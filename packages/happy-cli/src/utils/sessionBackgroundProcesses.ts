/**
 * Session-owned background processes (aplus-dev-studio-desktop#2111).
 *
 * When the user stops a response, Desktop asks each stopped session to clean up
 * the processes it left running, through the `clean-background-processes`
 * session RPC. The session runtime answers only for processes it spawned itself
 * and recorded at spawn time — the same rule as the desktop helper ledger
 * (ADR-041 R4: "a process not in the ledger is never reclaimed"). Nothing is
 * looked up by name, age, port, cwd or process tree.
 *
 * Identity, per record:
 * - **Root still unreaped** (`exitCode`/`signalCode` both null on the Node
 *   handle): the pid cannot have been reused — the kernel does not hand out a
 *   pid until its parent reaped it, and the parent is this process. This is a
 *   stronger proof than comparing start times (ADR-041's `lstart`), which the
 *   desktop ledger needs only because it no longer holds the handle.
 * - **Root reaped, own process group still populated**: recorded only for a
 *   process spawned as its own group leader (POSIX `detached`). A process group
 *   id is not reused while the group has members, and our leader's pid cannot be
 *   reused while it is still the id of a live group. So if some process holds
 *   the leader's pid again, our group ended — the record is dropped and nothing
 *   is signalled (`pid-reused`). If the probe is refused, the record is kept and
 *   reported as `failed` without a signal (`unverifiable`).
 * - **Root reaped, shared process group**: forgotten at exit. Whatever it left
 *   behind shares the session process's group and cannot be told apart from it
 *   without guessing.
 *
 * Signals go to the recorded group only when the runtime created that group;
 * otherwise to the recorded pid through its handle. SIGTERM first, SIGKILL
 * after a short grace, identity re-checked before each. On Windows there are no
 * POSIX groups, so every record is its pid alone.
 *
 * Not recorded (documented limitation, never approximated): processes that a
 * third-party agent CLI starts itself — Claude Code's Bash `run_in_background`,
 * Codex's background terminals — and anything that leaves its group (setsid,
 * double fork).
 */

import type { ChildProcess } from 'node:child_process';
import { logger } from '@/ui/logger';

export const CLEAN_BACKGROUND_PROCESSES_METHOD = 'clean-background-processes';

const DEFAULT_GRACE_MS = 2_000;
const DEFAULT_KILL_WAIT_MS = 1_000;
const POLL_MS = 25;
const COMMAND_PREVIEW_CHARS = 200;

type RecordedChild = Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'once'> & Partial<Pick<ChildProcess, 'kill'>>;
type Kill = (target: number, signal: NodeJS.Signals | 0) => void;

export interface BackgroundProcessRecord {
    pid: number;
    /** The group this runtime created for it (POSIX detached spawn); null when it shares ours. */
    processGroupId: number | null;
    command: string;
    child: RecordedChild;
}

export interface BackgroundProcessCleanupItem {
    pid: number;
    command: string;
    result: 'stopped' | 'failed' | 'skipped';
    reason?: 'pid-reused' | 'unverifiable' | 'signal-refused' | 'still-running';
}

export interface BackgroundProcessCleanupResult {
    stopped: number;
    failed: number;
    items: BackgroundProcessCleanupItem[];
}

export interface SessionBackgroundProcessesOptions {
    kill?: Kill;
    platform?: NodeJS.Platform;
    graceMs?: number;
    killWaitMs?: number;
}

type Identity = 'root-alive' | 'orphan-group' | 'gone' | 'pid-reused' | 'unverifiable';

function errorCode(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | undefined)?.code;
}

function rootAlive(record: BackgroundProcessRecord): boolean {
    return record.child.exitCode === null && record.child.signalCode === null;
}

