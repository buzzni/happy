import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import nacl from 'tweetnacl';
import { z } from 'zod';
import { openCheckpointFile, sealCheckpointStream, type CheckpointCryptoBinding } from '@/managed/checkpoint/managedCheckpointCrypto';
import type { DeviceKeys } from './deviceKeys';
import { workMachineSigningIdentity } from './workMachineCredential';

const domain = 'happy-work-machine-archive-v1';
const keyBytes = 32;
const maxSingleArchiveBytes = 32 * 1024 ** 3;
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const binary = (bytes: number) => z.string()
    .length(Math.ceil(bytes * 4 / 3))
    .regex(/^[A-Za-z0-9_-]+$/)
    .refine(value => Buffer.from(value, 'base64url').toString('base64url') === value);
const approvalDetailsSchema = z.object({
    taskId: identifier,
    machineId: identifier,
    accountId: identifier,
    generation: z.number().int().min(1).max(2_147_483_647),
    sourceDeviceId: binary(32),
    targetDeviceId: binary(32),
    expiresAt: z.number().int().positive(),
    maxBytes: z.number().int().positive().max(maxSingleArchiveBytes),
}).strict();
type ApprovalDetails = z.infer<typeof approvalDetailsSchema>;
const approvalSchema = approvalDetailsSchema.extend({
    targetRecipientKey: binary(nacl.box.publicKeyLength),
    targetSigningPublicKey: binary(nacl.sign.publicKeyLength),
    targetKeyProof: binary(nacl.sign.signatureLength),
});
export type WorkMachineArchiveApproval = z.infer<typeof approvalSchema>;

const receiptSchema = z.object({
    version: z.literal(1),
    sourcePublicKey: binary(nacl.sign.publicKeyLength),
    ephemeralPublicKey: binary(nacl.box.publicKeyLength),
    nonce: binary(nacl.box.nonceLength),
    wrappedKey: binary(keyBytes + nacl.box.overheadLength),
    signature: binary(nacl.sign.signatureLength),
}).strict();
type TransferReceipt = z.infer<typeof receiptSchema>;
type UnsignedReceipt = Omit<TransferReceipt, 'signature'>;
type TransferInput = { approval: WorkMachineArchiveApproval; now?: number };

function recipientProofPayload(approval: Omit<WorkMachineArchiveApproval, 'targetKeyProof'>): Buffer {
    return Buffer.from(JSON.stringify([
        'happy-work-machine-archive-recipient-v1', approval.taskId, approval.accountId, approval.machineId,
        approval.generation, approval.sourceDeviceId, approval.targetDeviceId, approval.targetRecipientKey,
        approval.targetSigningPublicKey, approval.expiresAt, approval.maxBytes,
    ]));
}

export function proveWorkMachineArchiveRecipient(details: ApprovalDetails, keys: DeviceKeys): WorkMachineArchiveApproval {
    const fields = approvalDetailsSchema.parse(details);
    if (workMachineSigningIdentity(keys.signing.publicKey).deviceId !== fields.targetDeviceId) {
        throw new Error('Work machine archive approval is for a different target');
    }
    const approval = {
        ...fields,
        targetRecipientKey: Buffer.from(keys.recipient.publicKey).toString('base64url'),
        targetSigningPublicKey: Buffer.from(keys.signing.publicKey).toString('base64url'),
    };
    return { ...approval, targetKeyProof: Buffer.from(nacl.sign.detached(recipientProofPayload(approval), keys.signing.secretKey)).toString('base64url') };
}

function transferBinding({ approval, now = Date.now() }: TransferInput): CheckpointCryptoBinding {
    const fields = approvalSchema.parse(approval);
    if (!Number.isSafeInteger(now) || now >= fields.expiresAt || fields.sourceDeviceId === fields.targetDeviceId) {
        throw new Error('Work machine archive approval is invalid or expired');
    }
    const signingPublicKey = Buffer.from(fields.targetSigningPublicKey, 'base64url');
    if (workMachineSigningIdentity(signingPublicKey).deviceId !== fields.targetDeviceId
        || !nacl.sign.detached.verify(recipientProofPayload(fields), Buffer.from(fields.targetKeyProof, 'base64url'), signingPublicKey)) {
        throw new Error('Work machine archive approval has an invalid target key proof');
    }
    return {
        tenantId: fields.accountId,
        projectId: fields.machineId,
        checkpointId: JSON.stringify([
            domain, fields.taskId, fields.generation, fields.sourceDeviceId, fields.targetDeviceId,
            fields.targetRecipientKey, fields.expiresAt, fields.maxBytes,
        ]),
        area: 'manifest',
    };
}

