import { randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import { z } from 'zod';
import { canonicalOrgSetupTokenJson, parseOrgSetupTokenDocument, orgDeviceEnrollmentDigest, verifyOrgSetupTokenDocument, type OrgSetupTokenDocument, type OrgDeviceEnrollmentTranscript } from '@slopus/happy-wire';
import type { createDeviceOrgPinStore } from './deviceOrgPinStore';
import type { DeviceKeys } from './deviceKeys';
const requestSchema = z.object({ companyId: z.string(), machineType: z.enum(['dedicated', 'shared']), ownerUserId: z.string().nullable(), orgSigningPublicKey: z.string(), signingGeneration: z.number() }).strict();
const confirmationSchema = z.object({ companyId: z.string(), machineId: z.string(), enrollmentDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type Approval = OrgSetupTokenDocument & { body: Extract<OrgSetupTokenDocument['body'], { kind: 'device-approval' }> };
type Pending = { approval: Approval | null; readyToPin: boolean; pinned: boolean; transcript: OrgDeviceEnrollmentTranscript; digest: string; proof: string; locallyConfirmed: boolean };
/** Pending comparisons are ephemeral. Neither confirmation alone grants persistent trust.
 * Restarting the daemon loses the pending comparison; persisted pins are owned by the approval store.
 */
/** aplus specs/shared-machine-server-signing S6 (contract §20.5) — stands in for the local confirmation of a shared PC's
 * approval: true only when this PC is marked shared and the approval's key is the one its trusted Studio origin serves. */
export type DeviceAutoConfirm = (input: { transcript: OrgDeviceEnrollmentTranscript; approval: Approval }) => Promise<boolean>;
export function createDeviceEnrollment(deps: { machineId: string; keys: DeviceKeys; now?: () => number; store?: ReturnType<typeof createDeviceOrgPinStore>;
    autoConfirm?: DeviceAutoConfirm; onSharedPinned?: () => Promise<unknown> }) {
    const now = deps.now ?? Date.now;
    let pending: Pending | null = null;
    let revision = 0;
    let committing: Promise<void> | null = null;
    function persistIfReady(): Promise<void> | void {
        if (committing) return committing;
        const enrollment = pending;
        if (!deps.store || !enrollment?.approval || !enrollment.locallyConfirmed || enrollment.pinned) return;
        if (now() >= enrollment.transcript.expiresAt) throw new Error('DEVICE_ENROLLMENT_EXPIRED');
        // Consent is checked here; registration cannot change while this durable write is in flight.
        const candidate = { publicKey: enrollment.transcript.orgSigningPublicKey, approval: { ...enrollment.approval, body: { ...enrollment.approval.body } } };
        committing = deps.store.pin(candidate).then(async () => {
            enrollment.pinned = true;
            // A PC that pinned a shared approval is a shared PC: later approvals may be confirmed automatically.
            if (enrollment.transcript.machineType === 'shared') await deps.onSharedPinned?.().catch(() => undefined);
        })
            .catch(() => { throw new Error('DEVICE_PIN_PERSIST_FAILED'); })
            .finally(() => { committing = null; });
        return committing;
    }
    const copy = (value: Pending): Pending => ({ ...value, transcript: { ...value.transcript }, approval: value.approval ? { ...value.approval, body: { ...value.approval.body } } : null, readyToPin: value.locallyConfirmed && value.approval !== null });
    return {
        /** Advertised as autoOrgPinVersion: Studio approves a shared PC without an administrator only if it confirms itself. */
        autoConfirms: deps.autoConfirm !== undefined,
        async begin(input: z.input<typeof requestSchema>): Promise<Pending> {
            if (committing) throw new Error('DEVICE_PIN_PENDING');
            // Invalidate first, including malformed replacement attempts; never retain stale consent.
            const current = ++revision;
            pending = null;
            const request = requestSchema.parse(input);
            if (deps.store && await deps.store.get(request.companyId)) throw new Error('ORG_ALREADY_PINNED');
            if (revision !== current) throw new Error('DEVICE_ENROLLMENT_REPLACED');
            const transcript: OrgDeviceEnrollmentTranscript = { version: 1, ...request, machineId: deps.machineId,
                deviceSigningPublicKey: Buffer.from(deps.keys.signing.publicKey).toString('base64url'),
                recipientPublicKey: Buffer.from(deps.keys.recipient.publicKey).toString('base64url'),
                enrollmentNonce: randomBytes(32).toString('base64url'), expiresAt: now() + 10 * 60 * 1000 };
            const digest = await orgDeviceEnrollmentDigest(transcript);
            const bytes = new TextEncoder().encode('saycode/device-enrollment/v1\n' + canonicalOrgSetupTokenJson(transcript));
            const proof = Buffer.from(nacl.sign.detached(bytes, deps.keys.signing.secretKey)).toString('base64url');
            if (revision !== current) throw new Error('DEVICE_ENROLLMENT_REPLACED');
            if (now() >= transcript.expiresAt) throw new Error('DEVICE_ENROLLMENT_EXPIRED');
            pending = { transcript, digest, proof, locallyConfirmed: false, approval: null, readyToPin: false, pinned: false };
            return copy(pending);
        },
        async approve(json: string): Promise<void> {
            const enrollment = pending;
            const current = revision;
            if (!enrollment || now() >= enrollment.transcript.expiresAt) {
                const document = parseOrgSetupTokenDocument(json);
                if (document.body.kind !== 'device-approval') throw new Error('DEVICE_ENROLLMENT_MISMATCH');
                // The store verifies signature and local device binding on every read. An
                // exact replay acknowledges an existing pin; it never creates fresh consent.
                const pin = await deps.store?.get(document.body.companyId);
                if (pin && canonicalOrgSetupTokenJson(pin.approval) === canonicalOrgSetupTokenJson(document)) return;
                throw new Error('DEVICE_ENROLLMENT_EXPIRED');
            }
            const transcript = enrollment.transcript;
            const document = await verifyOrgSetupTokenDocument(json, Buffer.from(transcript.orgSigningPublicKey, 'base64url'));
            // Crypto awaits must not carry an old registration into a new comparison.
            if (current !== revision || pending !== enrollment) throw new Error('DEVICE_ENROLLMENT_REPLACED');
            if (now() >= transcript.expiresAt) throw new Error('DEVICE_ENROLLMENT_EXPIRED');
            const body = document.body;
            if (body.kind !== 'device-approval' || body.companyId !== transcript.companyId ||
                body.machineId !== transcript.machineId || body.machineType !== transcript.machineType ||
                body.ownerUserId !== transcript.ownerUserId || body.signingGeneration !== transcript.signingGeneration ||
                body.deviceSigningPublicKey !== transcript.deviceSigningPublicKey || body.recipientPublicKey !== transcript.recipientPublicKey ||
                body.enrollmentDigest !== enrollment.digest) throw new Error('DEVICE_ENROLLMENT_MISMATCH');
            if (enrollment.approval && canonicalOrgSetupTokenJson(enrollment.approval) !== canonicalOrgSetupTokenJson(document)) throw new Error('REVISION_CONFLICT');
            // Never publish persistent trust before both independent confirmations.
            enrollment.approval = { ...document, body };
            if (!enrollment.locallyConfirmed && deps.autoConfirm && transcript.machineType === 'shared' && transcript.ownerUserId === null) {
                // A failed check only leaves the manual confirmation in place.
                const confirmed = await deps.autoConfirm({ transcript: { ...transcript }, approval: { ...enrollment.approval, body: { ...body } } })
                    .catch(() => false);
                if (current !== revision || pending !== enrollment) throw new Error('DEVICE_ENROLLMENT_REPLACED');
                if (confirmed === true) enrollment.locallyConfirmed = true;
            }
            await persistIfReady();
        },
        /** The locally confirmed organization pin, which signed setup-token delivery trusts. */
        orgPin(companyId: string) {
            return deps.store ? deps.store.get(companyId) : Promise.resolve(null);
        },
        async getStatus(companyId: string) {
            z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f-\u009f]+$/).parse(companyId);
            const pin = await deps.store?.get(companyId);
            // Read pending after disk I/O so expiry/re-enrollment cannot leak an obsolete comparison.
            const enrollment = pending?.transcript.companyId === companyId && now() < pending.transcript.expiresAt ? pending : null;
            const body = pin?.approval.body;
            return { companyId, machineId: deps.machineId,
                deviceSigningPublicKey: Buffer.from(deps.keys.signing.publicKey).toString('base64url'),
                recipientPublicKey: Buffer.from(deps.keys.recipient.publicKey).toString('base64url'),
                enrollment: enrollment ? { digest: enrollment.digest, expiresAt: enrollment.transcript.expiresAt,
                    orgSigningPublicKey: enrollment.transcript.orgSigningPublicKey, signingGeneration: enrollment.transcript.signingGeneration,
                    locallyConfirmed: enrollment.locallyConfirmed, administratorApproved: enrollment.approval !== null } : null,
                pin: pin && body?.kind === 'device-approval' ? { publicKey: pin.publicKey, policy: pin.policy,
                    signingGeneration: body.signingGeneration, keyId: body.signingKeyId, approvalId: body.approvalId } : null };
        },
        status(): Pending | null {
            if (!pending || now() >= pending.transcript.expiresAt) return null;
            return copy(pending);
        },
        confirm(input: z.input<typeof confirmationSchema>): Promise<void> | void {
            const request = confirmationSchema.parse(input);
            if (!pending || now() >= pending.transcript.expiresAt) throw new Error('DEVICE_ENROLLMENT_EXPIRED');
            if (request.companyId !== pending.transcript.companyId || request.machineId !== deps.machineId || request.enrollmentDigest !== pending.digest) throw new Error('DEVICE_ENROLLMENT_MISMATCH');
            pending.locallyConfirmed = true;
            return persistIfReady();
        },
    };
}
