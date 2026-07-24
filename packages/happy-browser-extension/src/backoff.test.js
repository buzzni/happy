import { describe, it, expect } from 'vitest'
import { reconnectDelayMs, MAX_RECONNECT_DELAY_MS } from './backoff.js'

describe('reconnectDelayMs', () => {
    it('starts at 1s for the first retry', () => {
        expect(reconnectDelayMs(0)).toBe(1000)
    })

    it('doubles with each consecutive failure', () => {
        expect(reconnectDelayMs(1)).toBe(2000)
        expect(reconnectDelayMs(2)).toBe(4000)
        expect(reconnectDelayMs(3)).toBe(8000)
    })

    it('caps at the maximum delay so a stopped daemon is still polled', () => {
        expect(reconnectDelayMs(99)).toBe(MAX_RECONNECT_DELAY_MS)
        expect(MAX_RECONNECT_DELAY_MS).toBe(30000)
    })
})