function signaturePayload(binding: CheckpointCryptoBinding, receipt: UnsignedReceipt): Buffer {
    return Buffer.from(JSON.stringify([
        domain, binding.tenantId, binding.projectId, binding.checkpointId,
        receipt.version, receipt.sourcePublicKey, receipt.ephemeralPublicKey, receipt.nonce, receipt.wrappedKey,
    ]));
}

/** The caller supplies the authenticated, approved task and reads from a consistent source snapshot. */
export async function sealWorkMachineArchive(input: TransferInput & {
    sourceKeys: DeviceKeys;
    source: Readable;
    destination: string;
}): Promise<TransferReceipt> {
    const binding = transferBinding(input);
    const { approval, sourceKeys } = input;
    if (workMachineSigningIdentity(sourceKeys.signing.publicKey).deviceId !== approval.sourceDeviceId) {
        throw new Error('Work machine archive source does not match approval');
    }
    const recipient = Buffer.from(approval.targetRecipientKey, 'base64url');
    const contentKey = randomBytes(keyBytes);
    const ephemeral = nacl.box.keyPair();
    try {
        const shared = nacl.scalarMult(ephemeral.secretKey, recipient);
        const invalidRecipient = shared.every(value => value === 0);
        shared.fill(0);
        if (invalidRecipient) throw new Error('Work machine archive recipient key is invalid');

        const nonce = randomBytes(nacl.box.nonceLength);
        const unsigned: UnsignedReceipt = {
            version: 1,
            sourcePublicKey: Buffer.from(sourceKeys.signing.publicKey).toString('base64url'),
            ephemeralPublicKey: Buffer.from(ephemeral.publicKey).toString('base64url'),
            nonce: nonce.toString('base64url'),
            wrappedKey: Buffer.from(nacl.box(contentKey, nonce, recipient, ephemeral.secretKey)).toString('base64url'),
        };
        const signature = nacl.sign.detached(signaturePayload(binding, unsigned), sourceKeys.signing.secretKey);
        let remaining = approval.maxBytes;
        const boundedSource = Readable.from((async function* () {
            for await (const chunk of input.source) {
                const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                if (bytes.length > remaining) throw new Error('Work machine archive exceeds the approved size');
                remaining -= bytes.length;
                yield bytes;
            }
        })(), { objectMode: false });
        let sealed = false;
        try {
            await sealCheckpointStream({ source: boundedSource, destination: input.destination, key: contentKey, binding });
            sealed = true;
            transferBinding(input);
            return { ...unsigned, signature: Buffer.from(signature).toString('base64url') };
        } catch (error) {
            if (sealed) await rm(input.destination, { force: true });
            throw error;
        } finally {
            boundedSource.destroy();
        }
    } finally {
        ephemeral.secretKey.fill(0);
        contentKey.fill(0);
    }
}

/** Returns an authenticated archive in a new local staging directory. The caller owns its cleanup. */
export async function restoreWorkMachineArchive(input: TransferInput & {
    targetKeys: DeviceKeys;
    receipt: unknown;
    source: string;
    stagingRoot: string;
}): Promise<{ archivePath: string; bytes: number; sha256: string }> {
    const binding = transferBinding(input);
    const { approval, targetKeys } = input;
    if (workMachineSigningIdentity(targetKeys.signing.publicKey).deviceId !== approval.targetDeviceId
        || Buffer.from(targetKeys.recipient.publicKey).toString('base64url') !== approval.targetRecipientKey) {
        throw new Error('Work machine archive target does not match approval');
    }
    const receipt = receiptSchema.parse(input.receipt);
    const sourcePublicKey = Buffer.from(receipt.sourcePublicKey, 'base64url');
    if (workMachineSigningIdentity(sourcePublicKey).deviceId !== approval.sourceDeviceId
        || !nacl.sign.detached.verify(signaturePayload(binding, receipt), Buffer.from(receipt.signature, 'base64url'), sourcePublicKey)) {
        throw new Error('Work machine archive source signature is invalid');
    }

    const unwrapped = nacl.box.open(
        Buffer.from(receipt.wrappedKey, 'base64url'), Buffer.from(receipt.nonce, 'base64url'),
        Buffer.from(receipt.ephemeralPublicKey, 'base64url'), targetKeys.recipient.secretKey,
    );
    if (!unwrapped) throw new Error('Work machine archive key is unreadable');
    const key = Buffer.from(unwrapped.buffer, unwrapped.byteOffset, unwrapped.byteLength);
    try {
        const staging = await mkdtemp(join(input.stagingRoot, 'work-machine-'));
        const archivePath = join(staging, 'archive');
        try {
            const result = await openCheckpointFile({
                source: input.source, destination: archivePath, key, binding, maxPlaintextBytes: approval.maxBytes,
            });
            transferBinding(input);
            return { archivePath, ...result };
        } catch (error) {
            await rm(staging, { recursive: true, force: true });
            throw error;
        }
    } finally {
        key.fill(0);
    }
}
