/**
 * Ending input is not the same as stopping a process, and every case here is a
 * way the difference could be lost.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
    createManagedGracefulStop,
    registerManagedGracefulStop,
    requestManagedGracefulStop,
    resetManagedGracefulStopForTests,
} from './managedGracefulStop';

function stop(over: { queueSize?: number; hasPending?: boolean } = {}) {
    const wakes: number[] = [];
    let queueSize = over.queueSize ?? 0;
    let hasPending = over.hasPending ?? false;
    const gate = createManagedGracefulStop({
        queueSize: () => queueSize,
        hasPending: () => hasPending,
        wake: () => { wakes.push(1); },
    });
    return {
        gate,
        wakes,
        setQueue: (n: number) => { queueSize = n; },
        setPending: (value: boolean) => { hasPending = value; },
    };
}

describe('createManagedGracefulStop', () => {
    it('shouldWakeAnIdleRunSoItsWaitingReadCanReturnNothing', () => {
        const { gate, wakes } = stop();
        gate.request();
        expect(gate.requested()).toBe(true);
        expect(gate.mayEndInput()).toBe(true);
        expect(wakes.length).toBe(1);
    });

    it('shouldNotWakeARunThatStillHasQueuedWork', () => {
        // The queue hands out its batch before it looks at `closed`, so a wake
        // here delivers those messages into a run that is trying to end.
        const { gate, wakes } = stop({ queueSize: 2 });
        gate.request();
        expect(gate.requested()).toBe(true);
        expect(gate.mayEndInput()).toBe(false);
        expect(wakes).toEqual([]);
    });

    it('shouldNotWakeARunHoldingAMessageForItsNextTurn', () => {
        // A promoted message is not in the queue at all, so queue size alone
        // would report this run as idle.
        const { gate, wakes } = stop({ hasPending: true });
        gate.request();
        expect(gate.mayEndInput()).toBe(false);
        expect(wakes).toEqual([]);
    });

    it('shouldBecomeReadyOnceTheAcceptedWorkIsGone', () => {
        // The turn boundary asks again; nothing else needs to fire.
        const { gate, setQueue } = stop({ queueSize: 1 });
        gate.request();
        expect(gate.mayEndInput()).toBe(false);
        setQueue(0);
        expect(gate.mayEndInput()).toBe(true);
    });

    it('shouldWakeAtMostOnceHoweverOftenItIsAsked', () => {
        const { gate, wakes } = stop();
        gate.request();
        gate.request();
        gate.request();
        expect(wakes.length).toBe(1);
    });

    it('shouldNeverEndInputThatNobodyAskedToEnd', () => {
        // Without this, an idle run would end on its own the moment anything
        // consulted the gate.
        const { gate, wakes } = stop();
        expect(gate.requested()).toBe(false);
        expect(gate.mayEndInput()).toBe(false);
        expect(wakes).toEqual([]);
    });
});

describe('reaching the stop from where the request arrives', () => {
    beforeEach(() => { resetManagedGracefulStopForTests(); });

    it('shouldPassAStopStraightThroughOnceTheLoopIsRegistered', () => {
        const { gate, wakes } = stop();
        registerManagedGracefulStop(gate);
        requestManagedGracefulStop();
        expect(gate.requested()).toBe(true);
        expect(wakes.length).toBe(1);
    });

    it('shouldRememberAStopThatArrivedBeforeTheLoopExisted', () => {
        /*
         * The control channel is read at startup; the message loop is built
         * later. A stop asked for in between would otherwise be dropped, and
         * the checkpoint that asked would wait for an end of input nobody was
         * left to deliver.
         */
        requestManagedGracefulStop();
        const { gate, wakes } = stop();
        registerManagedGracefulStop(gate);
        expect(gate.requested()).toBe(true);
        expect(wakes.length).toBe(1);
    });

    it('shouldApplyARememberedStopOnlyOnce', () => {
        requestManagedGracefulStop();
        const first = stop();
        registerManagedGracefulStop(first.gate);
        const second = stop();
        registerManagedGracefulStop(second.gate);
        // The second loop is a different run; it did not ask for anything.
        expect(second.gate.requested()).toBe(false);
    });

    it('shouldNotHandAStopToTheNextRunAfterTheLoopUnregisters', () => {
        /*
         * A mode switch ends the loop and starts another. A stop that arrives
         * in between must not be applied to a run nobody asked to stop — and
         * the first loop unregistering is what makes the request wait instead
         * of landing on a dead one.
         */
        const first = stop();
        registerManagedGracefulStop(first.gate);
        registerManagedGracefulStop(null);

        requestManagedGracefulStop();
        expect(first.gate.requested()).toBe(false);
    });

    it('shouldDoNothingWhenNobodyHasAskedForAStop', () => {
        const { gate, wakes } = stop();
        registerManagedGracefulStop(gate);
        expect(gate.requested()).toBe(false);
        expect(wakes).toEqual([]);
    });
});
