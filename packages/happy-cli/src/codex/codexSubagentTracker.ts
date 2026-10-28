import { logger } from '@/ui/logger';

/**
 * Sub-agent (child thread) tracking for one Codex app-server connection.
 *
 * The client hands over every notification of a thread other than the main one, and the main thread's
 * `collabAgentToolCall` / `subAgentActivity` items. A thread seen for the first time is classified with
 * `thread/read`: it is shown when its `thread_spawn` parent chain reaches the main thread, the way the Codex
 * TUI walks loaded threads. Its running state follows the notifications and the parent's items, reconciled
 * by a `thread/read` poll while any child is shown. The shown list is published only when it changes.
 * Pure state; nothing here throws.
 */

export type CodexSubagentSnapshot = { startedAt: number; available: boolean; tasks: Array<{ taskId: string; label: string; kind: 'agent' }> | null };
export type CodexSubagentSpawn = { callId: string; threadId: string; turnId: string | null; label: string };

/** `close` also marks the child gone (TUI `is_closed`). */
type Transition = 'run' | 'stop' | 'close';

/** Running-state inputs named by a notification method of the child itself. */
const NOTIFICATIONS = new Map<string, Transition>([
    ['turn/started', 'run'], ['turn/completed', 'stop'], ['thread/closed', 'close'], ['thread/deleted', 'close'], ['thread/archived', 'close'],
]);

/** Running-state inputs named by a value: thread status types, `agentsStates` statuses, `subAgentActivity` kinds. */
const STATES = new Map<string, Transition>([
    ['active', 'run'], ['idle', 'stop'], ['systemError', 'stop'], ['notLoaded', 'close'],
    ['pendingInit', 'run'], ['running', 'run'], ['completed', 'stop'], ['errored', 'stop'], ['interrupted', 'stop'], ['shutdown', 'close'], ['notFound', 'close'],
    ['started', 'run'],
]);

const POLL_INTERVAL_MS = 5000;
const READ_RETRY_DELAY_MS = 2000;
const FIRST_LISTING_WAIT_MS = 1500;
const MAX_TASKS = 50;
const MAX_LABEL_LENGTH = 200;

type Child = {
    /** `thread/read` settled: answered, or failed twice. Until then the child is a candidate. */
    classified: boolean;
    /** Codex's own helper thread (review, compact, memory consolidation, …): never shown. */
    internal: boolean;
    /** Lineage: the parent `thread/read` reports, else the thread whose spawn item named this child. */
    parentId: string | null;
    spawnedBy: string | null;
    nickname: string | null;
    role: string | null;
    agentPath: string | null;
    running: boolean;
    /** Closed or unloaded; only the child's own next turn reopens it (app-server sends `notLoaded` before the
     *  closeAgent item that still carries the pre-close `running`). */
    gone: boolean;
    /** First listing while the classification read is pending: held until it settles or 1.5 s pass, then open.
     *  (`turn/started` comes ≈100 ms before the answer; listing at once would flash the fallback label.) */
    listing: 'new' | 'held' | 'open';
    /** A spawn was already returned for this child. */
    spawned: boolean;
    /** Bumped by every running-state input; a `thread/read` sent before the latest one keeps its status out. */
    seq: number;
};

type ThreadRead = Pick<Child, 'parentId' | 'internal' | 'nickname' | 'role' | 'agentPath'> & { status: string | null };
/** Own handle, so a falsy timer id from an injected `setTimer` still counts as scheduled. */
type Timer = { handle: unknown };
type Waiter = { child: Child; resolve: (label: string) => void; timer: Timer | null };

export class CodexSubagentTracker {
    private readonly request: (method: string, params: unknown) => Promise<unknown>;
    private readonly publish: (snapshot: CodexSubagentSnapshot) => void;
    private readonly now: () => number;
    private readonly setTimer: (fn: () => void, ms: number) => unknown;
    private readonly clearTimer: (t: unknown) => void;
    private readonly children = new Map<string, Child>();
    /** Children of an earlier main thread or app-server: still diverted, never tracked again. */
    private readonly retired = new Set<string>();
    /** New children whose classification starts once the input that created them is applied. */
    private readonly unread = new Map<string, Child>();
    private readonly waiters = new Set<Waiter>();
    private readonly timers = new Set<Timer>();
    private mainThreadId: string | null = null;
    private available: boolean | null = null;
    private startedAt: number | null = null;
    private publishedKey: string | null = null;
    /** Bumped by every reset; a `thread/read` answer of an older generation is dropped. */
    private generation = 0;
    private pollTimer: Timer | null = null;
    private polling = false;
    private disposed = false;

