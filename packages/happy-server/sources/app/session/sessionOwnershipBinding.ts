import { randomUUID } from 'node:crypto';
import { Prisma, type SessionOwnershipBinding } from '@prisma/client';
import { z } from 'zod';
import { RotationOriginSchema, rotationDecodeBinary, SessionExecutionCreateBodySchema,
    sessionCreateBodyHash, sessionTagHash } from '@slopus/happy-wire';
import { SessionOwnershipProofSchema, ownershipDigest, ownershipFresh, verifyOwnership,
    OwnershipConfirmAssertionSchema, OwnershipLookupAssertionSchema, OwnershipMachineAssertionSchema,
    type SessionOwnershipProof, type OwnershipView } from '@session-ownership';
import { inTx, afterTx } from '@/storage/inTx';
import { eventRouter, buildNewSessionUpdate } from '@/app/events/eventRouter';
import { randomKeyNaked } from '@/utils/randomKeyNaked';
import { createExecutionBoundSession, verifySessionExecutionCreate } from '@/app/session/sessionExecutionBinding';

export class OwnershipError extends Error {
    constructor(readonly statusCode: 400 | 403 | 409 | 503, message: string) { super(message); }
}
const refuse = (): never => { throw new OwnershipError(403, 'Invalid ownership authority'); };
const conflict = (): never => { throw new OwnershipError(409, 'Ownership binding conflict'); };
function trust() {
    try {
        if (process.env.HAPPY_SESSION_OWNERSHIP_ENABLED !== '1') throw new Error();
        const issuer = RotationOriginSchema.parse(process.env.HAPPY_SESSION_OWNERSHIP_ISSUER);
        const audience = RotationOriginSchema.parse(process.env.HAPPY_SESSION_OWNERSHIP_AUDIENCE);
        const values = z.record(z.string().regex(/^[a-f0-9]{64}$/), z.string()).parse(
            JSON.parse(process.env.HAPPY_SESSION_OWNERSHIP_PUBLIC_KEYS ?? '{}'));
        const keys = new Map(Object.entries(values).map(([id, value]) => [id, rotationDecodeBinary(value, 32)]));
        if (!keys.size) throw new Error();
        return { issuer, audience, keys };
    } catch { throw new OwnershipError(503, 'Ownership trust unavailable'); }
}
export function ownershipEnabled() { try { trust(); return true; } catch { return false; } }
export function verifyOwnershipAssertion<T extends { type: string; issuer: string; audience: string;
    keyId: string; signature: string; issuedAt: number; expiresAt: number }>(schema: z.ZodType<T>, raw: unknown): T {
    const result = schema.safeParse(raw);
    if (!result.success) throw new OwnershipError(400, 'Invalid ownership document');
    const document = result.data, config = trust(), key = config.keys.get(document.keyId);
    if (!key) throw new OwnershipError(503, 'Ownership key unavailable');
    if (document.issuer !== config.issuer || document.audience !== config.audience ||
        !ownershipFresh(document) || !verifyOwnership(document, key)) refuse();
    return document;
}
async function bind(tx: Prisma.TransactionClient, sessionId: string, created: boolean,
    proof: SessionOwnershipProof, proofDigest: string) {
    if (!ownershipFresh(proof)) refuse();
    const machine = await tx.machine.findUnique({ where: { id: proof.machineId } });
    if (!machine || machine.accountId !== proof.machineAccountId) refuse();
    if (proof.parentHubSessionId) {
        const parent = await tx.sessionOwnershipBinding.findUnique({ where: { sessionId: proof.parentHubSessionId } });
        if (!parent?.confirmedAt || !parent.sessionRowId || parent.subjectIssuer !== proof.subject.issuer ||
            parent.ownerUserId !== proof.subject.userId || parent.sessionAccountId !== proof.sessionAccountId) refuse();
    }
    const existing = await tx.sessionOwnershipBinding.findFirst({ where: { OR: [
        { subjectIssuer: proof.issuer, intentId: proof.intentId },
        { subjectIssuer: proof.issuer, operationId: proof.operationId },
        { subjectIssuer: proof.issuer, nonce: proof.nonce }, { sessionId },
    ] } });
    if (existing || !created) {
        if (!created && existing?.sessionRowId === sessionId && existing.sessionId === sessionId &&
            existing.proofDigest === proofDigest && existing.createDigest === proof.createBodyHash &&
            existing.ownerUserId === proof.subject.userId && existing.subjectIssuer === proof.subject.issuer) return existing;
        conflict();
    }
    return tx.sessionOwnershipBinding.create({ data: {
        sessionId, sessionRowId: sessionId, bindingId: randomUUID(), subjectIssuer: proof.subject.issuer,
        ownerUserId: proof.subject.userId, sessionAccountId: proof.sessionAccountId, originProjectId: proof.projectId,
        machineId: proof.machineId, machineAccountId: proof.machineAccountId, companyId: proof.companyId,
        parentHubSessionId: proof.parentHubSessionId, intentId: proof.intentId, operationId: proof.operationId,
        nonce: proof.nonce, createDigest: proof.createBodyHash, proofDigest, issuedAt: new Date(proof.issuedAt),
    } });
}
export async function createOwnershipBoundSession(accountId: string, rawBody: unknown, rawProof: unknown, executionProof?: unknown) {
    const proof = verifyOwnershipAssertion(SessionOwnershipProofSchema, rawProof);
    const parsed = SessionExecutionCreateBodySchema.safeParse(rawBody);
    if (!parsed.success) throw new OwnershipError(400, 'Invalid ownership create body');
    const body = parsed.data;
    if (proof.subject.issuer !== proof.issuer || proof.sessionAccountId !== accountId ||
        proof.createBodyHash !== await sessionCreateBodyHash(body) || proof.tagHash !== await sessionTagHash(body.tag)) refuse();
    const proofDigest = await ownershipDigest(proof);
    if (executionProof !== undefined) {
        const execution = await verifySessionExecutionCreate(accountId, body, executionProof);
        const ticket = execution.proof.ticket.body;
        if (ticket.machineId !== proof.machineId || ticket.machineOwnerAccountId !== proof.machineAccountId ||
            ticket.sessionOwnerAccountId !== proof.sessionAccountId || ticket.companyId !== proof.companyId) refuse();
    }
    let binding: SessionOwnershipBinding | undefined;
    const participate = async (tx: Prisma.TransactionClient, session: { id: string }, created: boolean) => {
        binding = await bind(tx, session.id, created, proof, proofDigest);
    };
    for (let attempt = 0; ; attempt++) {
        try {
            const session = executionProof !== undefined
                ? await createExecutionBoundSession(accountId, body, executionProof, participate,
                    () => { if (!ownershipFresh(proof)) refuse(); })
                : await inTx(async tx => {
                    const existing = await tx.session.findUnique({ where: { accountId_tag: { accountId, tag: body.tag } } });
                    if (existing) { await participate(tx, existing, false); return existing; }
                    const created = await tx.session.create({ data: { accountId, tag: body.tag, metadata: body.metadata,
                        agentState: body.agentState, dataEncryptionKey: body.dataEncryptionKey
                            ? new Uint8Array(Buffer.from(body.dataEncryptionKey, 'base64')) : undefined } });
                    await participate(tx, created, true);
                    const account = await tx.account.update({ where: { id: accountId }, data: { seq: { increment: 1 } }, select: { seq: true } });
                    if (!ownershipFresh(proof)) refuse();
                    afterTx(tx, () => eventRouter.emitUpdate({ userId: accountId,
                        payload: buildNewSessionUpdate(created, account.seq, randomKeyNaked(12)),
                        recipientFilter: { type: 'user-scoped-only' } }));
                    return created;
                });
            return { session, ownership: { sessionId: session.id, ownershipBindingId: binding!.bindingId,
                registrationState: binding!.confirmedAt ? 'confirmed' : 'pending', createDigest: binding!.createDigest } };
        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                if (attempt < 2) continue;
                conflict();
            }
            throw error;
        }
    }
}
export function ownershipView(sessionId: string, row: SessionOwnershipBinding | null, accessible = true): OwnershipView {
    return { sessionId, bindingId: accessible ? row?.bindingId ?? null : null,
        ownerSubject: accessible && row?.confirmedAt ? { issuer: row.subjectIssuer, userId: row.ownerUserId } : null,
        state: !accessible ? 'unavailable' : !row ? 'unknown' : row.confirmedAt ? 'confirmed' : 'pending',
        checkedAt: Date.now(), reason: !accessible ? 'session-unavailable' : !row ? 'unproven' : row.confirmedAt ? null : 'confirmation-pending' };
}
export async function confirmOwnership(raw: unknown) {
    const assertion = verifyOwnershipAssertion(OwnershipConfirmAssertionSchema, raw);
    if (assertion.subject.issuer !== assertion.issuer) refuse();
    return inTx(async tx => {
        const row = await tx.sessionOwnershipBinding.findUnique({ where: { sessionId: assertion.sessionId } });
        if (!row) return refuse();
        const session = await tx.session.findUnique({ where: { id: assertion.sessionId } });
        if (!row?.sessionRowId || !session || session.accountId !== assertion.sessionAccountId ||
            row.bindingId !== assertion.bindingId || row.operationId !== assertion.operationId ||
            row.createDigest !== assertion.createDigest || row.subjectIssuer !== assertion.subject.issuer ||
            row.ownerUserId !== assertion.subject.userId) refuse();
        const machine = await tx.machine.findUnique({ where: { id: row.machineId } });
        if (!machine || machine.accountId !== row.machineAccountId || !ownershipFresh(assertion)) refuse();
        const confirmed = row.confirmedAt ? row : await tx.sessionOwnershipBinding.update({
            where: { sessionId: row.sessionId }, data: { confirmedAt: new Date() },
        });
        return ownershipView(row.sessionId, confirmed);
    });
}
export async function lookupOwnership(raw: unknown) {
    const assertion = verifyOwnershipAssertion(OwnershipLookupAssertionSchema, raw);
    if (assertion.subject.issuer !== assertion.issuer) refuse();
    return inTx(async tx => {
        const result = [];
        for (const target of assertion.sessions) {
            const session = await tx.session.findUnique({ where: { id: target.sessionId } });
            const row = await tx.sessionOwnershipBinding.findUnique({ where: { sessionId: target.sessionId } });
            const accessible = !!session && session.accountId === target.sessionAccountId;
            const machine = row ? await tx.machine.findUnique({ where: { id: row.machineId } }) : null;
            const available = accessible && (!row || (!!row.sessionRowId && machine?.accountId === row.machineAccountId));
            result.push({ ownership: ownershipView(target.sessionId, row, available),
                binding: available ? row : null, accountId: accessible ? session.accountId : null });
        }
        if (!ownershipFresh(assertion)) refuse();
        return result;
    });
}
export async function inspectOwnershipMachine(raw: unknown) {
    const assertion = verifyOwnershipAssertion(OwnershipMachineAssertionSchema, raw);
    return inTx(async tx => {
        const machine = await tx.machine.findUnique({ where: { id: assertion.machineId } });
        return machine?.accountId === assertion.machineAccountId ? { machineId: machine.id, accountId: machine.accountId } : null;
    });
}
