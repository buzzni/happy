import { describe, expect, it } from 'vitest';
import { createTargetResolver, parseLsappinfoInfo, type ExecFileText } from './targetResolver';

const FINDER_INFO = '"CFBundleIdentifier"="com.apple.finder"\n"LSDisplayName"="Finder"\n"pid"=26977\n';

function fakeExec(outputs: Record<string, string>, calls: string[] = []): ExecFileText {
    return async (file, args) => {
        const command = [file, ...args].join(' ');
        calls.push(command);
        return outputs[command] ?? '';
    };
}

describe('target resolver', () => {
    it('parses lsappinfo info, treating [ NULL ] as absent', () => {
        expect(parseLsappinfoInfo(FINDER_INFO)).toEqual({ bundleId: 'com.apple.finder', name: 'Finder', pid: 26977 });
        expect(parseLsappinfoInfo('"CFBundleIdentifier"=[ NULL ] \n"LSDisplayName"=[ NULL ] \n')).toBeNull();
    });

    it('resolves a macOS pid through its ASN and caches it for 30 seconds', async () => {
        const calls: string[] = [];
        let t = 0;
        const resolver = createTargetResolver({
            platform: 'darwin',
            now: () => t,
            exec: fakeExec({
                '/usr/bin/lsappinfo find pid=26977': 'ASN:0x0-0xf20f2-"Finder":\n',
                '/usr/bin/lsappinfo info -only bundleid -only name -only pid ASN:0x0-0xf20f2-"Finder":': FINDER_INFO,
            }, calls),
        });
        await expect(resolver.resolve({ kind: 'pid', pid: 26977 })).resolves.toEqual({ status: 'resolved', app: { bundleId: 'com.apple.finder', name: 'Finder', pid: 26977 } });
        await resolver.resolve({ kind: 'pid', pid: 26977 });
        expect(calls).toHaveLength(2);
        t = 30_000;
        await resolver.resolve({ kind: 'pid', pid: 26977 });
        expect(calls).toHaveLength(4);
    });

    it('falls back to the executable for a pid with no app record', async () => {
        const resolver = createTargetResolver({
            platform: 'darwin',
            exec: fakeExec({ '/bin/ps -o comm= -p 77': '/usr/local/bin/node\n' }),
        });
        await expect(resolver.resolve({ kind: 'pid', pid: 77 })).resolves.toEqual({ status: 'resolved', app: { pid: 77, executable: '/usr/local/bin/node', name: 'node' } });
    });

    it('resolves the frontmost macOS app without caching it', async () => {
        const calls: string[] = [];
        const resolver = createTargetResolver({
            platform: 'darwin',
            exec: fakeExec({
                '/usr/bin/lsappinfo front': 'ASN:0x0-0xf20f2:\n',
                '/usr/bin/lsappinfo info -only bundleid -only name -only pid ASN:0x0-0xf20f2:': FINDER_INFO,
            }, calls),
        });
        await expect(resolver.resolve({ kind: 'frontmost' })).resolves.toMatchObject({ status: 'resolved', app: { bundleId: 'com.apple.finder' } });
        await resolver.resolve({ kind: 'frontmost' });
        expect(calls).toHaveLength(4);
    });

    it('resolves a Windows pid to its executable and leaves frontmost unresolved', async () => {
        const resolver = createTargetResolver({
            platform: 'win32',
            exec: fakeExec({ 'powershell.exe -NoProfile -NonInteractive -Command (Get-CimInstance Win32_Process -Filter "ProcessId=9").ExecutablePath': 'C:\\Windows\\System32\\cmd.exe\r\n' }),
        });
        await expect(resolver.resolve({ kind: 'pid', pid: 9 })).resolves.toEqual({ status: 'resolved', app: { pid: 9, executable: 'C:\\Windows\\System32\\cmd.exe', name: 'cmd.exe' } });
        await expect(resolver.resolve({ kind: 'frontmost' })).resolves.toEqual({ status: 'unresolved' });
    });

    it('gives up after the 2-second deadline (→ ask)', async () => {
        const resolver = createTargetResolver({
            platform: 'darwin',
            deadlineMs: 20,
            exec: () => new Promise(() => undefined),
        });
        const started = Date.now();
        await expect(resolver.resolve({ kind: 'pid', pid: 1 })).resolves.toEqual({ status: 'unresolved' });
        expect(Date.now() - started).toBeLessThan(1000);
    });

    it('needs no lookup for launch_app and cannot place a bare element token', async () => {
        const resolver = createTargetResolver({ platform: 'darwin', exec: fakeExec({}) });
        await expect(resolver.resolve({ kind: 'launch', app: { bundleId: 'com.apple.Notes' } })).resolves.toEqual({ status: 'resolved', app: { bundleId: 'com.apple.Notes' } });
        await expect(resolver.resolve({ kind: 'unknown' })).resolves.toEqual({ status: 'unresolved' });
    });

    it('looks up the real frontmost macOS app without hanging', async () => {
        if (process.platform !== 'darwin') return;
        const resolver = createTargetResolver();
        const started = performance.now();
        const result = await resolver.resolve({ kind: 'frontmost' });
        expect(performance.now() - started).toBeLessThan(500);
        expect(['resolved', 'unresolved']).toContain(result.status);
    });
});
