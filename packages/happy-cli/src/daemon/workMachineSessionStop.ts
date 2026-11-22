/**
 * The clean-stop record a work machine session process leaves when it exits
 * (aplus-dev-studio specs/work-machine-migration plan 5.4, requirement 6).
 *
 * The daemon writes a session's resume cursor at most every 30 seconds and only while it runs, and
 * that cursor means "delivered to the agent loop", not "a turn ran it". An export signing it could
 * skip an input that never ran, or replay one that did. So the session process itself writes its
 * final state on every exit (stop, signal, revoked or frozen credential): the cursor lowered below
 * the first input no turn has started with, the provider conversation, and whether a turn was
 * still running. A starting process removes the previous record, so a live or killed process has
 * none, and the export refuses a session without one.
 *
 * `HAPPY_HOME/work-machine-sessions/<sessionId>.json`, 0600.
 *
 * Session processes outlive the daemon (it keeps `trackedSessions` for the next one), so the export
 * first stops those it can identify the way the daemon itself recovers them, and waits for each.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { isPidAlive, type PersistedTrackedSession } from '@/persistence';
import { getProcessStartedAt } from '@/utils/processStartTime';
import { classifyRecoveredTrackedProcess } from './orphanAdoption';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
export const workMachineSessionStopSchema = z.object({
    v: z.literal(1),
    sessionId: identifier,
    cleanStop: z.literal(true),
    stoppedAt: z.number().int().positive(),
    lastProcessedSeq: z.number().int().nonnegative(),
    /** A turn had started and not ended when the process was told to stop (or at exit). */
    turnInFlight: z.boolean(),
    /** An input below a started one never reached a turn: no single cursor describes this session. */
    inputSkipped: z.boolean(),
    claudeSessionId: z.string().min(1).max(200).optional(),
    codexThreadId: z.string().min(1).max(200).optional(),
}).strict();
export type WorkMachineSessionStop = z.infer<typeof workMachineSessionStopSchema>;

export const workMachineSessionStopPath = (home: string, sessionId: string) =>
    join(home, 'work-machine-sessions', `${identifier.parse(sessionId)}.json`);

/** Synchronous: called when the process starts and from its `exit` handler. */
export function clearWorkMachineSessionStop(path: string): void {
    rmSync(path, { force: true });
}

export function writeWorkMachineSessionStop(path: string, record: WorkMachineSessionStop): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(workMachineSessionStopSchema.parse(record)), { mode: 0o600 });
    renameSync(temporary, path);
}

/** Null when the session has no record (it is running, was killed, or never ran protected). */
export async function readWorkMachineSessionStop(path: string, sessionId: string): Promise<WorkMachineSessionStop | null> {
    const contents = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
    });
    if (contents === null) return null;
    try {
        const record = workMachineSessionStopSchema.parse(JSON.parse(contents));
        if (record.sessionId !== sessionId) throw new Error();
        return record;
    } catch {
        throw new Error(`The work machine stop record of session ${sessionId} is invalid`);
    }
}

/**
 * Which routed inputs a started turn has taken. An input is routed (received for the agent loop),
 * then queued (in the loop's message queue), then consumed: no longer queued when a turn starts or
 * ends (the loops' thinking transitions). File events carry the attachments of the next message,
 * so they are consumed with the first message after them.
 */
export function createWorkMachineInputLedger() {
    const routed = new Map<number, 'user' | 'file'>();
    const queued = new Set<number>();
    let consumedThrough = -1;
    return {
        routed(seq: number, kind: 'user' | 'file'): void { routed.set(seq, kind); },
        queued(seq: number): void { if (routed.get(seq) === 'user') queued.add(seq); },
        turnBoundary(waiting: ReadonlySet<number>): void {
            for (const seq of queued) {
                if (waiting.has(seq)) continue;
                queued.delete(seq);
                routed.delete(seq);
                consumedThrough = Math.max(consumedThrough, seq);
            }
            for (const [seq, kind] of routed) if (kind === 'file' && seq < consumedThrough) routed.delete(seq);
        },
        cursor(processedSeq: number): { lastProcessedSeq: number; inputSkipped: boolean } {
            const first = Math.min(...routed.keys());
            return {
                lastProcessedSeq: Math.max(0, Math.min(processedSeq, first - 1)),
                inputSkipped: [...routed].some(([seq, kind]) => kind === 'user' && seq < consumedThrough),
            };
        },
    };
}
export type WorkMachineInputLedger = ReturnType<typeof createWorkMachineInputLedger>;

/**
 * Sends SIGTERM to each still-running process the stopped daemon tracked (its pid not taken over by
 * a later process) and waits until it has exited; returns the stopped session ids. A process whose
 * identity cannot be checked, or that does not exit in time, stops the export: it may still be running
 * a turn or writing into a project.
 */
export async function stopTrackedSessionProcesses(
    tracked: readonly PersistedTrackedSession[], options: { timeoutMs?: number } = {},
): Promise<string[]> {
    const stopping: PersistedTrackedSession[] = [];
    for (const session of tracked) {
        const label = `Session ${session.happySessionId ?? 'starting'} (pid ${session.pid})`;
        const identity = classifyRecoveredTrackedProcess({ pid: session.pid, recordedStartedAt: session.startedAt, isPidAlive, getProcessStartedAt });
        if (identity === 'unverified') throw new Error(`${label} is running and cannot be identified; stop it, then export again`);
        if (identity !== 'verified') continue;
        process.kill(session.pid, 'SIGTERM');
        stopping.push(session);
    }
    const deadline = Date.now() + (options.timeoutMs ?? 60_000);
    for (const session of stopping) {
        while (isPidAlive(session.pid)) {
            if (Date.now() >= deadline) {
                throw new Error(`Session ${session.happySessionId ?? 'starting'} (pid ${session.pid}) did not exit after SIGTERM; wait for it or stop it, then export again`);
            }
            await sleep(100);
        }
    }
    return stopping.flatMap(session => session.happySessionId ? [session.happySessionId] : []);
}
