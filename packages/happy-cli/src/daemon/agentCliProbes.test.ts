/**
 * aplus-dev-studio specs/work-machine-migration — the agent login and Codex
 * status Studio reads on page open, run as fixed programs instead of a
 * caller-supplied `bash` command.
 */
import { describe, expect, it, vi } from 'vitest';
import type { MetadataDeps } from './machineMetadataMethods';
import {
    AGENT_LOGIN_PROBE_SCRIPT, CLAUDE_LOGIN_PROBE_SCRIPT, createAgentLoginStatusHandler, createCodexCliStatusHandler,
} from './agentCliProbes';

type RunFile = MetadataDeps['runFile'];

describe('agent-login-status', () => {
    it('runs the fixed Claude probe with node, whatever command the caller sends, and answers like bash', async () => {
        const runFile = vi.fn<RunFile>(async () => ({ code: 0, stdout: '__AP_CLAUDE_BEGIN__\n{}\n__AP_CLAUDE_END__\n', stderr: '' }));
        const handler = createAgentLoginStatusHandler({ runFile, nodePath: '/usr/local/bin/node' });

        expect(await handler({ command: 'touch /tmp/pwned' })).toEqual({ success: true, stdout: '__AP_CLAUDE_BEGIN__\n{}\n__AP_CLAUDE_END__\n', stderr: '' });
        expect(runFile.mock.calls[0].slice(0, 2)).toEqual(['/usr/local/bin/node', ['-e', CLAUDE_LOGIN_PROBE_SCRIPT]]);

        await handler({ includeOtherAgents: true });
        expect(runFile.mock.calls[1][1]).toEqual(['-e', AGENT_LOGIN_PROBE_SCRIPT]);
        expect(AGENT_LOGIN_PROBE_SCRIPT.startsWith(CLAUDE_LOGIN_PROBE_SCRIPT)).toBe(true);
        expect(AGENT_LOGIN_PROBE_SCRIPT).toContain("run('codex', ['login', 'status'])");
    });

    it('is a script node can compile and that prints the markers Studio reads', () => {
        expect(() => new Function('require', AGENT_LOGIN_PROBE_SCRIPT)).not.toThrow();
        for (const marker of ["section('CLAUDE_MANAGED'", "section('CLAUDE_CREDENTIAL'", "section('CLAUDE'", "section('CODEX'", "section('GROK'"]) {
            expect(AGENT_LOGIN_PROBE_SCRIPT).toContain(marker);
        }
        expect(AGENT_LOGIN_PROBE_SCRIPT).toContain("'__AP_' + name + '_BEGIN__\\n'");
    });

    it('reports a probe that cannot start as a failed run', async () => {
        const handler = createAgentLoginStatusHandler({
            runFile: async () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); }, nodePath: 'node',
        });
        expect(await handler({})).toEqual({ success: false, stdout: '', stderr: 'spawn ENOENT' });
    });
});

describe('codex-cli-status', () => {
    it('answers version, login and models in the markers Studio reads', async () => {
        const runFile = vi.fn<RunFile>(async (_command, args) => {
            if (args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.50.0\nextra\n', stderr: '' };
            if (args[0] === 'login') return { code: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' };
            return { code: 0, stdout: '{"models":[]}\n', stderr: 'noise' };
        });
        const handler = createCodexCliStatusHandler({ runFile });

        const result = await handler({ command: 'rm -rf ~' });

        expect(runFile.mock.calls.map(([command, args]) => [command, ...args])).toEqual([
            ['codex', '--version'], ['codex', 'login', 'status'], ['codex', 'debug', 'models'],
        ]);
        expect(result).toEqual({
            success: true, stderr: '',
            stdout: '__AP_STATUS:installed\n__AP_VERSION:codex-cli 0.50.0\n__AP_LOGIN_BEGIN__\nLogged in using ChatGPT\n\n__AP_LOGIN_END__\n'
                + '__AP_MODELS_BEGIN__\n{"models":[]}\n\n__AP_MODELS_END__\n',
        });
    });

    it('answers a machine without codex', async () => {
        const handler = createCodexCliStatusHandler({ runFile: async () => { throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }); } });
        expect(await handler({})).toEqual({ success: true, stdout: '__AP_STATUS:not-installed\n', stderr: '' });
    });

    it('keeps going when one codex subcommand fails or hangs', async () => {
        const runFile = vi.fn<RunFile>(async (_command, args) => {
            if (args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.50.0\n', stderr: '' };
            if (args[0] === 'login') return { code: 1, stdout: 'Not logged in\n', stderr: '' };
            return { code: null, stdout: '', stderr: '' };
        });
        const result = await createCodexCliStatusHandler({ runFile })({});
        expect(result.stdout).toContain('__AP_LOGIN_BEGIN__\nNot logged in\n\n__AP_LOGIN_END__');
        expect(result.stdout).toContain('__AP_MODELS_BEGIN__\n\n__AP_MODELS_END__');
    });
});
