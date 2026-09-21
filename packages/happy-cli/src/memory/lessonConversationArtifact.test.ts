import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { openLessonHost, type LessonHostHandle } from './cmlLessonHost';
import { createLessonBindingIssuer } from './lessonBindingIssuer';
import { createLessonSettingsStore } from './lessonSettingsStore';
import { createLessonTurnHost } from './lessonTurnHost';
import { createLessonReviewWorker } from './lessonReviewWorker';
import { LessonReviewBudget } from './lessonReviewBudget';

// Optional external artifact in normal CLI CI; the cross-repository job supplies
// this explicitly and requires the test to run, not skip.
describe.skipIf(!process.env.CLAUDE_MEMORY_LESSON_HOST_ROOT)('lesson conversation with the real CML artifact', () => {
    it('keeps proposals private, recalls an approved lesson in session B, and records only acknowledged delivery', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'lesson-conversation-'));
        const settings = createLessonSettingsStore(join(dir, 'settings.json'));
        let handle: LessonHostHandle | null = null;
        let closed = false;
        const issuer = createLessonBindingIssuer({
            projectHash: () => handle?.projectHash ?? null,
            projectId: 'project', generation: async () => (await settings.read()).revision, closed: () => closed,
        });
        const identity = { projectId: 'project', userId: 'actual-caller', machineId: 'machine', sessionId: 'session-a' };
        const opened = await openLessonHost({ workspaceDir: dir, isolatedStorageRoot: join(dir, 'store'), verifyBinding: issuer.verifier() });
        if (!opened.ok) throw new Error(`CML artifact could not open: ${opened.detail}`);
        handle = opened.handle;
        const manager = await issuer.issue({ ...identity, capabilities: ['lesson.read', 'lesson.manage'], ttlMs: 30_000 });
        const turn = createLessonTurnHost({ host: handle, issuer, settings, identity: () => ({ ...identity, sessionId: 'session-b' }) });
        try {
            const worker = createLessonReviewWorker({ host: handle, issuer, settings,
                budget: new LessonReviewBudget(join(dir, 'ledger.json')), identity: () => identity });
            expect(await settings.read()).toMatchObject({ reviewEnabled: true, dailyMicroUsd: 0, dailyTokens: 0 });
            const prepared = await worker.prepareReviewTurn!();
            expect(prepared).toEqual({ revision: 1 });
            expect(await turn.recall({ turnId: 'before-review', query: 'port listener collision' })).toEqual({ outcome: 'no_match' });
            expect(await worker.reviewFinishedTurn({
                record: { sessionId: 'session-a', turnId: 'turn-a', kind: 'foreground', endedNormally: true,
                    hadPriorAssistantTurn: false, userMessages: ['Repair the port listener test'],
                    agentSummary: 'The port regression test failed. After closing the owned listener, the same regression test passed.',
                    recoveredFailures: ['The port listener test failed and then passed after fixing the owned listener'] },
                signal: new AbortController().signal, settingsRevision: prepared!.revision,
                proposal: { name: 'Port listener verification', trigger: 'Port listener collision',
                    steps: ['Identify the owned listener', 'Close it and rerun the port test'],
                    failureModes: ['Do not close an unrelated process'], scope: 'This project listener tests',
                    validation: ['The same port test passed'], reconsiderWhen: 'The listener ownership changes' },
            })).toBe('reviewed');
            const { candidates } = await handle.service.listCandidates({ version: 1, requestId: 'candidates', binding: manager.handle }) as {
                candidates: Array<{ candidateId: string; revision: number; payloadHash: string; status: string }>;
            };
            expect(candidates).toHaveLength(1);
            const reviewed = candidates[0];
            expect(reviewed.status).toBe('reviewed');
            expect(await turn.recall({ turnId: 'before-approval', query: 'port listener collision' })).toEqual({ outcome: 'no_match' });
            const accepted = await handle.service.approveCandidate({ version: 1, requestId: 'approve', binding: manager.handle, generation: 1,
                candidateId: reviewed.candidateId, expectedRevision: reviewed.revision, payloadHash: reviewed.payloadHash }) as { lessonId: string; lessonRevision: number };
            const recalled = await turn.recall({ turnId: 'session-b-turn', query: 'port listener collision' });
            expect(recalled.outcome).toBe('selected');
            if (recalled.outcome !== 'selected') throw new Error('Approved lesson was not selected');
            expect(recalled.block).toContain(`[lesson:${accepted.lessonId}]`);
            expect(recalled.block).toContain('The same port test passed');
            const list = async () => (await handle!.service.listLessons({ version: 1, requestId: 'list', binding: manager.handle }) as {
                lessons: Array<{ lastSelectedAt: string | null; lastDeliveredAt: string | null }>;
            }).lessons[0];
            expect((await list()).lastSelectedAt).toBeTruthy();
            expect((await list()).lastDeliveredAt).toBeNull();
            expect(await turn.acknowledge(recalled.ticket)).toBe(true);
            expect((await list()).lastDeliveredAt).toBeTruthy();
            await handle.service.setRecallEnabled({ version: 1, requestId: 'exclude', binding: manager.handle, generation: 1,
                lessonId: accepted.lessonId, expectedRevision: accepted.lessonRevision, enabled: false });
            expect(await turn.recall({ turnId: 'after-exclusion', query: 'port listener collision' })).toEqual({ outcome: 'no_match' });
        } finally {
            manager.release(); closed = true;
            await handle.close();
            await rm(dir, { recursive: true, force: true });
        }
    });
});
