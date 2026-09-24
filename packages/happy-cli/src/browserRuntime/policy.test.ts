import { describe, expect, it } from 'vitest'
import { BrowserRuntimeError, type BatchStep, type ElementRef } from './contracts'
import { assertAllowedOrigin, approvalBinding, classifyAction, redact } from './policy'

const step: BatchStep = { stepId: 's' as never, actionId: 'a' as never, tabId: 't' as never, kind: 'click', ref: '@e1' as ElementRef, timeoutMs: 1000 }

describe('fixture action policy', () => {
    it('requires approval for risky targets and accessible names but ignores page text', () => {
        expect(classifyAction(step, { ref: '@e1' as ElementRef, role: 'button', name: 'Continue', visible: true, frameOrigin: 'https://fixture.test', targetUrl: '/risky-submit' })).toBe('approval-required')
        expect(classifyAction(step, { ref: '@e1' as ElementRef, role: 'button', name: 'Pay now', visible: true, frameOrigin: 'https://fixture.test' })).toBe('approval-required')
        expect(classifyAction(step, { ref: '@e1' as ElementRef, role: 'button', name: 'Continue', visible: true, frameOrigin: 'https://fixture.test' })).toBe('auto')
    })

    it('uses the current page path when driver risk hints are absent', () => {
        const element = { ref: '@e1' as ElementRef, role: 'button', name: 'Continue', visible: true, frameOrigin: 'https://fixture.test' }
        expect(classifyAction(step, { ...element, name: 'Confirm payment' }, undefined, 'https://fixture.test/checkout')).toBe('approval-required')
        expect(classifyAction(step, element, undefined, 'https://fixture.test/risky-submit')).toBe('approval-required')
    })

    it('uses exact origins and strips URL secrets and canaries from nested values', () => {
        expect(assertAllowedOrigin('https://fixture.test/path?q=secret#fragment', { allowedOrigins: ['https://fixture.test'] })).toBe('https://fixture.test')
        expect(() => assertAllowedOrigin('https://fixture.test.evil/path', { allowedOrigins: ['https://fixture.test'] })).toThrowError(BrowserRuntimeError)
        expect(redact({ url: 'https://fixture.test/path?q=secret#x', password: 'ABP-CANARY-secret', text: 'ABP-CANARY-value', field: { name: 'Password', value: 'synthetic-secret' } })).toEqual({ url: 'https://fixture.test/path', text: '[REDACTED]', field: { name: 'Password' } })
    })

    it('binds approval to all input and browser generation fields', () => {
        const base = { principalId: 'p', workspaceId: 'w', taskId: 't', actionId: 'a', origin: 'https://fixture.test', payloadHash: 'hash', leaseEpoch: 1, browserInstanceId: 'b', documentGeneration: 1, expiresAtMs: 10 }
        expect(approvalBinding(base)).not.toBe(approvalBinding({ ...base, leaseEpoch: 2 }))
        expect(approvalBinding(base)).not.toBe(approvalBinding({ ...base, documentGeneration: 2 }))
    })
})
