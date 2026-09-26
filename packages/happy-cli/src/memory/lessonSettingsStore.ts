/**
 * Per-project lesson settings, with compare-and-set.
 *
 * `configure` writes the whole record, so without a revision a second window
 * holding a stale copy silently reverts the first window's "review off" or
 * lowered budget — a lost update that reads as the feature turning itself back
 * on. Every write therefore names the revision it believes it is replacing,
 * and a mismatch is refused rather than merged.
 *
 * These settings live on the host, not in CML: they govern host recall and proposal capture. Legacy budget fields remain
 * readable so older clients can safely coexist.
 * CML owns lessons and candidates.
 */
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

/** The one directory these files live in, under the daemon's home. */
export const LESSON_SETTINGS_DIR = 'lesson-host';

/**
 * Where a project's settings live.
 *
 * Exported because there are two consumers in two processes — the daemon's
 * supervisor and the provider session — and they must name the same file. They
 * did not: one hashed the project id, the other hex-encoded it, so a user
 * switching recall off in the UI wrote one file while every session kept
 * reading another. The feature looked like it ignored the setting entirely.
 *
 * A hash rather than the id itself: a project id is not a safe file name, and
 * an encoding that merely escapes it can still collide on a shared prefix.
 */
export function lessonSettingsPath(happyHomeDir: string, projectId: string): string {
    const digest = createHash('sha256').update(projectId).digest('hex').slice(0, 32);
    return join(happyHomeDir, LESSON_SETTINGS_DIR, `${digest}.json`);
}

/**
 * The last review outcome for a project, written by whichever process ran it.
 *
 * Separate from the settings file on purpose: settings are a
 * compare-and-set record a person edits, and this is a status the
 * proposal worker overwrites. Sharing the file would make every worker tick contend
 * with the UI's revision and lose.
 *
 * A file rather than a table: the worker and the UI are different processes on
 * one machine, so the status has to outlive the process that produced it, and
 * this adds no store that did not already exist.
 */
export function lessonReviewOutcomePath(happyHomeDir: string, projectId: string): string {
    const digest = createHash('sha256').update(projectId).digest('hex').slice(0, 32);
    return join(happyHomeDir, LESSON_SETTINGS_DIR, `${digest}.outcome.json`);
}

const outcomeSchema = z.object({
    outcome: z.string().min(1).max(64),
    /** Which rule refused the turn, for diagnosis; never shown as the status. */
    reason: z.string().min(1).max(64).optional(),
    at: z.number().int().nonnegative(),
}).strict();

export type LessonReviewStatus = z.infer<typeof outcomeSchema>;

/**
 * How long a recorded outcome is still worth reporting.
 *
 * Past this the answer is `unknown`, not the stale word: an outcome from last
 * week says nothing about whether review is working now, and showing it as
 * current would be an invention.
 */
export const LESSON_REVIEW_OUTCOME_TTL_MS = 24 * 60 * 60_000;

export interface LessonReviewOutcomeStore {
    /** `'unknown'` when nothing was recorded, unreadable, or too old. */
    read(): Promise<string>;
    record(outcome: string, reason?: string): Promise<void>;
}

export function createLessonReviewOutcomeStore(
    path: string,
    now: () => number = Date.now,
): LessonReviewOutcomeStore {
    return {
        async read() {
            try {
                const parsed = outcomeSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
                if (!parsed.success) return 'unknown';
                /*
                 * `unknown`, never `idle`. "Nothing has run" and "we cannot
                 * tell" are different answers, and reporting the second as the
                 * first tells a user the feature is fine when it may not be.
                 */
                return now() - parsed.data.at > LESSON_REVIEW_OUTCOME_TTL_MS ? 'unknown' : parsed.data.outcome;
            } catch {
                return 'unknown';
            }
        },
        async record(outcome, reason) {
            try {
                await mkdir(dirname(path), { recursive: true, mode: 0o700 });
                const temp = `${path}.${randomUUID()}.tmp`;
                const file = await open(temp, 'wx', 0o600);
                try {
                    await file.writeFile(JSON.stringify({
                        outcome: outcome.slice(0, 64),
                        ...(reason ? { reason: reason.slice(0, 64) } : {}),
                        at: now(),
                    }));
                    await file.sync();
                } finally {
                    await file.close();
                }
                await rename(temp, path);
            } catch {
                // Status is not worth failing a review over, and a lost write
                // reads back as `unknown` rather than as a wrong answer.
            }
        },
    };
}

/** The review ledger is machine-wide, not per project; one name for both processes. */
export function lessonReviewLedgerPath(happyHomeDir: string): string {
    return join(happyHomeDir, LESSON_SETTINGS_DIR, 'review-ledger.json');
}

