/**
 * Resume-time credential decision (2026-07-23 incident follow-up).
 *
 * A resumed child must sync with the SAME account the session belongs to.
 * Two observed mismatch paths made the child 404 against happy-server:
 *  (a) user-credential sessions — the per-spawn staged HAPPY_HOME_DIR was
 *      deleted on child exit and never restored on resume, so the child fell
 *      back to the daemon's default credentials;
 *  (b) daemon re-login — the daemon preflights with the token captured at
 *      startup while the child reads the (possibly different-account)
 *      access.key currently on disk.
 * The decision below pins preflight and child to one identity, and refuses
 * to spawn a child that would sync under a different account.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/** Best-effort account subject from a JWT-shaped token; null when opaque. */
export function extractTokenSubject(token: string | null | undefined): string | null {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
        const subject = payload.sub ?? payload.userId ?? payload.uid ?? payload.accountId;
        return typeof subject === 'string' && subject.length > 0 ? subject : null;
    } catch {
        return null;
    }
}

export type ResumeCredentialDecision =
    | { kind: 'user-staged'; homeDir: string; token: string }
    | { kind: 'daemon'; token: string }
    | { kind: 'refuse'; reason: string };

export function decideResumeCredentials(input: {
    trackedUserHomeDir?: string;
    /** Token read back from the staged access.key; null when missing/unreadable. */
    stagedToken?: string | null;
    /** In-memory credentials captured at daemon startup. */
    daemonToken: string;
    /** Credentials the child would read from the default HAPPY home right now. */
    diskToken: string | null;
}): ResumeCredentialDecision {
    if (input.trackedUserHomeDir) {
        if (input.stagedToken) {
            return { kind: 'user-staged', homeDir: input.trackedUserHomeDir, token: input.stagedToken };
        }
        return {
            kind: 'refuse',
            reason: 'its staged user credentials are no longer available. Start a new session.',
        };
    }
    if (!input.diskToken) {
        return {
            kind: 'refuse',
            reason: 'daemon credentials are unreadable. Run `happy auth login` and restart the daemon.',
        };
    }
    const daemonSubject = extractTokenSubject(input.daemonToken);
    const diskSubject = extractTokenSubject(input.diskToken);
    const sameIdentity = daemonSubject !== null && diskSubject !== null
        ? daemonSubject === diskSubject
        : input.daemonToken === input.diskToken;
    if (!sameIdentity) {
        return {
            kind: 'refuse',
            reason: 'the credentials on disk now belong to a different account than when this session started. Restart the daemon or start a new session.',
        };
    }
    // Preflight must use the token the child will actually read (disk), not
    // the possibly-stale in-memory copy.
    return { kind: 'daemon', token: input.diskToken };
}

/** Read the token from a staged `<homeDir>/access.key`; null when missing/invalid. */
export async function readStagedTokenFromHomeDir(homeDir: string): Promise<string | null> {
    try {
        const raw = await fs.readFile(join(homeDir, 'access.key'), 'utf8');
        const parsed = JSON.parse(raw) as { token?: unknown };
        return typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : null;
    } catch {
        return null;
    }
}
