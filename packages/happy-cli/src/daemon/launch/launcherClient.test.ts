import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Socket } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import { createLauncherClient, createUnixSocketRequest } from './launcherClient';

const TOKEN = 'token-1';
const KEY = { runId: 'run-1', attemptId: 'attempt-1', epoch: 2 };

function client(request: (payload: string) => Promise<string>) {
    return createLauncherClient({ token: TOKEN, deps: { request } });
}

describe('launcher client (daemon side)', () => {
    it('carries the boot token and never invents privileged fields', async () => {
        const sentPayloads: string[] = [];
        const request = vi.fn(async (payload: string) => {
            sentPayloads.push(payload);
            return JSON.stringify({ ok: true, result: { requested: true, detail: 'accepted' } });
        });
        await client(request).requestStop(KEY);
        const sent = JSON.parse(sentPayloads[0]!.trim());
        expect(sent).toEqual({ op: 'request-stop', key: KEY, token: TOKEN });
    });

    it('passes a refusal through instead of discarding it', async () => {
        const result = await client(async () => JSON.stringify({
            ok: true, result: { requested: false, detail: 'generation-absent' },
        })).requestStop(KEY);
        // `requested:false` 를 지우면 자식이 영원히 남는다.
        expect(result).toEqual({ requested: false, detail: 'generation-absent' });
    });

    it('a transport failure is not a stop', async () => {
        const result = await client(async () => { throw new Error('postgres://secret@host'); })
            .requestStop(KEY);
        expect(result).toEqual({ requested: false, detail: 'transport' });
        expect(JSON.stringify(result)).not.toContain('secret');
    });

    it('an unauthorized answer is not a stop', async () => {
        expect(await client(async () => JSON.stringify({ ok: false, reason: 'unauthorized' }))
            .requestStop(KEY)).toEqual({ requested: false, detail: 'unauthorized' });
    });

    it('asks the runtime-wide question the fencing contract defines', async () => {
        const sent: string[] = [];
        await client(async (payload) => {
            sent.push(payload);
            return JSON.stringify({ ok: true, result: { proven: true, detail: 'ok' } });
        }).proveGenerationStopped({ belowEpoch: Number.MAX_SAFE_INTEGER });
        // run/attempt 로 좁히지 않는다 — teardown 은 전체를 묻는다.
        expect(JSON.parse(sent[0]!.trim()))
            .toEqual({ op: 'prove-below', belowEpoch: Number.MAX_SAFE_INTEGER, token: TOKEN });
    });

    it('proves only when the supervisor says proven', async () => {
        expect(await client(async () => JSON.stringify({
            ok: true, result: { proven: true, detail: 'all-generations-observed-empty' },
        })).proveGenerationStopped({ belowEpoch: 2 }))
            .toEqual({ proven: true, detail: 'all-generations-observed-empty' });
    });

    it('absence of evidence is not proof of stopping', async () => {
        expect(await client(async () => JSON.stringify({
            ok: true, result: { proven: false, detail: 'generation-unknown' },
        })).proveGenerationStopped({ belowEpoch: 2 }))
            .toEqual({ proven: false, detail: 'generation-unknown' });
    });

    it('a truthy-but-not-true proven field does not prove anything', async () => {
        for (const proven of ['true', 1, {}, null]) {
            expect(await client(async () => JSON.stringify({ ok: true, result: { proven } }))
                .proveGenerationStopped({ belowEpoch: 2 }))
                .toMatchObject({ proven: false });
        }
    });

    it('a malformed answer is not a proof and not a stop', async () => {
        for (const raw of ['', 'not json', '[]', '"x"']) {
            expect(await client(async () => raw).proveGenerationStopped({ belowEpoch: 2 }))
                .toEqual({ proven: false, detail: 'malformed-response' });
            expect(await client(async () => raw).requestStop(KEY))
                .toEqual({ requested: false, detail: 'malformed-response' });
        }
    });
});

/*
 * Handing the supervisor a checkpoint target.
 *
 * The RPC lands in the daemon and the inbox that holds the target lives in the
 * supervisor process — that is where the checkpoint session and the drain it
 * shares with the tool session are. So this is the hop, and what it carries is
 * a one-shot key and signed upload URLs.
 *
 * Bytes, not a path: a path would let the caller choose what the privileged
 * process reads. The same reason the bootstrap envelope travels this way.
 */
