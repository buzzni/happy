/**
 * Windows: no console window from the console programs Happy starts.
 *
 * The daemon and every session it starts run detached (`spawnHappyCLI`), and on Windows `detached`
 * means DETACHED_PROCESS: the process has no console at all (its `windowsHide` cannot apply). A console
 * program such a process starts without `windowsHide` therefore gets a NEW, VISIBLE console window
 * (2026-11-24: cmd.exe windows flashing up during Saycode conversations). Any of the ~190 child-process
 * calls without `windowsHide`, in Happy or in a library it uses, could do it.
 *
 * `installWindowsHiddenConsoleDefault` makes `windowsHide: true` the default of every child_process
 * function in this process for console programs. A child given a hidden console passes it on, so the
 * console programs that child starts in turn (codex.exe starting an MCP server through cmd.exe) stay
 * hidden too. GUI programs (a browser, an editor) are left alone: `windowsHide` would start their
 * first window hidden. An explicit `windowsHide` always wins. Rules: docs/windows-child-processes.md.
 */
import childProcess from 'node:child_process';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { delimiter, extname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
const subsystems = new Map<string, number | null>();

/** The PE subsystem of an executable (2 = GUI, 3 = console), or null when it cannot be read. */
export function peSubsystem(file: string): number | null {
    const cached = subsystems.get(file);
    if (cached !== undefined) return cached;
    let subsystem: number | null = null;
    let fd: number | undefined;
    try {
        fd = openSync(file, 'r');
        const dos = Buffer.alloc(64);
        if (readSync(fd, dos, 0, 64, 0) === 64 && dos.readUInt16LE(0) === 0x5a4d) {
            // PE signature (4) + COFF header (20) + optional header up to Subsystem (68).
            const header = Buffer.alloc(94);
            const peOffset = dos.readUInt32LE(0x3c);
            if (readSync(fd, header, 0, 94, peOffset) === 94 && header.readUInt32LE(0) === 0x00004550) subsystem = header.readUInt16LE(92);
        }
    } catch {
        subsystem = null;
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
    subsystems.set(file, subsystem);
    return subsystem;
}

function isFile(file: string): boolean {
    try { return statSync(file).isFile(); } catch { return false; }
}

const resolutions = new Map<string, string | null>();

/** Where Windows would find `command` (current folder, then PATH, with PATHEXT like cross-spawn), or null. */
export function resolveWindowsCommand(command: string, cwd: string | undefined, env: NodeJS.ProcessEnv): string | null {
    const name = command.replace(/^"(.*)"$/, '$1');
    const base = cwd ?? process.cwd();
    const searchPath = env.PATH ?? env.Path ?? '';
    const key = `${name}\0${base}\0${searchPath}\0${env.PATHEXT ?? ''}`;
    const cached = resolutions.get(key);
    if (cached !== undefined) return cached;
    const extensions = extname(name) ? [''] : ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)];
    const directories = isAbsolute(name) || /[\\/]/.test(name) ? [base] : [base, ...searchPath.split(delimiter).filter(Boolean)];
    let found: string | null = null;
    for (const directory of directories) {
        found = extensions.map(extension => resolve(directory, name + extension)).find(isFile) ?? null;
        if (found) break;
    }
    resolutions.set(key, found);
    return found;
}

/** False only for a program known to be a GUI program; an unknown one is treated as a console program. */
export function startsConsoleProgram(command: string, options: { shell?: unknown; cwd?: unknown; env?: NodeJS.ProcessEnv }): boolean {
    if (options.shell) return true;
    const resolved = resolveWindowsCommand(command, typeof options.cwd === 'string' ? options.cwd : undefined, options.env ?? process.env);
    if (!resolved) return true;
    if (!['.exe', '.com'].includes(extname(resolved).toLowerCase())) return true;
    return peSubsystem(resolved) !== IMAGE_SUBSYSTEM_WINDOWS_GUI;
}

type Options = Record<string, unknown>;
const isOptions = (value: unknown): value is Options => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The arguments of one child_process call with `windowsHide: true` added where it applies.
 * `kind` says where the options go: after an optional args array ('file') or right after the command ('shell').
 */
export function withWindowsHideDefault(kind: 'file' | 'shell', args: unknown[]): unknown[] {
    const command = args[0];
    if (typeof command !== 'string') return args;
    const index = kind === 'file' && (Array.isArray(args[1]) || (args[1] == null && args.length > 2)) ? 2 : 1;
    const given = args[index];
    if (isOptions(given) && given.windowsHide !== undefined) return args;
    if (kind === 'file' && !startsConsoleProgram(command, isOptions(given) ? given : {})) return args;
    const next = [...args];
    if (given == null || isOptions(given)) next[index] = { ...(isOptions(given) ? given : {}), windowsHide: true };
    else next.splice(index, 0, { windowsHide: true }); // a callback where the options would be
    return next;
}

let installed = false;

/** Windows only, once per process: see the file header. */
export function installWindowsHiddenConsoleDefault(): void {
    if (process.platform !== 'win32' || installed) return;
    installed = true;
    const target = childProcess as unknown as Record<string, (...args: unknown[]) => unknown>;
    const wrap = (name: string, kind: 'file' | 'shell') => {
        const original = target[name];
        if (typeof original !== 'function') return;
        const wrapped = function (this: unknown, ...args: unknown[]) { return original.apply(this, withWindowsHideDefault(kind, args)); };
        const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(original);
        // util.promisify(execFile/exec) uses this (it resolves to { stdout, stderr }): through the default too.
        const custom = (original as unknown as Record<symbol, unknown>)[promisify.custom];
        if (typeof custom === 'function') {
            descriptors[promisify.custom] = { value: (...args: unknown[]) => custom(...withWindowsHideDefault(kind, args)) };
        }
        Object.defineProperties(wrapped, descriptors);
        target[name] = wrapped;
    };
    for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) wrap(name, 'file');
    for (const name of ['exec', 'execSync']) wrap(name, 'shell');
    // Named ESM imports of node:child_process see the replacements too.
    syncBuiltinESMExports();
}
