/**
 * Which app a cua-driver call is about to act on, looked up at call time
 * (aplus-dev-studio specs/agent-tool-policy R5.1, 제약 "성능").
 *
 * - macOS: `lsappinfo find pid=<pid>` → ASN → `lsappinfo info` (bundle id, display name); a pid
 *   with no app record falls back to `ps -o comm=` (executable path). Frontmost: `lsappinfo front`.
 * - Windows: CIM `Win32_Process.ExecutablePath`. Frontmost is not resolved yet (→ unresolved).
 * - Linux: `/proc/<pid>/exe`.
 *
 * pid lookups are cached for 30 seconds, and a cached entry is used only while the pid still has
 * the same process start time (`ps -o lstart=`, one cheap exec) — a pid reused by another app
 * within the window is looked up again (R5.1 "그 시점에 조회"). Windows has no cheap start-time
 * probe (CIM costs as much as the lookup), so its entries live 5 seconds instead. Frontmost is never
 * cached. Anything slower than 2 seconds or failing is `unresolved`, which the decision turns into
 * `ask` (R3).
 */

import { execFile } from 'node:child_process';
import type { CuaTargetRequest, TargetResolution } from './evaluate';
import type { AppIdentity } from './rules';

export type ExecFileText = (file: string, args: string[], timeoutMs: number) => Promise<string>;

export interface TargetResolver {
    resolve(request: CuaTargetRequest): Promise<TargetResolution>;
}

export const TARGET_RESOLVE_DEADLINE_MS = 2000;
const PID_CACHE_MS = 30_000;
const WINDOWS_PID_CACHE_MS = 5_000;

export function createTargetResolver(options: {
    platform?: NodeJS.Platform;
    exec?: ExecFileText;
    now?: () => number;
    deadlineMs?: number;
} = {}): TargetResolver {
    const platform = options.platform ?? process.platform;
    const exec = options.exec ?? defaultExec;
    const now = options.now ?? Date.now;
    const deadlineMs = options.deadlineMs ?? TARGET_RESOLVE_DEADLINE_MS;
    const cache = new Map<number, { app: AppIdentity | null; at: number; started: string | null }>();

    const byPid = async (pid: number): Promise<AppIdentity | null> => {
        if (platform === 'win32') {
            const hit = cache.get(pid);
            if (hit && now() - hit.at < WINDOWS_PID_CACHE_MS) return hit.app;
            const app = await windowsAppByPid(exec, pid, deadlineMs);
            cache.set(pid, { app, at: now(), started: null });
            return app;
        }
        // Read the start time first: if the pid changes hands during the lookup, the next call sees a new one.
        const started = (await exec('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], deadlineMs)).trim() || null;
        const hit = cache.get(pid);
        if (hit && started && hit.started === started && now() - hit.at < PID_CACHE_MS) return hit.app;
        const app = platform === 'darwin' ? await macAppByPid(exec, pid, deadlineMs) : await linuxAppByPid(exec, pid, deadlineMs);
        if (started) cache.set(pid, { app, at: now(), started });
        else cache.delete(pid);
        return app;
    };

    const lookup = async (request: CuaTargetRequest): Promise<AppIdentity | null> => {
        switch (request.kind) {
            case 'launch': return request.app;
            case 'pid': return byPid(request.pid);
            case 'frontmost': return platform === 'darwin' ? macFrontmost(exec, deadlineMs) : null;
            default: return null;
        }
    };

    return {
        resolve: async (request) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), deadlineMs); });
            try {
                const app = await Promise.race([lookup(request).catch(() => null), deadline]);
                return app ? { status: 'resolved', app } : { status: 'unresolved' };
            } finally {
                clearTimeout(timer);
            }
        },
    };
}

async function macAppByPid(exec: ExecFileText, pid: number, timeoutMs: number): Promise<AppIdentity | null> {
    const asn = (await exec('/usr/bin/lsappinfo', ['find', `pid=${pid}`], timeoutMs)).trim();
    if (asn.startsWith('ASN:')) {
        const app = parseLsappinfoInfo(await exec('/usr/bin/lsappinfo', ['info', '-only', 'bundleid', '-only', 'name', '-only', 'pid', asn], timeoutMs));
        if (app) return { ...app, pid };
    }
    const executable = (await exec('/bin/ps', ['-o', 'comm=', '-p', String(pid)], timeoutMs)).trim();
    return executable ? { pid, executable, name: executable.split('/').pop() } : null;
}

async function macFrontmost(exec: ExecFileText, timeoutMs: number): Promise<AppIdentity | null> {
    const asn = (await exec('/usr/bin/lsappinfo', ['front'], timeoutMs)).trim();
    if (!asn.startsWith('ASN:')) return null;
    return parseLsappinfoInfo(await exec('/usr/bin/lsappinfo', ['info', '-only', 'bundleid', '-only', 'name', '-only', 'pid', asn], timeoutMs));
}

/** `"CFBundleIdentifier"="com.apple.finder"` / `"LSDisplayName"="Finder"` / `"pid"=26977`; `[ NULL ]` is absent. */
export function parseLsappinfoInfo(output: string): AppIdentity | null {
    const field = (key: string): string | undefined => {
        const match = new RegExp(`"${key}"=(?:"([^"]*)"|(\\d+))`).exec(output);
        return match ? match[1] ?? match[2] : undefined;
    };
    const bundleId = field('CFBundleIdentifier');
    const name = field('LSDisplayName');
    const pid = field('pid');
    if (!bundleId && !name) return null;
    return {
        ...(bundleId ? { bundleId } : {}),
        ...(name ? { name } : {}),
        ...(pid ? { pid: Number(pid) } : {}),
    };
}

async function windowsAppByPid(exec: ExecFileText, pid: number, timeoutMs: number): Promise<AppIdentity | null> {
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ExecutablePath`;
    const executable = (await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], timeoutMs)).trim();
    return executable ? { pid, executable, name: executable.split('\\').pop() } : null;
}

async function linuxAppByPid(exec: ExecFileText, pid: number, timeoutMs: number): Promise<AppIdentity | null> {
    const executable = (await exec('readlink', ['-f', `/proc/${pid}/exe`], timeoutMs)).trim();
    return executable ? { pid, executable, name: executable.split('/').pop() } : null;
}

const defaultExec: ExecFileText = (file, args, timeoutMs) => new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
        resolve(error ? '' : stdout);
    });
});
