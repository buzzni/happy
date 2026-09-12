/**
 * The push inbox: one attempt, no reuse, and `null` that never hides a failure.
 */
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';

import {
    canonicalManagedPayloadDigest,
    parseManagedVerifierKey,
} from '@/daemon/managedDispatchToken';

import { MANAGED_TARGET_MAX_BYTES } from './managedProviderStateScope';
import {
    createManagedCheckpointTargetInbox,
    parseManagedCheckpointTargetDelivery,
    parseManagedCheckpointTargetEnvelope,
    authenticateManagedCheckpointTarget,
    type ManagedCheckpointTargetDelivery,
} from './managedCheckpointTargetInbox';

/**
 * A receipt stands for "this was authenticated at receipt". Every acceptance
 * has one: the inbox takes no target that nothing established the origin of.
 */
const RECEIPT = { epoch: 1, requestKey: 'req-0', issuedAtMs: 0, expiresAtMs: 60_000 };

const target = (over: Partial<ManagedCheckpointTargetDelivery> = {}): ManagedCheckpointTargetDelivery => ({
    checkpointId: 'a'.repeat(64),
    key: Buffer.alloc(32, 3),
    targets: {} as never,
    expiresAt: 10_000,
    ...over,
});

describe('createManagedCheckpointTargetInbox', () => {
    it('shouldAnswerNullWhenTheParentHasPushedNothing', async () => {
        const inbox = createManagedCheckpointTargetInbox({ now: () => 0 });
        expect(await inbox.next()).toBeNull();
        expect(inbox.pending()).toBe(false);
    });

    it('shouldHandOverWhatWasPushed', async () => {
        const inbox = createManagedCheckpointTargetInbox({ now: () => 0 });
        inbox.accept(target(), RECEIPT);
        expect(inbox.pending()).toBe(true);
        const taken = await inbox.next();
        expect(taken).toMatchObject({ checkpointId: 'a'.repeat(64) });
        // The expiry is the delivery's own bookkeeping, not the runner's input.
        expect(taken).not.toHaveProperty('expiresAt');
    });

    it('shouldGiveTheSameTargetToOnlyOneCheckpoint', async () => {
        /*
         * The key is live for exactly one checkpoint and the URLs are signed
         * for one attempt. A second use would seal another archive under a key
         * that is no longer that archive's alone, and upload it over a key some
         * other attempt owns.
         */
        const inbox = createManagedCheckpointTargetInbox({ now: () => 0 });
        inbox.accept(target(), RECEIPT);
        expect(await inbox.next()).not.toBeNull();
        expect(await inbox.next()).toBeNull();
        expect(inbox.pending()).toBe(false);
    });

    it('shouldPreferTheNewerIssueWhenTheParentReissuedBeforeItWasUsed', async () => {
        const inbox = createManagedCheckpointTargetInbox({ now: () => 0 });
        inbox.accept(target({ checkpointId: 'b'.repeat(64) }), RECEIPT);
        inbox.accept(target({ checkpointId: 'c'.repeat(64) }), RECEIPT);
        // The older attempt's URLs are the stale pair.
        expect(await inbox.next()).toMatchObject({ checkpointId: 'c'.repeat(64) });
    });

    it('shouldNotHandOverATargetThatExpiredWhileItWaited', async () => {
        let now = 0;
        const expired: Array<{ checkpointId: string }> = [];
        const inbox = createManagedCheckpointTargetInbox({
            now: () => now,
            onExpired: (info) => expired.push(info),
        });
        inbox.accept(target({ expiresAt: 5_000 }), RECEIPT);

        now = 5_000;
        // Using it anyway fails at the upload; dropping it in silence looks
        // exactly like an idle project. So: nothing usable, and it is reported.
        expect(await inbox.next()).toBeNull();
        expect(expired).toEqual([{ checkpointId: 'a'.repeat(64), expiredAtMs: 5_000 }]);
    });

    it('shouldReportAnExpiredTargetOnlyOnce', async () => {
        let now = 0;
        const expired: unknown[] = [];
        const inbox = createManagedCheckpointTargetInbox({
            now: () => now, onExpired: (info) => expired.push(info),
        });
        inbox.accept(target({ expiresAt: 1 }), RECEIPT);
        now = 2;
        await inbox.next();
        await inbox.next();
        expect(expired).toHaveLength(1);
    });
});

