import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserRuntimeError, SCHEMA_VERSION, type TaskId, type TaskSpaceId } from './contracts'
import { TaskStore, type StoredTask } from './taskStore'

const dirs: string[] = []
async function tempDir(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), 'abp-store-')); dirs.push(dir); return dir }
const sample = (): StoredTask => ({ schemaVersion: SCHEMA_VERSION, taskId: 't1' as TaskId, taskSpaceId: 's1' as TaskSpaceId, profileId: 'p1' as never, agentSessionId: 'a1' as never, status: 'queued', cancelRequested: false, stateVersion: 1, highWatermarkSeq: 0, tabs: [], uncertainActions: [], createdAtMs: 1, updatedAtMs: 1, owner: { principalId: 'p', workspaceId: 'w', machineId: 'm' }, actions: {}, approvals: {}, batches: {}, dedupe: {} })
const event = { type: 'task-created' as const, atMs: 1, stateVersion: 1, leaseEpoch: 0, data: {} }

afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

describe('TaskStore writer and journal guarantees', () => {
    it('refuses a second live writer and rejects commits after fencing changes', async () => {
        const dir = await tempDir(); const first = await TaskStore.open(dir)
        await expect(TaskStore.open(dir)).rejects.toMatchObject({ code: 'JOURNAL_UNAVAILABLE' })
        await first.createTask(sample(), event)
        await writeFile(join(dir, 'fencing'), '999')
        await expect(first.commit('t1' as TaskId, { status: 'running' }, { ...event, type: 'state-changed' })).rejects.toMatchObject({ code: 'JOURNAL_UNAVAILABLE' })
        await first.close()
    })

    it('does not ACK a failed journal append', async () => {
        const dir = await tempDir(); const store = await TaskStore.open(dir, (operation) => { if (operation === 'event-append') throw new Error('ENOSPC') })
        await expect(store.createTask(sample(), event)).rejects.toMatchObject({ code: 'JOURNAL_UNAVAILABLE' })
        expect(store.getTask('t1' as TaskId)).toBeUndefined()
        await store.close()
    })

    it('quarantines a garbled final line during recovery', async () => {
        const dir = await tempDir(); const store = await TaskStore.open(dir)
        await store.createTask(sample(), event); await store.close()
        const events = join(dir, 'tasks', 't1', 'events.jsonl'); await writeFile(events, `${await readFile(events, 'utf8')}partial`)
        const recovered = await TaskStore.open(dir)
        expect(recovered.getTask('t1' as TaskId)?.highWatermarkSeq).toBe(1)
        expect(await readFile(join(dir, 'tasks', 't1', 'events.orphan.jsonl'), 'utf8')).toContain('partial')
        expect((await readFile(events, 'utf8')).trim().split('\n')).toHaveLength(1)
        await recovered.close()
    })

    it('fails closed on a checksummed middle record corruption', async () => {
        const dir = await tempDir(); const store = await TaskStore.open(dir)
        await store.createTask(sample(), event)
        await store.commit('t1' as TaskId, { status: 'running' }, { ...event, type: 'state-changed', atMs: 2 })
        await store.close()
        const file = join(dir, 'tasks', 't1', 'events.jsonl')
        const contents = await readFile(file, 'utf8')
        await writeFile(file, contents.replace('task-created', 'task-corrupt'))
        await expect(TaskStore.open(dir)).rejects.toMatchObject({ code: 'JOURNAL_UNAVAILABLE' })
    })
})
