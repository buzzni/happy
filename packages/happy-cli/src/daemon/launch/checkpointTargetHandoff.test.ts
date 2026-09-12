/**
 * The checkpoint target crossing the daemon → supervisor boundary, with the
 * real client on one end and the real IPC server on the other.
 *
 * Each half already has its own tests, and each half's tests use a fake for the
 * other one: the client speaks to a stub transport, the server is called with a
 * hand-written request. Two fakes can agree with their own side and disagree
 * with each other — a renamed field or a changed op name passes both suites and
 * fails only in a running runtime, where the symptom is a credential that
 * expires with nobody looking at it.
 *
 * What is deliberately *not* covered here is the two composition roots: the
 * daemon's `run.ts` hands `ManagedRuntime.acceptCheckpointTarget` to
 * `pushCheckpointTarget`, and the supervisor's `main.ts` hands the parsed
 * delivery to the inbox. Both are one line in a process-wide bootstrap. This
 * test covers the contract those two lines join.
 */
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createLauncherClient } from './launcherClient';
import { handleIpcRequest, type IpcHandlers } from '@/launcher/ipcServer';
import {
    canonicalManagedPayloadDigest,
    parseManagedVerifierKey,
} from '@/daemon/managedDispatchToken';
import { composeCheckpointTargetHandler } from '@/launcher/main';
import {
    authenticateManagedCheckpointTarget,
    createManagedCheckpointTargetInbox,
} from '@/managed/checkpoint/managedCheckpointTargetInbox';

const TOKEN = 'b'.repeat(43);
const CHECKPOINT_ID = 'a'.repeat(64);
const KEY = randomBytes(32);
const PUT = 'https://store.invalid/one?X-Amz-Signature=deadbeef';

/** A target shaped as the parent issues it, over the wire. */
function issued(over: Record<string, unknown> = {}) {
    return {
        checkpointId: CHECKPOINT_ID,
        keyBase64: KEY.toString('base64'),
        expiresAt: 2_000,
        targets: {
            areas: [{ area: 'project', putUrl: PUT, headUrl: `${PUT}&h=1` }],
            manifest: { putUrl: `${PUT}&m=1`, headUrl: `${PUT}&m=2` },
            pointer: { putUrl: `${PUT}&p=1`, getUrl: `${PUT}&p=2` },
        },
        ...over,
    };
}

/**
 * The daemon's client wired to the supervisor's server through nothing but the
 * request line. `handlers` is what the supervisor's composition root builds.
 */
function pair(handlers: Partial<IpcHandlers>) {
    const seen: string[] = [];
    const client = createLauncherClient({
        token: TOKEN,
        deps: {
            request: async (payload) => {
                seen.push(payload);
                const response = await handleIpcRequest({
                    raw: payload,
                    token: TOKEN,
                    handlers: handlers as IpcHandlers,
                });
                return JSON.stringify(response);
            },
        },
    });
    return { client, seen };
}

const KEYS = generateKeyPairSync('ed25519');
const VERIFIER = parseManagedVerifierKey(
    KEYS.publicKey.export({ format: 'der', type: 'spki' }) as Buffer,
);
const AUTHORITY = {
    verifier: VERIFIER,
    runtimeId: 'runtime-1',
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    keyId: 'kid-1',
    provisioningOperationId: 'op-1',
};

/**
 * The parent's own request-key shape, from
 * `packages/web-ui/server/cloudCheckpointTargetIssuer.ts:546`.
 */
const REQUEST_KEY = `op-1:4:checkpoint:${CHECKPOINT_ID}`;