describe('parseManagedCheckpointTargetDelivery', () => {
    const wire = (over: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({
        checkpointId: 'a'.repeat(64),
        keyBase64: Buffer.alloc(32, 5).toString('base64'),
        expiresAt: 10_000,
        targets: {
            areas: [{ area: 'project', putUrl: 'https://s/p?put', headUrl: 'https://s/p?head' }],
            manifest: { putUrl: 'https://s/m?put', headUrl: 'https://s/m?head' },
            pointer: { putUrl: 'https://s/ptr?put', getUrl: 'https://s/ptr?get' },
        },
        ...over,
    }), 'utf8');

    it('shouldReadADeliveryTheParentActuallyIssued', () => {
        const delivery = parseManagedCheckpointTargetDelivery(wire());
        expect(delivery.checkpointId).toBe('a'.repeat(64));
        expect(delivery.key).toHaveLength(32);
        expect(delivery.targets.objects.get('project')).toEqual({
            putUrl: 'https://s/p?put', headUrl: 'https://s/p?head',
        });
        // PUT and HEAD are signed separately: a presigned URL authorises the
        // method it was signed for, so one doing both is the wider permission.
        expect(delivery.targets.manifest.putUrl).not.toBe(delivery.targets.manifest.headUrl);
    });

    it('shouldRequireTheManifestTarget', () => {
        // A restore reads the manifest, not the area objects. Without it the
        // archive cannot describe itself.
        const broken = JSON.parse(wire().toString('utf8'));
        delete broken.targets.manifest;
        expect(() => parseManagedCheckpointTargetDelivery(Buffer.from(JSON.stringify(broken))))
            .toThrow(/manifest/);
    });

    it('shouldRequireAPointerGetUrlRatherThanAPrecomputedEtag', () => {
        const broken = JSON.parse(wire().toString('utf8'));
        broken.targets.pointer = { putUrl: 'https://s/ptr?put', ifMatch: '"etag"' };
        /*
         * The publisher reads the pointer itself and conditions its PUT on what
         * it read. An etag captured when the target was issued is stale by
         * exactly the window CAS exists to close.
         */
        expect(() => parseManagedCheckpointTargetDelivery(Buffer.from(JSON.stringify(broken))))
            .toThrow(/pointer/);
    });

    it('shouldRefuseAKeyThatIsNotTheArchivesKeyLength', () => {
        expect(() => parseManagedCheckpointTargetDelivery(
            wire({ keyBase64: Buffer.alloc(16, 5).toString('base64') }),
        )).toThrow(/32 bytes/);
    });

    it('shouldNeverPutTheKeyOrAUrlIntoARefusal', () => {
        const secret = Buffer.alloc(32, 9).toString('base64');
        try {
            parseManagedCheckpointTargetDelivery(wire({ keyBase64: secret, checkpointId: 'nope' }));
            throw new Error('should have refused');
        } catch (error) {
            const text = String((error as Error).message);
            expect(text).not.toContain(secret);
            expect(text).not.toContain('https://s/');
        }
    });
});

