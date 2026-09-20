import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { openLessonHost, type LessonHostHandle } from './cmlLessonHost';
import { createLessonBindingIssuer } from './lessonBindingIssuer';
import { createLessonSettingsStore } from './lessonSettingsStore';
import { createLessonTurnHost } from './lessonTurnHost';

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
        const review = await issuer.issue({ ...identity, capabilities: ['lesson.review'], normalEndSessionIds: ['session-a'], ttlMs: 30_000 });
        const manager = await issuer.issue({ ...identity, capabilities: ['lesson.read', 'lesson.manage'], ttlMs: 30_000 });
        const turn = createLessonTurnHost({ host: handle, issuer, settings, identity: () => ({ ...identity, sessionId: 'session-b' }) });
        try {
            const evidence = await handle.service.appendNormalEndEvidence!({
                version: 1, requestId: 'evidence', binding: review.handle, generation: 1,
                evidenceKey: 'verified-port-test', sessionId: 'session-a',
                content: 'The port regression test failed. After closing the owned listener, the same regression test passed.',
            }) as { outcome: string; eventId: string };
            expect(evidence.outcome).toBe('persisted');
            const candidate = { name: 'Port listener verification', trigger: 'Port listener collision',
                steps: ['Identify the owned listener', 'Close it and rerun the port test'], confidence: 0.5,
                sourceSessionIds: ['session-a'], sourceEventIds: [evidence.eventId], failureModes: ['Do not close an unrelated process'],
                skillCandidate: false, scope: 'This project listener tests', validation: ['The same port test passed'],
                reconsiderWhen: 'The listener ownership changes' };
            const payloadHash = handle.hashCandidatePayload(candidate);
            const queued = await handle.service.enqueueCandidate({ version: 1, requestId: 'enqueue', binding: review.handle, generation: 1,
                evidenceKey: 'verified-port-test', payloadHash, candidate }) as { candidateId: string; revision: number };
            expect(await turn.recall({ turnId: 'before-review', query: 'port listener collision' })).toEqual({ outcome: 'no_match' });
            const reviewed = await handle.service.markReviewed({ version: 1, requestId: 'review', binding: review.handle, generation: 1,
                candidateId: queued.candidateId, expectedRevision: queued.revision, payloadHash }) as { revision: number };
            expect(await turn.recall({ turnId: 'before-approval', query: 'port listener collision' })).toEqual({ outcome: 'no_match' });
            const accepted = await handle.service.approveCandidate({ version: 1, requestId: 'approve', binding: manager.handle, generation: 1,
                candidateId: queued.candidateId, expectedRevision: reviewed.revision, payloadHash }) as { lessonId: string; lessonRevision: number };
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
            review.release(); manager.release(); closed = true;
            await handle.close();
            await rm(dir, { recursive: true, force: true });
        }
    });
});