/** The parent signing a target, over the params **as it sends them**. */
function signFor(params: unknown, over: Record<string, unknown> = {}) {
    const digest = canonicalManagedPayloadDigest(params);
    const body = Buffer.from(JSON.stringify({
        v: 1, kid: 'kid-1', aud: 'runtime-1', op: 'checkpoint', workspaceId: 'ws-1',
        projectId: 'proj-1', provisioningOperationId: 'op-1', checkpointId: CHECKPOINT_ID,
        requestKey: REQUEST_KEY, epoch: 4, payloadDigest: digest, paramsDigest: digest,
        iat: 900, exp: 60_900, ...over,
    }), 'utf8').toString('base64url');
    return `${body}.${sign(null, Buffer.from(body, 'utf8'), KEYS.privateKey).toString('base64url')}`;
}

/**
 * The supervisor side as `main.ts` really composes it - the product function,
 * not a copy of its shape.
 */
function inboxHandler(now: () => number) {
    const inbox = createManagedCheckpointTargetInbox({ now });
    const acceptCheckpointTarget = composeCheckpointTargetHandler({
        authenticate: (input) => authenticateManagedCheckpointTarget({
            ...input, authority: AUTHORITY, now: now(),
        }),
        accept: (delivery, receipt) => inbox.accept(delivery, receipt),
    });
    return { inbox, acceptCheckpointTarget };
}

describe('checkpoint target hand-off across the daemon/supervisor boundary', () => {
    it('shouldDeliverAnIssuedTargetToTheInboxTheCheckpointSessionReads', async () => {
        const { inbox, acceptCheckpointTarget } = inboxHandler(() => 1_000);
        const { client } = pair({ acceptCheckpointTarget });

        expect(await client.pushCheckpointTarget(issued(), signFor(issued())))
            .toEqual({ accepted: true, state: 'queued', detail: 'queued' });

        // The coordinator's own view: it holds the source, and takes the
        // request out of it.
        expect(inbox.pending()).toBe(true);
        const request = await inbox.next();
        expect(request?.checkpointId).toBe(CHECKPOINT_ID);
        // The key survives the base64 hop as the same 32 bytes; a target whose
        // key arrived altered would fail at the seal, far from here.
        expect(request?.key).toEqual(KEY);
        expect(request?.targets.objects.get('project')?.putUrl).toBe(PUT);
        expect(request?.targets.pointer.getUrl).toBe(`${PUT}&p=2`);
        // One-shot: the second read has nothing.
        expect(await inbox.next()).toBeNull();
    });

    it('shouldReportARuntimeWithNoCheckpointInboxAsNotAccepted', async () => {
        // No `acceptCheckpointTarget` handler — this runtime does not
        // checkpoint. Folding that into an acceptance tells the parent its
        // credential is in place while nothing will ever use it.
        const { client } = pair({});
        expect(await client.pushCheckpointTarget(issued(), signFor(issued())))
            .toEqual({ accepted: false, detail: 'checkpoint-unconfigured' });
    });

    it('shouldRefuseAMalformedTargetWithoutPuttingAnythingInTheInbox', async () => {
        const { inbox, acceptCheckpointTarget } = inboxHandler(() => 1_000);
        const { client } = pair({ acceptCheckpointTarget });

        const broken = issued({ keyBase64: randomBytes(16).toString('base64') });
        const answer = await client.pushCheckpointTarget(broken, signFor(broken));
        expect(answer.accepted).toBe(false);
        expect(inbox.pending()).toBe(false);
    });

    it('shouldNeverCarryTheKeyOrASignedUrlBackToTheParent', async () => {
        const { acceptCheckpointTarget } = inboxHandler(() => 1_000);
        const { client } = pair({ acceptCheckpointTarget });

        for (const target of [issued({ checkpointId: 'not-a-digest' }), issued({ targets: {} })]) {
            const answer = await client.pushCheckpointTarget(target, signFor(target));
            expect(answer.accepted).toBe(false);
            // The refusal names a field, never what it held.
            expect(answer.detail).not.toContain('X-Amz-Signature');
            expect(answer.detail).not.toContain(KEY.toString('base64'));
        }
    });

    it('shouldNotHandAnExpiredTargetToTheCheckpointSession', async () => {
        // Accepted while live, read after `expiresAt`: a stale target used
        // anyway fails at the upload, and the URLs are signed for a window the
        // parent clamped to the write lease.
        let clock = 1_000;
        const { inbox, acceptCheckpointTarget } = inboxHandler(() => clock);
        const { client } = pair({ acceptCheckpointTarget });

        expect((await client.pushCheckpointTarget(issued(), signFor(issued()))).accepted).toBe(true);
        clock = 2_000;
        expect(await inbox.next()).toBeNull();
    });
});

