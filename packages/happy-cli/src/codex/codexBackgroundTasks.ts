import { logger } from '@/ui/logger';

export type CodexBackgroundTask = {
    callId: string;
    command: string;
    processId?: string;
    status: 'running' | 'unknown';
};

/** A full runtime snapshot, never a guess based on elapsed wall-clock time. */
export class CodexBackgroundTasks {
    private tasks = new Map<string, CodexBackgroundTask>();
    private generation = 0;
    private completed = new Set<string>();

    constructor(
        private readonly request: (method: string, params: unknown) => Promise<unknown>,
        private readonly publish: (tasks: CodexBackgroundTask[]) => void,
    ) {}

    get hasTasks(): boolean { return this.tasks.size > 0; }

    restore(tasks: CodexBackgroundTask[]): void {
        this.tasks = new Map(tasks.map(task => [task.callId, { ...task, status: 'unknown' }]));
        if (this.hasTasks) this.publish([...this.tasks.values()]);
    }

    complete(callId: string): void {
        this.completed.add(callId);
        if (this.tasks.delete(callId)) this.publish([...this.tasks.values()]);
    }

    invalidate(): void {
        this.generation++;
        for (const [id, task] of this.tasks) this.tasks.set(id, { ...task, status: 'unknown' });
        if (this.hasTasks) this.publish([...this.tasks.values()]);
    }

    async refresh(threadId: string, candidates: Array<{ callId: string; command: string }> = []): Promise<void> {
        const generation = ++this.generation;
        for (const task of candidates) {
            if (!this.completed.has(task.callId)) this.tasks.set(task.callId, { ...task, status: 'unknown' });
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
                    next.set(row.itemId, { callId: row.itemId, command: row.command, processId: row.processId, status: 'running' });
                }
                if (result.nextCursor != null && typeof result.nextCursor !== 'string') throw new Error('Invalid background terminal cursor');
                cursor = result.nextCursor || undefined;
                if (cursor && seen.has(cursor)) throw new Error('Repeated background terminal cursor');
                if (cursor) seen.add(cursor);
            } while (cursor);
            if (generation !== this.generation) return;
            for (const id of completedDuringRead) next.delete(id);
            this.tasks = next;
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
