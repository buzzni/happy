import { logger } from '@/ui/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LessonReviewBudget } from './lessonReviewBudget';
import { createLessonBindingIssuer } from './lessonBindingIssuer';
import { createLessonReviewWorker, type LessonReviewWorkerDeps } from './lessonReviewWorker';
import { createLessonSettingsStore } from './lessonSettingsStore';
import type { LessonHostHandle } from './cmlLessonHost';
import type { LessonTurnRecord } from './lessonTurnEvidence';

const record: LessonTurnRecord = {
    sessionId: 's1', turnId: 't1', kind: 'foreground', endedNormally: true,
    hadPriorAssistantTurn: false,
    userMessages: ['fix the build'],
    agentSummary: 'set out/ then reran the e2e suite',
    recoveredFailures: ['e2e failed: out/ missing'],
};

const proposal = {
    name: 'rebuild before e2e', trigger: 'e2e fails with missing out/',
    steps: ['run the build', 'rerun the suite'], scope: 'this repo',
    validation: ['npm run test:e2e'], reconsiderWhen: 'the build output moves',
    failureModes: ['a stale out/ passes locally'],
};

function hostFor(
    overrides: Partial<LessonHostHandle['service']> = {},
    resolveBinding?: (binding: unknown) => Promise<unknown>,
) {
    // Resolved during the call: a handle is released in the worker's `finally`,
    // and that is also the only moment CML itself would resolve it.
    const calls: Array<{ name: string; input: any; identity?: unknown }> = [];
    const push = async (name: string, input: any) => {
        const identity = resolveBinding ? await resolveBinding(input.binding).catch((e) => e) : undefined;
        calls.push({ name, input, identity });
    };
    const service = {
        appendNormalEndEvidence: async (input: any) => {
            await push('appendNormalEndEvidence', input);
            return { outcome: 'persisted', eventId: 'evt-1', evidenceKey: 'k', redacted: true };
        },
        enqueueCandidate: async (input: any) => {
            await push('enqueueCandidate', input);
            return { outcome: 'pending', candidateId: 'c1', revision: 1, payloadHash: 'h', status: 'pending' };
        },
        markReviewed: async (input: any) => { await push('markReviewed', input); return { outcome: 'reviewed' }; },
        recall: async () => ({}), get: async () => ({}), recordRead: async () => ({}),
        ackDelivery: async () => ({}), approveCandidate: async () => ({}), rejectCandidate: async () => ({}),
        setRecallEnabled: async () => ({}), listCandidates: async () => ({}), listLessons: async () => ({}),
        reviewStatus: async () => ({}),
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

async function harness(overrides: Partial<LessonReviewWorkerDeps> = {}, reviewEnabled = true) {
    const dir = await mkdtemp(join(tmpdir(), 'lesson-review-'));
    const settings = createLessonSettingsStore(join(dir, 'settings.json'));
    {
        await settings.write({
            expectedRevision: 1, recallEnabled: true, reviewEnabled,
            dailyMicroUsd: 0, dailyTokens: 0,
        });
    }
    let issuerRef: ReturnType<typeof createLessonBindingIssuer> | undefined;
    const host = overrides.host === undefined
        ? hostFor({}, (binding) => issuerRef!.verifier()(binding))
        : { handle: overrides.host as LessonHostHandle, calls: [] as Array<{ name: string; input: any; identity?: unknown }> };
    const issuer = createLessonBindingIssuer({
        projectHash: () => host.handle?.projectHash ?? null,
        projectId: 'p1',
        generation: async () => (await settings.read()).revision,
        closed: () => false,
    });
    issuerRef = issuer;
    const deps: LessonReviewWorkerDeps = {
        host: host.handle,
        issuer,
        settings,
        budget: new LessonReviewBudget(join(dir, 'ledger.json')),
        identity: () => ({ userId: 'u1', projectId: 'p1', machineId: 'm1' }),
        ...overrides,
    };
    return { worker: createLessonReviewWorker(deps), host, settings, dir, deps };
}

afterEach(() => vi.unstubAllGlobals());
const input = () => ({ record, proposal, settingsRevision: 2, signal: new AbortController().signal });

describe('foreground lesson proposals', () => {
    it('persists a candidate with zero budgets, only review authority and store-owned evidence', async () => {
        const network = vi.fn(() => { throw new Error('unexpected network'); });
        vi.stubGlobal('fetch', network);
        const h = await harness();
        expect(await h.worker.prepareReviewTurn!()).toEqual({ revision: 2 });
        expect(await h.worker.reviewFinishedTurn(input())).toBe('reviewed');
        expect(network).not.toHaveBeenCalled();
        const call = h.host.calls.find(c => c.name === 'enqueueCandidate')!;
        expect(call.input.candidate).toMatchObject({ sourceEventIds: ['evt-1'], sourceSessionIds: ['s1'], confidence: 0.5 });
        expect(call.identity).toMatchObject({ capabilities: ['lesson.review'], machineId: 'm1' });
        expect(h.host.calls.map(c => c.name)).toEqual(['appendNormalEndEvidence', 'enqueueCandidate', 'markReviewed']);
        await rm(h.dir, { recursive: true, force: true });
    });
    it('distinguishes authorization refusal while preparing a proposal', async () => {
        const log = vi.spyOn(logger, 'debug').mockImplementation(() => {});
        const h = await harness({ identity: () => null });
        try {
            expect(await h.worker.prepareReviewTurn!()).toBeNull();
            expect(log).toHaveBeenCalledWith('[lesson-review-prepare] permission_denied');
        } finally { log.mockRestore(); await rm(h.dir, { recursive: true, force: true }); }
    });
    it.each([
        ['no-signal', false, 'observed task', []],
        ['no-evidence', true, '', []],
    ] as const)('reports bounded %s diagnostics without recording content', async (reason, prior, summary, failures) => {
        const log = vi.spyOn(logger, 'debug').mockImplementation(() => {});
        const h = await harness();
        try {
            const result = await h.worker.reviewFinishedTurn({ ...input(), record: {
                ...record, hadPriorAssistantTurn: prior, userMessages: ['아니 secret-value'],
                agentSummary: summary, recoveredFailures: failures,
            } });
            expect(result).toBe('not-eligible');
            expect(log).toHaveBeenCalledWith('[lesson-review-evidence]', {
                reason, kind: 'foreground', hadPriorAssistantTurn: prior,
                hasObservedActions: Boolean(summary), hasVerifiedRecovery: false, proposalSubmitted: true,
            });
            expect(JSON.stringify(log.mock.calls)).not.toContain('secret-value');
            expect(h.host.calls).toHaveLength(0);
        } finally { log.mockRestore(); await rm(h.dir, { recursive: true, force: true }); }
    });
    it('does not call a gateway or persist evidence when no proposal was supplied', async () => {
        const network = vi.fn(); vi.stubGlobal('fetch', network);
        const h = await harness();
        expect(await h.worker.reviewFinishedTurn({ ...input(), proposal: undefined })).toBe('no-lesson');
        expect(await h.worker.reviewFinishedTurn({ ...input(), proposal: null })).toBe('no-lesson');
        expect(network).not.toHaveBeenCalled(); expect(h.host.calls).toHaveLength(0);
        await rm(h.dir, { recursive: true, force: true });
    });
    it('preserves explicit off and fails closed on corrupt settings', async () => {
        const h = await harness({}, false);
        expect(await h.worker.prepareReviewTurn!()).toBeNull();
        expect(await h.worker.reviewFinishedTurn(input())).toBe('disabled');
        await writeFile(join(h.dir, 'settings.json'), '{ broken');
        expect(await h.worker.prepareReviewTurn!()).toBeNull();
        expect(await h.worker.reviewFinishedTurn(input())).toBe('settings_unreadable');
        expect(h.host.calls).toHaveLength(0);
        await rm(h.dir, { recursive: true, force: true });
    });
    it('defaults new projects on without overwriting an explicit off', async () => {
        const h = await harness({}, false);
        expect((await h.settings.read()).reviewEnabled).toBe(false);
        await rm(join(h.dir, 'settings.json'));
        expect(await h.worker.prepareReviewTurn!()).toEqual({ revision: 1 });
        expect(await h.worker.reviewFinishedTurn({ ...input(), settingsRevision: 1 })).toBe('reviewed');
        await rm(h.dir, { recursive: true, force: true });
    });
    it.each([
        ['cancelled', { record: { ...record, endedNormally: false } }],
        ['not-eligible', { record: { ...record, kind: 'automation' } }],
        ['stale_settings', { settingsRevision: undefined }],
        ['stale_settings', { settingsRevision: 1 }],
        ['invalid_proposal', { proposal: { ...proposal, scope: '' } }],
        ['invalid_proposal', { proposal: { ...proposal, trigger: 'x'.repeat(17000) } }],
    ])('refuses %s before storage', async (outcome, patch) => {
        const h = await harness();
        expect(await h.worker.reviewFinishedTurn({ ...input(), ...patch } as Parameters<typeof h.worker.reviewFinishedTurn>[0])).toBe(outcome);
        expect(h.host.calls).toHaveLength(0);
        await rm(h.dir, { recursive: true, force: true });
    });
    it('requires available host and real actor', async () => {
        for (const [overrides, outcome] of [[{ host: null }, 'unsupported'], [{ identity: () => null }, 'permission_denied']] as const) {
            const h = await harness(overrides);
            expect(await h.worker.prepareReviewTurn!()).toBeNull();
            expect(await h.worker.reviewFinishedTurn(input())).toBe(outcome);
            await rm(h.dir, { recursive: true, force: true });
        }
    });
    it('cancels preempted turns', async () => {
        const h = await harness(); const controller = new AbortController(); controller.abort();
        expect(await h.worker.reviewFinishedTurn({ ...input(), signal: controller.signal })).toBe('cancelled');
        expect(h.host.calls).toHaveLength(0);
        await rm(h.dir, { recursive: true, force: true });
    });
    it('keeps applicability and ignores forged authority fields', async () => {
        const h = await harness();
        expect(await h.worker.reviewFinishedTurn({ ...input(), proposal: { ...proposal, validVersions: ['cml 2.4.3'],
            confidence: 1, skillCandidate: true, sourceEventIds: ['forged'] } })).toBe('reviewed');
        expect(h.host.calls.find(c => c.name === 'enqueueCandidate')!.input.candidate).toMatchObject({
            validVersions: ['cml 2.4.3'], confidence: 0.5, skillCandidate: false, sourceEventIds: ['evt-1'],
        });
        await rm(h.dir, { recursive: true, force: true });
    });
    it('deduplicates and rate limits across worker restarts', async () => {
        const h = await harness();
        expect(await h.worker.reviewFinishedTurn(input())).toBe('reviewed');
        const restarted = createLessonReviewWorker(h.deps);
        expect(await restarted.reviewFinishedTurn(input())).toBe('duplicate');
        expect(await restarted.reviewFinishedTurn({ ...input(), record: { ...record, turnId: 't2', agentSummary: 'a distinct verified fix' } })).toBe('cooldown');
        await rm(h.dir, { recursive: true, force: true });
    });
    it('never invents evidence after store refusal', async () => {
        const host = hostFor({ appendNormalEndEvidence: async () => ({ outcome: 'refused' }) } as never);
        const h = await harness({ host: host.handle });
        expect(await h.worker.reviewFinishedTurn(input())).toBe('not-eligible');
        expect(host.calls).toHaveLength(0);
        await rm(h.dir, { recursive: true, force: true });
    });
    it('releases a claim when evidence fails before enqueue, allowing a safe retry', async () => {
        const h = await harness();
        const original = h.deps.host!.service.appendNormalEndEvidence;
        h.deps.host!.service.appendNormalEndEvidence = (async () => ({ outcome: 'refused' })) as never;
        expect(await h.worker.reviewFinishedTurn(input())).toBe('not-eligible');
        h.deps.host!.service.appendNormalEndEvidence = original;
        expect(await h.worker.reviewFinishedTurn(input())).toBe('reviewed');
        await rm(h.dir, { recursive: true, force: true });
    });
    it('does not report reviewed when the store refuses the transition', async () => {
        const h = await harness();
        h.deps.host!.service.markReviewed = async () => ({ outcome: 'unsupported_version' });
        expect(await h.worker.reviewFinishedTurn(input())).toBe('runtime_error');
        await rm(h.dir, { recursive: true, force: true });
    });
    it('keeps the claim when enqueue throws because the write may already have committed', async () => {
        const h = await harness();
        h.deps.host!.service.enqueueCandidate = async () => { throw new Error('lost response'); };
        expect(await h.worker.reviewFinishedTurn(input())).toBe('runtime_error');
        expect(await h.worker.reviewFinishedTurn(input())).toBe('duplicate');
        await rm(h.dir, { recursive: true, force: true });
    });
    it('revokes the CML write binding immediately when foreground aborts inside enqueue', async () => {
        const h = await harness(); const controller = new AbortController();
        h.deps.host!.service.enqueueCandidate = async (request: any) => {
            await Promise.resolve();
            controller.abort();
            await expect(h.deps.issuer!.resolve(request.binding)).rejects.toThrow();
            throw new Error('binding revoked');
        };
        expect(await h.worker.reviewFinishedTurn({ ...input(), signal: controller.signal })).toBe('cancelled');
        expect(h.host.calls.some(c => c.name === 'markReviewed')).toBe(false);
        await rm(h.dir, { recursive: true, force: true });
    });
    it.each(['settings', 'identity', 'abort'] as const)('fences %s revoked while evidence is being persisted', async reason => {
        let authorized = true; const controller = new AbortController();
        const h = await harness({ identity: () => authorized ? { userId: 'u1', projectId: 'p1', machineId: 'm1' } : null });
        h.deps.host!.service.appendNormalEndEvidence = (async () => {
            if (reason === 'settings') await h.settings.write({ expectedRevision: 2, recallEnabled: true, reviewEnabled: false, dailyMicroUsd: 0, dailyTokens: 0 });
            if (reason === 'identity') authorized = false;
            if (reason === 'abort') controller.abort();
            return { outcome: 'persisted', eventId: 'evt-1' };
        }) as never;
        expect(await h.worker.reviewFinishedTurn({ ...input(), signal: controller.signal })).toBe(reason === 'abort' ? 'cancelled' : 'stale_settings');
        expect(h.host.calls.some(c => c.name === 'enqueueCandidate')).toBe(false);
        await rm(h.dir, { recursive: true, force: true });
    });
});
