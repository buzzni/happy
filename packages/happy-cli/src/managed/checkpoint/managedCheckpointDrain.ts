/**
 * Stops writes while a checkpoint is being taken, and lets them go again.
 *
 * A checkpoint that archives a tree the agent is still writing to captures a
 * moment that never existed: half of one tool's output, a database mid-commit.
 * Plan §7 puts draining first in the sequence for that reason, and the drain
 * has to be real — a flag nobody consults would make the ordering decorative.
 *
 * Two rules make it safe to hold:
 *
 *  - **A drain always ends.** If in-flight work does not finish inside the
 *    budget, the gate opens anyway and the drain fails. Blocking the agent
 *    forever is a worse outcome than a checkpoint that did not happen, and a
 *    long-running tool call is a normal thing to be waiting on.
 *  - **Reads are never blocked.** Only writes are, so a drained runtime can
 *    still answer questions rather than appearing hung.
 */
export class CheckpointDrainRefusal extends Error {
    constructor(readonly code: 'drain-in-progress' | 'drain-timeout') {
        super(`managed checkpoint drain: ${code}`);
        this.name = 'CheckpointDrainRefusal';
    }
}

export type CheckpointDrain = {
    /**
     * Admits one write and returns its completion callback. Throws while a
     * drain is in progress — the caller turns that into a refusal the agent
     * can retry, not a lost write.
     */
    beginWrite(): () => void;
    /** Refuses new writes and resolves once in-flight ones have finished. */
    drain(budgetMs: number): Promise<{ release: () => void }>;
    inFlight(): number;
    isDraining(): boolean;
};

export function createCheckpointDrain(deps?: {
    setTimer?: (run: () => void, ms: number) => { cancel: () => void };
}): CheckpointDrain {
    const setTimer = deps?.setTimer ?? ((run, ms) => {
        const handle = setTimeout(run, ms);
        return { cancel: () => clearTimeout(handle) };
    });
    let inFlight = 0;
    let draining = false;
    let notifyIdle: (() => void) | null = null;

    const settle = (): void => {
        if (inFlight === 0 && notifyIdle) {
            const notify = notifyIdle;
            notifyIdle = null;
            notify();
        }
    };

    return {
        beginWrite() {
            if (draining) throw new CheckpointDrainRefusal('drain-in-progress');
            inFlight += 1;
            let done = false;
            return () => {
                // Idempotent: a caller that reports completion twice must not
                // drive the count below zero and release a drain early.
                if (done) return;
                done = true;
                inFlight -= 1;
                settle();
            };
        },
        async drain(budgetMs: number) {
            if (draining) throw new CheckpointDrainRefusal('drain-in-progress');
            draining = true;
            const release = (): void => { draining = false; };
            if (inFlight === 0) return { release };

            // Declared as the union rather than inferred: the assignment
            // happens inside the executor, which the compiler cannot see
            // running, so an inferred `null` narrows this to `never`.
            let timer: { cancel: () => void } | undefined;
            try {
                await new Promise<void>((resolve, reject) => {
                    notifyIdle = resolve;
                    timer = setTimer(() => {
                        notifyIdle = null;
                        reject(new CheckpointDrainRefusal('drain-timeout'));
                    }, budgetMs);
                });
            } catch (error) {
                // The gate opens on the way out of a failed drain, so a
                // checkpoint that could not start does not leave the agent
                // unable to write.
                release();
                throw error;
            } finally {
                timer?.cancel();
            }
            return { release };
        },
        inFlight: () => inFlight,
        isDraining: () => draining,
    };
}
