import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AttentionOutbox } from './attention'
import { startBroker, type BrokerOptions } from './broker'
import { INTERACTIVE_CAPABILITY_ISSUER } from './contracts'

const issuer = generateKeyPairSync('ed25519')
const trustedIssuers = [{ kid: 'native-test', publicKeyPem: issuer.publicKey.export({ type: 'spki', format: 'pem' }).toString() }]
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function setup(extra: Partial<BrokerOptions> = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'native-broker-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const attention = await AttentionOutbox.open(dir)
    const server = createServer()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(async () => { attention.close(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())) })
    const broker = await startBroker({
        stateDir: dir, socketPath: '', server, attention,
        identity: { machineId: 'machine-a', workspaceId: 'workspace-a' },
        profiles: new Map([['profile-a', 'user-a']]), allowedOrigins: ['https://example.com'],
        agentKey: 'synthetic-agent-key', trustedIssuers, nativeAuthorization: true,
        revokeGrant: async () => {}, now: () => 100000, ...extra,
    } as unknown as BrokerOptions)
    cleanups.push(() => broker.close())
    const address = server.address() as { port: number }
    const call = async (path: string, body?: string, token?: string, headers?: Record<string, string>) => {
        const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
            method: body === undefined ? 'GET' : 'POST', body,
            headers: { ...(token ? { 'x-abp-native-command': token } : {}), ...headers },
        })
        return { status: response.status, json: await response.json() as { result: any; error?: { retryable: boolean; mayHaveSideEffects: boolean } } }
    }
    const challenge = (await call('/v1/native/challenge')).json.result
    function envelope(path: string, body?: string, overrides: Record<string, unknown> = {}) {
        const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'native-test', typ: 'abp-native-command' })).toString('base64url')
        const claims = { kind: 'native-command', iss: INTERACTIVE_CAPABILITY_ISSUER,
            aud: 'machine-a', machineId: 'machine-a', workspaceId: 'workspace-a',
            generation: challenge.generation, requestId: randomUUID(), principalId: 'user-a',
            method: body === undefined ? 'GET' : 'POST', path,
            bodySha256: createHash('sha256').update(body ?? '').digest('hex'),
            issuedAtMs: 100000, expiresAtMs: 115000, ...overrides }
        const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
        const content = `abp2.${header}.${payload}`
        return `${content}.${sign(null, Buffer.from(content), issuer.privateKey).toString('base64url')}`
    }
    return { call, envelope, challenge }
}
it('registers with an exact signed operation and refuses reuse, legacy tokens and unsigned calls', async () => {
    const h = await setup(), path = '/v1/sessions/register', body = '{"schemaVersion":1}'
    expect(Object.keys(h.challenge).sort()).toEqual(['generation', 'machineId', 'schemaVersion', 'workspaceId'])
    const token = h.envelope(path, body)
    const registered = await h.call(path, body, token)
    expect(registered.status).toBe(200)
    expect(registered.json.result.sessionSecret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect((await h.call(path, body, token)).status).toBe(401)
    expect((await h.call(path, body)).status).toBe(401)
    expect((await h.call(path, body, undefined, { 'x-abp-daemon-token': 'legacy' })).status).toBe(401)
})
it('rejects changes to exact bytes, path, scope, generation, lifetime or signature', async () => {
    const h = await setup(), path = '/v1/sessions/register', body = '{"schemaVersion":1}'
    expect((await h.call(path, '{ "schemaVersion":1}', h.envelope(path, body))).status).toBe(401)
    for (const change of [ { machineId: 'machine-b' }, { workspaceId: 'workspace-b' }, { aud: 'machine-b' },
        { generation: 'old-service-generation' }, { expiresAtMs: 99999 }, { issuedAtMs: 100001 },
        { expiresAtMs: 160001 }, { path: '/v1/sessions/revoke' }, { method: 'GET' }, { kind: 'interactive' } ]) {
        expect((await h.call(path, body, h.envelope(path, body, change))).status).toBe(401)
    }
    const parts = h.envelope(path, body).split('.')
    parts[3] = Buffer.alloc(64).toString('base64url')
    expect((await h.call(path, body, parts.join('.'))).status).toBe(401)
    expect((await h.call('/v1/sessions', undefined, h.envelope('/v1/sessions'))).json.result).toEqual([])
})
it('consumes authority before concurrent dispatch and rejects an old service generation', async () => {
    const h = await setup(), other = await setup(), path = '/v1/sessions/register', body = '{"schemaVersion":1}'
    const token = h.envelope(path, body)
    expect((await other.call(path, body, token)).status).toBe(401)
    const results = await Promise.all([h.call(path, body, token), h.call(path, body, token)])
    expect(results.map(r => r.status).sort()).toEqual([200, 401])
})
it('binds query bytes and cannot use daemon authority as an agent grant', async () => {
    const h = await setup()
    const path = '/v1/sessions/waiting?agentSessionId=session-a'
    expect((await h.call(path, undefined, h.envelope(path))).status).toBe(200)
    expect((await h.call(path + '&agentSessionId=session-b', undefined, h.envelope(path))).status).toBe(401)
    const body = '{"schemaVersion":1,"agentSessionId":"session-a"}'
    expect((await h.call('/v1/agent-grants', body, h.envelope('/v1/agent-grants', body))).status).toBe(401)
})
it('preserves bind, per-session grant and revocation through the signed service boundary', async () => {
    const h = await setup()
    const privileged = (path: string, value: unknown) => {
        const body = JSON.stringify(value)
        return h.call(path, body, h.envelope(path, body))
    }
    const registered = await privileged('/v1/sessions/register', { schemaVersion: 1 })
    const { registrationId, sessionSecret } = registered.json.result
    expect((await privileged('/v1/sessions/bind', { schemaVersion: 1, registrationId, agentSessionId: 'session-a' })).status).toBe(200)
    const grant = () => h.call('/v1/agent-grants', JSON.stringify({ schemaVersion: 1, agentSessionId: 'session-a', profileId: 'profile-a' }), undefined,
        { 'x-abp-session-secret': sessionSecret })
    expect((await grant()).status).toBe(200)
    expect((await privileged('/v1/sessions/revoke', { schemaVersion: 1, registrationId })).status).toBe(200)
    expect((await grant()).status).toBe(401)
})
it('never invites automatic replay after an authorized mutation fails without a definitive result', async () => {
    const h = await setup({ admit: async () => { throw new Error('synthetic unknown failure') } })
    const path = '/v1/sessions/register', body = '{"schemaVersion":1}'
    const result = await h.call(path, body, h.envelope(path, body))
    expect(result.status).toBe(500)
    expect(result.json.error).toMatchObject({ retryable: false, mayHaveSideEffects: true })
})
