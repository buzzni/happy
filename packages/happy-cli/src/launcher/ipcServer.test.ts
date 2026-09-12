import { describe, expect, it, vi } from 'vitest';

import { MANAGED_TARGET_MAX_BASE64 } from '@/managed/checkpoint/managedProviderStateScope';
import {
    MANAGED_CHECKPOINT_FRAME_MAX_BYTES,
    MANAGED_GRANT_FRAME_MAX_BYTES,
    MAX_BOOTSTRAP_BYTES,
    MAX_ENCODED_REQUEST_BYTES,
    MAX_REQUEST_BYTES,
    SOCKET_MODE,
    handleIpcRequest,
    tokensMatch,
    parseSupervisorHello,
} from './ipcServer';

const CREDENTIAL = Buffer.from(JSON.stringify({
    v: 1, launchId: 'a'.repeat(32), secretBase64: Buffer.alloc(32, 5).toString('base64'),
}), 'utf8').toString('base64');
const TOKEN = 'a'.repeat(43);
const KEY = { runId: 'run-1', attemptId: 'attempt-1', epoch: 2 };
/** Shape only - the signature is the supervisor's to check, not this boundary's. */
const DISPATCH = `${'a'.repeat(20)}.${'b'.repeat(20)}`;
const TARGET_DOC = Buffer.from(JSON.stringify({ checkpointId: 'a'.repeat(64) })).toString('base64');

function handlers() {
    return {
        proveStopped: vi.fn(() => ({ proven: true })),
        proveBelow: vi.fn(() => ({ proven: true, detail: 'ok' })),
        requestStop: vi.fn(() => ({ requested: true, detail: 'accepted' })),
        prepareLaunch: vi.fn(async () => ({ prepared: true as const, pid: 4242, handle: 'a'.repeat(32) })),
        releaseLaunch: vi.fn(async () => ({ released: true, detail: 'released' })),
        renew: vi.fn(() => ({ renewed: true })),
    };
}

async function call(body: unknown, over: { token?: string } = {}) {
    const h = handlers();
    const response = await handleIpcRequest({
        raw: typeof body === 'string' ? body : JSON.stringify(body),
        token: over.token ?? TOKEN,
        handlers: h,
    });
    return { response, h };
}

describe('supervisor IPC', () => {
    it('serves a proof request from an authenticated client', async () => {
        const { response, h } = await call({ op: 'prove-stopped', token: TOKEN, key: KEY });
        expect(response).toEqual({ ok: true, result: { proven: true } });
        expect(h.proveStopped).toHaveBeenCalledWith(KEY);
    });

    it('refuses a request without the boot token and never reaches a handler', async () => {
        const { response, h } = await call({ op: 'prove-stopped', token: 'wrong', key: KEY });
        expect(response).toEqual({ ok: false, reason: 'unauthorized' });
        expect(h.proveStopped).not.toHaveBeenCalled();
        expect(h.requestStop).not.toHaveBeenCalled();
    });

    it('checks the token before the operation, so an unknown op still needs auth', async () => {
        expect((await call({ op: 'nope', token: 'wrong' })).response).toEqual({ ok: false, reason: 'unauthorized' });
        expect((await call({ op: 'nope', token: TOKEN })).response).toEqual({ ok: false, reason: 'unsupported-op' });
    });

    it('the caller cannot choose the executable, uid or cgroup path', async () => {
        // 그런 필드는 계약에 없다 — 실어도 무시되고 세대만 지목된다.
        const { response, h } = await call({
            op: 'request-stop', token: TOKEN, key: KEY,
            exe: '/bin/sh', uid: 0, cgroup: '/sys/fs/cgroup',
        });
        expect(response).toEqual({ ok: true, result: { requested: true, detail: 'accepted' } });
        expect(h.requestStop).toHaveBeenCalledWith(KEY);
    });

    it('refuses ids that would escape the delegated root', async () => {
        for (const runId of ['../escape', 'a/b', '']) {
            expect((await call({ op: 'prove-stopped', token: TOKEN, key: { ...KEY, runId } })).response)
                .toEqual({ ok: false, reason: 'malformed' });
        }
        expect((await call({ op: 'prove-stopped', token: TOKEN, key: { ...KEY, epoch: -1 } })).response)
            .toEqual({ ok: false, reason: 'malformed' });
        expect((await call({ op: 'prove-stopped', token: TOKEN, key: { ...KEY, epoch: 1.5 } })).response)
            .toEqual({ ok: false, reason: 'malformed' });
    });

    it('refuses malformed input without throwing', async () => {
        for (const raw of ['', 'not json', '[]', 'null', '"str"']) {
            expect((await call(raw)).response).toEqual({ ok: false, reason: 'malformed' });
        }
    });

    it('compares tokens without leaking length through a throw', async () => {
        expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
        expect(tokensMatch(TOKEN, 'short')).toBe(false);
        expect(tokensMatch(TOKEN, 42)).toBe(false);
        expect(tokensMatch(TOKEN, undefined)).toBe(false);
    });

    it('bounds the request before parsing it', async () => {
        expect(MAX_REQUEST_BYTES).toBe(8192);
    });

    it('prove-below is runtime-wide — it takes only an epoch', async () => {
        const { response, h } = await call({ op: 'prove-below', token: TOKEN, belowEpoch: 7 });
        expect(response).toEqual({ ok: true, result: { proven: true, detail: 'ok' } });
        expect(h.proveBelow).toHaveBeenCalledWith({ belowEpoch: 7 });
    });

    it('prove-below refuses a non-epoch', async () => {
        for (const belowEpoch of [-1, 1.5, '7', undefined]) {
            expect((await call({ op: 'prove-below', token: TOKEN, belowEpoch })).response)
                .toEqual({ ok: false, reason: 'malformed' });
        }
    });

    it('the socket is not open to other local users', async () => {
        expect(SOCKET_MODE).toBe(0o660);
    });
});

