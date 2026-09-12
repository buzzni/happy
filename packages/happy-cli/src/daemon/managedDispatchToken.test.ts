import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';

import {
    canonicalManagedPayloadDigest,
    parseManagedVerifierKey,
    verifyManagedDispatchMaterial,
    verifyManagedDispatchToken,
    type ManagedRunTokenClaims,
} from './managedDispatchToken';

const keys = generateKeyPairSync('ed25519');
const publicKeyDer = keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
const verifier = parseManagedVerifierKey(publicKeyDer);

const NOW = 1_800_000_000_000;

function claims(overrides: Partial<ManagedRunTokenClaims> = {}): Record<string, unknown> {
    return {
        v: 1,
        kid: 'test-kid',
        aud: 'runtime-1',
        op: 'spawn',
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        runId: 'run-1',
        attemptId: 'attempt-1',
        requestKey: 'req-1',
        epoch: 3,
        payloadDigest: canonicalManagedPayloadDigest({ b: 2, a: 1 }),
        iat: NOW,
        exp: NOW + 60_000,
        ...overrides,
    };
}

function mint(body: Record<string, unknown>, signWith = keys.privateKey): string {
    const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
    // Ed25519 hashes internally; the digest argument must be null (a named
    // digest throws ERR_OSSL_INVALID_DIGEST even for a valid signature).
    const signature = sign(null, Buffer.from(encoded, 'utf8'), signWith);
    return `${encoded}.${signature.toString('base64url')}`;
}

function verify(token: string, overrides: Partial<Parameters<typeof verifyManagedDispatchToken>[0]> = {}) {
    return verifyManagedDispatchToken({
        token,
        verifier,
        runtimeId: 'runtime-1',
        workspaceId: 'ws-1',
        op: 'spawn',
        paramsDigest: canonicalManagedPayloadDigest({ a: 1, b: 2 }),
        currentEpoch: 3,
        now: NOW + 1_000,
        ...overrides,
    });
}

