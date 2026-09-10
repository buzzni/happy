import { describe, it, expect, vi } from 'vitest';
import {
    parsePreviewUpgradeRequest,
    parsePreviewUpgradeUrl,
    openPreviewWsTunnel,
    recheckOpenTunnelBinding,
    serializeUpgradeRequest,
    stripPreviewAuthCookie,
    PreviewWsOpenError,
} from '@/modules/preview/previewWebSocketRelay';

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

describe('openPreviewWsTunnel', () => {
    it('falls back to another live daemon socket when the first one is stale', async () => {
        const socket = (id: string, response: unknown) => ({
            id,
            timeout: () => ({ emitWithAck: async () => {
                if (response instanceof Error) throw response;
                return response;
            } }),
        });
        const stale = socket('stale', new Error('timeout'));
        const fresh = socket('fresh', { ok: true });

        await expect(openPreviewWsTunnel(
            [stale, fresh],
            { tunnelId: 'tunnel-1', port: 40002, dataB64: '' },
            10,
        )).resolves.toBe(fresh);
    });

    it('carries the runtime binding to the daemon', async () => {
        const emitWithAck = vi.fn(async () => ({ ok: true, bindingEnforced: true }));
        const daemon = { id: 'd1', timeout: () => ({ emitWithAck }) };
        const payload = {
            tunnelId: 'tunnel-1',
            port: 40002,
            dataB64: '',
            binding: { projectId: 'proj-1', leaseId: 'lease-1', workspacePaths: ['/srv/a'] },
        };

        await expect(openPreviewWsTunnel([daemon], payload, 10, true)).resolves.toBe(daemon);
        expect(emitWithAck).toHaveBeenCalledWith('proxy-ws-open', payload);
    });

    it('refuses a daemon that opened the tunnel without enforcing the binding', async () => {
        // specs/runtime-isolation-hardening (H3) — an older daemon ignores the
        // binding fields and answers a plain `{ ok: true }`. The upgrade path
        // must not become the way around the binding the HTTP relay enforces.
        const old = { id: 'old', timeout: () => ({ emitWithAck: async () => ({ ok: true }) }) };

        await expect(openPreviewWsTunnel(
            [old],
            { tunnelId: 'tunnel-1', port: 40002, dataB64: '', binding: { projectId: 'p', leaseId: 'l', workspacePaths: [] } },
            10,
            true,
        )).rejects.toThrow(/binding/i);
    });

    it('carries the daemon refusal code out, not just its prose', async () => {
        // handleUpgrade answers 401 for a stale lease and 403 for an
        // ownership refusal. The message is free text written for a human;
        // only the code can decide that.
        const daemon = {
            id: 'd1',
            timeout: () => ({
                emitWithAck: async () => ({
                    ok: false,
                    code: 'LEASE_MISMATCH',
                    message: 'The runtime serving this port is not the one the token was issued for',
                }),
            }),
        };
        await expect(openPreviewWsTunnel([daemon], { tunnelId: 't', port: 1, dataB64: '' }, 10))
            .rejects.toMatchObject({ code: 'LEASE_MISMATCH' });
    });

    it('reports a daemon that ignored the binding with the unsupported code', async () => {
        const old = { id: 'old', timeout: () => ({ emitWithAck: async () => ({ ok: true }) }) };
        await expect(openPreviewWsTunnel(
            [old],
            { tunnelId: 't', port: 1, dataB64: '', binding: { projectId: 'p', leaseId: 'l', workspacePaths: [] } },
            10,
            true,
        )).rejects.toBeInstanceOf(PreviewWsOpenError);
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
        policyMode: 'required' as const,
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
        expect(requestLease).toHaveBeenCalledWith([], {
            projectId: 'proj-1',
            port: 3000,
            workspacePaths: ['/srv/a'],
        });
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
