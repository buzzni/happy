import { describe, expect, it, vi } from 'vitest'
import { AGENT_PLAN_WEB_SEARCH_INSTRUCTIONS, createAgentPlanWebSearch, formatAgentPlanWebSearchResult } from './agentPlanWebSearch'

const URL_ = 'https://studio.test/api/agent-plan/v1/responses'

/** The gateway's buffered (non-streaming) Responses answer, as measured on gpt-6-luna. */
function answer(overrides: Record<string, unknown> = {}) {
    return {
        id: 'resp_1', object: 'response', status: 'completed',
        output: [
            { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'node lts' } },
            { type: 'reasoning', id: 'rs_1', summary: [] },
            {
                type: 'message', role: 'assistant', id: 'msg_1', status: 'completed',
                content: [{
                    type: 'output_text', text: 'Node.js 24 is the current LTS.',
                    annotations: [
                        { type: 'url_citation', url: 'https://nodejs.org/en/about/previous-releases', title: 'Node.js Releases', start_index: 0, end_index: 10 },
                        { type: 'url_citation', url: 'https://nodejs.org/en/about/previous-releases', title: 'Node.js Releases', start_index: 11, end_index: 20 },
                    ],
                }],
            },
        ],
        usage: { input_tokens: 9000, output_tokens: 80, total_tokens: 9080 },
        tool_usage: { web_search: { num_requests: 1 } },
        ...overrides,
    }
}

function gateway(status: number, body: unknown) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

describe('createAgentPlanWebSearch', () => {
    it('shouldAskThePlanGatewayForAHostedWebSearchWithTheSessionKeyAndNoStreaming', async () => {
        const fetchImpl = gateway(200, answer())
        const search = createAgentPlanWebSearch({ url: URL_, sessionKey: async () => 'agps_1', fetchImpl })
        await search('node lts')
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
        expect(url).toBe(URL_)
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer agps_1')
        expect(init.redirect).toBe('error')
        expect(JSON.parse(String(init.body))).toEqual({
            instructions: AGENT_PLAN_WEB_SEARCH_INSTRUCTIONS,
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'node lts' }] }],
            tools: [{ type: 'web_search' }],
            stream: false,
            store: false,
        })
    })

    it('shouldReturnTheAnswerAndEachCitedSourceOnce', async () => {
        const search = createAgentPlanWebSearch({ url: URL_, sessionKey: async () => 'agps_1', fetchImpl: gateway(200, answer()) })
        expect(await search('node lts')).toEqual({
            ok: true,
            answer: 'Node.js 24 is the current LTS.',
            sources: [{ title: 'Node.js Releases', url: 'https://nodejs.org/en/about/previous-releases' }],
            complete: true,
        })
    })

    it('shouldReportAnIncompleteAnswerInsteadOfPassingItOffAsComplete', async () => {
        const search = createAgentPlanWebSearch({ url: URL_, sessionKey: async () => 'agps_1', fetchImpl: gateway(200, answer({ status: 'incomplete' })) })
        expect(await search('node lts')).toMatchObject({ ok: true, complete: false })
    })

    it.each([
        [429, { error: { type: 'usage_limit_reached', code: 'agent_plan_weekly_limit', resets_at: 1_800_000_000 } }, { code: 'agent_plan_weekly_limit', resetsAt: 1_800_000_000_000 }],
        [429, { error: { type: 'rate_limit_exceeded', code: 'agent_plan_rate_limited' } }, { code: 'agent_plan_rate_limited' }],
        [400, { error: { code: 'agent_plan_upstream_rejected' } }, { code: 'agent_plan_upstream_rejected' }],
        [502, '<html>bad gateway</html>', { code: 'agent_plan_web_search_failed' }],
    ])('shouldTurnAGatewayRefusal %s into a typed failure', async (status, body, expected) => {
        const search = createAgentPlanWebSearch({ url: URL_, sessionKey: async () => 'agps_1', fetchImpl: gateway(status, body) })
        expect(await search('node lts')).toEqual({ ok: false, ...expected })
    })

    it('shouldFailWithoutCallingTheGatewayWhenTheSessionKeyCannotBeRefreshed', async () => {
        const fetchImpl = gateway(200, answer())
        const search = createAgentPlanWebSearch({ url: URL_, sessionKey: async () => { throw Object.assign(new Error('x'), { code: 'agent_plan_unreachable' }) }, fetchImpl })
        expect(await search('node lts')).toEqual({ ok: false, code: 'agent_plan_unreachable' })
        expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('shouldFailWhenTheGatewayCannotBeReached', async () => {
        const search = createAgentPlanWebSearch({ url: URL_, sessionKey: async () => 'agps_1', fetchImpl: vi.fn(async () => { throw new TypeError('fetch failed') }) })
        expect(await search('node lts')).toEqual({ ok: false, code: 'agent_plan_gateway_unreachable' })
    })
})

describe('formatAgentPlanWebSearchResult', () => {
    it('shouldListSourcesUnderTheAnswer', () => {
        expect(formatAgentPlanWebSearchResult({ ok: true, answer: 'A.', sources: [{ title: 'T', url: 'https://x.test' }], complete: true }))
            .toBe('A.\n\nSources:\n- T — https://x.test')
    })

    it('shouldSayWhenTheAnswerWasCutShortOrALimitWasReached', () => {
        expect(formatAgentPlanWebSearchResult({ ok: true, answer: 'A.', sources: [], complete: false })).toContain('incomplete')
        expect(formatAgentPlanWebSearchResult({ ok: false, code: 'agent_plan_weekly_limit', resetsAt: Date.parse('2026-11-16T00:00:00Z') }))
            .toBe('Web search unavailable: agent_plan_weekly_limit (the Saycode plan limit resets at 2026-11-16T00:00:00.000Z).')
    })
})
