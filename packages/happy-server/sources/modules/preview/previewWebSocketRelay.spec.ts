import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    hasTunnel,
    deliverDaemonData,
    applyRemoteData,
    _resetPreviewTunnelsForTest,
} from '@/modules/preview/previewWsTunnels';
import { describe as _describe } from 'vitest';
import {
    parsePreviewUpgradeRequest,
    parsePreviewUpgradeUrl,
    openPreviewWsTunnel,
    createTunnelCandidateHooks,
    recheckOpenTunnelBinding,
    armTunnelRevocation,
    serializeUpgradeRequest,
    stripPreviewAuthCookie,
    PreviewWsOpenError,
    WS_BINDING_RECHECK_MS,
    WS_RECHECK_DEADLINE_MS,
    wsOpenFailureStatus,
} from '@/modules/preview/previewWebSocketRelay';
void _describe;

describe('parsePreviewUpgradeUrl', () => {
    it('parses machineId, port, subPath, and query', () => {
        const parsed = parsePreviewUpgradeUrl('/v1/preview/mac-1/6080/websockify?ptoken=abc&x=1');
        expect(parsed).not.toBeNull();
        expect(parsed!.machineId).toBe('mac-1');
        expect(parsed!.port).toBe(6080);
        expect(parsed!.subPath).toBe('/websockify');
        expect(parsed!.query.get('ptoken')).toBe('abc');
        expect(parsed!.query.get('x')).toBe('1');
    });

    it('defaults subPath to / when absent', () => {
        const parsed = parsePreviewUpgradeUrl('/v1/preview/mac-1/6080');
        expect(parsed!.subPath).toBe('/');
    });

    it('returns null for non-preview paths', () => {
        expect(parsePreviewUpgradeUrl('/v1/updates')).toBeNull();
        expect(parsePreviewUpgradeUrl('/socket.io/')).toBeNull();
        expect(parsePreviewUpgradeUrl('/v1/preview/mac-1/notaport/ws')).toBeNull();
    });

    it('rejects out-of-range ports', () => {
        expect(parsePreviewUpgradeUrl('/v1/preview/mac-1/0/ws')).toBeNull();
        expect(parsePreviewUpgradeUrl('/v1/preview/mac-1/70000/ws')).toBeNull();
    });
});

/**
 * The open attempt now owns one pending tunnel per candidate daemon: it
 * registers it before emitting, approves it only on an ack that proves the
 * binding was enforced, and abandons it — telling that daemon to close —
 * in every other case, including the ones where no ack ever arrives.
 */
function candidateHooks(options: { cancelled?: () => boolean; approve?: () => boolean } = {}) {
    const begun: string[] = [];
    const approved: Array<[string, string]> = [];
    const abandoned: string[] = [];
    let n = 0;
    return {
        begun,
        approved,
        abandoned,
        hooks: {
            begin: (daemonSocketId: string) => {
                const id = `tunnel-${(n += 1)}-${daemonSocketId}`;
                begun.push(id);
                return id;
            },
            approve: (tunnelId: string, daemonSocketId: string) => {
                approved.push([tunnelId, daemonSocketId]);
                return options.approve ? options.approve() : true;
            },
            abandon: (tunnelId: string, socket: { emit: (event: string, payload: unknown) => unknown }) => {
                abandoned.push(tunnelId);
                socket.emit('proxy-ws-close', { tunnelId });
            },
            cancelled: options.cancelled ?? (() => false),
        },
    };
}

const OPEN_PAYLOAD = { port: 40002, dataB64: '' };

