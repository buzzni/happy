/** The lesson a proposal revises, at the revision the proposer read. */
export type LessonUpdateTarget = { lessonId: string; revision: number };

/**
 * `undefined` only when the field is absent; `null` when present but malformed
 * (including an explicit null). A malformed target is refused, never dropped:
 * dropping it would file a revision as a second, near-duplicate lesson.
 */
export function readUpdateTarget(value: unknown): LessonUpdateTarget | null | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const { lessonId, revision } = value as Record<string, unknown>;
    if (typeof lessonId !== 'string' || lessonId.trim().length === 0 || lessonId.trim().length > 240) return null;
    if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return null;
    return { lessonId: lessonId.trim(), revision };
}
