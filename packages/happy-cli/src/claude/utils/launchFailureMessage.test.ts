import { describe, expect, it } from 'vitest';
import { CLAUDE_NOT_SIGNED_IN_NOTICE, isClaudeRevokedTokenFailure, isClaudeAuthenticationFailure, claudeNotSignedInNotice, describeClaudeLaunchFailure, isClaudeTokenRefreshFailure } from './launchFailureMessage';

// Desktop specs/headless-standalone-server R21: the user sees why Claude Code did not start, but
// never raw stderr — it can carry paths, env values or tokens.
describe('describeClaudeLaunchFailure', () => {
    it('explains a refused personal credential without treating it as a general startup failure', () => {
        expect(describeClaudeLaunchFailure(new Error('CLAUDE_PERSONAL_AUTH_NOT_VERIFIED'))).toMatch(/Personal Claude stopped.*account or policy/);
    });

    it('explains a refused organization credential without asking for a personal login', () => {
        const text = describeClaudeLaunchFailure(new Error('CLAUDE_ORGANIZATION_AUTH_NOT_VERIFIED'));
        expect(text).toMatch(/Organization Claude stopped.*assigned account or policy/);
        expect(text).not.toMatch(/Personal|\/login|token=/);
    });

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

// aplus-dev-studio specs/machine-session-readiness-hardening D2: a failed refresh is not a logout and
// must be findable in the session log.
describe('isClaudeTokenRefreshFailure', () => {
    it('recognises the failed OAuth refresh result', () => {
        expect(isClaudeTokenRefreshFailure({ is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' })).toBe(true);
    });
    it('ignores a successful result, a logout and other errors', () => {
        expect(isClaudeTokenRefreshFailure({ is_error: false, result: 'OAuth session expired and could not be refreshed' })).toBe(false);
        expect(isClaudeTokenRefreshFailure({ is_error: true, result: 'Not logged in · Please run /login' })).toBe(false);
        expect(isClaudeTokenRefreshFailure({ is_error: true, result: 'API Error: 401 authentication_error' })).toBe(false);
    });
});


 it('classifies provider authentication refusals without trusting normal output or arbitrary failures', () => {
  expect(isClaudeAuthenticationFailure({type:'assistant',error:'authentication_failed'})).toBe(true);
  expect(isClaudeAuthenticationFailure({is_error:true,errors:['API Error: 401 token expired']})).toBe(true);
  expect(isClaudeAuthenticationFailure({is_error:true,result:'Failed to authenticate. API Error: 401'})).toBe(true);
  expect(isClaudeAuthenticationFailure({is_error:false,result:'API Error: 401 example'})).toBe(false);
  expect(isClaudeAuthenticationFailure({is_error:true,result:'Tool failed: permission denied'})).toBe(false);
 });

it('requires explicit provider token revocation before permanently excluding an account', () => {
 expect(isClaudeRevokedTokenFailure({ is_error: true, result: 'Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.' })).toBe(true);
 expect(isClaudeRevokedTokenFailure({ type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Failed to authenticate: OAuth token revoked.' }] } })).toBe(true);
 expect(isClaudeRevokedTokenFailure({ type: 'assistant', error: 'authentication_failed' })).toBe(false);
 expect(isClaudeRevokedTokenFailure({ is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' })).toBe(false);
 expect(isClaudeRevokedTokenFailure({ is_error: true, result: 'API Error: 401 token expired' })).toBe(false);
 expect(isClaudeRevokedTokenFailure({ is_error: false, result: 'Failed to authenticate: OAuth token revoked.' })).toBe(false);
});
