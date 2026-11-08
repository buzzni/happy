import { describe, expect, it, vi } from 'vitest'
import {
  buildOrgLlmEndpointEnvironment,
  OrgLlmEndpointError,
  parseOrgLlmEndpointStore,
  parseOrgLlmEndpointSync,
  probeOrgLlmEndpointTarget,
  replaceOrgLlmEndpoint,
  resolveOrgLlmEndpointLaunch,
  type OrgLlmEndpointEntry,
} from './orgLlmEndpoint'
import type { AiAuthSelection } from './sessionEnv'

// aplus specs/org-llm-endpoints C4·C5 — the daemon's local copy of an organization LLM endpoint and the
// session environment built from it.

const payload = (patch: Record<string, unknown> = {}, endpoint: Record<string, unknown> = {}) => ({
  version: 1, companyId: 'company-1', userId: 'user-1',
  endpoint: {
    id: 'endpoint-1', generation: 3, model: 'corp-model-v1', models: {}, maxContextTokens: 200_000, apiTimeoutMs: 600_000,
    authMode: 'static-token', token: 'corp-token-123',
    targets: [{ id: 'target-a', url: 'https://llm-a.corp.example' }, { id: 'target-b', url: 'http://10.0.0.5:8080/anthropic' }],
    ...endpoint,
  },
  ...patch,
})

const entry = (patch: Partial<OrgLlmEndpointEntry> = {}): OrgLlmEndpointEntry => ({ ...parseOrgLlmEndpointSync(payload()), ...patch })

const failure = (run: () => unknown): string => {
  try { run() } catch (error: unknown) { return error instanceof OrgLlmEndpointError ? error.code : `other:${String(error)}` }
  return 'did-not-throw'
}

describe('parseOrgLlmEndpointSync', () => {
  it('accepts the contract shape and stores company and user beside the endpoint', () => {
    expect(parseOrgLlmEndpointSync(payload())).toEqual({
      id: 'endpoint-1', generation: 3, model: 'corp-model-v1', models: {}, maxContextTokens: 200_000, apiTimeoutMs: 600_000,
      authMode: 'static-token', token: 'corp-token-123',
      targets: [{ id: 'target-a', url: 'https://llm-a.corp.example' }, { id: 'target-b', url: 'http://10.0.0.5:8080/anthropic' }],
      companyId: 'company-1', userId: 'user-1',
    })
  })

  it('takes tier models, strips trailing slashes and needs no token without auth', () => {
    const parsed = parseOrgLlmEndpointSync(payload({}, {
      authMode: 'none', token: undefined, models: { opus: 'big', haiku: 'small' },
      targets: [{ id: 'target-a', url: 'https://llm-a.corp.example/v1/' }],
    }))
    expect(parsed.models).toEqual({ opus: 'big', haiku: 'small' })
    expect(parsed.targets).toEqual([{ id: 'target-a', url: 'https://llm-a.corp.example/v1' }])
    expect(parsed).not.toHaveProperty('token')
  })

  it.each([
    { label: 'null', params: null },
    { label: 'array', params: [] },
    { label: 'wrong version', params: payload({ version: 2 }) },
    { label: 'extra top-level key', params: payload({ extra: 1 }) },
    { label: 'missing companyId', params: payload({ companyId: undefined }) },
    { label: 'userId with a separator', params: payload({ userId: 'a:b' }) },
    { label: 'missing endpoint', params: payload({ endpoint: undefined }) },
    { label: 'extra endpoint key', params: payload({}, { reachability: 'private' }) },
    { label: 'endpoint id with a space', params: payload({}, { id: 'end point' }) },
    { label: 'generation 0', params: payload({}, { generation: 0 }) },
    { label: 'generation as a string', params: payload({}, { generation: '3' }) },
    { label: 'model with a space', params: payload({}, { model: 'corp model' }) },
    { label: 'empty model', params: payload({}, { model: '' }) },
    { label: 'model of 201 characters', params: payload({}, { model: 'm'.repeat(201) }) },
    { label: 'tier model with a space', params: payload({}, { models: { opus: 'a b' } }) },
    { label: 'unknown tier', params: payload({}, { models: { ultra: 'x' } }) },
    { label: 'context 1023', params: payload({}, { maxContextTokens: 1023 }) },
    { label: 'context 2,000,001', params: payload({}, { maxContextTokens: 2_000_001 }) },
    { label: 'context fractional', params: payload({}, { maxContextTokens: 5000.5 }) },
    { label: 'timeout 9,999', params: payload({}, { apiTimeoutMs: 9_999 }) },
    { label: 'timeout 3,600,001', params: payload({}, { apiTimeoutMs: 3_600_001 }) },
    { label: 'unknown auth mode', params: payload({}, { authMode: 'oauth' }) },
    { label: 'static-token without a token', params: payload({}, { token: undefined }) },
    { label: 'token with a space', params: payload({}, { token: 'a b' }) },
    { label: 'token of 4097 characters', params: payload({}, { token: 't'.repeat(4097) }) },
    { label: 'a token sent without auth', params: payload({}, { authMode: 'none' }) },
    { label: 'no targets', params: payload({}, { targets: [] }) },
    { label: '17 targets', params: payload({}, { targets: Array.from({ length: 17 }, (_, i) => ({ id: `t${i}`, url: `https://h${i}.example` })) }) },
    { label: 'duplicate target id', params: payload({}, { targets: [{ id: 't', url: 'https://a.example' }, { id: 't', url: 'https://b.example' }] }) },
    { label: 'duplicate target url', params: payload({}, { targets: [{ id: 't1', url: 'https://a.example' }, { id: 't2', url: 'https://a.example/' }] }) },
    { label: 'extra target key', params: payload({}, { targets: [{ id: 't', url: 'https://a.example', slots: 1 }] }) },
    { label: 'ftp url', params: payload({}, { targets: [{ id: 't', url: 'ftp://a.example' }] }) },
    { label: 'url with userinfo', params: payload({}, { targets: [{ id: 't', url: 'https://user:pw@a.example' }] }) },
    { label: 'url with a query', params: payload({}, { targets: [{ id: 't', url: 'https://a.example/?k=v' }] }) },
    { label: 'url with an empty query', params: payload({}, { targets: [{ id: 't', url: 'https://a.example/?' }] }) },
    { label: 'url with a fragment', params: payload({}, { targets: [{ id: 't', url: 'https://a.example/#x' }] }) },
    { label: 'url with whitespace', params: payload({}, { targets: [{ id: 't', url: 'https://a.example/a b' }] }) },
    { label: 'not a url', params: payload({}, { targets: [{ id: 't', url: 'llm.corp' }] }) },
  ])('rejects $label', ({ params }) => {
    expect(failure(() => parseOrgLlmEndpointSync(params))).toBe('ORG_LLM_ENDPOINT_PAYLOAD_INVALID')
  })

  it('never puts the token into the failure', () => {
    try { parseOrgLlmEndpointSync(payload({}, { token: 'secret value with space' })) } catch (error) {
      expect(String(error)).not.toContain('secret')
      return
    }
    throw new Error('expected a failure')
  })
})

