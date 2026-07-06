import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecFile, mockExecFileAsync } = vi.hoisted(() => {
    const execFileAsync = vi.fn();
    const execFile = Object.assign(vi.fn(), {
        [Symbol.for('nodejs.util.promisify.custom')]: execFileAsync,
    });
    return {
        mockExecFile: execFile,
        mockExecFileAsync: execFileAsync,
    };
});

vi.mock('node:child_process', () => ({
    execFile: mockExecFile,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
    },
}));

import { readClaudeCodeUsage } from './readUsage';

const USAGE_RESULT = `You are currently using your subscription to power your Claude Code usage

Current session: 6% used · resets Jun 19, 2:40am (Asia/Seoul)
Current week (all models): 15% used · resets Jun 24, 12:59pm (Asia/Seoul)
Current week (Sonnet only): 2% used · resets Jun 24, 1pm (Asia/Seoul)`;

describe('readClaudeCodeUsage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockExecFileAsync.mockImplementation(async (_cmd: string, args: string[]) => {
            if (args[0] === '--version') {
                return { stdout: '1.0.88 (Claude Code)\n', stderr: '' };
            }
            if (args.join(' ') === 'auth status --json') {
                throw new Error('unknown command auth status');
            }
            if (args.join(' ') === '--print --output-format json /usage') {
                return {
                    stdout: JSON.stringify({
                        result: USAGE_RESULT,
                        usage: { input_tokens: 0, output_tokens: 0 },
                    }),
                    stderr: '',
                };
            }
            throw new Error(`unexpected claude args: ${args.join(' ')}`);
        });
    });

    it('treats successful /usage output as authenticated when legacy Claude Code lacks auth status json', async () => {
        const usage = await readClaudeCodeUsage();

        expect(usage.installed).toBe(true);
        expect(usage.authenticated).toBe(true);
        expect(usage.cliVersion).toBe('1.0.88');
        expect(usage.errorKind).toBeUndefined();
        expect(usage.window5h?.usedPct).toBe(6);
    });
});