describe('a target redelivered after its ACK was lost', () => {
    /**
     * The parent issues a target, the runtime takes it, and the ACK is lost on
     * the way back. The parent retries — correctly, because from where it
     * stands nothing was acknowledged — and reissues **the same checkpoint id**
     * with freshly signed URLs.
     *
     * Handing that out again seals the same volume twice and moves the pointer
     * twice, under one id. The ids being equal is not deduplication; it is what
     * makes the second run indistinguishable from the first in every record
     * afterwards.
     *
     * But a redelivery is not always a duplicate. An attempt that **failed** has
     * to be retryable, or the window it belonged to has no checkpoint at all,
     * ever. So the id carries a state, and only a *completed* one is final.
     */
    const ID = 'a'.repeat(64);

    it('shouldNotHandOutAnIdThatIsAlreadyRunning', async () => {
        const inbox = createManagedCheckpointTargetInbox({ now: () => 1_000 });
        expect(inbox.accept(target(), RECEIPT)).toEqual({ accepted: true, state: 'queued' });
        expect((await inbox.next())?.checkpointId).toBe(ID);

        // The retry, while the first attempt is still in flight.
        expect(inbox.accept(target(), RECEIPT)).toEqual({ accepted: true, state: 'in-flight' });
        expect(await inbox.next()).toBeNull();
        expect(inbox.pending()).toBe(false);
    });

    it('shouldRefuseAnIdWhosePointerWasAlreadyPublished', async () => {
        const inbox = createManagedCheckpointTargetInbox({ now: () => 1_000 });
        inbox.accept(target(), RECEIPT);
        await inbox.next();
        inbox.settle({ checkpointId: ID, outcome: 'published' });

        // Final: the parent must stop retrying this attempt and move on.
        expect(inbox.accept(target(), RECEIPT)).toEqual({ accepted: true, state: 'completed' });
        expect(await inbox.next()).toBeNull();
    });

    it('shouldLetAnAttemptThatWroteNothingBeDeliveredAgainUnderTheSameId', async () => {
        // Nothing reached the store, so nothing there can collide with a later
        // attempt under this id. This is the only automatically retryable end.
        const inbox = createManagedCheckpointTargetInbox({ now: () => 1_000 });
        inbox.accept(target(), RECEIPT);
        await inbox.next();
        inbox.settle({ checkpointId: ID, outcome: 'unstarted' });

        expect(inbox.accept(target(), RECEIPT)).toEqual({ accepted: true, state: 'queued' });
        expect((await inbox.next())?.checkpointId).toBe(ID);
    });

    it('shouldNotRerunAnIdWhoseAttemptStoppedWithoutProvingWhatItWrote', async () => {
        /*
         * The publisher uploads objects and the manifest with `ifAbsent: true`,
         * so a second attempt under the same id meets its own half-finished
         * upload and is refused 412 — every time, not once. And a throw is not
         * evidence the pointer went unpublished: the PUT may have succeeded
         * with the answer lost. Neither question is answerable by running
         * again, so the id is held until something looks at the store.
         */
        const inbox = createManagedCheckpointTargetInbox({ now: () => 1_000 });
        inbox.accept(target(), RECEIPT);
        await inbox.next();
        inbox.settle({ checkpointId: ID, outcome: 'uncertain' });

        expect(inbox.accept(target(), RECEIPT)).toEqual({ accepted: true, state: 'needs-verification' });
        expect(await inbox.next()).toBeNull();
    });

    it('shouldStillAcceptADifferentIdAfterAnUncertainAttempt', async () => {
        // The parent's recovery is a new attempt id; holding the old one must
        // not stop the runtime checkpointing again.
        const inbox = createManagedCheckpointTargetInbox({ now: () => 1_000 });
        inbox.accept(target(), RECEIPT);
        await inbox.next();
        inbox.settle({ checkpointId: ID, outcome: 'uncertain' });

        expect(inbox.accept(target({ checkpointId: 'c'.repeat(64) }), RECEIPT))
            .toEqual({ accepted: true, state: 'queued' });
        expect((await inbox.next())?.checkpointId).toBe('c'.repeat(64));
    });

    it('shouldStillReplaceAnUnconsumedTargetWhenTheParentReissuesIt', () => {
        // Nothing has been handed out, so the newer issue is the live one and
        // the older attempt's URLs are the stale pair.
        const inbox = createManagedCheckpointTargetInbox({ now: () => 1_000 });
        inbox.accept(target(), RECEIPT);
        expect(inbox.accept(target(), RECEIPT)).toEqual({ accepted: true, state: 'replaced-unconsumed' });
        expect(inbox.pending()).toBe(true);
    });

    it('shouldNotLetAnExpiredHandOutBlockADifferentCheckpointLater', async () => {
        let clock = 1_000;
        const inbox = createManagedCheckpointTargetInbox({ now: () => clock });
        inbox.accept(target(), RECEIPT);
        clock = 11_000;
        expect(await inbox.next()).toBeNull();
        inbox.accept(target({ checkpointId: 'b'.repeat(64), expiresAt: 20_000 }), RECEIPT);
        expect((await inbox.next())?.checkpointId).toBe('b'.repeat(64));
    });

    it('shouldNotMarkAnExpiredTargetAsHavingRun', async () => {
        // It was discarded, not consumed: the same id may be reissued.
        let clock = 1_000;
        const inbox = createManagedCheckpointTargetInbox({ now: () => clock });
        inbox.accept(target(), RECEIPT);
        clock = 11_000;
        expect(await inbox.next()).toBeNull();
        expect(inbox.accept(target({ expiresAt: 20_000 }), RECEIPT)).toEqual({ accepted: true, state: 'queued' });
    });
});

