/** Bounded runtime completion identities, independent of transcript display IDs and witness history. */
type CompletionRecord = {
    task: string;
    phase: 'started' | 'observed' | 'settled';
    status?: string;
    turn?: string;
};
type CompletionDecision = 'first' | 'next' | 'duplicate' | 'uncertain';
type CompletionIds = { taskId?: string; toolUseId?: string };
type LaunchIdentity = CompletionIds & {
    canonical: string;
    runId?: string;
    startedRun?: string | null;
    generation?: string;
    ambiguous: boolean;
    observed: boolean;
    receiptShape?: string;
};

export const BACKGROUND_HISTORY_LIMIT = 1000;

export class BackgroundCompletionTracker {
    // One fixed-size record per run: neither task count nor a task's run count can grow unbounded.
    readonly entries = new Map<string, CompletionRecord>();
    // Scoped task/tool aliases share sticky history, independently of consumed launch mappings.
    // Eviction cannot restore uniqueness: losing either bounded ledger sets historyLost.
    readonly aliases = new Map<string, LaunchIdentity>();
    historyLost = false;

    private link(ids: CompletionIds, run: string | null, scope?: string): LaunchIdentity | null {
        if (Buffer.byteLength(JSON.stringify([scope, ids, run]), 'utf8') > 4096) {
            this.historyLost = true;
            return null;
        }
        const keys = [ids.taskId ? `task:${ids.taskId}` : undefined, ids.toolUseId ? `tool:${ids.toolUseId}` : undefined]
            .filter((id): id is string => Boolean(id)).map(id => JSON.stringify([scope ?? null, id]));
        if (!keys.length) return null;
        const known = [...new Set(keys.map(key => this.aliases.get(key)).filter((entry): entry is LaunchIdentity => !!entry))];
        const identity: LaunchIdentity = known[0] ?? { taskId: ids.taskId, toolUseId: ids.toolUseId,
            canonical: ids.taskId ? `task:${ids.taskId}` : `tool:${ids.toolUseId}`,
            ambiguous: false, observed: false };
        // Joining previously separate histories is ambiguous, never a fresh observation.
        for (const previous of known.slice(1)) {
            identity.ambiguous = true;
            identity.observed ||= previous.observed;
            for (const [key, value] of this.aliases) if (value === previous) this.aliases.set(key, identity);
        }
        if ((identity.taskId && ids.taskId && identity.taskId !== ids.taskId)
            || (identity.toolUseId && ids.toolUseId && identity.toolUseId !== ids.toolUseId)
            || (identity.runId && run && identity.runId !== run)) identity.ambiguous = true;
        identity.taskId ??= ids.taskId;
        identity.toolUseId ??= ids.toolUseId;
        if (run && (!identity.runId || run > identity.runId)) identity.runId = run;
        for (const key of keys) this.aliases.set(key, identity);
        while (this.aliases.size > 2 * BACKGROUND_HISTORY_LIMIT) {
            this.aliases.delete(this.aliases.keys().next().value!);
            this.historyLost = true;
        }
        return identity;
    }

    launch(ids: CompletionIds, run: string | null, scope?: string, generation?: string): void {
        const identity = this.link(ids, run, scope);
        if (!identity) return;
        if ((identity.observed && (!run || run !== identity.runId))
            || (identity.generation && generation && identity.generation !== generation)) identity.ambiguous = true;
        identity.generation ??= generation;
    }

    completion(ids: CompletionIds, run: string | null, status: string | undefined, turn: string | null, scope?: string)
        : { decision: CompletionDecision; unique: boolean } {
        if (this.historyLost) return { decision: 'uncertain', unique: false };
        const identity = this.link(ids, run, scope);
        if (!identity || this.historyLost) return { decision: 'uncertain', unique: false };
        const shape = ids.taskId ? ids.toolUseId ? 'task+tool' : 'task' : 'tool';
        if (identity.receiptShape && identity.receiptShape !== shape) identity.ambiguous = true;
        identity.receiptShape = shape;
        if (!status) identity.ambiguous = true;
        const unique = !!status && !this.historyLost && !identity.ambiguous && !identity.observed;
        const canonical = ids.taskId ? `task:${ids.taskId}` : identity.canonical;
        const decision = status ? this.observe(canonical, run, status, turn, scope) : 'uncertain';
        identity.observed = true;
        return { decision, unique: unique && !this.historyLost };
    }

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
        while (this.entries.size > BACKGROUND_HISTORY_LIMIT) {
            this.entries.delete(this.entries.keys().next().value!);
            // Any loss permanently disables background routing, including exact run matches.
            this.historyLost = true;
        }
    }

    started(ids: CompletionIds, run: string | null, scope?: string): void {
        this.launch(ids, run, scope);
        const linked = this.link(ids, run, scope);
        if (linked) {
            // A second unidentified/different start cannot establish a unique legacy run.
            if (linked.startedRun !== undefined && (run === null || linked.startedRun !== run)) linked.ambiguous = true;
            if (linked.startedRun === undefined) linked.startedRun = run;
        }
        const canonical = ids.taskId ? `task:${ids.taskId}` : linked?.canonical;
        const identity = canonical ? this.identity(canonical, run, scope) : null;
        if (identity && !this.entries.has(identity.key)) {
            this.remember(identity.key, { task: identity.task, phase: 'started' });
        }
    }

    private observe(task: string, run: string | null, status: string, turn: string | null, scope?: string): CompletionDecision {
        const identity = this.identity(task, run, scope);
        if (!identity) return 'uncertain';
        const previous = this.entries.get(identity.key);
        // Only an explicit shared run ID proves equality. A missing source is not identity.
        if (run !== null && previous?.status === status) return 'duplicate';
        const related = [...this.entries.values()].filter(record => record.task === identity.task);
        const consumed = related.some(record => record.phase !== 'started');
        const legacy = this.entries.get(JSON.stringify([scope ?? null, task, null]));
        const uncertain = previous?.status !== undefined
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