describe('verifyManagedDispatchToken', () => {
    it('accepts a token signed with the provisioned key', () => {
        const result = verify(mint(claims()));
        expect(result).toMatchObject({ ok: true });
        if (result.ok && result.claims.op === 'spawn') {
            expect(result.claims.requestKey).toBe('req-1');
            expect(result.claims.runId).toBe('run-1');
        }
    });

    it('rejects a signature produced by a different key', () => {
        const other = generateKeyPairSync('ed25519');
        expect(verify(mint(claims(), other.privateKey)))
            .toEqual({ ok: false, reason: 'bad-signature' });
    });

    it('rejects a tampered payload that keeps a well-formed signature', () => {
        const token = mint(claims());
        const [body, signature] = token.split('.');
        const forged = Buffer.from(JSON.stringify(claims({ requestKey: 'req-2' })), 'utf8')
            .toString('base64url');
        expect(verify(`${forged}.${signature}`))
            .toEqual({ ok: false, reason: 'bad-signature' });
        expect(body).not.toBe(forged);
    });

    it('rejects a truncated signature without throwing', () => {
        const token = mint(claims());
        const truncated = `${token.split('.')[0]}.${token.split('.')[1]!.slice(0, 40)}`;
        expect(verify(truncated)).toEqual({ ok: false, reason: 'bad-signature' });
    });

    it('separates a malformed verifier key from a bad signature', () => {
        expect(() => parseManagedVerifierKey(Buffer.from('not-a-key')))
            .toThrowError(/managed verifier key/);
    });

    it('rejects a token minted for another runtime', () => {
        expect(verify(mint(claims({ aud: 'runtime-2' }))))
            .toEqual({ ok: false, reason: 'wrong-audience' });
    });

    it('rejects a token minted for another workspace', () => {
        expect(verify(mint(claims({ workspaceId: 'ws-2' }))))
            .toEqual({ ok: false, reason: 'wrong-workspace' });
    });

    it('rejects a lease token replayed as a spawn token', () => {
        expect(verify(mint(claims({ op: 'lease' }))))
            .toEqual({ ok: false, reason: 'wrong-op' });
    });

    it('rejects an expired token', () => {
        expect(verify(mint(claims()), { now: NOW + 61_000 }))
            .toEqual({ ok: false, reason: 'expired' });
    });

    it('rejects a token issued too far in the future', () => {
        expect(verify(mint(claims({ iat: NOW + 300_000, exp: NOW + 330_000 }))))
            .toEqual({ ok: false, reason: 'clock-skew' });
    });

    it('rejects a token whose lifetime exceeds the cap', () => {
        expect(verify(mint(claims({ exp: NOW + 30 * 60_000 }))))
            .toEqual({ ok: false, reason: 'ttl-too-long' });
    });

    it('rejects an epoch older than the runtime fencing token', () => {
        expect(verify(mint(claims({ epoch: 2 }))))
            .toEqual({ ok: false, reason: 'stale-epoch' });
    });

    it('refuses a spawn whose epoch is ahead of the runtime', () => {
        // A higher epoch means the server intends a new generation. Letting a
        // spawn ride that intent would start work while the previous
        // generation's children are still writing — the epoch may only be
        // raised by a lease renewal that first fences them.
        expect(verify(mint(claims({ epoch: 4 }))))
            .toEqual({ ok: false, reason: 'epoch-mismatch' });
    });

    it('refuses a stop or query whose epoch is ahead of the runtime', () => {
        for (const op of ['stop', 'query'] as const) {
            expect(verify(mint(claims({ op, epoch: 4 })), { op }))
                .toEqual({ ok: false, reason: 'epoch-mismatch' });
        }
    });

    it('accepts a lease renewal carrying a higher epoch, which is the fence path', () => {
        const token = mint(claims({
            op: 'lease', epoch: 4, renewalSeq: 1, leaseMs: 60_000, absoluteExpiry: NOW + 600_000,
        }));
        expect(verify(token, { op: 'lease' })).toMatchObject({ ok: true });
    });

    it('rejects params that do not match the signed digest', () => {
        expect(verify(mint(claims()), {
            paramsDigest: canonicalManagedPayloadDigest({ a: 1, b: 3 }),
        })).toEqual({ ok: false, reason: 'payload-mismatch' });
    });

    describe('strict field parsing', () => {
        const cases: Array<[string, Record<string, unknown>]> = [
            ['NaN exp', { exp: Number.NaN }],
            ['missing exp', { exp: undefined }],
            ['Infinity iat', { iat: Number.POSITIVE_INFINITY }],
            ['fractional epoch', { epoch: 1.5 }],
            ['negative epoch', { epoch: -1 }],
            ['string epoch', { epoch: '3' }],
            ['unsafe integer exp', { exp: Number.MAX_SAFE_INTEGER + 2 }],
            ['empty requestKey', { requestKey: '' }],
            ['non-string requestKey', { requestKey: 7 }],
            ['missing workspaceId', { workspaceId: undefined }],
            ['wrong version', { v: 2 }],
            ['unknown op', { op: 'delete-everything' }],
        ];
        for (const [name, override] of cases) {
            it(`rejects ${name}`, () => {
                expect(verify(mint(claims(override)))).toEqual({ ok: false, reason: 'malformed' });
            });
        }
    });

    it('requires a lease sequence only on lease tokens', () => {
        const leaseToken = mint(claims({ op: 'lease', renewalSeq: 5, leaseMs: 60_000, absoluteExpiry: NOW + 600_000 }));
        expect(verify(leaseToken, { op: 'lease' })).toMatchObject({ ok: true });
        const missingSeq = mint(claims({ op: 'lease', leaseMs: 60_000, absoluteExpiry: NOW + 600_000 }));
        expect(verify(missingSeq, { op: 'lease' })).toEqual({ ok: false, reason: 'malformed' });
    });

    it('rejects a lease token whose leaseMs exceeds the cap', () => {
        const token = mint(claims({
            op: 'lease', renewalSeq: 5, leaseMs: 60 * 60_000, absoluteExpiry: NOW + 600_000,
        }));
        expect(verify(token, { op: 'lease' })).toEqual({ ok: false, reason: 'malformed' });
    });
});

describe('canonicalManagedPayloadDigest', () => {
    it('is stable across key order so relay reserialization does not break dispatch', () => {
        expect(canonicalManagedPayloadDigest({ a: 1, b: { c: 2, d: 3 } }))
            .toBe(canonicalManagedPayloadDigest({ b: { d: 3, c: 2 }, a: 1 }));
    });

    it('distinguishes different values', () => {
        expect(canonicalManagedPayloadDigest({ a: 1 }))
            .not.toBe(canonicalManagedPayloadDigest({ a: 2 }));
    });

    it('distinguishes an absent key from an explicit undefined-like null', () => {
        expect(canonicalManagedPayloadDigest({ a: 1 }))
            .not.toBe(canonicalManagedPayloadDigest({ a: 1, b: null }));
    });
});

describe('parseManagedVerifierKey', () => {
    it('accepts a DER SPKI ed25519 key', () => {
        expect(parseManagedVerifierKey(publicKeyDer).asymmetricKeyType).toBe('ed25519');
    });

    it('rejects a non-ed25519 key', () => {
        const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
        const der = rsa.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
        expect(() => parseManagedVerifierKey(der)).toThrowError(/ed25519/);
    });
});

