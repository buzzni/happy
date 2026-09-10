/**
 * specs/runtime-isolation-hardening (H3).
 *
 * The first half drives the two helpers directly; the second half drives the
 * *real* mint and relay routes through `app.inject`, because everything H3
 * adds is a decision made between the route's own steps — schema, ACL
 * callback, daemon lease, enforcement echo — and a helper test cannot show
 * that those steps are actually wired in that order.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import {
    requestRuntimeLease,
    authorizeRelayBinding,
    previewRoutes,
    describePreviewRelayFailure,
    BOUND_PROXY_EVENT,
} from '@/app/api/routes/previewRoutes';
import { signPreviewToken, verifyPreviewToken } from '@/modules/preview/previewToken';
import { renderExpiredPtokenHtml } from '@/modules/preview/expiredPtokenHtml';
import { LEASE_UNSUPPORTED_CODE } from '@/modules/preview/previewRuntimeBinding';
import { type Fastify as FastifyType } from '../types';

vi.mock('@/app/events/eventRouter', () => {
    const machineSockets: { current: unknown[] } = { current: [] };
    return {
        eventRouter: {
            __machineSockets: machineSockets,
            server: {
                in: () => ({ timeout: () => ({ fetchSockets: async () => machineSockets.current }) }),
            },
        },
    };
});

vi.mock('@/storage/db', () => ({
    db: { machine: { findFirst: vi.fn() } },
}));

vi.mock('@/utils/log', () => ({ log: vi.fn() }));

import { eventRouter } from '@/app/events/eventRouter';
import { db } from '@/storage/db';

const MID = 'machine-1';
const PORT = 3000;
const USER_ID = 'happy-account-1';
const STUDIO_USER = 'studio-user-1';
const PROJECT = 'proj-1';
const TRUSTED_SECRET = 'trusted-secret';

process.env.HANDY_MASTER_SECRET = 'test-secret-key-for-ptoken';

function setMachineSockets(sockets: unknown[]) {
    (eventRouter as unknown as { __machineSockets: { current: unknown[] } }).__machineSockets.current = sockets;
}

function socket(id: string, response: unknown) {
    const emitWithAck = vi.fn(async () => {
        if (response instanceof Error) throw response;
        return response;
    });
    return { id, timeout: vi.fn(() => ({ emitWithAck })), emitWithAck };
}

const BIND = { projectId: 'proj-1', studioUserId: 'studio-1', leaseId: 'lease-1' };

describe('requestRuntimeLease', () => {
    it('returns the lease the daemon computed for the live runtime', async () => {
        const daemon = socket('d1', { type: 'success', leaseId: 'lease-1', evidenceKind: 'container' });
        await expect(requestRuntimeLease(
            [daemon as never],
            { projectId: 'proj-1', port: 3000, workspacePaths: ['/srv/a'] },
            10,
        )).resolves.toEqual({ type: 'success', leaseId: 'lease-1', evidenceKind: 'container' });
        // The workspace paths reach the daemon from here — they are the
        // studio's answer, never something the caller supplied.
        expect(daemon.emitWithAck).toHaveBeenCalledWith('preview-runtime-lease', {
            projectId: 'proj-1',
            port: 3000,
            workspacePaths: ['/srv/a'],
        });
    });

    it('reports a daemon that never acks as unsupported, not as a lease', async () => {
        // An old daemon has no handler for the event: the ack times out.
        const old = socket('old', new Error('operation has timed out'));
        await expect(requestRuntimeLease([old as never], { projectId: 'proj-1', port: 3000, workspacePaths: [] }, 10))
            .resolves.toMatchObject({ type: 'error', code: LEASE_UNSUPPORTED_CODE });
    });

    it('reports an unrecognised ack shape as unsupported', async () => {
        const old = socket('old', { ok: true });
        await expect(requestRuntimeLease([old as never], { projectId: 'proj-1', port: 3000, workspacePaths: [] }, 10))
            .resolves.toMatchObject({ type: 'error', code: LEASE_UNSUPPORTED_CODE });
    });

    it('surfaces the daemon refusal rather than treating it as unsupported', async () => {
        const daemon = socket('d1', { type: 'error', code: 'NO_LISTENER', message: 'nothing there' });
        await expect(requestRuntimeLease([daemon as never], { projectId: 'proj-1', port: 3000, workspacePaths: [] }, 10))
            .resolves.toEqual({ type: 'error', code: 'NO_LISTENER', message: 'nothing there' });
    });

    it('prefers a live daemon over a stale socket left by a reconnect', async () => {
        const stale = socket('stale', new Error('operation has timed out'));
        const fresh = socket('fresh', { type: 'success', leaseId: 'lease-1', evidenceKind: 'process' });
        await expect(requestRuntimeLease([stale as never, fresh as never], { projectId: 'proj-1', port: 3000, workspacePaths: [] }, 10))
            .resolves.toMatchObject({ type: 'success', leaseId: 'lease-1' });
    });

    it('reports no candidates as unsupported instead of throwing', async () => {
        await expect(requestRuntimeLease([], { projectId: 'proj-1', port: 3000, workspacePaths: [] }, 10))
            .resolves.toMatchObject({ type: 'error', code: LEASE_UNSUPPORTED_CODE });
    });
});

describe('authorizeRelayBinding', () => {
    const authorizerReturning = (result: unknown) => ({ authorize: vi.fn().mockResolvedValue(result) });

    it('asks the studio whether the bound user may still reach the project', async () => {
        const authorizer = authorizerReturning({ kind: 'allowed', workspacePaths: ['/srv/a'] });
        await expect(authorizeRelayBinding({
            access: BIND,
            machineId: 'machine-1',
            port: 3000,
            authorizer: authorizer as never,
        })).resolves.toEqual({ kind: 'allow', workspacePaths: ['/srv/a'] });
        expect(authorizer.authorize).toHaveBeenCalledWith({
            studioUserId: 'studio-1',
            projectId: 'proj-1',
            machineId: 'machine-1',
            port: 3000,
        });
    });

    it('rejects once the studio says the user lost access', async () => {
        await expect(authorizeRelayBinding({
            access: BIND,
            machineId: 'machine-1',
            port: 3000,
            authorizer: authorizerReturning({ kind: 'denied' }) as never,
        })).resolves.toMatchObject({ kind: 'reject', status: 403 });
    });

    it('fails closed with no callback even while the policy is off', async () => {
        // The policy decides who must be *issued* a bound token. A token that
        // already carries a binding is verified either way, or turning the
        // policy off would silently disarm every token minted while it was on.
        await expect(authorizeRelayBinding({
            access: BIND,
            machineId: 'machine-1',
            port: 3000,
            authorizer: null,
        })).resolves.toMatchObject({ kind: 'reject', status: 503 });
    });

    it('fails closed when the studio cannot answer, whatever the policy', async () => {
        await expect(authorizeRelayBinding({
            access: BIND,
            machineId: 'machine-1',
            port: 3000,
            authorizer: authorizerReturning({ kind: 'unavailable', reason: 'down' }) as never,
        })).resolves.toMatchObject({ kind: 'reject', status: 503 });
    });
});

// ---------------------------------------------------------------------------
// Real routes.
// ---------------------------------------------------------------------------

const ENV_KEYS = [
    'PREVIEW_RUNTIME_BINDING_POLICY',
    'PREVIEW_BINDING_LEGACY_MACHINE_IDS',
    'PREVIEW_AUTHZ_ORIGIN',
    'WEB_UI_TRUSTED_PREVIEW_SECRET',
] as const;

async function buildApp() {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as FastifyType;
    typed.decorate('authenticate', async (request: { userId?: string }) => {
        request.userId = USER_ID;
    });
    previewRoutes(typed);
    await typed.ready();
    return typed;
}

/** The studio ACL callback, stubbed at the one place the code reaches out. */
function stubAuthorizeCallback(answer: { allowed: boolean; workspacePaths?: string[] } | number) {
    const fetchImpl = vi.fn(async () => (typeof answer === 'number'
        ? new Response('nope', { status: answer })
        : new Response(JSON.stringify(answer), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })));
    vi.stubGlobal('fetch', fetchImpl);
    process.env.PREVIEW_AUTHZ_ORIGIN = 'http://studio.internal:5173';
    process.env.WEB_UI_TRUSTED_PREVIEW_SECRET = TRUSTED_SECRET;
    return fetchImpl;
}

