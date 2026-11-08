/**
 * The daemon's side of an organization LLM endpoint (aplus specs/org-llm-endpoints C4·C5).
 *
 * Studio pushes the admin-registered endpoint here through `ai-credential:org-llm-endpoint-sync`; a spawn
 * names it (`org-endpoint` selection) and the daemon builds the session environment from this local copy
 * only — it never asks Studio at spawn time. Pure on purpose: files and the network are injected by the
 * runtime, so the rules below are testable without either.
 */
import { CLAUDE_AUTH_OVERRIDE_ENV_KEYS } from '@/claude/utils/claudeAuthOverrideEnv'
import { HAPPY_AI_AUTH_SOURCE_ENV } from '@/usage/aiAuthSource'
import {
    formatOrgEndpointBinding,
    isOrgEndpointId,
    ORG_ENDPOINT_BINDING_ENV,
    ORG_ENDPOINT_MAX_TARGETS,
    type AiAuthSelection,
} from './sessionEnv'

/** Failures carry a fixed code and never a value: payloads hold the endpoint's token. */
export class OrgLlmEndpointError extends Error {
    constructor(readonly code: string) {
        super(`Org LLM endpoint operation failed (${code})`)
    }
}

export type OrgLlmEndpointTarget = { id: string; url: string }

export type OrgLlmEndpointEntry = {
    id: string
    generation: number
    model: string
    models: { opus?: string; sonnet?: string; haiku?: string }
    maxContextTokens: number
    apiTimeoutMs: number
    authMode: 'none' | 'static-token'
    token?: string
    targets: OrgLlmEndpointTarget[]
    companyId: string
    userId: string
}

export type OrgLlmEndpointStore = { version: 1; endpoints: Record<string, OrgLlmEndpointEntry> }

/** What an endpoint without a token hands the agent: Claude Code insists on some auth value. Not a secret. */
export const ORG_LLM_ENDPOINT_NO_AUTH_TOKEN = 'saycode-org-endpoint-no-auth'

const PAYLOAD_INVALID = 'ORG_LLM_ENDPOINT_PAYLOAD_INVALID'
const STORE_INVALID = 'ORG_LLM_ENDPOINT_STORE_INVALID'
const PRINTABLE = /^[\x21-\x7e]+$/
const MODEL = /^[\x21-\x7e]{1,200}$/
const TOKEN = /^[\x21-\x7e]{1,4096}$/
const TIERS = ['opus', 'sonnet', 'haiku'] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

function closedKeys(value: Record<string, unknown>, allowed: readonly string[], code: string): void {
    if (Object.keys(value).some((key) => !allowed.includes(key))) throw new OrgLlmEndpointError(code)
}

function integerInRange(value: unknown, min: number, max: number, code: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new OrgLlmEndpointError(code)
    return value
}