/**
 * Reading a runtime's status is not work, and it happens before there is any
 * work to name.
 *
 * The parent asks whether a runtime is ready *before* it creates an attempt
 * (`cloudRunWorker` calls `prepareRuntime` ahead of `beginCloudRunAttempt`),
 * so a claim shape that requires `runId` and `attemptId` can only be satisfied
 * by inventing them. An invented attempt is a real row somewhere, or a real id
 * that later collides with one — either way the ledger stops meaning what it
 * says. So the status claim carries the provisioning operation it belongs to
 * and nothing about a run at all.
 *
 * The separation is enforced in both directions: a status token may not carry
 * run, attempt or lease fields, and a work token may not carry a provisioning
 * operation. Neither is a warning — a token that mixes the two is refused.
 */
describe('the status claim', () => {
    function statusClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
        return {
            v: 1,
            kid: 'test-kid',
            aud: 'runtime-1',
            op: 'status',
            workspaceId: 'ws-1',
            projectId: 'proj-1',
            provisioningOperationId: 'op-1',
            requestKey: 'req-1',
            epoch: 3,
            payloadDigest: canonicalManagedPayloadDigest({}),
            iat: NOW,
            exp: NOW + 60_000,
            ...overrides,
        };
    }

    function verifyStatus(token: string, overrides: Record<string, unknown> = {}) {
        return verifyManagedDispatchToken({
            token,
            verifier,
            runtimeId: 'runtime-1',
            workspaceId: 'ws-1',
            op: 'status',
            paramsDigest: canonicalManagedPayloadDigest({}),
            currentEpoch: 3,
            provisioningOperationId: 'op-1',
            now: NOW + 1_000,
            ...overrides,
        } as never);
    }

    it('accepts a status token that names its provisioning operation', () => {
        const result = verifyStatus(mint(statusClaims()));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.claims.op).toBe('status');
        expect((result.claims as { provisioningOperationId?: string }).provisioningOperationId)
            .toBe('op-1');
    });

    it('refuses a status token without one', () => {
        const { provisioningOperationId: _omitted, ...without } = statusClaims();
        expect(verifyStatus(mint(without))).toEqual({ ok: false, reason: 'malformed' });
    });

    it.each(['runId', 'attemptId'])('refuses a status token carrying %s', (field) => {
        // Present at all, not merely required: a status token that can name a
        // run is a status token that can be replayed as one.
        expect(verifyStatus(mint(statusClaims({ [field]: 'smuggled' }))))
            .toEqual({ ok: false, reason: 'malformed' });
    });

    it.each(['renewalSeq', 'leaseMs', 'absoluteExpiry'])(
        'refuses a status token carrying the lease field %s', (field) => {
            // Reading a status must never be able to hold a write deadline open.
            expect(verifyStatus(mint(statusClaims({ [field]: 1 }))))
                .toEqual({ ok: false, reason: 'malformed' });
        },
    );

    it('refuses a work token that carries a provisioning operation', () => {
        expect(verify(mint(claims({ provisioningOperationId: 'op-1' } as never))))
            .toEqual({ ok: false, reason: 'malformed' });
    });

    it('refuses a status token minted for another operation', () => {
        expect(verifyStatus(mint(statusClaims()), { op: 'query' }))
            .toEqual({ ok: false, reason: 'wrong-op' });
    });

    it('is bound to the provisioning operation this runtime was created by', () => {
        // Lifting the epoch gate leaves the operation as the only thing tying
        // a status token to this runtime's generation. A token minted for a
        // different provisioning operation is a token for a different runtime
        // life — one whose resources this one may already have replaced.
        expect(verifyStatus(mint(statusClaims({ provisioningOperationId: 'op-someone-else' }))))
            .toEqual({ ok: false, reason: 'wrong-operation' });
    });

    it('refuses a status token when the runtime knows of no operation', () => {
        // Fail closed: an unprovisioned runtime cannot confirm anything about
        // which operation a token belongs to.
        expect(verifyStatus(mint(statusClaims()), { provisioningOperationId: undefined }))
            .toEqual({ ok: false, reason: 'wrong-operation' });
    });

    it('reads a runtime that has not been granted an epoch yet', () => {
        // A newly booted runtime holds epoch 0 until the first lease grant, and
        // the parent asks for its status precisely to find that out. Holding
        // the token to the runtime's current epoch would make the question
        // unanswerable exactly when it matters: the parent would have to know
        // the answer in order to ask.
        //
        // The token is bound to the provisioning operation instead, and the
        // runtime reports whatever epoch it currently holds. Nothing is
        // mutated by asking, so an epoch that does not match is a fact to
        // report rather than a request to refuse.
        expect(verifyStatus(mint(statusClaims({ epoch: 4 })), { currentEpoch: 0 }).ok).toBe(true);
        expect(verifyStatus(mint(statusClaims({ epoch: 0 })), { currentEpoch: 4 }).ok).toBe(true);
    });

    it('still holds work tokens to the epoch the runtime is on', () => {
        // The rule that was relaxed for reading is unchanged for writing.
        expect(verify(mint(claims({ epoch: 4 })), { currentEpoch: 3 }))
            .toEqual({ ok: false, reason: 'epoch-mismatch' });
        expect(verify(mint(claims({ epoch: 2 })), { currentEpoch: 3 }))
            .toEqual({ ok: false, reason: 'stale-epoch' });
    });

    it('leaves the existing work wire exactly as it was', () => {
        // The tokens already in flight carry no `provisioningOperationId` and
        // must keep verifying unchanged.
        const result = verify(mint(claims()));
        expect(result.ok).toBe(true);
        if (!result.ok || result.claims.op === 'status' || result.claims.op === 'credential'
            || result.claims.op === 'ai-auth'
            || result.claims.op === 'runtime-lease' || result.claims.op === 'checkpoint') return;
        expect(result.claims.runId).toBe('run-1');
        expect(result.claims.attemptId).toBe('attempt-1');
    });
});

