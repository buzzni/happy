import { describe, expect, it } from 'vitest'
import { classifyWorkerProtocol, TERMINAL_WORKER_PROTOCOL_OVERRIDE_ENV, TERMINAL_WORKER_PROTOCOL_VERSION, workerProtocolVersion } from './protocol'

describe('terminal worker protocol', () => {
    it('adopts only its own version; anything else, readable or not, is incompatible', () => {
        expect(classifyWorkerProtocol(TERMINAL_WORKER_PROTOCOL_VERSION)).toBe('current')
        expect(classifyWorkerProtocol(TERMINAL_WORKER_PROTOCOL_VERSION + 1)).toBe('incompatible')
        expect(classifyWorkerProtocol(0)).toBe('incompatible')
        expect(classifyWorkerProtocol('1')).toBe('incompatible')
        expect(classifyWorkerProtocol(undefined)).toBe('incompatible')
    })

    it('reports the test override only when it is a positive integer', () => {
        expect(workerProtocolVersion({})).toBe(TERMINAL_WORKER_PROTOCOL_VERSION)
        expect(workerProtocolVersion({ [TERMINAL_WORKER_PROTOCOL_OVERRIDE_ENV]: '7' })).toBe(7)
        expect(workerProtocolVersion({ [TERMINAL_WORKER_PROTOCOL_OVERRIDE_ENV]: 'x' })).toBe(TERMINAL_WORKER_PROTOCOL_VERSION)
    })
})