describe('the wire vocabulary is the contract, not the inbox internals', () => {
    it('shouldReportAReissuedUnconsumedTargetAsQueuedAcrossTheRealIpcPath', async () => {
        /*
         * The parent reissues before anything took the first target. The inbox
         * calls that `replaced-unconsumed`; the wire must say `queued`, because
         * the parent's next action is identical — an archive follows — and a
         * state outside the agreed six is classified by the parent's dispatcher
         * as a non-retryable failure. That would turn a perfectly ordinary
         * reissue into a checkpoint that never happens.
         *
         * Driven through the real client and the real IPC server, because this
         * is exactly the kind of mismatch each side's own fake would hide.
         */
        const { inbox, acceptCheckpointTarget } = inboxHandler(() => 1_000);
        const { client } = pair({ acceptCheckpointTarget });

        expect(await client.pushCheckpointTarget(issued(), signFor(issued())))
            .toEqual({ accepted: true, state: 'queued', detail: 'queued' });

        const second = await client.pushCheckpointTarget(issued(), signFor(issued()));
        expect(second.accepted).toBe(true);
        expect(second.state).toBe('queued');
        /*
         * The supervisor still sends `detail: 'replaced-unconsumed'`, but the
         * daemon's client currently overwrites `detail` with `state`, so the
         * diagnosis does not survive this hop. That is the client's own
         * behaviour and not something this boundary should work around — the
         * contract asserted here is the state, which is what the parent acts
         * on.
         */
        expect(inbox.pending()).toBe(true);

        // And the reissue did not add a second consumable target: the id comes
        // out once, and the inbox is then empty.
        expect((await inbox.next())?.checkpointId).toBe(CHECKPOINT_ID);
        expect(await inbox.next()).toBeNull();
    });
});