/**
 * The lease a runtime is granted before there is any run to name.
 *
 * A newly booted runtime holds no lease, and the parent needs it fenced before
 * it will dispatch anything — which happens before an attempt exists. The
 * existing `lease` op cannot serve that: its claim requires a run and an
 * attempt, and the only way to satisfy it early is to invent them.
 *
 * So the grant is bound to the provisioning operation instead. It is a write,
 * not a reading: it carries the lease fields the fence path needs, and it is
 * refused if it carries a run.
 */
describe('the runtime-lease claim', () => {
    function leaseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
        return {
            v: 1,
            kid: 'test-kid',
            aud: 'runtime-1',
            op: 'runtime-lease',
            workspaceId: 'ws-1',
            projectId: 'proj-1',
            provisioningOperationId: 'op-1',
            requestKey: 'req-1',
            epoch: 4,
            renewalSeq: 1,
            leaseMs: 60_000,
            absoluteExpiry: NOW + 3_600_000,
            payloadDigest: canonicalManagedPayloadDigest({}),
            iat: NOW,
            exp: NOW + 60_000,
            ...overrides,
        };
    }

    function verifyLease(token: string, overrides: Record<string, unknown> = {}) {
        return verifyManagedDispatchToken({
            token,
            verifier,
            runtimeId: 'runtime-1',
            workspaceId: 'ws-1',
            op: 'runtime-lease',
            paramsDigest: canonicalManagedPayloadDigest({}),
            currentEpoch: 0,
            provisioningOperationId: 'op-1',
            now: NOW + 1_000,
            ...overrides,
        } as never);
    }

    it('grants an epoch to a runtime that has none yet', () => {
        const result = verifyLease(mint(leaseClaims()));
        expect(result.ok).toBe(true);
        if (!result.ok || result.claims.op !== 'runtime-lease') return;
        expect(result.claims.provisioningOperationId).toBe('op-1');
        expect(result.claims.renewalSeq).toBe(1);
        expect(result.claims.leaseMs).toBe(60_000);
        expect(result.claims.absoluteExpiry).toBe(NOW + 3_600_000);
    });

    it.each(['runId', 'attemptId'])('refuses one that names %s', (field) => {
        expect(verifyLease(mint(leaseClaims({ [field]: 'smuggled' }))))
            .toEqual({ ok: false, reason: 'malformed' });
    });

    it.each(['renewalSeq', 'leaseMs', 'absoluteExpiry'])('requires %s', (field) => {
        const claims = leaseClaims();
        delete claims[field];
        expect(verifyLease(mint(claims))).toEqual({ ok: false, reason: 'malformed' });
    });

    it('is bound to the provisioning operation, like a status read', () => {
        expect(verifyLease(mint(leaseClaims({ provisioningOperationId: 'op-other' }))))
            .toEqual({ ok: false, reason: 'wrong-operation' });
    });

    it('may raise the epoch, because it is the path that fences', () => {
        // The same rule the run-scoped lease has: only a renewal may carry a
        // higher epoch, and only because it performs the fence first.
        expect(verifyLease(mint(leaseClaims({ epoch: 9 })), { currentEpoch: 3 }).ok).toBe(true);
        expect(verifyLease(mint(leaseClaims({ epoch: 2 })), { currentEpoch: 3 }))
            .toEqual({ ok: false, reason: 'stale-epoch' });
    });

    it('is not accepted where a status read was asked for', () => {
        expect(verifyLease(mint(leaseClaims()), { op: 'status' }))
            .toEqual({ ok: false, reason: 'wrong-op' });
    });

    it('leaves the run-scoped lease wire exactly as it was', () => {
        const result = verify(mint(claims({
            op: 'lease', epoch: 4, renewalSeq: 2, leaseMs: 60_000, absoluteExpiry: NOW + 3_600_000,
        } as never)), { op: 'lease', currentEpoch: 3 });
        expect(result.ok).toBe(true);
        if (!result.ok || result.claims.op === 'status' || result.claims.op === 'credential'
            || result.claims.op === 'ai-auth'
            || result.claims.op === 'runtime-lease' || result.claims.op === 'checkpoint') return;
        expect(result.claims.runId).toBe('run-1');
        expect(result.claims.attemptId).toBe('attempt-1');
    });
});

