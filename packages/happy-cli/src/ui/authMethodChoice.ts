import type { AuthMethod } from './ink/AuthSelector';

/**
 * Without a terminal the Ink selector cannot read keys and crashes, so print the
 * pairing code (the mobile flow) and wait for approval instead
 * (aplus-dev-studio-desktop specs/headless-standalone-server T15a).
 */
export function authMethodWithoutPrompt(stdinIsTTY: boolean | undefined): AuthMethod | null {
    return stdinIsTTY === true ? null : 'mobile';
}
