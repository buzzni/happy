import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionScanner } from '@/claude/utils/sessionScanner';
import { getProjectPath } from '@/claude/utils/path';
import { OutgoingMessageQueue } from '@/claude/utils/OutgoingMessageQueue';
import { SDKToLogConverter } from '@/claude/utils/sdkToLogConverter';
import { logger } from '@/ui/logger';
import { withContextUsageSignals } from '@/claude/claudeContextUsage';
import { TurnInputEvidence, type EvidenceBatch } from '@/api/turnInputEvidence';
import {
    closeClaudeTurnWithStatus,
    mapClaudeChannelFinalAnswer,
    mapClaudeLogMessageToSessionEnvelopes,
    mapClaudeStructuredOutput,
    type ClaudeSessionProtocolState,
} from '@/claude/utils/sessionProtocolMapper';
import type { SessionEnvelope, SessionTurnEndStatus } from '@slopus/happy-wire';
import {
    createOrderedTurnDispatcher,
    finalAnswerItem,
    pendingRequestItem,
    turnEndItem,
    permissionBindingItem,
    structuredOutputItem,
} from './channelTurnOrdering';
import { installChannelPermissionWiring } from './channelPermissionWiring';

/**
 * Drives the **real** dispatcher the launcher installs, against the **real** mapper, so the
 * ordering under test is the production one.
 *
 * The race this exists for cannot be seen from the mapper alone: by the time the mapper runs, the
 * queue has already decided the order. The launcher calls `onMessage(assistant)`,
 * `onMessage(result)` and `onReady()` in quick succession while the queue is still draining, and
 * the question is whether the envelopes come out as `turn-start → text → final-answer → turn-end`
 * under one request id.
 */
function harness(witnessed = false) {
    const envelopes: SessionEnvelope[] = [];
    const evidence = new TurnInputEvidence('host', envelope => envelopes.push(envelope));
    const append = (batch: SessionEnvelope[]) => envelopes.push(...batch.map(envelope => witnessed ? evidence.stamp(envelope) : envelope));
    const rearm = vi.fn((ids: string[], reasons?: string[]) => evidence.rearmBackground(ids, reasons));
    const state: ClaudeSessionProtocolState = { currentTurnId: null,
        ...(witnessed ? { onBackgroundInputLaunch: (id: string, turn: string) => evidence.rememberBackground(id, turn),
            onBackgroundInputRearm: rearm } : {}) };
    const bindings: {
        permissionId: string; toolName: string; instanceSeq: number;
        turnId: string | null; requestId: string | null;
    }[] = [];
    const target = {
        setPendingInputEvidence: (batch: EvidenceBatch) => evidence.setPending(batch),
        setPendingTurnRequestId: (requestId: string | null) => { state.pendingRequestId = requestId; },
        sendFinalAnswerForChannelTurn: (text: string) => {
            append(mapClaudeChannelFinalAnswer(state, text).envelopes);
        },
        sendStructuredOutput: (envelope: Parameters<typeof mapClaudeStructuredOutput>[1]) => {
            append(mapClaudeStructuredOutput(state, envelope).envelopes);
        },
        closeClaudeSessionTurn: (status: SessionTurnEndStatus) => {
            append(closeClaudeTurnWithStatus(state, status).envelopes);
        },
        sendClaudeSessionMessage: (logMessage: unknown) => {
            const mapped = mapClaudeLogMessageToSessionEnvelopes(logMessage as never, state);
            state.currentTurnId = mapped.currentTurnId;
            append(mapped.envelopes);
        },
        // Records the turn the binding was applied against, which is the whole question.
        bindChannelPermission: (permissionId: string, toolName: string, instanceSeq: number) => {
            bindings.push({
                permissionId,
                toolName,
                instanceSeq,
                turnId: state.currentTurnId,
                requestId: state.currentRequestId ?? null,
            });
        },
    };
    const queue = new OutgoingMessageQueue(withContextUsageSignals(createOrderedTurnDispatcher(target), () => {}));
    return { queue, envelopes, state, bindings, evidence, rearm, sendScannerMessage: target.sendClaudeSessionMessage };
}

const assistant = (text: string, uuid = 'a-1') => ({
    type: 'assistant',
    uuid,
    message: { role: 'assistant', model: 'claude', content: [{ type: 'text', text }] },
    timestamp: '2025-01-01T00:00:00.000Z',
});

function shape(envelopes: SessionEnvelope[]) {
    return envelopes.map((envelope) => (envelope.ev as { t: string }).t);
}

function requestIds(envelopes: SessionEnvelope[]) {
    return envelopes
        .map((envelope) => (envelope.ev as { requestId?: string }).requestId)
        .filter((id): id is string => typeof id === 'string');
}

/** All stimuli use the SDK stream or an actual queued-command JSONL file. */
function proofHarness() {
    const h = harness(true);
    const converter = new SDKToLogConverter({ sessionId: 'sdk-session', cwd: '/workspace', gitBranch: 'main' });
    const sdk = (message: Parameters<typeof converter.convert>[0]) => h.queue.enqueue(converter.convert(message));
    const started = (run: string, task = 'job') => sdk({ type: 'system', subtype: 'task_started', task_id: task, run_id: run,
        tool_use_id: 'launch-original', description: 'Running', session_id: 'sdk-session', uuid: '00000000-0000-4000-8000-000000000016' });
    const receipt = (task?: string, tool?: string, status?: string, run?: string) => sdk({ type: 'system', subtype: 'task_notification',
        ...(task ? { task_id: task } : {}), ...(tool ? { tool_use_id: tool } : {}), ...(status ? { status } : {}),
        ...(run ? { run_id: run } : {}), session_id: 'sdk-session', uuid: '00000000-0000-4000-8000-000000000006', output_file: '/tmp/output', summary: 'Done',
    } as Parameters<typeof converter.convert>[0]);
    const finish = async (text: string) => {
        h.queue.enqueue(assistant(text)); h.queue.enqueue(finalAnswerItem(text)); h.queue.enqueue(turnEndItem('completed'));
        await h.queue.flush();
        return h.envelopes.find(e => e.ev.t === 'final-answer' && e.ev.text === text)!.ev;
    };
    const launch = async (channel: string, run?: string, end = true, task = 'job') => {
        h.queue.enqueue(pendingRequestItem(channel, { inputs: [{ kind: 'channel', channelRequestId: channel }], inputCount: 1 }));
        sdk({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [
            { type: 'tool_use', id: 'launch-original', name: 'Bash', input: { command: 'sleep 10', run_in_background: true } },
        ] } } as Parameters<typeof converter.convert>[0]);
        if (run) started(run, task);
        sdk({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'launch-original', content: `Command running in background with ID: ${task}.` },
        ] } });
        if (end) h.queue.enqueue(turnEndItem('completed'));
        await h.queue.flush();
    };
    const resume = async () => {
        await launch('channel-A', 'run-1', false);
        receipt('job', 'launch-original', 'completed', 'run-1'); await h.queue.flush();
        started('run-2'); h.queue.enqueue(turnEndItem('completed')); await h.queue.flush();
    };
    const overflow = async (count = 1005) => {
        // Batched draining still processes every real receipt and follow-up turn in order.
        for (let i = 0; i < count; i++) {
            receipt(`other-${i}`, undefined, 'completed', `other-run-${i}`);
            h.queue.enqueue(assistant(`other-${i}`)); h.queue.enqueue(turnEndItem('completed'));
        }
        await h.queue.flush();
        expect(h.state.backgroundCompletions?.historyLost).toBe(true);
    };
    let workingDirectory: string | undefined;
    let scanner: Awaited<ReturnType<typeof createSessionScanner>> | undefined;
    let scanned = 0;
    let serial = 0;
    const deliver = async (source: string, task?: string, tool?: string, status?: string, run?: string) => {
        if (source === 'sdk') { receipt(task, tool, status, run); await h.queue.flush(); return; }
        if (!workingDirectory) {
            workingDirectory = await mkdtemp(join(tmpdir(), 't2rt-proof-'));
            scanner = await createSessionScanner({ sessionId: null, workingDirectory,
                onMessage: message => {
                    if (message.type !== 'user' || message.isSidechain) return;
                    const content = message.message.content;
                    if (typeof content !== 'string' || !content.trim()) return;
                    h.sendScannerMessage(message); scanned++;
                } });
            await mkdir(getProjectPath(workingDirectory), { recursive: true });
        }
        const id = ++serial;
        const sessionId = `11111111-2222-4333-8444-${String(id).padStart(12, '0')}`;
        const prompt = `<task-notification>${task ? `<task-id>${task}</task-id>` : ''}${tool ? `<tool-use-id>${tool}</tool-use-id>` : ''}`
            + `${status ? `<status>${status}</status>` : ''}<summary>Receipt</summary></task-notification>`;
        const before = scanned;
        await writeFile(join(getProjectPath(workingDirectory), `${sessionId}.jsonl`), JSON.stringify({ type: 'attachment', uuid: `receipt-${id}`,
            attachment: { type: 'queued_command', commandMode: 'task-notification', prompt,
                ...(run ? { origin: { kind: 'task-notification', runId: run } } : {}) } }) + '\n');
        await scanner!.onNewSession(sessionId);
        await vi.waitFor(() => expect(scanned).toBe(before + 1));
    };
    const destroy = async () => {
        await scanner?.cleanup(); h.queue.destroy();
        if (workingDirectory) {
            await rm(getProjectPath(workingDirectory), { recursive: true, force: true });
            await rm(workingDirectory, { recursive: true, force: true });
        }
    };
    return { h, sdk, started, receipt, finish, launch, resume, overflow, deliver, destroy };
}

