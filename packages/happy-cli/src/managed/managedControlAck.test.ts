/**
 * The child's answer, and the ways a silent or unhappy run could be read as a
 * clean one.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import {
    MANAGED_STOP_CLEAN,
    managedStopAck,
    parseManagedStopAck,
    readManagedControlChannel,
} from './managedControlChannel';
import { reportManagedStopOutcome } from './managedStartup';

describe('the child answering on the control descriptor', () => {
    it('shouldRoundTripTheOneVerdictThatMeansItFlushed', () => {
        expect(parseManagedStopAck(managedStopAck(MANAGED_STOP_CLEAN)))
            .toEqual({ verdict: MANAGED_STOP_CLEAN, nativeId: null });
    });

    it('shouldSayNothingRatherThanAVerdictForALineThatIsNotOne', () => {
        // `null` is "the child did not say", which is never a verdict —
        // folding the two lets a silent child look like a clean one.
        for (const line of ['', 'stop', 'ended', 'ended ', 'something else']) {
            expect(parseManagedStopAck(line)).toBeNull();
        }
    });

    it('shouldNeverCarryFreeTextAcrossTheBoundary', () => {
        // This is written by the child and read by the supervisor, and it is
        // logged. A code, or `unknown`.
        expect(managedStopAck('provider said: /workspace/secret')).toBe('ended unknown\n');
        expect(managedStopAck('a'.repeat(200))).toBe('ended unknown\n');
    });

    it('shouldReachAReaderListeningForAnswers', () => {
        const source = new EventEmitter();
        const verdicts: string[] = [];
        readManagedControlChannel({
            source: source as never,
            onStop: () => { throw new Error('an answer is not a request'); },
            onAck: (ack) => { verdicts.push(ack.verdict); },
        });
        source.emit('data', Buffer.from(managedStopAck(MANAGED_STOP_CLEAN), 'utf8'));
        expect(verdicts).toEqual([MANAGED_STOP_CLEAN]);
    });

    it('shouldReportNothingWhenThereIsNoChannelToAnswerOn', () => {
        // Not a failure to report: nothing asked this run to stop, and the
        // supervisor treats an absent ack as absent rather than assumed.
        expect(reportManagedStopOutcome(MANAGED_STOP_CLEAN, {
            write: () => { throw new Error('EBADF'); },
        })).toBe(false);
    });

    it('shouldWriteTheVerdictOnTheControlDescriptor', () => {
        const written: Array<[number, string]> = [];
        expect(reportManagedStopOutcome(MANAGED_STOP_CLEAN, {
            write: (fd, text) => { written.push([fd, text]); },
        })).toBe(true);
        expect(written).toEqual([[5, `ended ${MANAGED_STOP_CLEAN}\n`]]);
    });
});

describe('the identity that travels with the verdict', () => {
    const ID = '9f1c7a2e-4b30-4d51-8c66-0a2e7d3b91f4';

    it('shouldCarryTheSessionInTheSameFrameAsTheVerdict', () => {
        // One frame, one observation. Two frames would leave the reader to pair
        // a verdict with an identity, which is the pairing that kept going
        // wrong inside the launcher.
        expect(managedStopAck(MANAGED_STOP_CLEAN, ID)).toBe(`ended exhausted-clean ${ID}\n`);
        expect(parseManagedStopAck(managedStopAck(MANAGED_STOP_CLEAN, ID)))
            .toEqual({ verdict: MANAGED_STOP_CLEAN, nativeId: ID });
    });

    it('shouldStillSpeakToAPeerThatHasNoIdentityToGive', () => {
        // An older child, or a generation that exited before the SDK named a
        // session. A frame without an id is a legal frame, not a broken one.
        expect(parseManagedStopAck('ended exhausted-clean'))
            .toEqual({ verdict: MANAGED_STOP_CLEAN, nativeId: null });
        expect(managedStopAck(MANAGED_STOP_CLEAN, null)).toBe('ended exhausted-clean\n');
        expect(managedStopAck(MANAGED_STOP_CLEAN, undefined)).toBe('ended exhausted-clean\n');
    });

    it('shouldDropAnIdentityItWouldNotBeAbleToWriteDown', () => {
        // The writer never emits something the reader would refuse: that would
        // turn a run that ended perfectly well into a run with no answer.
        for (const bad of ['../../etc/passwd', 'NOT-A-UUID', `${ID} ${ID}`, '']) {
            expect(managedStopAck(MANAGED_STOP_CLEAN, bad)).toBe('ended exhausted-clean\n');
        }
    });

    it('shouldRefuseTheWholeFrameWhenTheIdentityIsMalformed', () => {
        /*
         * Not "accept the verdict and drop the id". They arrived together and
         * were meant to be believed together; taking half of a frame this
         * reader does not understand is how a supervisor ends up acting on a
         * sentence it only partly parsed.
         */
        for (const line of [
            'ended exhausted-clean deadbeef',
            'ended exhausted-clean 9f1c7a2e-4b30-4d51-8c66-0a2e7d3b91f',
            `ended exhausted-clean ${ID} extra`,
        ]) {
            expect(parseManagedStopAck(line)).toBeNull();
        }
    });

    it('shouldWaitForTheWholeFrameWhenItArrivesInPieces', () => {
        // A chunk boundary inside the id must not produce a short id, and must
        // not let the next chunk complete one nobody sent.
        const source = new EventEmitter();
        const acks: Array<{ verdict: string; nativeId: string | null }> = [];
        readManagedControlChannel({
            source: source as never,
            onStop: () => undefined,
            onAck: (ack) => { acks.push(ack); },
        });
        source.emit('data', Buffer.from('ended exhausted-cl', 'utf8'));
        source.emit('data', Buffer.from(`ean ${ID.slice(0, 10)}`, 'utf8'));
        expect(acks).toEqual([]);
        source.emit('data', Buffer.from(`${ID.slice(10)}\n`, 'utf8'));
        expect(acks).toEqual([{ verdict: MANAGED_STOP_CLEAN, nativeId: ID }]);
    });

    it('shouldHoldTheLongestLegalFrameThatHasNotEndedYet', () => {
        /*
         * The cap has to clear a whole legal frame. The longest is `ended ` +
         * a 40-character code + a space + a 36-character id = 83, so a cap
         * sized for the old vocabulary would discard a frame this reader is
         * supposed to understand — and discard it mid-identity, leaving a
         * valid-looking tail for the next chunk to complete.
         */
        const verdict = 'a'.repeat(40);
        const frame = `ended ${verdict} ${ID}`;
        expect(frame).toHaveLength(83);

        const source = new EventEmitter();
        const acks: Array<{ verdict: string; nativeId: string | null }> = [];
        readManagedControlChannel({
            source: source as never,
            onStop: () => undefined,
            onAck: (ack) => { acks.push(ack); },
        });
        source.emit('data', Buffer.from(frame, 'utf8'));
        source.emit('data', Buffer.from('\n', 'utf8'));
        expect(acks).toEqual([{ verdict, nativeId: ID }]);
    });

    it('shouldNotLetAnEndlessSenderGrowTheBuffer', () => {
        // Bounded, and it recovers: the frame that overflowed ends at its own
        // newline, and the channel reads normally from there.
        const source = new EventEmitter();
        const acks: Array<{ verdict: string; nativeId: string | null }> = [];
        readManagedControlChannel({
            source: source as never,
            onStop: () => undefined,
            onAck: (ack) => { acks.push(ack); },
        });
        source.emit('data', Buffer.from('x'.repeat(300), 'utf8'));
        source.emit('data', Buffer.from('\n', 'utf8'));
        expect(acks).toEqual([]);
        source.emit('data', Buffer.from(`ended exhausted-clean ${ID}\n`, 'utf8'));
        expect(acks).toEqual([{ verdict: MANAGED_STOP_CLEAN, nativeId: ID }]);
    });

    it('shouldNotLetTheTailOfOneOversizedFrameBecomeAFrameOfItsOwn', () => {
        /*
         * Root's repro. Clearing the buffer on overflow leaves the reader
         * believing the next byte starts a frame — but there was no newline, so
         * those bytes are still **inside** the frame that overflowed. A sender
         * that pads past the cap can then place any answer it likes after the
         * padding and have it accepted as a whole frame.
         *
         * Overflow means: discard until a newline actually arrives. The frame
         * after that one may be trusted; the rest of this one may not.
         */
        const source = new EventEmitter();
        const acks: Array<{ verdict: string; nativeId: string | null }> = [];
        readManagedControlChannel({
            source: source as never,
            onStop: () => undefined,
            onAck: (ack) => { acks.push(ack); },
        });
        source.emit('data', Buffer.from('x'.repeat(129), 'utf8'));
        source.emit('data', Buffer.from(`ended exhausted-clean ${ID}\n`, 'utf8'));
        expect(acks).toEqual([]);

        // And the channel still works afterwards: the next frame is a frame.
        source.emit('data', Buffer.from(`ended exhausted-clean ${ID}\n`, 'utf8'));
        expect(acks).toEqual([{ verdict: MANAGED_STOP_CLEAN, nativeId: ID }]);
    });

    it('shouldRejectAnOversizedFrameEvenWhenItArrivesCompleteInOneChunk', () => {
        /*
         * Root's second repro, and the same defect from the other side: the
         * unterminated-tail guard never fires when the newline is already
         * there, and trimming before measuring made 129 bytes of padding
         * disappear. A frame's length is a property of the bytes the sender
         * actually sent, not of what is left after the reader tidies them up.
         *
         * So the bound is on the raw line, whatever the chunking — and a
         * rejected line must not take the channel down with it: the next valid
         * frame is still a frame.
         */
        const source = new EventEmitter();
        const acks: Array<{ verdict: string; nativeId: string | null }> = [];
        readManagedControlChannel({
            source: source as never,
            onStop: () => { throw new Error('padding is not a request'); },
            onAck: (ack) => { acks.push(ack); },
        });
        source.emit('data', Buffer.from(`${' '.repeat(129)}ended exhausted-clean ${ID}\n`, 'utf8'));
        expect(acks).toEqual([]);

        source.emit('data', Buffer.from(`ended exhausted-clean ${ID}\n`, 'utf8'));
        expect(acks).toEqual([{ verdict: MANAGED_STOP_CLEAN, nativeId: ID }]);
    });

    it('shouldNotAcceptAPaddedRequestEither', () => {
        // The same bound applies to the one verb: `stop` is four bytes, and a
        // padded one is not it.
        const source = new EventEmitter();
        let stops = 0;
        readManagedControlChannel({
            source: source as never,
            onStop: () => { stops += 1; },
        });
        source.emit('data', Buffer.from(`${' '.repeat(129)}stop\n`, 'utf8'));
        expect(stops).toBe(0);
        source.emit('data', Buffer.from('stop\n', 'utf8'));
        expect(stops).toBe(1);
    });

    it('shouldKeepAnIdentityTheRestOfThisCodebaseWouldAccept', () => {
        /*
         * The grammar this channel checks has to be the grammar everything else
         * checks — `claudeSessionTransfer.ts` and `apiMachine.ts` both accept
         * either case. Narrowing it here made a legitimate upper-case session id
         * vanish from the frame silently, which is worse than refusing it: the
         * run reports clean and names nothing.
         *
         * The spelling is preserved rather than folded. This id reaches a path,
         * and normalising an identifier on its way to a filesystem is how you
         * end up looking for a file that is not there.
         */
        const upper = 'ABCDEFAB-1111-1111-1111-111111111111';
        expect(managedStopAck(MANAGED_STOP_CLEAN, upper)).toBe(`ended exhausted-clean ${upper}\n`);
        expect(parseManagedStopAck(`ended exhausted-clean ${upper}`))
            .toEqual({ verdict: MANAGED_STOP_CLEAN, nativeId: upper });
    });

    it('shouldWriteTheIdentityOfTheGenerationItIsReportingOn', () => {
        const written: string[] = [];
        reportManagedStopOutcome(MANAGED_STOP_CLEAN, {
            write: (_fd, text) => { written.push(text); },
            nativeId: ID,
        });
        expect(written).toEqual([`ended exhausted-clean ${ID}\n`]);
    });
});
