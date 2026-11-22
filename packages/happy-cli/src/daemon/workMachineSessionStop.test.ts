import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    clearWorkMachineSessionStop, createWorkMachineInputLedger, readWorkMachineSessionStop, stopTrackedSessionProcesses,
    workMachineSessionStopPath, writeWorkMachineSessionStop,
} from './workMachineSessionStop';

describe('work machine input ledger', () => {
    it('keeps the cursor at the processed seq once every routed input started a turn', () => {
        const ledger = createWorkMachineInputLedger();
        ledger.routed(11, 'file');
        ledger.routed(12, 'user');
        ledger.queued(12);
        ledger.turnBoundary(new Set());

        expect(ledger.cursor(12)).toEqual({ lastProcessedSeq: 12, inputSkipped: false });
    });

    it('lowers the cursor below an input still waiting behind the running turn', () => {
        const ledger = createWorkMachineInputLedger();
        ledger.routed(12, 'user');
        ledger.queued(12);
        ledger.turnBoundary(new Set());
        ledger.routed(13, 'file');
        ledger.routed(14, 'user');
        ledger.queued(14);
        ledger.turnBoundary(new Set([14]));

        expect(ledger.cursor(14)).toEqual({ lastProcessedSeq: 12, inputSkipped: false });
    });

    it('lowers the cursor below an input taken from the queue that no turn has started with', () => {
        const ledger = createWorkMachineInputLedger();
        ledger.routed(12, 'user');
        ledger.queued(12);

        expect(ledger.cursor(12)).toEqual({ lastProcessedSeq: 11, inputSkipped: false });
    });

    it('lowers the cursor below an input still on its way to the queue', () => {
        const ledger = createWorkMachineInputLedger();
        ledger.routed(12, 'user');
        ledger.turnBoundary(new Set());

        expect(ledger.cursor(12)).toEqual({ lastProcessedSeq: 11, inputSkipped: false });
    });

    it('keeps an attachment that arrived without its message below the cursor', () => {
        const ledger = createWorkMachineInputLedger();
        ledger.routed(12, 'user');
        ledger.queued(12);
        ledger.routed(13, 'file');
        ledger.turnBoundary(new Set());

        expect(ledger.cursor(13)).toEqual({ lastProcessedSeq: 12, inputSkipped: false });
    });

    it('reports an input that never started while a later one did', () => {
        const ledger = createWorkMachineInputLedger();
        ledger.routed(12, 'user');
        ledger.routed(13, 'user');
        ledger.queued(13);
        ledger.turnBoundary(new Set());

        expect(ledger.cursor(13)).toEqual({ lastProcessedSeq: 11, inputSkipped: true });
    });

    it('never raises the cursor above the processed seq', () => {
        expect(createWorkMachineInputLedger().cursor(7)).toEqual({ lastProcessedSeq: 7, inputSkipped: false });
    });
});

describe('work machine session stop record', () => {
    let home: string;
    beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'wm-stop-')); });
    afterEach(async () => { await rm(home, { recursive: true, force: true }); });

    const record = (sessionId: string) => ({
        v: 1 as const, sessionId, cleanStop: true as const, stoppedAt: 1_000, lastProcessedSeq: 12,
        turnInFlight: false, inputSkipped: false, claudeSessionId: '7b0c0bd2-6bb0-4a50-8f4e-2b8c1b0f2f10',
    });

    it('writes a private record that reads back', async () => {
        const path = workMachineSessionStopPath(home, 'session-a');
        writeWorkMachineSessionStop(path, record('session-a'));

        expect(await readWorkMachineSessionStop(path, 'session-a')).toEqual(record('session-a'));
        expect((await stat(path)).mode & 0o777).toBe(0o600);
    });

    it('has no record once a new process cleared it', async () => {
        const path = workMachineSessionStopPath(home, 'session-a');
        writeWorkMachineSessionStop(path, record('session-a'));
        clearWorkMachineSessionStop(path);

        expect(await readWorkMachineSessionStop(path, 'session-a')).toBeNull();
    });

    it('refuses a record that names another session or is malformed', async () => {
        const path = workMachineSessionStopPath(home, 'session-a');
        writeWorkMachineSessionStop(path, record('session-b'));
        await expect(readWorkMachineSessionStop(path, 'session-a')).rejects.toThrow('stop record of session session-a is invalid');

        await writeFile(path, '{', { mode: 0o600 });
        await expect(readWorkMachineSessionStop(path, 'session-a')).rejects.toThrow('stop record of session session-a is invalid');
        expect(await readFile(path, 'utf8')).toBe('{');
    });
});

describe('stopping the daemon\'s session processes before export', () => {
    const children: ChildProcess[] = [];
    afterEach(() => { for (const child of children.splice(0)) child.kill('SIGKILL'); });

    /** A stand-in session process; `onTerm` is its SIGTERM handler body. */
    const sessionProcess = async (onTerm: string) => {
        const child = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => { ${onTerm} }); setInterval(() => {}, 1000); console.log('ready')`],
            { stdio: ['ignore', 'pipe', 'ignore'] });
        children.push(child);
        await once(child.stdout!, 'data');
        return child;
    };
    const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

    it('signals a tracked session process it can identify and waits until it has exited', async () => {
        const child = await sessionProcess('setTimeout(() => process.exit(0), 300);');

        const stopped = await stopTrackedSessionProcesses([{ pid: child.pid!, startedAt: Date.now() + 5_000, happySessionId: 'session-a', startedBy: 'daemon' }]);

        expect(stopped).toEqual(['session-a']);
        expect(() => process.kill(child.pid!, 0)).toThrow();
    });

    it('leaves a pid that a later process took over', async () => {
        const child = await sessionProcess('process.exit(0);');

        expect(await stopTrackedSessionProcesses([{ pid: child.pid!, startedAt: Date.now() - 60_000, startedBy: 'daemon' }])).toEqual([]);
        expect(exited(child)).toBe(false);
    });

    it('refuses when a session process does not exit in time', async () => {
        const child = await sessionProcess('/* ignores the stop */');

        await expect(stopTrackedSessionProcesses([{ pid: child.pid!, startedAt: Date.now() + 5_000, happySessionId: 'session-a', startedBy: 'daemon' }], { timeoutMs: 500 }))
            .rejects.toThrow(`Session session-a (pid ${child.pid}) did not exit`);
    });
});
