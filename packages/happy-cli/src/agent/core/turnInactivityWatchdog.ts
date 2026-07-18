/**
 * Inactivity watchdog for agent turns.
 *
 * Bounds how long a turn may go *without any backend progress*, rather than how
 * long the turn may run in total. A turn that keeps reporting progress runs
 * without a wall-clock limit; only a silent backend is reported as inactive.
 *
 * The watchdog stays disarmed while an approval request is awaiting the user,
 * because such a turn is waiting on the human rather than hanging.
 */

export interface TurnInactivityWatchdog {
    /** Backend reported progress — restart the inactivity window. */
    recordActivity(): void;
    /** An approval request is now awaiting the user — disarm. */
    holdForApproval(): void;
    /** An approval was answered — re-arm with a full window once none remain. */
    releaseApproval(): void;
    /** Turn settled (or the runner is shutting down) — disarm permanently. */
    stop(): void;
}

export function startTurnInactivityWatchdog(opts: {
    timeoutMs: number;
    onInactive: () => void;
}): TurnInactivityWatchdog {
    let timer: NodeJS.Timeout | null = null;
    let outstandingApprovals = 0;
    let finished = false;

    const arm = (): void => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        if (finished || outstandingApprovals > 0) return;
        timer = setTimeout(() => {
            timer = null;
            finished = true;
            opts.onInactive();
        }, opts.timeoutMs);
    };

    arm();

    return {
        recordActivity: arm,
        holdForApproval: () => {
            outstandingApprovals += 1;
            arm();
        },
        releaseApproval: () => {
            outstandingApprovals = Math.max(0, outstandingApprovals - 1);
            arm();
        },
        stop: () => {
            finished = true;
            arm();
        },
    };
}
