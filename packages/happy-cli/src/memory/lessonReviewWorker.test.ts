import { describe, expect, it, vi } from 'vitest';
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
        markReviewed: async (input: any) => { await push('markReviewed', input); return {}; },
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
    if (reviewEnabled) {
        await settings.write({
            expectedRevision: 1, recallEnabled: true, reviewEnabled: true,
            dailyMicroUsd: 1_000_000, dailyTokens: 500_000,
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
        gateway: async () => ({
            config: { baseUrl: 'https://gw.example/v1', apiKey: 'k', projectId: 'p1', model: 'm' },
            quote: {
                model: 'm', inputMicroUsdPerMillion: 300, outputMicroUsdPerMillion: 1500,
                expiresAt: Date.now() + 600_000, source: 'vendor-doc',
            },
        }),
        identity: () => ({ userId: 'u1', projectId: 'p1', machineId: 'm1' }),
        ...overrides,
    };
    return { worker: createLessonReviewWorker(deps), host, settings, dir, deps };
}

function gatewayResponse(content: unknown) {
    return vi.fn(async () => new Response(JSON.stringify({
        model: 'm',
        choices: [{ message: { content: JSON.stringify(content) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
}

describe('createLessonReviewWorker', () => {
    it('refuses without a store, before anything else is considered', async () => {
        const h = await harness({ host: null });
        const gateway = vi.fn();
        expect(await h.worker.reviewFinishedTurn({
            record, signal: new AbortController().signal,
        })).toBe('unsupported');
        expect(gateway).not.toHaveBeenCalled();
        await rm(h.dir, { recursive: true, force: true });
    });

    it('refuses an aborted turn as cancelled, not as a failure', async () => {
        const h = await harness();
        expect(await h.worker.reviewFinishedTurn({
            record: { ...record, endedNormally: false },
            signal: new AbortController().signal,
        })).toBe('cancelled');
        await rm(h.dir, { recursive: true, force: true });
    });

    it('never calls the gateway when review is switched off', async () => {
        const gateway = vi.fn(async () => null);
        const h = await harness({ gateway }, false);
        expect(await h.worker.reviewFinishedTurn({
            record, signal: new AbortController().signal,
        })).toBe('disabled');
        expect(gateway).not.toHaveBeenCalled();
        await rm(h.dir, { recursive: true, force: true });
    });

    it('spends nothing when no settled price exists', async () => {
        const h = await harness({ gateway: async () => null });
        expect(await h.worker.reviewFinishedTurn({
            record, signal: new AbortController().signal,
        })).toBe('price_unknown');
        await rm(h.dir, { recursive: true, force: true });
    });

    it('refuses when the store did not persist the evidence, rather than inventing an id', async () => {
        const empty = hostFor({
            appendNormalEndEvidence: async () => ({ outcome: 'refused' }),
        } as never);
        const h = await harness({ host: empty.handle });
        expect(await h.worker.reviewFinishedTurn({
            record, signal: new AbortController().signal,
        })).toBe('not-eligible');
        await rm(h.dir, { recursive: true, force: true });
    });

    it('reports unsupported when the installed build has no evidence entry point', async () => {
        const old = hostFor();
        delete (old.handle.service as unknown as Record<string, unknown>).appendNormalEndEvidence;
        const h = await harness({ host: old.handle });
        expect(await h.worker.reviewFinishedTurn({
            record, signal: new AbortController().signal,
        })).toBe('unsupported');
        await rm(h.dir, { recursive: true, force: true });
    });

    it('anchors the candidate on the ids the store actually returned', async () => {
        (globalThis as { fetch: typeof fetch }).fetch =
            gatewayResponse({ proposal }) as unknown as typeof fetch;
        const h = await harness();
        expect(await h.worker.reviewFinishedTurn({
            record, signal: new AbortController().signal,
        })).toBe('reviewed');
        expect(h.host.calls.find((call) => call.name === 'enqueueCandidate')!.input.candidate)
            .toMatchObject({ sourceEventIds: ['evt-1'], sourceSessionIds: ['s1'] });
        // The host asserts the normal end, inside the binding.
        const identity = h.host.calls.find((call) => call.name === 'appendNormalEndEvidence')!.identity as
            { normalEndSessionIds?: string[] };
        expect(identity.normalEndSessionIds).toEqual(['s1']);
    });

    it('stops when the foreground preempts it', async () => {
        const controller = new AbortController();
        controller.abort();
        const h = await harness();
        expect(await h.worker.reviewFinishedTurn({
            record, signal: controller.signal,
        })).toBe('cancelled');
        await rm(h.dir, { recursive: true, force: true });
    });

    it('enqueues and reviews a proposal with review authority only', async () => {
        const fetchImpl = gatewayResponse({ proposal });
        const h = await harness();
        (globalThis as { fetch: typeof fetch }).fetch = fetchImpl as unknown as typeof fetch;
        const outcome = await h.worker.reviewFinishedTurn({
            record, signal: new AbortController().signal,
        });
        expect(outcome).toBe('reviewed');
        const enqueue = h.host.calls.find((call) => call.name === 'enqueueCandidate')!;
        const identity = enqueue.identity as { capabilities: string[] };
        // The worker proposes; only a person's grant can accept.
        expect(identity.capabilities).toEqual(['lesson.review']);
        expect(identity.capabilities).not.toContain('lesson.manage');
        expect(h.host.calls.some((call) => call.name === 'markReviewed')).toBe(true);
        expect(enqueue.input.candidate).toMatchObject({
            scope: 'this repo', validation: ['npm run test:e2e'], reconsiderWhen: 'the build output moves',
        });
        await rm(h.dir, { recursive: true, force: true });
    });

    it('does not write a candidate when review was switched off during the call', async () => {
        const h = await harness();
        (globalThis as { fetch: typeof fetch }).fetch = (async () => {
            // Another window turns review off while the provider is answering.
            await h.settings.write({
                expectedRevision: 2, recallEnabled: true, reviewEnabled: false,
                dailyMicroUsd: 1_000_000, dailyTokens: 500_000,
            });
            return new Response(JSON.stringify({
                model: 'm', choices: [{ message: { content: JSON.stringify({ proposal }) } }],
                usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }) as unknown as typeof fetch;
        expect(await h.worker.reviewFinishedTurn({
            record, signal: new AbortController().signal,
        })).toBe('stale_settings');
        expect(h.host.calls.some((call) => call.name === 'enqueueCandidate')).toBe(false);
        await rm(h.dir, { recursive: true, force: true });
    });

    it('keeps the applicability conditions the review produced', async () => {
        (globalThis as { fetch: typeof fetch }).fetch = gatewayResponse({
            proposal: { ...proposal, validVersions: ['cml 2.4.0'] },
        }) as unknown as typeof fetch;
        const h = await harness();
        expect(await h.worker.reviewFinishedTurn({
            record, signal: new AbortController().signal,
        })).toBe('reviewed');
        const enqueued = h.host.calls.find((call) => call.name === 'enqueueCandidate')!.input.candidate;
        expect(enqueued).toMatchObject({
            validVersions: ['cml 2.4.0'], failureModes: ['a stale out/ passes locally'],
        });
        await rm(h.dir, { recursive: true, force: true });
    });

    it('binds the worker to the real machine, not to a placeholder', async () => {
        (globalThis as { fetch: typeof fetch }).fetch =
            gatewayResponse({ proposal }) as unknown as typeof fetch;
        const h = await harness();
        await h.worker.reviewFinishedTurn({
            record, signal: new AbortController().signal,
        });
        const identity = h.host.calls.find((call) => call.name === 'enqueueCandidate')!.identity as
            { machineId: string };
        expect(identity.machineId).toBe('m1');
    });

    it('spends nothing when the settings file is unreadable', async () => {
        const h = await harness();
        // The user had switched review off; the file is then corrupted. Reading
        // it back as the defaults would turn review on again.
        await writeFile(join(h.dir, 'settings.json'), '{ not json');
        const fetchImpl = vi.fn();
        (globalThis as { fetch: typeof fetch }).fetch = fetchImpl as unknown as typeof fetch;
        expect(await h.worker.reviewFinishedTurn({
            record, signal: new AbortController().signal,
        })).toBe('settings_unreadable');
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(h.host.calls).toHaveLength(0);
        await rm(h.dir, { recursive: true, force: true });
    });

    it('treats an explicit no-lesson as a successful review', async () => {
        (globalThis as { fetch: typeof fetch }).fetch =
            gatewayResponse({ proposal: null }) as unknown as typeof fetch;
        const h = await harness();
        expect(await h.worker.reviewFinishedTurn({
            record, signal: new AbortController().signal,
        })).toBe('no-lesson');
        // Evidence is appended before the provider is asked; nothing after it ran.
        expect(h.host.calls.map((call) => call.name)).toEqual(['appendNormalEndEvidence']);
        await rm(h.dir, { recursive: true, force: true });
    });

    it('refuses a proposal missing its scope or validation', async () => {
        const { scope: _scope, ...withoutScope } = proposal;
        (globalThis as { fetch: typeof fetch }).fetch =
            gatewayResponse({ proposal: withoutScope }) as unknown as typeof fetch;
        const h = await harness();
        expect(await h.worker.reviewFinishedTurn({
            record, signal: new AbortController().signal,
        })).toBe('invalid_proposal');
        expect(h.host.calls.map((call) => call.name)).toEqual(['appendNormalEndEvidence']);
        await rm(h.dir, { recursive: true, force: true });
    });

    it('reports a candidate that already exists rather than reviewing it twice', async () => {
        (globalThis as { fetch: typeof fetch }).fetch =
            gatewayResponse({ proposal }) as unknown as typeof fetch;
        const existing = hostFor({
            enqueueCandidate: async () => ({
                outcome: 'reviewed', candidateId: 'c1', revision: 3, payloadHash: 'h', status: 'reviewed',
            }),
        });
        const h = await harness({ host: existing.handle });
        h.host.calls.length = 0;
        expect(await h.worker.reviewFinishedTurn({
            record, signal: new AbortController().signal,
        })).toBe('duplicate');
        expect(existing.calls.some((call) => call.name === 'markReviewed')).toBe(false);
        await rm(h.dir, { recursive: true, force: true });
    });

    it('enqueues once for the same turn seen twice', async () => {
        (globalThis as { fetch: typeof fetch }).fetch =
            gatewayResponse({ proposal }) as unknown as typeof fetch;
        const h = await harness();
        const signal = new AbortController().signal;
        expect(await h.worker.reviewFinishedTurn({ record, signal })).toBe('reviewed');
        // The ledger recognises the same evidence key and refuses to pay again.
        expect(await h.worker.reviewFinishedTurn({ record, signal })).toBe('duplicate');
        await rm(h.dir, { recursive: true, force: true });
    });
});

describe('authorization withdrawn mid-review', () => {
    it('writes nothing when the caller is no longer authorized', async () => {
        const h = await harness();
        let authorized = true;
        // The lease lapses while the provider is still answering.
        (h.deps as { identity: () => unknown }).identity = () =>
            (authorized ? { userId: 'u1', projectId: 'p1', machineId: 'm1' } : null);
        (globalThis as { fetch: typeof fetch }).fetch = (async () => {
            authorized = false;
            return new Response(JSON.stringify({
                model: 'm', choices: [{ message: { content: JSON.stringify({ proposal }) } }],
                usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }) as unknown as typeof fetch;

        const outcome = await h.worker.reviewFinishedTurn({
            record, signal: new AbortController().signal,
        });
        expect(outcome).toBe('stale_settings');
        expect(h.host.calls.some((call) => call.name === 'enqueueCandidate')).toBe(false);
        expect(h.host.calls.some((call) => call.name === 'markReviewed')).toBe(false);
        await rm(h.dir, { recursive: true, force: true });
    });

    it('spends nothing when authorization is already gone', async () => {
        const h = await harness({ identity: () => null });
        const fetchImpl = vi.fn();
        (globalThis as { fetch: typeof fetch }).fetch = fetchImpl as unknown as typeof fetch;
        expect(await h.worker.reviewFinishedTurn({
            record, signal: new AbortController().signal,
        })).toBe('permission_denied');
        expect(fetchImpl).not.toHaveBeenCalled();
        await rm(h.dir, { recursive: true, force: true });
    });
});