    constructor(deps: {
        request: (method: string, params: unknown) => Promise<unknown>;
        publish: (snapshot: CodexSubagentSnapshot) => void;
        now?: () => number;
        setTimer?: (fn: () => void, ms: number) => unknown;
        clearTimer?: (t: unknown) => void;
    }) {
        this.request = deps.request;
        this.publish = deps.publish;
        this.now = deps.now ?? (() => Date.now());
        // Unref'd: a pending poll or label wait never keeps the runtime process alive.
        this.setTimer = deps.setTimer ?? ((fn, ms) => {
            const timer = setTimeout(fn, ms);
            timer.unref?.();
            return timer;
        });
        this.clearTimer = deps.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
    }

    setAvailable(available: boolean): void {
        this.safely('setAvailable', undefined, () => {
            this.available = available === true;
            this.sync();
        });
    }

    setMainThread(threadId: string | null): void {
        this.safely('setMainThread', undefined, () => {
            this.reset();
            this.mainThreadId = id(threadId);
            if (this.mainThreadId) this.retired.delete(this.mainThreadId);
            this.sync();
        });
    }

    shouldDivert(threadId: string, mainThreadId: string | null): boolean {
        if (!id(threadId)) return false;
        return id(mainThreadId) ? threadId !== mainThreadId : this.children.has(threadId) || this.retired.has(threadId);
    }

    observeOtherThread(method: string, params: unknown): void {
        this.safely('observeOtherThread', undefined, () => {
            const message = record(params);
            // Same precedence as the client's `extractThreadId`.
            const threadId = id(record(message?.thread)?.id ?? message?.threadId ?? message?.thread_id);
            const child = threadId ? this.ensure(threadId) : null;
            if (!threadId || !child) return;
            if (method === 'thread/status/changed') this.apply(child, record(message?.status)?.type, STATES, true);
            else if (method === 'item/completed' && this.isTracked(threadId)) this.observeItem(threadId, message?.item);
            else this.apply(child, method, NOTIFICATIONS, true);
            this.sync();
        });
    }

    observeMainItem(method: 'item/started' | 'item/completed', item: unknown, turnId: string | null): CodexSubagentSpawn | null {
        return this.safely('observeMainItem', null, () => {
            if (method !== 'item/completed' || !this.mainThreadId) return null;
            const threadId = this.observeItem(this.mainThreadId, item);
            const child = threadId ? this.children.get(threadId) : undefined;
            const callId = id(record(item)?.id);
            let spawn: CodexSubagentSpawn | null = null;
            if (threadId && child && callId && !child.spawned) {
                child.spawned = true;
                spawn = { callId, threadId, turnId: id(turnId), label: formatCodexAgentLabel(child) };
            }
            this.sync();
            return spawn;
        });
    }

    /** The spawn row title: the label once `thread/read` settles, or the fallback label after `timeoutMs`. */
    awaitLabel(threadId: string, timeoutMs: number): Promise<string> {
        return new Promise(resolve => {
            const child = this.children.get(threadId);
            if (!child || child.classified) return resolve(formatCodexAgentLabel(child ?? {}));
            const waiter: Waiter = { child, resolve, timer: null };
            this.waiters.add(waiter);
            waiter.timer = this.after(timeoutMs, () => this.settle(waiter));
            if (!waiter.timer) this.settle(waiter);
        });
    }

    invalidate(): void {
        this.safely('invalidate', undefined, () => {
            this.reset();
            this.sync();
        });
    }

    get running(): ReadonlyArray<{ threadId: string; label: string }> {
        return this.shown().map(([threadId, child]) => ({ threadId, label: formatCodexAgentLabel(child) }));
    }

    /** Stops every timer and read for good; nothing is published afterwards. */
    dispose(): void {
        this.safely('dispose', undefined, () => {
            this.disposed = true;
            this.reset();
        });
    }

    private safely<T>(what: string, fallback: T, run: () => T): T {
        try {
            return run();
        } catch (error) {
            logger.debug(`[CodexSubagents] ${what} failed`, { error: String(error) });
            return fallback;
        }
    }

    /** Listed children, first seen first, at most 50 (Desktop's limit). */
    private shown(): Array<[string, Child]> {
        const listed = [...this.children].filter(([threadId, child]) => (child.classified || child.listing === 'open') && this.listable(threadId, child));
        return listed.slice(0, MAX_TASKS);
    }

    private listable(threadId: string, child: Child): boolean {
        return child.running && !child.gone && this.isTracked(threadId);
    }

    /** Every thread up to the main one is known and not internal: classified, or named by a spawn item while its read is
     *  pending. Derived, so a grandchild answered before its parent follows the parent's classification. */
    isTracked(threadId: string): boolean {
        const seen = new Set<string>();
        for (let current: string | null = threadId; current && !seen.has(current);) {
            seen.add(current);
            const child = this.children.get(current);
            if (!child || child.internal || (!child.classified && !child.spawnedBy)) return false;
            current = child.parentId ?? child.spawnedBy;
            if (current && current === this.mainThreadId) return true;
        }
        return false;
    }

