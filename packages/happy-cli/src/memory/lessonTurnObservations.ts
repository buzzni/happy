/**
 * What this host actually watched a turn do.
 *
 * The review worker needs evidence, and the only evidence it may use is what
 * the provider reported. A record assembled from the user's question alone
 * lets the reviewing model describe a procedure nobody performed — so
 * observations are collected here from real command events, and a turn with
 * none is refused before it costs anything.
 *
 * **Recovery** is narrow on purpose: the same command, in the same directory,
 * observed to exit non-zero and later observed to exit zero. Each part carries
 * its weight.
 *
 *  - *Observed to fail.* Two successes are not a recovery; nothing failed.
 *  - *The same command.* `npm test` failing and `npm --version` succeeding is
 *    not a recovery — the thing that failed was never made to work.
 *  - *The same directory.* A monorepo runs `npm test` in several packages; one
 *    passing is not evidence that another's failure was resolved.
 *  - *Exit status, not text.* Codex sends `exit_code: item.exitCode ?? null`,
 *    so `null` is genuinely unknown — cancelled, declined, still running. Only
 *    a numeric `0` verifies success and only a numeric non-zero verifies
 *    failure; anything else verifies nothing.
 *
 * Commands and output pass through the same redaction the review gateway uses
 * before being stored: a command line carries tokens, and output carries
 * whatever the tool printed.
 */
import { redactAutonomousGateText } from '@/daemon/autonomousQualityGateSafety';

const MAX_COMMANDS = 20;
const MAX_FAILURES = 6;
const MAX_COMMAND_CHARS = 200;
const MAX_FAILURE_CHARS = 300;
/** A parallel turn can have several commands open at once. */
const MAX_OPEN_CALLS = 64;

function clean(value: string, max: number): string {
    const redacted = redactAutonomousGateText(value).replace(/\s+/g, ' ').trim();
    return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
}

/** Codex may report a command as a string or as argv. */
function readCommand(command: unknown): string | null {
    if (typeof command === 'string') return command.trim() || null;
    if (Array.isArray(command)) {
        const parts = command.filter((part): part is string => typeof part === 'string');
        return parts.length > 0 ? (parts.join(' ').trim() || null) : null;
    }
    return null;
}

/**
 * What makes two runs "the same run": the command and the directory together.
 *
 * Either alone is too loose — the same text in two packages is two different
 * checks, and two different commands in one directory are not each other's
 * verification.
 */
function verificationKey(command: string, cwd: string | null): string {
    return JSON.stringify([command, cwd ?? '']);
}

export type LessonCommandOutcome = 'succeeded' | 'failed' | 'unverified';

/** Classifies an ended command from the provider's own status. */
export function classifyCommandExit(input: { exitCode?: unknown; status?: unknown }): LessonCommandOutcome {
    // `status` first: a cancelled command can still carry an exit code, and it
    // did not run to a conclusion anybody may learn from.
    if (typeof input.status === 'string' && input.status !== 'completed') return 'unverified';
    if (typeof input.exitCode !== 'number' || !Number.isFinite(input.exitCode)) return 'unverified';
    return input.exitCode === 0 ? 'succeeded' : 'failed';
}

export interface LessonTurnObservation {
    summary: string;
    recoveredFailures: readonly string[];
}

export interface LessonCommandStart {
    callId?: unknown;
    command?: unknown;
    cwd?: unknown;
}

export interface LessonCommandEnd extends LessonCommandStart {
    exitCode?: unknown;
    status?: unknown;
    output?: unknown;
    /** Legacy shape kept for callers that already classified the outcome. */
    failed?: boolean;
    detail?: unknown;
}

export interface LessonTurnObservations {
    /** `callId` pairs this with its end; parallel commands never cross. */
    commandStarted(input: LessonCommandStart | string): void;
    commandEnded(input: LessonCommandEnd): void;
    /** Reads and clears. A turn's observations belong to that turn only. */
    take(): LessonTurnObservation;
}

interface OpenCall {
    command: string;
    key: string;
}

export function createLessonTurnObservations(): LessonTurnObservations {
    /** Commands that reached a verified conclusion, for the summary. */
    let completed: string[] = [];
    let open = new Map<string, OpenCall>();
    /** Verified failures not yet made to work, keyed by command+directory. */
    let outstanding = new Map<string, string>();
    let recovered: string[] = [];
    /** Used only when an event carries no call id at all. */
    let lastAnonymous: OpenCall | null = null;

    function describe(input: LessonCommandStart): OpenCall | null {
        const command = readCommand(input.command);
        if (!command) return null;
        const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : null;
        return { command: clean(command, MAX_COMMAND_CHARS), key: verificationKey(command, cwd) };
    }

    return {
        commandStarted(input) {
            const start: LessonCommandStart = typeof input === 'string' ? { command: input } : input;
            const call = describe(start);
            if (!call) return;
            const callId = typeof start.callId === 'string' && start.callId ? start.callId : null;
            if (!callId) {
                lastAnonymous = call;
                return;
            }
            if (open.size >= MAX_OPEN_CALLS) return;
            open.set(callId, call);
        },
        commandEnded(input) {
            const callId = typeof input.callId === 'string' && input.callId ? input.callId : null;
            /*
             * Paired by id. A single "last started" slot mismatches every
             * parallel tool call, and a mismatched pair credits one command's
             * success to another command's failure.
             */
            const call = (callId ? open.get(callId) : null) ?? describe(input) ?? lastAnonymous;
            if (callId) open.delete(callId); else lastAnonymous = null;
            if (!call) return;

            const outcome = input.failed === undefined
                ? classifyCommandExit(input)
                : (input.failed ? 'failed' : 'succeeded');
            if (completed.length < MAX_COMMANDS) completed.push(`${call.command} → ${outcome}`);
            if (outcome === 'unverified') return;

            if (outcome === 'failed') {
                if (outstanding.size < MAX_FAILURES && !outstanding.has(call.key)) {
                    const raw = typeof input.output === 'string' ? input.output
                        : (typeof input.detail === 'string' ? input.detail : '');
                    const detail = raw ? clean(raw.split('\n')[0] ?? '', MAX_FAILURE_CHARS) : '';
                    outstanding.set(call.key, detail ? `${call.command} — ${detail}` : call.command);
                }
                return;
            }
            // A verified success clears only the failure of this exact command
            // in this exact directory.
            const cleared = outstanding.get(call.key);
            if (cleared === undefined) return;
            outstanding.delete(call.key);
            if (recovered.length < MAX_FAILURES) recovered.push(cleared);
        },
        take() {
            const observation: LessonTurnObservation = {
                // Outcomes, not just names: "ran a command" is not a fact about
                // whether anything worked.
                summary: completed.length > 0 ? `Commands run: ${completed.join('; ')}` : '',
                recoveredFailures: recovered,
            };
            completed = [];
            open = new Map();
            outstanding = new Map();
            recovered = [];
            lastAnonymous = null;
            return observation;
        },
    };
}
