/**
 * Decide the cwd a freshly-spawned remote PTY should start in, with
 * defense-in-depth fallback to homedir when the requested directory
 * cannot be used. Pure — fs / validate are injected so the helper stays
 * test-friendly and the resulting decision is auditable.
 *
 * specs/remote-terminal-cwd-fallback/ Phase 1.
 *
 * Rationale: the web-ui calls `ensureDirectory` before terminal-open
 * (specs/project-workspace-auto-create/ Phase 3), but that call can be
 * swallowed silently — e.g. on older daemons without the RPC, or when
 * the requested path is outside the allowed root, or when the network
 * drops the RPC. When that happens the cwd reaches `pty.spawn()` and
 * `chdir(2)` fails with ENOENT, dumping `chdir(2) failed.: No such file
 * or directory` into the user's terminal. This helper guarantees the
 * cwd handed to node-pty always exists and is reachable.
 *
 * Decision order:
 *   1. No requested cwd       → homedir (no banner — expected case).
 *   2. validate() rejects     → homedir + fallback reason 'outside-root'.
 *                               mkdir is NOT attempted — keeping
 *                               validatePath's traversal defense intact.
 *   3. fsExists(resolved)     → use it (mkdir no-op skipped).
 *   4. fsMkdir(resolved) ok   → use it.
 *   5. fsMkdir throws         → homedir + fallback reason 'mkdir-failed'.
 *
 * The caller (apiMachine.terminal-open-fwd) is responsible for surfacing
 * the fallback to the user via a terminal-frame banner and the audit log.
 */

export type CwdFallbackReason = 'outside-root' | 'mkdir-failed';

export interface CwdDecision {
    cwd: string;
    fallback?: {
        requested: string;
        reason: CwdFallbackReason;
        error?: string;
    };
}

export interface DecideTerminalCwdInput {
    requested?: string;
    allowedRoot: string;
    homedir: string;
    fsExists: (path: string) => boolean;
    fsMkdir: (path: string) => void;
    validate: (path: string, root: string) => { valid: boolean; resolvedPath?: string; error?: string };
}

/**
 * Render the one-line dim-ANSI banner the user sees in xterm when the
 * spawn falls back. Kept pure (no socket / no log) so it can be tested
 * independently of the daemon's apiMachine wiring.
 *
 * Trailing `\r\n` ensures xterm starts the shell prompt on a fresh line.
 * The dim grey style (ESC[2m) communicates "informational, not an
 * error" so users don't mistake the fallback for a crash.
 */
export function formatCwdFallbackBanner(decision: CwdDecision): string | undefined {
    if (!decision.fallback) return undefined;
    const { requested } = decision.fallback;
    return `\x1b[2m[info] 요청한 작업 디렉토리(${requested})를 사용할 수 없어 ${decision.cwd}에서 시작합니다.\x1b[0m\r\n`;
}

export function decideTerminalCwd(input: DecideTerminalCwdInput): CwdDecision {
    const { requested, allowedRoot, homedir, fsExists, fsMkdir, validate } = input;

    if (!requested) {
        return { cwd: homedir };
    }

    const validation = validate(requested, allowedRoot);
    if (!validation.valid) {
        return {
            cwd: homedir,
            fallback: { requested, reason: 'outside-root', error: validation.error },
        };
    }

    const resolved = validation.resolvedPath ?? requested;

    if (fsExists(resolved)) {
        return { cwd: resolved };
    }

    try {
        fsMkdir(resolved);
        return { cwd: resolved };
    } catch (e) {
        return {
            cwd: homedir,
            fallback: {
                requested,
                reason: 'mkdir-failed',
                error: e instanceof Error ? e.message : String(e),
            },
        };
    }
}
