import { logger } from '@/ui/logger';

export type CodexBackgroundTask = {
    callId: string;
    command: string;
    processId?: string;
    status: 'running' | 'unknown';
    /** When this runtime first saw it (aplus-dev-studio-desktop specs/agent-background-work-panel R1). */
    startedAt?: number;
};

/** A full runtime snapshot, never a guess based on elapsed wall-clock time. */
export class CodexBackgroundTasks {
    private tasks = new Map<string, CodexBackgroundTask>();
    private generation = 0;
    private completed = new Set<string>();
    private snapshotConfirmed = false;

    constructor(
        private readonly request: (method: string, params: unknown) => Promise<unknown>,
        private readonly publish: (tasks: CodexBackgroundTask[]) => void,
        private readonly now: () => number = Date.now,
    ) {}

    get hasTasks(): boolean { return this.tasks.size > 0; }
    /** The listed terminal with this call id, for a stop by its process id. */
    get(callId: string): CodexBackgroundTask | undefined { return this.tasks.get(callId); }
    /** An empty UI list on a failed/unsupported read is never writer quiescence. */
    get confirmedEmpty(): boolean { return this.snapshotConfirmed && this.tasks.size === 0; }

    restore(tasks: CodexBackgroundTask[]): void {
        this.generation++;
        this.snapshotConfirmed = false;
        this.tasks = new Map(tasks.map(task => [task.callId, { ...task, status: 'unknown' }]));
        if (this.hasTasks) this.publish([...this.tasks.values()]);
    }

    complete(callId: string): void {
        this.completed.add(callId);
        if (this.tasks.delete(callId)) this.publish([...this.tasks.values()]);
    }

    invalidate(): void {
        this.generation++;
        this.snapshotConfirmed = false;
        for (const [id, task] of this.tasks) this.tasks.set(id, { ...task, status: 'unknown' });
        if (this.hasTasks) this.publish([...this.tasks.values()]);
    }

    async refresh(threadId: string, candidates: Array<{ callId: string; command: string }> = []): Promise<void> {
        const generation = ++this.generation;
        this.snapshotConfirmed = false;
        for (const task of candidates) {
            if (!this.completed.has(task.callId)) {
                this.tasks.set(task.callId, { ...task, status: 'unknown', startedAt: this.tasks.get(task.callId)?.startedAt ?? this.now() });
            }
        }
        const completedDuringRead = this.completed;
        const next = new Map<string, CodexBackgroundTask>();
        try {
            let cursor: string | undefined;
            const seen = new Set<string>();
            do {
                const result = await this.request('thread/backgroundTerminals/list', {
                    threadId, ...(cursor ? { cursor } : {}),
                }) as { data?: unknown; nextCursor?: unknown } | null;
                if (!result || !Array.isArray(result.data)) throw new Error('Invalid background terminal list');
                for (const row of result.data) {
                    if (!row || typeof row.itemId !== 'string' || !row.itemId
                        || typeof row.processId !== 'string' || typeof row.command !== 'string') {
                        throw new Error('Invalid background terminal entry');
                    }
                    next.set(row.itemId, {
                        callId: row.itemId, command: row.command, processId: row.processId, status: 'running',
                        startedAt: this.tasks.get(row.itemId)?.startedAt ?? this.now(),
                    });
                }
                if (result.nextCursor != null && typeof result.nextCursor !== 'string') throw new Error('Invalid background terminal cursor');
                cursor = result.nextCursor || undefined;
                if (cursor && seen.has(cursor)) throw new Error('Repeated background terminal cursor');
                if (cursor) seen.add(cursor);
            } while (cursor);
            if (generation !== this.generation) return;
            for (const id of completedDuringRead) next.delete(id);
            this.tasks = next;
            this.snapshotConfirmed = true;
            // Retain tombstones through this read, then allow the next fresh snapshot.
            this.completed = new Set();
        } catch (error) {
            if (generation !== this.generation) return;
            logger.debug('[Codex] Background terminal status unavailable', { error: String(error) });
            for (const [id, task] of this.tasks) this.tasks.set(id, { ...task, status: 'unknown' });
        }
        this.publish([...this.tasks.values()]);
    }
}