export const LESSON_SETTINGS_INITIAL_REVISION = 1;

const settingsSchema = z.object({
    revision: z.number().int().positive(),
    recallEnabled: z.boolean(),
    reviewEnabled: z.boolean(),
    dailyMicroUsd: z.number().int().nonnegative().max(100_000_000),
    dailyTokens: z.number().int().nonnegative().max(1_000_000),
}).strict();

export type LessonSettings = z.infer<typeof settingsSchema>;

/** New projects use foreground lesson proposals by default. Existing explicit
 * settings, including review off and gateway budgets, remain unchanged. */
export const LESSON_SETTINGS_DEFAULT: LessonSettings = {
    revision: LESSON_SETTINGS_INITIAL_REVISION,
    recallEnabled: true,
    reviewEnabled: true,
    dailyMicroUsd: 0,
    dailyTokens: 0,
};

/**
 * A settings file that exists but cannot be read as settings.
 *
 * Distinct from "no file yet" on purpose. Falling back to the defaults on a
 * corrupt or unreadable file would turn recall back on for a user who switched
 * it off, and reset the revision to 1 — which is the CAS fence, so every stale
 * window would suddenly match again. Neither is a safe guess, so the store
 * refuses and the callers report it without disturbing the conversation.
 */
export class LessonSettingsError extends Error {
    readonly reason = 'settings_unreadable';
    constructor() {
        super('lesson settings are unreadable');
        this.name = 'LessonSettingsError';
    }
}

export type LessonSettingsWrite =
    | { ok: true; settings: LessonSettings }
    | { ok: false; reason: 'revision_conflict' | 'invalid_request' | 'settings_unreadable' | 'runtime_error' };

export interface LessonSettingsStore {
    read(): Promise<LessonSettings>;
    write(input: {
        expectedRevision: number;
        recallEnabled: boolean;
        reviewEnabled: boolean;
        dailyMicroUsd: number;
        dailyTokens: number;
    }): Promise<LessonSettingsWrite>;
}

export function createLessonSettingsStore(path: string): LessonSettingsStore {
    async function load(): Promise<LessonSettings> {
        let raw: string;
        try {
            raw = await readFile(path, 'utf8');
        } catch (error) {
            // Only "there is no file yet" is a default. A permissions error or
            // a disk failure is a file whose contents we do not know.
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return LESSON_SETTINGS_DEFAULT;
            throw new LessonSettingsError();
        }
        let parsed;
        try {
            parsed = settingsSchema.safeParse(JSON.parse(raw));
        } catch {
            throw new LessonSettingsError();
        }
        if (!parsed.success) throw new LessonSettingsError();
        return parsed.data;
    }

    return {
        read: load,
        async write(input) {
            // `expectedRevision` is the compare-and-set token, not a stored
            // field. Leaving it in would fail the strict schema and turn every
            // settings write into `invalid_request`.
            const { expectedRevision, ...values } = input;
            const next = settingsSchema.safeParse({ ...values, revision: LESSON_SETTINGS_INITIAL_REVISION });
            if (!next.success || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
                return { ok: false, reason: 'invalid_request' };
            }
            await mkdir(dirname(path), { recursive: true, mode: 0o700 });
            let lock: Awaited<ReturnType<typeof open>>;
            try {
                // Never steal a lock by guessing process liveness; a crashed
                // lock fails closed, matching the review budget ledger.
                lock = await open(`${path}.lock`, 'wx', 0o600);
            } catch {
                return { ok: false, reason: 'runtime_error' };
            }
            let temp: string | undefined;
            try {
                let current: LessonSettings;
                try {
                    current = await load();
                } catch (error) {
                    // Refuse to overwrite a file we could not read: its real
                    // contents may be stricter than what is being written.
                    return {
                        ok: false,
                        reason: error instanceof LessonSettingsError ? 'settings_unreadable' : 'runtime_error',
                    };
                }
                if (current.revision !== expectedRevision) {
                    return { ok: false, reason: 'revision_conflict' };
                }
                const settings: LessonSettings = { ...next.data, revision: current.revision + 1 };
                temp = `${path}.${randomUUID()}.tmp`;
                const file = await open(temp, 'wx', 0o600);
                try {
                    await file.writeFile(JSON.stringify(settings));
                    await file.sync();
                } finally {
                    await file.close();
                }
                await rename(temp, path);
                temp = undefined;
                return { ok: true, settings };
            } catch {
                return { ok: false, reason: 'runtime_error' };
            } finally {
                if (temp) await unlink(temp).catch(() => {});
                await lock.close();
                await unlink(`${path}.lock`).catch(() => {});
            }
        },
    };
}