describe('default-deny background routing proof', () => {
    it.each(['sdk', 'scanner'].flatMap(source => [false, true].map(lost => ({ source, lost }))))(
        'T2RT-13 blocks an old start replay after history loss ($source, lost=$lost)', async ({ source, lost }) => {
            const d = proofHarness();
            const debug = vi.spyOn(logger, 'debug');
            try {
                await d.launch('channel-A', 'run-1', true, 'old-job');
                await d.deliver(source, 'old-job', 'launch-original', 'completed', 'run-1');
                expect(await d.finish('original A')).toMatchObject({ requestId: 'channel-A' });
                if (lost) await d.overflow();
                else expect(d.h.state.backgroundCompletions?.historyLost).toBe(false);
                await d.launch('channel-B', 'run-2', false, 'current-job');
                const retained = [...d.h.state.backgroundTaskLaunches!.values()];
                d.started('run-1', 'old-job'); await d.h.queue.flush();
                if (lost) expect.soft([...d.h.state.backgroundTaskLaunches!.values()]).toEqual(retained);
                d.h.queue.enqueue(turnEndItem('completed')); await d.h.queue.flush();
                await d.deliver(source, 'old-job', 'launch-original', 'completed', 'run-1');
                expect.soft(await d.finish('old run stale answer')).not.toHaveProperty('requestId');
                if (lost) {
                    expect.soft([...d.h.state.backgroundTaskLaunches!.values()]).toEqual(retained);
                    expect.soft(d.h.rearm).toHaveBeenLastCalledWith([], ['background-request-unrouted']);
                    expect.soft(debug).toHaveBeenCalledWith('[claude] Background completion not routed',
                        expect.objectContaining({ reason: 'history-lost' }));
                }
                await d.deliver(source, 'current-job', 'launch-original', 'completed', 'run-2');
                const current = await d.finish('actual current B');
                if (lost) {
                    expect.soft(current).not.toHaveProperty('requestId');
                    expect.soft(current).toMatchObject({ inputEvidence: { coverage: 'incomplete',
                        incompleteReasons: expect.arrayContaining(['background-request-unrouted']) } });
                    expect.soft([...d.h.state.backgroundTaskLaunches!.values()]).toEqual(retained);
                } else expect.soft(current).toMatchObject({ requestId: 'channel-B' });
            } finally { debug.mockRestore(); await d.destroy(); }
        }, 15000,
    );

    it.each(['sdk', 'scanner'])('stops every shape at the first completion eviction through %s', async source => {
        const d = proofHarness();
        try {
            // 999 unrelated terminal identities plus this started run fill the 1000 slots.
            for (let i = 0; i < 999; i++) {
                d.receipt(`before-${i}`, undefined, 'completed', `run-${i}`);
                d.h.queue.enqueue(assistant(`before-${i}`)); d.h.queue.enqueue(turnEndItem('completed'));
            }
            await d.h.queue.flush();
            await d.launch('channel-A', 'run-current');
            expect.soft(d.h.state.backgroundCompletions?.entries.size).toBe(1000);
            expect.soft(d.h.state.backgroundCompletions?.historyLost).toBe(false);
            await d.deliver(source, 'job', 'launch-original', 'completed', 'run-current');
            expect.soft(await d.finish('last route before loss')).toMatchObject({ requestId: 'channel-A' });
            // Opening a new identity triggers the very first eviction in task_started.
            await d.launch('channel-B', 'run-next', true, 'new-job');
            expect(d.h.state.backgroundCompletions?.historyLost).toBe(true);
            const retained = [...d.h.state.backgroundTaskLaunches!.values()];
            for (const [i, status] of ['completed', undefined, 'done', 'running'].entries()) {
                for (const [j, identity] of ['run', 'task', 'tool', 'task+tool', 'none'].entries()) {
                    await d.deliver(source, identity === 'tool' || identity === 'none' ? undefined : 'new-job',
                        identity === 'tool' || identity === 'task+tool' ? 'launch-original' : undefined,
                        status, identity === 'run' ? 'run-next' : undefined);
                    const result = await d.finish(`after loss ${i}/${j}`);
                    expect(result).not.toHaveProperty('requestId');
                    expect(result).toMatchObject({ inputEvidence: { coverage: 'incomplete',
                        incompleteReasons: expect.arrayContaining(['background-request-unrouted']) } });
                    expect([...d.h.state.backgroundTaskLaunches!.values()]).toEqual(retained);
                    expect(d.h.rearm).toHaveBeenLastCalledWith([], ['background-request-unrouted']);
                }
            }
        } finally { await d.destroy(); }
    }, 15000);

    it.each(['sdk', 'scanner'])('refuses the completion that first evicts history through %s', async source => {
        const d = proofHarness();
        try {
            for (let i = 0; i < 1000; i++) {
                d.receipt(`full-${i}`, undefined, 'completed', `run-${i}`);
                d.h.queue.enqueue(assistant(`full-${i}`)); d.h.queue.enqueue(turnEndItem('completed'));
            }
            await d.h.queue.flush();
            await d.launch('channel-A');
            expect(d.h.state.backgroundCompletions?.historyLost).toBe(false);
            const retained = [...d.h.state.backgroundTaskLaunches!.values()];
            await d.deliver(source, 'job', 'launch-original', 'completed');
            expect(d.h.state.backgroundCompletions?.historyLost).toBe(true);
            expect(await d.finish('first evicting completion')).not.toHaveProperty('requestId');
            expect([...d.h.state.backgroundTaskLaunches!.values()]).toEqual(retained);
            expect(d.h.rearm).toHaveBeenLastCalledWith([], ['background-request-unrouted']);
        } finally { await d.destroy(); }
    }, 15000);

    it.each(['sdk', 'scanner'])('latches launch-only eviction without losing a completion record through %s', async source => {
        const d = proofHarness();
        try {
            // No task_started or completion events: only launch mappings can overflow here.
            for (let i = 0; i < 1000; i++) await d.launch('channel-A', undefined, true, `launch-job-${i}`);
            expect(d.h.state.backgroundCompletions?.entries.size).toBe(0);
            expect(d.h.state.backgroundCompletions?.historyLost).toBe(false);
            expect(d.h.state.backgroundTaskLaunches?.size).toBe(1000);
            await d.launch('channel-A', undefined, true, 'launch-job-1000');
            expect(d.h.state.backgroundCompletions?.historyLost).toBe(true);
            expect(d.h.state.backgroundTaskLaunches?.size).toBe(1000);
            const retained = [...d.h.state.backgroundTaskLaunches!.values()];
            d.started('run-new', 'launch-job-1000'); await d.h.queue.flush();
            await d.deliver(source, 'launch-job-1000', 'launch-original', 'completed', 'run-new');
            expect(await d.finish('after launch eviction')).not.toHaveProperty('requestId');
            expect([...d.h.state.backgroundTaskLaunches!.values()]).toEqual(retained);
            expect(d.h.rearm).toHaveBeenLastCalledWith([], ['background-request-unrouted']);
        } finally { await d.destroy(); }
    }, 30000);

    it.each(['sdk', 'scanner'])('keeps explicit run identity scoped to its task through %s', async source => {
        const d = proofHarness();
        try {
            await d.launch('channel-A', 'run-shared');
            await d.deliver(source, 'job', 'launch-original', 'completed', 'run-shared');
            expect(await d.finish('original task')).toMatchObject({ requestId: 'channel-A' });
            await d.launch('channel-B', 'run-shared', true, 'other-job');
            const retained = [...d.h.state.backgroundTaskLaunches!.values()];
            // Run IDs have a per-task contract. A recycled tool plus the same run string
            // cannot identify which task produced this old receipt.
            await d.deliver(source, undefined, 'launch-original', 'completed', 'run-shared');
            expect.soft(await d.finish('aliased old task')).not.toHaveProperty('requestId');
            expect.soft([...d.h.state.backgroundTaskLaunches!.values()]).toEqual(retained);
            await d.deliver(source, 'other-job', 'launch-original', 'completed', 'run-shared');
            expect.soft(await d.finish('exact current task')).toMatchObject({ requestId: 'channel-B' });
        } finally { await d.destroy(); }
    });

    it.each(['sdk', 'scanner'].flatMap(source => ['new-turn', 'partial-start'].map(kind => ({ source, kind }))))(
        'does not infer uniqueness across $kind reuse through $source', async ({ source, kind }) => {
            const d = proofHarness();
            try {
                await d.launch('channel-A', undefined, kind === 'new-turn');
                if (kind === 'new-turn') await d.launch('channel-B');
                else {
                    d.sdk({ type: 'system', subtype: 'task_started', task_id: 'job', tool_use_id: 'launch-original',
                        description: 'Legacy start', session_id: 'sdk-session', uuid: '00000000-0000-4000-8000-000000000026' });
                    d.started('run-2'); d.h.queue.enqueue(turnEndItem('completed')); await d.h.queue.flush();
                }
                const retained = [...d.h.state.backgroundTaskLaunches!.values()];
                await d.deliver(source, 'job', 'launch-original', 'completed');
                expect.soft(await d.finish('late unqualified receipt')).not.toHaveProperty('requestId');
                expect.soft([...d.h.state.backgroundTaskLaunches!.values()]).toEqual(retained);
                d.started('run-2'); await d.h.queue.flush();
                await d.deliver(source, 'job', 'launch-original', 'completed', 'run-2');
                expect.soft(await d.finish('exact new generation')).toMatchObject({ requestId: kind === 'new-turn' ? 'channel-B' : 'channel-A' });
            } finally { await d.destroy(); }
        },
    );

    it.each(['missing', 'done', 'running', 'tool-alias'])(
        'T2RT-11/12 preserves the launch after refusal then a real scanner $0 receipt', async status => {
            const d = proofHarness();
            try {
                await d.resume();
                if (status !== 'tool-alias') await d.overflow();
                else expect(d.h.state.backgroundCompletions?.historyLost).toBe(false);
                await d.deliver('scanner', 'job', 'launch-original', 'completed');
                expect(await d.finish('first refused')).not.toHaveProperty('requestId');
                const retained = [...d.h.state.backgroundTaskLaunches!.values()];
                await d.deliver('scanner', status === 'tool-alias' ? undefined : 'job', 'launch-original',
                    status === 'missing' ? undefined : status === 'tool-alias' ? 'completed' : status);
                expect.soft(await d.finish('stale scanner answer')).not.toHaveProperty('requestId');
                expect.soft([...d.h.state.backgroundTaskLaunches!.values()]).toEqual(retained);
                expect.soft(d.h.rearm).toHaveBeenLastCalledWith([], ['background-request-unrouted']);
                await d.deliver('sdk', 'job', 'launch-original', 'completed', 'run-2');
                const current = await d.finish('real current answer');
                if (status === 'tool-alias') expect.soft(current).toMatchObject({ requestId: 'channel-A' });
                else {
                    expect.soft(current).not.toHaveProperty('requestId');
                    expect.soft([...d.h.state.backgroundTaskLaunches!.values()]).toEqual(retained);
                }
            } finally { await d.destroy(); }
        },
    );

    const matrix = ['sdk', 'scanner'].flatMap(source => ['terminal', 'missing', 'unknown', 'nonterminal'].flatMap(status =>
        ['run', 'task', 'tool', 'task+tool', 'alias-switch', 'none'].flatMap(identity =>
            ['intact', 'lost'].flatMap(history => ['fresh', 'resumed-run'].map(prior => ({ source, status, identity, history, prior }))))));
    it.each(matrix)('proof matrix $source/$status/$identity/$history/$prior', async ({ source, status, identity, history, prior }) => {
        const d = proofHarness();
        const task = ['run', 'task', 'task+tool'].includes(identity) ? 'job' : undefined;
        const tool = ['tool', 'task+tool', 'alias-switch'].includes(identity) ? 'launch-original' : undefined;
        const terminal = status === 'terminal' ? 'completed' : status === 'unknown' ? 'done' : status === 'nonterminal' ? 'running' : undefined;
        const run = identity === 'run' ? 'run-2' : undefined;
        const permitted = history === 'intact' && status === 'terminal' && (identity === 'run'
            || (prior === 'fresh' && ['task', 'tool', 'task+tool'].includes(identity)));
        try {
            if (prior === 'resumed-run') await d.resume();
            else await d.launch('channel-A', identity === 'run' ? 'run-2' : undefined);
            if (history === 'lost') await d.overflow();
            if (identity === 'alias-switch') {
                // A refused observation under the task namespace must stay ambiguous when
                // the next row names only the tool, even without a resume or eviction.
                await d.deliver(source, 'job', 'launch-original');
                expect(await d.finish('refused alias seed')).not.toHaveProperty('requestId');
            }
            const retained = [...d.h.state.backgroundTaskLaunches!.values()];
            await d.deliver(source, task, tool, terminal, run);
            const candidate = await d.finish('candidate');
            if (permitted) expect(candidate).toMatchObject({ requestId: 'channel-A' });
            else {
                expect(candidate).not.toHaveProperty('requestId');
                expect(candidate).toMatchObject({ inputEvidence: { coverage: 'incomplete',
                    incompleteReasons: expect.arrayContaining(['background-request-unrouted']) } });
                expect([...d.h.state.backgroundTaskLaunches!.values()]).toEqual(retained);
                expect(d.h.rearm).toHaveBeenLastCalledWith([], ['background-request-unrouted']);
                d.started('run-2'); await d.h.queue.flush();
                await d.deliver(source, 'job', 'launch-original', 'completed', 'run-2');
                const current = await d.finish('recovered A');
                if (history === 'intact') expect(current).toMatchObject({ requestId: 'channel-A' });
                else {
                    expect(current).not.toHaveProperty('requestId');
                    expect([...d.h.state.backgroundTaskLaunches!.values()]).toEqual(retained);
                }
            }
            // After loss even a genuinely new launch cannot restore channel routing.
            // Intact cells still replay old shapes against a newer live launch.
            await d.launch('channel-B', 'run-3');
            const newer = [...d.h.state.backgroundTaskLaunches!.values()];
            await d.deliver(source, task, tool, terminal, identity === 'run' ? 'run-0' : undefined);
            const stale = await d.finish('stale receipt');
            expect(stale).not.toHaveProperty('requestId');
            expect(stale).toMatchObject({ inputEvidence: { coverage: 'incomplete',
                incompleteReasons: expect.arrayContaining(['background-request-unrouted']) } });
            expect([...d.h.state.backgroundTaskLaunches!.values()]).toEqual(newer);
            expect(d.h.rearm).toHaveBeenLastCalledWith([], ['background-request-unrouted']);
            await d.deliver(source, 'job', 'launch-original', 'completed', 'run-3');
            const current = await d.finish('real B');
            if (history === 'intact') expect(current).toMatchObject({ requestId: 'channel-B' });
            else {
                expect(current).not.toHaveProperty('requestId');
                expect([...d.h.state.backgroundTaskLaunches!.values()]).toEqual(newer);
            }
        } finally { await d.destroy(); }
    }, 15000);

    it.each([
        { source: 'sdk', task: 'job', tool: 'launch-original' },
        { source: 'scanner', task: 'job', tool: 'launch-original' },
        { source: 'scanner', task: 'job', tool: undefined },
        { source: 'scanner', task: undefined, tool: 'launch-original' },
    ])('keeps a genuinely first terminal legacy control ($source/$task/$tool)', async ({ source, task, tool }) => {
        const d = proofHarness();
        try {
            await d.launch('channel-A');
            const root = d.h.evidence.snapshot()!.rootBatchId;
            await d.deliver(source, task, tool, 'completed');
            expect(await d.finish('first legacy answer')).toMatchObject({ requestId: 'channel-A',
                inputEvidence: { rootBatchId: root, coverage: 'complete' } });
        } finally { await d.destroy(); }
    });
});