describe('local store', () => {
  it('replaces only the synced endpoint and keeps the others', () => {
    const other = entry({ id: 'endpoint-2', generation: 9 })
    const before = replaceOrgLlmEndpoint(replaceOrgLlmEndpoint(undefined, other), entry())
    const after = replaceOrgLlmEndpoint(before, entry({ generation: 4 }))
    expect(after).toEqual({ version: 1, endpoints: { 'endpoint-2': other, 'endpoint-1': entry({ generation: 4 }) } })
    expect(before.endpoints['endpoint-1']!.generation).toBe(3)
  })

  it('round-trips through its file text', () => {
    const store = replaceOrgLlmEndpoint(undefined, entry())
    expect(parseOrgLlmEndpointStore(JSON.stringify(store))).toEqual(store)
  })

  it.each([
    { label: 'not json', raw: 'nope' },
    { label: 'wrong version', raw: JSON.stringify({ version: 2, endpoints: {} }) },
    { label: 'extra key', raw: JSON.stringify({ version: 1, endpoints: {}, extra: 1 }) },
    { label: 'an entry under another id', raw: JSON.stringify({ version: 1, endpoints: { other: entry() } }) },
    { label: 'an entry that is no longer valid', raw: JSON.stringify({ version: 1, endpoints: { 'endpoint-1': { ...entry(), generation: 0 } } }) },
  ])('refuses a store with $label', ({ raw }) => {
    expect(failure(() => parseOrgLlmEndpointStore(raw))).toBe('ORG_LLM_ENDPOINT_STORE_INVALID')
  })
})

