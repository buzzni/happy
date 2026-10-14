import { describe, expect, it } from 'vitest';
import { CLAUDE_NOT_SIGNED_IN_NOTICE, claudeNotSignedInNotice, describeClaudeLaunchFailure } from './launchFailureMessage';

// Desktop specs/headless-standalone-server R21: the user sees why Claude Code did not start, but
// never raw stderr — it can carry paths, env values or tokens.
describe('describeClaudeLaunchFailure', () => {
    it('names the root refusal and what to do', () => {
        const message = describeClaudeLaunchFailure(new Error('Claude Code process exited with code 1. stderr: --dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons'));
        expect(message).toMatch(/root/);
        expect(message).toMatch(/regular user/);
    });

    it('names a missing executable and a crash by signal', () => {
        expect(describeClaudeLaunchFailure(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }))).toMatch(/not installed|could not be found/);
        expect(describeClaudeLaunchFailure(new Error('Claude Code process terminated by signal SIGABRT. stderr: ASSERTION FAILED: MemoryExhaustion'))).toMatch(/stopped unexpectedly \(SIGABRT\)/);
    });

    it('falls back to a generic message and never echoes unknown stderr', () => {
        const message = describeClaudeLaunchFailure(new Error('Claude Code process exited with code 1. stderr: token=sk-ant-secret-value at /home/me/.claude'));
        expect(message).not.toMatch(/sk-ant|\/home\/me/);
        expect(message).toMatch(/could not start/);
        expect(describeClaudeLaunchFailure('weird')).toMatch(/could not start/);
    });
});

describe('claudeNotSignedInNotice', () => {
    it('explains a missing Claude login only for Claude Code\'s own failed answer', () => {
        expect(claudeNotSignedInNotice({ is_error: true, result: 'Not logged in · Please run /login' })).toBe(CLAUDE_NOT_SIGNED_IN_NOTICE);
        expect(claudeNotSignedInNotice({ is_error: false, result: 'Not logged in · Please run /login' })).toBeNull();
        expect(claudeNotSignedInNotice({ is_error: true, result: 'Failed to authenticate. API Error: 401' })).toBeNull();
        expect(claudeNotSignedInNotice({ is_error: true })).toBeNull();
    });
});