/** A daemon that answers both the mint-time lease and the relayed request. */
function daemonSocket(options: {
    lease?: unknown;
    proxy?: unknown;
    /** Models a daemon that predates the bound relay event: no handler at all. */
    handles?: (event: string) => boolean;
} = {}) {
    const upstream: string[] = [];
    const emitWithAck = vi.fn(async (event: string, payload: unknown) => {
        if (options.handles && !options.handles(event)) {
            // Socket.IO has no listener, so the ack never comes.
            await new Promise((resolve) => setTimeout(resolve, 50));
            throw new Error('operation has timed out');
        }
        if (event === 'preview-runtime-lease') {
            return options.lease ?? { type: 'success', leaseId: 'lease-1', evidenceKind: 'container' };
        }
        // Reaching a relay handler at all means the daemon opened the
        // upstream request — the thing a mutation must never do twice, or
        // once with an unenforced binding.
        upstream.push(`${(payload as { method?: string })?.method ?? 'GET'} ${event}`);
        return options.proxy ?? {
            type: 'success',
            bindingEnforced: true,
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            bodyB64: Buffer.from('<html>UPSTREAM</html>', 'utf-8').toString('base64'),
            truncated: false,
        };
    });
    return {
        id: `daemon-${Math.random().toString(36).slice(2, 8)}`,
        data: { clientType: 'machine-scoped', machineId: MID },
        timeout: () => ({ emitWithAck }),
        emitWithAck,
        upstream,
    };
}