/** https or http, no userinfo, query or fragment; a trailing slash is not part of the address. */
function normalizeTargetUrl(value: unknown, code: string): string {
    if (typeof value !== 'string' || value.length > 2048 || !PRINTABLE.test(value) || /[?#]/.test(value)) throw new OrgLlmEndpointError(code)
    let parsed: URL
    try { parsed = new URL(value) } catch { throw new OrgLlmEndpointError(code) }
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password || !parsed.hostname) {
        throw new OrgLlmEndpointError(code)
    }
    return value.replace(/\/+$/, '')
}

function parseEndpoint(value: unknown, code: string): Omit<OrgLlmEndpointEntry, 'companyId' | 'userId'> {
    if (!isRecord(value)) throw new OrgLlmEndpointError(code)
    closedKeys(value, ['id', 'generation', 'model', 'models', 'maxContextTokens', 'apiTimeoutMs', 'authMode', 'token', 'targets'], code)
    if (!isOrgEndpointId(value.id)) throw new OrgLlmEndpointError(code)
    const generation = integerInRange(value.generation, 1, Number.MAX_SAFE_INTEGER, code)
    if (typeof value.model !== 'string' || !MODEL.test(value.model)) throw new OrgLlmEndpointError(code)
    if (!isRecord(value.models)) throw new OrgLlmEndpointError(code)
    closedKeys(value.models, TIERS, code)
    const models: OrgLlmEndpointEntry['models'] = {}
    for (const tier of TIERS) {
        const tierModel = value.models[tier]
        if (tierModel === undefined) continue
        if (typeof tierModel !== 'string' || !MODEL.test(tierModel)) throw new OrgLlmEndpointError(code)
        models[tier] = tierModel
    }
    const maxContextTokens = integerInRange(value.maxContextTokens, 1024, 2_000_000, code)
    const apiTimeoutMs = integerInRange(value.apiTimeoutMs, 10_000, 3_600_000, code)
    if (value.authMode !== 'none' && value.authMode !== 'static-token') throw new OrgLlmEndpointError(code)
    const authMode = value.authMode
    if (authMode === 'static-token') {
        if (typeof value.token !== 'string' || !TOKEN.test(value.token)) throw new OrgLlmEndpointError(code)
    } else if (value.token !== undefined) {
        throw new OrgLlmEndpointError(code)
    }
    if (!Array.isArray(value.targets) || value.targets.length < 1 || value.targets.length > ORG_ENDPOINT_MAX_TARGETS) throw new OrgLlmEndpointError(code)
    const targets = value.targets.map((target: unknown): OrgLlmEndpointTarget => {
        if (!isRecord(target)) throw new OrgLlmEndpointError(code)
        closedKeys(target, ['id', 'url'], code)
        if (!isOrgEndpointId(target.id)) throw new OrgLlmEndpointError(code)
        return { id: target.id, url: normalizeTargetUrl(target.url, code) }
    })
    if (new Set(targets.map((target) => target.id)).size !== targets.length
        || new Set(targets.map((target) => target.url)).size !== targets.length) throw new OrgLlmEndpointError(code)
    return { id: value.id, generation, model: value.model, models, maxContextTokens, apiTimeoutMs, authMode, ...(authMode === 'static-token' ? { token: value.token as string } : {}), targets }
}

/** C4 params → the entry the daemon stores. Every value rule of the server's validation is checked again here. */
export function parseOrgLlmEndpointSync(params: unknown): OrgLlmEndpointEntry {
    if (!isRecord(params)) throw new OrgLlmEndpointError(PAYLOAD_INVALID)
    closedKeys(params, ['version', 'companyId', 'userId', 'endpoint'], PAYLOAD_INVALID)
    if (params.version !== 1 || !isOrgEndpointId(params.companyId) || !isOrgEndpointId(params.userId)) throw new OrgLlmEndpointError(PAYLOAD_INVALID)
    return { ...parseEndpoint(params.endpoint, PAYLOAD_INVALID), companyId: params.companyId, userId: params.userId }
}

/** The file's text → store. Anything off is refused as a whole: a half-read store would hide an endpoint. */
export function parseOrgLlmEndpointStore(raw: string): OrgLlmEndpointStore {
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { throw new OrgLlmEndpointError(STORE_INVALID) }
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.endpoints)) throw new OrgLlmEndpointError(STORE_INVALID)
    closedKeys(parsed, ['version', 'endpoints'], STORE_INVALID)
    const endpoints: Record<string, OrgLlmEndpointEntry> = {}
    for (const [id, row] of Object.entries(parsed.endpoints)) {
        if (!isRecord(row) || !isOrgEndpointId(row.companyId) || !isOrgEndpointId(row.userId)) throw new OrgLlmEndpointError(STORE_INVALID)
        const { companyId, userId, ...endpoint } = row
        const entry = { ...parseEndpoint(endpoint, STORE_INVALID), companyId, userId }
        if (entry.id !== id) throw new OrgLlmEndpointError(STORE_INVALID)
        endpoints[id] = entry
    }
    return { version: 1, endpoints }
}

/** A new store with only that endpoint's entry replaced. */
export function replaceOrgLlmEndpoint(store: OrgLlmEndpointStore | undefined, entry: OrgLlmEndpointEntry): OrgLlmEndpointStore {
    return { version: 1, endpoints: { ...store?.endpoints, [entry.id]: entry } }
}

const PROBE_BODY_LIMIT = 16 * 1024
export const ORG_LLM_ENDPOINT_PROBE_TIMEOUT_MS = 3000

export type OrgLlmEndpointProbeResult = { ok: true } | { ok: false; reason: string }
export type OrgLlmEndpointFetch = (url: string, init: RequestInit) => Promise<Response>
export type OrgLlmEndpointProbe = (input: { url: string; token?: string }) => Promise<OrgLlmEndpointProbeResult>

/** An error's name and code only: its message can carry the address and the credential. */
function failureReason(error: unknown): string {
    const name = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : typeof error
    const code = [(error as { code?: unknown } | null)?.code, (error as { cause?: { code?: unknown } } | null)?.cause?.code]
        .find((candidate): candidate is string => typeof candidate === 'string' && /^[A-Z0-9_]{1,32}$/.test(candidate))
    return code ? `${name}:${code}` : name
}

/**
 * `GET {url}/v1/models`: does anything Anthropic-compatible answer there. Redirects are errors (a redirect
 * would carry the token to another address), the body is read to at most 16 KiB, and the timeout covers the
 * body too.
 */
