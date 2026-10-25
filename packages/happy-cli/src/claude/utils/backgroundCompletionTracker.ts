/** Bounded runtime completion identities, independent of transcript display IDs and witness history. */
type CompletionRecord = {
    task: string;
    phase: 'started' | 'observed' | 'settled';
    status?: string;
    turn?: string;
};
type CompletionDecision = 'first' | 'next' | 'duplicate' | 'uncertain';

export class BackgroundCompletionTracker {
    // One fixed-size record per run: neither task count nor a task's run count can grow unbounded.
    readonly entries = new Map<string, CompletionRecord>();
    historyLost = false;

    private identity(task: string, run: string | null, scope?: string): { task: string; key: string } | null {
        const taskKey = JSON.stringify([scope ?? null, task]);
        const key = JSON.stringify([scope ?? null, task, run]);
        if (Buffer.byteLength(key, 'utf8') > 4096) {
            this.historyLost = true;
            return null;
        }
        return { task: taskKey, key };
    }

    private remember(key: string, record: CompletionRecord): void {
        this.entries.set(key, record);
        while (this.entries.size > 200) {
            this.entries.delete(this.entries.keys().next().value!);
            // A cache miss can now be a late duplicate. Never turn that lack of proof into
            // a fresh exclusive continuation, even if the task's launch mapping survived.
            this.historyLost = true;
        }
    }

    started(task: string, run: string | null, scope?: string): void {
        const identity = this.identity(task, run, scope);
        if (identity && !this.entries.has(identity.key)) {
            this.remember(identity.key, { task: identity.task, phase: 'started' });
        }
    }

    observe(task: string, run: string | null, status: string, turn: string | null, scope?: string): CompletionDecision {
        const identity = this.identity(task, run, scope);
        if (!identity) return 'uncertain';
        const previous = this.entries.get(identity.key);
        // Only an explicit shared run ID proves equality. A missing source is not identity.
        if (run !== null && previous?.status === status) return 'duplicate';
        const related = [...this.entries.values()].filter(record => record.task === identity.task);
        const consumed = related.some(record => record.phase !== 'started');
        const legacy = this.entries.get(JSON.stringify([scope ?? null, task, null]));
        const uncertain = this.historyLost || previous?.status !== undefined
            || (run === null && related.length > 0)
            || (run !== null && legacy !== undefined);
        this.remember(identity.key, { task: identity.task, phase: 'observed', status, ...(turn ? { turn } : {}) });
        return uncertain ? 'uncertain' : consumed ? 'next' : 'first';
    }

    attachTurn(turn: string): void {
        for (const record of this.entries.values()) {
            if (record.phase === 'observed' && !record.turn) record.turn = turn;
        }
    }

    endTurn(turn: string): void {
        for (const record of this.entries.values()) {
            if (record.turn !== turn) continue;
            // Clear active ownership at turn end, retaining only a bounded identity tombstone.
            record.phase = 'settled';
            delete record.turn;
        }
    }
}
