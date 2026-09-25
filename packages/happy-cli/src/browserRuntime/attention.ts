/**
 * Attention outbox (D10, Runtime side).
 *
 * Persists the external task transitions after which the owning agent session
 * must be re-invoked (user approval decision, takeover release, user resume,
 * recovery). Transitions are tagged at commit time with `data.attention`; the
 * outbox observes TaskStore commits, so the Runtime core never writes here.
 *
 * Durability: the task journal is the source of truth. A crash between a task
 * commit and the outbox write is repaired by `reconcile()` at start-up, which
 * appends any tagged task event newer than the outbox's per-task cursor.
 * The daemon reads the feed over the broker socket and deduplicates delivery
 * by `abp-<taskId>-<eventSeq>`.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ATTENTION_REASONS, BrowserRuntimeError, TERMINAL_STATUSES, type AttentionEvent, type AttentionFeed, type AttentionReason, type TaskEvent, type TaskId } from './contracts'
import type { StoredTask, TaskStore } from './taskStore'

const FILE = 'attention.json'
const SCHEMA_VERSION = 1
const DEFAULT_MAX_EVENTS = 1_000

interface OutboxFile {
    schemaVersion: number
    lastSeq: number
    events: AttentionEvent[]
    /** Highest task event seq already recorded, per task. */
    taskCursors: Record<string, number>
}

function attentionReason(event: TaskEvent): AttentionReason | undefined {
    const reason = event.data.attention
    return (ATTENTION_REASONS as readonly unknown[]).includes(reason) ? reason as AttentionReason : undefined
}

export class AttentionOutbox {
    private store?: TaskStore
    private writeTail: Promise<void> = Promise.resolve()
    private readonly waiters = new Set<() => void>()

    private constructor(private readonly stateDir: string, private readonly maxEvents: number, private state: OutboxFile) { }

    static async open(stateDir: string, options: { maxEvents?: number } = {}): Promise<AttentionOutbox> {
        let state: OutboxFile = { schemaVersion: SCHEMA_VERSION, lastSeq: 0, events: [], taskCursors: {} }
        try {
            const parsed = JSON.parse(await readFile(join(stateDir, FILE), 'utf8')) as OutboxFile
            if (parsed.schemaVersion !== SCHEMA_VERSION) throw new BrowserRuntimeError('JOURNAL_UNAVAILABLE', 'Unknown attention outbox schema')
            state = parsed
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error instanceof BrowserRuntimeError ? error : new BrowserRuntimeError('JOURNAL_UNAVAILABLE', 'Attention outbox is unreadable')
        }
        return new AttentionOutbox(stateDir, options.maxEvents ?? DEFAULT_MAX_EVENTS, state)
    }

    /** Start recording tagged commits of `store`. */
    attach(store: TaskStore): void {
        this.store = store
        store.onCommitted((task, event) => this.record(task, event))
    }

    /** Append tagged task events that the outbox missed (crash between commit and outbox write). */
    async reconcile(): Promise<void> {
        for (const task of this.store?.listTasks() ?? []) {
            for (const event of this.store?.events(task.taskId, this.state.taskCursors[task.taskId] ?? 0) ?? []) this.record(task, event)
        }
        await this.flush()
    }

    read(afterSeq: number): AttentionFeed {
        const oldestSeq = this.state.events[0]?.seq ?? this.state.lastSeq + 1
        if (afterSeq + 1 < oldestSeq || afterSeq > this.state.lastSeq) {
            return { code: 'CURSOR_EXPIRED', events: [], snapshot: this.snapshot(), nextSeq: this.state.lastSeq, oldestSeq }
        }
        const events = this.state.events.filter((event) => event.seq > afterSeq)
        return { events: structuredClone(events), nextSeq: events.at(-1)?.seq ?? afterSeq, oldestSeq }
    }

    /** Long poll: resolves as soon as an event after `afterSeq` exists, or after waitMs. */
    async wait(afterSeq: number, waitMs: number): Promise<AttentionFeed> {
        const first = this.read(afterSeq)
        if ('code' in first || first.events.length > 0 || waitMs <= 0) return first
        await new Promise<void>((resolve) => {
            const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve() }
            const timer = setTimeout(wake, waitMs)
            this.waiters.add(wake)
        })
        return this.read(afterSeq)
    }

    /** Resolves once every recorded event is durable. */
    flush(): Promise<void> { return this.writeTail }

    private record(task: StoredTask, event: TaskEvent): void {
        const reason = attentionReason(event)
        if (event.seq <= (this.state.taskCursors[task.taskId] ?? 0)) return
        this.state.taskCursors[task.taskId] = event.seq
        if (!reason) return
        const seq = this.state.lastSeq + 1
        this.state.lastSeq = seq
        this.state.events = [...this.state.events, { seq, taskId: task.taskId as TaskId, agentSessionId: task.agentSessionId,
            status: task.status, eventSeq: event.seq, reason }].slice(-this.maxEvents)
        const snapshot = structuredClone(this.state)
        // A failed write is retried by the next record; reconcile() repairs a crash.
        this.writeTail = this.writeTail.then(() => this.persist(snapshot)).catch(() => undefined)
        for (const wake of [...this.waiters]) wake()
    }

    /** Latest attention entry per task that no agent batch has followed since. */
    private snapshot(): AttentionEvent[] {
        const latest = new Map<string, AttentionEvent>()
        for (const event of this.state.events) latest.set(event.taskId, event)
        return [...latest.values()].filter((entry) => {
            const task = this.store?.getTask(entry.taskId)
            if (!task) return false
            const handled = (this.store?.events(entry.taskId, entry.eventSeq) ?? []).some((event) => event.type === 'batch-accepted')
            return !handled && (!(TERMINAL_STATUSES as readonly string[]).includes(task.status) || entry.reason === 'approval-rejected')
        }).map((entry) => structuredClone(entry))
    }

    private async persist(state: OutboxFile): Promise<void> {
        await mkdir(this.stateDir, { recursive: true })
        const file = join(this.stateDir, FILE)
        const temporary = join(this.stateDir, `.${randomUUID()}.attention.tmp`)
        try {
            const handle = await open(temporary, 'wx', 0o600)
            try {
                await handle.writeFile(JSON.stringify(state))
                await handle.sync()
            } finally {
                await handle.close()
            }
            await rename(temporary, file)
            const dir = await open(this.stateDir, 'r')
            try { await dir.sync() } finally { await dir.close() }
        } catch (error) {
            await rm(temporary, { force: true })
            throw error
        }
    }
}