describe('handing a checkpoint target to the supervisor', () => {
    const TARGET = {
        checkpointId: 'ckpt-7',
        keyBase64: Buffer.alloc(32, 5).toString('base64'),
        expiresAt: 1_900_000_600_000,
        targets: {
            areas: [{ area: 'project', putUrl: 'https://storage.test/PUT/o', headUrl: 'https://storage.test/HEAD/o' }],
            manifest: { putUrl: 'https://storage.test/PUT/m', headUrl: 'https://storage.test/HEAD/m' },
            pointer: { putUrl: 'https://storage.test/PUT/p', getUrl: 'https://storage.test/GET/p' },
        },
    };

    it.each([
        ['queued', true],
        ['replaced-unconsumed', true],
        ['in-flight', true],
        ['already-completed', true],
    ] as const)('carries the acceptance state %s back', async (state, accepted) => {
        /*
         * 네 가지 다 **수락**이다 — 이 hop 은 끝났다. 다른 것은 그 때문에
         * 아카이브가 일어나는가이고, 그것은 절대 추측하면 안 된다: `in-flight`
         * 는 나중에 다시 물을 일이고 `already-completed` 는 그 시도가 끝났다는
         * 뜻이라 다음 창으로 가야 한다.
         */
        const result = await client(async () => JSON.stringify({
            ok: true, result: { accepted: true, state },
        })).pushCheckpointTarget(TARGET, 'signed.token')
        expect(result).toEqual({ accepted, state, detail: state })
    })

    it('keeps the supervisor diagnostic instead of restating the state', async () => {
        /*
         * 수신단이 `replaced-unconsumed` 를 계약값 `queued` 로 normalize 하면서
         * 그 사실을 `detail` 에 담는다. 여기서 `detail` 을 state 로 덮으면 그
         * 진단이 이 hop 에서 사라져, "무엇이 대체됐는가" 를 아무도 못 본다.
         */
        expect(await client(async () => JSON.stringify({
            ok: true, result: { accepted: true, state: 'queued', detail: 'replaced-unconsumed' },
        })).pushCheckpointTarget(TARGET, 'signed.token'))
            .toEqual({ accepted: true, state: 'queued', detail: 'replaced-unconsumed' })
    })

    it('shouldSendTheDispatchTokenAsItsOwnFieldBesideTheTarget', async () => {
        /*
         * Two tokens, two jobs. The boot token says *this caller may speak on
         * this socket*; the dispatch token says *the parent signed this
         * document*. Folding the second into the params would put it inside
         * what it signs, and leaving it behind would hand the supervisor a
         * document it cannot authenticate - which is where the relay started.
         */
        const sent: string[] = [];
        const request = vi.fn(async (payload: string) => {
            sent.push(payload);
            return JSON.stringify({ ok: true, result: { accepted: true, state: 'queued' } });
        });
        await client(request).pushCheckpointTarget(TARGET, 'signed.token');
        const body = JSON.parse(sent[0]!.trim()) as Record<string, unknown>;
        expect(body.dispatchToken).toBe('signed.token');
        // Not inside the signed document, and not conflated with the bearer.
        expect(body.token).toBe(TOKEN);
        expect(Buffer.from(body.targetBase64 as string, 'base64').toString('utf8'))
            .not.toContain('signed.token');
    });

    it('sends the target as bytes, with the boot token', async () => {
        const sent: string[] = [];
        const request = vi.fn(async (payload: string) => {
            sent.push(payload);
            return JSON.stringify({ ok: true, result: { accepted: true, state: 'queued' } });
        });
        expect(await client(request).pushCheckpointTarget(TARGET, 'signed.token'))
            .toEqual({ accepted: true, state: 'queued', detail: 'queued' });
        const body = JSON.parse(sent[0]!.trim()) as Record<string, unknown>;
        expect(body.op).toBe('checkpoint-target');
        expect(body.token).toBe(TOKEN);
        expect(JSON.parse(Buffer.from(body.targetBase64 as string, 'base64').toString('utf8')))
            .toEqual(TARGET);
        // 평문으로 흘리지 않는다: 이 문서에는 한 체크포인트짜리 키가 있다.
        expect(sent[0]).not.toContain(TARGET.keyBase64);
    });

    it('reads a refusal as not accepted, and keeps its reason', async () => {
        // `checkpoint-unconfigured` 는 부모가 알아야 하는 사실이다 — 자격을
        // 발급했는데 놓을 데가 없다는 뜻이라, 그대로 만료된다.
        expect(await client(async () => JSON.stringify({ ok: false, reason: 'checkpoint-unconfigured' }))
            .pushCheckpointTarget(TARGET, 'signed.token'))
            .toEqual({ accepted: false, detail: 'checkpoint-unconfigured' });
    });

    it('reads an accepted:false answer as not accepted', async () => {
        expect(await client(async () => JSON.stringify({
            ok: true, result: { accepted: false, detail: 'target-invalid' },
        })).pushCheckpointTarget(TARGET, 'signed.token'))
            .toEqual({ accepted: false, detail: 'target-invalid' });
    });

    it('a transport failure is not an acceptance, and carries no payload', async () => {
        const result = await client(async () => { throw new Error('https://storage.test/PUT/o?sig=secret'); })
            .pushCheckpointTarget(TARGET, 'signed.token');
        expect(result).toEqual({ accepted: false, detail: 'transport' });
        expect(JSON.stringify(result)).not.toContain('sig=secret');
    });

    it('an unreadable answer is not an acceptance', async () => {
        expect(await client(async () => 'not json').pushCheckpointTarget(TARGET, 'signed.token'))
            .toEqual({ accepted: false, detail: 'malformed-response' });
    });
});