export function createSessionBackgroundProcesses(options: SessionBackgroundProcessesOptions = {}) {
    const kill: Kill = options.kill ?? ((target, signal) => { process.kill(target, signal); });
    const platform = options.platform ?? process.platform;
    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    const killWaitMs = options.killWaitMs ?? DEFAULT_KILL_WAIT_MS;
    const sessions = new Map<string, Map<number, BackgroundProcessRecord>>();
    const cleaning = new Map<string, Promise<BackgroundProcessCleanupResult>>();

    const probe = (target: number): 'alive' | 'gone' | 'denied' => {
        try {
            kill(target, 0);
            return 'alive';
        } catch (error) {
            return errorCode(error) === 'ESRCH' ? 'gone' : 'denied';
        }
    };

    const identify = (record: BackgroundProcessRecord): Identity => {
        if (rootAlive(record)) return 'root-alive';
        if (record.processGroupId === null) return 'gone';
        // Our leader was reaped: any process holding its pid now is someone else's.
        if (probe(record.processGroupId) !== 'gone') return 'pid-reused';
        const group = probe(-record.processGroupId);
        return group === 'alive' ? 'orphan-group' : group === 'gone' ? 'gone' : 'unverifiable';
    };

    const forget = (sessionId: string, pid: number, record: BackgroundProcessRecord): void => {
        const records = sessions.get(sessionId);
        if (records?.get(pid) !== record) return;
        records.delete(pid);
        if (records.size === 0) sessions.delete(sessionId);
    };

    const signal = (record: BackgroundProcessRecord, identity: 'root-alive' | 'orphan-group', sig: NodeJS.Signals): void => {
        if (record.processGroupId !== null) {
            kill(-record.processGroupId, sig);
            return;
        }
        // Only reachable for an unreaped root: the handle cannot address anything else.
        if (identity === 'root-alive') record.child.kill?.(sig);
    };

    const waitUntilGone = async (record: BackgroundProcessRecord, timeoutMs: number): Promise<boolean> => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const identity = identify(record);
            if (identity === 'gone' || identity === 'pid-reused') return true;
            if (Date.now() >= deadline) return false;
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
    };

    const stopOne = async (sessionId: string, record: BackgroundProcessRecord): Promise<BackgroundProcessCleanupItem | null> => {
        const item = (result: BackgroundProcessCleanupItem['result'], reason?: BackgroundProcessCleanupItem['reason']): BackgroundProcessCleanupItem => ({
            pid: record.pid, command: record.command, result, ...(reason ? { reason } : {}),
        });
        for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
            // Re-verified before every signal: the state may have moved during the grace period.
            const identity = identify(record);
            if (identity === 'gone') {
                forget(sessionId, record.pid, record);
                return sig === 'SIGTERM' ? null : item('stopped');
            }
            if (identity === 'pid-reused') {
                forget(sessionId, record.pid, record);
                logger.debug(`[background-processes] skip pid=${record.pid}: its pid now belongs to another process`);
                return sig === 'SIGTERM' ? item('skipped', 'pid-reused') : item('stopped');
            }
            if (identity === 'unverifiable') return item('failed', 'unverifiable');
            try {
                signal(record, identity, sig);
            } catch (error) {
                if (errorCode(error) !== 'ESRCH') {
                    logger.debug(`[background-processes] ${sig} refused pid=${record.pid}: ${errorCode(error) ?? String(error)}`);
                    return item('failed', 'signal-refused');
                }
            }
            if (await waitUntilGone(record, sig === 'SIGTERM' ? graceMs : killWaitMs)) {
                forget(sessionId, record.pid, record);
                return item('stopped');
            }
        }
        return item('failed', 'still-running');
    };

    const cleanNow = async (sessionId: string): Promise<BackgroundProcessCleanupResult> => {
        const records = [...(sessions.get(sessionId)?.values() ?? [])];
        const items = (await Promise.all(records.map((record) => stopOne(sessionId, record))))
            .filter((item): item is BackgroundProcessCleanupItem => item !== null);
        const result = {
            stopped: items.filter((item) => item.result === 'stopped').length,
            failed: items.filter((item) => item.result === 'failed').length,
            items,
        };
        logger.debug(`[background-processes] clean session=${sessionId} stopped=${result.stopped} failed=${result.failed} skipped=${items.length - result.stopped - result.failed}`);
        return result;
    };

    return {
        /**
         * Called right after spawn, from the code that spawned it. `ownProcessGroup`
         * is true only when that spawn created a new process group (POSIX detached).
         */
        record(input: { sessionId: string; child: RecordedChild; command: string; ownProcessGroup: boolean }): void {
            const pid = input.child.pid;
            if (!pid || pid === process.pid || pid === process.ppid) return;
            const record: BackgroundProcessRecord = {
                pid,
                processGroupId: input.ownProcessGroup && platform !== 'win32' ? pid : null,
                command: input.command.slice(0, COMMAND_PREVIEW_CHARS),
                child: input.child,
            };
            if (!rootAlive(record)) return;
            let records = sessions.get(input.sessionId);
            if (!records) {
                records = new Map();
                sessions.set(input.sessionId, records);
            }
            records.set(pid, record);
            input.child.once('exit', () => {
                // Kept only while it still leads a populated group of its own (or we cannot tell).
                const identity = identify(record);
                if (identity === 'gone' || identity === 'pid-reused') forget(input.sessionId, pid, record);
            });
        },

        /** Stops this session's recorded processes. Concurrent calls share one run. */
        clean(sessionId: string): Promise<BackgroundProcessCleanupResult> {
            const running = cleaning.get(sessionId);
            if (running) return running;
            const run = cleanNow(sessionId).finally(() => cleaning.delete(sessionId));
            cleaning.set(sessionId, run);
            return run;
        },

        /** The records currently held for a session (diagnostics and tests). */
        list(sessionId: string): BackgroundProcessRecord[] {
            return [...(sessions.get(sessionId)?.values() ?? [])];
        },
    };
}

export type SessionBackgroundProcesses = ReturnType<typeof createSessionBackgroundProcesses>;

/** One registry per session process; records are keyed by the session that spawned them. */
export const sessionBackgroundProcesses = createSessionBackgroundProcesses();

/**
 * Registers `${sessionId}:clean-background-processes` on a session's RPC scope.
 * The session id is fixed at registration: params are ignored, so a caller can
 * never reach another session's records through this method.
 */
export function registerCleanBackgroundProcessesHandler(
    rpc: { registerHandler: (method: string, handler: (params: unknown) => Promise<unknown>) => void },
    sessionId: string,
    registry: SessionBackgroundProcesses = sessionBackgroundProcesses,
): void {
    rpc.registerHandler(CLEAN_BACKGROUND_PROCESSES_METHOD, async () => registry.clean(sessionId));
}