describe('openPreviewWsTunnel', () => {
    it('falls back to another live daemon socket when the first one is stale', async () => {
        const socket = (id: string, response: unknown) => ({
            id,
            emit: vi.fn(),
            timeout: () => ({ emitWithAck: async () => {
                if (response instanceof Error) throw response;
                return response;
            } }),
        });
        const stale = socket('stale', new Error('timeout'));
        const fresh = socket('fresh', { ok: true });
        const { hooks } = candidateHooks();

        const opened = await openPreviewWsTunnel([stale, fresh], OPEN_PAYLOAD, hooks, 10);

        expect(opened.socket).toBe(fresh);
    });

    it('gives each candidate its own tunnel id', async () => {
        // One id shared across candidates means the daemon that lost the race
        // can still write into the tunnel the winner is serving.
        const refusing = { id: 'a', emit: vi.fn(), timeout: () => ({ emitWithAck: async () => ({ ok: false }) }) };
        const accepting = { id: 'b', emit: vi.fn(), timeout: () => ({ emitWithAck: async () => ({ ok: true }) }) };
        const probe = candidateHooks();

        const opened = await openPreviewWsTunnel([refusing, accepting], OPEN_PAYLOAD, probe.hooks, 10);

        expect(probe.begun).toHaveLength(2);
        expect(new Set(probe.begun).size).toBe(2);
        expect(opened.tunnelId).toBe(probe.begun[1]);
    });

    it('carries the runtime binding to the daemon', async () => {
        const emitWithAck = vi.fn(async () => ({ ok: true, bindingEnforced: true }));
        const daemon = { id: 'd1', emit: vi.fn(), timeout: () => ({ emitWithAck }) };
        const binding = { projectId: 'proj-1', leaseId: 'lease-1', workspacePaths: ['/srv/a'] };
        const probe = candidateHooks();

        await openPreviewWsTunnel([daemon], { ...OPEN_PAYLOAD, binding }, probe.hooks, 10, true);

        expect(emitWithAck).toHaveBeenCalledWith('proxy-ws-open', {
            tunnelId: probe.begun[0],
            ...OPEN_PAYLOAD,
            binding,
        });
    });

    it('never approves a tunnel a daemon opened without enforcing the binding', async () => {
        const old = { id: 'old', emit: vi.fn(), timeout: () => ({ emitWithAck: async () => ({ ok: true }) }) };
        const probe = candidateHooks();

        await expect(openPreviewWsTunnel(
            [old],
            { ...OPEN_PAYLOAD, binding: { projectId: 'p', leaseId: 'l', workspacePaths: [] } },
            probe.hooks,
            10,
            true,
        )).rejects.toBeInstanceOf(PreviewWsOpenError);

        expect(probe.approved).toEqual([]);
        expect(probe.abandoned).toEqual(probe.begun);
        expect(old.emit).toHaveBeenCalledWith('proxy-ws-close', { tunnelId: probe.begun[0] });
    });

    it('tells a daemon to close the tunnel it opened after we stopped waiting', async () => {
        // P2: the open deadline can pass while the daemon is still queueing.
        // If it connects afterwards, nothing on the server knows about that
        // tunnel any more — no expiry timer, no recheck — so the cancellation
        // has to reach the daemon rather than only the local registry.
        const slow = {
            id: 'slow',
            emit: vi.fn(),
            timeout: (ms: number) => ({
                emitWithAck: async () => {
                    await new Promise((resolve) => setTimeout(resolve, ms));
                    throw new Error('operation has timed out');
                },
            }),
        };
        const probe = candidateHooks();

        await expect(openPreviewWsTunnel([slow], OPEN_PAYLOAD, probe.hooks, 20)).rejects.toThrow();

        expect(slow.emit).toHaveBeenCalledWith('proxy-ws-close', { tunnelId: probe.begun[0] });
    });

    it('abandons an ack that arrives after the browser has gone', async () => {
        // The browser leaves mid-open. The ack still comes back "ok", and the
        // daemon is holding an upstream connection for a tunnel nobody will
        // ever read — it has to be told.
        let gone = false;
        const daemon = {
            id: 'd1',
            emit: vi.fn(),
            timeout: () => ({ emitWithAck: async () => { gone = true; return { ok: true }; } }),
        };
        const probe = candidateHooks({ cancelled: () => gone });

        await expect(openPreviewWsTunnel([daemon], OPEN_PAYLOAD, probe.hooks, 10)).rejects.toThrow();

        expect(probe.approved).toEqual([]);
        expect(daemon.emit).toHaveBeenCalledWith('proxy-ws-close', { tunnelId: probe.begun[0] });
    });

    it('abandons a tunnel the registry refuses to approve', async () => {
        const daemon = { id: 'd1', emit: vi.fn(), timeout: () => ({ emitWithAck: async () => ({ ok: true }) }) };
        const probe = candidateHooks({ approve: () => false });

        await expect(openPreviewWsTunnel([daemon], OPEN_PAYLOAD, probe.hooks, 10)).rejects.toThrow();

        expect(probe.abandoned).toEqual(probe.begun);
    });

    it('carries the daemon refusal code out, not just its prose', async () => {
        const daemon = {
            id: 'd1',
            emit: vi.fn(),
            timeout: () => ({
                emitWithAck: async () => ({
                    ok: false,
                    code: 'LEASE_MISMATCH',
                    message: 'The runtime serving this port is not the one the token was issued for',
                }),
            }),
        };
        await expect(openPreviewWsTunnel([daemon], OPEN_PAYLOAD, candidateHooks().hooks, 10))
            .rejects.toMatchObject({ code: 'LEASE_MISMATCH' });
    });

    it('spends one budget across every candidate daemon instead of one each', async () => {
        const attempted: string[] = [];
        const hanging = (id: string) => ({
            id,
            emit: vi.fn(),
            timeout: (ms: number) => ({
                emitWithAck: async () => {
                    attempted.push(id);
                    await new Promise((resolve) => setTimeout(resolve, ms));
                    throw new Error('operation has timed out');
                },
            }),
        });

        await expect(openPreviewWsTunnel(
            [hanging('a'), hanging('b'), hanging('c')],
            OPEN_PAYLOAD,
            candidateHooks().hooks,
            40,
        )).rejects.toThrow();

        expect(attempted.length).toBeLessThan(3);
    });
});