/*
 * The checkpoint token's second digest.
 *
 * `ManagedCheckpointTokenClaims` requires a `paramsDigest` of its own, beside
 * the `payloadDigest` every token carries — and nothing compared it. A field
 * that is required and never checked is decoration: it looks like a binding in
 * the type and in the review, and an issuer that filled it with anything at all
 * would be accepted. Either it means the same thing as `payloadDigest`, and it
 * must equal it, or it means something else and nobody says what.
 */
describe('the checkpoint token binds one digest, not two', () => {
    const PARAMS = { areas: [{ area: 'project', put: 'https://storage.test/o/ckpt-7/project' }] };
    const digest = canonicalManagedPayloadDigest(PARAMS);

    const checkpointClaims = (overrides: Record<string, unknown> = {}) => ({
        v: 1,
        kid: 'test-kid',
        aud: 'runtime-1',
        op: 'checkpoint',
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        provisioningOperationId: 'op-1',
        checkpointId: 'ckpt-7',
        requestKey: 'req-ckpt-1',
        epoch: 3,
        payloadDigest: digest,
        paramsDigest: digest,
        iat: NOW,
        exp: NOW + 60_000,
        ...overrides,
    });

    const verifyCheckpoint = (body: Record<string, unknown>) => verifyManagedDispatchToken({
        token: mint(body),
        verifier,
        runtimeId: 'runtime-1',
        workspaceId: 'ws-1',
        op: 'checkpoint',
        paramsDigest: digest,
        currentEpoch: 3,
        provisioningOperationId: 'op-1',
        now: NOW + 1_000,
    });

    it('accepts one whose two digests agree', () => {
        expect(verifyCheckpoint(checkpointClaims()).ok).toBe(true);
    });

    it('refuses one minted for another provisioning operation of the same runtime', () => {
        /*
         * `PROVISIONING_SCOPED_OPS` carries `checkpoint`, and the parse side
         * requires the id — but the verify side only compared it for `status`,
         * `runtime-lease` and `credential`. So a validly signed checkpoint token
         * from a **different** provisioning operation of the same runtime,
         * workspace, project and epoch was accepted, and it names upload
         * destinations: whoever holds one can have this runtime seal its volume
         * into a namespace the current operation never authorised.
         *
         * The id is the only thing that ties a provisioning-scoped grant to the
         * life this runtime is currently living; the epoch cannot, because the
         * two operations can share one.
         */
        expect(verifyCheckpoint(checkpointClaims({ provisioningOperationId: 'op-someone-else' })))
            .toEqual({ ok: false, reason: 'wrong-operation' });
    });

    it('refuses one when the runtime knows of no provisioning operation at all', () => {
        // Fail closed: nothing to compare against is not a reason to accept.
        expect(verifyManagedDispatchToken({
            token: mint(checkpointClaims()),
            verifier,
            runtimeId: 'runtime-1',
            workspaceId: 'ws-1',
            op: 'checkpoint',
            paramsDigest: digest,
            currentEpoch: 3,
            provisioningOperationId: undefined,
            now: NOW + 1_000,
        })).toEqual({ ok: false, reason: 'wrong-operation' });
    });

    it('refuses one whose two digests disagree', () => {
        /*
         * The destinations are in the parameters. A token carrying a second,
         * unchecked digest of *something else* is a token whose binding cannot
         * be read from the token.
         *
         * `malformed` rather than `payload-mismatch`, and the difference is
         * real: `payload-mismatch` says "signed for other parameters than the
         * ones handed to me", which is a comparison with the request. This one
         * disagrees with **itself**, before any request is considered — so it
         * is a shape that may not be read at all.
         */
        expect(verifyCheckpoint(checkpointClaims({
            paramsDigest: canonicalManagedPayloadDigest({ areas: [] }),
        }))).toEqual({ ok: false, reason: 'malformed' });
    });
});

