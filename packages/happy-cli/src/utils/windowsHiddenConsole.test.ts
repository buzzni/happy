import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { peSubsystem, startsConsoleProgram, withWindowsHideDefault } from './windowsHiddenConsole';

// docs/windows-child-processes.md — 2026-11-24: cmd.exe windows flashed up during Saycode conversations because the
// detached daemon and sessions have no console, so a console program started without windowsHide got a visible one.

const missing = 'happy-no-such-program-7f3a';
const callback = () => undefined;

describe('withWindowsHideDefault', () => {
    it('adds windowsHide wherever the options of each child_process signature go', () => {
        expect(withWindowsHideDefault('file', [missing])).toEqual([missing, { windowsHide: true }]);
        expect(withWindowsHideDefault('file', [missing, ['a']])).toEqual([missing, ['a'], { windowsHide: true }]);
        expect(withWindowsHideDefault('file', [missing, ['a'], { cwd: 'C:\\w' }])).toEqual([missing, ['a'], { cwd: 'C:\\w', windowsHide: true }]);
        expect(withWindowsHideDefault('file', [missing, { stdio: 'ignore' }])).toEqual([missing, { stdio: 'ignore', windowsHide: true }]);
        expect(withWindowsHideDefault('file', [missing, null, { stdio: 'pipe' }])).toEqual([missing, null, { stdio: 'pipe', windowsHide: true }]);
        expect(withWindowsHideDefault('file', [missing, callback])).toEqual([missing, { windowsHide: true }, callback]);
        expect(withWindowsHideDefault('file', [missing, ['a'], callback])).toEqual([missing, ['a'], { windowsHide: true }, callback]);
        expect(withWindowsHideDefault('shell', ['dir /b', callback])).toEqual(['dir /b', { windowsHide: true }, callback]);
        expect(withWindowsHideDefault('shell', ['dir /b', { cwd: 'C:\\w' }, callback])).toEqual(['dir /b', { cwd: 'C:\\w', windowsHide: true }, callback]);
    });

    it('leaves an explicit choice alone', () => {
        const shown = [missing, ['a'], { windowsHide: false }];
        expect(withWindowsHideDefault('file', shown)).toBe(shown);
        const hidden = ['dir', { windowsHide: true }];
        expect(withWindowsHideDefault('shell', hidden)).toBe(hidden);
    });
});

const windows = process.platform === 'win32';
const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');

describe.skipIf(!windows)('console or GUI program on Windows', () => {
    it('reads the PE subsystem of console and GUI programs', () => {
        expect(peSubsystem(join(system32, 'cmd.exe'))).toBe(3);
        expect(peSubsystem(join(system32, 'notepad.exe'))).toBe(2);
        expect(peSubsystem(join(system32, 'drivers', 'etc', 'hosts'))).toBeNull();
    });

    it('treats a GUI program as GUI and everything else (shell, scripts, unknown names) as a console program', () => {
        expect(startsConsoleProgram(join(system32, 'notepad.exe'), {})).toBe(false);
        expect(startsConsoleProgram('cmd.exe', {})).toBe(true);
        expect(startsConsoleProgram('node', {})).toBe(true);
        expect(startsConsoleProgram(join(system32, 'notepad.exe'), { shell: true })).toBe(true);
        expect(startsConsoleProgram(missing, {})).toBe(true);
        // A GUI program keeps its window: no default added.
        const gui = [join(system32, 'notepad.exe'), []];
        expect(withWindowsHideDefault('file', gui)).toBe(gui);
    });
});

describe.skipIf(!windows)('a detached Happy process starting cmd.exe on Windows', () => {
    const work = windows ? mkdtempSync(join(tmpdir(), 'happy-hidden-console-')) : '';
    afterAll(() => { if (work) rmSync(work, { recursive: true, force: true }); });

    /** Whether a top-level window with this title became visible within `seconds`. */
    function visibleWindow(title: string, seconds: number): boolean {
        const script = `Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class W { delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(P f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static bool Seen(string t) { bool seen = false; EnumWindows((h, l) => { var s = new StringBuilder(256); GetWindowText(h, s, 256);
    if (IsWindowVisible(h) && s.ToString().Contains(t)) seen = true; return !seen; }, IntPtr.Zero); return seen; } }
'@
$end = (Get-Date).AddSeconds(${seconds}); while ((Get-Date) -lt $end) { if ([W]::Seen('${title}')) { 'visible'; exit } ; Start-Sleep -Milliseconds 100 }; 'none'`;
        return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }).trim() === 'visible';
    }

    /**
     * Like a session spawnHappyCLI starts: detached, so no console; it starts cmd.exe without windowsHide.
     * cmd.exe leaves a marker, so "no window" can only mean a hidden one, never a session that did not get that far.
     */
    function detachedSession(title: string, installDefault: boolean): string {
        // No quotes for cmd.exe: Node escapes them as \" in the command line, which cmd.exe does not read.
        const session = join(work, `${title}.mjs`), marker = join(work, `${title}.ran`);
        if (/\s/.test(marker)) throw new Error('The temp folder must have no spaces for this test');
        writeFileSync(session, `import { spawn } from 'node:child_process';
${installDefault ? `const { installWindowsHiddenConsoleDefault } = await import(${JSON.stringify(pathToFileURL(join(__dirname, 'windowsHiddenConsole.ts')).href)});
installWindowsHiddenConsoleDefault();` : ''}
spawn('cmd.exe', ['/d', '/c', ${JSON.stringify(`title ${title} & echo ran>${marker} & ping -n 5 127.0.0.1 >nul`)}], { stdio: 'ignore' }).on('exit', () => process.exit(0));
`);
        spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', session], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        return marker;
    }

    it('shows a console window without the default: the case this guards', () => {
        const title = `happy-console-shown-${process.pid}`;
        const marker = detachedSession(title, false);
        expect(visibleWindow(title, 6)).toBe(true);
        expect(existsSync(marker)).toBe(true);
    }, 30_000);

    it('shows no console window with the default installed, and cmd.exe still runs', () => {
        const title = `happy-console-hidden-${process.pid}`;
        const marker = detachedSession(title, true);
        expect(visibleWindow(title, 6)).toBe(false);
        expect(existsSync(marker)).toBe(true);
    }, 30_000);

    it('keeps named imports and util.promisify working once installed', () => {
        const probe = join(work, 'probe.mjs');
        writeFileSync(probe, `import childProcess, { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const { installWindowsHiddenConsoleDefault } = await import(${JSON.stringify(pathToFileURL(join(__dirname, 'windowsHiddenConsole.ts')).href)});
const before = spawn;
installWindowsHiddenConsoleDefault();
const { stdout } = await promisify(execFile)('cmd.exe', ['/d', '/c', 'echo hi']);
process.stdout.write(JSON.stringify({ named: spawn === childProcess.spawn && spawn !== before, execFile: execFile === childProcess.execFile, stdout: stdout.trim() }));
`);
        const output = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', probe], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
        expect(JSON.parse(output)).toEqual({ named: true, execFile: true, stdout: 'hi' });
    }, 30_000);
});