describe('channel turn ordering through the launcher dispatcher', () => {
    it.each([false, true].flatMap(evicted => ['active', 'pending', 'idle'].map(phase => ({ evicted, phase }))))(
        'T2RT-02/03 delivers SDK notification before B ends (evicted=$evicted, phase=$phase)', async ({ evicted, phase }) => {
            const h = harness(true);
            const converter = new SDKToLogConverter({ sessionId: 'sdk-session', cwd: '/workspace', gitBranch: 'main' });
            const sdk = (message: Parameters<typeof converter.convert>[0], delay?: number) => {
                const log = converter.convert(message);
                expect(log).not.toBeNull(); h.queue.enqueue(log, { delay });
            };
            const batch = (id: string) => pendingRequestItem(null, {
                inputs: [{ kind: 'rest', serverMessageId: id, serverSeq: 1 }], inputCount: 1,
            });
            const text = (value: string) => ({ type: 'assistant' as const, parent_tool_use_id: null,
                message: { role: 'assistant', content: [{ type: 'text', text: value }] } } as Parameters<typeof converter.convert>[0]);
            try {
                h.queue.enqueue(batch('A'));
                sdk({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [
                    { type: 'tool_use', id: 'launch', name: 'Bash', input: { command: 'sleep 10', run_in_background: true } },
                ] } } as Parameters<typeof converter.convert>[0], 250);
                sdk({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [
                    { type: 'tool_result', tool_use_id: 'launch', content: 'Command running in background with ID: long-job.' },
                ] } });
                h.queue.enqueue(turnEndItem('completed')); await h.queue.flush();
                const original = h.evidence.snapshot()!;
                if (evicted) {
                    for (let i = 0; i < 128; i++) {
                        h.queue.enqueue(batch(`other-${i}`)); sdk(text(`other-${i}`)); h.queue.enqueue(turnEndItem('completed'));
                    }
                    await h.queue.flush(); expect(h.evidence.snapshot(original.turnId)).toBeNull();
                }
                if (phase !== 'idle') h.queue.enqueue(batch('B'));
                if (phase === 'active') sdk(text('B begins'), 250);
                sdk({ type: 'system', subtype: 'task_notification', task_id: 'long-job', tool_use_id: 'launch',
                    status: 'completed', session_id: 'sdk-session', uuid: '00000000-0000-4000-8000-000000000001',
                    output_file: '/tmp/long-job.output', summary: 'Background task completed' });
                // Unrelated system messages must remain filtered.
                sdk({ type: 'system', subtype: 'init', session_id: 'sdk-session' } as Parameters<typeof converter.convert>[0]);
                if (phase === 'idle') h.queue.enqueue(batch('B'));
                sdk(text('B finishes')); h.queue.enqueue(finalAnswerItem('B finishes')); h.queue.enqueue(turnEndItem('completed'));
                await h.queue.flush(); // The scanner has not run; B's durable terminal must already be safe.
                const terminal = h.envelopes.filter(envelope => envelope.ev.t === 'turn-end').at(-1)!;
                expect(terminal.ev).toMatchObject({ inputEvidence: { inputs: [{ kind: 'rest', serverMessageId: 'B', serverSeq: 1 }],
                    terminal: true, coverage: 'incomplete', incompleteReasons: expect.arrayContaining([
                        evicted ? 'background-source-unavailable' : 'background-co-consumption',
                    ]) } });
                expect(h.rearm).toHaveBeenCalledOnce();
                const receiptIndex = h.envelopes.findIndex(envelope => envelope.id.startsWith('task-notification:long-job:receipt'));
                expect(receiptIndex).toBeGreaterThan(-1);
                expect(receiptIndex).toBeLessThan(h.envelopes.indexOf(terminal));
            } finally { h.queue.destroy(); }
        },
    );

    it.each([
        { sdkRunId: undefined, scannerRunId: undefined },
        { sdkRunId: 'run-1', scannerRunId: 'run-1' },
        { sdkRunId: 'run-1', scannerRunId: undefined },
        { sdkRunId: undefined, scannerRunId: 'run-1' },
    ].flatMap(identity => ['follow-up', 'idle', 'unrelated'].flatMap(phase =>
        ['sdk', 'scanner'].map(first => ({ ...identity, phase, first })))))(
        'T2RT-07 preserves correlation and only deduplicates proven identities (sdk=$sdkRunId, scanner=$scannerRunId, late=$phase, first=$first)',
        async ({ sdkRunId, scannerRunId, phase, first }) => {
            const h = harness(true);
            const converter = new SDKToLogConverter({ sessionId: 'sdk-session', cwd: '/workspace', gitBranch: 'main' });
            const sdk = (message: Parameters<typeof converter.convert>[0]) => {
                const log = converter.convert(message);
                expect(log).not.toBeNull(); h.queue.enqueue(log);
            };
            const text = (value: string) => sdk({ type: 'assistant', parent_tool_use_id: null,
                message: { role: 'assistant', content: [{ type: 'text', text: value }] } } as Parameters<typeof converter.convert>[0]);
            const batch = (id: string) => pendingRequestItem(`channel-${id}`, {
                inputs: [{ kind: 'channel', channelRequestId: `channel-${id}` }], inputCount: 1,
            });
            const finish = (value: string) => {
                text(value); h.queue.enqueue(finalAnswerItem(value)); h.queue.enqueue(turnEndItem('completed'));
            };
            const details = '<task-notification><task-id>long-job</task-id><tool-use-id>launch</tool-use-id>'
                + '<status>completed</status><summary>Full scanner result</summary></task-notification>';
            // runClaude's scanner sends directly to the session mapper, independently of the SDK queue.
            const scanner = () => h.sendScannerMessage({ type: 'user', uuid: 'scanner-detail',
                origin: { kind: 'task-notification', producer: 'session-task', ...(scannerRunId ? { runId: scannerRunId } : {}) },
                message: { role: 'user', content: details } });
            try {
                h.queue.enqueue(batch('A'));
                sdk({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [
                    { type: 'tool_use', id: 'launch', name: 'Bash', input: { command: 'sleep 10', run_in_background: true } },
                ] } } as Parameters<typeof converter.convert>[0]);
                sdk({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [
                    { type: 'tool_result', tool_use_id: 'launch', content: 'Command running in background with ID: long-job.' },
                ] } });
                h.queue.enqueue(turnEndItem('completed')); await h.queue.flush();
                const original = h.evidence.snapshot()!;
                const receipt = (runId = sdkRunId) => sdk({ type: 'system', subtype: 'task_notification',
                    task_id: 'long-job', tool_use_id: 'launch', status: 'completed',
                    ...(runId ? { run_id: runId } : {}), session_id: 'sdk-session',
                    uuid: '00000000-0000-4000-8000-000000000007', output_file: '/tmp/long-job.output', summary: 'Done' });
                const duplicate = first === 'sdk' ? scanner : () => receipt();
                if (first === 'sdk') receipt(); else scanner();
                text('F begins'); await h.queue.flush();
                const followUp = h.state.currentTurnId!;
                expect(h.envelopes.find(e => e.turn === followUp && e.ev.t === 'turn-start')?.ev)
                    .toMatchObject({ requestId: 'channel-A' });
                if (phase === 'follow-up') duplicate();
                finish('F actual final'); await h.queue.flush();
                if (phase === 'idle') duplicate();
                h.queue.enqueue(batch('B')); text('B begins'); await h.queue.flush();
                if (phase === 'unrelated') duplicate();
                finish('B actual final'); await h.queue.flush();

                // Missing run identity is now intentionally conservative (T2RT-08): it cannot
                // prove a duplicate, but must not close the active turn or lose its request ID.
                const ambiguous = !sdkRunId || !scannerRunId;
                const fIncomplete = ambiguous && phase === 'follow-up';
                const bIncomplete = ambiguous && phase !== 'follow-up';
                const reasons = (incomplete: boolean) => incomplete ? expect.arrayContaining(['background-source-unavailable']) : [];
                const finalF = h.envelopes.find(e => e.ev.t === 'final-answer' && e.ev.text === 'F actual final')!;
                expect.soft(finalF).toMatchObject({ turn: followUp, ev: { requestId: 'channel-A',
                    inputEvidence: { rootBatchId: original.rootBatchId, coverage: fIncomplete ? 'incomplete' : 'complete', incompleteReasons: reasons(fIncomplete) } } });
                expect.soft(h.envelopes.filter(e => e.turn === followUp && e.ev.t === 'turn-end')).toHaveLength(1);
                expect.soft(h.evidence.snapshot(followUp)).toMatchObject({ rootBatchId: original.rootBatchId,
                    coverage: fIncomplete ? 'incomplete' : 'complete', incompleteReasons: reasons(fIncomplete), terminal: true });
                const finalB = h.envelopes.find(e => e.ev.t === 'final-answer' && e.ev.text === 'B actual final')!;
                expect.soft(finalB.ev).toMatchObject({ requestId: 'channel-B' });
                const evidenceB = h.evidence.snapshot(finalB.turn)!;
                expect.soft(evidenceB).toMatchObject({ coverage: bIncomplete ? 'incomplete' : 'complete', incompleteReasons: reasons(bIncomplete),
                    inputs: [{ kind: 'channel', channelRequestId: 'channel-B' }], terminal: true });
                expect.soft(evidenceB.rootBatchId).not.toBe(original.rootBatchId);
                expect.soft(h.rearm).toHaveBeenCalledTimes(ambiguous ? 2 : 1);
                expect.soft(h.envelopes).toContainEqual(expect.objectContaining({ id: 'task-notification:long-job',
                    ev: { t: 'text', text: details } }));
                expect.soft(h.envelopes).toContainEqual(expect.objectContaining({ id: 'task-notification:long-job:receipt:completed' }));
                // A resumed run is new input, including after both old receipts lacked run IDs.
                receipt('run-2'); text('Resumed task'); await h.queue.flush();
                expect(h.rearm).toHaveBeenCalledTimes(ambiguous ? 3 : 2);
                expect(h.evidence.snapshot()).toMatchObject({ coverage: 'incomplete',
                    incompleteReasons: expect.arrayContaining(['background-source-unavailable']) });
            } finally { h.queue.destroy(); }
        },
    );

    it.each(['origin', 'attachment'])('keeps a real promoted scanner duplicate harmless using %s run identity', async location => {
        const h = harness(true);
        const workingDirectory = await mkdtemp(join(tmpdir(), 't2rt-completion-'));
        const projectDir = getProjectPath(workingDirectory);
        let scanner: Awaited<ReturnType<typeof createSessionScanner>> | undefined;
        let scanned = 0;
        try {
            const converter = new SDKToLogConverter({ sessionId: 'sdk-session', cwd: workingDirectory, gitBranch: 'main' });
            h.queue.enqueue(converter.convert({ type: 'system', subtype: 'task_notification', task_id: 'job', run_id: 'run-1',
                status: 'completed', session_id: 'sdk-session', uuid: '00000000-0000-4000-8000-000000000028',
                output_file: '/tmp/job.output', summary: 'Done' }));
            h.queue.enqueue(assistant('F')); h.queue.enqueue(turnEndItem('completed')); await h.queue.flush();
            h.queue.enqueue(pendingRequestItem('channel-B', { inputs: [{ kind: 'channel', channelRequestId: 'channel-B' }], inputCount: 1 }));
            h.queue.enqueue(assistant('B begins')); await h.queue.flush();
            scanner = await createSessionScanner({ sessionId: null, workingDirectory,
                onMessage: message => { h.sendScannerMessage(message); scanned++; } });
            await mkdir(projectDir, { recursive: true });
            const sessionId = '11111111-2222-4333-8444-999999999999';
            await writeFile(join(projectDir, `${sessionId}.jsonl`), JSON.stringify({ type: 'attachment', uuid: 'late-details',
                attachment: { type: 'queued_command', commandMode: 'task-notification',
                    ...(location === 'origin' ? { origin: { kind: 'task-notification', runId: 'run-1' } } : { runId: 'run-1' }),
                    prompt: '<task-notification><task-id>job</task-id><status>completed</status><summary>Full result</summary></task-notification>' },
            }) + '\n');
            scanner.onNewSession(sessionId);
            await vi.waitFor(() => expect(scanned).toBe(1));
            h.queue.enqueue(finalAnswerItem('B final')); h.queue.enqueue(turnEndItem('completed')); await h.queue.flush();
            expect(h.rearm).toHaveBeenCalledOnce();
            expect(h.envelopes.find(e => e.ev.t === 'final-answer' && e.ev.text === 'B final')?.ev)
                .toMatchObject({ requestId: 'channel-B', inputEvidence: { coverage: 'complete' } });
            expect(h.evidence.snapshot()).toMatchObject({ coverage: 'complete', terminal: true });
        } finally {
            await scanner?.cleanup(); h.queue.destroy();
            await rm(workingDirectory, { recursive: true, force: true });
            await rm(projectDir, { recursive: true, force: true });
        }
    });

    it.each(['sdk', 'scanner'].flatMap(first => [false, true].map(started => ({ first, started }))))(
        'T2RT-08 consumes a resumed run after only $first reported the legacy completion (started=$started)',
        async ({ first, started }) => {
            const h = harness(true);
            const converter = new SDKToLogConverter({ sessionId: 'sdk-session', cwd: '/workspace', gitBranch: 'main' });
            const sdk = (message: Parameters<typeof converter.convert>[0]) => h.queue.enqueue(converter.convert(message));
            const batch = (id: string) => h.queue.enqueue(pendingRequestItem(`channel-${id}`, {
                inputs: [{ kind: 'channel', channelRequestId: `channel-${id}` }], inputCount: 1,
            }));
            const finish = (value: string) => {
                h.queue.enqueue(assistant(value)); h.queue.enqueue(finalAnswerItem(value)); h.queue.enqueue(turnEndItem('completed'));
            };
            const completion = (source: string, runId?: string) => {
                if (source === 'sdk') sdk({ type: 'system', subtype: 'task_notification', task_id: 'job', tool_use_id: 'launch',
                    status: 'completed', ...(runId ? { run_id: runId } : {}), session_id: 'sdk-session',
                    uuid: '00000000-0000-4000-8000-000000000008', output_file: '/tmp/job.output', summary: 'Done' });
                else h.sendScannerMessage({ type: 'user', uuid: `scanner-${runId ?? 'legacy'}`,
                    origin: { kind: 'task-notification', ...(runId ? { runId } : {}) }, message: { role: 'user',
                        content: '<task-notification><task-id>job</task-id><tool-use-id>launch</tool-use-id><status>completed</status></task-notification>' } });
            };
            try {
                batch('A');
                sdk({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [
                    { type: 'tool_use', id: 'launch', name: 'Bash', input: { command: 'sleep 10', run_in_background: true } },
                ] } } as Parameters<typeof converter.convert>[0]);
                sdk({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [
                    { type: 'tool_result', tool_use_id: 'launch', content: 'Command running in background with ID: job.' },
                ] } });
                h.queue.enqueue(turnEndItem('completed')); await h.queue.flush();
                const original = h.evidence.snapshot()!;
                completion(first); finish('F'); await h.queue.flush();
                expect(h.evidence.snapshot()).toMatchObject({ rootBatchId: original.rootBatchId, coverage: 'complete', terminal: true });
                expect(h.envelopes.find(e => e.ev.t === 'final-answer' && e.ev.text === 'F')?.ev).toMatchObject({ requestId: 'channel-A' });
                batch('B'); h.queue.enqueue(assistant('B begins')); await h.queue.flush();
                if (started) {
                    sdk({ type: 'system', subtype: 'task_started', task_id: 'job', run_id: 'run-2', tool_use_id: 'resume',
                        description: 'Resumed job', session_id: 'sdk-session', uuid: '00000000-0000-4000-8000-000000000018' });
                    await h.queue.flush();
                    expect([...h.state.backgroundCompletions!.entries.values()].some(record => record.phase === 'started')).toBe(true);
                }
                completion(first === 'sdk' ? 'scanner' : 'sdk', 'run-2'); finish('B final'); await h.queue.flush();
                expect.soft(h.rearm).toHaveBeenCalledTimes(2);
                expect.soft(h.envelopes.find(e => e.ev.t === 'final-answer' && e.ev.text === 'B final')?.ev)
                    .toMatchObject({ requestId: 'channel-B', inputEvidence: { coverage: 'incomplete' } });
                expect.soft(h.evidence.snapshot()).toMatchObject({ coverage: 'incomplete', terminal: true });
            } finally { h.queue.destroy(); }
        },
    );

    it.each(['tasks', 'runs'].flatMap(kind => [false, true].map(idle => ({ kind, idle }))))(
        'T2RT-09 bounds 1005 completed $kind at 1000 and handles an evicted scanner identity (idle=$idle)', async ({ kind, idle }) => {
        const h = harness(true);
        const converter = new SDKToLogConverter({ sessionId: 'sdk-session', cwd: '/workspace', gitBranch: 'main' });
        try {
            for (let i = 0; i < 1005; i++) {
                h.queue.enqueue(converter.convert({ type: 'system', subtype: 'task_notification',
                    task_id: kind === 'tasks' ? `job-${i}` : 'job', run_id: `run-${i}`, status: 'completed',
                    session_id: 'sdk-session', uuid: '00000000-0000-4000-8000-000000000009', output_file: '/tmp/job.output', summary: 'Done' }));
                h.queue.enqueue(assistant(`follow-up-${i}`)); h.queue.enqueue(turnEndItem('completed'));
                await h.queue.flush();
            }
            const ledger = h.state.backgroundCompletions!;
            expect.soft(ledger.entries.size).toBeLessThanOrEqual(1000);
            expect.soft(ledger.aliases.size).toBeLessThanOrEqual(2000);
            expect.soft(ledger.historyLost).toBe(true);
            expect.soft([...ledger.entries.values()].every(receipt => receipt.phase === 'settled' && !receipt.turn)).toBe(true);
            h.queue.enqueue(pendingRequestItem('channel-B', { inputs: [{ kind: 'channel', channelRequestId: 'channel-B' }], inputCount: 1 }));
            h.queue.enqueue(assistant('B begins')); await h.queue.flush();
            const taskId = kind === 'tasks' ? 'job-0' : 'job';
            if (idle) {
                // A post-loss launch cannot restore background channel correlation.
                h.queue.enqueue(converter.convert({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [
                    { type: 'tool_use', id: 'resume', name: 'Bash', input: { command: 'sleep 10', run_in_background: true } },
                ] } } as Parameters<typeof converter.convert>[0]));
                h.queue.enqueue(converter.convert({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [
                    { type: 'tool_result', tool_use_id: 'resume', content: `Command running in background with ID: ${taskId}.` },
                ] } }));
                h.queue.enqueue(turnEndItem('completed')); await h.queue.flush();
            }
            h.sendScannerMessage({ type: 'user', uuid: 'late-evicted', origin: { kind: 'task-notification', runId: 'run-0' },
                message: { role: 'user', content: `<task-notification><task-id>${kind === 'tasks' ? 'job-0' : 'job'}</task-id><status>completed</status></task-notification>` } });
            h.queue.enqueue(assistant('after late scanner'));
            h.queue.enqueue(finalAnswerItem('B final')); h.queue.enqueue(turnEndItem('completed')); await h.queue.flush();
            const final = h.envelopes.find(e => e.ev.t === 'final-answer' && e.ev.text === 'B final')!.ev;
            expect.soft(final).toMatchObject({ inputEvidence: { coverage: 'incomplete' } });
            if (idle) expect.soft(final).not.toHaveProperty('requestId');
            else expect.soft(final).toMatchObject({ requestId: 'channel-B' });
            expect.soft(h.evidence.snapshot()).toMatchObject({ coverage: 'incomplete', terminal: true });
        } finally { h.queue.destroy(); }
    }, 15000);

    it.each(['sdk', 'scanner'])('T2RT-10 preserves a resumed launch after a run-ID-less old %s receipt', async source => {
        const h = harness(true);
        const converter = new SDKToLogConverter({ sessionId: 'sdk-session', cwd: '/workspace', gitBranch: 'main' });
        const sdk = (message: Parameters<typeof converter.convert>[0]) => h.queue.enqueue(converter.convert(message));
        const started = (run: string) => sdk({ type: 'system', subtype: 'task_started', task_id: 'job', run_id: run,
            tool_use_id: 'launch-original', description: 'Running job', session_id: 'sdk-session',
            uuid: '00000000-0000-4000-8000-000000000016' });
        const completion = (task: string, run?: string, tool?: string) => sdk({ type: 'system', subtype: 'task_notification',
            task_id: task, ...(run ? { run_id: run } : {}), ...(tool ? { tool_use_id: tool } : {}), status: 'completed',
            session_id: 'sdk-session', uuid: '00000000-0000-4000-8000-000000000006', output_file: '/tmp/job.output', summary: 'Done' });
        const finish = async (text: string) => {
            h.queue.enqueue(assistant(text)); h.queue.enqueue(finalAnswerItem(text));
            h.queue.enqueue(turnEndItem('completed')); await h.queue.flush();
            return h.envelopes.find(e => e.ev.t === 'final-answer' && e.ev.text === text)!.ev;
        };
        const debug = vi.spyOn(logger, 'debug');
        try {
            h.queue.enqueue(pendingRequestItem('channel-A', { inputs: [{ kind: 'channel', channelRequestId: 'channel-A' }], inputCount: 1 }));
            sdk({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [
                { type: 'tool_use', id: 'launch-original', name: 'Bash', input: { command: 'sleep 10', run_in_background: true } },
            ] } } as Parameters<typeof converter.convert>[0]);
            started('run-1');
            sdk({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [
                { type: 'tool_result', tool_use_id: 'launch-original', content: 'Command running in background with ID: job.' },
            ] } });
            completion('job', 'run-1', 'launch-original'); await h.queue.flush();
            // The spawning turn is still open: live tool membership binds the resumed run
            // to A, even though run-1's completion consumed the original launch record.
            started('run-2'); h.queue.enqueue(turnEndItem('completed')); await h.queue.flush();
            for (let i = 0; i < 1005; i++) {
                completion(`other-${i}`, `other-run-${i}`);
                await finish(`unrelated-${i}`);
            }
            expect(h.state.backgroundCompletions?.historyLost).toBe(true);
            const retained = [...h.state.backgroundTaskLaunches!.values()];
            expect(retained).toEqual([expect.objectContaining({ taskId: 'job', runId: 'run-2',
                toolUseId: 'launch-original', requestId: 'channel-A' })]);
            if (source === 'sdk') completion('job', undefined, 'launch-original');
            else h.sendScannerMessage({ type: 'user', uuid: 'late-runless', origin: { kind: 'task-notification' },
                message: { role: 'user', content: '<task-notification><task-id>job</task-id><tool-use-id>launch-original</tool-use-id><status>completed</status></task-notification>' } });
            const late = await finish('late run-1 answer');
            expect.soft(late).not.toHaveProperty('requestId');
            expect.soft(late).toMatchObject({ inputEvidence: { coverage: 'incomplete',
                incompleteReasons: expect.arrayContaining(['background-request-unrouted']) } });
            // Empty IDs report uncertainty without consuming a surviving source mapping.
            expect.soft(h.rearm).toHaveBeenLastCalledWith([], ['background-request-unrouted']);
            expect.soft([...h.state.backgroundTaskLaunches!.values()]).toEqual(retained);
            expect.soft(debug).toHaveBeenCalledWith('[claude] Background completion not routed',
                expect.objectContaining({ reason: 'history-lost' }));
            completion('job', 'run-2', 'launch-original');
            const current = await finish('actual run-2 answer');
            expect.soft(current).not.toHaveProperty('requestId');
            expect.soft(current).toMatchObject({ inputEvidence: {
                coverage: 'incomplete', incompleteReasons: expect.arrayContaining(['background-request-unrouted']),
            } });
            expect.soft(h.rearm).toHaveBeenLastCalledWith([], ['background-request-unrouted']);
            expect.soft([...h.state.backgroundTaskLaunches!.values()]).toEqual(retained);
        } finally { debug.mockRestore(); h.queue.destroy(); }
    }, 15000);

    it.each(['sdk', 'scanner'].flatMap(source => ['before-result', 'after-result', 'tool-only'].map(start => ({ source, start }))))(
        'does not reconstruct channel routing after completion eviction ($source, $start)', async ({ source, start }) => {
        const h = harness(true);
        const converter = new SDKToLogConverter({ sessionId: 'sdk-session', cwd: '/workspace', gitBranch: 'main' });
        const sdk = (message: Parameters<typeof converter.convert>[0]) => h.queue.enqueue(converter.convert(message));
        const completion = (task: string, run?: string, tool?: string): Parameters<typeof converter.convert>[0] => ({ type: 'system' as const, subtype: 'task_notification' as const,
            task_id: task, ...(run ? { run_id: run } : {}), ...(tool ? { tool_use_id: tool } : {}), status: 'completed' as const,
            session_id: 'sdk-session', uuid: '00000000-0000-4000-8000-000000000005', output_file: '/tmp/job.output', summary: 'Done' });
        const debug = vi.spyOn(logger, 'debug');
        try {
            // Evict the same task's old run, not just unrelated tasks.
            for (let i = 0; i < 1005; i++) {
                sdk(completion(i === 0 ? 'job' : `other-${i}`, `run-${i}`));
                h.queue.enqueue(assistant('old response')); h.queue.enqueue(turnEndItem('completed'));
                await h.queue.flush();
            }
            expect(h.state.backgroundCompletions?.historyLost).toBe(true);
            h.queue.enqueue(pendingRequestItem('channel-A', { inputs: [{ kind: 'channel', channelRequestId: 'channel-A' }], inputCount: 1 }));
            sdk({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [
                { type: 'tool_use', id: 'launch-new', name: 'Bash', input: { command: 'sleep 10', run_in_background: true } },
            ] } } as Parameters<typeof converter.convert>[0]);
            const started = () => sdk({ type: 'system', subtype: 'task_started', task_id: 'job', run_id: 'run-new', tool_use_id: 'launch-new',
                description: 'New run', session_id: 'sdk-session', uuid: '00000000-0000-4000-8000-000000000015' });
            if (start === 'before-result') started();
            sdk({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [
                { type: 'tool_result', tool_use_id: 'launch-new', content: 'Command running in background with ID: job.' },
            ] } });
            if (start === 'after-result') started();
            h.queue.enqueue(turnEndItem('completed')); await h.queue.flush();
            // A late earlier run must not take the new launch, even with a matching tool ID.
            if (start !== 'tool-only') {
                h.sendScannerMessage({ type: 'user', uuid: 'old-run', origin: { kind: 'task-notification', runId: 'run-0' },
                    message: { role: 'user', content: '<task-notification><task-id>job</task-id><tool-use-id>launch-new</tool-use-id><status>completed</status></task-notification>' } });
                h.queue.enqueue(assistant('late old result')); h.queue.enqueue(finalAnswerItem('late old result'));
                h.queue.enqueue(turnEndItem('completed')); await h.queue.flush();
                expect(h.envelopes.find(e => e.ev.t === 'final-answer' && e.ev.text === 'late old result')?.ev).not.toHaveProperty('requestId');
                expect(h.evidence.snapshot()?.incompleteReasons).toContain('background-request-unrouted');
                expect(debug).toHaveBeenCalledWith('[claude] Background completion not routed', expect.objectContaining({ reason: 'history-lost' }));
            }
            const run = start === 'tool-only' ? undefined : 'run-new';
            const tool = start === 'tool-only' ? 'launch-new' : undefined;
            if (source === 'sdk') sdk(completion('job', run, tool));
            else h.sendScannerMessage({ type: 'user', uuid: 'new-run', origin: { kind: 'task-notification', ...(run ? { runId: run } : {}) },
                message: { role: 'user', content: `<task-notification><task-id>job</task-id>${tool ? `<tool-use-id>${tool}</tool-use-id>` : ''}<status>completed</status></task-notification>` } });
            h.queue.enqueue(assistant('actual final')); h.queue.enqueue(finalAnswerItem('actual final'));
            h.queue.enqueue(turnEndItem('completed')); await h.queue.flush();
            const final = h.envelopes.find(e => e.ev.t === 'final-answer' && e.ev.text === 'actual final')?.ev;
            expect(final).not.toHaveProperty('requestId');
            expect(final).toMatchObject({ inputEvidence: { coverage: 'incomplete',
                incompleteReasons: expect.arrayContaining(['background-request-unrouted']) } });
            expect(h.rearm).toHaveBeenLastCalledWith([], ['background-request-unrouted']);
            expect(h.state.backgroundTaskLaunches?.size ?? 0).toBe(0);
        } finally { debug.mockRestore(); h.queue.destroy(); }
    }, 15000);

    it.each(['tasks', 'runs'])('round 5 bounds retained launch identities for %s and signals an unroutable completion', async kind => {
        const h = harness(true);
        const converter = new SDKToLogConverter({ sessionId: 'sdk-session', cwd: '/workspace', gitBranch: 'main' });
        const sdk = (message: Parameters<typeof converter.convert>[0]) => h.queue.enqueue(converter.convert(message));
        try {
            h.queue.enqueue(pendingRequestItem('channel-A', { inputs: [{ kind: 'channel', channelRequestId: 'channel-A' }], inputCount: 1 }));
            for (let i = 0; i < 1005; i++) {
                const taskId = kind === 'tasks' ? `job-${i}` : 'job';
                sdk({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [
                    { type: 'tool_use', id: `launch-${i}`, name: 'Bash', input: { command: 'sleep 10', run_in_background: true } },
                ] } } as Parameters<typeof converter.convert>[0]);
                sdk({ type: 'system', subtype: 'task_started', task_id: taskId, run_id: `run-${String(i).padStart(4, '0')}`, tool_use_id: `launch-${i}`,
                    description: 'New run', session_id: 'sdk-session', uuid: '00000000-0000-4000-8000-000000000025' });
                sdk({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [
                    { type: 'tool_result', tool_use_id: `launch-${i}`, content: `Command running in background with ID: ${taskId}.` },
                ] } });
            }
            h.queue.enqueue(turnEndItem('completed')); await h.queue.flush();
            expect(h.state.backgroundTaskLaunches?.size).toBe(kind === 'tasks' ? 1000 : 1);
            const retained = [...h.state.backgroundTaskLaunches!.values()];
            // A registered run without a witnessed spawning call proves no channel ownership.
            sdk({ type: 'system', subtype: 'task_started', task_id: 'orphan', run_id: 'orphan-run', tool_use_id: 'unseen-call',
                description: 'Detached task', session_id: 'sdk-session', uuid: '00000000-0000-4000-8000-000000000045' });
            sdk({ type: 'system', subtype: 'task_notification', task_id: 'orphan', run_id: 'orphan-run', tool_use_id: 'unseen-call',
                status: 'completed', session_id: 'sdk-session', uuid: '00000000-0000-4000-8000-000000000055', output_file: '/tmp/job.output', summary: 'Done' });
            h.queue.enqueue(assistant('orphan answer')); h.queue.enqueue(finalAnswerItem('orphan answer'));
            h.queue.enqueue(turnEndItem('completed')); await h.queue.flush();
            expect(h.envelopes.find(e => e.ev.t === 'final-answer' && e.ev.text === 'orphan answer')?.ev).not.toHaveProperty('requestId');
            expect(h.evidence.snapshot()?.incompleteReasons).toContain('background-request-unrouted');
            for (const i of [0, 999, 1004]) {
                sdk({ type: 'system', subtype: 'task_notification', task_id: kind === 'tasks' ? `job-${i}` : 'job', run_id: `run-${String(i).padStart(4, '0')}`, tool_use_id: `launch-${i}`,
                    status: 'completed', session_id: 'sdk-session', uuid: '00000000-0000-4000-8000-000000000035', output_file: '/tmp/job.output', summary: 'Done' });
                h.queue.enqueue(assistant(`answer-${i}`)); h.queue.enqueue(finalAnswerItem(`answer-${i}`));
                h.queue.enqueue(turnEndItem('completed')); await h.queue.flush();
                const final = h.envelopes.find(e => e.ev.t === 'final-answer' && e.ev.text === `answer-${i}`)!.ev;
                expect(final).not.toHaveProperty('requestId');
                expect(h.evidence.snapshot()?.incompleteReasons).toContain('background-request-unrouted');
                expect([...h.state.backgroundTaskLaunches!.values()]).toEqual(retained);
            }
        } finally { h.queue.destroy(); }
    }, 15000);

    it('emits start, text, final answer and terminal in order under one request id', async () => {
        const { queue, envelopes } = harness();

        // Exactly the launcher's sequence, all before the queue drains.
        queue.enqueue(pendingRequestItem('core-req-1'));
        queue.enqueue(assistant('the answer'));
        queue.enqueue(finalAnswerItem('the answer'));
        queue.enqueue(turnEndItem('completed'));
        await queue.flush();

        expect(shape(envelopes)).toEqual(['turn-start', 'text', 'final-answer', 'turn-end']);
        expect(new Set(requestIds(envelopes))).toEqual(new Set(['core-req-1']));
    });

    it('does not let the terminal close a turn before its transcript arrives', async () => {
        // The failure this replaces: the terminal ran synchronously, closing an empty correlated
        // turn, and the queued assistant log then opened a second, uncorrelated one.
        const { queue, envelopes } = harness();
        queue.enqueue(pendingRequestItem('core-req-1'));
        queue.enqueue(assistant('the answer'));
        queue.enqueue(turnEndItem('completed'));
        await queue.flush();

        expect(shape(envelopes)).toEqual(['turn-start', 'text', 'turn-end']);
        // One turn, not two.
        expect(new Set(envelopes.map((envelope) => envelope.turn)).size).toBe(1);
    });

    it('keeps back-to-back requests on their own turns and ids', async () => {
        const { queue, envelopes } = harness();
        queue.enqueue(pendingRequestItem('core-req-A'));
        queue.enqueue(assistant('answer A', 'a-1'));
        queue.enqueue(finalAnswerItem('answer A'));
        queue.enqueue(turnEndItem('completed'));
        // B is consumed while A's output is still queued — the id must not overwrite A's.
        queue.enqueue(pendingRequestItem('core-req-B'));
        queue.enqueue(assistant('answer B', 'a-2'));
        queue.enqueue(finalAnswerItem('answer B'));
        queue.enqueue(turnEndItem('completed'));
        await queue.flush();

        expect(shape(envelopes)).toEqual([
            'turn-start', 'text', 'final-answer', 'turn-end',
            'turn-start', 'text', 'final-answer', 'turn-end',
        ]);
        expect(requestIds(envelopes)).toEqual([
            'core-req-A', 'core-req-A', 'core-req-A',
            'core-req-B', 'core-req-B', 'core-req-B',
        ]);
        const turns = envelopes.map((envelope) => envelope.turn);
        expect(turns[0]).not.toBe(turns[4]);
    });

    it('ends a failed run as failed, with no final answer', async () => {
        const { queue, envelopes } = harness();
        queue.enqueue(pendingRequestItem('core-req-1'));
        queue.enqueue(assistant('partial work'));
        // A failed SDK result enqueues no candidate, and the terminal says so.
        queue.enqueue(turnEndItem('failed'));
        await queue.flush();

        expect(shape(envelopes)).toEqual(['turn-start', 'text', 'turn-end']);
        expect(envelopes.at(-1)?.ev).toMatchObject({ status: 'failed', requestId: 'core-req-1' });
    });

    it('answers a run that produced no transcript at all', async () => {
        const { queue, envelopes } = harness();
        queue.enqueue(pendingRequestItem('core-req-1'));
        queue.enqueue(turnEndItem('failed'));
        await queue.flush();

        // The terminal opens and closes a correlated turn rather than stranding the request.
        expect(shape(envelopes)).toEqual(['turn-start', 'turn-end']);
        expect(requestIds(envelopes)).toEqual(['core-req-1', 'core-req-1']);
    });

    it('preserves an authoritative successful result when no transcript opened the turn', async () => {
        const { queue, envelopes } = harness();
        queue.enqueue(pendingRequestItem('core-result-only'));
        queue.enqueue(finalAnswerItem('finished without a transcript'));
        queue.enqueue(turnEndItem('completed'));
        await queue.flush();

        expect(shape(envelopes)).toEqual(['turn-start', 'final-answer', 'turn-end']);
        expect(requestIds(envelopes)).toEqual([
            'core-result-only', 'core-result-only', 'core-result-only',
        ]);
        expect(envelopes[1].ev).toMatchObject({ text: 'finished without a transcript' });
    });

    it('publishes an ordinary final without a channel handle and keeps an empty channel result separate', async () => {
        const { queue, envelopes } = harness();
        queue.enqueue(finalAnswerItem('ordinary result'));
        queue.enqueue(turnEndItem('completed'));
        await queue.flush();
        expect(shape(envelopes)).toEqual(['turn-start', 'final-answer', 'turn-end']);
        expect(requestIds(envelopes)).toEqual([]);
        envelopes.length = 0;
        queue.enqueue(pendingRequestItem('core-empty'));
        queue.enqueue(finalAnswerItem('   '));
        await queue.flush();
        expect(envelopes).toEqual([]);
        queue.enqueue(turnEndItem('completed'));
        await queue.flush();
        expect(shape(envelopes)).toEqual(['turn-start', 'turn-end']);
        expect(requestIds(envelopes)).toEqual(['core-empty', 'core-empty']);
    });

    it('leaves an ordinary in-app turn uncorrelated', async () => {
        const { queue, envelopes } = harness();
        queue.enqueue(pendingRequestItem(null));
        queue.enqueue(assistant('an answer for the person at the keyboard'));
        queue.enqueue(turnEndItem('completed'));
        await queue.flush();

        expect(requestIds(envelopes)).toEqual([]);
    });
});