function trustedMint(app: Awaited<ReturnType<typeof buildApp>>, payload: Record<string, unknown>) {
    process.env.WEB_UI_TRUSTED_PREVIEW_SECRET = TRUSTED_SECRET;
    return app.inject({
        method: 'POST',
        url: '/v1/preview-token-trusted',
        headers: { 'x-trusted-preview-secret': TRUSTED_SECRET },
        payload,
    });
}

function mintBody(extra: Record<string, unknown> = {}) {
    return { machineId: MID, port: PORT, projectId: PROJECT, studioUserId: STUDIO_USER, ...extra };
}

/** A bound token that has already expired — what a re-mint actually carries. */
function expiredBoundToken() {
    return signPreviewToken(
        {
            userId: USER_ID,
            machineId: MID,
            port: PORT,
            bind: { projectId: PROJECT, studioUserId: STUDIO_USER, leaseId: 'lease-1' },
        },
        { ttlMs: -1_000 },
    ).token;
}

function boundToken(bind = { projectId: PROJECT, studioUserId: STUDIO_USER, leaseId: 'lease-1' }) {
    return signPreviewToken({ userId: USER_ID, machineId: MID, port: PORT, bind }).token;
}

describe('preview mint route — runtime binding', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        for (const key of ENV_KEYS) delete process.env[key];
        vi.mocked(db.machine.findFirst).mockResolvedValue({ id: MID, accountId: USER_ID } as never);
        setMachineSockets([]);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        for (const key of ENV_KEYS) delete process.env[key];
    });

    it('never mints a bound token from a studio identity the caller supplied', async () => {
        // A happy bearer proves which *happy account* owns the machine, not
        // who is asking: on a company machine every member holds one. Letting
        // this path bind to a caller-supplied studioUserId would let any
        // member mint a token in anyone else's name, which is the opposite of
        // what the binding is for. Only the trusted studio path may bind.
        const daemon = daemonSocket();
        setMachineSockets([daemon]);
        stubAuthorizeCallback({ allowed: true, workspacePaths: ['/srv/proj-1'] });
        const app = await buildApp();

        const res = await app.inject({
            method: 'POST',
            url: '/v1/preview-token',
            payload: mintBody({ studioUserId: 'someone-else' }),
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().binding).toBe('unbound');
        expect(verifyPreviewToken(res.json().token)?.bind).toBeUndefined();
        expect(daemon.emitWithAck).not.toHaveBeenCalled();
        await app.close();
    });

    it('refuses the bearer mint outright once binding is required', async () => {
        // Under the required policy an unbound token is not acceptable and a
        // bound one cannot be issued here, so the only honest answer is to
        // send the caller to the trusted studio path.
        process.env.PREVIEW_RUNTIME_BINDING_POLICY = 'required';
        const app = await buildApp();

        const res = await app.inject({
            method: 'POST',
            url: '/v1/preview-token',
            payload: mintBody(),
        });

        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('BEARER_BINDING_UNSUPPORTED');
        expect(res.json().token).toBeUndefined();
        await app.close();
    });

    it('still mints unbound on an explicitly excepted legacy machine', async () => {
        process.env.PREVIEW_RUNTIME_BINDING_POLICY = 'required';
        process.env.PREVIEW_BINDING_LEGACY_MACHINE_IDS = MID;
        const app = await buildApp();

        const res = await app.inject({
            method: 'POST',
            url: '/v1/preview-token',
            payload: { machineId: MID, port: PORT },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().binding).toBe('unbound');
        await app.close();
    });

    it('mints a trusted token bound to the runtime the daemon leased', async () => {
        process.env.PREVIEW_RUNTIME_BINDING_POLICY = 'required';
        const fetchImpl = stubAuthorizeCallback({ allowed: true, workspacePaths: ['/srv/proj-1'] });
        const daemon = daemonSocket();
        setMachineSockets([daemon]);
        const app = await buildApp();

        const res = await trustedMint(app, mintBody());

        expect(res.statusCode).toBe(200);
        expect(res.json().binding).toBe('lease');
        expect(verifyPreviewToken(res.json().token)?.bind).toEqual({
            projectId: PROJECT,
            studioUserId: STUDIO_USER,
            leaseId: 'lease-1',
        });
        // The studio's workspace answer is what reaches the daemon — the
        // caller never gets to say which directories count as the project's.
        expect(daemon.emitWithAck).toHaveBeenCalledWith('preview-runtime-lease', {
            projectId: PROJECT,
            port: PORT,
            workspacePaths: ['/srv/proj-1'],
        });
        expect(fetchImpl).toHaveBeenCalledWith(
            'http://studio.internal:5173/api/internal/preview-authorize',
            expect.objectContaining({ method: 'POST' }),
        );
        await app.close();
    });

    it('refuses the legacy unbound mint on the trusted path once binding is required', async () => {
        process.env.PREVIEW_RUNTIME_BINDING_POLICY = 'required';
        const app = await buildApp();

        const res = await trustedMint(app, { machineId: MID, port: PORT });

        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('BINDING_REQUIRED');
        await app.close();
    });

    it('refuses to mint when the daemon predates runtime binding', async () => {
        stubAuthorizeCallback({ allowed: true, workspacePaths: [] });
        // An old daemon has no handler for the event, so the ack times out.
        setMachineSockets([{
            id: 'old',
            data: { clientType: 'machine-scoped', machineId: MID },
            timeout: () => ({ emitWithAck: async () => { throw new Error('operation has timed out'); } }),
        }]);
        const app = await buildApp();

        const res = await trustedMint(app, mintBody());

        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe(LEASE_UNSUPPORTED_CODE);
        expect(res.json().token).toBeUndefined();
        await app.close();
    });

    it('answers a saturated runtime probe with a retryable 503, never a weaker token', async () => {
        // EVIDENCE_BUSY is backpressure: the daemon's probe queue is full, so
        // it did not look. That is neither an authorization answer nor proof
        // that nothing is there — and handing back an unbound token because
        // the machine is busy would make load the way to lose the binding.
        stubAuthorizeCallback({ allowed: true, workspacePaths: ['/srv/proj-1'] });
        setMachineSockets([daemonSocket({
            lease: { type: 'error', code: 'EVIDENCE_BUSY', message: 'preview runtime probe queue is full' },
        })]);
        const app = await buildApp();

        const res = await trustedMint(app, mintBody());

        expect(res.statusCode).toBe(503);
        expect(res.json().code).toBe('EVIDENCE_BUSY');
        expect(res.json().token).toBeUndefined();
        await app.close();
    });

    it('refuses to mint for a port whose runtime belongs to another project', async () => {
        stubAuthorizeCallback({ allowed: true, workspacePaths: ['/srv/proj-1'] });
        setMachineSockets([daemonSocket({
            lease: { type: 'error', code: 'PROJECT_OWNERSHIP_MISMATCH', message: 'other project' },
        })]);
        const app = await buildApp();

        const res = await trustedMint(app, mintBody());

        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('PROJECT_OWNERSHIP_MISMATCH');
        await app.close();
    });

    it('refuses to mint once the studio says the user lost the project', async () => {
        stubAuthorizeCallback({ allowed: true, workspacePaths: [] });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ allowed: false }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })));
        const daemon = daemonSocket();
        setMachineSockets([daemon]);
        const app = await buildApp();

        const res = await trustedMint(app, mintBody());

        expect(res.statusCode).toBe(403);
        // Denied before the daemon is asked to lease anything at all.
        expect(daemon.emitWithAck).not.toHaveBeenCalled();
        await app.close();
    });

    it('fails a requested trusted binding closed rather than handing back an unbound token', async () => {
        // No callback configured. An unbound token here would be a silent
        // downgrade of exactly the request that asked to be bound, and the
        // caller would have no way to tell the two apart.
        const daemon = daemonSocket();
        setMachineSockets([daemon]);
        const app = await buildApp();

        const res = await trustedMint(app, mintBody());

        expect(res.statusCode).toBe(503);
        expect(res.json().token).toBeUndefined();
        expect(daemon.emitWithAck).not.toHaveBeenCalled();
        await app.close();
    });

    it('keeps a restarted session bound when recovering an expired bound token', async () => {
        // The policy is off, so an ordinary mint here would be unbound. The
        // token being replaced was bound, and a dev-server restart must not
        // be a way to come back with weaker access than the session already
        // had.
        stubAuthorizeCallback({ allowed: true, workspacePaths: ['/srv/proj-1'] });
        setMachineSockets([daemonSocket({ lease: { type: 'success', leaseId: 'lease-2', evidenceKind: 'container' } })]);
        const app = await buildApp();

        const res = await trustedMint(app, mintBody({ previousToken: expiredBoundToken() }));

        expect(res.statusCode).toBe(200);
        expect(res.json().binding).toBe('lease');
        expect(verifyPreviewToken(res.json().token)?.bind).toMatchObject({ leaseId: 'lease-2' });
        await app.close();
    });

    it('does not downgrade a bound recovery on an explicitly excepted machine', async () => {
        process.env.PREVIEW_BINDING_LEGACY_MACHINE_IDS = MID;
        stubAuthorizeCallback({ allowed: true, workspacePaths: ['/srv/proj-1'] });
        setMachineSockets([daemonSocket()]);
        const app = await buildApp();

        const res = await trustedMint(app, mintBody({ previousToken: expiredBoundToken() }));

        expect(res.statusCode).toBe(200);
        expect(res.json().binding).toBe('lease');
        await app.close();
    });

    it('refuses a recovery whose previous token does not verify', async () => {
        const app = await buildApp();

        const res = await trustedMint(app, mintBody({ previousToken: 'not.a-real-token' }));

        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('INVALID_PREVIOUS_TOKEN');
        await app.close();
    });

    it('refuses a recovery pointing at another port', async () => {
        const app = await buildApp();
        const other = signPreviewToken({
            userId: USER_ID,
            machineId: MID,
            port: PORT + 1,
            bind: { projectId: PROJECT, studioUserId: STUDIO_USER, leaseId: 'lease-1' },
        }).token;

        const res = await trustedMint(app, mintBody({ previousToken: other }));

        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('PREVIOUS_TOKEN_MISMATCH');
        await app.close();
    });

    it('refuses a recovery whose previous binding names another project', async () => {
        const app = await buildApp();
        const other = signPreviewToken({
            userId: USER_ID,
            machineId: MID,
            port: PORT,
            bind: { projectId: 'proj-2', studioUserId: STUDIO_USER, leaseId: 'lease-1' },
        }).token;

        const res = await trustedMint(app, mintBody({ previousToken: other }));

        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('PREVIOUS_TOKEN_MISMATCH');
        await app.close();
    });

    it('mints unbound on an excepted machine even though the studio sent binding fields', async () => {
        // The studio always sends them, so honouring the operator's explicit
        // per-machine exception has to happen before the lease is attempted.
        process.env.PREVIEW_RUNTIME_BINDING_POLICY = 'required';
        process.env.PREVIEW_BINDING_LEGACY_MACHINE_IDS = MID;
        const daemon = daemonSocket();
        setMachineSockets([daemon]);
        const app = await buildApp();

        const res = await trustedMint(app, mintBody());

        expect(res.statusCode).toBe(200);
        expect(res.json().binding).toBe('unbound');
        expect(daemon.emitWithAck).not.toHaveBeenCalled();
        await app.close();
    });

    it('rejects a trusted mint whose secret is wrong without leaking it', async () => {
        const app = await buildApp();
        process.env.WEB_UI_TRUSTED_PREVIEW_SECRET = TRUSTED_SECRET;

        const res = await app.inject({
            method: 'POST',
            url: '/v1/preview-token-trusted',
            headers: { 'x-trusted-preview-secret': 'wrong-but-same-length' },
            payload: mintBody(),
        });

        expect(res.statusCode).toBe(401);
        expect(res.body).not.toContain(TRUSTED_SECRET);
        await app.close();
    });

    it('still mints an unbound token while the policy is off and none was asked for', async () => {
        const app = await buildApp();

        const res = await app.inject({
            method: 'POST',
            url: '/v1/preview-token',
            payload: { machineId: MID, port: PORT },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().binding).toBe('unbound');
        expect(verifyPreviewToken(res.json().token)?.bind).toBeUndefined();
        await app.close();
    });
});

