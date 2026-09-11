/**
 * Codex's graceful close, against the real method on the real class.
 *
 * `disconnect()` does `stdin.end()` and `SIGTERM` in one breath and never
 * awaits the exit, so it can never prove a flush. Every case here is a way
 * `endInputAndAwaitExit` could report one that did not happen.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { CodexAppServerClient } from './codexAppServerClient';

/** A stand-in for the spawned app server, recording every signal sent. */
function processDouble() {
    const proc = new EventEmitter() as EventEmitter & {
        pid: number;
        stdin: { end: () => void } | null;
        kill: (signal?: string) => boolean;
    };
    const signals: string[] = [];
    let stdinEnded = 0;
    proc.pid = 4242;
    proc.stdin = { end: () => { stdinEnded += 1; } };
    proc.kill = (signal?: string) => { signals.push(signal ?? 'SIGTERM'); return true; };
    return { proc, signals, endedCount: () => stdinEnded };
}

/**
 * The real prototype with only `process` supplied.
 *
 * `process` is private, so the cast goes through `unknown` — the method under
 * test is the real one either way, which is the part that matters.
 */
function client(proc: unknown): { endInputAndAwaitExit: CodexAppServerClient['endInputAndAwaitExit'] } {
    const instance = Object.create(CodexAppServerClient.prototype) as unknown as { process: unknown };
    instance.process = proc;
    return instance as unknown as { endInputAndAwaitExit: CodexAppServerClient['endInputAndAwaitExit'] };
}

describe('endInputAndAwaitExit', () => {
    it('shouldEndStdinAndSendNoSignalAtAll', async () => {
        const { proc, signals, endedCount } = processDouble();
        const instance = client(proc);

        const settled = instance.endInputAndAwaitExit(1_000);
        proc.emit('exit', 0, null);

        expect(await settled).toEqual({ exited: true, code: 0, signal: null });
        expect(endedCount()).toBe(1);
        // The whole point: a signalled process did not flush.
        expect(signals).toEqual([]);
    });

    it('shouldReportWhatTheKernelSaidRatherThanWhatWasHopedFor', async () => {
        const { proc } = processDouble();
        const instance = client(proc);

        const settled = instance.endInputAndAwaitExit(1_000);
        proc.emit('exit', 3, null);

        expect(await settled).toEqual({ exited: true, code: 3, signal: null });
    });

    it('shouldNotCallATimeoutAnExit', async () => {
        // A budget that ran out is "not observed leaving", and folding it into
        // a clean exit is how a still-writing provider gets archived. The
        // caller may fall back to `disconnect()`, but that is a kill.
        const { proc, signals } = processDouble();
        const instance = client(proc);

        expect(await instance.endInputAndAwaitExit(10))
            .toEqual({ exited: false, code: null, signal: null });
        expect(signals).toEqual([]);
    });

    it('shouldNotReportACleanExitWhenThereWasNoProcess', async () => {
        // "There was no process" is not "the process finished writing".
        const instance = client(null);
        expect(await instance.endInputAndAwaitExit(1_000))
            .toEqual({ exited: false, code: null, signal: null });
    });

    it('shouldReportASignalledExitAsSignalledRatherThanHidingIt', async () => {
        // It sends no signal, but something else may have. The caller needs to
        // see that, because it is never a flush.
        const { proc } = processDouble();
        const instance = client(proc);

        const settled = instance.endInputAndAwaitExit(1_000);
        proc.emit('exit', null, 'SIGTERM');

        expect(await settled).toEqual({ exited: true, code: null, signal: 'SIGTERM' });
    });
});
