import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 파일 **소유자 관측만** 테스트에서 좁힌다 — 제품에는 아무 스위치도 두지 않는다.
 *
 * 이 테스트는 root 가 아니므로 실제 소유자로는 어떤 파일도 gate 를 통과하지 못하고,
 * 그러면 판독 경로가 통째로 검증되지 않는다. gate 를 주입받게 만들면 그 계약이
 * 호출자 마음이 되므로, 대신 `fstatSync` 가 돌려주는 **uid 한 필드**만 바꾼다.
 * mode·size·isFile 은 실제 파일의 것이 그대로 고정 gate 에 들어간다.
 */
const owner = vi.hoisted(() => ({ uid: null as number | null }));
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        fstatSync: (fd: number, ...rest: unknown[]) => {
            const stat = (actual.fstatSync as (fd: number, ...rest: unknown[]) => unknown)(fd, ...rest);
            if (owner.uid === null) return stat;
            return new Proxy(stat as object, {
                get: (target, key, receiver) => (key === 'uid'
                    ? owner.uid
                    : Reflect.get(target, key, receiver)),
            });
        },
    };
});

import type { ManagedProvisioningDeps } from '@/daemon/managedRuntimeIdentity';
import {
    managedSupervisorAttestationPath,
    MAX_ATTESTATION_BYTES,
    readManagedSupervisorAttestation,
    writeManagedSupervisorAttestation,
    type ManagedSupervisorAttestation,
    type ManagedSupervisorAttestationWriteDeps,
} from './managedSupervisorAttestation';

/** 고정 임시 이름의 규약. 모듈 내부이므로 테스트가 같은 규약을 적는다. */
const temporaryPath = (dir: string): string => `${managedSupervisorAttestationPath(dir)}.tmp`;

let stateDir: string;

const NONCE = 'A'.repeat(32);
const DIGEST = 'ab'.repeat(32);

function record(over: Partial<ManagedSupervisorAttestation> = {}): ManagedSupervisorAttestation {
    return {
        version: 1,
        instanceNonce: NONCE,
        socketPath: join(stateDir, 'launcher', 'launcher.sock'),
        // marker 축은 불투명하다. 경로 구성요소가 아니므로 safe-ID 로 좁히지 않는다.
        runtimeId: 'runtime.one:alpha',
        provisioningOperationId: 'op one/two',
        markerSha256: DIGEST,
        ...over,
    };
}

/**
 * 실제 파일을 쓰되 **관측만** 좁힌다 — 정책은 그대로 돈다.
 *
 * 이 테스트는 root 가 아니므로 실제 소유자로는 어떤 파일도 통과하지 못하고, 그러면
 * 판독 경로가 통째로 검증되지 않는다. 그래서 조상은 `lstatDir` 로, 파일은
 * `observedUid` 로 **소유자만** root 로 본다. mode·size·스키마·크기 판정은
 * 어느 것도 대체되지 않는다.
 */
function deps(): ManagedProvisioningDeps {
    return {
        getuid: () => 0,
        lstatDir: () => ({ uid: 0, mode: 0o700, isDirectory: true, isSymbolicLink: false }),
    } as unknown as ManagedProvisioningDeps;
}

/** 판독 호출의 기본형. 소유자 관측은 위 mock 이 root 로 좁힌다. */
const readBack = (over: { deps?: ManagedProvisioningDeps } = {}) =>
    readManagedSupervisorAttestation({ stateDir, deps: over.deps ?? deps() });

/** 실제 fs 를 쓰되 한 단계만 실패시키고, 열고 닫은 fd 를 센다. */
function tracked(over: Partial<ManagedSupervisorAttestationWriteDeps> = {}): {
    deps: ManagedSupervisorAttestationWriteDeps;
    balance: () => number;
} {
    const real = require('node:fs') as typeof import('node:fs');
    let open = 0;
    const base: ManagedSupervisorAttestationWriteDeps = {
        openSync: (...args: Parameters<typeof real.openSync>) => { open += 1; return real.openSync(...args); },
        writeSync: real.writeSync,
        fsyncSync: real.fsyncSync,
        closeSync: (fd: number) => { open -= 1; real.closeSync(fd); },
        renameSync: real.renameSync,
        unlinkSync: real.unlinkSync,
    };
    return { deps: { ...base, ...over }, balance: () => open };
}

