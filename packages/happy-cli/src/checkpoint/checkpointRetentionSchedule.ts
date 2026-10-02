/** Startup check and daily cleanup piggyback on the daemon heartbeat; no second interval. */
export class CheckpointRetentionSchedule {
    private lastSuccess: number | null = null;
    private running: Promise<void> | null = null;
    private stopped = false;
    constructor(private readonly input: {
        collect(now: number): Promise<unknown>;
        isIdle(): boolean;
        now?: () => number;
        onError(error: unknown): void;
    }) {}

    tick(): Promise<void> {
        const now = this.input.now?.() ?? Date.now();
        if (this.stopped || this.running || !this.input.isIdle()
            || (this.lastSuccess !== null && now - this.lastSuccess < 86400_000)) return Promise.resolve();
        const work = Promise.resolve().then(() => this.input.collect(now)).then(
            () => { this.lastSuccess = now; },
            error => { this.input.onError(error); },
        );
        this.running = work;
        return work.finally(() => { if (this.running === work) this.running = null; });
    }

    async stop(): Promise<void> {
        this.stopped = true;
        await this.running;
    }
}
