import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as signEd25519 } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalLessonDigest, createLessonGrantVerifier, lessonGrantAudience } from './lessonGrantVerifier';

const LESSON_GRANT_AUDIENCE = lessonGrantAudience('https://studio.example');
import { createLessonHostRpc } from './lessonHostRpc';
import { createLessonSettingsStore, LESSON_SETTINGS_DEFAULT } from './lessonSettingsStore';
import type { LessonHostHandle } from './cmlLessonHost';
import { createLessonBindingIssuer } from './lessonBindingIssuer';

const pair = generateKeyPairSync('ed25519');
const publicKeyBase64 = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

function grantFor(request: Record<string, unknown>, capabilities: string[], iat = 1_000) {
    const claims = {
        v: 1, aud: LESSON_GRANT_AUDIENCE, op: request.operation,
        digest: canonicalLessonDigest(request), userId: 'u1', projectId: 'p1', machineId: 'm1',
        workspaceDir: '/ws/p1', capabilities, iat, expiresAt: iat + 60_000,
    };
    const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    return `${payload}.${signEd25519(null, Buffer.from(payload, 'utf8'), pair.privateKey).toString('base64url')}`;
}

const snapshotRequest = { version: 1, projectId: 'p1', requestId: 'r1', operation: 'snapshot' };

/**
 * Resolves the binding *during* the call, the way CML does.
 *
 * A handle is released in the RPC's `finally`, so inspecting one afterwards
 * legitimately refuses — the assertion has to happen while the request is
 * still in flight, which is also the only moment CML itself would resolve it.
 */
function fakeHost(
    overrides: Partial<LessonHostHandle['service']> = {},
    resolveBinding?: (binding: unknown) => Promise<unknown>,
) {
    const calls: Array<{ name: string; input: any; identity?: unknown }> = [];
    const push = async (name: string, input: any) => {
        const identity = resolveBinding ? await resolveBinding(input.binding).catch((error) => error) : undefined;
        calls.push({ name, input, identity });
    };
    const record = (name: string) => async (input: any) => { await push(name, input); return undefined; };
    const service = {
        recall: async (input: any) => {
            await push('recall', input);
            return { outcome: 'selected', traceId: 't', lessonIds: ['l1'], lessons: [
                { lessonId: 'l1', revision: 2, name: 'n', trigger: 'tr', steps: ['s'], recallEnabled: true },
            ] };
        },
        listLessons: async (input: any) => {
            await push('listLessons', input);
            return { outcome: 'ok', nextOffset: 100, lessons: [{ lessonId: 'l1', revision: 2, name: 'n',
                trigger: 'tr', steps: ['s'], recallEnabled: true, sourceEventIds: ['e1'], sourceSessionIds: ['s1'],
                scope: 'this repo', validation: ['npm test'], failureModes: ['stale out/'] }] };
        },
        reviewStatus: record('reviewStatus'),
        listCandidates: async (input: any) => {
            await push('listCandidates', input);
            return { outcome: 'ok', nextOffset: null, candidates: [{
                candidateId: 'c1', revision: 3, payloadHash: 'h', status: 'reviewed', evidenceKey: 'e',
                duplicateLessonIds: ['l1'],
                candidate: {
                    name: 'n', trigger: 'tr', steps: ['s1'], sourceEventIds: ['e1'], sourceSessionIds: ['s'],
                    scope: 'this repo only', validation: ['npm test'], reconsiderWhen: 'CLI v3',
                    validVersions: ['2.4.0'], failureModes: ['ran before the build'],
                },
            }] };
        },
        get: record('get'), recordRead: record('recordRead'), ackDelivery: record('ackDelivery'),
        enqueueCandidate: record('enqueueCandidate'), markReviewed: record('markReviewed'),
        approveCandidate: record('approveCandidate'), rejectCandidate: record('rejectCandidate'),
        setRecallEnabled: record('setRecallEnabled'),
        ...overrides,
    };
    const handle: LessonHostHandle = {
        service: service as LessonHostHandle['service'],
        projectHash: 'hash-p1',
        hashCandidatePayload: () => 'h',
        close: async () => {},
    };
    return { handle, calls };
}

