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
    it.each([
    {
        "query": "port listener collision",
        "proposal": {
            "name": "Port listener verification",
            "trigger": "Port listener collision",
            "steps": [
                "Identify the owned listener",
                "Close it and rerun the port test"
            ],
            "failureModes": [
                "Do not close an unrelated process"
            ],
            "scope": "This project listener tests",
            "validation": [
                "The same port test passed"
            ],
            "reconsiderWhen": "The listener ownership changes"
        },
        "referenceOnly": false,
        "versionConditional": false
    },
    {
        "query": "현재 Happy CLI 버전을 확인해주세요. 파일 수정·설치·교훈 저장은 하지 마세요. 로그 전체나 인증정보는 출력하지 마세요.",
        "proposal": {
            "name": "happy-running-version-from-startup-diagnostic",
            "trigger": "Need to verify which happy CLI version a running session actually uses, as opposed to the installed version",
            "steps": [
                "Installed evidence: read version from the installed @buzzni/happy-cli package.json (resolve the `happy` bin symlink to find it); file mtimes are also install-side evidence only",
                "Identify the running session's happy process PID (the node .../happy-cli/dist/index.mjs claude process that is the parent of the claude binary serving this shell)",
                "Runtime evidence: in ~/.happy_remote/logs/<start-timestamp>-pid-<PID>.log, extract only the line matching '^\\S.*\\[DAEMON CONTROL\\] Current CLI version: ' (grep | head -n 1), never dumping the whole log",
                "Report installed version and running version separately; mark running version unconfirmed only if the startup diagnostic line is absent"
            ],
            "failureModes": [
                "Concluding the running version is unconfirmed (or inferring it from mtime vs process start time) without checking the process startup diagnostic",
                "Treating package.json or file mtimes as runtime evidence",
                "Printing the full session log, which may contain conversation or credentials"
            ],
            "scope": "happy CLI (@buzzni/happy-cli) sessions launched by the happy daemon on this machine",
            "validation": [
                "A process startup diagnostic confirmed the running version"
            ],
            "reconsiderWhen": "happy CLI changes its log directory, log filename pattern, or removes/renames the DAEMON CONTROL version diagnostic",
            "validVersions": []
        },
        "referenceOnly": true,
        "versionConditional": false
    }
].flatMap(fixture => fixture.referenceOnly ? [fixture, { ...fixture, versionConditional: true, proposal: { ...fixture.proposal, validVersions: ['@buzzni/happy-cli 1.1.10-aplus.239'] } }] : [fixture]))('keeps proposals private, recalls an approved lesson in session B, and records only acknowledged delivery', async ({ query, proposal, referenceOnly, versionConditional }) => {
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
            expect(await turn.recall({ turnId: 'before-review', query })).toEqual({ outcome: 'no_match' });
            expect(await worker.reviewFinishedTurn({
                record: { sessionId: 'session-a', turnId: 'turn-a', kind: 'foreground', endedNormally: true,
                    hadPriorAssistantTurn: false, userMessages: ['Repair the port listener test'],
                    agentSummary: 'The port regression test failed. After closing the owned listener, the same regression test passed.',
                    recoveredFailures: ['The port listener test failed and then passed after fixing the owned listener'] },
                signal: new AbortController().signal, settingsRevision: prepared!.revision,
                proposal,
            })).toBe('reviewed');
            const { candidates } = await handle.service.listCandidates({ version: 1, requestId: 'candidates', binding: manager.handle }) as {
                candidates: Array<{ candidateId: string; revision: number; payloadHash: string; status: string }>;
            };
            expect(candidates).toHaveLength(1);
            const reviewed = candidates[0];
            expect(reviewed.status).toBe('reviewed');
            expect(await turn.recall({ turnId: 'before-approval', query })).toEqual({ outcome: 'no_match' });
            const accepted = await handle.service.approveCandidate({ version: 1, requestId: 'approve', binding: manager.handle, generation: 1,
                candidateId: reviewed.candidateId, expectedRevision: reviewed.revision, payloadHash: reviewed.payloadHash }) as { lessonId: string; lessonRevision: number };
            const recalled = await turn.recall({ turnId: 'session-b-turn', query });
            // A declared version condition must not be silently treated as verified.
            if (versionConditional) {
                expect(recalled.outcome).toBe('no_match');
                return;
            }
            expect(recalled.outcome).toBe('selected');
            if (recalled.outcome !== 'selected') throw new Error('Approved lesson was not selected');
            expect(recalled.block).toContain(`[lesson:${accepted.lessonId}]`);
            expect(recalled.block).toContain(referenceOnly ? 'mem-lesson-get' : 'The same port test passed');
            const list = async () => (await handle!.service.listLessons({ version: 1, requestId: 'list', binding: manager.handle }) as {
                lessons: Array<{ lastSelectedAt: string | null; lastDeliveredAt: string | null }>;
            }).lessons[0];
            expect((await list()).lastSelectedAt).toBeTruthy();
            expect((await list()).lastDeliveredAt).toBeNull();
            expect(await turn.acknowledge(recalled.ticket)).toBe(true);
            expect((await list()).lastDeliveredAt).toBeTruthy();
            await handle.service.setRecallEnabled({ version: 1, requestId: 'exclude', binding: manager.handle, generation: 1,
                lessonId: accepted.lessonId, expectedRevision: accepted.lessonRevision, enabled: false });
            expect(await turn.recall({ turnId: 'after-exclusion', query })).toEqual({ outcome: 'no_match' });
        } finally {
            manager.release(); closed = true;
            await handle.close();
            await rm(dir, { recursive: true, force: true });
        }
    });
});