describe('preview relay route — runtime binding', () => {
    const relayUrl = (token: string) => `/v1/preview/${MID}/${PORT}/index.html?ptoken=${token}`;

    beforeEach(() => {
        vi.clearAllMocks();
        for (const key of ENV_KEYS) delete process.env[key];
        vi.mocked(db.machine.findFirst).mockResolvedValue({ id: MID, accountId: USER_ID } as never);
        setMachineSockets([]);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        for (const key of ENV_KEYS) delete process.env[key];
    });

    it('relays a bound request and hands the daemon the binding to verify', async () => {
        stubAuthorizeCallback({ allowed: true, workspacePaths: ['/srv/proj-1'] });
        const daemon = daemonSocket();
        setMachineSockets([daemon]);
        const app = await buildApp();

        const res = await app.inject({ method: 'GET', url: relayUrl(boundToken()) });

        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('UPSTREAM');
        // Bound requests travel on their own event — see BOUND_PROXY_EVENT.
        expect(daemon.emitWithAck).toHaveBeenCalledWith(BOUND_PROXY_EVENT, expect.objectContaining({
            binding: { projectId: PROJECT, leaseId: 'lease-1', workspacePaths: ['/srv/proj-1'] },
        }));
        await app.close();
    });

    it('enforces a bound token even while the policy is off', async () => {
        // The policy decides who must *mint* bound. A token that already
        // carries a binding is always enforced, or turning the policy off
        // would silently disarm every token minted while it was on.
        stubAuthorizeCallback({ allowed: true, workspacePaths: ['/srv/proj-1'] });
        const daemon = daemonSocket();
        setMachineSockets([daemon]);
        const app = await buildApp();

        const res = await app.inject({ method: 'GET', url: relayUrl(boundToken()) });

        expect(res.statusCode).toBe(200);
        expect(daemon.emitWithAck).toHaveBeenCalledWith(BOUND_PROXY_EVENT, expect.objectContaining({
            binding: expect.objectContaining({ leaseId: 'lease-1' }),
        }));
        await app.close();
    });

    it('never reaches an old daemon\'s upstream with a bound request', async () => {
        // The echo check catches a downgraded *response*, but by then a POST
        // has already been executed against whatever was on that port. A
        // bound request therefore travels on an event an old daemon has no
        // handler for, so there is nothing to execute.
        stubAuthorizeCallback({ allowed: true, workspacePaths: [] });
        const old = daemonSocket({ handles: (event) => event === 'proxy-http-request' });
        setMachineSockets([old]);
        const app = await buildApp();

        const res = await app.inject({
            method: 'POST',
            url: relayUrl(boundToken()),
            payload: 'a=1',
        });

        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe(LEASE_UNSUPPORTED_CODE);
        expect(old.upstream).toEqual([]);
        await app.close();
    });

    it('sends a bound request to one daemon only, never fanned out', async () => {
        // The legacy path races every candidate socket and takes the first
        // answer. For a mutation that means the request can be executed more
        // than once, on more than one runtime.
        stubAuthorizeCallback({ allowed: true, workspacePaths: [] });
        const first = daemonSocket();
        const second = daemonSocket();
        setMachineSockets([first, second]);
        const app = await buildApp();

        const res = await app.inject({ method: 'POST', url: relayUrl(boundToken()), payload: 'a=1' });

        expect(res.statusCode).toBe(200);
        expect(first.upstream.length + second.upstream.length).toBe(1);
        await app.close();
    });

    it('does not retry a bound mutation on the next daemon when the first is stale', async () => {
        // A stale socket that never answers is indistinguishable from one
        // that answered after doing the work. Retrying a POST there is how a
        // single click becomes two orders.
        stubAuthorizeCallback({ allowed: true, workspacePaths: [] });
        const stale = daemonSocket({ handles: () => false });
        const live = daemonSocket();
        setMachineSockets([stale, live]);
        const app = await buildApp();

        const res = await app.inject({ method: 'POST', url: relayUrl(boundToken()), payload: 'a=1' });

        expect(res.statusCode).toBe(409);
        expect(live.upstream).toEqual([]);
        await app.close();
    });

    it('still recovers a bound GET from a stale socket', async () => {
        // A read can safely be re-issued, and reconnects leave stale sockets
        // behind often enough that refusing would break ordinary previews.
        stubAuthorizeCallback({ allowed: true, workspacePaths: [] });
        const stale = daemonSocket({ handles: () => false });
        const live = daemonSocket();
        setMachineSockets([stale, live]);
        const app = await buildApp();

        const res = await app.inject({ method: 'GET', url: relayUrl(boundToken()) });

        expect(res.statusCode).toBe(200);
        expect(live.upstream.length).toBe(1);
        await app.close();
    });

    it('keeps the legacy unbound path on the original event and its fan-out', async () => {
        const daemon = daemonSocket({ handles: (event) => event === 'proxy-http-request' });
        setMachineSockets([daemon]);
        const app = await buildApp();

        const res = await app.inject({
            method: 'GET',
            url: relayUrl(signPreviewToken({ userId: USER_ID, machineId: MID, port: PORT }).token),
        });

        expect(res.statusCode).toBe(200);
        expect(daemon.upstream).toEqual(['GET proxy-http-request']);
        await app.close();
    });

    it('refuses to forward a body from a daemon that did not echo enforcement', async () => {
        // A daemon downgraded after the token was minted relays the request
        // and answers an otherwise identical success envelope. Not being able
        // to tell whether it checked is not permission to serve the bytes.
        stubAuthorizeCallback({ allowed: true, workspacePaths: [] });
        setMachineSockets([daemonSocket({
            proxy: {
                type: 'success',
                status: 200,
                headers: { 'content-type': 'text/html; charset=utf-8' },
                bodyB64: Buffer.from('<html>UPSTREAM</html>', 'utf-8').toString('base64'),
                truncated: false,
            },
        })]);
        const app = await buildApp();

        const res = await app.inject({ method: 'GET', url: relayUrl(boundToken()) });

        expect(res.statusCode).toBe(502);
        expect(res.body).not.toContain('UPSTREAM');
        expect(res.json().code).toBe(LEASE_UNSUPPORTED_CODE);
        await app.close();
    });

    it('refuses an unbound token once the policy requires binding', async () => {
        process.env.PREVIEW_RUNTIME_BINDING_POLICY = 'required';
        setMachineSockets([daemonSocket()]);
        const app = await buildApp();

        const res = await app.inject({
            method: 'GET',
            url: relayUrl(signPreviewToken({ userId: USER_ID, machineId: MID, port: PORT }).token),
        });

        expect(res.statusCode).toBe(401);
        expect(res.json().code).toBe('binding-missing');
        await app.close();
    });

    it('lets a top-level navigation with an unbound token re-mint itself', async () => {
        process.env.PREVIEW_RUNTIME_BINDING_POLICY = 'required';
        setMachineSockets([daemonSocket()]);
        const app = await buildApp();

        const res = await app.inject({
            method: 'GET',
            url: relayUrl(signPreviewToken({ userId: USER_ID, machineId: MID, port: PORT }).token),
            headers: { accept: 'text/html,application/xhtml+xml' },
        });

        expect(res.statusCode).toBe(401);
        expect(res.headers['content-type']).toContain('text/html');
        await app.close();
    });

    it('stops relaying the moment the studio revokes access, on a token that still verifies', async () => {
        stubAuthorizeCallback({ allowed: false });
        const daemon = daemonSocket();
        setMachineSockets([daemon]);
        const app = await buildApp();

        const res = await app.inject({ method: 'GET', url: relayUrl(boundToken()) });

        expect(res.statusCode).toBe(403);
        expect(daemon.emitWithAck).not.toHaveBeenCalled();
        await app.close();
    });

    it('fails closed when the studio cannot answer under the required policy', async () => {
        process.env.PREVIEW_RUNTIME_BINDING_POLICY = 'required';
        process.env.PREVIEW_AUTHZ_ORIGIN = 'http://studio.internal:5173';
        process.env.WEB_UI_TRUSTED_PREVIEW_SECRET = TRUSTED_SECRET;
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }));
        const daemon = daemonSocket();
        setMachineSockets([daemon]);
        const app = await buildApp();

        const res = await app.inject({ method: 'GET', url: relayUrl(boundToken()) });

        expect(res.statusCode).toBe(503);
        expect(daemon.emitWithAck).not.toHaveBeenCalled();
        await app.close();
    });

    it('omits the previous token from the page when it carried no binding', async () => {
        // The studio treats `previousToken` as "this session was bound" and
        // forces a trusted, bound re-mint on it. Sending an unbound token
        // would therefore demand a shared secret and a current daemon for a
        // flow that works without either today — a regression dressed up as
        // preservation.
        const app = await buildApp();
        const unbound = signPreviewToken({ userId: USER_ID, machineId: MID, port: PORT }, { ttlMs: -1_000 }).token;

        const res = await app.inject({
            method: 'GET',
            url: relayUrl(unbound),
            headers: { accept: 'text/html', 'sec-fetch-dest': 'document' },
        });

        expect(res.statusCode).toBe(401);
        expect(res.body).not.toContain('previousToken');
        await app.close();
    });

    it('omits an unreadable previous token from the page', async () => {
        const app = await buildApp();

        const res = await app.inject({
            method: 'GET',
            url: `/v1/preview/${MID}/${PORT}/index.html?ptoken=not.a-token`,
            headers: { accept: 'text/html', 'sec-fetch-dest': 'document' },
        });

        expect(res.statusCode).toBe(401);
        expect(res.body).not.toContain('previousToken');
        await app.close();
    });

    it('includes it for a stale bound token, which is the case recovery exists for', async () => {
        const app = await buildApp();
        const stale = expiredBoundToken();

        const res = await app.inject({
            method: 'GET',
            url: relayUrl(stale),
            headers: { accept: 'text/html', 'sec-fetch-dest': 'document' },
        });

        expect(res.statusCode).toBe(401);
        expect(res.body).toContain(JSON.stringify(stale));
        await app.close();
    });

    it('hands the re-mint page the very token it is replacing', async () => {
        // End of the P4 chain: the relay puts the bound token into the page,
        // the page posts it back, and the trusted mint uses it to stay bound.
        stubAuthorizeCallback({ allowed: true, workspacePaths: [] });
        setMachineSockets([daemonSocket({
            proxy: { type: 'error', code: 'LEASE_MISMATCH', message: 'runtime changed' },
        })]);
        const app = await buildApp();
        const token = boundToken();

        const res = await app.inject({
            method: 'GET',
            url: relayUrl(token),
            headers: { accept: 'text/html', 'sec-fetch-dest': 'document' },
        });

        expect(res.statusCode).toBe(401);
        expect(res.body).toContain(JSON.stringify(token));
        await app.close();
    });

    it('offers a re-mint page when the runtime restarted under a valid token', async () => {
        // A restart legitimately changes the lease. Answering 403 here would
        // strand a user who still has full access on a page that can never
        // recover; the re-mint page asks for a lease over what is there now.
        stubAuthorizeCallback({ allowed: true, workspacePaths: [] });
        setMachineSockets([daemonSocket({
            proxy: { type: 'error', code: 'LEASE_MISMATCH', message: 'runtime changed' },
        })]);
        const app = await buildApp();

        const res = await app.inject({
            method: 'GET',
            url: relayUrl(boundToken()),
            headers: { accept: 'text/html,application/xhtml+xml' },
        });

        expect(res.statusCode).toBe(401);
        expect(res.headers['content-type']).toContain('text/html');
        await app.close();
    });

    it('never accepts an expired token, however recoverable it would be at mint', async () => {
        // The recovery reader exists only for the mint path. If the relay
        // could read an expired token, every bound session would outlive its
        // own expiry.
        stubAuthorizeCallback({ allowed: true, workspacePaths: [] });
        setMachineSockets([daemonSocket()]);
        const app = await buildApp();

        const res = await app.inject({ method: 'GET', url: relayUrl(expiredBoundToken()) });

        expect(res.statusCode).toBe(401);
        await app.close();
    });

    it('never answers a mutation with the self-reloading re-mint page', async () => {
        // The page reloads the URL it was served for, so serving it here
        // would re-issue the POST as soon as a fresh token arrives.
        stubAuthorizeCallback({ allowed: true, workspacePaths: [] });
        setMachineSockets([daemonSocket({
            proxy: { type: 'error', code: 'LEASE_MISMATCH', message: 'runtime changed' },
        })]);
        const app = await buildApp();

        const res = await app.inject({
            method: 'POST',
            url: relayUrl(boundToken()),
            headers: { accept: 'text/html,application/xhtml+xml' },
            payload: 'a=1',
        });

        expect(res.statusCode).toBe(401);
        expect(res.headers['content-type']).not.toContain('text/html');
        await app.close();
    });

    it('never answers a subresource with the re-mint page', async () => {
        stubAuthorizeCallback({ allowed: true, workspacePaths: [] });
        setMachineSockets([daemonSocket({
            proxy: { type: 'error', code: 'LEASE_MISMATCH', message: 'runtime changed' },
        })]);
        const app = await buildApp();

        const res = await app.inject({
            method: 'GET',
            url: relayUrl(boundToken()),
            headers: { accept: 'text/html', 'sec-fetch-dest': 'script', 'sec-fetch-mode': 'no-cors' },
        });

        expect(res.statusCode).toBe(401);
        expect(res.headers['content-type']).not.toContain('text/html');
        await app.close();
    });

    it('answers a saturated runtime probe with a retryable 503 and no re-mint page', async () => {
        // Re-minting cannot help a busy machine — the mint takes the same
        // probe — so a page that re-mints and reloads would just add load to
        // the thing that is already saturated.
        stubAuthorizeCallback({ allowed: true, workspacePaths: [] });
        setMachineSockets([daemonSocket({
            proxy: { type: 'error', code: 'EVIDENCE_BUSY', message: 'preview runtime probe queue is full' },
        })]);
        const app = await buildApp();

        const res = await app.inject({
            method: 'GET',
            url: relayUrl(boundToken()),
            headers: { accept: 'text/html,application/xhtml+xml', 'sec-fetch-dest': 'document' },
        });

        expect(res.statusCode).toBe(503);
        expect(res.headers['content-type']).not.toContain('text/html');
        expect(res.json().code).toBe('EVIDENCE_BUSY');
        await app.close();
    });

    it('answers a genuine ownership refusal with 403 and no re-mint page', async () => {
        stubAuthorizeCallback({ allowed: true, workspacePaths: [] });
        setMachineSockets([daemonSocket({
            proxy: { type: 'error', code: 'PROJECT_OWNERSHIP_MISMATCH', message: 'other project' },
        })]);
        const app = await buildApp();

        const res = await app.inject({
            method: 'GET',
            url: relayUrl(boundToken()),
            headers: { accept: 'text/html,application/xhtml+xml' },
        });

        expect(res.statusCode).toBe(403);
        expect(res.headers['content-type']).not.toContain('text/html');
        await app.close();
    });
});

