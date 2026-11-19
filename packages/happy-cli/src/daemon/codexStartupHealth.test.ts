import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexStartupHealth } from './codexStartupHealth';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.mocked(execFile).mockReset(); });

describe('Codex startup health', () => {
    const settingsFailure = JSON.stringify({ error: { code: -32600, data: { reason: 'configLoad', detail: 'Failed to synchronize managed preferences' } } });
    it.each([
        [null, JSON.stringify({ appServerVersion: '0.169', configRequirements: null }), 'ready'],
        [Object.assign(new Error('exit'), { code: 1 }), settingsFailure, 'managed-preferences'],
        [Object.assign(new Error('exit'), { code: 1 }), 'Failed to synchronize managed preferences', 'unavailable'],
        [Object.assign(new Error('exit'), { code: 2 }), 'unexpected argument --print-startup-config', 'unavailable'],
        [Object.assign(new Error('timeout'), { code: 1, killed: true }), settingsFailure, 'unavailable'],
    ] as const)('only reports a confirmed settings failure (%s)', async (error, response, status) => {
        vi.mocked(execFile).mockImplementation(((_file: unknown, _args: unknown, _options: unknown, callback: (error: unknown, output: string, stderr: string) => void) => {
            callback(error, response, '');
        }) as unknown as typeof execFile);
        await expect(codexStartupHealth('darwin')).resolves.toBe(status);
        expect(execFile).toHaveBeenCalledWith('codex', ['app-server', '--print-startup-config'], expect.objectContaining({ timeout: 3000 }), expect.any(Function));
    });
});
