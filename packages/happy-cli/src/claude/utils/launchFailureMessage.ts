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