beforeEach(() => {
    owner.uid = 0;
    stateDir = mkdtempSync(join(tmpdir(), 'attestation-'));
    mkdirSync(join(stateDir, 'launcher'), { recursive: true });
});
afterEach(() => {
    owner.uid = null;
    rmSync(stateDir, { recursive: true, force: true });
});

describe('the attestation file', () => {
    it('writes a record the reader accepts, byte for byte', () => {
        const written = writeManagedSupervisorAttestation({ stateDir, record: record(), provisioning: deps() });
        expect(written).toEqual({ ok: true });

        const read = readBack();
        expect(read).toEqual({ ok: true, attestation: record() });
    });

    it('is replaced whole: a second write leaves no trace of the first', () => {
        writeManagedSupervisorAttestation({ stateDir, record: record(), provisioning: deps() });
        const second = record({ instanceNonce: 'B'.repeat(40) });
        expect(writeManagedSupervisorAttestation({ stateDir, record: second, provisioning: deps() })).toEqual({ ok: true });

        const read = readBack();
        expect(read).toEqual({ ok: true, attestation: second });
        // 임시 파일은 남지 않는다.
        expect(existsSync(temporaryPath(stateDir))).toBe(false);
    });

    it('preserves the marker axis instead of narrowing it to a path grammar', () => {
        /*
         * marker 의 `runtimeId`/`provisioningOperationId` 는 trim 된 200자 이하의
         * **불투명 문자열**이다(`readString`). run/attempt 세그먼트의 safe-ID 문법으로
         * 좁히면, 생산자가 정당하게 낼 수 있는 marker 를 가진 runtime 이 영원히
         * 이 파일을 쓸 수도 읽을 수도 없게 된다.
         */
        const wide = record({
            runtimeId: `${'r'.repeat(190)}.x:y`,
            provisioningOperationId: 'op with spaces/and.dots:colons',
        });
        expect(writeManagedSupervisorAttestation({ stateDir, record: wide, provisioning: deps() })).toEqual({ ok: true });
        expect(readBack())
            .toEqual({ ok: true, attestation: wide });
    });
});

