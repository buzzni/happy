/**
 * The channel has to be listening before the message loop exists, and a
 * runtime that never gave the child one must not take the child down.
 */
import { closeSync, createReadStream, openSync } from 'node:fs';
import { devNull } from 'node:os';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it } from 'vitest';

import { openManagedControlChannel } from './managedStartup';
import { managedStopRequest } from './managedControlChannel';
import {
    createManagedGracefulStop,
    registerManagedGracefulStop,
    resetManagedGracefulStopForTests,
} from './managedGracefulStop';

describe('openManagedControlChannel', () => {
    beforeEach(() => { resetManagedGracefulStopForTests(); });

    it('shouldCarryAStopThroughToALoopThatRegistersLater', () => {
        /*
         * The real sequence: the channel is read during startup, the loop is
         * built afterwards. A stop in between must survive the gap.
         */
        const source = new EventEmitter();
        openManagedControlChannel({ open: () => source as never });
        source.emit('data', Buffer.from(managedStopRequest(), 'utf8'));

        const wakes: number[] = [];
        const stop = createManagedGracefulStop({
            queueSize: () => 0,
            hasPending: () => false,
            wake: () => { wakes.push(1); },
        });
        registerManagedGracefulStop(stop);

        expect(stop.requested()).toBe(true);
        expect(wakes.length).toBe(1);
    });

    it('shouldSurviveASynchronousFailureToOpenTheSlot', () => {
        let unusable = 0;
        expect(openManagedControlChannel({
            open: () => { throw new Error('EBADF'); },
            onUnusable: () => { unusable += 1; },
        })).toBeNull();
        expect(unusable).toBe(1);
    });

    it('shouldSurviveADescriptorTheRuntimeNeverOpened', async () => {
        /*
         * The failure that actually happens, and the one a throwing double
         * misses entirely: `createReadStream` over a closed descriptor
         * constructs fine and emits `error` on its **first read**, long after
         * the constructor returned. With no listener that is an unhandled
         * `error` event and the whole child dies.
         *
         * Driven through the real `node:fs` stream over a genuinely closed
         * descriptor — no double — because the point is Node's behaviour.
         */
        const fd = openSync(devNull, 'r');
        closeSync(fd);

        let unusable = 0;
        const dispose = openManagedControlChannel({
            open: (): never => createReadStream('', { fd, autoClose: false }) as never,
            onUnusable: () => { unusable += 1; },
        });
        expect(typeof dispose).toBe('function');

        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(unusable).toBe(1);
        dispose?.();
    });

    it('shouldNeverReadAFailedChannelAsARequestToStop', async () => {
        // Fabricating an EOF here would end input on every runtime that did
        // not open the descriptor — the exact opposite of failing closed.
        const fd = openSync(devNull, 'r');
        closeSync(fd);

        const stop = createManagedGracefulStop({
            queueSize: () => 0,
            hasPending: () => false,
            wake: () => undefined,
        });
        registerManagedGracefulStop(stop);
        const dispose = openManagedControlChannel({
            open: (): never => createReadStream('', { fd, autoClose: false }) as never,
        });

        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(stop.requested()).toBe(false);
        dispose?.();
    });
});