describe('which fault wins when a token has several', () => {
    /*
     * Every case in this file gives a token one fault. That left the order the
     * guards run in unpinned: an extraction could reorder them and the suite
     * would stay green, and the answer a caller acts on would change.
     *
     * The digest is broken **externally** - the claims stay valid and signed,
     * and the caller passes a `paramsDigest` for other params. That is the real
     * shape of the fault: a token signed for one document arriving with
     * another, not a token someone edited.
     */
    const OTHER_DIGEST = canonicalManagedPayloadDigest({ different: true });

    it('shouldSayStaleEpochRatherThanPayloadMismatch', () => {
        // The pair the first C1 draft would have inverted.
        expect(verify(mint(claims({ epoch: 2 })), { currentEpoch: 5, paramsDigest: OTHER_DIGEST }))
            .toEqual({ ok: false, reason: 'stale-epoch' });
    });

    it('shouldSayEpochMismatchRatherThanPayloadMismatchForWork', () => {
        expect(verify(mint(claims({ epoch: 7 })), { currentEpoch: 3, paramsDigest: OTHER_DIGEST }))
            .toEqual({ ok: false, reason: 'epoch-mismatch' });
    });

    /**
     * A checkpoint token carries `checkpointId` and its own `paramsDigest`,
     * which must equal `payloadDigest` - and it carries neither `runId` nor
     * `attemptId`. Building it from the work-token fixture gives `malformed`,
     * which is the baseline telling me the fixture is wrong rather than the
     * function; this is the real shape.
     */
    const checkpointToken = (over: Record<string, unknown> = {}) => {
        const signedDigest = canonicalManagedPayloadDigest({ a: 1, b: 2 });
        return mint({
            v: 1, kid: 'test-kid', aud: 'runtime-1', op: 'checkpoint',
            workspaceId: 'ws-1', projectId: 'proj-1', provisioningOperationId: 'op-1',
            checkpointId: 'ckpt-7', requestKey: 'req-ckpt-1', epoch: 3,
            payloadDigest: signedDigest, paramsDigest: signedDigest,
            iat: NOW, exp: NOW + 60_000, ...over,
        });
    };

    it('shouldSayEpochMismatchRatherThanPayloadMismatchForCheckpoint', () => {
        expect(verify(checkpointToken({ epoch: 7 }), {
            op: 'checkpoint', currentEpoch: 3, provisioningOperationId: 'op-1',
            paramsDigest: OTHER_DIGEST,
        })).toEqual({ ok: false, reason: 'epoch-mismatch' });
    });

    it('shouldSayWrongOperationBeforeEitherEpochOrPayload', () => {
        expect(verify(checkpointToken({ epoch: 2, provisioningOperationId: 'op-other' }), {
            op: 'checkpoint', currentEpoch: 5, provisioningOperationId: 'op-1',
            paramsDigest: OTHER_DIGEST,
        })).toEqual({ ok: false, reason: 'wrong-operation' });
    });

    it('shouldSayExpiredBeforeEveryLaterGuard', () => {
        expect(verify(mint(claims({ epoch: 2, exp: NOW - 1 })), {
            currentEpoch: 5, paramsDigest: OTHER_DIGEST,
        })).toEqual({ ok: false, reason: 'expired' });
    });

    it('shouldSayWrongAudienceBeforeEpochOrPayload', () => {
        expect(verify(mint(claims({ aud: 'runtime-2', epoch: 2 })), {
            currentEpoch: 5, paramsDigest: OTHER_DIGEST,
        })).toEqual({ ok: false, reason: 'wrong-audience' });
    });

    it('shouldStillSayPayloadMismatchWhenThatIsTheOnlyFault', () => {
        // The control: without it the table above could be satisfied by a
        // function that never reaches the payload check at all.
        expect(verify(mint(claims()), { paramsDigest: OTHER_DIGEST }))
            .toEqual({ ok: false, reason: 'payload-mismatch' });
    });
});

describe('the epoch rules, per operation', () => {
    /*
     * Pinned as a matrix rather than as scattered cases, because the extraction
     * must keep the gate exactly where it is and these are the rules it holds:
     * work is exact, both lease shapes may rise but never fall, and `status`
     * and `credential` are outside the gate entirely.
     */
    const workOp = (epoch: number, currentEpoch: number) =>
        verify(mint(claims({ epoch })), { currentEpoch });

    it.each([
        ['equal', 3, 3, null],
        ['below', 2, 3, 'stale-epoch'],
        ['above', 4, 3, 'epoch-mismatch'],
    ])('shouldJudgeWorkExactly(%s)', (_name, epoch, currentEpoch, reason) => {
        const result = workOp(epoch as number, currentEpoch as number);
        if (reason === null) expect(result.ok).toBe(true);
        else expect(result).toEqual({ ok: false, reason });
    });

    it.each([
        ['lease', 'lease' as const],
        ['runtime-lease', 'runtime-lease' as const],
    ])('shouldLetALeaseRiseButNotFall(%s)', (_name, op) => {
        const lease = (epoch: number, currentEpoch: number) => {
            const body: Record<string, unknown> = {
                ...claims(), op, epoch,
                renewalSeq: 1, leaseMs: 60_000, absoluteExpiry: NOW + 600_000,
            };
            if (op === 'runtime-lease') {
                body.provisioningOperationId = 'op-1';
                delete body.runId;
                delete body.attemptId;
            }
            return verify(mint(body), {
                op, currentEpoch,
                ...(op === 'runtime-lease' ? { provisioningOperationId: 'op-1' } : {}),
            });
        };
        expect(lease(3, 3).ok).toBe(true);
        expect(lease(9, 3).ok).toBe(true);
        expect(lease(2, 3)).toEqual({ ok: false, reason: 'stale-epoch' });
    });

    it.each([
        ['status', 'status' as const],
        ['credential', 'credential' as const],
        // A personal login is started from a project screen, where there may
        // be no run and no lease at all.
        ['ai-auth', 'ai-auth' as const],
    ])('shouldNotGateOnEpochAtAllFor(%s)', (_name, op) => {
        const body: Record<string, unknown> = {
            ...claims(), op, epoch: 0, provisioningOperationId: 'op-1',
        };
        delete body.runId;
        delete body.attemptId;
        // Far below the current epoch, and still accepted: a booted runtime
        // holds epoch 0 and the parent asks precisely to find that out.
        expect(verify(mint(body), {
            op, currentEpoch: 9, provisioningOperationId: 'op-1',
        }).ok).toBe(true);
    });
});

