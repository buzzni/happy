import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { spawnHappyCLI } from '@/utils/spawnHappyCLI';

import { buildResumeLaunch, formatResumeHelp, handleResumeCommand, parseResumeCommandArgs } from './handleResumeCommand';
import { resolveHappySession } from './resolveHappySession';

vi.mock('@/utils/spawnHappyCLI', () => ({ spawnHappyCLI: vi.fn() }));
vi.mock('./resolveHappySession', () => ({ resolveHappySession: vi.fn() }));

describe('handleResumeCommand', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('starts the resumed session host without the calling session\'s scope', async () => {
        // Run from an agent shell, `happy resume <B>` would otherwise hand session A's
        // agent grant, checkpoint binding and connector grant to session B's runner.
        vi.stubEnv('SAYCODE_AGENT_ROOT', '/session-a');
        vi.stubEnv('HAPPY_CHECKPOINT_SPAWN_CONTEXT', '{"projectId":"a"}');
        vi.stubEnv('HAPPY_APLUS_MCP_CALLER_GRANT', 'session-a-grant');
        vi.stubEnv('HAPPY_HOME_DIR', '/home/u/.happy');
        vi.mocked(resolveHappySession).mockResolvedValue({
            id: 'session-b', active: false, metadata: { path: tmpdir(), flavor: 'codex', codexThreadId: 'thread-b' } as never,
        });
        const child = new EventEmitter();
        vi.mocked(spawnHappyCLI).mockImplementation(() => {
            queueMicrotask(() => child.emit('exit', 0, null));
            return child as never;
        });

        await handleResumeCommand(['session-b']);

        const env = vi.mocked(spawnHappyCLI).mock.calls[0][1]?.env ?? {};
        expect(env.HAPPY_HOME_DIR).toBe('/home/u/.happy');
        expect(env).not.toHaveProperty('SAYCODE_AGENT_ROOT');
        expect(env).not.toHaveProperty('HAPPY_CHECKPOINT_SPAWN_CONTEXT');
        expect(env).not.toHaveProperty('HAPPY_APLUS_MCP_CALLER_GRANT');
    });
});

describe('parseResumeCommandArgs', () => {
    it('parses the happy session id', () => {
        expect(parseResumeCommandArgs(['cmmij8olq00dp5jcxr3wtbpau'])).toEqual({
            showHelp: false,
            sessionId: 'cmmij8olq00dp5jcxr3wtbpau',
        });
    });

    it('recognizes help flags', () => {
        expect(parseResumeCommandArgs(['--help'])).toEqual({
            showHelp: true,
            sessionId: '',
        });
    });

    it('rejects missing session ids', () => {
        expect(() => parseResumeCommandArgs([])).toThrow(
            'Happy session ID is required: happy resume <session-id>',
        );
    });
});

