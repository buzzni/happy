import { describe, expect, it } from 'vitest';

import { buildResumeLaunch, formatResumeHelp, parseResumeCommandArgs } from './handleResumeCommand';

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