describe('recheckOpenTunnelBinding', () => {
    // A tunnel makes exactly one request — the upgrade — and then lives for
    // hours. Everything the HTTP relay re-checks per request has to be
    // re-checked here on a timer, or the upgrade path becomes the way to hold
    // access that was taken away.
    const BIND = { projectId: 'proj-1', studioUserId: 'studio-1', leaseId: 'lease-1' };
    const base = {
        bind: BIND,
        machineId: 'machine-1',
        port: 3000,
        sockets: [],
    };
    const allowing = (workspacePaths: string[] = ['/srv/a']) => ({
        authorize: vi.fn().mockResolvedValue({ kind: 'allowed', workspacePaths }),
    });

    it('keeps a tunnel whose project access and runtime are both unchanged', async () => {
        const requestLease = vi.fn().mockResolvedValue({ type: 'success', leaseId: 'lease-1', evidenceKind: 'container' });
        await expect(recheckOpenTunnelBinding({
            ...base,
            authorizer: allowing() as never,
            requestLease,
        })).resolves.toEqual({ ok: true });
        expect(requestLease).toHaveBeenCalledWith(
            [],
            { projectId: 'proj-1', port: 3000, workspacePaths: ['/srv/a'] },
            // The lease inherits whatever is left of the recheck budget.
            expect.any(Number),
        );
    });

    it('drops a tunnel once the studio revokes project access', async () => {
        await expect(recheckOpenTunnelBinding({
            ...base,
            authorizer: { authorize: vi.fn().mockResolvedValue({ kind: 'denied' }) } as never,
            requestLease: vi.fn(),
        })).resolves.toMatchObject({ ok: false });
    });

    it('drops a tunnel when the runtime behind the port was replaced', async () => {
        const requestLease = vi.fn().mockResolvedValue({ type: 'success', leaseId: 'lease-2', evidenceKind: 'container' });
        await expect(recheckOpenTunnelBinding({
            ...base,
            authorizer: allowing() as never,
            requestLease,
        })).resolves.toEqual({ ok: false, reason: 'LEASE_MISMATCH' });
    });

    it('drops a tunnel when the daemon can no longer prove the runtime', async () => {
        const requestLease = vi.fn().mockResolvedValue({ type: 'error', code: 'NO_LISTENER', message: 'gone' });
        await expect(recheckOpenTunnelBinding({
            ...base,
            authorizer: allowing() as never,
            requestLease,
        })).resolves.toEqual({ ok: false, reason: 'NO_LISTENER' });
    });

    it('drops a tunnel when the studio cannot answer under the required policy', async () => {
        await expect(recheckOpenTunnelBinding({
            ...base,
            authorizer: { authorize: vi.fn().mockResolvedValue({ kind: 'unavailable', reason: 'down' }) } as never,
            requestLease: vi.fn(),
        })).resolves.toMatchObject({ ok: false });
    });
});

