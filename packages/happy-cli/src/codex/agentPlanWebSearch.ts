/**
 * aplus-dev-studio specs/agent-plan-full-capability P3 — web search for a plan session, as a Happy MCP tool.
 *
 * Codex sends no hosted `web_search` tool for the plan models (gpt-6 family, code mode — captured on 0.166/0.167),
 * so the runner offers its own tool and asks the plan gateway for a hosted search itself. The gateway already
 * reserves and settles a `web_search` call (per-search price, result-token allowance, `max_tool_calls`), so the
 * search is billed on the same ledger as the session's own calls. The runner calls it directly with the session's
 * `agps_` key — this code runs in the runner process, outside the agent sandbox, like the local proxy.
 */

export const AGENT_PLAN_WEB_SEARCH_INSTRUCTIONS = 'Search the web to answer the request. Reply with a concise, factual summary '
    + 'in the language of the request and cite the pages you used. Do not invent sources.'

/**
 * Below the MCP request timeout (SDK default 60s) that both the Happy stdio bridge's `callTool` and Codex apply to
 * this tool. A search the gateway is still answering past that is billed either way (it reads upstream to the end);
 * ending here first gives the model `agent_plan_gateway_unreachable` to explain instead of a bare tool timeout.
 * Measured searches took 2–18s; the margin covers the gateway waiting for the user's busy agent slot.
 */
export const AGENT_PLAN_WEB_SEARCH_TIMEOUT_MS = 50_000

export type AgentPlanWebSearchSource = { title: string; url: string }

export type AgentPlanWebSearchResult =
    | { ok: true; answer: string; sources: AgentPlanWebSearchSource[]; complete: boolean }
    /** `resetsAt` (ms) comes with a plan limit refusal. */
    | { ok: false; code: string; resetsAt?: number }

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readAnswer(body: Record<string, unknown>): Extract<AgentPlanWebSearchResult, { ok: true }> | null {
    if (!Array.isArray(body.output)) return null
    const texts: string[] = []
    const sources = new Map<string, AgentPlanWebSearchSource>()
    for (const item of body.output) {
        if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) continue
        for (const part of item.content) {
            if (!isRecord(part) || part.type !== 'output_text' || typeof part.text !== 'string') continue
            texts.push(part.text)
            for (const note of Array.isArray(part.annotations) ? part.annotations : []) {
                if (!isRecord(note) || note.type !== 'url_citation' || typeof note.url !== 'string') continue
                if (!sources.has(note.url)) sources.set(note.url, { title: typeof note.title === 'string' ? note.title : note.url, url: note.url })
            }
        }
    }
    return { ok: true, answer: texts.join('\n'), sources: [...sources.values()], complete: body.status === 'completed' }
}

async function readRefusal(response: Response): Promise<Extract<AgentPlanWebSearchResult, { ok: false }>> {
    const body: unknown = await response.json().catch(() => null)
    const error = isRecord(body) && isRecord(body.error) ? body.error : null
    if (!error || typeof error.code !== 'string') return { ok: false, code: 'agent_plan_web_search_failed' }
    return {
        ok: false,
        code: error.code,
        ...(typeof error.resets_at === 'number' ? { resetsAt: error.resets_at * 1000 } : {}),
    }
}

export function createAgentPlanWebSearch(options: {
    /** The gateway's Responses endpoint, `<origin>/api/agent-plan/v1/responses`. */
    url: string
    sessionKey: () => Promise<string>
    fetchImpl?: typeof fetch
    timeoutMs?: number
}): (query: string) => Promise<AgentPlanWebSearchResult> {
    const fetchImpl = options.fetchImpl ?? fetch
    return async (query) => {
        let key: string
        try {
            key = await options.sessionKey()
        } catch (error) {
            const code = (error as { code?: unknown }).code
            return { ok: false, code: typeof code === 'string' ? code : 'agent_plan_unavailable' }
        }
        let response: Response
        try {
            response = await fetchImpl(options.url, {
                method: 'POST',
                headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
                // The gateway pins the grant model, effort, output cap and `max_tool_calls`; only the search is ours.
                body: JSON.stringify({
                    instructions: AGENT_PLAN_WEB_SEARCH_INSTRUCTIONS,
                    input: [{ role: 'user', content: [{ type: 'input_text', text: query }] }],
                    tools: [{ type: 'web_search' }],
                    stream: false,
                    store: false,
                }),
                redirect: 'error',
                signal: AbortSignal.timeout(options.timeoutMs ?? AGENT_PLAN_WEB_SEARCH_TIMEOUT_MS),
            })
        } catch {
            return { ok: false, code: 'agent_plan_gateway_unreachable' }
        }
        if (!response.ok) return readRefusal(response)
        const body: unknown = await response.json().catch(() => null)
        return (isRecord(body) && readAnswer(body)) || { ok: false, code: 'agent_plan_web_search_failed' }
    }
}

/** The tool's text result for the model. */
export function formatAgentPlanWebSearchResult(result: AgentPlanWebSearchResult): string {
    if (!result.ok) {
        const resets = result.resetsAt ? ` (the Saycode plan limit resets at ${new Date(result.resetsAt).toISOString()})` : ''
        return `Web search unavailable: ${result.code}${resets}.`
    }
    const lines = [result.answer]
    if (!result.complete) lines.push('', '(The search answer is incomplete; it was cut short.)')
    if (result.sources.length > 0) lines.push('', 'Sources:', ...result.sources.map(source => `- ${source.title} — ${source.url}`))
    return lines.join('\n')
}
