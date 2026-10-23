/**
 * 자격 하나에 대한 프로세스 간 락 (aplus specs/codexcli-daemon-stream-durability C-R2·C-R6).
 *
 * 소유자(pid·시작 시각·bootId·획득 시각)를 기록하는 ownedFileLock 위에 두 가지를 얹는다.
 * 잡힐 때까지 기다리고(최대 60초), 자격 락 고유의 회수 조건(다른 부팅, 획득 후 120초)을 켠다.
 * 락 파일 이름은 자격 파일 실경로의 해시이고 내용은 소유자뿐이라, 토큰이나 계정 이름이 남지 않는다.
 *
 * 락은 자격 파일 바로 옆에 둔다. HAPPY_HOME_DIR 이 데몬·CLI·Desktop 원격 스크립트마다 다를 수
 * 있어도 같은 파일은 같은 락을 쓴다. 원격 스크립트(Desktop `src/sync/credentialFileLockScript.ts`)는
 * 이 모듈을 import 할 수 없으므로 같은 경로·형식을 그쪽에서 다시 쓴다 — 바꾸면 둘 다 바꾼다.
 *
 * 네트워크 요청을 감싸지 않는다(Q-C3). 읽기·비교·쓰기 같은 로컬 단계만 감싼다.
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { FileLockHeldError, withOwnedFileLock, type OwnedFileLockDeps } from '@/utils/ownedFileLock'

/** 락을 기다리는 상한. 넘으면 일시 실패로 끝낸다. */
export const CREDENTIAL_LOCK_WAIT_MS = 60_000
/** 이보다 오래 잡힌 락은 소유자가 살아 있어도 회수한다. 갱신 타임아웃(45초)의 두 배 이상. */
export const CREDENTIAL_LOCK_MAX_HOLD_MS = 120_000
const POLL_MS = 50

export class CredentialLockTimeoutError extends Error {
    constructor() {
        super('credential lock wait timed out')
        this.name = 'CredentialLockTimeoutError'
    }
}

/**
 * 자격 파일의 락 경로: 그 파일과 같은 폴더의 `.saycode-credential-<실경로 sha256 앞 32자>.lock`.
 * 파일이 아직 없으면 폴더의 실경로 + 파일 이름으로 키를 만든다.
 */
export function credentialFileLockPath(file: string): string {
    const real = realCredentialPath(file)
    const key = createHash('sha256').update(real).digest('hex').slice(0, 32)
    return join(dirname(real), `.saycode-credential-${key}.lock`)
}

function realCredentialPath(file: string): string {
    try {
        return realpathSync(file)
    } catch {
        try {
            return join(realpathSync(dirname(file)), basename(file))
        } catch {
            return resolve(file)
        }
    }
}

let bootIdCache: { value: string | undefined } | undefined

/** 이번 부팅의 식별자. 알 수 없는 플랫폼이면 undefined(그 조건만 건너뛴다). 프로세스 수명 동안 바뀌지 않아 한 번만 읽는다. */
export function currentBootId(): string | undefined {
    bootIdCache ??= { value: readBootId() }
    return bootIdCache.value
}

function readBootId(): string | undefined {
    try {
        if (process.platform === 'linux') return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined
        if (process.platform === 'darwin') {
            return execFileSync('sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined
        }
    } catch {
        // 읽지 못하면 부팅 비교만 빠진다. 나머지 회수 조건은 그대로다.
    }
    return undefined
}

/**
 * `lockPath` 를 잡고 `work` 를 실행한다. 살아 있는 다른 소유자가 잡고 있으면 `waitMs` 까지 기다리고,
 * 넘으면 {@link CredentialLockTimeoutError}. 죽은 소유자·다른 부팅·120초 넘은 락은 회수한다.
 */
export async function withCredentialLock<T>(
    lockPath: string,
    work: () => Promise<T>,
    options: { waitMs?: number; deps?: OwnedFileLockDeps } = {},
): Promise<T> {
    const deps: OwnedFileLockDeps = { bootId: currentBootId(), maxHoldMs: CREDENTIAL_LOCK_MAX_HOLD_MS, ...options.deps }
    const now = deps.now ?? Date.now
    const deadline = now() + (options.waitMs ?? CREDENTIAL_LOCK_WAIT_MS)
    for (;;) {
        let entered = false
        try {
            return await withOwnedFileLock(lockPath, () => {
                entered = true
                return work()
            }, deps)
        } catch (error) {
            // `work` 안에서 난 오류는 그대로 올린다. 락을 못 잡은 경우만 다시 기다린다.
            if (entered || !(error instanceof FileLockHeldError)) throw error
            if (now() >= deadline) throw new CredentialLockTimeoutError()
            await new Promise(resolveSleep => setTimeout(resolveSleep, POLL_MS))
        }
    }
}
