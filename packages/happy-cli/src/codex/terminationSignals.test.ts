import { describe, expect, it, vi } from 'vitest';
import { createTerminationSignalHandler } from './terminationSignals';

/**
 * The daemon stops sessions by sending SIGTERM (daemon/run.ts) — the idle
 * reaper, `stop-session` RPC and Ctrl-C all land here. It never escalates to
 * SIGKILL, so this handler is solely responsible for both draining the session
 * and making sure the process actually leaves.
 */
describe('createTerminationSignalHandler', () => {
    it('drains the session without stamping it archived', async () => {
        const terminate = vi.fn().mockResolvedValue(undefined);
        const forceExit = vi.fn();

        const handler = createTerminationSignalHandler({ terminate, forceExit });
        await handler('SIGTERM');

        // stampArchive:false — a signalled exit means "I'll come back to this
        // session later", so it must stay resumable instead of being archived.
        expect(terminate).toHaveBeenCalledWith({ stampArchive: false });
    });

    it('ignores a second signal while the first drain is still in flight', async () => {
        let releaseTerminate: () => void = () => {};
        const terminate = vi.fn(() => new Promise<void>((resolve) => { releaseTerminate = resolve; }));
        const forceExit = vi.fn();

        const handler = createTerminationSignalHandler({ terminate, forceExit });
        const first = handler('SIGTERM');
        await handler('SIGTERM');

        // A repeated signal must not start a second drain — that would send
        // sessionDeath twice and flush a session that is already closing.
        expect(terminate).toHaveBeenCalledTimes(1);

        releaseTerminate();
        await first;
    });

    it('force-exits when the drain outlives the grace period', async () => {
        vi.useFakeTimers();
        try {
            const terminate = vi.fn(() => new Promise<void>(() => {}));
            const forceExit = vi.fn();

            const handler = createTerminationSignalHandler({
                terminate,
                forceExit,
                graceMs: 5000,
            });
            void handler('SIGTERM');

            expect(forceExit).not.toHaveBeenCalled();

            // The daemon sends no SIGKILL fallback, so a drain that hangs (a
            // codex turn that will not abort) would otherwise leak the process
            // forever and keep the session pinned as live.
            await vi.advanceTimersByTimeAsync(5000);
            expect(forceExit).toHaveBeenCalledWith(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('still exits when the drain throws', async () => {
        const terminate = vi.fn().mockRejectedValue(new Error('socket already gone'));
        const forceExit = vi.fn();

        const handler = createTerminationSignalHandler({ terminate, forceExit });
        await handler('SIGTERM');

        // A failed drain must not leave the process parked: the daemon has
        // already dropped this session from tracking.
        expect(forceExit).toHaveBeenCalledWith(1);
    });

    it('does not force-exit after a drain that completes in time', async () => {
        vi.useFakeTimers();
        try {
            const terminate = vi.fn().mockResolvedValue(undefined);
            const forceExit = vi.fn();

            const handler = createTerminationSignalHandler({
                terminate,
                forceExit,
                graceMs: 5000,
            });
            await handler('SIGTERM');

            // terminate() is expected to exit the process itself; the watchdog
            // timer must be cleared so it cannot fire a bogus exit afterwards.
            await vi.advanceTimersByTimeAsync(10000);
            expect(forceExit).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});