async function harness(overrides: Record<string, unknown> = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'lesson-rpc-'));
    const settings = createLessonSettingsStore(join(dir, 'settings.json'));
    // The fence is the durable settings revision, exactly as in production.
    const generation = async () => (await settings.read()).revision;
    let closed = false;
    let issuerRef: ReturnType<typeof createLessonBindingIssuer> | undefined;
    const host = fakeHost({}, (binding) => issuerRef!.verifier()(binding));
    const issuer = createLessonBindingIssuer({
        projectHash: () => host.handle.projectHash,
        projectId: 'p1',
        generation,
        closed: () => closed,
    });
    issuerRef = issuer;
    const deps = {
        verifier: createLessonGrantVerifier({ publicKeyBase64, machineId: 'm1', audience: LESSON_GRANT_AUDIENCE, now: () => 1_500 }),
        issuer,
        host: host.handle,
        settings,
        generation,
        reviewOutcome: () => 'disabled',
        now: () => 1_500,
        ...overrides,
    };
    return {
        handle: createLessonHostRpc(deps as any), host, settings, dir, deps, issuer,
        generation, close: () => { closed = true; },
    };
}

describe('lesson-host-v1', () => {
    it('returns a snapshot whose candidates carry every applicability field', async () => {
        const { handle, dir } = await harness();
        const result = await handle({ ...snapshotRequest, grantEnvelope: grantFor(snapshotRequest, ['lesson.read', 'lesson.manage']) });
        expect(result.ok).toBe(true);
        const candidate = (result as any).snapshot.candidates[0];
        expect(candidate).toMatchObject({
            candidateId: 'c1', revision: 3, payloadHash: 'h', status: 'reviewed',
            scope: 'this repo only', validation: ['npm test'], reconsiderWhen: 'CLI v3',
            validVersions: ['2.4.0'], duplicateLessonIds: ['l1'],
            failureModes: ['ran before the build'],
        });
        expect((result as any).snapshot.lessons).toHaveLength(1);
        // Applicability fields are carried through exactly as stored — present
        // when the row has them, absent when it does not.
        expect((result as any).snapshot.lessons[0]).toMatchObject({
            scope: 'this repo', validation: ['npm test'], failureModes: ['stale out/'],
        });
        expect((result as any).snapshot.lessons[0]).not.toHaveProperty('reconsiderWhen');
        expect((result as any).snapshot.pagination).toEqual({
            lessonOffset: 0, candidateOffset: 0, nextLessonOffset: 100, nextCandidateOffset: null,
        });
        expect((result as any).snapshot.settings).toEqual(LESSON_SETTINGS_DEFAULT);
        await rm(dir, { recursive: true, force: true });
    });

    it('reports a refused page instead of rendering it as an empty list', async () => {
        const refusing = fakeHost({
            listLessons: async () => ({ outcome: 'unsupported_version' }),
        });
        const { handle, dir } = await harness({ host: refusing.handle } as any);
        expect(await handle({
            ...snapshotRequest, grantEnvelope: grantFor(snapshotRequest, ['lesson.read', 'lesson.manage']),
        })).toEqual({ ok: false, reason: 'unsupported_version' });
        await rm(dir, { recursive: true, force: true });
    });

    it('lists lessons instead of running a query that would file selection traces', async () => {
        const { handle, host, dir } = await harness();
        await handle({ ...snapshotRequest, grantEnvelope: grantFor(snapshotRequest, ['lesson.read', 'lesson.manage']) });
        expect(host.calls.some((call) => call.name === 'listLessons')).toBe(true);
        expect(host.calls.some((call) => call.name === 'recall')).toBe(false);
        await rm(dir, { recursive: true, force: true });
    });

    it('walks pages with the offsets the caller supplies', async () => {
        const { handle, host, dir } = await harness();
        const paged = { ...snapshotRequest, requestId: 'r-page', lessonOffset: 100, candidateOffset: 0 };
        const result = await handle({ ...paged, grantEnvelope: grantFor(paged, ['lesson.read', 'lesson.manage']) });
        expect(result.ok).toBe(true);
        expect(host.calls.find((call) => call.name === 'listLessons')!.input)
            .toMatchObject({ limit: 100, offset: 100 });
        expect((result as any).snapshot.pagination.lessonOffset).toBe(100);
        await rm(dir, { recursive: true, force: true });
    });

    it('refuses an offset outside the agreed bounds rather than clamping it', async () => {
        const { handle, dir } = await harness();
        const bad = { ...snapshotRequest, requestId: 'r-bad', lessonOffset: -1 };
        expect(await handle({ ...bad, grantEnvelope: grantFor(bad, ['lesson.read', 'lesson.manage']) }))
            .toEqual({ ok: false, reason: 'invalid_request' });
        await rm(dir, { recursive: true, force: true });
    });

    it('acts on the verified claims, never on the echoed request fields', async () => {
        const h = await harness();
        const { handle, host, dir } = h;
        await handle({ ...snapshotRequest, grantEnvelope: grantFor(snapshotRequest, ['lesson.read', 'lesson.manage']) });
        const call = host.calls.find((entry) => entry.name === 'listCandidates')!;
        // Opaque on the wire; only the issuer can turn it into an identity.
        expect(Object.keys(call.input.binding as object)).toEqual([]);
        expect(call.identity).toMatchObject({
            projectHash: 'hash-p1', userId: 'u1', actorId: 'user:u1', machineId: 'm1', generation: 1,
        });
        await rm(dir, { recursive: true, force: true });
    });

    it('refuses a request whose grant was minted for another operation', async () => {
        const { handle, dir } = await harness();
        const approve = {
            version: 1, projectId: 'p1', requestId: 'r2', operation: 'approve',
            candidateId: 'c1', expectedRevision: 3, payloadHash: 'h',
        };
        const result = await handle({ ...approve, grantEnvelope: grantFor(snapshotRequest, ['lesson.read']) });
        expect(result).toEqual({ ok: false, reason: 'permission_denied' });
        await rm(dir, { recursive: true, force: true });
    });

    it('never lets a UI grant carry review authority through to CML', async () => {
        const h = await harness();
        const { handle, host, dir } = h;
        const approve = {
            version: 1, projectId: 'p1', requestId: 'r3', operation: 'approve',
            candidateId: 'c1', expectedRevision: 3, payloadHash: 'h',
        };
        await handle({ ...approve, grantEnvelope: grantFor(approve, ['lesson.manage']) });
        const resolved = host.calls.find((call) => call.name === 'approveCandidate')!.identity as
            { capabilities: string[] };
        expect(resolved.capabilities).toEqual(['lesson.manage']);
        expect(resolved.capabilities).not.toContain('lesson.review');
        await rm(dir, { recursive: true, force: true });
    });

    it('burns a mutation grant so one click cannot act twice', async () => {
        const { handle, dir } = await harness();
        const reject = {
            version: 1, projectId: 'p1', requestId: 'r4', operation: 'reject',
            candidateId: 'c1', expectedRevision: 3, payloadHash: 'h',
        };
        const envelope = grantFor(reject, ['lesson.manage']);
        expect((await handle({ ...reject, grantEnvelope: envelope })).ok).toBe(true);
        expect(await handle({ ...reject, grantEnvelope: envelope }))
            .toEqual({ ok: false, reason: 'permission_denied' });
        await rm(dir, { recursive: true, force: true });
    });

    it('lets a snapshot be retried, because a slow machine is not a replay', async () => {
        const { handle, dir } = await harness();
        const envelope = grantFor(snapshotRequest, ['lesson.read', 'lesson.manage']);
        expect((await handle({ ...snapshotRequest, grantEnvelope: envelope })).ok).toBe(true);
        expect((await handle({ ...snapshotRequest, grantEnvelope: envelope })).ok).toBe(true);
        await rm(dir, { recursive: true, force: true });
    });

    it('refuses a forged binding object even from inside this process', async () => {
        const h = await harness();
        const forged = {
            projectHash: 'hash-p1', actorId: 'user:attacker', userId: 'attacker', machineId: 'm1',
            sessionId: 's', generation: 1, capabilities: ['lesson.manage'],
        };
        await expect(h.issuer.verifier()(forged)).rejects.toMatchObject({ reason: 'unknown-binding' });
        await rm(h.dir, { recursive: true, force: true });
    });

    it('refuses a grant for another project on this same machine', async () => {
        const h = await harness();
        const other = { version: 1, projectId: 'p2', requestId: 'r-other', operation: 'snapshot' };
        // The grant is perfectly valid — for a different project.
        const envelope = (() => {
            const claims = {
                v: 1, aud: LESSON_GRANT_AUDIENCE, op: 'snapshot',
                digest: canonicalLessonDigest(other), userId: 'u1', projectId: 'p2', machineId: 'm1',
                workspaceDir: '/ws/p2',
                capabilities: ['lesson.read', 'lesson.manage'], iat: 1_000, expiresAt: 61_000,
            };
            const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
            return `${payload}.${signEd25519(null, Buffer.from(payload, 'utf8'), pair.privateKey).toString('base64url')}`;
        })();
        expect(await h.handle({ ...other, grantEnvelope: envelope }))
            .toEqual({ ok: false, reason: 'permission_denied' });
        await rm(h.dir, { recursive: true, force: true });
    });

    it('reports disabled with no verification key and unsupported with no store', async () => {
        const off = await harness({ verifier: null } as any);
        expect(await off.handle({ ...snapshotRequest, grantEnvelope: 'x' }))
            .toEqual({ ok: false, reason: 'disabled' });
        const noStore = await harness({ host: null, issuer: null } as any);
        expect(await noStore.handle({ ...snapshotRequest, grantEnvelope: 'x' }))
            .toEqual({ ok: false, reason: 'unsupported' });
        await rm(off.dir, { recursive: true, force: true });
        await rm(noStore.dir, { recursive: true, force: true });
    });

    it('reports an unknown protocol version rather than guessing', async () => {
        const { handle, dir } = await harness();
        expect(await handle({ ...snapshotRequest, version: 2, grantEnvelope: 'x' }))
            .toEqual({ ok: false, reason: 'unsupported_version' });
        await rm(dir, { recursive: true, force: true });
    });

    it('names a request-id payload conflict rather than calling it a runtime error', async () => {
        const failing = fakeHost({
            approveCandidate: async () => { throw new Error('requestId payload conflict'); },
        });
        const { handle, dir } = await harness({ host: failing.handle } as any);
        const approve = {
            version: 1, projectId: 'p1', requestId: 'r5', operation: 'approve',
            candidateId: 'c1', expectedRevision: 3, payloadHash: 'h',
        };
        expect(await handle({ ...approve, grantEnvelope: grantFor(approve, ['lesson.manage']) }))
            .toEqual({ ok: false, reason: 'request_conflict' });
        await rm(dir, { recursive: true, force: true });
    });

    it('names a same-name collision as merge_required, not a stale revision', async () => {
        // The message contains the word "revision", so a loose pattern reported
        // it as a retryable CAS conflict — and retrying can never fix it.
        const failing = fakeHost({
            approveCandidate: async () => {
                throw new Error('existing lesson requires an explicit merge proposal and lesson revision CAS');
            },
        });
        const { handle, dir } = await harness({ host: failing.handle } as any);
        const approve = {
            version: 1, projectId: 'p1', requestId: 'r-merge', operation: 'approve',
            candidateId: 'c1', expectedRevision: 3, payloadHash: 'h',
        };
        expect(await handle({ ...approve, grantEnvelope: grantFor(approve, ['lesson.manage']) }))
            .toEqual({ ok: false, reason: 'merge_required' });
        await rm(dir, { recursive: true, force: true });
    });

    it('prefers an error code over the message text', async () => {
        const failing = fakeHost({
            approveCandidate: async () => {
                const error = new Error('some future wording nobody has seen') as Error & { code: string };
                error.code = 'merge_required';
                throw error;
            },
        });
        const { handle, dir } = await harness({ host: failing.handle } as any);
        const approve = {
            version: 1, projectId: 'p1', requestId: 'r-code', operation: 'approve',
            candidateId: 'c1', expectedRevision: 3, payloadHash: 'h',
        };
        expect(await handle({ ...approve, grantEnvelope: grantFor(approve, ['lesson.manage']) }))
            .toEqual({ ok: false, reason: 'merge_required' });
        await rm(dir, { recursive: true, force: true });
    });

    it('leaves an unrecognised message as a runtime error rather than guessing', async () => {
        const failing = fakeHost({
            approveCandidate: async () => { throw new Error('a message with revision in it somewhere'); },
        });
        const { handle, dir } = await harness({ host: failing.handle } as any);
        const approve = {
            version: 1, projectId: 'p1', requestId: 'r-unknown', operation: 'approve',
            candidateId: 'c1', expectedRevision: 3, payloadHash: 'h',
        };
        expect(await handle({ ...approve, grantEnvelope: grantFor(approve, ['lesson.manage']) }))
            .toEqual({ ok: false, reason: 'runtime_error' });
        await rm(dir, { recursive: true, force: true });
    });

    it('names a CAS failure as a revision conflict', async () => {
        const failing = fakeHost({
            setRecallEnabled: async () => { throw new Error('lesson revision conflict or lesson not found'); },
        });
        const { handle, dir } = await harness({ host: failing.handle } as any);
        const disable = {
            version: 1, projectId: 'p1', requestId: 'r6', operation: 'set-recall-enabled',
            lessonId: 'l1', expectedRevision: 2, enabled: false,
        };
        expect(await handle({ ...disable, grantEnvelope: grantFor(disable, ['lesson.manage']) }))
            .toEqual({ ok: false, reason: 'revision_conflict' });
        await rm(dir, { recursive: true, force: true });
    });

    describe('configure', () => {
        const configure = (expectedRevision: number, reviewEnabled = true) => ({
            version: 1, projectId: 'p1', requestId: `cfg-${expectedRevision}-${reviewEnabled}`,
            operation: 'configure', expectedRevision,
            recallEnabled: true, reviewEnabled, dailyMicroUsd: 500, dailyTokens: 10_000,
        });

        it('writes settings and fences in-flight work by bumping the generation', async () => {
            const { handle, dir, generation } = await harness();
            const request = configure(1);
            const result = await handle({ ...request, grantEnvelope: grantFor(request, ['lesson.manage']) });
            expect(result.ok).toBe(true);
            expect((result as any).snapshot.settings).toMatchObject({ revision: 2, reviewEnabled: true, dailyMicroUsd: 500 });
            // The durable revision *is* the fence; there is no separate counter.
            expect(await generation()).toBe(2);
            await rm(dir, { recursive: true, force: true });
        });

        it('refuses a stale window rather than reverting the other window', async () => {
            const { handle, dir } = await harness();
            const first = configure(1, false);
            expect((await handle({ ...first, grantEnvelope: grantFor(first, ['lesson.manage']) })).ok).toBe(true);
            // A second window still believes revision 1 and would turn review back on.
            const stale = configure(1, true);
            expect(await handle({ ...stale, grantEnvelope: grantFor(stale, ['lesson.manage']) }))
                .toEqual({ ok: false, reason: 'revision_conflict' });
            await rm(dir, { recursive: true, force: true });
        });
    });
});
