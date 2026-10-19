import { Prisma } from '@prisma/client';
import {
  HappySessionExecutionProofSchema, RotationOriginSchema, SessionExecutionCreateBodySchema,
  rotationDecodeBinary, rotationDigest, rotationIsFresh, rotationSha256,
  sessionCreateBodyHash, sessionTagHash, verifyRotationDocument,
  type HappySessionExecutionProof,
} from '@slopus/happy-wire';
import { inTx, afterTx } from '@/storage/inTx';
import { eventRouter, buildNewSessionUpdate } from '@/app/events/eventRouter';
import { randomKeyNaked } from '@/utils/randomKeyNaked';

export class ExecutionBindingError extends Error {
  constructor(readonly statusCode: 400 | 403 | 409 | 503, message: string) { super(message); }
}
function refuse(): never { throw new ExecutionBindingError(403, 'Invalid session execution proof'); }
function conflict(): never { throw new ExecutionBindingError(409, 'Session execution binding conflict'); }
function trustConfig() {
  try {
    const studioOrigin = RotationOriginSchema.parse(process.env.HAPPY_EXECUTION_STUDIO_ORIGIN);
    const audience = RotationOriginSchema.parse(process.env.HAPPY_EXECUTION_AUDIENCE);
    const publicKey = rotationDecodeBinary(process.env.HAPPY_EXECUTION_STUDIO_PUBLIC_KEY ?? '', 32);
    return { studioOrigin, audience, publicKey };
  } catch { throw new ExecutionBindingError(503, 'Session execution trust is not configured'); }
}
export async function verifySessionExecutionCreate(ownerAccountId: string, rawBody: unknown, rawProof: unknown, now = Date.now()) {
  const bodyResult = SessionExecutionCreateBodySchema.safeParse(rawBody);
  const proofResult = HappySessionExecutionProofSchema.safeParse(rawProof);
  if (!bodyResult.success || !proofResult.success) throw new ExecutionBindingError(400, 'Invalid session execution request');
  const body = bodyResult.data, proof = proofResult.data;
  const trust = trustConfig();
  const ticket = proof.ticket.body, device = proof.deviceProof.body;
  try {
    if (ticket.studioOrigin !== trust.studioOrigin || ticket.audience !== trust.audience || device.audience !== trust.audience ||
      ticket.keyId !== await rotationSha256(trust.publicKey) || ticket.sessionOwnerAccountId !== ownerAccountId ||
      device.sessionOwnerAccountId !== ownerAccountId || !rotationIsFresh(ticket, now) || !rotationIsFresh(device, now)) refuse();
    await verifyRotationDocument(proof.ticket, trust.publicKey);
    const deviceKey = rotationDecodeBinary(ticket.deviceSigningPublicKey, 32);
    if (ticket.deviceKeyId !== await rotationSha256(deviceKey)) refuse();
    await verifyRotationDocument(proof.deviceProof, deviceKey);
    const ticketDigest = await rotationDigest(proof.ticket);
    const tagHash = await sessionTagHash(body.tag), bodyHash = await sessionCreateBodyHash(body);
    if (device.ticketDigest !== ticketDigest || ticket.sessionTagHash !== tagHash || device.sessionTagHash !== tagHash ||
      ticket.sessionCreateBodyHash !== bodyHash || device.sessionCreateBodyHash !== bodyHash) refuse();
    return { body, proof, ticketDigest, createProofDigest: await rotationDigest(proof) };
  } catch (error) {
    if (error instanceof ExecutionBindingError) throw error;
    refuse();
  }
}
function fresh(proof: HappySessionExecutionProof) {
  const now = Date.now();
  if (!rotationIsFresh(proof.ticket.body, now) || !rotationIsFresh(proof.deviceProof.body, now)) refuse();
}

/** Only a new session can acquire this immutable relation. Existing rows require exact replay. */
export async function createExecutionBoundSession(ownerAccountId: string, rawBody: unknown, rawProof: unknown) {
  const verified = await verifySessionExecutionCreate(ownerAccountId, rawBody, rawProof);
  const { body, proof, ticketDigest, createProofDigest } = verified;
  const ticket = proof.ticket.body;
  for (let attempt = 0; ; attempt++) {
    try {
      return await inTx(async tx => {
        fresh(proof);
        const machine = await tx.machine.findUnique({ where: { id: ticket.machineId } });
        if (!machine || machine.accountId !== ticket.machineOwnerAccountId) refuse();
        const existing = await tx.session.findUnique({ where: { accountId_tag: { accountId: ownerAccountId, tag: body.tag } } });
        const binding = await tx.sessionExecutionBinding.findFirst({ where: { OR: [
          { companyId: ticket.companyId, machineId: ticket.machineId, launchId: ticket.launchId },
          { companyId: ticket.companyId, initialNonce: ticket.initialNonce },
          { companyId: ticket.companyId, machineId: ticket.machineId, operationId: ticket.operationId },
        ] } });
        if (existing || binding) {
          if (existing && binding && binding.sessionId === existing.id && binding.sessionRowId === existing.id &&
            binding.sessionOwnerAccountId === ownerAccountId && binding.machineRowId === machine.id &&
            binding.machineOwnerAccountId === machine.accountId && binding.companyId === ticket.companyId &&
            binding.machineId === ticket.machineId && binding.launchId === ticket.launchId &&
            binding.initialNonce === ticket.initialNonce && binding.operationId === ticket.operationId &&
            binding.ticketDigest === ticketDigest && binding.createProofDigest === createProofDigest &&
            binding.sessionTagHash === ticket.sessionTagHash && binding.sessionCreateBodyHash === ticket.sessionCreateBodyHash) return existing;
          conflict();
        }
        const session = await tx.session.create({ data: {
          accountId: ownerAccountId, tag: body.tag, metadata: body.metadata, agentState: body.agentState,
          dataEncryptionKey: body.dataEncryptionKey ? new Uint8Array(Buffer.from(body.dataEncryptionKey, 'base64')) : undefined,
        } });
        await tx.sessionExecutionBinding.create({ data: {
          sessionId: session.id, sessionRowId: session.id, sessionRowOwnerAccountId: ownerAccountId,
          companyId: ticket.companyId, machineId: machine.id, machineOwnerAccountId: machine.accountId,
          machineRowId: machine.id, machineRowOwnerAccountId: machine.accountId, sessionOwnerAccountId: ownerAccountId,
          launchId: ticket.launchId, initialNonce: ticket.initialNonce, operationId: ticket.operationId,
          approvalId: ticket.approvalId, deviceKeyId: ticket.deviceKeyId, sessionTagHash: ticket.sessionTagHash,
          sessionCreateBodyHash: ticket.sessionCreateBodyHash, ticketDigest, createProofDigest,
        } });
        const account = await tx.account.update({ where: { id: ownerAccountId }, data: { seq: { increment: 1 } }, select: { seq: true } });
        fresh(proof);
        afterTx(tx, () => eventRouter.emitUpdate({ userId: ownerAccountId,
          payload: buildNewSessionUpdate(session, account.seq, randomKeyNaked(12)), recipientFilter: { type: 'user-scoped-only' } }));
        return session;
      });
    } catch (error) {
      // A concurrent identical create can lose either unique constraint. Re-read,
      // reauthorize and apply the same replay predicate in a new transaction.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && attempt < 2) continue;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') conflict();
      throw error;
    }
  }
}
