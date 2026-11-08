import { constants as osConstants } from 'node:os';
import { PluginDirArgumentError } from './pluginsFromArgs';

export const PERSONAL_CLAUDE_AUTH_FAILURE = 'CLAUDE_PERSONAL_AUTH_NOT_VERIFIED';
export const ORGANIZATION_CLAUDE_AUTH_FAILURE = 'CLAUDE_ORGANIZATION_AUTH_NOT_VERIFIED';

export type ClaudeAuthCheckStage = 'initialize' | 'settings' | 'apply' | 'recheck';
export type ClaudeAuthCheckReason = 'timeout' | 'unsupported' | 'mismatch' | 'policy' | 'control_failed';

/** A sanitized pinned-credential refusal: the message stays the code; only fixed values say where and why. */
export class ClaudeAuthNotVerifiedError extends Error {
    constructor(code: string, readonly stage: ClaudeAuthCheckStage, readonly reason: ClaudeAuthCheckReason) { super(code); }
}

/**
 * What the user is told when Claude Code exits before its first SDK message (Desktop
 * specs/headless-standalone-server R21). The SDK's error already carries the child's stderr, but that
 * text can hold paths, env values or tokens, so only recognised failures get a specific sentence;
 * anything else gets a generic one that points at the machine's log, where the full error is.
 */
export const CLAUDE_STARTUP_TIMEOUT_NOTICE = 'Claude Code took too long to start on this machine, so the request was not sent. The account was not rejected. '
    + 'Send again; if this repeats, check this project\'s SessionStart hooks.';
export const CLAUDE_AUTH_CHECK_TIMEOUT_NOTICE = 'Claude Code did not answer the account check in time, so the request was not sent. The account was not rejected. Send again.';

export function describeClaudeLaunchFailure(error: unknown): string {
    if (error instanceof ClaudeAuthNotVerifiedError && error.reason === 'timeout') {
        return error.stage === 'initialize' ? CLAUDE_STARTUP_TIMEOUT_NOTICE : CLAUDE_AUTH_CHECK_TIMEOUT_NOTICE;
    }
    const text = error instanceof Error ? error.message : String(error);
    if (text === 'CAPACITY_WAIT_EXPIRED') return '조직 AI 계정의 빈자리를 30분 동안 기다렸습니다. 입력과 첨부를 확인한 뒤 다시 요청하거나 관리자에게 계정 상태를 확인해 주세요.';
    if (text === 'CAPACITY_ACTOR_REQUIRED' || text === 'CAPACITY_INPUT_PROOF_INVALID') return '요청한 사용자를 확인할 수 없어 실행을 멈췄습니다. 앱과 작업PC 실행기를 업데이트한 뒤 다시 요청해 주세요. 원래 입력과 첨부는 대화에 남아 있습니다.';
    if (/^CAPACITY_(DELIVERY_UNKNOWN|PROVIDER_EXIT_UNCONFIRMED|RECOVERY_REQUIRED)$/i.test(text)) return '이전 실행의 전달 또는 종료 상태를 확인할 수 없어 자동 재전송을 멈췄습니다. 원래 입력과 첨부는 유지됩니다. 조직 관리자에게 계정 복구 상태를 확인해 주세요.';
    if (text.startsWith('CAPACITY_')) return '조직 AI 계정의 사용 권한이나 실행 상태를 확인하지 못해 실행을 멈췄습니다. 원래 입력과 첨부는 유지됩니다. 계정 상태를 확인한 뒤 다시 요청해 주세요.';
    if (text === 'SETUP_TOKEN_START_WAIT_EXHAUSTED') return 'No organization Claude account became available after repeated checks. Ask your organization administrator to check the assigned accounts, then send again.';
    if (text === 'SETUP_TOKEN_START_UNAVAILABLE') return 'The organization Claude account could not be authorized to start. Ask your organization administrator to check the assigned accounts, then send again.';
    if (text === ORGANIZATION_CLAUDE_AUTH_FAILURE) return 'Organization Claude stopped because the assigned account or policy could not be verified. Check this machine’s CLI and assigned account, then send again.';
    if (text === PERSONAL_CLAUDE_AUTH_FAILURE) return 'Personal Claude stopped because the selected account or policy could not be verified. Check the account and send again.';
    if (error instanceof PluginDirArgumentError) {
        return `Claude Code could not start: ${text}. Start this session again with a valid --plugin-dir.`;
    }
    const code = (error as { code?: unknown } | null)?.code;
    if (/cannot be used with root\/sudo privileges/i.test(text)) {
        return 'Claude Code could not start: it refuses to run with permission prompts skipped as root. '
            + 'Run this machine\'s daemon as a regular user.';
    }
    if (code === 'ENOENT' || /\bENOENT\b/.test(text)) {
        return 'Claude Code could not start: its executable could not be found on this machine. Reinstall happy-cli on it.';
    }
    if (/your account is on hold/i.test(text)) {
        return 'Claude Code stopped: the Claude account this session uses is on hold. '
            + 'Check it at https://claude.ai/restricted, or switch this session to another Claude account, then send again.';
    }
    const signal = /terminated by signal (SIG[A-Z0-9]+)/.exec(text)?.[1] ?? signalOfExitCode(text);
    if (signal) {
        return `Claude Code could not start: it stopped unexpectedly (${signal}). Check this machine's daemon log.`;
    }
    return 'Claude Code could not start on this machine. Check this machine\'s daemon log for details.';
}

