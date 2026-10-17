/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary strict-followup-plan F1 — stopping a deleted
 * project's native dev servers on the machine.
 *
 * The web server used to send this as a bash script (`server/projectDeleteNativeProcesses.ts`); a
 * strict machine refuses that, so the daemon runs the same judgement itself. The rules are the
 * script's, unchanged:
 * - A process is this project's only when the process-marker registry has a `bound` dev-server row
 *   for this project and machine, and the process's own environment markers match that row. A pid
 *   or a port alone proves nothing (pids and ports are reused).
 * - Each proven pid is signalled on its own, never its group, children before the wrapper, and is
 *   re-checked (still alive, same start time, same markers) right before every signal.
 * - Anything that cannot be proven is left alone and reported, never silently passed.
 */
import { readFile } from 'node:fs/promises';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The web's spawn markers (`web-ui/src/lib/spawn/markers.ts`, `types.ts`). */
const MARKER_ENV = {
    OWNER: 'APLUS_OWNER',
    MARKER_ID: 'APLUS_MARKER_ID',
    KIND: 'APLUS_SPAWN_KIND',
    VERSION: 'APLUS_MARKER_VERSION',
    LAUNCHED_AT: 'APLUS_LAUNCHED_AT',
} as const;
const MARKER_OWNER = 'aplus-dev-studio';
const MARKER_TIME_SKEW_MS = 60_000;
const TERM_GRACE_MS = 3_000;
const POLL_MS = 100;

export type NativeStopReason =
    | 'cleaned'
    | 'no-native-processes'
    | 'proc-unavailable'
    | 'registry-unreadable'
    | 'identity-unverified'
    | 'terminate-incomplete'
    | 'evidence-unavailable';

export type NativeStopResult = {
    reason: NativeStopReason;
    verified: number;
    unverified: number;
    pending: number;
    signalled: number;
    escalated: number;
};

export interface NativeProcessIo {
    /** The registry file's text; null when it does not exist. Throws when it cannot be read. */
    readRegistry(): Promise<string | null>;
    procAvailable(): boolean;
    pids(): number[] | null;
    environ(pid: number): Record<string, string> | null;
    stat(pid: number): { state: string; start: number } | null;
    kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
    sleep(ms: number): Promise<void>;
    now(): number;
    selfPid: number;
}

type Row = { markerId?: unknown; kind?: unknown; projectId?: unknown; machineId?: unknown; status?: unknown; launchedAt?: unknown; hostPid?: unknown };
type Target = { pid: number; start: number; host: boolean; row: Row };

function vouches(env: Record<string, string> | null, row: Row): boolean {
    if (!env) return false;
    if (env[MARKER_ENV.OWNER] !== MARKER_OWNER) return false;
    if (env[MARKER_ENV.MARKER_ID] !== row.markerId) return false;
    if (env[MARKER_ENV.KIND] !== row.kind) return false;
    if (env[MARKER_ENV.VERSION] !== '1') return false;
    const launched = Number(env[MARKER_ENV.LAUNCHED_AT]);
    const recorded = typeof row.launchedAt === 'number' ? row.launchedAt : Number.NaN;
    return Number.isFinite(launched) && Number.isFinite(recorded) && Math.abs(launched - recorded) <= MARKER_TIME_SKEW_MS;
}