describe('probeOrgLlmEndpointTarget', () => {
  const ok = (status = 200, body: string | null = '{"data":[]}') => vi.fn(async (_url: string, _init?: RequestInit) => new Response(body, { status }))

  it('asks GET {url}/v1/models without following redirects and sends the token both ways', async () => {
    const fetch = ok()
    await expect(probeOrgLlmEndpointTarget({ fetch, url: 'https://llm-a.corp.example/anthropic', token: 'corp-token-123' })).resolves.toEqual({ ok: true })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://llm-a.corp.example/anthropic/v1/models')
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
    expect(init!.headers).toMatchObject({ 'x-api-key': 'corp-token-123', Authorization: 'Bearer corp-token-123' })
    expect(init!.signal).toBeInstanceOf(AbortSignal)
  })

  it('sends no credential header for an endpoint without auth', async () => {
    const fetch = ok()
    await probeOrgLlmEndpointTarget({ fetch, url: 'https://llm-a.corp.example' })
    const headers = fetch.mock.calls[0]![1]!.headers as Record<string, string>
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain('authorization')
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain('x-api-key')
  })

  it.each([200, 204, 299])('accepts %i', async (status) => {
    await expect(probeOrgLlmEndpointTarget({ fetch: ok(status, null), url: 'https://a.example', token: 't' })).resolves.toEqual({ ok: true })
  })

  it.each([301, 401, 404, 500])('reports %i without the url or token', async (status) => {
    const result = await probeOrgLlmEndpointTarget({ fetch: ok(status), url: 'https://a.example', token: 'secret-token' })
    expect(result).toEqual({ ok: false, reason: `http-${status}` })
  })

  it('reports a network error by its name only', async () => {
    const fetch = vi.fn(async () => { throw Object.assign(new TypeError('connect ECONNREFUSED https://a.example?token=secret-token'), { cause: { code: 'ECONNREFUSED' } }) })
    const result = await probeOrgLlmEndpointTarget({ fetch, url: 'https://a.example', token: 'secret-token' })
    expect(result).toEqual({ ok: false, reason: 'TypeError:ECONNREFUSED' })
    expect(JSON.stringify(result)).not.toContain('secret-token')
  })

  it('gives up after the timeout and aborts the request', async () => {
    let aborted = false
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) })
    }))
    const result = await probeOrgLlmEndpointTarget({ fetch, url: 'https://a.example', timeoutMs: 20 })
    expect(result).toEqual({ ok: false, reason: 'timeout' })
    expect(aborted).toBe(true)
  })

  it('reads at most 16 KiB of the body and then cancels it', async () => {
    let pulled = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(4096)) },
      cancel() { cancelled = true },
    })
    const fetch = vi.fn(async () => new Response(body, { status: 200 }))
    await expect(probeOrgLlmEndpointTarget({ fetch, url: 'https://a.example' })).resolves.toEqual({ ok: true })
    expect(cancelled).toBe(true)
    expect(pulled).toBeLessThanOrEqual(6)
  })

  it('times out a body that never ends', async () => {
    const body = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => undefined) } })
    const fetch = vi.fn(async () => new Response(body, { status: 200 }))
    await expect(probeOrgLlmEndpointTarget({ fetch, url: 'https://a.example', timeoutMs: 20 })).resolves.toEqual({ ok: false, reason: 'timeout' })
  })
})

describe('buildOrgLlmEndpointEnvironment', () => {
  const target = { id: 'target-a', url: 'https://llm-a.corp.example' }

  it('builds exactly the closed set with the chosen address, the token and the tier models', () => {
    expect(buildOrgLlmEndpointEnvironment({ entry: entry({ models: { opus: 'big' } }), target, bindingId: 'binding-1' })).toEqual({
      ANTHROPIC_BASE_URL: 'https://llm-a.corp.example',
      ANTHROPIC_AUTH_TOKEN: 'corp-token-123',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '200000',
      ANTHROPIC_MODEL: 'corp-model-v1',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'big',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'corp-model-v1',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'corp-model-v1',
      API_TIMEOUT_MS: '600000',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_CUSTOM_HEADERS: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      CLAUDE_CODE_USE_BEDROCK: '',
      CLAUDE_CODE_USE_VERTEX: '',
      CLAUDE_CODE_USE_FOUNDRY: '',
      ANTHROPIC_SMALL_FAST_MODEL: '',
      HAPPY_AI_AUTH_SOURCE: 'org-endpoint',
      HAPPY_AI_AUTH_ORG_ENDPOINT_BINDING: 'binding-1:endpoint-1:target-a:3',
    })
  })

  it('uses a non-secret dummy token for an endpoint without auth', () => {
    const env = buildOrgLlmEndpointEnvironment({ entry: entry({ authMode: 'none', token: undefined }), target, bindingId: 'binding-1' })
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('saycode-org-endpoint-no-auth')
  })
})