describe('verifyManagedDispatchMaterial', () => {
    /*
     * The epoch-free entry point, called directly. freeze85 shipped it with no
     * test touching it at all, which is how the defect below survived review of
     * a green suite: the extraction looked right and nothing exercised the new
     * path.
     *
     * What it returns is authenticated **material**, not authorisation. Every
     * guard the full verifier applies before its epoch gate must still apply
     * here - a holder with no epoch has *fewer* reasons to trust a token, not
     * more.
     */
    const DIGEST = canonicalManagedPayloadDigest({ a: 1, b: 2 });
    const OTHER_DIGEST = canonicalManagedPayloadDigest({ different: true });

    const provisioningToken = (op: string, over: Record<string, unknown> = {}) => {
        const body: Record<string, unknown> = {
            v: 1, kid: 'test-kid', aud: 'runtime-1', op,
            workspaceId: 'ws-1', projectId: 'proj-1', provisioningOperationId: 'op-1',
            requestKey: 'req-1', epoch: 3,
            payloadDigest: DIGEST, iat: NOW, exp: NOW + 60_000,
        };
        if (op === 'checkpoint') {
            body.checkpointId = 'ckpt-7';
            body.paramsDigest = DIGEST;
        }
        if (op === 'runtime-lease') {
            body.renewalSeq = 1;
            body.leaseMs = 60_000;
            body.absoluteExpiry = NOW + 600_000;
        }
        return mint({ ...body, ...over });
    };

    const material = (token: string, over: Partial<Parameters<typeof verifyManagedDispatchMaterial>[0]> = {}) =>
        verifyManagedDispatchMaterial({
            token,
            verifier,
            runtimeId: 'runtime-1',
            workspaceId: 'ws-1',
            op: 'checkpoint',
            paramsDigest: DIGEST,
            provisioningOperationId: 'op-1',
            now: NOW + 1_000,
            ...over,
        });

    it('shouldAcceptWhateverEpochTheParentSignedFor', () => {
        /*
         * The point of the entry point: a holder with no current epoch can
         * still establish who signed this and for what. The epoch is recorded
         * as a fact, not judged.
         */
        for (const epoch of [0, 3, 99]) {
            const result = material(provisioningToken('checkpoint', { epoch }));
            expect(result.ok).toBe(true);
            if (result.ok) expect(result.claims.epoch).toBe(epoch);
        }
    });

    it('shouldNotBeAuthorisationTheFullVerifierWouldRefuse', () => {
        // The same token, same instant: material accepts, the full verifier
        // refuses because that epoch is not the current one. If these ever
        // agreed, the epoch gate would have been bypassed rather than skipped.
        const token = provisioningToken('checkpoint', { epoch: 99 });
        expect(material(token).ok).toBe(true);
        expect(verifyManagedDispatchToken({
            token, verifier, runtimeId: 'runtime-1', workspaceId: 'ws-1', op: 'checkpoint',
            paramsDigest: DIGEST, currentEpoch: 3, provisioningOperationId: 'op-1', now: NOW + 1_000,
        })).toEqual({ ok: false, reason: 'epoch-mismatch' });
    });

    it.each([
        ['checkpoint', 'checkpoint'],
        ['status', 'status'],
        ['credential', 'credential'],
        ['ai-auth', 'ai-auth'],
        ['runtime-lease', 'runtime-lease'],
    ])('shouldRefuseATokenMintedForAnotherProvisioningOperation(%s)', (_name, op) => {
        /*
         * Astra's blocker. Every one of these ops is provisioning-scoped, and
         * the binding is what stops a token signed for a *different* operation
         * on the same runtime, workspace, project and epoch from being acted
         * on - the params of a checkpoint carry upload destinations, so holding
         * such a token means choosing where this runtime seals its volume.
         *
         * The epoch cannot substitute: two operations can share one.
         */
        expect(material(provisioningToken(op, { provisioningOperationId: 'op-other' }), { op: op as never }))
            .toEqual({ ok: false, reason: 'wrong-operation' });
    });

    it.each([
        ['checkpoint', 'checkpoint'],
        ['status', 'status'],
        ['credential', 'credential'],
        ['ai-auth', 'ai-auth'],
        ['runtime-lease', 'runtime-lease'],
    ])('shouldRefuseWhenTheCallerNamesNoOperationAtAll(%s)', (_name, op) => {
        // Fail closed: a holder that cannot say which life it is living cannot
        // confirm the token belongs to it.
        expect(material(provisioningToken(op), { op: op as never, provisioningOperationId: undefined }))
            .toEqual({ ok: false, reason: 'wrong-operation' });
    });

    it.each([
        ['a forged signature', () => material(provisioningToken('checkpoint').slice(0, -8) + 'AAAAAAAA'), 'bad-signature'],
        ['another runtime', () => material(provisioningToken('checkpoint'), { runtimeId: 'runtime-2' }), 'wrong-audience'],
        ['another workspace', () => material(provisioningToken('checkpoint'), { workspaceId: 'ws-2' }), 'wrong-workspace'],
        ['another op', () => material(provisioningToken('checkpoint'), { op: 'spawn' }), 'wrong-op'],
        ['a token past its life', () => material(provisioningToken('checkpoint', { exp: NOW - 1 })), 'expired'],
        ['params it was not signed for', () => material(provisioningToken('checkpoint'), { paramsDigest: OTHER_DIGEST }), 'payload-mismatch'],
    ])('shouldStillRefuse(%s)', (_name, run, reason) => {
        expect(run()).toEqual({ ok: false, reason });
    });
});