describe('relaying a runtime grant to the supervisor', () => {
    it('shouldSendTheTokenAndParamsAsSeparateFields', async () => {
        const sent: string[] = [];
        const request = vi.fn(async (payload: string) => {
            sent.push(payload);
            return JSON.stringify({ ok: true, result: { admitted: true } });
        });
        expect(await client(request).pushRuntimeGrant({
            token: 'signed.token', params: { requestedMs: 60_000 },
        })).toEqual({ admitted: true, detail: 'admitted' });
        const body = JSON.parse(sent[0]!.trim()) as Record<string, unknown>;
        expect(body.op).toBe('grant');
        expect(body.token).toBe(TOKEN);
        expect(body.dispatchToken).toBe('signed.token');
        // The params travel as the bytes they were signed as - the signature is
        // over the document, so a re-serialisation here would break it.
        expect(JSON.parse(Buffer.from(body.paramsBase64 as string, 'base64').toString('utf8')))
            .toEqual({ requestedMs: 60_000 });
    });

    it('shouldReportAnyNonAdmissionAsNotAdmitted', async () => {
        // Every refusal and every unreadable answer. Folding one into an
        // acceptance tells the daemon a grant is recorded when it is not.
        for (const answer of [
            JSON.stringify({ ok: false, reason: 'grant-stale-renewal' }),
            JSON.stringify({ ok: true, result: { admitted: false, detail: 'expired' } }),
            JSON.stringify({ ok: true, result: null }),
            'not json',
        ]) {
            const result = await client(async () => answer)
                .pushRuntimeGrant({ token: 'signed.token', params: { requestedMs: 1 } });
            expect(result.admitted).toBe(false);
        }
    });
});

/**
 * 소켓 경로 게이트.
 *
 * **매 연결 전에** 소켓 디렉터리와 그 조상 전부가 root 소유이고, symlink 가 아니며,
 * group/other-writable 이 아님을 확인한다. 요청마다 새 연결이 열리고 그 첫 줄에 boot
 * token 이 실리므로(`createUnixSocketRequest`), 경로 신뢰는 연결마다 필요하다 —
 * startup 에 한 번 본 것은 그 다음 연결을 대신하지 못한다.
 *
 * **소켓 leaf 자체는 보지 않는다.** 디렉터리가 leaf 를 지킨다. 그 이름에 root 소유의
 * 다른 파일이 있으면 `connect` 가 실패하고 `transport` 로 접힌다.
 *
 * 센티널 타입은 **export 되지 않는다.** 그래서 여기서는 그것을 만들지 않고, 실제
 * 게이트를 거절시켜 나온 값만 본다 — 테스트가 자기가 던진 값을 확인하면 생산 경로의
 * 분류가 증명되지 않는다. `instanceof` 이므로 모듈을 두 번 적재하면 코드가
 * `transport` 로 떨어진다(fail-closed 이지만 코드는 사라진다). 이 파일은 구현과
 * 같은 모듈 인스턴스를 쓴다.
 */
