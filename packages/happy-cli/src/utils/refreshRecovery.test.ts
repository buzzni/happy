import { afterEach, describe, expect, it, vi } from 'vitest'
import { logger } from '@/ui/logger'
import {
    classifyRefreshFailure,
    createSerialLock,
    credentialFingerprint,
    hasPermanentRefreshFailure,
    recoverCredential,
    RefreshFailure,
    resetPermanentRefreshFailuresForTest,
    type RefreshAdapter,
} from './refreshRecovery'

const SECRET = 'rt-SECRET-VALUE-0001'
const fp = (secret: string) => credentialFingerprint('test', 'account-1', secret)

/** 메모리에 든 자격 하나. `refresh` 는 테스트마다 갈아 끼운다. */
function memoryCredential(initial: string | null, refresh: RefreshAdapter<string>['refresh']) {
    const state = { value: initial, writes: 0 }
    const adapter: RefreshAdapter<string> = {
        read: async () => state.value,
        fingerprint: fp,
        refresh: vi.fn(refresh),
        write: async (next) => { state.value = next; state.writes += 1 },
    }
    return { state, adapter }
}

afterEach(() => {
    resetPermanentRefreshFailuresForTest()
    vi.restoreAllMocks()
})

describe('classifyRefreshFailure', () => {
    it.each([
        ['invalid_grant', new RefreshFailure({ status: 400, code: 'invalid_grant' })],
        ['refresh token expired', new RefreshFailure({ status: 400, code: 'refresh_token_expired' })],
        ['refresh token reused', new RefreshFailure({ status: 400, code: 'refresh_token_reused' })],
        ['refresh token revoked', new RefreshFailure({ status: 400, code: 'refresh_token_invalidated' })],
        ['refresh endpoint 401', new RefreshFailure({ status: 401 })],
    ])('treats %s as permanent', (_name, error) => {
        expect(classifyRefreshFailure(error)).toBe('permanent')
    })

    it.each([
        ['a network failure', new TypeError('fetch failed')],
        ['a timeout', Object.assign(new Error('timed out'), { name: 'TimeoutError' })],
        ['a 5xx', new RefreshFailure({ status: 503 })],
        ['a 429', new RefreshFailure({ status: 429 })],
        ['an unknown rejection', new RefreshFailure({ status: 409 })],
    ])('treats %s as transient', (_name, error) => {
        expect(classifyRefreshFailure(error)).toBe('transient')
    })
})

describe('recoverCredential', () => {
    it('refreshes once and stores the new value', async () => {
        const { state, adapter } = memoryCredential(SECRET, async () => 'rt-next')
        const outcome = await recoverCredential(adapter, fp(SECRET), { lock: createSerialLock() })
        expect(outcome).toEqual({ status: 'refreshed', value: 'rt-next' })
        expect(adapter.refresh).toHaveBeenCalledTimes(1)
        expect(state).toMatchObject({ value: 'rt-next', writes: 1 })
    })

    it('uses a value another holder already stored instead of refreshing (guarded reload)', async () => {
        const { adapter } = memoryCredential('rt-someone-else', async () => 'never')
        expect(await recoverCredential(adapter, fp(SECRET), { lock: createSerialLock() }))
            .toEqual({ status: 'lost-race', value: 'rt-someone-else' })
        expect(adapter.refresh).not.toHaveBeenCalled()
    })

    it('lets only one of two concurrent recoveries refresh; the other wins nothing and fails nothing', async () => {
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        const { state, adapter } = memoryCredential(SECRET, async () => { await gate; return 'rt-next' })
        const lock = createSerialLock()
        const first = recoverCredential(adapter, fp(SECRET), { lock })
        const second = recoverCredential(adapter, fp(SECRET), { lock })
        await vi.waitFor(() => expect(adapter.refresh).toHaveBeenCalledTimes(1))
        release()
        expect(await first).toEqual({ status: 'refreshed', value: 'rt-next' })
        expect(await second).toEqual({ status: 'lost-race', value: 'rt-next' })
        expect(adapter.refresh).toHaveBeenCalledTimes(1)
        expect(state.writes).toBe(1)
    })

    it('caches a permanent failure per fingerprint and stops calling the network for it', async () => {
        const { state, adapter } = memoryCredential(SECRET, async () => { throw new RefreshFailure({ status: 400, code: 'invalid_grant' }) })
        const lock = createSerialLock()
        expect(await recoverCredential(adapter, fp(SECRET), { lock })).toEqual({ status: 'failed', classification: 'permanent' })
        expect(await recoverCredential(adapter, fp(SECRET), { lock })).toEqual({ status: 'failed', classification: 'permanent', cached: true })
        expect(adapter.refresh).toHaveBeenCalledTimes(1)
        expect(hasPermanentRefreshFailure(fp(SECRET))).toBe(true)

        // 사용자가 다시 연결해 자격이 바뀌면 캐시는 그 새 지문에 걸리지 않는다.
        state.value = 'rt-reconnected'
        vi.mocked(adapter.refresh).mockImplementation(async () => 'rt-after-reconnect')
        expect(await recoverCredential(adapter, fp('rt-reconnected'), { lock })).toEqual({ status: 'refreshed', value: 'rt-after-reconnect' })
    })

    it('keeps the current credential on a transient failure and does not cache it', async () => {
        const { state, adapter } = memoryCredential(SECRET, async () => { throw new RefreshFailure({ status: 503 }) })
        const lock = createSerialLock()
        expect(await recoverCredential(adapter, fp(SECRET), { lock })).toEqual({ status: 'failed', classification: 'transient' })
        expect(await recoverCredential(adapter, fp(SECRET), { lock })).toEqual({ status: 'failed', classification: 'transient' })
        expect(adapter.refresh).toHaveBeenCalledTimes(2)
        expect(state).toMatchObject({ value: SECRET, writes: 0 })
    })

    it('times out a refresh that never answers as transient and frees the lock', async () => {
        const { adapter } = memoryCredential(SECRET, () => new Promise<string>(() => {}))
        const lock = createSerialLock()
        expect(await recoverCredential(adapter, fp(SECRET), { lock, refreshTimeoutMs: 20 })).toEqual({ status: 'failed', classification: 'transient' })
        expect(await lock(async () => 'free')).toBe('free')
    })

    it('treats a lock it could not get as transient', async () => {
        const { adapter } = memoryCredential(SECRET, async () => 'never')
        const outcome = await recoverCredential(adapter, fp(SECRET), { lock: async () => { throw new Error('busy') } })
        expect(outcome).toEqual({ status: 'failed', classification: 'transient' })
        expect(adapter.refresh).not.toHaveBeenCalled()
    })

    it('never writes a credential value to the debug log', async () => {
        const debug = vi.spyOn(logger, 'debug')
        const ok = memoryCredential(SECRET, async () => 'rt-NEXT-SECRET-0002')
        await recoverCredential(ok.adapter, fp(SECRET), { lock: createSerialLock() })
        const bad = memoryCredential(SECRET, async () => { throw new RefreshFailure({ status: 401 }) })
        await recoverCredential(bad.adapter, fp(SECRET), { lock: createSerialLock() })
        const logged = debug.mock.calls.flat().map(String).join('\n')
        expect(logged).toContain('fp=')
        expect(logged).not.toContain(SECRET)
        expect(logged).not.toContain('rt-NEXT-SECRET-0002')
    })
})
