/** Real Chrome + Unix broker + separate CLI consumer; TCP/FakeDriver remains a restricted-environment smoke. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { launchChrome } from './drivers/pocTestKit'
import { FakeBrowserDriver } from './testing/fakeDriver'
import type { BrowserDriver } from './contracts'
import { CdpDriver } from './drivers/cdpDriver'
import { TaskStore } from './taskStore'
import { AttentionOutbox } from './attention'
import { BrowserRuntime } from './runtime'
import { startRuntimeServer } from './server'
import { startBroker, withRevokingGrants } from './broker'
import { verifyToken } from './auth'
import { fixtureSitePolicies } from './testing/fixtureSitePolicy'
import { AGENT_OPERATIONS, type AgentGrant } from './contracts'
const exec = promisify(execFile)
const consumer = `
const fs=require('node:fs');
const {url,token,space,target}=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
async function call(op,body){const r=await fetch(url+'/v1/ops/'+op,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(body)});const j=await r.json();if(!j.ok)throw Error(j.error.code);return j.result}
(async()=>{const task=await call('createTask',{taskSpaceId:space,requestId:crypto.randomUUID()});let tab;
try {const opened=await call('openPage',{taskId:task.taskId,url:target,requestId:crypto.randomUUID()});tab=opened.tabId;
const observed=await call('observe',{taskId:task.taskId,tabId:tab});const current=await call('getTask',{taskId:task.taskId});
await call('finishTask',{taskId:task.taskId,expectedVersion:current.stateVersion,requestId:crypto.randomUUID()});
const closed=await call('closePage',{taskSpaceId:space,tabId:tab,requestId:crypto.randomUUID()});if(!closed.closed)throw Error('cleanup');
console.log(JSON.stringify({text:observed.text}));}
catch(e){await call('cancel',{taskId:task.taskId,requestId:crypto.randomUUID()}).catch(()=>{});throw e;}})().catch(()=>{console.log(JSON.stringify({ok:false}));process.exitCode=3});`
const realChrome = process.env.BROWSER_CLIENT_REAL_SMOKE === '1'
it.runIf(realChrome || process.env.BROWSER_CLIENT_HTTP_SMOKE === '1')(realChrome ? 'real Chrome authenticated profile: separate process collection and revocation' : 'real HTTP and separate process with FakeDriver (not a login acceptance)', async () => {
    const cleanups: Array<() => Promise<unknown>> = []
    try {
        const dir = await mkdtemp(join(tmpdir(), 'browser-client-real-')); cleanups.push(() => rm(dir, { recursive: true, force: true }))
        const site = createServer((req, res) => {
            res.setHeader('content-type', 'text/html'); res.setHeader('cache-control', 'no-store')
            if (req.url === '/seed') { res.setHeader('set-cookie', 'test-login=authenticated; Path=/; HttpOnly; SameSite=Strict'); res.end('<h1>Test login seeded</h1>') }
            else res.end(`<h1>${req.headers.cookie?.includes('test-login=authenticated') ? 'AUTHENTICATED_REPORT' : 'LOGIN_REQUIRED'}</h1>`)
        })
        await new Promise<void>(r => site.listen(0, '127.0.0.1', r)); cleanups.push(() => new Promise<void>(r => { site.closeAllConnections(); site.close(() => r()) }))
        const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`
        let driver: BrowserDriver
        if (realChrome) {
            const chrome = await launchChrome(); cleanups.push(() => chrome.stop())
            const cdp = new CdpDriver({ browserWsUrl: chrome.browserWsUrl, browserInstanceIdProvider: async () => 'smoke-browser' as never })
            await cdp.connect(); cleanups.push(() => cdp.close()); driver = cdp
        } else driver = new FakeBrowserDriver()
        const store = await TaskStore.open(dir); cleanups.push(() => store.close())
        const runtime = new BrowserRuntime({ store, drivers: { main: driver }, sites: fixtureSitePolicies([origin]), spaceIdleReclaimMs: 100 })
        const attention = await AttentionOutbox.open(dir); attention.attach(store)
        const key = 'synthetic-client-smoke-key-only', now = Date.now()
        const credential: AgentGrant = { kind: 'agent-grant', grantId: 'parent-g' as never, principalId: 'u' as never, machineId: 'm' as never, workspaceId: 'w' as never,
            profileId: 'main' as never, agentSessionId: 'parent' as never, operations: [...AGENT_OPERATIONS], allowedOrigins: [origin], taskSpaceIds: [], issuedAtMs: now, expiresAtMs: now + 3600000 }
        const auth = { credential, verifiedAtMs: now }
        const space = await runtime.createSpace(auth, { profileId: credential.profileId, requestId: 'space' as never })
        const task = await runtime.createTask(auth, { taskSpaceId: space.taskSpaceId, requestId: 'seed-task' as never })
        const opened = await runtime.openPage(auth, { taskId: task.taskId, url: origin + '/seed', requestId: 'seed-page' as never })
        const current = await runtime.getTask(auth, { taskId: task.taskId })
        await runtime.finishTask(auth, { taskId: task.taskId, expectedVersion: current.stateVersion, requestId: 'seed-done' as never })
        await runtime.closePage(auth, { taskSpaceId: space.taskSpaceId, tabId: opened.tabId, requestId: 'seed-close' as never })
        const socketPath = join(dir, 'broker.sock')
        const server = createServer()
        if (!realChrome) await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
        const broker = await startBroker({ ...(realChrome ? {} : { server }), socketPath, stateDir: dir, attention, agentKey: key,
            daemonTokenSha256: createHash('sha256').update('test-daemon').digest('hex'), identity: { machineId: credential.machineId, workspaceId: credential.workspaceId },
            profiles: new Map([[credential.profileId, credential.principalId]]), allowedOrigins: [origin],
            revokeGrant: id => runtime.revokeGrant(id), endSession: id => runtime.endSession(id),
            setLocalClientValidator: check => runtime.setLocalClientValidator(check),
            attachLocalClient: (owner, client, until) => runtime.attachLocalClient(owner, client, until), cleanupLocalClient: (id: string) => runtime.endLocalClient(id),
            checkLocalClient: c => runtime.checkLocalClient(c) })
        cleanups.push(() => broker.close())
        const address = realChrome ? { socketPath } : { hostname: '127.0.0.1', port: (server.address() as { port: number }).port }
        const call = (path: string, secret: string, body: unknown, daemon = false) => new Promise<any>((resolve, reject) => {
            const req = request({ ...address, path, method: 'POST', headers: { 'content-type': 'application/json',
                [daemon ? 'x-abp-daemon-token' : 'x-abp-session-secret']: secret } }, response => {
                let raw = ''
                response.on('data', chunk => { raw += chunk })
                response.on('error', reject)
                response.on('end', () => {
                    try { const reply = JSON.parse(raw); expect(reply.ok).toBe(true); resolve(reply.result) }
                    catch (error) { reject(error) }
                })
            })
            req.on('error', reject); req.setTimeout(30_000, () => req.destroy(new Error('test broker timeout')))
            req.end(JSON.stringify(body))
        })
        const owner = await call('/v1/sessions/register', 'test-daemon', { schemaVersion: 1 }, true)
        await call('/v1/sessions/bind', 'test-daemon', { schemaVersion: 1, registrationId: owner.registrationId, agentSessionId: 'parent' }, true)
        const connection = await call('/v1/clients/register', owner.sessionSecret, { schemaVersion: 1, profileId: 'main', taskSpaceId: space.taskSpaceId, origins: [origin], leaseMs: 60000 })
        const issued = await call('/v1/clients/grant', connection.clientSecret, { schemaVersion: 1 })
        const api = await startRuntimeServer({ api: runtime, host: '127.0.0.1', port: 0, health: () => ({}), verifyToken: token => verifyToken(token, { agentKey: key }, Date.now(), withRevokingGrants(store.getRevocations(), broker)) })
        cleanups.push(() => api.close())
        const input = join(dir, 'consumer.json')
        await writeFile(input, JSON.stringify(realChrome ? { schemaVersion: 1, brokerSocket: socketPath, runtimeUrl: api.url,
            clientSecret: connection.clientSecret, clientSessionId: connection.clientSessionId, profileId: 'main',
            taskSpaceId: space.taskSpaceId, expiresAtMs: connection.expiresAtMs }
            : { url: api.url, token: issued.token, space: space.taskSpaceId, target: origin + '/report' }), { mode: 0o600 })
        const collect = () => exec(process.execPath, realChrome
            ? [resolve('dist/index.mjs'), 'browser-client', 'collect', '--file', input, '--url', origin + '/report']
            : ['-e', consumer, input], { timeout: 30000 })
        expect((await collect()).stdout).toContain(realChrome ? 'AUTHENTICATED_REPORT' : '"text"')
        await runtime.endSession('parent'); await runtime.reclaimSpaces()
        expect((await collect()).stdout).toContain(realChrome ? 'AUTHENTICATED_REPORT' : '"text"')
        await call('/v1/clients/revoke', connection.clientSecret, { schemaVersion: 1 })
        await expect(collect()).rejects.toMatchObject({ code: 3 })
        expect(store.getSpace(space.taskSpaceId)?.tabs).toHaveLength(0)
    } finally { for (const cleanup of cleanups.reverse()) await cleanup() }
}, 60000)