describe('the socket path gate', () => {
    const SOCKET = '/state/launcher/launcher.sock';
    const rootDir = { uid: 0, mode: 0o700, isDirectory: true, isSymbolicLink: false };

    /** 관측만 주입한다 — 걷기와 정책은 어느 경우에도 돈다. */
    function gated(over: {
        lstat?: (path: string) => typeof rootDir;
        onConnect?: (path: string) => void;
    }) {
        const connected: string[] = [];
        const deps = createUnixSocketRequest(SOCKET, 50, {
            provisioning: {
                lstatDir: over.lstat ?? (() => rootDir),
            } as never,
            connect: ((path: string) => {
                connected.push(path);
                over.onConnect?.(path);
                // 응답 없이 즉시 끝나는 소켓. 여기서 보는 것은 게이트이지 왕복이 아니다.
                return {
                    setTimeout: (_ms: number, cb: () => void) => { setTimeout(cb, 0); },
                    setEncoding: () => {},
                    on: () => {},
                    destroy: () => {},
                    write: () => {},
                } as never;
            }) as never,
        });
        return { deps, connected };
    }

    it('refuses a component owned by anyone but root, including the daemon', async () => {
        /*
         * 기존 경로 정책(`trustedPathRefusal` 의 기본 호출)은 daemon 소유 조상을
         * **허용한다**. 이 자리에서는 허용하지 않는다 — 그 디렉터리에 쓸 수 있는
         * 주체는 소켓을 바꿔치기하고 그 뒤 모든 요청의 token 을 받는다.
         */
        for (const uid of [1000, 4242]) {
            const { deps, connected } = gated({
                lstat: (path) => (path === '/state' ? { ...rootDir, uid } : rootDir),
            });
            const failure = await deps.request('{}\n').then(() => null, (error: Error) => error);
            expect([failure?.name, failure?.message])
                .toEqual(['LauncherPathUntrustedError', 'backend-path-untrusted']);
            // 거절이면 **소켓을 열지 않는다.** token 은 프로세스를 떠나지 않는다.
            expect(connected).toEqual([]);
        }
    });

    it('refuses a symlinked, non-directory, or group-writable component', async () => {
        const broken = [
            { ...rootDir, isSymbolicLink: true },
            { ...rootDir, isDirectory: false },
            { ...rootDir, mode: 0o770 },
            { ...rootDir, mode: 0o707 },
        ];
        for (const stat of broken) {
            const { deps, connected } = gated({
                lstat: (path) => (path === '/state/launcher' ? stat : rootDir),
            });
            const failure = await deps.request('{}\n').then(() => null, (error: Error) => error);
            expect(failure?.message).toBe('backend-path-untrusted');
            expect(connected).toEqual([]);
        }
    });

    it('refuses when a component cannot be observed at all', async () => {
        // 못 본 것은 신뢰의 근거가 아니다.
        const { deps, connected } = gated({
            lstat: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
        });
        const failure = await deps.request('{}\n').then(() => null, (error: Error) => error);
        expect(failure?.message).toBe('backend-path-untrusted');
        expect(connected).toEqual([]);
    });

    it('connects when every component is root-owned and not writable by others', async () => {
        for (const mode of [0o700, 0o710, 0o755]) {
            const { deps, connected } = gated({ lstat: () => ({ ...rootDir, mode }) });
            await deps.request('{}\n').catch(() => undefined);
            expect(connected).toEqual([SOCKET]);
        }
    });

    it('walks again for every connection', async () => {
        /*
         * 한 연결에서 한 일이 다음 연결을 대신하지 않는다. 캐시하면 정확히 지금의
         * 결함(startup 1회 검사)으로 돌아간다.
         */
        let trusted = true;
        const { deps, connected } = gated({
            lstat: () => (trusted ? rootDir : { ...rootDir, uid: 1000 }),
        });
        await deps.request('{}\n').catch(() => undefined);
        expect(connected).toEqual([SOCKET]);
        trusted = false;
        await expect(deps.request('{}\n')).rejects.toMatchObject({
            message: 'backend-path-untrusted',
        });
        // 두 번째는 열리지 않았다.
        expect(connected).toEqual([SOCKET]);
    });

    it('carries no path and no token in the refusal', async () => {
        /*
         * walker 의 `detail` 은 `"<component>: <reason>"` 이다. 센티널은 그것을
         * 버린다 — 진단 하나 때문에 경로가 로그로 흘러나가지 않는다.
         */
        const { deps } = gated({ lstat: () => ({ ...rootDir, uid: 1000 }) });
        const failure = await deps.request('{"token":"secret-boot-token"}\n')
            .then(() => null, (error: Error) => error);
        const shown = `${failure?.name}|${failure?.message}|${failure?.stack ?? ''}`;
        expect(shown).not.toContain('/state');
        expect(shown).not.toContain('secret-boot-token');
        expect(failure?.message).toBe('backend-path-untrusted');
        expect(JSON.stringify(failure)).not.toContain('/state');
    });

    it('reports the gate as its own reason and everything else as transport', async () => {
        /*
         * `instanceof` 하나만 본다. `message`/`code` 는 읽지 않는다 — 임의 문자열이
         * 거절 코드가 되는 순간 backend 가 코드를 고르게 된다.
         */
        // 실제 게이트가 거절한 값이 client 를 지나 코드가 되는지를 본다.
        const { deps, connected } = gated({ lstat: () => ({ ...rootDir, uid: 1000 }) });
        const gate = await createLauncherClient({ token: TOKEN, deps }).requestStop(KEY);
        expect(gate).toEqual({ requested: false, detail: 'backend-path-untrusted' });
        expect(connected).toEqual([]);

        // 같은 문자열을 단 다른 오류는 흉내일 뿐이다.
        for (const thrown of [
            new Error('backend-path-untrusted'),
            Object.assign(new Error('x'), { code: 'backend-path-untrusted' }),
            Object.assign(new Error('backend-path-untrusted'), { name: 'LauncherPathUntrustedError' }),
            null,
        ]) {
            const other = await createLauncherClient({
                token: TOKEN,
                deps: { request: async () => { throw thrown; } },
            }).requestStop(KEY);
            expect(other).toEqual({ requested: false, detail: 'transport' });
        }
    });

    it('is not wired with the observation override at the production call site', async () => {
        /*
         * 주입 인자는 export 된 생산 파라미터다. 운영 호출부가 그것을 넘기기
         * 시작하면 게이트가 관측을 스스로 고르게 되므로, 호출부를 고정한다.
         */
        const run = readFileSync(join(__dirname, '..', 'run.ts'), 'utf8');
        const calls = [...run.matchAll(/createUnixSocketRequest\(([^)]*)\)/g)].map((m) => m[1]!);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toBe('launcher.binding.socketPath');
    });
});