export async function stopProjectNativeProcesses(
    input: { projectId: string; machineId: string; dryRun?: boolean },
    io: NativeProcessIo = defaultNativeProcessIo(),
): Promise<NativeStopResult> {
    const out: NativeStopResult = { reason: 'no-native-processes', verified: 0, unverified: 0, pending: 0, signalled: 0, escalated: 0 };
    const end = (reason: NativeStopReason): NativeStopResult => ({ ...out, reason });

    let raw: string | null;
    try {
        raw = await io.readRegistry();
    } catch {
        return end('registry-unreadable');
    }
    let rows: unknown = [];
    if (raw !== null) {
        try {
            rows = JSON.parse(raw);
        } catch {
            return end('registry-unreadable');
        }
    }
    if (!Array.isArray(rows)) return end('registry-unreadable');

    const mine = (rows as Row[]).filter((row) => row && row.projectId === input.projectId && row.machineId === input.machineId);
    out.pending = mine.filter((row) => row.kind === 'dev-server' && row.status === 'pending').length;
    const targets = mine.filter((row) => row.kind === 'dev-server' && row.status === 'bound');
    if (targets.length === 0 && out.pending === 0) return end('no-native-processes');
    if (!io.procAvailable()) return end('proc-unavailable');

    const live = (pid: number) => {
        const stat = io.stat(pid);
        return !!stat && stat.state !== 'Z' && stat.state !== 'X';
    };
    const scanned = io.pids();
    if (scanned === null) return end('proc-unavailable');
    const byRow = new Map<unknown, Target[]>();
    for (const pid of scanned) {
        if (pid === io.selfPid) continue;
        const env = io.environ(pid);
        if (!env || env[MARKER_ENV.OWNER] !== MARKER_OWNER) continue;
        const row = targets.find((target) => target.markerId === env[MARKER_ENV.MARKER_ID]);
        if (!row || !vouches(env, row)) continue;
        // Without a start time the re-check before the signal cannot run: not a target.
        const start = io.stat(pid)?.start;
        if (start === undefined) continue;
        const list = byRow.get(row.markerId) ?? [];
        list.push({ pid, start, host: row.hostPid === pid, row });
        byRow.set(row.markerId, list);
    }
    for (const list of byRow.values()) out.verified += list.length;
    for (const row of targets) {
        if ((byRow.get(row.markerId) ?? []).length > 0) continue;
        const hostPid = typeof row.hostPid === 'number' ? row.hostPid : 0;
        if (hostPid > 0 && live(hostPid)) out.unverified++;
    }
    if (input.dryRun) return end(out.unverified > 0 ? 'identity-unverified' : out.pending > 0 ? 'evidence-unavailable' : 'no-native-processes');

    const samePid = (target: Target) => live(target.pid) && io.stat(target.pid)?.start === target.start;
    const intact = (target: Target) => samePid(target) && vouches(io.environ(target.pid), target.row);
    const send = (target: Target, signal: 'SIGTERM' | 'SIGKILL') => {
        if (!intact(target)) return false;
        try {
            io.kill(target.pid, signal);
            return true;
        } catch {
            return false;
        }
    };
    // The wrapper goes last, or its children become orphans.
    const all = [...byRow.values()].flat().sort((a, b) => Number(a.host) - Number(b.host));
    for (const target of all) if (send(target, 'SIGTERM')) out.signalled++;
    let left = all.filter(samePid);
    const deadline = io.now() + TERM_GRACE_MS;
    while (left.length > 0 && io.now() < deadline) {
        await io.sleep(POLL_MS);
        left = left.filter(samePid);
    }
    for (const target of left) if (send(target, 'SIGKILL')) out.escalated++;
    if (left.length > 0) {
        await io.sleep(POLL_MS);
        left = left.filter(samePid);
    }

    if (left.length > 0) return end('terminate-incomplete');
    if (out.unverified > 0) return end('identity-unverified');
    if (out.pending > 0) return end('evidence-unavailable');
    if (out.signalled > 0 || out.escalated > 0) return end('cleaned');
    return end('no-native-processes');
}

/** Where the web's spawn commands keep the registry (`APLUS_DAEMON_STATE_DIR`, D7). */
export function processMarkerRegistryPath(env: Record<string, string | undefined> = process.env): string {
    return join(env.APLUS_DAEMON_STATE_DIR || join(homedir(), '.aplus-dev-studio', 'daemon-state'), 'process-markers.json');
}

export function defaultNativeProcessIo(procRoot = '/proc', registry = processMarkerRegistryPath()): NativeProcessIo {
    const statFields = (pid: number): string[] | null => {
        let text: string;
        try {
            text = readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
        } catch {
            return null;
        }
        // comm may hold spaces and parentheses: fields start after the last ")".
        const close = text.lastIndexOf(')');
        return close < 0 ? null : text.slice(close + 1).trim().split(/\s+/);
    };
    return {
        readRegistry: async () => {
            try {
                return await readFile(registry, 'utf8');
            } catch (error) {
                if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
                throw error;
            }
        },
        procAvailable: () => {
            try {
                return statSync(procRoot).isDirectory();
            } catch {
                return false;
            }
        },
        pids: () => {
            try {
                return readdirSync(procRoot).filter((name) => /^[0-9]+$/.test(name)).map(Number);
            } catch {
                return null;
            }
        },
        environ: (pid) => {
            let text: string;
            try {
                text = readFileSync(`${procRoot}/${pid}/environ`, 'utf8');
            } catch {
                return null;
            }
            const env: Record<string, string> = {};
            for (const pair of text.split('\0')) {
                const at = pair.indexOf('=');
                if (at > 0) env[pair.slice(0, at)] = pair.slice(at + 1);
            }
            return env;
        },
        stat: (pid) => {
            const fields = statFields(pid);
            if (!fields) return null;
            const start = Number(fields[19]);
            return Number.isFinite(start) ? { state: fields[0] ?? '', start } : null;
        },
        kill: (pid, signal) => { process.kill(pid, signal); },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => Date.now(),
        selfPid: process.pid,
    };
}