    /** The child `threadId` names, created on first sight; null for the main thread and retired ids. */
    private ensure(threadId: string): Child | null {
        if (this.disposed || !this.mainThreadId || threadId === this.mainThreadId || this.retired.has(threadId)) return null;
        let child = this.children.get(threadId);
        if (!child) {
            child = {
                classified: false, internal: false, parentId: null, spawnedBy: null, nickname: null, role: null, agentPath: null,
                running: false, gone: false, listing: 'new', spawned: false, seq: 0,
            };
            this.children.set(threadId, child);
            this.unread.set(threadId, child);
        }
        return child;
    }

    /** Spawn evidence and running-state inputs of a sub-agent item `reporter` sent; returns the child whose spawn it confirms. */
    private observeItem(reporter: string, value: unknown): string | null {
        const item = record(value);
        if (item?.type === 'subAgentActivity') {
            const threadId = id(item.agentThreadId);
            if (!threadId) return null;
            const started = item.kind === 'started';
            const child = started ? this.ensure(threadId) : this.children.get(threadId);
            if (!child) return null;
            if (started) child.spawnedBy ??= reporter;
            child.agentPath ??= text(item.agentPath);
            this.apply(child, item.kind, STATES);
            return started ? threadId : null;
        }
        if (item?.type !== 'collabAgentToolCall') return null;
        const receivers = (Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []).map(id).filter(threadId => threadId !== null);
        const spawn = item.tool === 'spawnAgent';
        for (const threadId of spawn ? receivers : []) {
            const child = this.ensure(threadId);
            if (child) child.spawnedBy ??= reporter;
        }
        for (const [threadId, state] of Object.entries(record(item.agentsStates) ?? {})) {
            this.apply(this.children.get(threadId), record(state)?.status, STATES);
        }
        return spawn && item.status === 'completed' ? receivers.find(threadId => this.children.has(threadId)) ?? null : null;
    }

    /** One row of the running-state table; `own` marks a notification of the child thread itself. */
    private apply(child: Child | undefined, input: unknown, inputs: ReadonlyMap<string, Transition>, own = false): void {
        const next = typeof input === 'string' ? inputs.get(input) : undefined;
        if (!child || !next) return;
        child.seq++;
        child.running = next === 'run';
        if (next === 'close') child.gone = true;
        else if (own && next === 'run') child.gone = false;
    }

    /** `thread/read` of one thread; null when it failed or answered something else. Never rejects. */
    private async read(threadId: string): Promise<ThreadRead | null> {
        try {
            const thread = readThread(await this.request('thread/read', { threadId, includeTurns: false }));
            if (!thread) logger.debug('[CodexSubagents] Ignoring a malformed thread/read answer', { threadId });
            return thread;
        } catch (error) {
            logger.debug('[CodexSubagents] thread/read failed', { threadId, error: String(error) });
            return null;
        }
    }

    /** Takes the labels of a `thread/read` answer, and its status unless a newer input arrived after `seq`. */
    private absorb(child: Child, thread: ThreadRead, seq: number): void {
        child.nickname = thread.nickname ?? child.nickname;
        child.role = thread.role ?? child.role;
        child.agentPath = thread.agentPath ?? child.agentPath;
        if (child.seq === seq) this.apply(child, thread.status, STATES);
    }

    /** One retry 2 s after a failed read; after that, only spawn evidence can show the child. */
    private async classify(threadId: string, child: Child, attempt: number): Promise<void> {
        const generation = this.generation;
        const seq = child.seq;
        const thread = await this.read(threadId);
        if (generation !== this.generation) return;
        if (!thread && attempt === 1) {
            const retry = this.after(READ_RETRY_DELAY_MS, () => this.background('Classification', this.classify(threadId, child, 2)));
            if (retry) {
                // The retry lands after any label wait, so waiting on cannot improve the label; the spawn row
                // must not outlast its parent turn waiting for it.
                for (const waiter of this.waiters) if (waiter.child === child) this.settle(waiter);
                return;
            }
        }
        if (thread) {
            child.parentId = thread.parentId;
            child.internal = thread.internal;
            this.absorb(child, thread, seq);
        }
        child.classified = true;
        for (const waiter of this.waiters) if (waiter.child === child) this.settle(waiter);
        this.sync();
    }

    /** Re-reads the shown children one at a time; the next round is scheduled by `sync` while any still runs. */
    private async poll(): Promise<void> {
        const generation = this.generation;
        this.polling = true;
        for (const [threadId, child] of this.shown()) {
            const seq = child.seq;
            const thread = await this.read(threadId);
            if (generation !== this.generation) return;
            if (thread) this.absorb(child, thread, seq);
        }
        this.polling = false;
        this.sync();
    }