describe('bounded supervisor hello client', () => {
    const hello = { instanceNonce: 'n'.repeat(32), runtimeId: 'runtime:1',
        provisioningOperationId: 'operation:1', markerSha256: 'a'.repeat(64) };
    const reply = JSON.stringify({ ok: true, result: hello });

    it('requests the exact hello with bounded transport options and validates the copied result', async () => {
        const request = vi.fn(async () => reply);
        expect(await client(request).hello()).toEqual({ ok: true, result: hello });
        expect(request).toHaveBeenCalledWith(JSON.stringify({ op: 'hello', token: TOKEN }) + '\n', { mode: 'hello' });
    });
    it('rejects malformed envelopes and payloads without forwarding arbitrary refusal text', async () => {
        for (const raw of ['null', '[]', '{}', '{',
            JSON.stringify({ ok: true, result: hello, extra: true }),
            JSON.stringify({ ok: true, result: { ...hello, extra: true } }),
            JSON.stringify({ ok: false, reason: 'secret', extra: true }),
            JSON.stringify({ ok: false }),
            JSON.stringify({ ok: 1, result: hello }),
            JSON.stringify({ ok: true, result: { ...hello, runtimeId: ' padded ' } }),
        ]) expect(await client(async () => raw).hello()).toEqual({ ok: false, reason: 'malformed-response' });
        expect(await client(async () => JSON.stringify({ ok: false, reason: 'secret/path/token' })).hello())
            .toEqual({ ok: false, reason: 'hello-refused' });
        expect(await client(async () => { throw new Error('secret'); }).hello())
            .toEqual({ ok: false, reason: 'transport' });
    });
    it('uses the same 4096 byte first-frame limit for injected raw lines, excluding LF', async () => {
        const exact = reply + ' '.repeat(4096 - Buffer.byteLength(reply));
        expect(await client(async () => exact).hello()).toEqual({ ok: true, result: hello });
        expect(await client(async () => exact + '\nignored').hello()).toEqual({ ok: true, result: hello });
        expect(await client(async () => exact + ' ').hello()).toEqual({ ok: false, reason: 'response-too-large' });
        expect(await client(async () => exact + ' \n').hello()).toEqual({ ok: false, reason: 'response-too-large' });
        const multibyte = JSON.stringify({ ok: true, result: { ...hello, runtimeId: 'é' } });
        const bytes = Buffer.byteLength(multibyte);
        expect(await client(async () => multibyte + ' '.repeat(4096 - bytes)).hello()).toEqual({ ok: true, result: { ...hello, runtimeId: 'é' } });
        expect(await client(async () => multibyte + ' '.repeat(4097 - bytes)).hello()).toEqual({ ok: false, reason: 'response-too-large' });
    });
    function transport(over: { connect?: (path: string) => Socket; lstat?: () => never } = {}) {
        const socket = new Socket();
        const write = vi.spyOn(socket, 'write').mockReturnValue(true);
        const connect = vi.fn(over.connect ?? (() => socket));
        const deps = createUnixSocketRequest('/trusted/launcher.sock', 1, {
            connect,
            provisioning: { getuid: () => 0,
                lstatDir: over.lstat ?? (() => ({ uid: 0, mode: 0o755, isDirectory: true, isSymbolicLink: false })),
                probeIsolationBackend: () => ({ verified: true }),
            },
        });
        return { socket, write, connect, client: createLauncherClient({ token: TOKEN, deps }) };
    }
    it('bounds total waiting despite a slow trickle and prevents late connect from writing a token', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        let now = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        try {
            const t = transport();
            let settled = false;
            const pending = t.client.hello().then((result) => { settled = true; return result; });
            t.socket.emit('connect');
            for (let i = 1; i <= 4; i++) {
                now = i * 1000;
                await vi.advanceTimersByTimeAsync(1000);
                t.socket.emit('data', Buffer.from(' '));
                expect(settled).toBe(false);
            }
            now = 4999;
            await vi.advanceTimersByTimeAsync(999);
            expect(settled).toBe(false);
            now = 5000;
            await vi.advanceTimersByTimeAsync(1);
            expect(await pending).toEqual({ ok: false, reason: 'timeout' });
            expect(t.socket.destroyed).toBe(true);
            expect(t.socket.listenerCount('data')).toBe(0);
            expect(t.write).toHaveBeenCalledTimes(1);
            t.socket.emit('connect');
            t.socket.emit('data', Buffer.from(reply + '\n'));
            expect(t.write).toHaveBeenCalledTimes(1);
            const late = transport();
            const waiting = late.client.hello();
            now = 10000;
            await vi.advanceTimersByTimeAsync(5000);
            expect(await waiting).toEqual({ ok: false, reason: 'timeout' });
            late.socket.emit('connect');
            late.socket.emit('data', Buffer.from(reply + '\n'));
            expect(late.write).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
    });
    it('checks elapsed time before success and before a delayed connect even if the timer has not run', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        let now = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        try {
            const t = transport(); const pending = t.client.hello(); t.socket.emit('connect');
            now = 5000;
            t.socket.emit('data', Buffer.from(reply + '\n'));
            expect(await pending).toEqual({ ok: false, reason: 'timeout' });
            const late = transport(); const waiting = late.client.hello();
            now = 10000;
            late.socket.emit('connect');
            expect(await waiting).toEqual({ ok: false, reason: 'timeout' });
            expect(late.write).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
    });
    it('waits for LF at the exact byte cap and refuses the next non-LF byte', async () => {
        const exact = Buffer.from(reply + ' '.repeat(4096 - Buffer.byteLength(reply)));
        const t = transport(); let settled = false;
        const pending = t.client.hello().then((r) => { settled = true; return r; });
        t.socket.emit('data', exact);
        await Promise.resolve(); expect(settled).toBe(false);
        t.socket.emit('data', Buffer.from('\n' + 'x'.repeat(100000)));
        expect(await pending).toEqual({ ok: true, result: hello });
        for (const suffix of [' ', ' \n']) {
            const t = transport(); const pending = t.client.hello();
            t.socket.emit('data', exact);
            t.socket.emit('data', Buffer.from(suffix));
            expect(await pending).toEqual({ ok: false, reason: 'response-too-large' });
        }
        const huge = transport(); const oversized = huge.client.hello();
        huge.socket.emit('data', Buffer.from('x'.repeat(4097) + '\n' + reply));
        expect(await oversized).toEqual({ ok: false, reason: 'response-too-large' });
    });
    it('decodes split multibyte UTF8 only after framing and refuses invalid bytes or a malformed first frame', async () => {
        const multibyte = Buffer.from(JSON.stringify({ ok: true, result: { ...hello, runtimeId: '한글' } }) + '\n');
        const at = multibyte.indexOf(Buffer.from('한')) + 1;
        const t = transport(); const pending = t.client.hello();
        t.socket.emit('data', multibyte.subarray(0, at));
        t.socket.emit('data', multibyte.subarray(at));
        expect(await pending).toEqual({ ok: true, result: { ...hello, runtimeId: '한글' } });
        for (const bytes of [
            Buffer.concat([Buffer.from(reply.split('runtime:1')[0]!),
                Buffer.from([0xff]), Buffer.from(reply.split('runtime:1')[1]! + '\n')]),
            Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(reply + '\n')]),
            Buffer.from('bad\n' + reply + '\n'),
        ]) {
            const t = transport(); const pending = t.client.hello();
            t.socket.emit('data', bytes);
            expect(await pending).toEqual({ ok: false, reason: 'malformed-response' });
        }
    });
    it('settles safely on close, socket errors, synchronous connection failures and path observation throws', async () => {
        for (const event of ['close', 'error']) {
            const t = transport(); const pending = t.client.hello();
            t.socket.emit(event, new Error('secret'));
            expect(await pending).toEqual({ ok: false, reason: 'transport' });
            t.socket.emit('connect'); expect(t.write).not.toHaveBeenCalled();
            t.socket.emit('error', new Error('late secret'));
        }
        const failed = transport({ connect: () => { throw new Error('secret'); } });
        expect(await failed.client.hello()).toEqual({ ok: false, reason: 'transport' });
        const path = transport({ lstat: () => { throw new Error('secret'); } });
        expect(await path.client.hello()).toEqual({ ok: false, reason: 'backend-path-untrusted' });
        expect(path.connect).not.toHaveBeenCalled(); expect(path.write).not.toHaveBeenCalled();
    });
    it('reads bounded raw bytes through an actual Unix socket and sends the exact authenticated request', async () => {
        const { createServer } = await import('node:net');
        const { mkdtempSync, rmSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const root = mkdtempSync(join(tmpdir(), 'hello-client-'));
        const socketPath = join(root, 's.sock');
        const seen: unknown[] = [];
        const replies = [Buffer.from(reply + '\n'), Buffer.from('x'.repeat(4097) + '\n'), Buffer.from([0xff, 10])];
        const server = createServer((socket) => {
            socket.once('data', (chunk) => {
                seen.push(JSON.parse(chunk.toString().trim()));
                const response = replies.shift();
                if (!response) throw new Error('unexpected fixture request');
                socket.end(response);
            });
        });
        try {
            await new Promise<void>((resolve) => server.listen(socketPath, resolve));
            // Actual filesystem/socket bytes under this UID; ancestry observation only is simulated.
            const deps = createUnixSocketRequest(socketPath, 5000, { provisioning: {
                getuid: () => 0,
                lstatDir: () => ({ uid: 0, mode: 0o755, isDirectory: true, isSymbolicLink: false }),
                probeIsolationBackend: () => ({ verified: true }),
            } });
            const actual = createLauncherClient({ token: TOKEN, deps });
            expect(await actual.hello()).toEqual({ ok: true, result: hello });
            expect(await actual.hello()).toEqual({ ok: false, reason: 'response-too-large' });
            expect(await actual.hello()).toEqual({ ok: false, reason: 'malformed-response' });
            expect(seen).toEqual(Array.from({ length: 3 }, () => ({ op: 'hello', token: TOKEN })));
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            rmSync(root, { recursive: true, force: true });
        }
    });

});
