/**
 * 갱신형 자격의 복구 상태머신과 실패 분류
 * (aplus specs/codexcli-daemon-stream-durability C-R1~C-R3, plan C-2).
 *
 * 저장값 재조회 → (요청 지문과 다르면) 남이 이미 갱신했으니 그 값으로 끝 → 같은 지문의 영구 실패가
 * 캐시돼 있으면 네트워크 없이 실패 → 락 → 락 안에서 재조회(바뀌었으면 경합 패배, 실패 아님) → 갱신 →
 * 쓰기. 각 단계는 호출당 한 번이다. 토큰 종류별 차이는 어댑터(`read`·`fingerprint`·`refresh`·`write`)와
 * 락(`lock`)으로 넘긴다. happy-cli 에서 파일 락은 네트워크를 감싸지 않으므로(Q-C3), 네트워크 갱신을
 * 하는 어댑터는 프로세스 안 직렬화({@link createSerialLock})를 쓴다.
 *
 * 로그에는 지문만 남긴다. 토큰 원문은 어댑터 밖으로 나오지 않는다.
 */

import { createHash } from 'node:crypto'
import { logger } from '@/ui/logger'

export type RefreshFailureClass = 'permanent' | 'transient'
/** 머신 RPC 경계에 넘기는 분류(C-R7). 비밀은 넘기지 않는다. */
export type CredentialFailureClassification = RefreshFailureClass | 'lost-race'

/** 갱신 요청 타임아웃 상한(C-R2). 어댑터가 더 짧게 줄 수 있다. */
export const REFRESH_REQUEST_TIMEOUT_MS = 45_000

/** OAuth 오류 코드 중 다시 시도해도 낫지 않는 것: refresh token 이 만료·재사용·폐기됐다. */
const PERMANENT_ERROR_CODES = new Set([
    'invalid_grant',
    'refresh_token_expired',
    'refresh_token_reused',
    'refresh_token_invalidated',
])

/** 갱신 엔드포인트의 거절. `code` 는 OAuth `error` 값(또는 어댑터가 정한 같은 뜻의 값). */
export class RefreshFailure extends Error {
    constructor(readonly detail: { status?: number; code?: string }) {
        super(`credential refresh rejected${detail.status === undefined ? '' : ` (${detail.status})`}${detail.code ? ` ${detail.code}` : ''}`)
        this.name = 'RefreshFailure'
    }
}

/**
 * 영구(다시 연결 필요) 또는 일시(기존 자격 유지·나중에 재시도). 영구는 확실한 것만:
 * refresh token 만료·재사용·폐기 코드와 갱신 엔드포인트의 401. 네트워크·타임아웃·5xx·429와
 * 그 밖의 알 수 없는 실패는 일시로 둔다 — 거짓 "다시 연결 필요"가 재시도보다 비싸다.
 */
export function classifyRefreshFailure(error: unknown): RefreshFailureClass {
    if (!(error instanceof RefreshFailure)) return 'transient'
    const { status, code } = error.detail
    if (code !== undefined && PERMANENT_ERROR_CODES.has(code)) return 'permanent'
    return status === 401 ? 'permanent' : 'transient'
}

/** 자격 지문: `sha256(kind, accountKey, secret)` 앞 16바이트. 로그·락·캐시에는 이것만 쓴다. */
export function credentialFingerprint(kind: string, accountKey: string, secret: string): string {
    return createHash('sha256').update(`${kind}\0${accountKey}\0${secret}`).digest('hex').slice(0, 32)
}

/** 프로세스 안에서 순서대로 한 번에 하나씩 실행한다. 기다린 쪽은 앞선 갱신이 끝난 뒤 재조회한다. */
export function createSerialLock(): <R>(work: () => Promise<R>) => Promise<R> {
    let tail: Promise<unknown> = Promise.resolve()
    return <R>(work: () => Promise<R>): Promise<R> => {
        const run = tail.then(work)
        tail = run.catch(() => undefined)
        return run
    }
}

/** 영구 실패한 지문. 같은 지문으로는 다시 네트워크를 쓰지 않는다. 지문이 바뀌면(새 자격) 자연히 풀린다. */
const permanentFailures = new Set<string>()