describe('resolveOrgLlmEndpointLaunch', () => {
  const store = replaceOrgLlmEndpoint(undefined, entry())
  const selection = (patch: Partial<Extract<AiAuthSelection, { kind: 'org-endpoint' }>> = {}): Extract<AiAuthSelection, { kind: 'org-endpoint' }> =>
    ({ kind: 'org-endpoint', bindingId: 'binding-1', endpointId: 'endpoint-1', generation: 3, candidates: ['target-b', 'target-a'], ...patch })
  const probeOnly = (reachable: string[]) => vi.fn(async ({ url }: { url: string; token?: string }) =>
    reachable.some((host) => url.includes(host)) ? { ok: true as const } : { ok: false as const, reason: 'http-503' })

  it('uses the first candidate that answers, in the server order', async () => {
    const probe = probeOnly(['llm-a', '10.0.0.5'])
    const env = await resolveOrgLlmEndpointLaunch({ store, selection: selection(), probe })
    expect(env.ANTHROPIC_BASE_URL).toBe('http://10.0.0.5:8080/anthropic')
    expect(env.HAPPY_AI_AUTH_ORG_ENDPOINT_BINDING).toBe('binding-1:endpoint-1:target-b:3')
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledWith({ url: 'http://10.0.0.5:8080/anthropic', token: 'corp-token-123' })
  })

  it('falls over to the next candidate when the first does not answer', async () => {
    const probe = probeOnly(['llm-a'])
    const env = await resolveOrgLlmEndpointLaunch({ store, selection: selection(), probe })
    expect(env.HAPPY_AI_AUTH_ORG_ENDPOINT_BINDING).toBe('binding-1:endpoint-1:target-a:3')
    expect(probe.mock.calls.map(([call]) => call.url)).toEqual(['http://10.0.0.5:8080/anthropic', 'https://llm-a.corp.example'])
  })

  it('refuses the spawn when no candidate answers', async () => {
    const probe = probeOnly([])
    await expect(resolveOrgLlmEndpointLaunch({ store, selection: selection(), probe })).rejects.toMatchObject({ code: 'ORG_LLM_ENDPOINT_UNREACHABLE' })
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('does not probe an endpoint without a token with any credential', async () => {
    const open = replaceOrgLlmEndpoint(undefined, entry({ authMode: 'none', token: undefined }))
    const probe = probeOnly(['llm-a'])
    await resolveOrgLlmEndpointLaunch({ store: open, selection: selection({ candidates: ['target-a'] }), probe })
    expect(probe).toHaveBeenCalledWith({ url: 'https://llm-a.corp.example' })
  })

  it.each([
    { label: 'endpoint that was never synced', store: undefined, patch: {}, code: 'ORG_LLM_ENDPOINT_NOT_SYNCED' },
    { label: 'another endpoint synced', store: replaceOrgLlmEndpoint(undefined, entry({ id: 'endpoint-2' })), patch: {}, code: 'ORG_LLM_ENDPOINT_NOT_SYNCED' },
    { label: 'older local generation', store, patch: { generation: 4 }, code: 'ORG_LLM_ENDPOINT_GENERATION_MISMATCH' },
    { label: 'newer local generation', store, patch: { generation: 2 }, code: 'ORG_LLM_ENDPOINT_GENERATION_MISMATCH' },
    { label: 'candidate that is no target of the entry', store, patch: { candidates: ['target-a', 'target-zzz'] }, code: 'ORG_LLM_ENDPOINT_TARGET_UNKNOWN' },
  ])('refuses with $code for a $label before probing anything', async ({ store: held, patch, code }) => {
    const probe = probeOnly(['llm-a', '10.0.0.5'])
    await expect(resolveOrgLlmEndpointLaunch({ store: held, selection: selection(patch), probe })).rejects.toMatchObject({ code })
    expect(probe).not.toHaveBeenCalled()
  })

  it('a resume rebuilds the recorded target without asking the network and never moves to another one', async () => {
    const probe = probeOnly([])
    const env = await resolveOrgLlmEndpointLaunch({ store, selection: selection({ candidates: ['target-a'], resume: true }), probe })
    expect(env.ANTHROPIC_BASE_URL).toBe('https://llm-a.corp.example')
    expect(env.HAPPY_AI_AUTH_ORG_ENDPOINT_BINDING).toBe('binding-1:endpoint-1:target-a:3')
    expect(probe).not.toHaveBeenCalled()

    const withoutTarget = replaceOrgLlmEndpoint(undefined, entry({ targets: [{ id: 'target-b', url: 'http://10.0.0.5:8080/anthropic' }] }))
    await expect(resolveOrgLlmEndpointLaunch({ store: withoutTarget, selection: selection({ candidates: ['target-a'], resume: true }), probe }))
      .rejects.toMatchObject({ code: 'ORG_LLM_ENDPOINT_TARGET_UNKNOWN' })
  })
})
