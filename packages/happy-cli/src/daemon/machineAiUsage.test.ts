/**
 * aplus-dev-studio specs/work-machine-migration — the AI usage Studio's chat
 * polls, read by a fixed script instead of a caller-supplied `bash` command.
 */
import { describe, expect, it, vi } from 'vitest';
import type { MetadataDeps } from './machineMetadataMethods';
import { createMachineAiUsageHandler, MACHINE_AI_USAGE_SCRIPT } from './machineAiUsage';

const payload = { claude: [{ id: '1', label: 'a@b' }], claudeError: null, codex: null, claudeWriterProtected: false };

function setup(runFile: MetadataDeps['runFile'], platform = 'darwin') {
    const spy = vi.fn(runFile);
    return { runFile: spy, handler: createMachineAiUsageHandler({ runFile: spy, nodePath: '/usr/local/bin/node', platform }) };
}

describe('machine-ai-usage', () => {
    it('runs the fixed usage script with node, whatever command the caller sends, and returns its answer', async () => {
        const { handler, runFile } = setup(async () => ({ code: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: '' }));

        expect(await handler({ command: 'touch /tmp/pwned' })).toEqual({ success: true, usage: payload });

        expect(runFile).toHaveBeenCalledTimes(1);
        const [command, args, options] = runFile.mock.calls[0];
        expect(command).toBe('/usr/local/bin/node');
        expect(args).toEqual(['-e', MACHINE_AI_USAGE_SCRIPT]);
        expect(options.timeoutMs).toBe(45_000);
        expect(Object.keys(options.env).length).toBeGreaterThan(0);
    });

    it('starts with the Claude writer protected only when asked', async () => {
        const { handler, runFile } = setup(async () => ({ code: 0, stdout: JSON.stringify(payload), stderr: '' }), 'win32');

        await handler({ protectClaude: true });
        await handler({ protectClaude: 'yes' });

        expect(runFile.mock.calls[0][1][1]).toContain('let enhancedClaude=true;');
        expect(runFile.mock.calls[0][2].timeoutMs).toBe(150_000);
        expect(runFile.mock.calls[1][1][1]).toBe(MACHINE_AI_USAGE_SCRIPT);
        expect(MACHINE_AI_USAGE_SCRIPT).toContain('let enhancedClaude=false;');
    });

    it('is a script node can compile', () => {
        expect(() => new Function('require', MACHINE_AI_USAGE_SCRIPT)).not.toThrow();
    });

    it('reports a script that fails, prints no JSON or cannot start', async () => {
        const failed = setup(async () => ({ code: 1, stdout: '', stderr: 'boom' }));
        expect(await failed.handler({})).toEqual({ success: false, errorCode: 'USAGE_FAILED', error: 'boom' });
        const garbled = setup(async () => ({ code: 0, stdout: 'not json', stderr: '' }));
        expect(await garbled.handler({})).toMatchObject({ success: false, errorCode: 'USAGE_FAILED' });
        const missing = setup(async () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); });
        expect(await missing.handler({})).toMatchObject({ success: false, errorCode: 'USAGE_FAILED' });
    });
});