describe('two-phase launch over IPC', () => {
    const KEY2 = { runId: 'run-1', attemptId: 'attempt-1', epoch: 2 };
    const bootstrapBase64 = Buffer.from('{"v":1}').toString('base64');

    it('carries the bootstrap as bytes — never a path or an fd number', async () => {
        const { response, h } = await call({
            op: 'prepare-launch', token: TOKEN, reportCredentialBase64: CREDENTIAL, key: KEY2,
            leaseExpiresMonotonic: 5_000, bootstrapBase64,
        });
        expect(response).toMatchObject({ ok: true, result: { prepared: true, pid: 4242 } });
        const seen: Array<{ bootstrap: Buffer }> = [];
        for (const args of h.prepareLaunch.mock.calls as unknown as Array<[{ bootstrap: Buffer }]>) {
            seen.push(args[0]);
        }
        expect(seen).toHaveLength(1);
        expect(Buffer.isBuffer(seen[0]!.bootstrap)).toBe(true);
        expect(seen[0]!.bootstrap.toString('utf8')).toBe('{"v":1}');
    });

    it('refuses an encoded body beyond the wire cap before decoding it', async () => {
        const { response, h } = await call({
            op: 'prepare-launch', token: TOKEN, reportCredentialBase64: CREDENTIAL, key: KEY2, leaseExpiresMonotonic: 5_000,
            bootstrapBase64: 'A'.repeat(MAX_ENCODED_REQUEST_BYTES + 1),
        });
        expect(response).toEqual({ ok: false, reason: 'too-large' });
        expect(h.prepareLaunch).not.toHaveBeenCalled();
    });

    it('the wire cap leaves room for base64 overhead above the 2MiB envelope', () => {
        expect(MAX_BOOTSTRAP_BYTES).toBe(2 * 1024 * 1024);
        expect(MAX_ENCODED_REQUEST_BYTES).toBeGreaterThan(MAX_BOOTSTRAP_BYTES);
    });

    it('refuses an empty or oversize decoded envelope', async () => {
        expect((await call({
            op: 'prepare-launch', token: TOKEN, reportCredentialBase64: CREDENTIAL, key: KEY2,
            leaseExpiresMonotonic: 5_000, bootstrapBase64: '',
        })).response).toEqual({ ok: false, reason: 'malformed' });
    });

    it('release takes an opaque handle, not a pid or a path', async () => {
        const handle = 'b'.repeat(32);
        const { response, h } = await call({ op: 'release-launch', token: TOKEN, handle });
        expect(response).toMatchObject({ ok: true, result: { released: true } });
        expect(h.releaseLaunch).toHaveBeenCalledWith(handle);
    });

    it('refuses a handle that is not one this supervisor could have issued', async () => {
        for (const handle of ['', '../escape', 'zz', 4242]) {
            expect((await call({ op: 'release-launch', token: TOKEN, handle })).response)
                .toEqual({ ok: false, reason: 'malformed' });
        }
    });

    it('renew carries the generation, sequence and deadline', async () => {
        const { response, h } = await call({
            op: 'renew', token: TOKEN, key: KEY2, renewalSeq: 3, leaseExpiresMonotonic: 9_000,
        });
        expect(response).toMatchObject({ ok: true, result: { renewed: true } });
        expect(h.renew).toHaveBeenCalledWith({
            key: KEY2, renewalSeq: 3, leaseExpiresMonotonic: 9_000,
        });
    });

    it('every launch command still needs the boot token', async () => {
        for (const op of ['prepare-launch', 'release-launch', 'renew']) {
            expect((await call({ op, token: 'wrong' })).response)
                .toEqual({ ok: false, reason: 'unauthorized' });
        }
    });
});