describe('describePreviewRelayFailure — binding refusals', () => {
    const ctx = {
        method: 'GET',
        machineId: MID,
        port: PORT,
        userId: USER_ID,
        path: '/index.html',
        candidates: 1,
    };

    it('answers a stale lease with 401 so the caller re-mints', () => {
        expect(describePreviewRelayFailure(
            { kind: 'daemon-error', code: 'LEASE_MISMATCH', message: 'changed' },
            ctx,
        ).status).toBe(401);
    });

    it('answers an ownership refusal with 403, which re-minting cannot fix', () => {
        for (const code of ['PROJECT_OWNERSHIP_MISMATCH', 'PORT_PROJECT_MISMATCH', 'WORKSPACE_UNVERIFIED']) {
            expect(describePreviewRelayFailure({ kind: 'daemon-error', code, message: '' }, ctx).status).toBe(403);
        }
    });

    it('answers a saturated probe with 503, apart from both 403 and the 502 contract', () => {
        // 502 would read as "the dev server is unreachable" to
        // checkPortReachable, and 403 as "you may not have this". It is
        // neither: come back in a moment.
        expect(describePreviewRelayFailure(
            { kind: 'daemon-error', code: 'EVIDENCE_BUSY', message: 'queue full' },
            ctx,
        ).status).toBe(503);
    });

    it('leaves an unprovable runtime on the 502 relay contract, distinct from a busy one', () => {
        // At relay time "nothing is listening" is what checkPortReachable
        // polls for; only the busy answer moves off that contract.
        for (const code of ['NO_LISTENER', 'EVIDENCE_UNAVAILABLE']) {
            expect(describePreviewRelayFailure({ kind: 'daemon-error', code, message: '' }, ctx).status).toBe(502);
        }
    });

    it('leaves the checkPortReachable contract alone for ordinary upstream failures', () => {
        expect(describePreviewRelayFailure(
            { kind: 'daemon-error', code: 'ECONNREFUSED', message: 'refused' },
            ctx,
        ).status).toBe(502);
        expect(describePreviewRelayFailure({ kind: 'machine-offline' }, ctx).status).toBe(502);
    });
});
