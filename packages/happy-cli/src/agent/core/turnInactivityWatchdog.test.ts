import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startTurnInactivityWatchdog } from './turnInactivityWatchdog';

describe('startTurnInactivityWatchdog', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('reports inactivity once the window elapses with no activity', () => {
        const onInactive = vi.fn();
        startTurnInactivityWatchdog({ timeoutMs: 1000, onInactive });

        vi.advanceTimersByTime(1000);

        expect(onInactive).toHaveBeenCalledTimes(1);
    });

    it('keeps a turn alive while the backend reports progress', () => {
        const onInactive = vi.fn();
        const watchdog = startTurnInactivityWatchdog({ timeoutMs: 1000, onInactive });

        for (let i = 0; i < 5; i++) {
            vi.advanceTimersByTime(900);
            watchdog.recordActivity();
        }
        vi.advanceTimersByTime(900);

        expect(onInactive).not.toHaveBeenCalled();
    });

    it('stays disarmed while an approval awaits the user', () => {
        const onInactive = vi.fn();
        const watchdog = startTurnInactivityWatchdog({ timeoutMs: 1000, onInactive });

        watchdog.holdForApproval();
        vi.advanceTimersByTime(60_000);

        expect(onInactive).not.toHaveBeenCalled();
    });

    it('re-arms with a full window once the approval is answered', () => {
        const onInactive = vi.fn();
        const watchdog = startTurnInactivityWatchdog({ timeoutMs: 1000, onInactive });

        watchdog.holdForApproval();
        vi.advanceTimersByTime(60_000);
        watchdog.releaseApproval();

        vi.advanceTimersByTime(999);
        expect(onInactive).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(onInactive).toHaveBeenCalledTimes(1);
    });

    it('stays disarmed until every outstanding approval is answered', () => {
        const onInactive = vi.fn();
        const watchdog = startTurnInactivityWatchdog({ timeoutMs: 1000, onInactive });

        watchdog.holdForApproval();
        watchdog.holdForApproval();
        watchdog.releaseApproval();
        vi.advanceTimersByTime(60_000);

        expect(onInactive).not.toHaveBeenCalled();
    });

    it('does not report inactivity after the turn is stopped', () => {
        const onInactive = vi.fn();
        const watchdog = startTurnInactivityWatchdog({ timeoutMs: 1000, onInactive });

        watchdog.stop();
        vi.advanceTimersByTime(60_000);

        expect(onInactive).not.toHaveBeenCalled();
    });

    it('reports inactivity at most once per turn', () => {
        const onInactive = vi.fn();
        const watchdog = startTurnInactivityWatchdog({ timeoutMs: 1000, onInactive });

        vi.advanceTimersByTime(1000);
        watchdog.recordActivity();
        vi.advanceTimersByTime(60_000);

        expect(onInactive).toHaveBeenCalledTimes(1);
    });
});
