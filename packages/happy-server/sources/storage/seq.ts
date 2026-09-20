import { db } from "@/storage/db";
import type { Prisma } from "@prisma/client";

type SeqClient = Pick<Prisma.TransactionClient, "account" | "session">;

function resolveClient(tx?: SeqClient) {
    return tx ?? db;
}

export async function allocateUserSeq(accountId: string) {
    const user = await db.account.update({
        where: { id: accountId },
        select: { seq: true },
        data: { seq: { increment: 1 } }
    });
    const seq = user.seq;
    return seq;
}

/**
 * Allocates `count` update seqs for one account in a single `Account.seq`
 * update, mirroring `allocateSessionSeqBatch`.
 *
 * Every writer for an account contends on that one row, so a caller that
 * emits N updates in a row should take its whole block at once instead of
 * taking (and releasing) the row lock N times. Deliberately not transaction
 * aware: the caller is expected to allocate outside any open transaction so
 * the row lock is not held for the transaction's lifetime.
 */
export async function allocateUserSeqBatch(accountId: string, count: number) {
    if (count <= 0) {
        return [] as number[];
    }
    const user = await db.account.update({
        where: { id: accountId },
        select: { seq: true },
        data: { seq: { increment: count } }
    });
    const endSeq = user.seq;
    const startSeq = endSeq - count + 1;
    return Array.from({ length: count }, (_, index) => startSeq + index);
}

export async function allocateSessionSeq(sessionId: string) {
    const session = await db.session.update({
        where: { id: sessionId },
        select: { seq: true },
        data: { seq: { increment: 1 } }
    });
    const seq = session.seq;
    return seq;
}

export async function allocateSessionEventSeq(sessionId: string) {
    const session = await db.session.update({
        where: { id: sessionId },
        select: { eventSeq: true },
        data: { eventSeq: { increment: 1 } }
    });
    return session.eventSeq;
}

export async function allocateSessionEventSeqBatch(sessionId: string, count: number, tx?: SeqClient) {
    if (count <= 0) {
        return [] as number[];
    }
    const client = resolveClient(tx);
    const session = await client.session.update({
        where: { id: sessionId },
        select: { eventSeq: true },
        data: { eventSeq: { increment: count } }
    });
    const endSeq = session.eventSeq;
    const startSeq = endSeq - count + 1;
    return Array.from({ length: count }, (_, index) => startSeq + index);
}

export async function allocateSessionSeqBatch(sessionId: string, count: number, tx?: SeqClient) {
    if (count <= 0) {
        return [] as number[];
    }

    const client = resolveClient(tx);
    const session = await client.session.update({
        where: { id: sessionId },
        select: { seq: true },
        data: { seq: { increment: count } }
    });

    const endSeq = session.seq;
    const startSeq = endSeq - count + 1;
    return Array.from({ length: count }, (_, index) => startSeq + index);
}