describe('the provider-state scope the parent signs into the target', () => {
    const wire = (over: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({
        checkpointId: 'a'.repeat(64),
        keyBase64: Buffer.alloc(32, 5).toString('base64'),
        expiresAt: 10_000,
        targets: {
            areas: [{ area: 'project', putUrl: 'https://s/p?put', headUrl: 'https://s/p?head' }],
            manifest: { putUrl: 'https://s/m?put', headUrl: 'https://s/m?head' },
            pointer: { putUrl: 'https://s/ptr?put', getUrl: 'https://s/ptr?get' },
        },
        ...over,
    }), 'utf8');
    const RUNTIME = 'runtime-1';
    const NATIVE = '330a1f93-cda9-4080-89a3-c780c9ade479';
    const scope = (over: Record<string, unknown> = {}) => ({
        version: 1,
        provider: 'claude',
        capability: 'native-resume',
        generation: {
            projectId: 'proj-1', workspaceId: 'ws-1', runtimeId: RUNTIME,
            epoch: 3, provisioningOperationId: 'op-1',
        },
        sources: [{
            attemptId: 'attempt-1', runId: 'run-1', happySessionId: 'sess-1',
            runtimeId: RUNTIME, epoch: 3, currentNativeId: NATIVE,
            retainedNativeIds: [], metadataVersion: 1,
        }],
        ...over,
    });

    it('shouldCarryTheScopeThroughToTheDelivery', () => {
        // The runtime cannot compare against a document it did not keep. Before
        // this the parser dropped every field it did not itself use.
        const delivery = parseManagedCheckpointTargetDelivery(wire({ providerStateScope: scope() }));
        expect(delivery.providerStateScope?.sources[0]?.currentNativeId).toBe(NATIVE);
        expect(delivery.providerStateScope?.generation.epoch).toBe(3);
    });

    it('shouldLeaveTheScopeAbsentWhenTheParentSentNone', () => {
        /*
         * Absent is the shape every target has today, and it stays legal. It is
         * **not** permission to archive provider state and **not** evidence
         * that no provider ran - the publisher refuses either way.
         */
        expect(parseManagedCheckpointTargetDelivery(wire()).providerStateScope).toBeUndefined();
    });

    it('shouldRefuseTheWholeDeliveryWhenTheScopeIsMalformed', () => {
        // Not "drop the scope and carry on": a target whose scope this runtime
        // cannot read is a target it cannot act on correctly.
        expect(() => parseManagedCheckpointTargetDelivery(wire({
            providerStateScope: scope({ sources: [] }),
        }))).toThrow(/provider-state scope/);
    });

    it('shouldRefuseADocumentOverTheLimitBeforeParsingIt', () => {
        /*
         * Measured before `JSON.parse`, on the raw **bytes**. Parsing first to
         * find out it was too large means already paying for it, and a string
         * length is not a byte count once anything non-ASCII is in the URLs.
         */
        const oversized = Buffer.concat([
            Buffer.from('{"pad":"', 'utf8'),
            Buffer.alloc(MANAGED_TARGET_MAX_BYTES, 0x61),
            Buffer.from('"}', 'utf8'),
        ]);
        expect(oversized.length).toBeGreaterThan(MANAGED_TARGET_MAX_BYTES);
        expect(() => parseManagedCheckpointTargetDelivery(oversized)).toThrow(/too large/);
    });

    it('shouldMeasureBytesRatherThanCharacters', () => {
        // A multi-byte character counts as what it costs on the wire. Measuring
        // `.length` after `toString()` would undercount every one of them.
        const multibyte = '\u00e9'.repeat(MANAGED_TARGET_MAX_BYTES / 2 + 1);
        const raw = Buffer.from(`{"pad":"${multibyte}"}`, 'utf8');
        expect(raw.toString('utf8').length).toBeLessThan(MANAGED_TARGET_MAX_BYTES);
        expect(raw.length).toBeGreaterThan(MANAGED_TARGET_MAX_BYTES);
        expect(() => parseManagedCheckpointTargetDelivery(raw)).toThrow(/too large/);
    });

    it('shouldAcceptADocumentExactlyAtTheLimit', () => {
        // The boundary is inclusive, and a target that fits must not be refused
        // for being close to the edge.
        const base = JSON.parse(wire().toString('utf8')) as Record<string, unknown>;
        const fixed = Buffer.from(JSON.stringify({ ...base, pad: '' }), 'utf8').length;
        const pad = 'a'.repeat(MANAGED_TARGET_MAX_BYTES - fixed);
        const raw = Buffer.from(JSON.stringify({ ...base, pad }), 'utf8');
        expect(raw.length).toBe(MANAGED_TARGET_MAX_BYTES);
        // `pad` is not a field the parser knows, but the size gate is what is
        // under test here and it runs first.
        expect(() => parseManagedCheckpointTargetDelivery(raw)).not.toThrow(/too large/);
    });
});

