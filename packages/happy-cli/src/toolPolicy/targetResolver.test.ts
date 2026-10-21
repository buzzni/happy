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
                '/bin/ps -o lstart= -p 26977': 'Wed Oct 22 01:00:00 2026\n',
                '/usr/bin/lsappinfo find pid=26977': 'ASN:0x0-0xf20f2-"Finder":\n',
                '/usr/bin/lsappinfo info -only bundleid -only name -only pid ASN:0x0-0xf20f2-"Finder":': FINDER_INFO,
            }, calls),
        });
        await expect(resolver.resolve({ kind: 'pid', pid: 26977 })).resolves.toEqual({ status: 'resolved', app: { bundleId: 'com.apple.finder', name: 'Finder', pid: 26977 } });
        expect(calls).toHaveLength(3);
        await resolver.resolve({ kind: 'pid', pid: 26977 });
        expect(calls.slice(3)).toEqual(['/bin/ps -o lstart= -p 26977']);
        t = 30_000;
        await resolver.resolve({ kind: 'pid', pid: 26977 });
        expect(calls).toHaveLength(7);
    });

    // Cross review #3: Notes quits, Terminal gets its pid inside the cache window.
    it('does not reuse a cached pid once a different process holds it', async () => {
        const outputs: Record<string, string> = {
            '/bin/ps -o lstart= -p 500': 'Wed Oct 22 01:00:00 2026\n',
            '/usr/bin/lsappinfo find pid=500': 'ASN:0x0-0x1:\n',
            '/usr/bin/lsappinfo info -only bundleid -only name -only pid ASN:0x0-0x1:': '"CFBundleIdentifier"="com.apple.Notes"\n"LSDisplayName"="Notes"\n',
        };
        const resolver = createTargetResolver({ platform: 'darwin', now: () => 0, exec: fakeExec(outputs) });
        await expect(resolver.resolve({ kind: 'pid', pid: 500 })).resolves.toMatchObject({ app: { bundleId: 'com.apple.Notes' } });
        outputs['/bin/ps -o lstart= -p 500'] = 'Wed Oct 22 01:00:05 2026\n';
        outputs['/usr/bin/lsappinfo info -only bundleid -only name -only pid ASN:0x0-0x1:'] = '"CFBundleIdentifier"="com.apple.Terminal"\n"LSDisplayName"="Terminal"\n';
        await expect(resolver.resolve({ kind: 'pid', pid: 500 })).resolves.toMatchObject({ app: { bundleId: 'com.apple.Terminal' } });
        // A pid whose start time cannot be read is never served from the cache.
        delete outputs['/bin/ps -o lstart= -p 500'];
        delete outputs['/usr/bin/lsappinfo find pid=500'];
        await expect(resolver.resolve({ kind: 'pid', pid: 500 })).resolves.toEqual({ status: 'unresolved' });
    });

    it('keeps Windows pid lookups for 5 seconds only (no cheap start-time check)', async () => {
        const calls: string[] = [];
        let t = 0;
        const resolver = createTargetResolver({
            platform: 'win32',
            now: () => t,
            exec: fakeExec({ 'powershell.exe -NoProfile -NonInteractive -Command (Get-CimInstance Win32_Process -Filter "ProcessId=9").ExecutablePath': 'C:\\Windows\\notepad.exe\r\n' }, calls),
        });
        await resolver.resolve({ kind: 'pid', pid: 9 });
        t = 4_999;
        await resolver.resolve({ kind: 'pid', pid: 9 });
        expect(calls).toHaveLength(1);
        t = 5_000;
        await resolver.resolve({ kind: 'pid', pid: 9 });
        expect(calls).toHaveLength(2);
    });

    it('falls back to the executable for a pid with no app record', async () => {
        const resolver = createTargetResolver({
            platform: 'darwin',
            exec: fakeExec({ '/bin/ps -o lstart= -p 77': 'Wed Oct 22 01:00:00 2026\n', '/bin/ps -o comm= -p 77': '/usr/local/bin/node\n' }),
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

    // Cross review #9: 제약 "성능" — p95 50 ms including the app lookup, measured on the real commands.
    it('decides a cached pid lookup within 50 ms at p95 on macOS', async () => {
        if (process.platform !== 'darwin') return;
        const resolver = createTargetResolver();
        await expect(resolver.resolve({ kind: 'pid', pid: process.pid })).resolves.toMatchObject({ status: 'resolved' });
        const samples: number[] = [];
        for (let i = 0; i < 100; i++) {
            const started = performance.now();
            await resolver.resolve({ kind: 'pid', pid: process.pid });
            samples.push(performance.now() - started);
        }
        samples.sort((a, b) => a - b);
        expect(samples[Math.floor(samples.length * 0.95)]).toBeLessThan(50);
    });
});
