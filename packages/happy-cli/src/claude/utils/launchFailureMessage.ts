/**
 * What the user is told when Claude Code exits before its first SDK message (Desktop
 * specs/headless-standalone-server R21). The SDK's error already carries the child's stderr, but that
 * text can hold paths, env values or tokens, so only recognised failures get a specific sentence;
 * anything else gets a generic one that points at the machine's log, where the full error is.
 */
export function describeClaudeLaunchFailure(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: unknown } | null)?.code;
    if (/cannot be used with root\/sudo privileges/i.test(text)) {
        return 'Claude Code could not start: it refuses to run with permission prompts skipped as root. '
            + 'Run this machine\'s daemon as a regular user.';
    }
    if (code === 'ENOENT' || /\bENOENT\b/.test(text)) {
        return 'Claude Code could not start: its executable could not be found on this machine. Reinstall happy-cli on it.';
    }
    const signal = /terminated by signal (SIG[A-Z0-9]+)/.exec(text)?.[1];
    if (signal) {
        return `Claude Code could not start: it stopped unexpectedly (${signal}). Check this machine's daemon log.`;
    }
    return 'Claude Code could not start on this machine. Check this machine\'s daemon log for details.';
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