export async function probeOrgLlmEndpointTarget(input: {
    fetch: OrgLlmEndpointFetch
    url: string
    token?: string
    timeoutMs?: number
}): Promise<OrgLlmEndpointProbeResult> {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, input.timeoutMs ?? ORG_LLM_ENDPOINT_PROBE_TIMEOUT_MS)
    try {
        const response = await input.fetch(`${input.url}/v1/models`, {
            method: 'GET',
            redirect: 'error',
            signal: controller.signal,
            headers: { Accept: 'application/json', ...(input.token ? { 'x-api-key': input.token, Authorization: `Bearer ${input.token}` } : {}) },
        })
        const reader = response.body?.getReader()
        if (reader) {
            // A body that stalls must not outlive the timeout, whether or not the transport honours the abort.
            const expired = new Promise<never>((_resolve, reject) => {
                controller.signal.addEventListener('abort', () => reject(new Error('probe timeout')), { once: true })
            })
            let read = 0
            try {
                while (read < PROBE_BODY_LIMIT) {
                    const chunk = await Promise.race([reader.read(), expired])
                    if (chunk.done) break
                    read += chunk.value.byteLength
                }
            } finally {
                void reader.cancel().catch(() => undefined)
            }
        }
        return response.status >= 200 && response.status < 300 ? { ok: true } : { ok: false, reason: `http-${response.status}` }
    } catch (error) {
        return { ok: false, reason: timedOut ? 'timeout' : failureReason(error) }
    } finally {
        clearTimeout(timer)
    }
}

/** C5's closed managed environment. Every other Claude auth override and the small-fast model are written empty. */
export function buildOrgLlmEndpointEnvironment(input: {
    entry: OrgLlmEndpointEntry
    target: OrgLlmEndpointTarget
    bindingId: string
}): Record<string, string> {
    const { entry, target, bindingId } = input
    const cleared = Object.fromEntries(CLAUDE_AUTH_OVERRIDE_ENV_KEYS
        .filter((key) => key !== 'ANTHROPIC_AUTH_TOKEN' && key !== 'ANTHROPIC_BASE_URL')
        .map((key) => [key, '']))
    return {
        ANTHROPIC_BASE_URL: target.url,
        ANTHROPIC_AUTH_TOKEN: entry.token ?? ORG_LLM_ENDPOINT_NO_AUTH_TOKEN,
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(entry.maxContextTokens),
        ANTHROPIC_MODEL: entry.model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: entry.models.opus ?? entry.model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: entry.models.sonnet ?? entry.model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: entry.models.haiku ?? entry.model,
        API_TIMEOUT_MS: String(entry.apiTimeoutMs),
        ...cleared,
        ANTHROPIC_SMALL_FAST_MODEL: '',
        [HAPPY_AI_AUTH_SOURCE_ENV]: 'org-endpoint',
        [ORG_ENDPOINT_BINDING_ENV]: formatOrgEndpointBinding({ bindingId, endpointId: entry.id, targetId: target.id, generation: entry.generation }),
    }
}

/**
 * The environment for one `org-endpoint` selection, from the local store only. The entry must exist at the
 * selected generation and every candidate must be one of its targets — otherwise the whole selection is
 * refused, never narrowed. A new spawn takes the first candidate that answers; a resume (`resume`) rebuilds
 * its one recorded target without asking the network and has no other target to fall back to.
 */
export async function resolveOrgLlmEndpointLaunch(input: {
    store: OrgLlmEndpointStore | undefined
    selection: Extract<AiAuthSelection, { kind: 'org-endpoint' }>
    probe: OrgLlmEndpointProbe
    onProbeFailure?: (targetId: string, reason: string) => void
}): Promise<Record<string, string>> {
    const { selection } = input
    const entry = input.store?.endpoints[selection.endpointId]
    if (!entry) throw new OrgLlmEndpointError('ORG_LLM_ENDPOINT_NOT_SYNCED')
    if (entry.generation !== selection.generation) throw new OrgLlmEndpointError('ORG_LLM_ENDPOINT_GENERATION_MISMATCH')
    const targets: OrgLlmEndpointTarget[] = []
    for (const candidate of selection.candidates) {
        const target = entry.targets.find((row) => row.id === candidate)
        if (!target) throw new OrgLlmEndpointError('ORG_LLM_ENDPOINT_TARGET_UNKNOWN')
        targets.push(target)
    }
    const bindingId = selection.bindingId
    if (selection.resume) return buildOrgLlmEndpointEnvironment({ entry, target: targets[0]!, bindingId })
    for (const target of targets) {
        const result = await input.probe({ url: target.url, ...(entry.token ? { token: entry.token } : {}) })
        if (result.ok) return buildOrgLlmEndpointEnvironment({ entry, target, bindingId })
        input.onProbeFailure?.(target.id, result.reason)
    }
    throw new OrgLlmEndpointError('ORG_LLM_ENDPOINT_UNREACHABLE')
}