describe('what the schema refuses', () => {
    const bad: Array<[string, Partial<ManagedSupervisorAttestation>]> = [
        ['a version that is not 1', { version: 2 as never }],
        ['an empty runtimeId', { runtimeId: '   ' }],
        ['a runtimeId past 200 characters', { runtimeId: 'r'.repeat(201) }],
        ['an empty provisioningOperationId', { provisioningOperationId: '' }],
        ['a nonce shorter than the minted length', { instanceNonce: 'A'.repeat(31) }],
        ['a nonce past the maximum', { instanceNonce: 'A'.repeat(65) }],
        ['a nonce outside base64url', { instanceNonce: `${'A'.repeat(31)}+` }],
        ['an uppercase digest', { markerSha256: 'AB'.repeat(32) }],
        ['a digest of the wrong length', { markerSha256: 'ab'.repeat(31) }],
        ['a relative socket path', { socketPath: 'launcher/launcher.sock' }],
        /*
         * JSON 은 NUL 을 실어 나르지만 OS 경로는 그것을 담을 수 없다. 이 값은
         * `stateDir` 안이고 canonical 이므로, 거절하는 것은 **NUL 규칙 하나뿐**이다
         * — 다른 관문에 가려지지 않도록 일부러 그렇게 둔다.
         */
        ['a socket path with an embedded NUL', { socketPath: '' }],
    ];

    it.each(bad)('refuses to write %s', (_name, over) => {
        // 빈 자리는 `stateDir` 를 알아야 만들 수 있다 — 위 표는 그것을 모른다.
        const fixed = over.socketPath === ''
            ? { ...over, socketPath: `${join(stateDir, 'launcher', 'launcher')}\0.sock` }
            : over;
        expect(writeManagedSupervisorAttestation({ stateDir, record: record(fixed), provisioning: deps() }))
            .toEqual({ ok: false, stage: 'schema' });
        // 거절이면 파일을 만들지 않는다.
        expect(existsSync(managedSupervisorAttestationPath(stateDir))).toBe(false);
    });

    it('refuses a socket path outside the state directory, written or read', () => {
        // `<stateDir>` 자신도 아니고, 그 아래여야 한다. 같은 규칙을 양쪽이 쓴다.
        for (const socketPath of ['/etc/launcher.sock', stateDir, `${stateDir}-sibling/x.sock`]) {
            expect(writeManagedSupervisorAttestation({ stateDir, record: record({ socketPath }), provisioning: deps() }))
                .toEqual({ ok: false, stage: 'schema' });
        }
        writeFileSync(managedSupervisorAttestationPath(stateDir),
            JSON.stringify({ ...record(), socketPath: '/etc/launcher.sock' }), { mode: 0o600 });
        expect(readBack())
            .toEqual({ ok: false, reason: 'unusable' });
    });

    it('requires a canonical socket path and does not tidy one for the caller', () => {
        /*
         * `a/../b` 와 `b` 는 같은 파일을 가리키지만 문자열이 다르다. 그대로 받으면
         * 같은 소켓이 두 표기로 기록되고, 나중에 문자열 비교가 갈린다.
         * 반대로 끝 공백은 **정당한 이름**이라 다듬지 않는다 — 다듬으면 기록된 것과
         * 다른 파일을 가리킨다.
         */
        // `join` 은 스스로 펴므로 문자열로 만든다 — API 가 받는 것이 이 모양이다.
        const alias = `${stateDir}/launcher/../launcher/launcher.sock`;
        expect(writeManagedSupervisorAttestation({
            stateDir, record: record({ socketPath: alias }), provisioning: deps(),
        })).toEqual({ ok: false, stage: 'schema' });

        const spaced = join(stateDir, 'launcher', 'launcher.sock ');
        expect(writeManagedSupervisorAttestation({
            stateDir, record: record({ socketPath: spaced }), provisioning: deps(),
        })).toEqual({ ok: true });
        expect(readBack()).toEqual({ ok: true, attestation: record({ socketPath: spaced }) });
    });

    it('refuses an embedded NUL on the way back in as well', () => {
        /*
         * 쓰기에서만 막으면, 손으로 놓인 기록이 그대로 읽힌다. 같은 파서를 양쪽이
         * 지나므로 한 곳에 규칙을 둔다.
         */
        writeFileSync(managedSupervisorAttestationPath(stateDir),
            JSON.stringify({ ...record(), socketPath: `${join(stateDir, 'launcher')}\0/x.sock` }),
            { mode: 0o600 });
        expect(readBack()).toEqual({ ok: false, reason: 'unusable' });
    });

    it('refuses a relative state directory on the way in as well as out', () => {
        // 같은 계약이 양방향이다. `resolve` 가 cwd 로 펴기 전에 막는다.
        expect(readManagedSupervisorAttestation({ stateDir: 'relative/state', deps: deps() }))
            .toEqual({ ok: false, reason: 'untrusted' });
    });

    it('refuses an unknown key rather than reading a record it did not understand', () => {
        writeFileSync(managedSupervisorAttestationPath(stateDir),
            JSON.stringify({ ...record(), somethingNew: 1 }), { mode: 0o600 });
        expect(readBack())
            .toEqual({ ok: false, reason: 'unusable' });
    });

    it('tells absence apart from damage', () => {
        // 부재는 **모른다**는 뜻이다 — 아무도 발행하지 않았다는 증거가 아니다.
        expect(readBack())
            .toEqual({ ok: false, reason: 'absent' });
        writeFileSync(managedSupervisorAttestationPath(stateDir), 'not json', { mode: 0o600 });
        expect(readBack())
            .toEqual({ ok: false, reason: 'unusable' });
    });

    it('refuses an untrusted ancestor before it reads anything', () => {
        writeManagedSupervisorAttestation({ stateDir, record: record(), provisioning: deps() });
        const untrusted = {
            ...deps(),
            lstatDir: () => ({ uid: 1000, mode: 0o700, isDirectory: true, isSymbolicLink: false }),
        } as ManagedProvisioningDeps;
        const outcome = readBack({ deps: untrusted });
        expect(outcome).toEqual({ ok: false, reason: 'untrusted' });
        // 사유에 경로도 nonce 도 없다.
        expect(JSON.stringify(outcome)).not.toContain(stateDir);
    });
});