describe('permission binding lands on the turn that raised the prompt', () => {
    /** The launcher's real shape: the tool-call message is delayed and released by the prompt. */
    function raiseToolCallPrompt(h: ReturnType<typeof harness>, toolCallId: string) {
        h.queue.enqueue(assistant('working on it', 'a-tool'), {
            delay: 250,
            toolCallIds: [toolCallId],
        });
    }

    it('is applied after the delayed tool-call message, so the turn is already open', async () => {
        const h = harness();
        h.queue.enqueue(pendingRequestItem('req-1'));
        raiseToolCallPrompt(h, 'tool-1');

        // Exactly what `installChannelPermissionWiring` does when the prompt fires.
        let onRequest: ((id: string, tool: string, seq: number) => void) | undefined;
        installChannelPermissionWiring({
            queue: h.queue,
            handler: {
                setOnPermissionRequest: (cb) => { onRequest = cb; },
                setChannelObservationPublisher: () => { },
                bindChannelPermission: () => { },
            },
            turnContextFor: () => { /* membership never resolves in this fixture */ },
            publish: () => { },
        });
        onRequest!('tool-1', 'Bash', 7);
        await h.queue.flush();

        expect(h.bindings).toHaveLength(1);
        // The turn exists, and it is the one the request opened.
        expect(h.bindings[0]?.turnId).toBe(h.state.currentTurnId);
        expect(h.bindings[0]?.turnId).not.toBeNull();
        expect(h.bindings[0]?.requestId).toBe('req-1');
        expect(h.bindings[0]?.toolName).toBe('Bash');
        expect(h.bindings[0]?.instanceSeq).toBe(7);
    });

    it('is held behind the unreleased tool-call message rather than applied early', async () => {
        // `processQueueInternal` stops at the first unreleased item, so nothing behind the delayed
        // message can be applied. That is what keeps the binding from seeing an unopened turn.
        const h = harness();
        h.queue.enqueue(pendingRequestItem('req-1'));
        raiseToolCallPrompt(h, 'tool-1');
        h.queue.enqueue(permissionBindingItem('tool-1', 'Bash', 1));
        // No release: the delayed message is still held, so only the binding can be applied.
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(h.bindings.map((binding) => binding.turnId)).toEqual([]);
    });

    it('keeps the four markers in enqueue order', async () => {
        const h = harness();
        h.queue.enqueue(pendingRequestItem('req-1'));
        h.queue.enqueue(assistant('hello'));
        h.queue.enqueue(permissionBindingItem('tool-1', 'Bash', 1));
        h.queue.enqueue(finalAnswerItem('done'));
        h.queue.enqueue(turnEndItem('completed'));
        await h.queue.flush();

        expect(h.bindings).toHaveLength(1);
        expect(shape(h.envelopes)).toEqual(['turn-start', 'text', 'final-answer', 'turn-end']);
    });
});

