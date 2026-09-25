import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeBase64, decrypt } from '@/api/encryption'
import { AttentionOutbox } from '@/browserRuntime/attention'
import { startBroker, type Broker } from '@/browserRuntime/broker'
import type { AttentionEvent } from '@/browserRuntime/contracts'
import { TaskStore, type StoredTask } from '@/browserRuntime/taskStore'
import { BrowserAttentionWatcher, createAttentionCursorStore } from './browserAttentionWatcher'
import { deliverBrowserAttention, pollBrowserAttention, startBrowserAttentionWatcher } from './browserAttentionDelivery'
import type { TrackedSession } from './types'

const event: AttentionEvent = { seq: 1, taskId: 'task-1' as never, agentSessionId: 'session-1' as never, status: 'paused', eventSeq: 2, reason: 'approval-approved' }
const encryption = { encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy' as const, seq: 0, metadataVersion: 0, agentStateVersion: 0 }
const session: TrackedSession = { startedBy: 'daemon', happySessionId: 'session-1', pid: 123, encryption }
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function tempDir() { const dir = await mkdtemp(join(tmpdir(), 'abp-deliver-')); cleanup.push(() => rm(dir, { recursive: true, force: true })); return dir }
async function listen(server: Server) {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('address')
    return `http://127.0.0.1:${address.port}`
}

describe('attention delivery over the existing encrypted server path', () => {
    it.each(['legacy', 'dataKey'] as const)('posts only PoC text with stable localId and validates ack (%s)', async variant => {
        let acknowledge = false; const requests: unknown[] = []
        const serverUrl = await listen(createServer(async (req, res) => {
            let raw = ''; for await (const chunk of req) raw += chunk
            const body = JSON.parse(raw); requests.push(body)
            expect(req.url).toBe('/v3/sessions/session-1/messages')
            expect(req.headers.authorization).toBe('Bearer synthetic-account-token')
            const message = body.messages[0]
            expect(message.localId).toBe('abp-task-1-2')
            expect(decrypt(encryption.encryptionKey, variant, decodeBase64(message.content))).toEqual({
                role: 'user', content: { type: 'text', text: '[agent-browser] task task-1 status=paused eventSeq=2. Call getTask for the current state before continuing.' },
                localKey: 'abp-task-1-2', meta: { sentFrom: 'daemon', source: 'agent-browser' },
            })
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ messages: acknowledge ? [{ id: 'm1', localId: message.localId, seq: 1 }] : [] }))
        }))
        const options = { serverUrl, findSession: () => ({ ...session, encryption: { ...encryption, encryptionVariant: variant } }), isAlive: () => true, readToken: async () => 'synthetic-account-token' }
        await expect(deliverBrowserAttention(event, new AbortController().signal, options)).rejects.toThrow('acknowledgement')
        acknowledge = true
        await expect(deliverBrowserAttention(event, new AbortController().signal, options)).resolves.toBe('sent')
        expect(requests).toHaveLength(2)
    })

    it('skips ended/unowned sessions and retries missing encryption or credentials without posting', async () => {
        let tracked: TrackedSession | undefined = session; let alive = false
        const options = { serverUrl: 'http://127.0.0.1:1', findSession: () => tracked, isAlive: () => alive, readToken: async () => null }
        const deliver = () => deliverBrowserAttention(event, new AbortController().signal, options)
        expect(await deliver()).toBe('ended')
        tracked = undefined; expect(await deliver()).toBe('unowned')
        tracked = { ...session, startedBy: 'happy directly - likely by user from terminal' }; alive = true
        expect(await deliver()).toBe('unowned')
        tracked = { ...session, encryption: undefined }; await expect(deliver()).rejects.toThrow('encryption')
        tracked = session; await expect(deliver()).rejects.toThrow('credential')
    })

    it('consumes the real S2 broker/outbox, including expiry and authenticated long-poll wakeup', async () => {
        const dir = await tempDir(); const socketPath = join(dir, 'b.sock')
        const store = await TaskStore.open(dir); cleanup.push(() => store.close())
        const attention = await AttentionOutbox.open(dir, { maxEvents: 1 }); attention.attach(store)
        const task: StoredTask = {
            schemaVersion: 1, taskId: 'task-1' as never, taskSpaceId: 'space-1' as never, profileId: 'profile-1' as never, agentSessionId: 'session-1' as never,
            status: 'paused', pauseReason: 'awaiting-agent', cancelRequested: false, stateVersion: 0, highWatermarkSeq: 0, tabs: [],
            uncertainActions: [], createdAtMs: 1, updatedAtMs: 1, owner: { principalId: 'p', workspaceId: 'w', machineId: 'm' },
            actions: {}, approvals: {}, batches: {}, dedupe: {},
        }
        await store.createTask(task, { type: 'task-created', atMs: 1, leaseEpoch: 0, data: {} })
        const daemonToken = 'synthetic-broker-token'
        const broker: Broker = await startBroker({ socketPath, stateDir: dir, daemonTokenSha256: createHash('sha256').update(daemonToken).digest('hex'), identity: { machineId: 'm' as never, workspaceId: 'w' as never }, profiles: new Map(), allowedOrigins: [], agentKey: 'synthetic-agent-key', revokeGrant: async () => {}, attention })
        cleanup.push(() => broker.close())
        const config = { socketPath, daemonToken }; const controller = new AbortController()
        const poll = (after: number, signal: AbortSignal) => pollBrowserAttention(config, after, signal)
        await expect(pollBrowserAttention({ ...config, daemonToken: 'synthetic-wrong-token' }, 0, controller.signal)).rejects.toThrow()
        const waiting = poll(0, controller.signal)
        await store.commit('task-1' as never, {}, { type: 'agent-attention-required', atMs: 2, leaseEpoch: 0, data: { attention: 'user-resumed' } })
        expect((await waiting).events).toHaveLength(1)
        await store.commit('task-1' as never, {}, { type: 'agent-attention-required', atMs: 3, leaseEpoch: 0, data: { attention: 'user-resumed' } }); await attention.flush()
        const sent: AttentionEvent[] = []; const cursor = createAttentionCursorStore(join(dir, 'daemon-cursor.json'))
        await new BrowserAttentionWatcher({ store: cursor, poll, deliver: async e => { sent.push(e); return 'sent' } }).pollOnce()
        expect(sent.map(e => e.eventSeq)).toEqual([3]); expect((await cursor.read()).afterSeq).toBe(2)
        const aborted = poll(2, controller.signal); controller.abort()
        await expect(aborted).rejects.toThrow()
    })


    it('starts only with the S2 configuration and cancels polling during shutdown', async () => {
        const dir = await tempDir(); const socketPath = join(dir, 'lifecycle.sock')
        const tokenFile = join(dir, 'token'); await writeFile(tokenFile, 'synthetic-lifecycle-token')
        let requests = 0
        let arrived!: () => void
        const polling = new Promise<void>(resolve => { arrived = resolve })
        const server = createServer(req => {
            expect(req.url).toBe('/v1/attention?afterSeq=0&waitMs=30000')
            expect(req.headers['x-abp-daemon-token']).toBe('synthetic-lifecycle-token')
            requests++; arrived()
        })
        await new Promise<void>(resolve => server.listen(socketPath, resolve))
        cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
        const options = { happyHomeDir: dir, machineId: 'machine-1', serverUrl: 'http://127.0.0.1:1', findSession: () => undefined, isAlive: () => false, readToken: async () => null, log: () => {} }
        await startBrowserAttentionWatcher({ ...options, env: {} })()
        await startBrowserAttentionWatcher({ ...options, env: { HAPPY_BROWSER_TASK_BROKER_SOCKET: socketPath, HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: join(dir, 'missing') } })()
        expect(requests).toBe(0)
        const stop = startBrowserAttentionWatcher({ ...options, env: { HAPPY_BROWSER_TASK_BROKER_SOCKET: socketPath, HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: tokenFile } })
        await polling; await stop()
        expect(requests).toBe(1)
        expect(await readdir(dir)).not.toContain('browser-attention')
    })

    it('rejects oversized broker replies and cancels a hanging poll promptly', async () => {
        const dir = await tempDir(); const socketPath = join(dir, 's.sock'); let oversized = true
        const server = createServer((_req, res) => { if (oversized) res.end('x'.repeat(1024 * 1024 + 1)) })
        await new Promise<void>(resolve => server.listen(socketPath, resolve))
        cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
        const config = { socketPath, daemonToken: 'synthetic-token' }
        await expect(pollBrowserAttention(config, 0, new AbortController().signal)).rejects.toThrow()
        oversized = false
        const controller = new AbortController(); const pending = pollBrowserAttention(config, 0, controller.signal)
        controller.abort(); await expect(pending).rejects.toThrow()
    })
})