describe('the size bound', () => {
    it('refuses a well-formed record that is simply too big to write', () => {
        /*
         * 유효한 모양도 상한을 넘을 수 있다 — `socketPath` 하나가 경로 상한까지
         * 갈 수 있기 때문이다. 넘을 수 없다고 말하지 않고, 일어날 수 있는 결과로 다룬다.
         */
        const deep = join(stateDir, 'd'.repeat(200), 'e'.repeat(200));
        const long = join(...Array.from({ length: 44 }, () => 'f'.repeat(200)));
        const outcome = writeManagedSupervisorAttestation({
            stateDir, record: record({ socketPath: join(deep, long, 'launcher.sock') }),
            provisioning: deps(),
        });
        expect(outcome).toEqual({ ok: false, stage: 'too-large' });
        expect(existsSync(managedSupervisorAttestationPath(stateDir))).toBe(false);
    });

    it('refuses to read past the bound before it parses anything', () => {
        const padded = JSON.stringify({ ...record(), pad: 'x'.repeat(MAX_ATTESTATION_BYTES) });
        writeFileSync(managedSupervisorAttestationPath(stateDir), padded, { mode: 0o600 });
        expect(readBack())
            .toEqual({ ok: false, reason: 'unusable' });
    });
});

describe('the permission gate', () => {
    /*
     * 정책은 주입되지 않는다 — 이 테스트가 좁히는 것은 **소유자 관측 하나**이고,
     * 모드와 크기는 실제 파일의 것이 그대로 판정에 들어간다. gate 자체를 갈아끼울
     * 수 있으면 이 파일의 계약이 호출자 마음이 된다.
     */
    it('refuses every mode that is not exactly 0600', () => {
        writeManagedSupervisorAttestation({ stateDir, record: record(), provisioning: deps() });
        // 기존 공용 gate 였다면 앞의 둘은 통과했을 것이다.
        for (const mode of [0o640, 0o644, 0o400, 0o700, 0o606]) {
            chmodSync(managedSupervisorAttestationPath(stateDir), mode);
            expect(readBack()).toEqual({ ok: false, reason: 'untrusted' });
        }
        chmodSync(managedSupervisorAttestationPath(stateDir), 0o600);
        expect(readBack()).toMatchObject({ ok: true });
    });

    it('refuses a file that is not owned by root', () => {
        writeManagedSupervisorAttestation({ stateDir, record: record(), provisioning: deps() });
        owner.uid = 1000;
        expect(readBack()).toEqual({ ok: false, reason: 'untrusted' });
    });

    it('creates the file at 0600', () => {
        writeManagedSupervisorAttestation({ stateDir, record: record(), provisioning: deps() });
        const mode = require('node:fs').statSync(managedSupervisorAttestationPath(stateDir)).mode;
        expect(mode & 0o777).toBe(0o600);
    });
});