// Saycode specs/claude-cli-benchmark-followups R2.
describe('structured output lands inside the turn it judges', () => {
    it('emits the verdict after the turn text and before its terminal', async () => {
        const { queue, envelopes } = harness();
        queue.enqueue(assistant('{"answer":"ok"}'));
        queue.enqueue(structuredOutputItem({ v: 1, status: 'ok', value: { answer: 'ok' } }));
        queue.enqueue(turnEndItem('completed'));
        await queue.flush();

        expect(shape(envelopes)).toEqual(['turn-start', 'text', 'structured-output', 'turn-end']);
        expect(new Set(envelopes.map((envelope) => envelope.turn)).size).toBe(1);
        expect(envelopes[2].ev).toEqual({ t: 'structured-output', v: 1, status: 'ok', value: { answer: 'ok' } });
    });

    it('still reports a missing value for a turn that produced no text', async () => {
        // A turn that failed before any output must not end with silence: the reader would
        // otherwise take "no event" for "this session never asked for one".
        const { queue, envelopes } = harness();
        queue.enqueue(structuredOutputItem({ v: 1, status: 'missing', reason: 'turn_failed' }));
        queue.enqueue(turnEndItem('failed'));
        await queue.flush();

        expect(shape(envelopes)).toEqual(['turn-start', 'structured-output', 'turn-end']);
        expect(envelopes[1].ev).toEqual({ t: 'structured-output', v: 1, status: 'missing', reason: 'turn_failed' });
    });

    it('fills in a missing verdict for a turn that closes without one, so a cancelled turn never reads as success', async () => {
        // Abort and launch-failure paths close the turn without an SDK result to judge.
        const { queue, envelopes, state } = harness();
        state.structuredOutputVerdicts = true;
        queue.enqueue(assistant('working on it'));
        queue.enqueue(turnEndItem('cancelled'));
        await queue.flush();

        expect(shape(envelopes)).toEqual(['turn-start', 'text', 'structured-output', 'turn-end']);
        expect(envelopes[2].ev).toEqual({ t: 'structured-output', v: 1, status: 'missing', reason: 'turn_cancelled' });
        expect(new Set(envelopes.map((envelope) => envelope.turn)).size).toBe(1);
    });

    it('does not add a second verdict to a turn that already has one', async () => {
        const { queue, envelopes, state } = harness();
        state.structuredOutputVerdicts = true;
        queue.enqueue(assistant('{"answer":"ok"}'));
        queue.enqueue(structuredOutputItem({ v: 1, status: 'ok', value: { answer: 'ok' } }));
        queue.enqueue(turnEndItem('completed'));
        await queue.flush();

        expect(shape(envelopes)).toEqual(['turn-start', 'text', 'structured-output', 'turn-end']);
    });
});