/**
 * The login operation's own claim shape (R23).
 *
 * It is provisioning-scoped like `credential`, and the refusals are what keep
 * it that way: a token that could name a run could be replayed as one, and a
 * token carrying lease fields would be a login holding a write deadline open.
 */
describe('the ai-auth token', () => {
    const aiAuth = (over: Record<string, unknown> = {}) => {
        const body: Record<string, unknown> = {
            ...claims(), op: 'ai-auth', provisioningOperationId: 'op-1',
        };
        delete body.runId;
        delete body.attemptId;
        return mint({ ...body, ...over });
    };

    const check = (token: string, over: Partial<Parameters<typeof verifyManagedDispatchToken>[0]> = {}) =>
        verify(token, { op: 'ai-auth', provisioningOperationId: 'op-1', ...over });

    it('shouldAcceptOneBoundToThisProvisioningOperation', () => {
        const result = check(aiAuth());
        expect(result.ok).toBe(true);
        if (result.ok && result.claims.op === 'ai-auth') {
            expect(result.claims.provisioningOperationId).toBe('op-1');
        }
    });

    it.each([
        ['runId', { runId: 'run-1' }],
        ['attemptId', { attemptId: 'attempt-1' }],
        ['renewalSeq', { renewalSeq: 1 }],
        ['leaseMs', { leaseMs: 60_000 }],
        ['absoluteExpiry', { absoluteExpiry: NOW + 600_000 }],
    ])('shouldRefuseOneCarrying(%s)', (_name, over) => {
        expect(check(aiAuth(over))).toEqual({ ok: false, reason: 'malformed' });
    });

    it('shouldRefuseOneWithNoProvisioningOperation', () => {
        const body: Record<string, unknown> = { ...claims(), op: 'ai-auth' };
        delete body.runId;
        delete body.attemptId;
        delete body.provisioningOperationId;
        expect(check(mint(body))).toEqual({ ok: false, reason: 'malformed' });
    });

    it('shouldRefuseOneMintedForAnotherOperation', () => {
        expect(check(aiAuth({ provisioningOperationId: 'op-other' })))
            .toEqual({ ok: false, reason: 'wrong-operation' });
    });

    it('shouldRefuseASpawnTokenPresentedAsALogin', () => {
        // The whole reason it is its own op: a signature authorising work on a
        // run must not also be able to delete somebody's credential.
        expect(check(mint(claims()))).toEqual({ ok: false, reason: 'wrong-op' });
    });

    it('shouldRefuseALoginTokenPresentedAsWork', () => {
        expect(verify(aiAuth(), { op: 'spawn' })).toEqual({ ok: false, reason: 'wrong-op' });
    });

    it('shouldStillBindTheParameters', () => {
        // The action and the connection travel in the params; without this the
        // same signature would drive a logout as easily as a status read.
        expect(check(aiAuth(), { paramsDigest: canonicalManagedPayloadDigest({ other: true }) }))
            .toEqual({ ok: false, reason: 'payload-mismatch' });
    });
});
