import { execFile } from 'node:child_process';

export function codexStartupHealth(platform = process.platform): Promise<'ready' | 'managed-preferences' | 'unavailable'> {
    if (platform !== 'darwin') {
        return Promise.resolve('unavailable');
    }
    // This only loads configuration. No thread is created or resumed, and no model is called.
    return new Promise(resolve => execFile('codex', ['app-server', '--print-startup-config'], {
        timeout: 3_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, encoding: 'utf8',
    }, (error, stdout) => {
        try {
            const report = JSON.parse(stdout);
            if (!error && typeof report?.appServerVersion === 'string' && Object.hasOwn(report, 'configRequirements')) return resolve('ready');
            // Match the structured startup report. A timeout, unsupported option or unrelated error cannot trigger a replacement.
            if (error && !error.killed && typeof error.code === 'number' && report?.error?.code === -32600
                && report.error.data?.reason === 'configLoad' && report.error.data?.detail === 'Failed to synchronize managed preferences') {
                return resolve('managed-preferences');
            }
        } catch { /* No startup report from this CLI. */ }
        resolve('unavailable');
    }));
}
