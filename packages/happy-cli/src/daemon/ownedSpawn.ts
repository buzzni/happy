/** T4rt operation state machine: every irreversible side effect follows a durable intent. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SessionOwnershipIntentSchema, SessionOwnershipProofSchema, OwnershipConfirmedReceiptSchema,
    OwnershipCallerBindingSchema, HappySessionExecutionProofSchema, SessionExecutionCreateBodySchema,
    ownershipDigest, ownershipFresh, ownershipId, sessionCreateBodyHash, sessionTagHash } from '@slopus/happy-wire';
import type { OwnedSpawnJournal } from './ownedSpawnJournal';

export const ownedSnapshotSchema = z.object({ body: SessionExecutionCreateBodySchema,
    encryptionKey: z.string().refine(v => Buffer.from(v, 'base64').length === 32), encryptionVariant: z.enum(['legacy', 'dataKey']),
    executionProof: HappySessionExecutionProofSchema.optional(), runtimeState: z.record(z.string(), z.unknown()).optional(),
}).strict();
export const ownedCreatedSchema = z.object({ sessionId: ownershipId, ownershipBindingId: ownershipId.optional(),
    registrationState: z.enum(['pending', 'confirmed']).optional(), createDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const ownedSpawnRecordSchema = z.object({ version: z.literal(1), intent: SessionOwnershipIntentSchema,
    spawn: z.record(z.string(), z.unknown()), preparationId: ownershipId, intentDigest: z.string(),
    state: z.enum(['preparing', 'prepared', 'committing', 'created', 'starting', 'started', 'failed']),
    snapshot: ownedSnapshotSchema.optional(), creationMode: z.enum(['signed', 'unsigned']).optional(),
    commitIssued: z.boolean(), ownershipOutcome: z.enum(['confirmed', 'pending', 'unproven']),
    unprovenReason: z.string().optional(), proof: SessionOwnershipProofSchema.optional(),
    created: ownedCreatedSchema.optional(), confirmedReceipt: OwnershipConfirmedReceiptSchema.optional(),
    providerRuntimeId: ownershipId.optional(), caller: OwnershipCallerBindingSchema.optional(),
    /** 'host': the child host holds the caller key, fixed when the start is submitted (H3). Absent means daemon
     * custody, as on every earlier record, so a daemon from before H3 still reads those. */
    callerCustody: z.literal('host').optional(),
}).strict();
export type OwnedSpawnRecord = z.infer<typeof ownedSpawnRecordSchema>;
export type OwnedSpawnSnapshot = z.infer<typeof ownedSnapshotSchema>;
export type OwnedCreated = z.infer<typeof ownedCreatedSchema>;
export interface OwnedSpawnDependencies {
    journal: OwnedSpawnJournal; now(): number;
    /** Verifies issuer/audience/key/signature using daemon configuration, never a key supplied in an RPC. */
    verify(document: unknown): Promise<boolean>;
    scope(spawn: Record<string, unknown>): Promise<{ machineId: string; machineAccountId: string; sessionAccountId: string }>;
    prepare(record: OwnedSpawnRecord, publish: (snapshot: OwnedSpawnSnapshot) => Promise<void>): Promise<OwnedSpawnSnapshot>;
    failed?(record: OwnedSpawnRecord): Promise<void>;
    commit(record: OwnedSpawnRecord): Promise<OwnedCreated>;
    /** Read-only recovery, including expired proof. Never creates a new tag or re-encrypts. */
    discover(record: OwnedSpawnRecord): Promise<OwnedCreated | null>;
    prepareStart?(record: OwnedSpawnRecord): Promise<void>;
    start(record: OwnedSpawnRecord): Promise<StartedProvider>;
    observeStart(record: OwnedSpawnRecord): Promise<StartedProvider | null>;
    /** null: the child host holds its own key and its binding arrives with the started provider (T1c-b2 H3). */
    caller(record: OwnedSpawnRecord): Promise<z.infer<typeof OwnershipCallerBindingSchema> | null>;
}
/** caller: the binding of the started runtime, held by the child host (host custody) or the daemon. */
type StartedProvider = { providerRuntimeId: string; caller: z.infer<typeof OwnershipCallerBindingSchema> };
export class OwnedSpawnRejected extends Error { constructor(readonly reason = 'creation-rejected') { super('owned-spawn-rejected'); } }
/** Only trusted daemon code that knows dispatch never occurred may throw this. */
export class OwnedStartRefused extends Error {
    constructor(readonly reason: 'daemon-restarting' | 'directory-approval-required' | 'validation-error') { super('owned-start-refused'); }
}
const reference = z.object({ creationRequestId: ownershipId, preparationId: ownershipId });
const refusal = (code = 'owned-spawn-conflict'): never => { throw new Error(code); };
export function createOwnedSpawn(deps: OwnedSpawnDependencies) {
    const flights = new Map<string, Promise<unknown>>();
    function serial<T>(id: string, work: () => Promise<T>): Promise<T> {
        const next = (flights.get(id) ?? Promise.resolve()).catch(() => undefined).then(work);
        flights.set(id, next); void next.finally(() => { if (flights.get(id) === next) flights.delete(id); }).catch(() => undefined);
        return next;
    }
    async function scope(record: OwnedSpawnRecord) {
        const actual = await deps.scope(record.spawn), intent = record.intent;
        if (actual.machineId !== intent.machineId || actual.machineAccountId !== intent.machineAccountId
            || actual.sessionAccountId !== intent.sessionAccountId) refusal('identity-changed');
    }
    async function read(id: string, preparationId?: string) {
        const record = await deps.journal.read(id);
        if (!record || preparationId && preparationId !== record.preparationId) return refusal();
        await scope(record); return record;
    }
    function view(r: OwnedSpawnRecord) {
        return { version: 1 as const, creationRequestId: r.intent.creationRequestId, operationId: r.intent.operationId,
            preparationId: r.preparationId, ownershipPolicy: r.intent.ownershipPolicy, state: r.state,
            commitIssued: r.commitIssued, ownershipOutcome: r.ownershipOutcome,
            ...(r.unprovenReason ? { unprovenReason: r.unprovenReason } : {}),
            ...(r.created ?? {}), ...(r.providerRuntimeId ? { providerRuntimeId: r.providerRuntimeId } : {}),
            ...(r.caller ? { caller: r.caller } : {}),
        };
    }
    async function created(r: OwnedSpawnRecord, value: OwnedCreated, recovered = false) {
        const result = ownedCreatedSchema.parse(value);
        if (!r.snapshot || result.createDigest !== await sessionCreateBodyHash(r.snapshot.body)
            || !recovered && r.creationMode === 'signed' && (!result.ownershipBindingId || !result.registrationState)) refusal();
        r.created = result; r.state = 'created';
        // Only the personal signed confirm receipt can promote authority, never this REST view.
        r.ownershipOutcome = r.creationMode === 'unsigned' ? 'unproven' : 'pending';
        await deps.journal.write(r);
    }
    /** Started is recorded only with the started runtime's caller, bound to this session and the intent's machine/account. */
    function adopt(r: OwnedSpawnRecord, found: StartedProvider) {
        const caller = OwnershipCallerBindingSchema.safeParse(found.caller);
        if (!caller.success || caller.data.sessionId !== r.created?.sessionId || caller.data.machineId !== r.intent.machineId
            || caller.data.happyAccountId !== r.intent.sessionAccountId || caller.data.runtimeId !== found.providerRuntimeId) refusal('caller-mismatch');
        r.caller = caller.data; r.providerRuntimeId = found.providerRuntimeId; r.state = 'started';
    }
    async function recover(r: OwnedSpawnRecord) {
        if (r.state === 'failed') await deps.failed?.(r);
        if (r.state === 'committing') { const found = await deps.discover(r); if (found) await created(r, found, true); }
        if (r.state === 'starting') {
            const found = await deps.observeStart(r);
            if (found) {
                // A binding that is not this child's own leaves the start unconfirmed; it is never retried as a launch.
                try { adopt(r, found); } catch { return view(r); }
                await deps.journal.write(r);
            }
        }
        return view(r);
    }
    return {
        async prepare(raw: unknown) {
            const input = z.object({ intent: SessionOwnershipIntentSchema, spawn: z.record(z.string(), z.unknown()) }).strict().parse(raw);
            const id = input.intent.creationRequestId;
            return serial(id, async () => {
                const digest = await ownershipDigest(input.intent);
                if (input.intent.spawnDigest !== await ownershipDigest(input.spawn) || !await deps.verify(input.intent)) refusal('invalid-ownership-intent');
                let r = await deps.journal.read(id);
                if (r) { if (r.intentDigest !== digest) refusal(); await scope(r); }
                else {
                    if (!ownershipFresh(input.intent, deps.now())) refusal('ownership-intent-expired');
                    r = { version: 1, ...input, preparationId: randomUUID(), intentDigest: digest, state: 'preparing', commitIssued: false, ownershipOutcome: 'pending' };
                    await scope(r); await deps.journal.write(r);
                }
                if (r.state === 'preparing') {
                    try {
                        const snapshot = ownedSnapshotSchema.parse(await deps.prepare(r, async snapshot => {
                            r!.snapshot = ownedSnapshotSchema.parse(snapshot); await deps.journal.write(r!);
                        }));
                        r.snapshot = snapshot; r.state = 'prepared'; await deps.journal.write(r);
                    } catch (error) {
                        r.state = 'failed'; r.unprovenReason = 'preparation-failed';
                        try { await deps.journal.write(r); } finally { await deps.failed?.(r); }
                        throw error;
                    }
                }
                if (r.state === 'failed') { await deps.failed?.(r); refusal('creation-failed'); }
                return { preparationId: r.preparationId, operationId: r.intent.operationId, intentDigest: r.intentDigest,
                    sessionCreateBodyHash: await sessionCreateBodyHash(r.snapshot!.body), sessionTagHash: await sessionTagHash(r.snapshot!.body.tag) };
            });
        },
        async commit(raw: unknown) {
            const input = reference.extend({ ownershipProof: SessionOwnershipProofSchema.optional(),
                unprovenReason: z.enum(['ownership-timeout', 'aplus-unavailable', 'personal-auth-missing']).optional() }).strict().parse(raw);
            return serial(input.creationRequestId, async () => {
                const r = await read(input.creationRequestId, input.preparationId), proof = input.ownershipProof;
                if (!r.snapshot || Boolean(proof) === Boolean(input.unprovenReason)) refusal();
                const mode = proof ? 'signed' : 'unsigned';
                if (r.creationMode && (r.creationMode !== mode || proof && await ownershipDigest(proof) !== await ownershipDigest(r.proof))) refusal();
                if (r.commitIssued) return recover(r);
                if (r.state !== 'prepared') refusal();
                if (proof) {
                    const { type: _type, signature: _signature, keyId: _keyId, issuedAt: _issued, expiresAt: _expires, ...intentScope } = r.intent;
                    for (const [key, expected] of Object.entries(intentScope)) {
                        if (await ownershipDigest((proof as Record<string, unknown>)[key]) !== await ownershipDigest(expected)) refusal('ownership-proof-mismatch');
                    }
                    if (!ownershipFresh(proof, deps.now()) || !await deps.verify(proof)
                        || proof.createBodyHash !== await sessionCreateBodyHash(r.snapshot!.body)
                        || proof.tagHash !== await sessionTagHash(r.snapshot!.body.tag)) refusal('ownership-proof-mismatch');
                } else if (r.intent.ownershipPolicy !== 'prefer-owned') refusal('ownership-required');
                r.creationMode = mode; r.proof = proof; r.unprovenReason = input.unprovenReason;
                await scope(r);
                r.commitIssued = true; r.state = 'committing'; await deps.journal.write(r);
                try { await created(r, await deps.commit(r)); }
                catch (error) {
                    if (error instanceof OwnedSpawnRejected) {
                        r.state = 'failed'; r.unprovenReason = error.reason;
                        try { await deps.journal.write(r); } finally { await deps.failed?.(r); }
                    }
                    // All uncertain outcomes are read-only recovered; never POST another session.
                }
                return view(r);
            });
        },
        async start(raw: unknown) {
            const input = reference.extend({ sessionId: ownershipId, confirmedReceipt: OwnershipConfirmedReceiptSchema.optional() }).strict().parse(raw);
            return serial(input.creationRequestId, async () => {
                const r = await read(input.creationRequestId, input.preparationId);
                await recover(r);
                const candidate = r.created;
                if (!candidate || candidate.sessionId !== input.sessionId) return refusal();
                const submitted = r.state === 'started' || r.state === 'starting';
                if (submitted && !input.confirmedReceipt) return view(r);
                if (!submitted && r.state !== 'created') refusal();
                if (input.confirmedReceipt) {
                    const c = input.confirmedReceipt, i = r.intent;
                    if (r.creationMode !== 'signed' || !ownershipFresh(c, deps.now()) || !await deps.verify(c) || c.sessionId !== input.sessionId
                        || candidate.ownershipBindingId && c.bindingId !== candidate.ownershipBindingId || c.preparationId !== r.preparationId
                        || c.operationId !== i.operationId || c.creationRequestId !== i.creationRequestId || c.ownershipPolicy !== i.ownershipPolicy
                        || c.createDigest !== candidate.createDigest || c.spawnDigest !== i.spawnDigest || c.parentHubSessionId !== i.parentHubSessionId
                        || c.subject.issuer !== i.subject.issuer || c.subject.userId !== i.subject.userId) refusal('confirmation-mismatch');
                    r.confirmedReceipt = c; r.ownershipOutcome = 'confirmed';
                    r.created = { ...candidate, ownershipBindingId: c.bindingId, registrationState: 'confirmed' }; r.unprovenReason = undefined;
                } else if (r.intent.ownershipPolicy === 'require-owned') refusal('ownership-required');
                else if (r.creationMode === 'signed') r.unprovenReason = 'confirmation-pending';
                if (submitted) { await scope(r); await deps.journal.write(r); return view(r); }
                await deps.prepareStart?.(r);
                await scope(r);
                const caller = await deps.caller(r);
                if (caller) delete r.callerCustody; else r.callerCustody = 'host';
                if (caller) {
                    r.caller = OwnershipCallerBindingSchema.parse(caller);
                    if (r.caller.sessionId !== input.sessionId || r.caller.machineId !== r.intent.machineId || r.caller.happyAccountId !== r.intent.sessionAccountId) return refusal('caller-mismatch');
                }
                r.state = 'starting'; await deps.journal.write(r);
                try {
                    adopt(r, await deps.start(r));
                    await deps.journal.write(r);
                } catch (error) {
                    if (error instanceof OwnedStartRefused) {
                        r.state = 'created'; delete r.providerRuntimeId; delete r.caller; delete r.callerCustody;
                        await deps.journal.write(r);
                    }
                    // Unknown dispatch outcomes can only be observed, never resubmitted.
                }
                return view(r);
            });
        },
        async status(raw: unknown) {
            const { creationRequestId } = z.object({ creationRequestId: ownershipId }).strict().parse(raw);
            return serial(creationRequestId, async () => recover(await read(creationRequestId)));
        },
    };
}