/** The SDK reports a child killed by signal N as "exited with code 128+N" (SIGTERM → 143). */
function signalOfExitCode(text: string): string | undefined {
    const code = Number(/exited with code (\d+)/.exec(text)?.[1]);
    if (!(code > 128 && code < 160)) return undefined;
    return Object.entries(osConstants.signals).find(([, number]) => number === code - 128)?.[0];
}

/**
 * Claude Code without a login on this machine still starts, then answers with a synthetic
 * "Not logged in · Please run /login" and an `is_error` result (claude-code 2.1.296). That says neither
 * which machine nor that the daemon's user is the one to sign in (Desktop specs/headless-standalone-server R36).
 */
export const CLAUDE_NOT_SIGNED_IN_NOTICE = 'Claude Code is not signed in on this machine. '
    + 'Sign in as the user that runs this machine\'s daemon (run `claude`, then /login) and send the message again.';

export function claudeNotSignedInNotice(result: { is_error?: unknown; result?: unknown }): string | null {
    return result.is_error === true && typeof result.result === 'string' && /^not logged in\b/i.test(result.result.trim())
        ? CLAUDE_NOT_SIGNED_IN_NOTICE
        : null;
}

/**
 * The stored OAuth token could not be refreshed for this turn. Unlike "Not logged in" a retry often
 * succeeds (concurrent refreshes, a busy keychain), so it is logged for diagnosis, not shown as a logout.
 */
export function isClaudeTokenRefreshFailure(result: { is_error?: unknown; result?: unknown }): boolean {
    return result.is_error === true && typeof result.result === 'string'
        && /oauth session expired and could not be refreshed/i.test(result.result);
}


/** Only a failed provider result is evidence; quoted assistant/tool text never is. */
export function isClaudeAuthenticationFailure(value: { type?: unknown; error?: unknown; is_error?: unknown; result?: unknown; errors?: unknown; subtype?: unknown }): boolean {
    if (value.type === 'assistant' && value.error === 'authentication_failed') return true;
    if (value.is_error !== true) return false;
    const texts = [value.result, ...(Array.isArray(value.errors) ? value.errors : [])];
    return texts.some(text => typeof text === 'string' && (/^not logged in\b/i.test(text.trim())
        || /oauth session expired and could not be refreshed/i.test(text)
        || /^(?:API Error: 401\b|Failed to authenticate\b)/i.test(text.trim())));
}

/** A failed refresh or generic 401 is not proof that the credential generation was revoked. */
export function isClaudeRevokedTokenFailure(value: Parameters<typeof isClaudeAuthenticationFailure>[0] & { message?: unknown }): boolean {
    if (!isClaudeAuthenticationFailure(value)) return false;
    const message = value.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    const texts = [value.result, ...(Array.isArray(value.errors) ? value.errors : []),
        ...content.flatMap(block => block?.type === 'text' ? [block.text] : [])];
    return texts.some(text => typeof text === 'string' && /\boauth (?:access )?token (?:has been )?revoked\b/i.test(text));
}
