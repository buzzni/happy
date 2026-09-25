/**
 * Production-mode Runtime on real containers (S2 smoke): the Runtime reads
 * /etc/abp/runtime.json, verifies the entrypoint flock, issues agent grants on
 * the broker socket, serves admin only on its unix socket, and accepts
 * interactive capabilities only when server-signed (abp2).
 *
 * It runs next to the harness stack's Runtime, on its own state volume, and
 * attaches to the same browsers. Socket clients run in helper containers that
 * share the /run/abp volume (unix sockets do not cross the macOS bind mount).
 */
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { signServerCapability } from '../auth'
import { INTERACTIVE_CAPABILITY_ISSUER, type RequestId } from '../contracts'
import { RuntimeClient } from '../runtimeClient'
import { MACHINE, PRINCIPAL_A, PROFILE_A, SITE_A, SITE_B, WORKSPACE, startPocStack, type PocStack } from './pocStack'

const abpDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/browser-poc/.abp')
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

describe('Runtime in production mode', () => {
    let stack: PocStack
    let name: string
    let image: string
    let runtimeUrl: string
    const daemonToken = randomBytes(32).toString('hex')
    const issuer = generateKeyPairSync('ed25519')
    const runVolume = () => `abp-${stack.run}-prod-run`

    /** One HTTP request over a unix socket in the shared /run/abp volume, from a helper container. */
    const socketCall = (socket: string, method: string, path: string, headers: Record<string, string> = {}, body?: unknown): { status: number; body: any } => {
        const script = `const http=require('node:http');const [s,m,p,h,b]=process.argv.slice(1);const r=http.request({socketPath:s,method:m,path:p,headers:JSON.parse(h)},(res)=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>process.stdout.write(JSON.stringify({status:res.statusCode,body:d?JSON.parse(d):{}})))});r.on('error',e=>{process.stdout.write(JSON.stringify({status:0,body:{error:e.code}}))});r.end(b||undefined)`
        const out = docker(['run', '--rm', '--label', `ai.saycode.abp-run=${stack.run}`, '-v', `${runVolume()}:/run/abp`, '--entrypoint', 'node', image,
            '-e', script, socket, method, path, JSON.stringify({ 'content-type': 'application/json', ...headers }), body === undefined ? '' : JSON.stringify(body)])
        return JSON.parse(out) as { status: number; body: any }
    }

    beforeAll(async () => {
        stack = await startPocStack()
        image = docker(['inspect', '-f', '{{.Config.Image}}', stack.env.containers.runtime])
        name = `abp-${stack.run}-runtime-prod`
        const configFile = join(abpDir, stack.run, 'runtime.json')
        writeFileSync(configFile, JSON.stringify({
            authMode: 'production', machineId: MACHINE, workspaceId: WORKSPACE,
            profiles: [{ profileId: PROFILE_A, principalId: PRINCIPAL_A, cdpHttpUrl: 'http://browser-a:9223', instanceUrl: 'http://browser-a:9224/instance' }],
            trustedIssuers: [{ kid: 'k1', publicKeyPem: issuer.publicKey.export({ type: 'spki', format: 'pem' }).toString() }],
            sites: [{ origin: SITE_A }, { origin: SITE_B }],
            runtimePort: 8787,
            daemonTokenSha256: createHash('sha256').update(daemonToken).digest('hex'),
        }), { mode: 0o644 })
        docker(['volume', 'create', '--label', `ai.saycode.abp-run=${stack.run}`, `abp-${stack.run}-prod-state`])
        docker(['volume', 'create', '--label', `ai.saycode.abp-run=${stack.run}`, runVolume()])
        // Fresh named volumes copy ownership from the image path, so the abp user owns /run/abp and the state dir.
        docker(['run', '-d', '--name', name, '--label', `ai.saycode.abp-run=${stack.run}`, '--network', `abp-${stack.run}-a`,
            '--read-only', '--tmpfs', '/tmp:rw,size=64m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '-v', `abp-${stack.run}-prod-state:/var/lib/abp`, '-v', `${runVolume()}:/run/abp`,
            '-v', `${join(abpDir, 'runtime.mjs')}:/app/runtime.mjs:ro`, '-v', `${configFile}:/etc/abp/runtime.json:ro`,
            '-e', 'ABP_STATE_DIR=/var/lib/abp/state', '-e', 'ABP_CONFIG_FILE=/etc/abp/runtime.json',
            '-p', '127.0.0.1::8787', image])
        runtimeUrl = `http://127.0.0.1:${docker(['port', name, '8787']).split('\n')[0].split(':').at(-1)}`
        const deadline = Date.now() + 60_000
        for (;;) {
            const ready = await fetch(`${runtimeUrl}/v1/ready`).then((r) => r.status).catch(() => 0)
            if (ready === 200) break
            if (Date.now() > deadline) throw new Error(`production Runtime not ready: ${execFileSync('sh', ['-c', 'docker logs "$0" 2>&1 | tail -20', name], { encoding: 'utf8' })}`)
            await new Promise((r) => setTimeout(r, 500))
        }
    }, 300_000)
    afterAll(() => stack?.down({ purge: true }))

    it('holds the writer flock, publishes no admin port and serves readiness', async () => {
        const stderr = execFileSync('sh', ['-c', 'docker logs "$0" 2>&1', name], { encoding: 'utf8' })
        expect(stderr).toMatch(/listening .*mode=production admin=socket broker=socket flock=true/)
        expect(docker(['port', name])).not.toMatch(/8788/)
        expect(await (await fetch(`${runtimeUrl}/v1/ready`)).json()).toEqual({ ok: true, ready: true, checks: { browsers: true, writerLock: true, disk: true } })
        const metrics = socketCall('/run/abp/admin.sock', 'GET', '/admin/metrics')
        expect(metrics.status).toBe(200)
        expect(metrics.body.result.browsers).toEqual({ [PROFILE_A]: { connected: true } })
    })

    it('issues a session grant over the broker socket and serves the task API with it', async () => {
        const daemon = { 'x-abp-daemon-token': daemonToken }
        expect(socketCall('/run/abp/broker.sock', 'POST', '/v1/sessions/register', {}, { schemaVersion: 1 }).status).toBe(401)
        const registered = socketCall('/run/abp/broker.sock', 'POST', '/v1/sessions/register', daemon, { schemaVersion: 1 })
        expect(registered.status).toBe(200)
        const { registrationId, sessionSecret } = registered.body.result
        expect(socketCall('/run/abp/broker.sock', 'POST', '/v1/sessions/bind', daemon, { schemaVersion: 1, registrationId, agentSessionId: 'session-prod' }).status).toBe(200)
        const granted = socketCall('/run/abp/broker.sock', 'POST', '/v1/agent-grants', { 'x-abp-session-secret': sessionSecret }, { schemaVersion: 1, agentSessionId: 'session-prod', profileId: PROFILE_A })
        expect(granted.status).toBe(200)
        const agent = new RuntimeClient({ baseUrl: runtimeUrl, token: granted.body.result.token })
        const { taskSpaceId } = await agent.createSpace({ profileId: PROFILE_A, requestId: randomUUID() as RequestId })
        const task = await agent.createTask({ taskSpaceId, requestId: randomUUID() as RequestId })

        // Interactive: server-signed abp2 works, the harness's abp1 HMAC capability does not.
        const now = Date.now() - 5_000
        const capability = signServerCapability({ kind: 'interactive', capabilityId: `cap-${randomUUID()}`, principalId: PRINCIPAL_A, workspaceId: WORKSPACE,
            machineId: MACHINE, viewerSessionId: 'viewer', profileId: PROFILE_A, operations: ['getTask', 'approve'], issuedAtMs: now, expiresAtMs: now + 240_000,
            aud: MACHINE, iss: INTERACTIVE_CAPABILITY_ISSUER }, { kid: 'k1', privateKey: issuer.privateKey })
        expect((await new RuntimeClient({ baseUrl: runtimeUrl, token: capability }).getTask({ taskId: task.taskId })).taskId).toBe(task.taskId)
        await expect(new RuntimeClient({ baseUrl: runtimeUrl, token: stack.mintInteractive() }).getTask({ taskId: task.taskId })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })

        expect(socketCall('/run/abp/broker.sock', 'POST', '/v1/sessions/revoke', daemon, { schemaVersion: 1, agentSessionId: 'session-prod' }).body.result).toEqual({ revoked: true, grants: 1 })
        await expect(agent.getTask({ taskId: task.taskId })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
        expect(socketCall('/run/abp/broker.sock', 'POST', '/v1/agent-grants', { 'x-abp-session-secret': sessionSecret }, { schemaVersion: 1, agentSessionId: 'session-prod', profileId: PROFILE_A }).status).toBe(401)
    }, 120_000)
})