    /** Fire-and-forget work: a failure is logged, never an unhandled rejection. */
    private background(what: string, work: Promise<void>): void {
        work.catch(error => logger.debug(`[CodexSubagents] ${what} failed`, { error: String(error) }));
    }

    private settle(waiter: Waiter): void {
        this.waiters.delete(waiter);
        if (waiter.timer) this.cancel(waiter.timer);
        waiter.resolve(formatCodexAgentLabel(waiter.child));
    }

    /** Forgets every child (retiring its id), pending reads, timers and label waits. */
    private reset(): void {
        this.generation++;
        for (const waiter of this.waiters) this.settle(waiter);
        for (const timer of this.timers) this.cancel(timer);
        this.pollTimer = null;
        this.polling = false;
        for (const threadId of this.children.keys()) this.retired.add(threadId);
        this.children.clear();
        this.unread.clear();
    }

    /** Runs `fn` once after `ms`; null when no timer could be set. */
    private after(ms: number, fn: () => void): Timer | null {
        const timer: Timer = { handle: null };
        this.timers.add(timer);
        try {
            timer.handle = this.setTimer(() => {
                if (this.timers.delete(timer)) this.safely('Timer', undefined, fn);
            }, ms);
            return timer;
        } catch (error) {
            this.timers.delete(timer);
            logger.debug('[CodexSubagents] Could not set a timer', { error: String(error) });
            return null;
        }
    }

    private cancel(timer: Timer): void {
        if (this.timers.delete(timer)) this.safely('clearTimer', undefined, () => this.clearTimer(timer.handle));
    }

    /** Starts reads for new children, polls while any child is shown, and publishes the shown list when it changed. */
    private sync(): void {
        if (this.disposed) return;
        for (const [threadId, child] of this.unread) this.background('Classification', this.classify(threadId, child, 1));
        this.unread.clear();
        for (const [threadId, child] of this.children) {
            if (child.classified || child.listing !== 'new' || !this.listable(threadId, child)) continue;
            child.listing = 'held';
            this.background('First listing', this.awaitLabel(threadId, FIRST_LISTING_WAIT_MS).then(() => {
                child.listing = 'open';
                this.sync();
            }));
        }
        const running = this.running;
        if (running.length && !this.pollTimer && !this.polling) {
            this.pollTimer = this.after(POLL_INTERVAL_MS, () => {
                this.pollTimer = null;
                this.background('Reconciliation', this.poll());
            });
        } else if (!running.length && this.pollTimer) {
            this.cancel(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.available === null) return;
        const tasks = this.available ? running.map(({ threadId, label }) => ({ taskId: threadId, label, kind: 'agent' as const })) : null;
        const key = JSON.stringify([this.available, tasks]);
        if (key === this.publishedKey) return;
        try {
            this.startedAt ??= this.now();
            this.publish({ startedAt: this.startedAt, available: this.available, tasks });
            this.publishedKey = key;
        } catch (error) {
            logger.warn('[CodexSubagents] Publishing the sub-agent list failed', { error: String(error) });
        }
    }
}

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function id(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function text(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The fields of a `thread/read` answer this tracker uses (`subAgent` is camelCase, `thread_spawn` snake_case). */
function readThread(result: unknown): ThreadRead | null {
    const thread = record(record(result)?.thread);
    if (!thread) return null;
    const subAgent = record(thread.source)?.subAgent;
    const spawn = record(record(subAgent)?.thread_spawn);
    return {
        parentId: id(spawn?.parent_thread_id) ?? id(thread.parentThreadId),
        // "review" | "compact" | "memory_consolidation" | {other}: Codex's own helper threads, not spawned agents.
        internal: subAgent != null && !spawn,
        nickname: text(thread.agentNickname) ?? text(spawn?.agent_nickname),
        role: text(thread.agentRole) ?? text(spawn?.agent_role),
        agentPath: text(spawn?.agent_path),
        status: id(record(thread.status)?.type),
    };
}

/**
 * Codex TUI `format_agent_picker_item_name` (trimmed `nickname [role]`, `nickname`, `[role]`, `Agent`), with the
 * last segment of a V2 agent path (`/root/ok_reply` → `ok_reply`) before a bare role. At most 200 UTF-16 units.
 */
export function formatCodexAgentLabel(input: { nickname?: string | null; role?: string | null; agentPath?: string | null }): string {
    const nickname = text(input?.nickname);
    const role = text(input?.role);
    const pathName = text(text(input?.agentPath)?.split('/').filter(part => part.trim()).pop());
    const label = nickname && role ? `${nickname} [${role}]` : nickname ?? pathName ?? (role ? `[${role}]` : 'Agent');
    if (label.length <= MAX_LABEL_LENGTH) return label;
    const cut = label.slice(0, MAX_LABEL_LENGTH);
    return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}
