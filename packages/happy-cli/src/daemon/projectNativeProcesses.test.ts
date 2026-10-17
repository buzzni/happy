/**
 * aplus-dev-studio strict-followup-plan F1 — the project-delete process stop, moved from the web
 * server's bash script into the daemon unchanged: only processes whose own environment markers
 * match a registry row of this project are signalled, and a pid is re-checked right before each signal.
 */
import { describe, expect, it } from 'vitest';
import { stopProjectNativeProcesses, type NativeProcessIo } from './projectNativeProcesses';

const PROJECT = 'proj-1';
const MACHINE = 'm1';
const ROW = { markerId: 'mk-1', kind: 'dev-server', projectId: PROJECT, machineId: MACHINE, status: 'bound', launchedAt: 1_000, hostPid: 100 };
const MARKERS = { APLUS_OWNER: 'aplus-dev-studio', APLUS_MARKER_ID: 'mk-1', APLUS_SPAWN_KIND: 'dev-server', APLUS_MARKER_VERSION: '1', APLUS_LAUNCHED_AT: '1000' };

type Proc = { env?: Record<string, string>; start: number; state?: string; diesOn?: 'SIGTERM' | 'SIGKILL' | 'never' };

function machine(input: { rows?: unknown; procs: Record<number, Proc>; proc?: boolean }) {
    const procs = new Map<number, Proc>(Object.entries(input.procs).map(([pid, p]) => [Number(pid), p]));
    const signals: Array<[number, string]> = [];
    const io: NativeProcessIo = {
        readRegistry: async () => (input.rows === undefined ? null : JSON.stringify(input.rows)),
        procAvailable: () => input.proc !== false,
        pids: () => [...procs.keys()],
        environ: (pid) => procs.get(pid)?.env ?? null,
        stat: (pid) => {
            const p = procs.get(pid);
            return p ? { state: p.state ?? 'S', start: p.start } : null;
        },
        kill: (pid, signal) => {
            signals.push([pid, signal]);
            const p = procs.get(pid);
            if (p && (p.diesOn === signal || (p.diesOn === undefined && signal === 'SIGTERM'))) procs.delete(pid);
        },
        sleep: async () => undefined,
        now: (() => { let t = 0; return () => (t += 1_000); })(),
        selfPid: 1,
    };
    return { io, signals, procs };
}

describe('stopProjectNativeProcesses', () => {
    it('stops the processes that prove they are this project\'s, children first', async () => {
        const m = machine({ rows: [ROW], procs: { 100: { env: MARKERS, start: 5 }, 101: { env: MARKERS, start: 6 } } });
        const result = await stopProjectNativeProcesses({ projectId: PROJECT, machineId: MACHINE }, m.io);
        expect(result.reason).toBe('cleaned');
        expect(m.signals).toEqual([[101, 'SIGTERM'], [100, 'SIGTERM']]);
    });

    it('does not touch a process that only shares a pid with a row', async () => {
        const m = machine({ rows: [ROW], procs: { 100: { env: { APLUS_OWNER: 'someone-else' }, start: 5 } } });
        const result = await stopProjectNativeProcesses({ projectId: PROJECT, machineId: MACHINE }, m.io);
        expect(result.reason).toBe('identity-unverified');
        expect(m.signals).toEqual([]);
    });

    it('escalates to SIGKILL only for the same process, and reports one that survived', async () => {
        const m = machine({ rows: [ROW], procs: { 100: { env: MARKERS, start: 5, diesOn: 'never' } } });
        const result = await stopProjectNativeProcesses({ projectId: PROJECT, machineId: MACHINE }, m.io);
        expect(m.signals).toEqual([[100, 'SIGTERM'], [100, 'SIGKILL']]);
        expect(result.reason).toBe('terminate-incomplete');
    });

    it('has nothing to do without rows for this project, and fails without the registry it needs', async () => {
        expect((await stopProjectNativeProcesses({ projectId: PROJECT, machineId: MACHINE }, machine({ procs: {} }).io)).reason).toBe('no-native-processes');
        expect((await stopProjectNativeProcesses({ projectId: PROJECT, machineId: MACHINE }, machine({ rows: [{ ...ROW, projectId: 'other' }], procs: {} }).io)).reason).toBe('no-native-processes');
        expect((await stopProjectNativeProcesses({ projectId: PROJECT, machineId: MACHINE }, machine({ rows: 'broken', procs: {} }).io)).reason).toBe('registry-unreadable');
        expect((await stopProjectNativeProcesses({ projectId: PROJECT, machineId: MACHINE }, machine({ rows: [ROW], procs: {}, proc: false }).io)).reason).toBe('proc-unavailable');
        expect((await stopProjectNativeProcesses({ projectId: PROJECT, machineId: MACHINE }, machine({ rows: [{ ...ROW, status: 'pending' }], procs: {} }).io)).reason).toBe('evidence-unavailable');
    });

    it('counts without signalling on a dry run', async () => {
        const m = machine({ rows: [ROW], procs: { 100: { env: MARKERS, start: 5 } } });
        const result = await stopProjectNativeProcesses({ projectId: PROJECT, machineId: MACHINE, dryRun: true }, m.io);
        expect(result).toMatchObject({ verified: 1, unverified: 0 });
        expect(m.signals).toEqual([]);
    });
});