describe('a relayed target is authenticated before it is queued', () => {
    it('shouldQueueATargetTheParentActuallySignedOverTheseParams', async () => {
        /*
         * The whole relay, end to end: the parent signs the params it sends,
         * the daemon forwards the signature unaltered, the IPC boundary carries
         * it in its own field, and the supervisor checks it against its marker
         * before anything is queued.
         */
        const { inbox, acceptCheckpointTarget } = inboxHandler(() => 1_000);
        const { client } = pair({ acceptCheckpointTarget });
        const target = issued();

        expect(await client.pushCheckpointTarget(target, signFor(target)))
            .toEqual({ accepted: true, state: 'queued', detail: 'queued' });
        expect(inbox.pending()).toBe(true);
        /*
         * The receipt reaches the consumer **on the request**: `epoch` is the
         * epoch the parent signed for, carried as a fact. Current authority is
         * a separate question and nothing here answers it.
         */
        expect((await inbox.next())?.receipt).toEqual({
            epoch: 4, requestKey: REQUEST_KEY, issuedAtMs: 900, expiresAtMs: 60_900,
        });
    });

    it('shouldNotQueueATargetWhoseSignatureWasLostOnTheWay', async () => {
        // A daemon that verified and dropped the token leaves the supervisor
        // with a document it cannot check. Nothing is queued from it.
        const { inbox, acceptCheckpointTarget } = inboxHandler(() => 1_000);
        const { client } = pair({ acceptCheckpointTarget });

        expect(await client.pushCheckpointTarget(issued(), ''))
            .toEqual({ accepted: false, detail: 'malformed' });
        expect(inbox.pending()).toBe(false);
        expect(await inbox.next()).toBeNull();
    });

    it('shouldNotQueueATargetMutatedAfterItWasSigned', async () => {
        /*
         * The signature travels with the document, so the hop that carries it
         * cannot edit it. Here the destination is moved after signing - the
         * failure mode the relay exists to prevent, because what follows a
         * queued target is a sealed archive uploaded to whatever it names.
         */
        const { inbox, acceptCheckpointTarget } = inboxHandler(() => 1_000);
        const { client } = pair({ acceptCheckpointTarget });
        const original = issued();
        const moved = issued({
            targets: { ...original.targets, pointer: { putUrl: 'https://evil/p', getUrl: 'https://evil/g' } },
        });

        const answer = await client.pushCheckpointTarget(moved, signFor(original));
        expect(answer.accepted).toBe(false);
        expect(inbox.pending()).toBe(false);
    });

    it('shouldNotQueueATargetSignedForAnotherRuntimeOrOperation', async () => {
        for (const over of [{ aud: 'runtime-2' }, { workspaceId: 'ws-2' },
            { provisioningOperationId: 'op-2' }, { projectId: 'proj-2' }, { kid: 'kid-2' }]) {
            const { inbox, acceptCheckpointTarget } = inboxHandler(() => 1_000);
            const { client } = pair({ acceptCheckpointTarget });
            const target = issued();
            const answer = await client.pushCheckpointTarget(target, signFor(target, over));
            expect(answer.accepted).toBe(false);
            expect(inbox.pending()).toBe(false);
        }
    });

    it('shouldNotQueueATargetWhoseTokenHasAlreadyExpiredHere', async () => {
        // The supervisor's own clock, not the daemon's word for it.
        const { inbox, acceptCheckpointTarget } = inboxHandler(() => 61_000);
        const { client } = pair({ acceptCheckpointTarget });
        const target = issued({ expiresAt: 200_000 });

        const answer = await client.pushCheckpointTarget(target, signFor(target));
        expect(answer.accepted).toBe(false);
        expect(inbox.pending()).toBe(false);
    });

    it('shouldRefuseEveryTargetWhenNoAuthenticationIsWired', async () => {
        /*
         * Absence refuses. A supervisor composed without the boot-auth hook has
         * no way to establish who issued a target, and accepting one anyway
         * would queue an unauthenticated document while everything looked
         * wired.
         */
        const inbox = createManagedCheckpointTargetInbox({ now: () => 1_000 });
        const acceptCheckpointTarget = composeCheckpointTargetHandler({
            accept: (delivery, receipt) => inbox.accept(delivery, receipt),
        });
        const { client } = pair({ acceptCheckpointTarget });
        const target = issued();

        /*
         * The refusal is asserted by its classifier, not merely by `accepted`
         * being false: an acceptance that simply came back malformed would
         * satisfy the weaker assertion while the target had already been
         * queued, and that is the defect this test exists for.
         */
        expect(await client.pushCheckpointTarget(target, signFor(target)))
            .toEqual({ accepted: false, detail: 'target-unauthenticated' });
        expect(inbox.pending()).toBe(false);
        expect(await inbox.next()).toBeNull();
    });

    it('shouldNeverCarryTheTokenOrTheKeyBackToTheParent', async () => {
        const { acceptCheckpointTarget } = inboxHandler(() => 1_000);
        const { client } = pair({ acceptCheckpointTarget });
        const target = issued();
        const token = signFor(target, { aud: 'runtime-2' });

        const answer = await client.pushCheckpointTarget(target, token);
        expect(answer.accepted).toBe(false);
        // A closed classifier, never the material that failed.
        expect(answer.detail).not.toContain(token);
        expect(answer.detail).not.toContain(KEY.toString('base64'));
        expect(answer.detail).not.toContain('X-Amz-Signature');
    });
});