describe('checkpoint targets cross the process boundary', () => {
    const TARGET = Buffer.from(JSON.stringify({ checkpointId: 'a'.repeat(64) })).toString('base64');

    it('refuses when this runtime does not take checkpoints', async () => {
        /*
         * Accepting and dropping it would let a parent-issued credential expire
         * unused while everything looked fine — the parent believes a target is
         * in flight and the runtime never had anywhere to put it.
         */
        expect(await handleIpcRequest({
            raw: JSON.stringify({ op: 'checkpoint-target', token: TOKEN, targetBase64: TARGET, dispatchToken: DISPATCH }),
            token: TOKEN,
            handlers: handlers(),
        })).toEqual({ ok: false, reason: 'checkpoint-unconfigured' });
    });

    it('hands the bytes to the inbox when one is wired', async () => {
        const seen: Buffer[] = [];
        expect(await handleIpcRequest({
            raw: JSON.stringify({ op: 'checkpoint-target', token: TOKEN, targetBase64: TARGET, dispatchToken: DISPATCH }),
            token: TOKEN,
            handlers: {
                ...handlers(),
                acceptCheckpointTarget: (target: Buffer) => { seen.push(target); return { accepted: true }; },
            },
        })).toEqual({ ok: true, result: { accepted: true } });
        expect(seen).toHaveLength(1);
    });

    it('refuses an oversized body before decoding it', async () => {
        expect(await handleIpcRequest({
            raw: JSON.stringify({
                op: 'checkpoint-target', token: TOKEN, dispatchToken: DISPATCH,
                targetBase64: 'A'.repeat(MANAGED_TARGET_MAX_BASE64 + 1),
            }),
            token: TOKEN,
            handlers: handlers(),
        })).toEqual({ ok: false, reason: 'too-large' });
    });

    it('carries a target larger than the generic request cap', async () => {
        /*
         * Measured, not assumed: with realistic presigned URLs a scope of 11
         * sources encodes to 7,964 base64 characters and fits under the generic
         * 8 KiB cap; 12 sources reach 8,244 and do not. So small scope-bearing
         * targets already pass - it is history that the generic cap rejects,
         * and this op needs its own limit rather than the shared one.
         *
         * Nothing else widens: the generic cap, the bootstrap cap and the frame
         * limit are untouched.
         */
        const seen: Buffer[] = [];
        const big = Buffer.alloc(12_000, 0x7b).toString('base64');
        expect(big.length).toBeGreaterThan(MAX_REQUEST_BYTES);
        expect(big.length).toBeLessThanOrEqual(MANAGED_TARGET_MAX_BASE64);
        expect(await handleIpcRequest({
            raw: JSON.stringify({ op: 'checkpoint-target', token: TOKEN, targetBase64: big, dispatchToken: DISPATCH }),
            token: TOKEN,
            handlers: {
                ...handlers(),
                acceptCheckpointTarget: (target: Buffer) => { seen.push(target); return { accepted: true }; },
            },
        })).toEqual({ ok: true, result: { accepted: true } });
        expect(seen[0]).toHaveLength(12_000);
    });

    it('refuses at the checkpoint limit before decoding, not after', async () => {
        // One character over, and nothing is allocated from it.
        const decoded: Buffer[] = [];
        expect(await handleIpcRequest({
            raw: JSON.stringify({
                op: 'checkpoint-target', token: TOKEN, dispatchToken: DISPATCH,
                targetBase64: 'A'.repeat(MANAGED_TARGET_MAX_BASE64 + 1),
            }),
            token: TOKEN,
            handlers: {
                ...handlers(),
                acceptCheckpointTarget: (target: Buffer) => { decoded.push(target); return { accepted: true }; },
            },
        })).toEqual({ ok: false, reason: 'too-large' });
        expect(decoded).toEqual([]);
    });

    it('leaves the generic request cap where it was', () => {
        // The wider limit belongs to this one op. The credential a launch
        // carries is still bound by the generic cap, and the two constants are
        // not the same number.
        expect(MANAGED_TARGET_MAX_BASE64).toBeGreaterThan(MAX_REQUEST_BYTES);
        expect(MAX_REQUEST_BYTES).toBe(8192);
    });

    it('refuses a caller without the boot token', async () => {
        // The target carries a one-shot key and signed upload URLs.
        expect(await handleIpcRequest({
            raw: JSON.stringify({ op: 'checkpoint-target', token: 'wrong', targetBase64: TARGET, dispatchToken: DISPATCH }),
            token: TOKEN,
            handlers: handlers(),
        })).toEqual({ ok: false, reason: 'unauthorized' });
    });
});