describe('what the writer refuses before it creates anything', () => {
    it('refuses an untrusted ancestor rather than writing there first', () => {
        /*
         * 판독에서만 막으면 늦다: 그때는 root 가 이미 남의 디렉터리에 파일을 만든
         * 뒤이고, 그 고정 임시 이름의 소유권도 이쪽 것이 아니다.
         */
        const untrusted = {
            ...deps(),
            lstatDir: () => ({ uid: 1000, mode: 0o700, isDirectory: true, isSymbolicLink: false }),
        } as ManagedProvisioningDeps;
        const outcome = writeManagedSupervisorAttestation({
            stateDir, record: record(), provisioning: untrusted,
        });
        expect(outcome).toEqual({ ok: false, stage: 'untrusted' });
        expect(existsSync(managedSupervisorAttestationPath(stateDir))).toBe(false);
        expect(existsSync(temporaryPath(stateDir))).toBe(false);
        expect(JSON.stringify(outcome)).not.toContain(stateDir);
    });

    it('refuses an ancestor owned by the daemon, not only by a stranger', () => {
        /*
         * 공용 경로 정책은 "root **또는** 이 daemon" 을 신뢰한다. 이 기록에는 그
         * 완화가 맞지 않는다 — 그 디렉터리에 쓸 수 있는 주체는 발행된 nonce 를
         * 고를 수 있고, 그러면 살아 있는 인스턴스가 영구 불일치로 보인다.
         */
        const daemonOwned = {
            getuid: () => 1000,
            lstatDir: () => ({ uid: 1000, mode: 0o700, isDirectory: true, isSymbolicLink: false }),
        } as unknown as ManagedProvisioningDeps;
        expect(writeManagedSupervisorAttestation({
            stateDir, record: record(), provisioning: daemonOwned,
        })).toEqual({ ok: false, stage: 'untrusted' });
        expect(readManagedSupervisorAttestation({ stateDir, deps: daemonOwned }))
            .toEqual({ ok: false, reason: 'untrusted' });
    });

    it('refuses a relative state directory and creates nothing', () => {
        /*
         * 상대 `stateDir` 는 스키마에서 먼저 죽는다 — 절대경로이면서 상대 디렉터리
         * 안에 있는 소켓 경로는 존재할 수 없기 때문이다. 어느 관문에서 막히든
         * **아무것도 만들지 않는다**는 것이 계약이다.
         */
        const outcome = writeManagedSupervisorAttestation({
            stateDir: 'relative/state', record: record(), provisioning: deps(),
        });
        expect(outcome.ok).toBe(false);
        expect(existsSync(join('relative/state', 'supervisor-attestation.json'))).toBe(false);
        expect(existsSync(`${join('relative/state', 'supervisor-attestation.json')}.tmp`)).toBe(false);
    });

    it('refuses a descriptor that never makes progress instead of spinning', () => {
        /*
         * 이 함수는 동기 임계구역에서 불린다. 0 을 계속 돌려주는 descriptor 를
         * 만나면 루프가 프로세스를 잡고, 그때는 supervisor 전체가 멈춘다.
         */
        /*
         * 첫 호출만 0 을 돌려주고 그 뒤는 실제 쓰기에 위임한다. 가드가 있으면
         * 즉시 `staged` 로 거절하고, 가드를 지우면 **멈추지 않고** 그대로 발행까지
         * 가서 이 단언이 실패한다 — 무한 대기가 아니라 실패로 드러나야 한다.
         */
        const real = require('node:fs') as typeof import('node:fs');
        let first = true;
        const { deps: stuck } = tracked({
            writeSync: (fd, buffer, offset, length) => {
                if (first) { first = false; return 0; }
                return real.writeSync(fd, buffer, offset, length);
            },
        });
        expect(writeManagedSupervisorAttestation({
            stateDir, record: record(), provisioning: deps(), deps: stuck,
        })).toEqual({ ok: false, stage: 'staged' });
        // 이 호출이 만든 임시 파일은 거둔다.
        expect(existsSync(temporaryPath(stateDir))).toBe(false);
        expect(existsSync(managedSupervisorAttestationPath(stateDir))).toBe(false);
    });
});

