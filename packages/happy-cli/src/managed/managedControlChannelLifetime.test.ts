/**
 * The control channel must not keep the run alive.
 *
 * Measured in a deployed runtime: the provider finished its turn, reported
 * `exhausted-clean`, cleaned up — and then sat there. Forty-four seconds later
 * it was still running with nothing left in its log. The supervisor waited the
 * whole 30s budget, saw no exit, and the gate refused `exit-unobserved`. The
 * run was preventing the very exit the checkpoint was waiting for.
 *
 * The cause was a listener: `fs.createReadStream` over the inherited
 * descriptor keeps a read pending, and a pending read holds the event loop
 * open. Earlier runs never showed it because the watchdog's SIGKILL ended the
 * process first.
 *
 * Driven as a real child process, because "does the process exit" is not a
 * question a double can answer.
 */
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/** Runs a child that opens fd 5 the way the runtime does, and reports whether it exits. */
function childThatListensOnFd5(body: string): Promise<{ exited: boolean; code: number | null }> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['-e', body], {
            stdio: ['ignore', 'ignore', 'inherit', 'ignore', 'ignore', 'pipe'],
        });
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve({ exited: false, code: null });
        }, 3_000);
        child.once('exit', (code) => {
            clearTimeout(timer);
            resolve({ exited: true, code });
        });
    });
}

describe('a child listening on the control descriptor', () => {
    it('shouldStillExitOnceItsWorkIsDone', async () => {
        // The production shape: a socket on the inherited fd, unref'd.
        const outcome = await childThatListensOnFd5(`
            const { Socket } = require('node:net');
            const s = new Socket({ fd: 5, readable: true, writable: false });
            s.unref();
            s.on('data', () => {});
            s.on('error', () => {});
        `);
        expect(outcome).toEqual({ exited: true, code: 0 });
    });

    it('shouldHaveFailedToExitWithTheListenerThatWasThereBefore', async () => {
        /*
         * The regression, stated as behaviour rather than as a claim: a
         * pending threadpool read on the same descriptor holds the loop open
         * and the process never leaves.
         */
        const outcome = await childThatListensOnFd5(`
            const { createReadStream } = require('node:fs');
            const s = createReadStream('', { fd: 5, autoClose: false });
            s.on('data', () => {});
            s.on('error', () => {});
        `);
        expect(outcome.exited).toBe(false);
    });

    it('shouldStillDeliverAStopWhileTheRunHasWork', async () => {
        // Unref'd is not deaf. It must still wake the run when the supervisor
        // speaks, for as long as the run is alive.
        const child = spawn(process.execPath, ['-e', `
            const { Socket } = require('node:net');
            const s = new Socket({ fd: 5, readable: true, writable: false });
            s.unref();
            let buf = '';
            s.on('data', (c) => {
                buf += c;
                if (buf.includes('\\n')) process.exit(7);
            });
            // Something else keeping the run alive, as a real turn would.
            setTimeout(() => process.exit(1), 2_500);
        `], { stdio: ['ignore', 'ignore', 'inherit', 'ignore', 'ignore', 'pipe'] });

        const code = await new Promise<number | null>((resolve) => {
            setTimeout(() => {
                // `stdio` is typed as a 5-tuple; the extra slot is real at
                // runtime, which is the whole point of the channel.
                const control = (child.stdio as unknown as Array<{ write(text: string): void }>)[5];
                control?.write('stop\n');
            }, 200);
            child.once('exit', resolve);
        });
        expect(code).toBe(7);
    });
});