describe('parsePreviewUpgradeRequest', () => {
    it('maps a root path on an isolated preview host to the matching upstream', () => {
        const parsed = parsePreviewUpgradeRequest(
            '/_expo/ws?platform=web',
            '6b8a8c22-9439-4d4f-b4c6-9e7f13027818-40002.preview.saycode.ai',
        );
        expect(parsed).toMatchObject({
            machineId: '6b8a8c22-9439-4d4f-b4c6-9e7f13027818',
            port: 40002,
            subPath: '/_expo/ws',
        });
        expect(parsed!.query.get('platform')).toBe('web');
    });

    it('ignores unrelated hosts and upgrade paths', () => {
        expect(parsePreviewUpgradeRequest('/socket.io/', 'saycode.ai')).toBeNull();
    });
});

describe('stripPreviewAuthCookie', () => {
    it('keeps app cookies but does not expose the relay token upstream', () => {
        expect(stripPreviewAuthCookie(
            ['Host', 'preview', 'Cookie', 'theme=dark; happy_preview_machine-1_40002=secret; app=1'],
            'machine-1',
            40002,
        )).toEqual(['Host', 'preview', 'Cookie', 'theme=dark; app=1']);
    });
});

describe('serializeUpgradeRequest', () => {
    it('rebuilds a valid HTTP upgrade request with Host rewritten to loopback', () => {
        const rawHeaders = [
            'Host', 'preview.example.com',
            'Upgrade', 'websocket',
            'Connection', 'Upgrade',
            'Sec-WebSocket-Key', 'dGhlIHNhbXBsZQ==',
            'Sec-WebSocket-Version', '13',
        ];
        const bytes = serializeUpgradeRequest('GET', '/websockify', 6080, rawHeaders, Buffer.alloc(0));
        const text = bytes.toString('utf-8');

        expect(text.startsWith('GET /websockify HTTP/1.1\r\n')).toBe(true);
        expect(text).toContain('Host: 127.0.0.1:6080\r\n');
        expect(text).toContain('Upgrade: websocket\r\n');
        expect(text).toContain('Sec-WebSocket-Key: dGhlIHNhbXBsZQ==\r\n');
        expect(text.endsWith('\r\n\r\n')).toBe(true);
    });

    it('appends any upgrade head bytes after the header block', () => {
        const bytes = serializeUpgradeRequest('GET', '/ws', 3000, ['Host', 'x'], Buffer.from('EARLYBYTES'));
        const text = bytes.toString('utf-8');
        expect(text).toContain('\r\n\r\nEARLYBYTES');
    });

    // specs/preview-relay-origin-normalization — symmetric with the Host
    // rewrite above. Host is already always rewritten to the loopback target;
    // Origin must match it or dev-server WS upgrade handlers that compare the
    // two (Vite/webpack HMR, Expo Metro) reject the handshake as cross-origin.
    it('rewrites Origin to the loopback target alongside Host', () => {
        const rawHeaders = [
            'Host', 'preview.example.com',
            'Origin', 'https://3c78fd5e-c77f-4d1e-9783-62b6df5d12ef-30003.preview.saycode.ai',
            'Upgrade', 'websocket',
            'Connection', 'Upgrade',
        ];
        const bytes = serializeUpgradeRequest('GET', '/ws', 30003, rawHeaders, Buffer.alloc(0));
        const text = bytes.toString('utf-8');

        expect(text).toContain('Host: 127.0.0.1:30003\r\n');
        expect(text).toContain('Origin: http://127.0.0.1:30003\r\n');
    });

    it('does not add an Origin header when the caller sent none', () => {
        const bytes = serializeUpgradeRequest('GET', '/ws', 3000, ['Host', 'x'], Buffer.alloc(0));
        const text = bytes.toString('utf-8');

        expect(text).not.toContain('Origin:');
    });
});

describe('recheckOpenTunnelBinding — deadline', () => {
    it('gives up within its deadline when the studio never answers', async () => {
        // Without this the tunnel's termination guarantee would be "the
        // recheck interval plus however long the callback feels like taking".
        const started = Date.now();
        await expect(recheckOpenTunnelBinding({
            bind: { projectId: 'p', studioUserId: 's', leaseId: 'l' },
            machineId: 'm',
            port: 3000,
            authorizer: { authorize: () => new Promise(() => { /* never answers */ }) } as never,
            sockets: [],
            deadlineMs: 30,
        })).resolves.toMatchObject({ ok: false });
        expect(Date.now() - started).toBeLessThan(2_000);
    });
});