describe('the scope survives the pipeline it is carried through', () => {
    const NATIVE = '330a1f93-cda9-4080-89a3-c780c9ade479';
    const scoped = (): ManagedCheckpointTargetDelivery => ({
        ...target(),
        providerStateScope: {
            version: 1,
            provider: 'claude',
            capability: 'native-resume',
            generation: {
                projectId: 'proj-1', workspaceId: 'ws-1', runtimeId: 'runtime-1',
                epoch: 3, provisioningOperationId: 'op-1',
            },
            sources: [{
                attemptId: 'attempt-1', runId: 'run-1', happySessionId: 'sess-1',
                runtimeId: 'runtime-1', epoch: 3, currentNativeId: NATIVE,
                retainedNativeIds: [], metadataVersion: 1,
            }],
        },
    });

    it('shouldHandTheScopeOnWhenTheInboxReleasesTheRequest', async () => {
        /*
         * `inbox.next()` strips `expiresAt` with a rest spread, so the scope
         * rides along structurally - but `ManagedCheckpointRequest` never
         * declared it, which means the next hop can drop it without the types
         * noticing. Asserting it here pins the carrier rather than the accident.
         */
        const inbox = createManagedCheckpointTargetInbox({ now: () => 0 });
        inbox.accept(scoped());
        const request = await inbox.next();
        expect(request?.providerStateScope?.sources[0]?.currentNativeId).toBe(NATIVE);
    });
});

describe('the envelope keeps the bytes the parent signed', () => {
    const wireDoc = (over: Record<string, unknown> = {}) => ({
        checkpointId: 'a'.repeat(64),
        keyBase64: Buffer.alloc(32, 5).toString('base64'),
        expiresAt: 10_000,
        targets: {
            areas: [{ area: 'project', putUrl: 'https://s/p?put', headUrl: 'https://s/p?head' }],
            manifest: { putUrl: 'https://s/m?put', headUrl: 'https://s/m?head' },
            pointer: { putUrl: 'https://s/ptr?put', getUrl: 'https://s/ptr?get' },
        },
        ...over,
    });

    it('shouldReturnTheRawParamsBesideTheReconstructedDelivery', () => {
        /*
         * The signature is over what the parent sent. The delivery is a
         * *reconstruction* - `keyBase64` becomes a Buffer, `targets.areas[]`
         * becomes a Map - so a digest taken over it cannot equal the one that
         * was signed. Both shapes come back from one parse: the raw object for
         * the digest, the delivery for everything downstream.
         */
        const doc = wireDoc();
        const envelope = parseManagedCheckpointTargetEnvelope(Buffer.from(JSON.stringify(doc), 'utf8'));
        expect(envelope.rawParams).toEqual(doc);
        expect(envelope.delivery.checkpointId).toBe('a'.repeat(64));
        expect(envelope.delivery.key).toHaveLength(32);
        expect(envelope.delivery.targets.objects.get('project')).toEqual({
            putUrl: 'https://s/p?put', headUrl: 'https://s/p?head',
        });
    });

    it('shouldNotHandBackAReconstructionAsTheSignedBytes', () => {
        // The distinction this whole envelope exists for: a digest over the
        // delivery is not the digest the parent signed.
        const doc = wireDoc();
        const envelope = parseManagedCheckpointTargetEnvelope(Buffer.from(JSON.stringify(doc), 'utf8'));
        expect(envelope.rawParams).not.toBe(envelope.delivery as unknown);
        expect((envelope.rawParams as Record<string, unknown>).keyBase64).toBe(doc.keyBase64);
        expect((envelope.rawParams as Record<string, unknown>).targets).toEqual(doc.targets);
    });

    it('shouldKeepTheExistingParserAsAWrapper', () => {
        // Every existing caller keeps working, and both parsers agree.
        const raw = Buffer.from(JSON.stringify(wireDoc()), 'utf8');
        expect(parseManagedCheckpointTargetDelivery(raw))
            .toEqual(parseManagedCheckpointTargetEnvelope(raw).delivery);
    });

    it('shouldRefuseTheSameDocumentsTheDeliveryParserRefuses', () => {
        const broken = Buffer.from(JSON.stringify(wireDoc({ checkpointId: 'nope' })), 'utf8');
        expect(() => parseManagedCheckpointTargetEnvelope(broken)).toThrow(/checkpointId/);
    });
});

