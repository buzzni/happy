import { logger } from '@/ui/logger';

export interface TerminationSignalHandlerOptions {
    /** Drains the session (sessionDeath, flush, close, transport teardown) and exits. */
    terminate: (opts: { stampArchive: boolean }) => Promise<void>;
    /** Escape hatch used only when `terminate` hangs or throws. */
    forceExit: (code: number) => void;
    /** How long `terminate` may run before we exit anyway. */
    graceMs?: number;
}

/** Long enough for an idle session to flush, short enough to not leak a process. */
const DEFAULT_GRACE_MS = 5000;

/**
 * Builds the SIGTERM/SIGINT handler for a Codex session.
 *
 * The daemon stops sessions with a bare SIGTERM (daemon/run.ts) — the idle
 * reaper, the stop-session RPC and Ctrl-C all arrive this way — and it never
 * follows up with SIGKILL. Node's default disposition kills the process
 * instantly, so without a handler the drain in `handleKillSession` never runs.
 *
 * Because there is no SIGKILL fallback, this handler owns the deadline too: a
 * drain that cannot finish must still end the process rather than leave a
 * session pinned as live.
 */
export function createTerminationSignalHandler(
    opts: TerminationSignalHandlerOptions,
): (signal: string) => Promise<void> {
    const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    let terminating = false;

    return async (signal: string) => {
        if (terminating) {
            logger.debug(`[Codex] Ignoring ${signal} — termination already in progress`);
            return;
        }
        terminating = true;

        logger.debug(`[Codex] Received ${signal}, draining session before exit`);
        const watchdog = setTimeout(() => {
            logger.debug(`[Codex] Drain exceeded ${graceMs}ms after ${signal}, exiting anyway`);
            opts.forceExit(0);
        }, graceMs);
        // Never hold the event loop open on our own account.
        watchdog.unref?.();

        try {
            // stampArchive:false — a signalled exit means the session should stay
            // resumable, matching runClaude's `archive: false` on SIGTERM/SIGINT.
            await opts.terminate({ stampArchive: false });
        } catch (error) {
            logger.debug('[Codex] Drain failed during termination:', error);
            opts.forceExit(1);
        } finally {
            clearTimeout(watchdog);
        }
    };
}