describe('buildResumeLaunch', () => {
    it('starts an execution-bound Claude session only when the daemon proves no provider start was submitted', () => {
        const session = { id: 'machine-session', active: true, metadata: { path: '/project', host: 'box', flavor: 'claude' } } as any;
        expect(() => buildResumeLaunch(session)).toThrow('missing its Claude session ID');
        expect(buildResumeLaunch(session, { startedBy: 'daemon', emptyMachineClaudeSession: { sessionId: 'machine-session', serverSeq: 0, processedSeq: 0, startNeverSubmitted: true } }).args).toEqual(['claude', '--started-by', 'daemon']);
        expect(buildResumeLaunch(session, { startedBy: 'daemon', emptyMachineClaudeSession: { sessionId: 'machine-session', serverSeq: 3, processedSeq: 0, startNeverSubmitted: true } }).args).toEqual(['claude', '--started-by', 'daemon']);
        expect(() => buildResumeLaunch(session, { startedBy: 'terminal', emptyMachineClaudeSession: { sessionId: 'machine-session', serverSeq: 0, processedSeq: 0, startNeverSubmitted: true } })).toThrow();
        expect(() => buildResumeLaunch(session, { startedBy: 'daemon', emptyMachineClaudeSession: { sessionId: 'another-session', serverSeq: 0, processedSeq: 0, startNeverSubmitted: true } })).toThrow();
    });

    it('starts Codex without a provider resume only for a daemon-confirmed unused Happy session', () => {
        const options = { startedBy: 'daemon' as const, emptyCodexSession: { serverSeq: 0, processedSeq: 0 } };
        expect(buildResumeLaunch({ id: 'unused', active: false, metadata: { path: '/chat', flavor: 'codex' } as never }, options)).toEqual({
            cwd: '/chat', args: ['codex', '--started-by', 'daemon'],
        });
    });

    it.each([{ serverSeq: 1, processedSeq: 0 }, { serverSeq: 0, processedSeq: 1 }, { serverSeq: -1, processedSeq: 0 }, { serverSeq: undefined, processedSeq: 0 }, { serverSeq: 0, processedSeq: Number.NaN }])('refuses a missing Codex thread when the session is not proven unused (%j)', emptyCodexSession => {
        const options = { startedBy: 'daemon' as const, emptyCodexSession };
        expect(() => buildResumeLaunch({ id: 'used', active: false, metadata: { path: '/chat', flavor: 'codex' } as never }, options)).toThrow('has no Codex thread to resume');
    });

    it('does not accept unused-session evidence for a terminal launch', () => {
        const options = { startedBy: 'terminal' as const, emptyCodexSession: { serverSeq: 0, processedSeq: 0 } };
        expect(() => buildResumeLaunch({ id: 'unused', active: false, metadata: { path: '/chat', flavor: 'codex' } as never }, options)).toThrow('has no Codex thread to resume');
    });

    it('builds a Codex resume command', () => {
        expect(buildResumeLaunch({
            id: 'session-1',
            active: false,
            metadata: {
                path: '/tmp/p1-control-flow',
                flavor: 'codex',
                codexThreadId: '019ccca5-726b-7c61-b914-16de27dfab6e',
                host: 'localhost',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.happy',
                happyLibDir: '/tmp/happy',
                happyToolsDir: '/tmp/happy/tools',
            },
        })).toEqual({
            cwd: '/tmp/p1-control-flow',
            args: ['codex', '--resume', '019ccca5-726b-7c61-b914-16de27dfab6e'],
        });
    });

    it('builds a Claude resume command', () => {
        expect(buildResumeLaunch({
            id: 'session-2',
            active: false,
            metadata: {
                path: '/tmp/repo',
                flavor: 'claude',
                claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
                host: 'localhost',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.happy',
                happyLibDir: '/tmp/happy',
                happyToolsDir: '/tmp/happy/tools',
            },
        })).toEqual({
            cwd: '/tmp/repo',
            args: ['claude', '--resume', '93a9705e-bc6a-406d-8dce-8acc014dedbd'],
        });
    });

    // A thread exists only after the first turn and is dropped on context reset,
    // so a missing ID does not by itself mean Codex failed to start.
    it('explains every way a Codex session can lack a thread instead of only naming the missing ID', () => {
        expect(() => buildResumeLaunch({
            id: 'session-4',
            active: false,
            metadata: {
                path: '/tmp/repo',
                flavor: 'codex',
                host: 'localhost',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.happy',
                happyLibDir: '/tmp/happy',
                happyToolsDir: '/tmp/happy/tools',
            },
        })).toThrow('Happy session session-4 has no Codex thread to resume (Codex never started a thread in it, or its context was reset). Start a new conversation.');
    });

    it('rejects unsupported flavors', () => {
        expect(() => buildResumeLaunch({
            id: 'session-3',
            active: false,
            metadata: {
                path: '/tmp/repo',
                flavor: 'gemini',
                host: 'localhost',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.happy',
                happyLibDir: '/tmp/happy',
                happyToolsDir: '/tmp/happy/tools',
            },
        })).toThrow('Happy session session-3 uses unsupported flavor "gemini".');
    });
});

describe('formatResumeHelp', () => {
    it('mentions the session id command shape', () => {
        expect(formatResumeHelp()).toContain('happy resume <happy-session-id>');
    });
});