describe('authenticating a received checkpoint target', () => {
    /*
     * The supervisor has no current epoch and no lease view - only its
     * root-owned marker. What it can establish is that the parent signed *this
     * document*, for *this* runtime, workspace, project and provisioning
     * operation, within the token's own life. That is authenticated material,
     * not authority: `claims.epoch` is recorded as a fact and never fed back to
     * a verifier as truth.
     */
    const keys = generateKeyPairSync('ed25519');
    const verifier = parseManagedVerifierKey(
        keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer,
    );
    const NOW = 1_800_000_000_000;
    const CHECKPOINT = 'a'.repeat(64);

    /*
     * The parent's own shape, read from its issuer rather than invented here:
     * `packages/web-ui/server/cloudCheckpointTargetIssuer.ts:546` signs
     * `<provisioningOperationId>:<epoch>:checkpoint:<checkpointId>`.
     */
    const REQUEST_KEY = `op-1:7:checkpoint:${CHECKPOINT}`;

    const authority = {
        verifier,
        runtimeId: 'runtime-1',
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        keyId: 'kid-1',
        provisioningOperationId: 'op-1',
    };

    const doc = (over: Record<string, unknown> = {}) => ({
        checkpointId: CHECKPOINT,
        keyBase64: Buffer.alloc(32, 5).toString('base64'),
        expiresAt: NOW + 600_000,
        targets: {
            areas: [{ area: 'project', putUrl: 'https://s/p?put', headUrl: 'https://s/p?head' }],
            manifest: { putUrl: 'https://s/m?put', headUrl: 'https://s/m?head' },
            pointer: { putUrl: 'https://s/ptr?put', getUrl: 'https://s/ptr?get' },
        },
        ...over,
    });

    /** Mints over the params **as sent**, exactly as the parent must. */
    const sign_ = (params: unknown, over: Record<string, unknown> = {}) => {
        const digest = canonicalManagedPayloadDigest(params);
        const body = {
            v: 1, kid: 'kid-1', aud: 'runtime-1', op: 'checkpoint',
            workspaceId: 'ws-1', projectId: 'proj-1', provisioningOperationId: 'op-1',
            checkpointId: CHECKPOINT, requestKey: REQUEST_KEY,
            epoch: 7, payloadDigest: digest, paramsDigest: digest,
            iat: NOW, exp: NOW + 60_000,
            ...over,
        };
        const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
        return `${encoded}.${sign(null, Buffer.from(encoded, 'utf8'), keys.privateKey).toString('base64url')}`;
    };

    const authenticate = (over: Partial<Parameters<typeof authenticateManagedCheckpointTarget>[0]> = {}) => {
        const params = doc();
        return authenticateManagedCheckpointTarget({
            rawParams: params,
            dispatchToken: sign_(params),
            checkpointId: CHECKPOINT,
            authority,
            now: NOW + 1_000,
            ...over,
        });
    };

    it('shouldAuthenticateATokenSignedOverTheParamsAsTheyArrived', () => {
        /*
         * End to end through the real envelope parser: the digest is taken over
         * what `JSON.parse` produced, not over the reconstructed delivery. If
         * this is ever taken over the delivery instead, every real target
         * refuses as `payload-mismatch`.
         */
        const raw = Buffer.from(JSON.stringify(doc()), 'utf8');
        const envelope = parseManagedCheckpointTargetEnvelope(raw);
        const result = authenticateManagedCheckpointTarget({
            rawParams: envelope.rawParams,
            dispatchToken: sign_(JSON.parse(raw.toString('utf8'))),
            checkpointId: envelope.delivery.checkpointId,
            authority,
            now: NOW + 1_000,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // The epoch is carried as a recorded fact. Nothing compares it to a
        // current epoch, because this process has none to compare against.
        expect(result.claims.epoch).toBe(7);
        expect(result.claims.checkpointId).toBe(CHECKPOINT);
        expect(result.receipt.requestKey).toBe(REQUEST_KEY);
    });

    it('shouldRefuseARequestKeyThatDoesNotDeriveFromThisOperationAndEpoch', () => {
        /*
         * Derived from three things this process already trusts or has just
         * verified: its own marker's operation, the epoch the token was signed
         * with, and the checkpoint the params name. It binds the token to this
         * provisioning a second way, independent of the operation claim the
         * verifier compared - and each part alone is enough to refuse.
         */
        const params = doc();
        for (const key of [
            'req-1',
            `op-2:7:checkpoint:${CHECKPOINT}`,
            `op-1:8:checkpoint:${CHECKPOINT}`,
            `op-1:7:checkpoint:${'b'.repeat(64)}`,
            `op-1:7:status:${CHECKPOINT}`,
        ]) {
            expect(authenticate({ rawParams: params, dispatchToken: sign_(params, { requestKey: key }) }))
                .toEqual({ ok: false, reason: 'request-key-mismatch' });
        }
    });

    it('shouldFollowTheSignedEpochWhenDerivingTheRequestKey', () => {
        // Not pinned to one epoch: a token signed for epoch 9 must carry the
        // key for epoch 9. Deriving from a fixed number would refuse every
        // checkpoint after the first generation.
        const params = doc();
        expect(authenticate({
            rawParams: params,
            dispatchToken: sign_(params, { epoch: 9, requestKey: `op-1:9:checkpoint:${CHECKPOINT}` }),
        }).ok).toBe(true);
    });

    it('shouldRefuseParamsMutatedAfterTheySigned', () => {
        // The destination is the interesting field: a relay that let this
        // through would upload a sealed archive wherever the mutation says.
        const signed = doc();
        const token = sign_(signed);
        const moved = doc({
            targets: { ...signed.targets, pointer: { putUrl: 'https://evil/put', getUrl: 'https://evil/get' } },
        });
        expect(authenticate({ rawParams: moved, dispatchToken: token }))
            .toEqual({ ok: false, reason: 'payload-mismatch' });
    });

    it('shouldRefuseATokenThatNamesAnotherIdentity', () => {
        // Each axis alone is enough to refuse; none of them is implied by
        // another, and the signature is valid in every one of these.
        for (const [field, value, reason] of [
            ['aud', 'runtime-2', 'wrong-audience'],
            ['workspaceId', 'ws-2', 'wrong-workspace'],
            ['provisioningOperationId', 'op-2', 'wrong-operation'],
        ] as const) {
            const params = doc();
            expect(authenticate({
                rawParams: params, dispatchToken: sign_(params, { [field]: value }),
            })).toEqual({ ok: false, reason });
        }
    });

    it('shouldRefuseAProjectOrKeyTheMarkerDoesNotName', () => {
        /*
         * Neither is an input to the verifier - the daemon performs both
         * separately (`managedRpcHandlers.ts:522,525`), and a supervisor that
         * skipped them would be checking *less* than the daemon does while
         * holding more privilege.
         */
        const params = doc();
        expect(authenticate({ rawParams: params, dispatchToken: sign_(params, { projectId: 'proj-2' }) }))
            .toEqual({ ok: false, reason: 'wrong-project' });
        expect(authenticate({ rawParams: params, dispatchToken: sign_(params, { kid: 'kid-2' }) }))
            .toEqual({ ok: false, reason: 'wrong-key' });
    });

    it('shouldRefuseATokenPastItsOwnLifeByThisProcessesClock', () => {
        const params = doc();
        expect(authenticate({
            rawParams: params, dispatchToken: sign_(params), now: NOW + 60_001,
        })).toEqual({ ok: false, reason: 'expired' });
    });

    it('shouldRefuseACheckpointIdTheParamsDoNotAgreeWith', () => {
        // The token names what it authorises; the params name what would be
        // written. Disagreement means a target for one checkpoint accepted
        // under another's authorisation.
        const params = doc();
        expect(authenticate({
            rawParams: params, dispatchToken: sign_(params, { checkpointId: 'b'.repeat(64) }),
        })).toEqual({ ok: false, reason: 'checkpoint-mismatch' });
    });

    it('shouldRefuseATokenSignedByAnotherKey', () => {
        const other = generateKeyPairSync('ed25519');
        const params = doc();
        const digest = canonicalManagedPayloadDigest(params);
        const body = Buffer.from(JSON.stringify({
            v: 1, kid: 'kid-1', aud: 'runtime-1', op: 'checkpoint', workspaceId: 'ws-1',
            projectId: 'proj-1', provisioningOperationId: 'op-1', checkpointId: CHECKPOINT,
            requestKey: REQUEST_KEY, epoch: 7, payloadDigest: digest, paramsDigest: digest,
            iat: NOW, exp: NOW + 60_000,
        }), 'utf8').toString('base64url');
        const forged = `${body}.${sign(null, Buffer.from(body, 'utf8'), other.privateKey).toString('base64url')}`;
        expect(authenticate({ rawParams: params, dispatchToken: forged }))
            .toEqual({ ok: false, reason: 'bad-signature' });
    });
});

describe('the inbox keeps the receipt with the candidate it authenticated', () => {
    const receiptFor = (epoch: number, key: string) => ({
        epoch, requestKey: key, issuedAtMs: 1_000, expiresAtMs: 61_000,
    });

    it('shouldHandTheReceiptOnWithTheRequestItBelongsTo', async () => {
        // It travels *on* the request. A consumer reached through `next()` is
        // the one that must eventually compare this epoch with what it observes.
        const inbox = createManagedCheckpointTargetInbox({ now: () => 1_000 });
        inbox.accept(target(), receiptFor(7, 'req-1'));
        expect((await inbox.next())?.receipt).toEqual(receiptFor(7, 'req-1'));
    });

    it('shouldHandOnTheReplacementsReceiptAndNotTheReplacedOne', async () => {
        /*
         * accept(A) -> accept(B) -> next() must yield B's receipt. A receipt
         * held apart from its target reads as current after the target it
         * described is gone; here the pair moves together or not at all.
         */
        const inbox = createManagedCheckpointTargetInbox({ now: () => 1_000 });
        inbox.accept(target({ checkpointId: 'a'.repeat(64) }), receiptFor(7, 'req-A'));
        inbox.accept(target({ checkpointId: 'b'.repeat(64) }), receiptFor(8, 'req-B'));
        const taken = await inbox.next();
        expect(taken?.checkpointId).toBe('b'.repeat(64));
        expect(taken?.receipt).toEqual(receiptFor(8, 'req-B'));
    });

    it('shouldDropTheReceiptWithTheTargetItExpiredWith', async () => {
        // Expiry removes the candidate; nothing is left behind describing it.
        let clock = 1_000;
        const inbox = createManagedCheckpointTargetInbox({ now: () => clock });
        inbox.accept(target({ expiresAt: 5_000 }), receiptFor(7, 'req-A'));
        clock = 5_000;
        expect(await inbox.next()).toBeNull();
        clock = 5_001;
        inbox.accept(target({ checkpointId: 'c'.repeat(64), expiresAt: 9_000 }), receiptFor(9, 'req-C'));
        const taken = await inbox.next();
        expect(taken?.receipt).toEqual(receiptFor(9, 'req-C'));
    });

    it('shouldGiveEachInFlightRequestItsOwnReceipt', async () => {
        /*
         * Two ids, taken one after the other: each carries the receipt it was
         * accepted with. A single shared slot would have handed the second
         * request the first one's epoch, which is precisely the comparison a
         * consumer would later make wrongly.
         */
        const inbox = createManagedCheckpointTargetInbox({ now: () => 1_000 });
        inbox.accept(target({ checkpointId: 'a'.repeat(64) }), receiptFor(7, 'req-A'));
        const first = await inbox.next();
        inbox.accept(target({ checkpointId: 'b'.repeat(64) }), receiptFor(8, 'req-B'));
        const second = await inbox.next();
        expect(first?.receipt).toEqual(receiptFor(7, 'req-A'));
        expect(second?.receipt).toEqual(receiptFor(8, 'req-B'));
    });

    it('shouldCarryNoReceiptWhenNothingAuthenticatedTheTarget', async () => {
        // No claim is invented for a target that arrived without one. The gate
        // that refuses those is the wire boundary, not this inbox.
        const inbox = createManagedCheckpointTargetInbox({ now: () => 1_000 });
        inbox.accept(target());
        expect((await inbox.next())?.receipt).toBeUndefined();
    });
});
