import { createHash } from 'node:crypto';
import { db } from '@/storage/db';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function cohort() {
    const value = process.env.HAPPY_OBSERVATION_COHORT;
    return value && /^[a-zA-Z0-9._-]{1,128}$/.test(value) ? value : null;
}

/** Opt-in only after all legacy writers have drained. Rolling deployments must leave this unset. */
export function observationCapability() {
    return { resumableObservation: cohort() ? { version: 1, maxPageSize: 200, contract: 'committed-session-history-v1' } : null };
}

/** One repeatable-read snapshot binds the commit watermark, page and encryption generation; no plaintext custody. */
export async function readSessionObservation(accountId: string, sessionId: string, after: number, through: number | undefined, limit: number) {
    const selectedCohort = cohort();
    if (!selectedCohort) return { status: 503, body: { error: 'observation-unavailable' } };
    return db.$transaction(async tx => {
        const session = await tx.session.findFirst({ where: { id: sessionId, accountId }, select: {
            id: true, seq: true, createdAt: true, dataEncryptionKey: true,
        } });
        if (!session) return { status: 404, body: { error: 'Session not found' } };
        const upper = through ?? session.seq;
        if (upper > session.seq || after > upper) return { status: 409, body: { error: 'history-incomplete' } };
        const rows = await tx.sessionMessage.findMany({ where: { sessionId, seq: { gt: after, lte: upper } },
            orderBy: { seq: 'asc' }, take: limit + 1,
            select: { id: true, seq: true, content: true, localId: true, createdAt: true, updatedAt: true },
        });
        const body = {
            messages: rows.slice(0, limit).map(row => ({ ...row, createdAt: row.createdAt.getTime(), updatedAt: row.updatedAt.getTime(), contentRevision: digest(row.content) })),
            hasMore: rows.length > limit,
            observation: { version: 1, generation: digest([selectedCohort, session.id, session.createdAt, session.dataEncryptionKey]),
                coveredThroughSeq: upper, observedAt: Date.now(), retention: 'full', contract: 'committed-session-history-v1', responseFinality: 'unknown' },
        };
        if (Buffer.byteLength(JSON.stringify(body)) > 512 * 1024) return { status: 413, body: { error: 'observation-page-too-large' } };
        return { status: 200, body };
    }, { isolationLevel: 'RepeatableRead', timeout: 5000 });
}