describe('the three ways a write can fail', () => {
    it('keeps the old record when staging fails, and removes only its own temporary', () => {
        writeManagedSupervisorAttestation({ stateDir, record: record(), provisioning: deps() });
        const before = readFileSync(managedSupervisorAttestationPath(stateDir), 'utf8');

        const { deps: failing, balance } = tracked({
            writeSync: () => { throw new Error('ENOSPC'); },
        });
        expect(writeManagedSupervisorAttestation({
            stateDir, record: record({ instanceNonce: 'C'.repeat(32) }),
            provisioning: deps(), deps: failing,
        })).toEqual({ ok: false, stage: 'staged' });

        expect(readFileSync(managedSupervisorAttestationPath(stateDir), 'utf8')).toBe(before);
        expect(existsSync(temporaryPath(stateDir))).toBe(false);
        expect(balance()).toBe(0);
    });

    it('keeps the old record when the rename fails', () => {
        writeManagedSupervisorAttestation({ stateDir, record: record(), provisioning: deps() });
        const before = readFileSync(managedSupervisorAttestationPath(stateDir), 'utf8');

        const { deps: failing, balance } = tracked({
            renameSync: () => { throw new Error('EXDEV'); },
        });
        expect(writeManagedSupervisorAttestation({
            stateDir, record: record({ instanceNonce: 'D'.repeat(32) }),
            provisioning: deps(), deps: failing,
        })).toEqual({ ok: false, stage: 'promote' });

        expect(readFileSync(managedSupervisorAttestationPath(stateDir), 'utf8')).toBe(before);
        expect(existsSync(temporaryPath(stateDir))).toBe(false);
        expect(balance()).toBe(0);
    });

    it('reports durability-unknown after the rename, and does not roll back', () => {
        /*
         * rename 은 이미 보였다. 되돌리면 이전 바이트가 없는데 있는 척하게 되고,
         * 성공으로 접으면 크래시 뒤 사라질 수 있는 기록을 남았다고 말하게 된다.
         * 모르는 것은 모른다고 남긴다.
         */
        writeManagedSupervisorAttestation({ stateDir, record: record(), provisioning: deps() });
        const next = record({ instanceNonce: 'E'.repeat(32) });
        let renamed = false;
        const real = require('node:fs') as typeof import('node:fs');
        const { deps: failing, balance } = tracked({
            renameSync: (from: string, to: string) => { real.renameSync(from, to); renamed = true; },
            fsyncSync: (fd: number) => { if (renamed) throw new Error('EIO'); real.fsyncSync(fd); },
        });
        expect(writeManagedSupervisorAttestation({ stateDir, record: next, deps: failing, provisioning: deps() }))
            .toEqual({ ok: false, stage: 'durability-unknown' });

        // 새 파일은 보인다 — 그 사실을 숨기지 않는다.
        expect(readBack())
            .toEqual({ ok: true, attestation: next });
        expect(balance()).toBe(0);
    });
});

describe('the fixed temporary name', () => {
    it('refuses loudly when one is already there and never removes it', () => {
        /*
         * 남아 있는 임시 파일은 다른 호출이나 이전 크래시의 것이다. 조용히 지우면
         * 살아 있는 발행을 밟을 수 있고, 조용히 재사용하면 남의 바이트 위에 쓴다.
         * 자동으로 치우지 않고 **발행을 거절**해 사람이 보게 남긴다.
         */
        const temporary = temporaryPath(stateDir);
        writeFileSync(temporary, 'someone else', { mode: 0o600 });

        expect(writeManagedSupervisorAttestation({ stateDir, record: record(), provisioning: deps() }))
            .toEqual({ ok: false, stage: 'temporary-exists' });

        expect(readFileSync(temporary, 'utf8')).toBe('someone else');
        expect(existsSync(managedSupervisorAttestationPath(stateDir))).toBe(false);
    });

    it('does not remove a foreign temporary when the write fails for another reason', () => {
        const temporary = temporaryPath(stateDir);
        const { deps: failing } = tracked({
            openSync: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
        });
        expect(writeManagedSupervisorAttestation({ stateDir, record: record(), deps: failing, provisioning: deps() }))
            .toEqual({ ok: false, stage: 'staged' });
        // 이번 호출은 아무것도 만들지 않았으므로 아무것도 지우지 않는다.
        expect(existsSync(temporary)).toBe(false);
    });
});
