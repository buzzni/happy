/**
 * The channel is the only authority that can end a managed run without killing
 * it, so every case here is a way it could act on something nobody sent.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import {
    assertDistinctManagedFds,
    MANAGED_CONTROL_CHILD_FD,
    managedStopRequest,
    readManagedControlChannel,
} from './managedControlChannel';
import { TRUSTED_RUNTIME_BOOTSTRAP_ENV } from '@/launcher/managedRuntimeBootstrapEnv';

function channel() {
    const source = new EventEmitter() as EventEmitter & { destroy?: () => void };
    let destroyed = false;
    source.destroy = () => { destroyed = true; };
    const stops: number[] = [];
    const cancel = readManagedControlChannel({
        source: source as never,
        onStop: () => { stops.push(1); },
    });
    return {
        send: (text: string) => source.emit('data', Buffer.from(text, 'utf8')),
        stops,
        cancel,
        destroyed: () => destroyed,
    };
}

const SLOTS = { bootstrap: 3, report: 4, control: MANAGED_CONTROL_CHILD_FD, status: 9, release: 8 };

describe('readManagedControlChannel', () => {
    it('shouldAskForAStopWhenTheSupervisorSendsOne', () => {
        const { send, stops } = channel();
        send(managedStopRequest());
        expect(stops.length).toBe(1);
    });

    it('shouldWaitForTheNewlineBeforeActingOnAVerb', () => {
        // A chunk boundary inside the word must not be read as the word, and
        // must not be lost either.
        const { send, stops } = channel();
        send('st');
        expect(stops).toEqual([]);
        send('op');
        expect(stops).toEqual([]);
        send('\n');
        expect(stops.length).toBe(1);
    });

    it('shouldIgnoreAVerbItDoesNotHave', () => {
        // A newer supervisor must not be able to make an older child act on
        // something it does not understand.
        const { send, stops } = channel();
        send('restart\nkill\n\n');
        expect(stops).toEqual([]);
    });

    it('shouldNotTreatTheChannelClosingAsAStop', () => {
        // The supervisor going away says nothing about whether this run should
        // end, and a run that ended on it would end on every restart.
        const { send, stops } = channel();
        send('');
        expect(stops).toEqual([]);
    });

    it('shouldActOnEachStopThatArrivesInOneChunk', () => {
        // Two verbs in one read is a framing question, not a deduplication
        // one — `request()` is idempotent on the other side.
        const { send, stops } = channel();
        send('stop\nstop\n');
        expect(stops.length).toBe(2);
    });

    it('shouldNotGrowWithoutBoundOnASenderThatNeverSendsANewline', () => {
        /*
         * This used to assert that the verb **immediately** after the overflow
         * was honoured, which locked in a real defect: with no newline seen,
         * those bytes are still inside the frame that overflowed, so a sender
         * could pad past the cap and have whatever followed accepted as a frame
         * of its own. Root reproduced exactly that.
         *
         * So the rest of the overlong frame is discarded up to the newline that
         * ends it — and the channel recovers there, rather than going deaf.
         */
        const { send, stops } = channel();
        send('x'.repeat(10_000));
        // Whatever it discarded, it did not invent a verb out of it.
        expect(stops).toEqual([]);
        // Still the tail of that frame, however much it looks like a verb.
        send(managedStopRequest());
        expect(stops).toEqual([]);
        // The frame after it is a frame.
        send(managedStopRequest());
        expect(stops.length).toBe(1);
    });

    it('shouldStopActingOnVerbsOnceCancelled', () => {
        // The run is ending for its own reasons; a late verb must not reopen
        // anything.
        const { send, stops, cancel, destroyed } = channel();
        cancel();
        send(managedStopRequest());
        expect(stops).toEqual([]);
        expect(destroyed()).toBe(true);
    });
});

describe('assertDistinctManagedFds', () => {
    it('shouldAcceptTheSlotsTheRuntimeActuallyUses', () => {
        expect(() => assertDistinctManagedFds(SLOTS)).not.toThrow();
    });

    it('shouldRefuseTwoDocumentsOnOneDescriptor', () => {
        // `bootstrapFd` is configurable, so this is reachable: the child would
        // read one document as the other and fail somewhere else entirely.
        expect(() => assertDistinctManagedFds({ ...SLOTS, bootstrap: MANAGED_CONTROL_CHILD_FD }))
            .toThrow(/one descriptor/);
    });

    it('shouldRefuseADescriptorThatWouldLandOnTheChildsOwnStdio', () => {
        expect(() => assertDistinctManagedFds({ ...SLOTS, control: 0 })).toThrow(/standard descriptors/);
        expect(() => assertDistinctManagedFds({ ...SLOTS, control: 2 })).toThrow(/standard descriptors/);
    });

    it('shouldNameTheAxesAndNotEchoAnythingElse', () => {
        try {
            assertDistinctManagedFds({ ...SLOTS, report: MANAGED_CONTROL_CHILD_FD });
            throw new Error('should have refused');
        } catch (error) {
            expect((error as Error).message).toContain('report');
            expect((error as Error).message).toContain('control');
        }
    });
});

describe('the control slot is a constant, not an environment variable', () => {
    it('shouldNotWidenTheClosedManagedEnvironmentPrefix', () => {
        /*
         * `assertProviderEnv` and `buildCodexToolPolicy` both close the whole
         * `HAPPY_MANAGED_` prefix and allow only what the runtime binds. This
         * slot is a constant on both sides, so naming it in the environment
         * would widen that prefix for a value neither side chooses.
         */
        expect([...TRUSTED_RUNTIME_BOOTSTRAP_ENV].some((key) => key.includes('CONTROL'))).toBe(false);
    });

    it('shouldNotCollideWithTheDescriptorsTheRuntimeAlreadyUses', () => {
        // 3 bootstrap, 4 report, 8 release, 9 status.
        expect([3, 4, 8, 9]).not.toContain(MANAGED_CONTROL_CHILD_FD);
    });
});
