import { createHash } from 'node:crypto'
import { BrowserRuntimeError, type AgentGrant, type BatchStep, type ElementDescription, type ObservedElement } from './contracts'

export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
}

export function payloadHash(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex') }

export function assertAllowedOrigin(url: string, grant: Pick<AgentGrant, 'allowedOrigins'>): string {
    let origin: string
    try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('unsupported URL'); origin = parsed.origin } catch { throw new BrowserRuntimeError('ORIGIN_DENIED', 'Invalid navigation URL') }
    if (!grant.allowedOrigins.includes(origin)) throw new BrowserRuntimeError('ORIGIN_DENIED', 'Origin is not in the task grant')
    return origin
}

export function classifyAction(step: BatchStep, element?: ObservedElement | ElementDescription, formAction?: string, currentUrl?: string): 'auto' | 'approval-required' {
    if (step.kind !== 'click') return 'auto'
    const riskyPath = (candidate?: string) => {
        if (!candidate) return false
        try { const path = new URL(candidate, 'https://fixture.invalid').pathname; return path === '/risky-submit' || path === '/api/risky' } catch { return false }
    }
    if (/^(pay|buy now|send|submit order|confirm payment)/i.test(element?.name ?? '')) return 'approval-required'
    if ('pageUrl' in (element ?? {})) currentUrl = (element as ElementDescription).pageUrl
    if ('formAction' in (element ?? {})) formAction = (element as ElementDescription).formAction
    if ('frameOrigin' in (element ?? {}) && !('pageUrl' in (element ?? {})))
        formAction = formAction ?? (element as ObservedElement).formAction
    const submitControl = ['button', 'submit'].includes(element?.role.toLowerCase() ?? '')
    const targetUrl = element && 'targetUrl' in element ? element.targetUrl : undefined
    if (submitControl && (riskyPath(formAction) || riskyPath(element?.formAction)
        || riskyPath(targetUrl) || riskyPath(currentUrl))) return 'approval-required'
    return 'auto'
}

export interface FormValue {
    name: string
    value: string
}

export function observedFormValues(elements: ObservedElement[]): FormValue[] {
    return elements.flatMap((element) => {
        if (element.value === undefined || /password/i.test(element.name))
            return []
        return [{ name: element.name, value: element.value }]
    })
}

export function classifyUserWait(url: string): 'login' | 'captcha' | undefined {
    try {
        const path = new URL(url).pathname
        if (path.startsWith('/login'))
            return 'login'
        if (path.startsWith('/challenge'))
            return 'captcha'
    } catch {
        return undefined
    }
    return undefined
}

export function approvalBinding(input: { principalId: string; workspaceId: string; taskId: string; actionId: string; origin: string; payloadHash: string; leaseEpoch: number; browserInstanceId: string; documentGeneration: number; expiresAtMs: number; frameOrigin?: string }): string {
    return payloadHashHex(input)
}
function payloadHashHex(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex') }

const CANARY = /ABP-CANARY-[A-Za-z0-9]+/g
export function redact<T>(value: T): T {
    if (typeof value === 'string') {
        const scrubUrl = (text: string) => text.replace(/(https?:\/\/[^\s?#]+)(?:[?#][^\s]*)?/g, '$1').replace(/(^|\s)(\/[^\s?#]+)(?:[?#][^\s]*)?/g, '$1$2')
        return scrubUrl(value).replace(CANARY, '[REDACTED]') as T
    }
    if (Array.isArray(value)) return value.map((item) => redact(item)) as T
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {}
        const record = value as Record<string, unknown>
        const passwordField = /password/i.test(String(record.name ?? '')) || /password/i.test(String(record.type ?? ''))
        for (const [key, item] of Object.entries(record)) {
            if (/password/i.test(key)) continue
            if (passwordField && key === 'value') continue
            out[key] = redact(item)
        }
        return out as T
    }
    return value
}