describe('armTunnelRevocation', () => {
    const BIND = { projectId: 'proj-1', studioUserId: 'studio-1', leaseId: 'lease-1' };

    function daemon(id = 'accepting-daemon') {
        return { id, emit: vi.fn(), timeout: () => ({ emitWithAck: async () => ({}) }) };
    }

    function arm(overrides: Record<string, unknown> = {}) {
        const revoke = vi.fn();
        const recheck = vi.fn().mockResolvedValue({ ok: true });
        const accepting = daemon();
        const stop = armTunnelRevocation({
            tunnelId: 't-1',
            bind: BIND,
            machineId: 'machine-1',
            port: 3000,
            expiresAt: Date.now() + 60 * 60_000,
            daemon: accepting,
            isOpen: () => true,
            revoke,
            recheck: recheck as never,
            ...overrides,
        });
        return { stop, revoke, recheck, accepting };
    }

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('rechecks against the daemon that actually accepted the upgrade', async () => {
        // Re-resolving the machine's sockets would let a *different* daemon
        // answer for a tunnel it is not carrying, and its answer would say
        // nothing about the runtime this tunnel is attached to.
        const { stop, recheck, accepting } = arm();

        await vi.advanceTimersByTimeAsync(WS_BINDING_RECHECK_MS);

        expect(recheck).toHaveBeenCalledWith(expect.objectContaining({ sockets: [accepting] }));
        stop();
    });

    it('revokes when the token expires even while every recheck passes', async () => {
        const { stop, revoke } = arm({ expiresAt: Date.now() + 5_000 });

        await vi.advanceTimersByTimeAsync(5_001);

        expect(revoke).toHaveBeenCalledWith('token-expired');
        stop();
    });

    it('never runs two rechecks at once', async () => {
        // A slow callback must not stack one check per interval on top of it.
        let release: (() => void) | null = null;
        const recheck = vi.fn(() => new Promise((resolve) => {
            release = () => resolve({ ok: true });
        }));
        const { stop } = arm({ recheck });

        await vi.advanceTimersByTimeAsync(WS_BINDING_RECHECK_MS * 3);
        expect(recheck).toHaveBeenCalledTimes(1);

        release!();
        await vi.advanceTimersByTimeAsync(WS_BINDING_RECHECK_MS);
        expect(recheck).toHaveBeenCalledTimes(2);
        stop();
    });

    it('revokes and stops rechecking once the binding no longer holds', async () => {
        const recheck = vi.fn().mockResolvedValue({ ok: false, reason: 'LEASE_MISMATCH' });
        const { revoke } = arm({ recheck });

        await vi.advanceTimersByTimeAsync(WS_BINDING_RECHECK_MS);
        expect(revoke).toHaveBeenCalledWith('LEASE_MISMATCH');

        await vi.advanceTimersByTimeAsync(WS_BINDING_RECHECK_MS * 3);
        expect(recheck).toHaveBeenCalledTimes(1);
    });

    it('terminates within one interval plus one deadline in the worst case', () => {
        // The contract the operator can rely on. Not "instant revocation",
        // and not an unbounded wait either.
        expect(WS_BINDING_RECHECK_MS + WS_RECHECK_DEADLINE_MS).toBeLessThanOrEqual(60_000);
    });

    it('stops every timer when the tunnel closes, and cannot revoke afterwards', async () => {
        let release: ((value: unknown) => void) | null = null;
        const recheck = vi.fn(() => new Promise((resolve) => { release = resolve; }));
        const { stop, revoke } = arm({ recheck, expiresAt: Date.now() + WS_BINDING_RECHECK_MS * 10 });

        await vi.advanceTimersByTimeAsync(WS_BINDING_RECHECK_MS);
        stop();
        // A check that was already in flight resolves against a closed tunnel.
        release!({ ok: false, reason: 'LEASE_MISMATCH' });
        await vi.advanceTimersByTimeAsync(60_000);

        expect(revoke).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('stops rechecking a tunnel that is already gone', async () => {
        const { revoke, recheck } = arm({ isOpen: () => false });

        await vi.advanceTimersByTimeAsync(WS_BINDING_RECHECK_MS * 2);

        expect(recheck).not.toHaveBeenCalled();
        expect(revoke).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('wsOpenFailureStatus', () => {
    // The upgrade never becomes a WebSocket, so this status is the only thing
    // the browser and the operator get. It has to say the same thing the HTTP
    // relay says about the same daemon answer.
    it('answers a saturated runtime probe with a retryable 503', () => {
        expect(wsOpenFailureStatus('EVIDENCE_BUSY')).toBe(503);
    });

    it('answers a stale lease with 401 so the page can re-mint', () => {
        expect(wsOpenFailureStatus('LEASE_MISMATCH')).toBe(401);
    });

    it('answers an ownership refusal with 403', () => {
        for (const code of ['PROJECT_OWNERSHIP_MISMATCH', 'PORT_PROJECT_MISMATCH', 'WORKSPACE_UNVERIFIED']) {
            expect(wsOpenFailureStatus(code)).toBe(403);
        }
    });

    it('leaves everything else at 502', () => {
        expect(wsOpenFailureStatus('TIMEOUT')).toBe(502);
        expect(wsOpenFailureStatus('NO_LISTENER')).toBe(502);
        expect(wsOpenFailureStatus(null)).toBe(502);
    });
});

describe('createTunnelCandidateHooks', () => {
    function browserSocket() {
        return {
            writable: true,
            written: [] as string[],
            write(buf: Buffer) { this.written.push(buf.toString()); return true; },
            end() { /* unused */ },
            destroy() { /* unused */ },
        };
    }

    beforeEach(() => _resetPreviewTunnelsForTest());

    it('gives every candidate its own tunnel id', () => {
        // A shared id lets the daemon that lost the race write into the
        // tunnel the winner is serving.
        const hooks = createTunnelCandidateHooks({
            browserSocket: browserSocket() as never,
            bound: true,
            cancelled: () => false,
        });

        const first = hooks.begin('daemon-1');
        const second = hooks.begin('daemon-2');

        expect(first).not.toBe(second);
        expect(hasTunnel(first)).toBe(true);
        expect(hasTunnel(second)).toBe(true);
    });

    it('registers the tunnel closed, so nothing is delivered before approval', () => {
        const socket = browserSocket();
        const hooks = createTunnelCandidateHooks({
            browserSocket: socket as never,
            bound: true,
            cancelled: () => false,
        });
        const tunnelId = hooks.begin('daemon-1');

        deliverDaemonData(tunnelId, Buffer.from('early').toString('base64'), vi.fn(), 'daemon-1');
        expect(socket.written).toEqual([]);

        expect(hooks.approve(tunnelId, 'daemon-1')).toBe(true);
        expect(socket.written).toEqual(['early']);
    });

    it('tells the daemon to close the upstream it may still be opening', () => {
        // The whole point of P2: dropping our own registry entry leaves the
        // daemon connecting into a tunnel nothing will ever read or close.
        const hooks = createTunnelCandidateHooks({
            browserSocket: browserSocket() as never,
            bound: true,
            cancelled: () => false,
        });
        const tunnelId = hooks.begin('daemon-1');
        const machineSocket = { id: 'daemon-1', emit: vi.fn(), timeout: () => ({ emitWithAck: async () => ({}) }) };

        hooks.abandon(tunnelId, machineSocket);

        expect(hasTunnel(tunnelId)).toBe(false);
        expect(machineSocket.emit).toHaveBeenCalledWith('proxy-ws-close', { tunnelId });
    });

    it('marks a bound tunnel bound, so a sender-less relayed frame is refused', () => {
        // The flag is what makes the same-daemon pin strict for bound
        // tunnels; a hook that always registered them unbound would leave the
        // pin bypassable by any older peer replica.
        const socket = browserSocket();
        const hooks = createTunnelCandidateHooks({
            browserSocket: socket as never,
            bound: true,
            cancelled: () => false,
        });
        const tunnelId = hooks.begin('daemon-1');
        hooks.approve(tunnelId, 'daemon-1');

        applyRemoteData({ tunnelId, dataB64: Buffer.from('no-sender').toString('base64') } as never);

        expect(socket.written).toEqual([]);
    });

    it('marks an unbound tunnel unbound, keeping mixed-version delivery working', () => {
        const socket = browserSocket();
        const hooks = createTunnelCandidateHooks({
            browserSocket: socket as never,
            bound: false,
            cancelled: () => false,
        });
        const tunnelId = hooks.begin('daemon-1');
        hooks.approve(tunnelId, 'daemon-1');

        applyRemoteData({ tunnelId, dataB64: Buffer.from('legacy').toString('base64') } as never);

        expect(socket.written).toEqual(['legacy']);
    });
});