describe('shutdown drains in-flight requests', () => {
    it('waits for a handler that is still running when the socket is already gone', async () => {
        const { createIpcServer } = await import('./ipcServer');
        const { mkdtempSync, rmSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const { connect } = await import('node:net');

        const dir = mkdtempSync(join(tmpdir(), 'ipc-drain-'));
        const socketPath = join(dir, 's.sock');
        let releaseHandler: (() => void) | null = null;
        let handlerFinished = false;
        const ipc = createIpcServer({
            socketPath,
            token: TOKEN,
            handlers: {
                ...handlers(),
                prepareLaunch: async () => {
                    await new Promise<void>((resolve) => { releaseHandler = resolve; });
                    handlerFinished = true;
                    return { prepared: false as const, detail: 'done' };
                },
            },
        });
        try {
            await ipc.listen();
            const socket = connect(socketPath);
            await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
            socket.write(`${JSON.stringify({
                op: 'prepare-launch', token: TOKEN, reportCredentialBase64: CREDENTIAL,
                key: { runId: 'r', attemptId: 'a', epoch: 0 },
                leaseExpiresMonotonic: 5_000,
                bootstrapBase64: Buffer.from('{}').toString('base64'),
            })}\n`);
            await new Promise((resolve) => setTimeout(resolve, 100));
            // 소켓이 사라져도 handler 는 계속 돈다.
            socket.destroy();

            let closed = false;
            const closing = ipc.close().then(() => { closed = true; });
            await new Promise((resolve) => setTimeout(resolve, 150));
            expect(closed).toBe(false);
            expect(handlerFinished).toBe(false);

            releaseHandler!();
            await closing;
            expect(handlerFinished).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);

    it('refuses a request that arrives after shutdown started', async () => {
        const { createIpcServer } = await import('./ipcServer');
        const { mkdtempSync, rmSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const { connect } = await import('node:net');

        const dir = mkdtempSync(join(tmpdir(), 'ipc-late-'));
        const socketPath = join(dir, 's.sock');
        let releaseHandler: (() => void) | null = null;
        const prepareLaunch = vi.fn(async () => {
            await new Promise<void>((resolve) => { releaseHandler = resolve; });
            return { prepared: false as const, detail: 'done' };
        });
        const ipc = createIpcServer({
            socketPath, token: TOKEN, handlers: { ...handlers(), prepareLaunch },
        });
        try {
            await ipc.listen();
            const first = connect(socketPath);
            await new Promise<void>((resolve) => first.on('connect', () => resolve()));
            const late = connect(socketPath);
            await new Promise<void>((resolve) => late.on('connect', () => resolve()));
            const body = `${JSON.stringify({
                op: 'prepare-launch', token: TOKEN, reportCredentialBase64: CREDENTIAL,
                key: { runId: 'r', attemptId: 'a', epoch: 0 },
                leaseExpiresMonotonic: 5_000,
                bootstrapBase64: Buffer.from('{}').toString('base64'),
            })}\n`;
            first.write(body);
            await new Promise((resolve) => setTimeout(resolve, 100));

            const closing = ipc.close();
            // 이미 연결된 소켓으로 들어온 늦은 요청도 받지 않는다.
            const answer = new Promise<string>((resolve) => {
                let buffer = '';
                late.setEncoding('utf8');
                late.on('data', (chunk: string) => {
                    buffer += chunk;
                    if (buffer.includes('\n')) resolve(buffer.trim());
                });
            });
            late.write(body);
            expect(JSON.parse(await answer)).toEqual({ ok: false, reason: 'shutting-down' });
            expect(prepareLaunch).toHaveBeenCalledTimes(1);

            releaseHandler!();
            await closing;
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);
});

describe('the checkpoint frame budget', () => {
    /*
     * The whole serialized request is bounded before anything is decoded, and
     * the bound is a sum of named parts rather than a cushion:
     *
     *   74        the empty standard envelope, measured
     *   349,528   MANAGED_TARGET_MAX_BASE64
     *   4,096     the dispatch token, base64url + one dot, so chars == bytes
     *   3,072     the bearer: MAX_TOKEN_LENGTH 512 UTF-16 units, and JSON
     *             escapes a control character as \uXXXX - six bytes each
     *   ------
     *   356,770   (356,771 with the newline the socket adds)
     */
    it('shouldStateTheBudgetAsASumOfNamedParts', () => {
        expect(MANAGED_CHECKPOINT_FRAME_MAX_BYTES).toBe(74 + 349_528 + 4_096 + 6 * 512);
        expect(MANAGED_CHECKPOINT_FRAME_MAX_BYTES).toBe(356_770);
    });

    it('shouldRefuseARawFrameOverTheBudgetBeforeDecoding', async () => {
        const decoded: Buffer[] = [];
        const padding = 'A'.repeat(MANAGED_CHECKPOINT_FRAME_MAX_BYTES);
        expect(await handleIpcRequest({
            raw: JSON.stringify({
                op: 'checkpoint-target', token: TOKEN, targetBase64: 'AAAA',
                dispatchToken: DISPATCH, padding,
            }),
            token: TOKEN,
            handlers: {
                ...handlers(),
                acceptCheckpointTarget: (target: Buffer) => { decoded.push(target); return { accepted: true }; },
            },
        })).toEqual({ ok: false, reason: 'too-large' });
        // An extra field that pushes the raw frame over is refused even though
        // every per-field limit is satisfied.
        expect(decoded).toEqual([]);
    });

    it('shouldRefuseAWorstCaseBearerBeforeItCanBeMeasured', async () => {
        /*
         * 512 UTF-16 units of U+0001 is inside `MAX_TOKEN_LENGTH` and
         * serializes to 3,072 bytes. Paired with a maximal target and a maximal
         * dispatch token the frame weighs **exactly** the budget - the sum has
         * no cushion in it, which is why each term had to be measured rather
         * than rounded. It never reaches that check: the bearer must equal the boot token, so
         * it is refused as unauthorized before the op runs at all. The 6 x 512
         * term is therefore headroom this boundary cannot be made to spend,
         * kept because a future op-before-auth ordering must not silently make
         * a legal frame illegal.
         */
        const bearer = String.fromCharCode(1).repeat(512);
        const raw = JSON.stringify({
            op: 'checkpoint-target', token: bearer,
            targetBase64: 'A'.repeat(MANAGED_TARGET_MAX_BASE64),
            dispatchToken: `${'a'.repeat(2047)}.${'b'.repeat(2048)}`,
        });
        expect(Buffer.byteLength(raw, 'utf8')).toBe(MANAGED_CHECKPOINT_FRAME_MAX_BYTES);
        expect(await handleIpcRequest({ raw, token: TOKEN, handlers: handlers() }))
            .toEqual({ ok: false, reason: 'unauthorized' });
    });

    it('shouldRefuseTheBudgetPlusOneWithAValidBearer', async () => {
        /*
         * The same maximal frame with the real bearer: one byte over the
         * budget is refused, and the byte under it is accepted - so the bound
         * is the number, not a direction.
         */
        const decoded: Buffer[] = [];
        const accepting = () => ({
            ...handlers(),
            acceptCheckpointTarget: (target: Buffer) => { decoded.push(target); return { accepted: true }; },
        });
        const frame = (padding: string) => JSON.stringify({
            op: 'checkpoint-target', token: TOKEN, targetBase64: TARGET_DOC,
            dispatchToken: DISPATCH, padding,
        });
        const fixed = Buffer.byteLength(frame(''), 'utf8');
        const under = frame('p'.repeat(MANAGED_CHECKPOINT_FRAME_MAX_BYTES - fixed));
        const over = frame('p'.repeat(MANAGED_CHECKPOINT_FRAME_MAX_BYTES - fixed + 1));
        expect(Buffer.byteLength(under, 'utf8')).toBe(MANAGED_CHECKPOINT_FRAME_MAX_BYTES);
        expect(await handleIpcRequest({ raw: under, token: TOKEN, handlers: accepting() }))
            .toEqual({ ok: true, result: { accepted: true } });
        expect(await handleIpcRequest({ raw: over, token: TOKEN, handlers: accepting() }))
            .toEqual({ ok: false, reason: 'too-large' });
        expect(decoded).toHaveLength(1);
    });

    it('shouldRefuseADispatchTokenOutsideItsAlphabet', async () => {
        /*
         * Checked before the size, so the size check measures something known:
         * `.length` counts UTF-16 units, and a control character serializes to
         * six bytes, so a token that passes a character bound can contribute
         * six times its length to the frame.
         */
        expect(await handleIpcRequest({
            raw: JSON.stringify({
                op: 'checkpoint-target', token: TOKEN, targetBase64: 'AAAA',
                dispatchToken: `a${String.fromCharCode(1)}b.cd`,
            }),
            token: TOKEN,
            handlers: handlers(),
        })).toEqual({ ok: false, reason: 'malformed' });
    });

    it('shouldCarryTheDispatchTokenToTheHandler', async () => {
        const seen: Array<{ target: Buffer; dispatchToken?: string }> = [];
        const token = `${'a'.repeat(20)}.${'b'.repeat(20)}`;
        expect(await handleIpcRequest({
            raw: JSON.stringify({
                op: 'checkpoint-target', token: TOKEN, targetBase64: TARGET_DOC, dispatchToken: token,
            }),
            token: TOKEN,
            handlers: {
                ...handlers(),
                acceptCheckpointTarget: (target: Buffer, dispatchToken?: string) => {
                    seen.push({ target, dispatchToken });
                    return { accepted: true };
                },
            },
        })).toEqual({ ok: true, result: { accepted: true } });
        expect(seen[0]?.dispatchToken).toBe(token);
    });

    it('shouldRefuseACheckpointTargetWithNoDispatchToken', async () => {
        // No unsigned fallback: a target with nothing to verify is refused at
        // the boundary rather than queued as an unauthenticated candidate.
        expect(await handleIpcRequest({
            raw: JSON.stringify({ op: 'checkpoint-target', token: TOKEN, targetBase64: TARGET_DOC }),
            token: TOKEN,
            handlers: handlers(),
        })).toEqual({ ok: false, reason: 'malformed' });
    });
});

describe('the runtime grant op', () => {
    const PARAMS = Buffer.from(JSON.stringify({ requestedMs: 60_000 }), 'utf8').toString('base64');

    it('shouldStateTheGrantBudgetAsASumOfNamedParts', () => {
        /*
         *   62      the empty envelope, measured
         *   1,368   paramsBase64: 4*ceil(1024/3) for a 1 KiB params document
         *   4,096   the dispatch token, base64url + one dot
         *   3,072   the bearer, 512 UTF-16 units x 6 bytes when JSON-escaped
         */
        expect(MANAGED_GRANT_FRAME_MAX_BYTES).toBe(62 + 1_368 + 4_096 + 6 * 512);
        expect(MANAGED_GRANT_FRAME_MAX_BYTES).toBe(8_598);
    });

    it('shouldCarryTheTokenAndParamsToTheHandler', async () => {
        const seen: Array<{ params: Buffer; dispatchToken: string }> = [];
        const token = `${'a'.repeat(20)}.${'b'.repeat(20)}`;
        expect(await handleIpcRequest({
            raw: JSON.stringify({
                op: 'grant', token: TOKEN, paramsBase64: PARAMS, dispatchToken: token,
            }),
            token: TOKEN,
            handlers: {
                ...handlers(),
                acceptRuntimeGrant: (params: Buffer, dispatchToken: string) => {
                    seen.push({ params, dispatchToken });
                    return { admitted: true };
                },
            },
        })).toEqual({ ok: true, result: { admitted: true } });
        expect(JSON.parse(seen[0]!.params.toString('utf8'))).toEqual({ requestedMs: 60_000 });
        expect(seen[0]?.dispatchToken).toBe(token);
    });

    it('shouldRefuseAGrantWithNoDispatchToken', async () => {
        // No unsigned path: a grant with nothing to verify is refused at the
        // boundary rather than recorded as the parent's statement.
        expect(await handleIpcRequest({
            raw: JSON.stringify({ op: 'grant', token: TOKEN, paramsBase64: PARAMS }),
            token: TOKEN,
            handlers: handlers(),
        })).toEqual({ ok: false, reason: 'malformed' });
    });

    it('shouldRefuseADispatchTokenOutsideItsAlphabetBeforeMeasuring', async () => {
        expect(await handleIpcRequest({
            raw: JSON.stringify({
                op: 'grant', token: TOKEN, paramsBase64: PARAMS,
                dispatchToken: `a${String.fromCharCode(1)}b.cd`,
            }),
            token: TOKEN,
            handlers: handlers(),
        })).toEqual({ ok: false, reason: 'malformed' });
    });

    it('shouldRefuseTheGrantBudgetPlusOneBeforeDecoding', async () => {
        const decoded: Buffer[] = [];
        const accepting = () => ({
            ...handlers(),
            acceptRuntimeGrant: (params: Buffer) => { decoded.push(params); return { admitted: true }; },
        });
        const frame = (padding: string) => JSON.stringify({
            op: 'grant', token: TOKEN, paramsBase64: PARAMS, dispatchToken: DISPATCH, padding,
        });
        const fixed = Buffer.byteLength(frame(''), 'utf8');
        const under = frame('p'.repeat(MANAGED_GRANT_FRAME_MAX_BYTES - fixed));
        const over = frame('p'.repeat(MANAGED_GRANT_FRAME_MAX_BYTES - fixed + 1));
        expect(await handleIpcRequest({ raw: under, token: TOKEN, handlers: accepting() }))
            .toEqual({ ok: true, result: { admitted: true } });
        expect(await handleIpcRequest({ raw: over, token: TOKEN, handlers: accepting() }))
            .toEqual({ ok: false, reason: 'too-large' });
        expect(decoded).toHaveLength(1);
    });

    it('shouldRefuseAGrantWhenNoHandlerIsWired', async () => {
        /*
         * Absence refuses. A supervisor with no grant handler cannot record
         * the parent's statement, and answering anything else would let the
         * daemon ACK a grant nothing observed.
         */
        expect(await handleIpcRequest({
            raw: JSON.stringify({
                op: 'grant', token: TOKEN, paramsBase64: PARAMS, dispatchToken: DISPATCH,
            }),
            token: TOKEN,
            handlers: handlers(),
        })).toEqual({ ok: false, reason: 'grant-unconfigured' });
    });

    it('shouldRefuseACallerWithoutTheBootToken', async () => {
        expect(await handleIpcRequest({
            raw: JSON.stringify({
                op: 'grant', token: 'wrong', paramsBase64: PARAMS, dispatchToken: DISPATCH,
            }),
            token: TOKEN,
            handlers: handlers(),
        })).toEqual({ ok: false, reason: 'unauthorized' });
    });
});


describe('authenticated supervisor hello', () => {
    const hello = {
        instanceNonce: 'N'.repeat(32), runtimeId: 'runtime opaque:1',
        provisioningOperationId: 'operation:1', markerSha256: 'a'.repeat(64),
    };
    it('authenticates before dispatch and rejects extra request fields', async () => {
        const callback = vi.fn(() => hello);
        for (const request of [
            { op: 'hello' }, { op: 'hello', token: 'wrong', extra: true },
        ]) {
            expect(await handleIpcRequest({ raw: JSON.stringify(request), token: TOKEN,
                handlers: { ...handlers(), hello: callback } })).toEqual({ ok: false, reason: 'unauthorized' });
        }
        expect(await handleIpcRequest({ raw: JSON.stringify({ op: 'hello', token: TOKEN, extra: true }),
            token: TOKEN, handlers: { ...handlers(), hello: callback } })).toEqual({ ok: false, reason: 'malformed' });
        expect(callback).not.toHaveBeenCalled();
        expect(await handleIpcRequest({ raw: JSON.stringify({ op: 'hello', token: TOKEN }),
            token: TOKEN, handlers: { ...handlers(), hello: callback } })).toEqual({ ok: true, result: hello });
        expect(callback).toHaveBeenCalledWith();
    });
    it('keeps unauthorized and extra-field requests away from the handler over a real socket', async () => {
        const { createIpcServer } = await import('./ipcServer');
        const { mkdtempSync, rmSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const { connect } = await import('node:net');
        const root = mkdtempSync(join(tmpdir(), 'hello-auth-'));
        const socketPath = join(root, 's.sock');
        const callback = vi.fn(() => hello);
        const ipc = createIpcServer({ socketPath, token: TOKEN, handlers: { ...handlers(), hello: callback } });
        const request = (body: unknown) => new Promise<unknown>((resolve, reject) => {
            const socket = connect(socketPath);
            socket.on('error', reject);
            socket.on('connect', () => socket.write(JSON.stringify(body) + '\n'));
            let raw = '';
            socket.on('data', (chunk) => {
                raw += chunk.toString();
                if (raw.includes('\n')) { socket.destroy(); resolve(JSON.parse(raw.trim())); }
            });
        });
        try {
            await ipc.listen();
            expect(await request({ op: 'hello' })).toEqual({ ok: false, reason: 'unauthorized' });
            expect(await request({ op: 'hello', token: 'wrong' })).toEqual({ ok: false, reason: 'unauthorized' });
            expect(await request({ op: 'hello', token: TOKEN, key: KEY })).toEqual({ ok: false, reason: 'malformed' });
            expect(callback).not.toHaveBeenCalled();
            expect(await request({ op: 'hello', token: TOKEN })).toEqual({ ok: true, result: hello });
            expect(callback).toHaveBeenCalledTimes(1);
        } finally {
            await ipc.close();
            rmSync(root, { recursive: true, force: true });
        }
    });
    it('refuses an absent or unavailable handler with a fixed reason', async () => {
        for (const h of [handlers(), { ...handlers(), hello: () => null }]) {
            expect(await handleIpcRequest({ raw: JSON.stringify({ op: 'hello', token: TOKEN }),
                token: TOKEN, handlers: h })).toEqual({ ok: false, reason: 'hello-unavailable' });
        }
    });
    it('parses exactly four bounded fields without normalizing identity or retaining the input', () => {
        expect(parseSupervisorHello(hello)).toEqual(hello);
        expect(parseSupervisorHello(hello)).not.toBe(hello);
        for (const patch of [
            { extra: true }, { instanceNonce: 'x'.repeat(31) }, { instanceNonce: 'x'.repeat(65) },
            { instanceNonce: 'x'.repeat(31) + '/' }, { instanceNonce: 'x'.repeat(32) + '\n' },
            { markerSha256: 'a'.repeat(64) + '\n' }, { markerSha256: 'A'.repeat(64) },
            { markerSha256: 'a'.repeat(63) }, { runtimeId: '' }, { runtimeId: ' leading' },
            { provisioningOperationId: 'trailing ' }, { runtimeId: 'x'.repeat(201) },
        ]) expect(parseSupervisorHello({ ...hello, ...patch })).toBeNull();
        for (const value of [null, [], {}, { ...hello, markerSha256: undefined }]) {
            expect(parseSupervisorHello(value)).toBeNull();
        }
        expect(parseSupervisorHello({ ...hello, instanceNonce: '_-'.repeat(32), runtimeId: 'x'.repeat(200) })).not.toBeNull();
    });
});
