import { describe, expect, it } from 'vitest'
import { BrowserRuntimeError, type BatchStep, type ElementRef, type FormSubmission } from './contracts'
import { assertAllowedOrigin, approvalBinding, classifyAction, classifyUserWait, formDigest, formSummary, redact } from './policy'

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

    it('classifies only the submitting click on a risky form path, never fill or read-only steps', () => {
        const submit = { ref: '@e1' as ElementRef, role: 'button', name: 'Continue', visible: true, frameOrigin: 'https://fixture.test' }
        const input = { ...submit, role: 'textbox' }
        const fill: BatchStep = { ...step, kind: 'fill', value: '5' }
        const observe: BatchStep = { ...step, kind: 'observe' }
        const waitFor: BatchStep = { ...step, kind: 'waitFor', until: { kind: 'text', text: 'ready' } }
        const screenshot: BatchStep = { ...step, kind: 'screenshot' }

        expect(classifyAction(fill, input, undefined, 'https://fixture.test/risky-submit')).toBe('auto')
        expect(classifyAction(observe, undefined, undefined, 'https://fixture.test/risky-submit')).toBe('auto')
        expect(classifyAction(waitFor, undefined, undefined, 'https://fixture.test/risky-submit')).toBe('auto')
        expect(classifyAction(screenshot, undefined, undefined, 'https://fixture.test/risky-submit')).toBe('auto')
        expect(classifyAction(step, input, undefined, 'https://fixture.test/risky-submit')).toBe('auto')
        expect(classifyAction(step, submit, undefined, 'https://fixture.test/risky-submit')).toBe('approval-required')
    })

    it('classifies fixture login and captcha paths for user waits', () => {
        expect(classifyUserWait('https://fixture.test/login')).toBe('login')
        expect(classifyUserWait('https://fixture.test/login/oauth')).toBe('login')
        expect(classifyUserWait('https://fixture.test/challenge/captcha')).toBe('captcha')
        expect(classifyUserWait('https://fixture.test/account')).toBeUndefined()
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

describe('form digest', () => {
    const base: FormSubmission = {
        action: 'https://fixture.test/order', method: 'post', enctype: 'application/x-www-form-urlencoded', target: '',
        fields: [['item', 'a'], ['item', 'b'], ['amount', '10'], ['pin', { password: 4 }]],
        submitter: { name: 'op', value: 'pay', formaction: null, formmethod: null, formenctype: null },
        opaque: false,
    }

    it('is a stable SHA-256 over every submitted part', () => {
        expect(formDigest(base)).toMatch(/^[0-9a-f]{64}$/)
        expect(formDigest(structuredClone(base))).toBe(formDigest(base))
    })

    it('changes with field order, duplicates, values, destination, method, enctype and submitter overrides', () => {
        const variants: FormSubmission[] = [
            { ...base, fields: [['item', 'b'], ['item', 'a'], ['amount', '10'], ['pin', { password: 4 }]] },
            { ...base, fields: [['item', 'a'], ['amount', '10'], ['pin', { password: 4 }]] },
            { ...base, fields: [['item', 'a'], ['item', 'b'], ['amount', '11'], ['pin', { password: 4 }]] },
            { ...base, fields: [['item', 'a'], ['item', 'b'], ['amount', '10'], ['pin', { password: 5 }]] },
            { ...base, action: 'https://fixture.test/other' },
            { ...base, method: 'get' },
            { ...base, enctype: 'text/plain' },
            { ...base, target: '_blank' },
            { ...base, submitter: { ...base.submitter!, value: 'refund' } },
            { ...base, submitter: { ...base.submitter!, formaction: '/other' } },
            { ...base, submitter: null },
            { ...base, opaque: true },
        ]
        const digests = new Set([formDigest(base), ...variants.map(formDigest)])
        expect(digests.size).toBe(variants.length + 1)
    })

    it('truncates only the display summary, never the bound values', () => {
        const long = 'x'.repeat(60)
        const a = { ...base, fields: [['note', `${long}A`]] as FormSubmission['fields'] }
        const b = { ...base, fields: [['note', `${long}B`]] as FormSubmission['fields'] }
        expect(formSummary(a)).toBe(formSummary(b))
        expect(formDigest(a)).not.toBe(formDigest(b))
        expect(formSummary(base)).toBe('POST https://fixture.test/order: item=a, item=b, amount=10, pin=••••')
        const many = { ...base, fields: Array.from({ length: 20 }, (_, i) => [`f${i}`, String(i)]) as FormSubmission['fields'] }
        expect(formSummary(many)).toMatch(/f11=11, \+8 more$/)
    })
})
