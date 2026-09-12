/**
 * The two turn shapes that never reach `nextMessage()`.
 *
 * Every case here is a way a provider that was killed could be recorded as one
 * that finished on its own.
 */
import { describe, expect, it } from 'vitest';

import { endManagedTurnInput } from './managedGracefulStop';

function harness(over: { exitsAfter?: number } = {}) {
    const events: string[] = [];
    let ticks = 0;
    return {
        events,
        run: (budgetMs: number) => endManagedTurnInput({
            endInput: () => { events.push('end-input'); },
            exitedCleanly: () => over.exitsAfter !== undefined && ticks >= over.exitsAfter,
            forceClose: async () => { events.push('force-close'); },
            budgetMs,
            // Deterministic: no real time passes, and the clock only moves
            // when the code actually waits.
            wait: async () => { ticks += 1; },
            now: () => ticks * 25,
        }),
    };
}

describe('endManagedTurnInput', () => {
    it('shouldEndInputAndLetTheProviderLeaveOnItsOwn', async () => {
        const { run, events } = harness({ exitsAfter: 2 });
        expect(await run(1_000)).toEqual({ exhausted: true, forced: false });
        // It ended the input and never reached for the kill.
        expect(events).toEqual(['end-input']);
    });

    it('shouldEndInputBeforeWaitingForAnything', async () => {
        // A provider that is never told its input ended has no reason to
        // leave, and the wait would always run out.
        const { run, events } = harness({ exitsAfter: 0 });
        await run(1_000);
        expect(events[0]).toBe('end-input');
    });

    it('shouldFallBackToTheForcedCloseWhenTheProviderStays', async () => {
        const { run, events } = harness();
        expect(await run(100)).toEqual({ exhausted: true, forced: true });
        expect(events).toEqual(['end-input', 'force-close']);
    });

    it('shouldReportTheForcedCloseRatherThanHidingItBehindTheEndedInput', async () => {
        /*
         * `exhausted` stays true because the input really did end — but the
         * close is a kill, and a killed provider did not flush. The gate has
         * to be able to tell these apart, so `forced` is separate.
         */
        const { run } = harness();
        const outcome = await run(50);
        expect(outcome.exhausted).toBe(true);
        expect(outcome.forced).toBe(true);
    });

    it('shouldNotForceAnExitThatLandsInTheFinalGap', async () => {
        /*
         * The provider leaves in the same moment the budget runs out. Killing
         * it then would turn a clean exit into a forced one for no reason but
         * timing — so there is one last look after the loop.
         *
         * The budget allows exactly one poll: `exitsAfter: 1` is false at that
         * poll and true at the look afterwards.
         */
        const { run, events } = harness({ exitsAfter: 1 });
        expect(await run(25)).toEqual({ exhausted: true, forced: false });
        expect(events).toEqual(['end-input']);
    });
});