export function hasPermanentRefreshFailure(fingerprint: string): boolean {
    return permanentFailures.has(fingerprint)
}

/** 테스트 전용: 프로세스 수명 캐시를 비운다. */
export function resetPermanentRefreshFailuresForTest(): void {
    permanentFailures.clear()
}

export interface RefreshAdapter<T> {
    /** 저장된 현재 값. 없으면 null. */
    read(): Promise<T | null>
    fingerprint(value: T): string
    /** 갱신 요청. 거절은 {@link RefreshFailure} 로 던진다. `signal` 은 타임아웃에 끊긴다. */
    refresh(current: T, signal: AbortSignal): Promise<T>
    write(next: T): Promise<void>
}

export type RefreshOutcome<T> =
    | { status: 'refreshed'; value: T }
    /** 다른 실행 단위가 먼저 갱신했다. 실패가 아니며, 그 값으로 다시 시도하면 된다. */
    | { status: 'lost-race'; value: T }
    /** `cached` 는 이미 알려진 영구 실패라 네트워크를 쓰지 않았다는 뜻 — 안내를 다시 띄우지 않는다. */
    | { status: 'failed'; classification: RefreshFailureClass; cached?: true }

/**
 * `usedFingerprint` 로 요청했던 자격을 복구한다(401 직후 또는 선제 갱신).
 */
export async function recoverCredential<T>(
    adapter: RefreshAdapter<T>,
    usedFingerprint: string,
    options: { lock: <R>(work: () => Promise<R>) => Promise<R>; refreshTimeoutMs?: number },
): Promise<RefreshOutcome<T>> {
    const tag = `[credential-refresh] fp=${usedFingerprint.slice(0, 12)}`
    const changed = async (): Promise<T | null> => {
        const current = await adapter.read()
        return current !== null && adapter.fingerprint(current) !== usedFingerprint ? current : null
    }
    try {
        const already = await changed()
        if (already !== null) {
            logger.debug(`${tag} already replaced — using the stored value`)
            return { status: 'lost-race', value: already }
        }
        if (permanentFailures.has(usedFingerprint)) return { status: 'failed', classification: 'permanent', cached: true }
        return await options.lock(async (): Promise<RefreshOutcome<T>> => {
            const current = await adapter.read()
            if (current === null) return { status: 'failed', classification: 'permanent' }
            if (adapter.fingerprint(current) !== usedFingerprint) {
                logger.debug(`${tag} lost the race — another holder refreshed first`)
                return { status: 'lost-race', value: current }
            }
            let next: T
            try {
                next = await withTimeout(signal => adapter.refresh(current, signal), options.refreshTimeoutMs ?? REFRESH_REQUEST_TIMEOUT_MS)
            } catch (error) {
                const classification = classifyRefreshFailure(error)
                if (classification === 'permanent') permanentFailures.add(usedFingerprint)
                logger.debug(`${tag} refresh failed (${classification}${error instanceof RefreshFailure && error.detail.status ? ` ${error.detail.status}` : ''})`)
                return { status: 'failed', classification }
            }
            await adapter.write(next)
            logger.debug(`${tag} refreshed`)
            return { status: 'refreshed', value: next }
        })
    } catch (error) {
        // 락 대기 초과·저장 실패 등: 기존 자격을 그대로 두고 나중에 다시 시도한다.
        logger.debug(`${tag} recovery interrupted (${error instanceof Error ? error.name : typeof error}) — keeping the current credential`)
        return { status: 'failed', classification: 'transient' }
    }
}

async function withTimeout<R>(run: (signal: AbortSignal) => Promise<R>, timeoutMs: number): Promise<R> {
    const controller = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            controller.abort()
            reject(new Error('credential refresh timed out'))
        }, timeoutMs)
    })
    try {
        // 신호를 무시하는 어댑터도 락을 붙잡지 못하게 타임아웃과 경주한다.
        return await Promise.race([run(controller.signal), timedOut])
    } finally {
        clearTimeout(timer)
    }
}
