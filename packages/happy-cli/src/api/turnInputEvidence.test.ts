/** T2rt golden runtime streams: input IDs, asynchronous attempts, carry and mode gates. */
import { describe, expect, it } from 'vitest';
import { createEnvelope, sessionEnvelopeSchema, type InputRef, type SessionEnvelope } from '@slopus/happy-wire';
import { HubInputGate, TurnInputEvidence } from './turnInputEvidence';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { AutomationTurnTracker } from './automationTurnTracker';
import { createOfflineSessionStub } from '@/utils/offlineSessionStub';

const ref = (id: string): InputRef => ({ kind: 'rest', serverMessageId: id, serverSeq: 42 });
function harness() {
    const events: SessionEnvelope[] = [];
    const tracker = new TurnInputEvidence('host', event => events.push(event));
    const start = (turn: string) => tracker.stamp(createEnvelope('agent', { t: 'turn-start' }, { turn }));
    const end = (turn: string, status: 'completed' | 'failed' | 'cancelled' = 'completed') =>
        tracker.stamp(createEnvelope('agent', { t: 'turn-end', status }, { turn }));
    return { events, tracker, start, end };
}
describe('TurnInputEvidence', () => {
    for (const kind of ['claude-transient', 'claude-account-switch', 'codex-capacity'] as const) {
        it.each(['pre-write', 'post-write/pre-start'] as const)(`T2RT-06/22 settles ${kind} after %s failure`, phase => {
            const h = harness();
            h.tracker.setPending({ inputs: [ref('A')], inputCount: 1 }); h.start('a');
            const root = h.tracker.snapshot()!.rootBatchId;
            h.tracker.continuePending(kind); h.end('a', 'failed');
            h.tracker.setPending({ inputs: [], inputCount: 0, continuation: h.tracker.takeContinuation()! });
            expect(h.tracker.commitPending()).toBe(true);
            h.events.length = 0;
            if (phase === 'pre-write') h.tracker.cancelPendingDispatch();
            else {
                const orphan = h.tracker.unmappedFinalEvidence('provider-turn-unmapped');
                expect(orphan).not.toHaveProperty('turn');
                expect(orphan.ev).toMatchObject({ inputEvidence: { inputs: [], coverage: 'incomplete' } });
                expect((orphan.ev as any).inputEvidence.rootBatchId).not.toBe(root);
            }
            const source = h.tracker.snapshot('a')!;
            expect(source).toMatchObject({ rootBatchId: root, inputs: [ref('A')], terminal: true,
                continuation: { kind, state: 'cancelled' } });
            if (phase === 'post-write/pre-start') expect(source).toMatchObject({ coverage: 'incomplete',
                incompleteReasons: expect.arrayContaining(['missing-provider-turn']) });
            h.tracker.cancelPendingDispatch(); h.tracker.cancelContinuation('cancelled');
            expect(h.events).toHaveLength(1);
            expect(h.events[0].ev).toMatchObject({ t: 'turn-input-evidence', inputEvidence: source });
            for (const event of h.events) sessionEnvelopeSchema.parse(event);
        });
    }

    it('reports an unmapped final without registering or carrying a turn witness', () => {
        const h = harness();
        h.tracker.setPending({ inputs: [ref('old')], inputCount: 1 }); h.start('old'); h.end('old');
        h.tracker.setPending({ inputs: [ref('A')], inputCount: 1 });
        const revision = h.tracker.unmappedFinalEvidence();
        expect(revision).not.toHaveProperty('turn');
        expect(revision.ev).toMatchObject({ t: 'turn-input-evidence', inputEvidence: {
            terminal: true, coverage: 'incomplete', inputs: [], inputCount: 0, incompleteReasons: ['unmapped-final-answer'],
        } });
        h.tracker.continuePending('claude-transient');
        expect(h.tracker.takeContinuation()).toBeUndefined();
        expect(h.tracker.snapshot()).toBeNull();
        expect(h.tracker.currentTurn()).toBeNull();
        h.start('F'); h.end('F');
        expect(h.tracker.snapshot()).toMatchObject({ inputs: [], inputCount: 0, coverage: 'incomplete' });
        expect(() => sessionEnvelopeSchema.parse(revision)).not.toThrow();
    });
    it('allows an offline batch to dispatch without publishing evidence', () => {
        const session = createOfflineSessionStub('test');
        session.setPendingInputEvidence({ inputs: [ref('offline')], inputCount: 1 });
        expect(session.inputEvidence.commitPending()).toBe(true);
    });
    it('T2RT-01 preserves ownership after the provider write and reconciles an ACK before start', () => {
        const h = harness(); h.tracker.setPending({ inputs: [ref('A')], inputCount: 1 }); h.start('a');
        const attempt = h.tracker.attempt('steer');
        h.tracker.continuePending('codex-capacity'); h.end('a', 'failed');
        const continuation = h.tracker.takeContinuation()!;
        h.tracker.setPending({ inputs: [], inputCount: 0, continuation });
        expect(h.tracker.commitPending()).toBe(true);
        h.tracker.cancelContinuation('replaced'); attempt.settle('accepted'); h.start('retry');
        expect(h.tracker.snapshot()).toMatchObject({ rootBatchId: continuation.rootBatchId, inputs: [ref('A')],
            additional: { pending: 0, accepted: 1 }, continuation: { state: 'running' } });
    });

    it('retains a claimed Claude retry while its ordered transcript waits behind shutdown cleanup', () => {
        const h = harness(); h.tracker.setPending({ inputs: [ref('A')], inputCount: 1 }); h.start('a');
        h.tracker.continuePending('claude-transient'); h.end('a', 'failed');
        const continuation = h.tracker.claimContinuation(h.tracker.takeContinuation()!)!;
        h.tracker.cancelContinuation('cancelled');
        h.tracker.setPending({ inputs: [], inputCount: 0, continuation }); h.start('retry');
        expect(h.tracker.snapshot()).toMatchObject({ inputs: [ref('A')], coverage: 'complete',
            continuation: { kind: 'claude-transient', state: 'running' } });
    });
    it('T2RT-01 refuses a cancelled snapshot even when a late turn-start arrives', () => {
        const h = harness(); h.tracker.setPending({ inputs: [ref('A')], inputCount: 1 }); h.start('a');
        const root = h.tracker.snapshot()!.rootBatchId;
        h.tracker.continuePending('codex-capacity'); h.end('a', 'failed');
        const continuation = h.tracker.takeContinuation()!;
        h.tracker.setPending({ inputs: [], inputCount: 0, continuation });
        h.tracker.cancelContinuation('replaced'); h.start('stale');
        expect(h.tracker.snapshot()).toMatchObject({ coverage: 'incomplete', inputs: [], continuation: { kind: 'none' } });
        expect(h.tracker.snapshot()!.rootBatchId).not.toBe(root);
    });
    it('stages scanner consumption for the next turn before the previous terminal is stamped', () => {
        const h = harness();
        h.tracker.setPending({ inputs: [ref('A')], inputCount: 1 }); h.start('a');
        const root = h.tracker.snapshot()!.rootBatchId;
        h.tracker.rememberBackground('job', 'a'); h.end('a');
        h.tracker.setPending({ inputs: [ref('B')], inputCount: 1 }); h.start('b');
        // The mapper has closed B; its terminal is still waiting to be stamped.
        h.tracker.rearmBackground(['job'], [], true);
        h.end('b'); h.start('follow-up');
        expect(h.tracker.snapshot('b')).toMatchObject({ inputs: [ref('B')], coverage: 'complete' });
        expect(h.tracker.snapshot()).toMatchObject({ inputs: [ref('A')], rootBatchId: root, coverage: 'complete',
            continuation: { kind: 'background' } });
    });
    it.each(['background-first', 'batch-first'])('T2RT-02 preserves co-consumption in %s order', order => {
        const h = harness(); h.tracker.setPending({ inputs: [ref('A')], inputCount: 1 }); h.start('a');
        h.tracker.rememberBackground('job', 'a'); h.end('a');
        if (order === 'background-first') h.tracker.rearmBackground(['job']);
        h.tracker.setPending({ inputs: [ref('B')], inputCount: 1 });
        if (order === 'batch-first') h.tracker.rearmBackground(['job']);
        h.start('b');
        expect(h.tracker.snapshot()).toMatchObject({ inputs: [ref('B')], coverage: 'incomplete',
            incompleteReasons: expect.arrayContaining(['background-co-consumption']) });
    });
    it.each(['active', 'pending', 'idle'])('T2RT-03 retains background input after source eviction while %s', phase => {
        const h = harness(); h.tracker.setPending({ inputs: [ref('A')], inputCount: 1 }); h.start('a');
        h.tracker.rememberBackground('long-job', 'a'); h.end('a');
        for (let i = 0; i < 128; i++) {
            h.tracker.setPending({ inputs: [ref(`other-${i}`)], inputCount: 1 }); h.start(`other-${i}`); h.end(`other-${i}`);
        }
        expect(h.tracker.snapshot('a')).toBeNull();
        if (phase !== 'idle') h.tracker.setPending({ inputs: [ref('B')], inputCount: 1 });
        if (phase === 'active') h.start('b');
        h.tracker.rearmBackground(['long-job']);
        if (phase === 'idle') { h.tracker.setPending(null); h.tracker.setPending({ inputs: [ref('B')], inputCount: 1 }); }
        if (phase !== 'active') h.start('b');
        expect(h.tracker.snapshot()).toMatchObject({ coverage: 'incomplete',
            incompleteReasons: expect.arrayContaining(['background-source-unavailable']) });
    });
    it.each([0, 128])('T2RT-04 settles only inherited attempts across background forks (prior=%s)', prior => {
        const h = harness(); h.tracker.setPending({ inputs: [ref('A')], inputCount: 1 }); h.start('a');
        for (let i = 0; i < prior; i++) h.tracker.attempt('steer').settle('accepted');
        const common = h.tracker.attempt('steer');
        h.tracker.rememberBackground('f-job', 'a'); h.tracker.rememberBackground('g-job', 'a'); h.end('a');
        h.tracker.rearmBackground(['f-job']); h.start('f'); const f = h.tracker.attempt('steer'); h.end('f');
        h.tracker.rearmBackground(['g-job']); h.start('g'); const g = h.tracker.attempt('steer');
        f.settle('accepted');
        expect(h.tracker.snapshot('g')?.additional).toMatchObject({ pending: 2, accepted: prior });
        common.settle('unknown'); g.settle('rejected');
        expect(h.tracker.snapshot('f')?.additional).toMatchObject({ pending: 0, accepted: prior + 1, unknown: 1 });
        expect(h.tracker.snapshot('g')?.additional).toMatchObject({ pending: 0, accepted: prior, unknown: 1 });
        for (const event of h.events) expect(() => sessionEnvelopeSchema.parse(event)).not.toThrow();
    });
    it('does not attribute B stored while A runs, then records every B+C batch input', () => {
        const h = harness();
        h.tracker.setPending({ inputs: [ref('A')], inputCount: 1 });
        h.start('a');
        h.tracker.setPending({ inputs: [ref('B'), ref('C')], inputCount: 2 });
        expect(h.end('a').ev).toMatchObject({ inputEvidence: { inputs: [ref('A')], terminal: true } });
        expect(h.start('b').ev).toMatchObject({ inputEvidence: { inputs: [ref('B'), ref('C')], inputCount: 2 } });
    });
    it('captures pending before delivery, keeps it at end, and settles the original turn after another starts', () => {
        const h = harness(); h.tracker.setPending({ inputs: [ref('A')], inputCount: 1 }); h.start('a');
        const attempt = h.tracker.attempt('steer', 'a');
        expect(h.events.at(-1)?.ev).toMatchObject({ inputEvidence: { additional: { attempted: 1, pending: 1 } } });
        expect(h.end('a').ev).toMatchObject({ inputEvidence: { additional: { pending: 1 } } });
        h.tracker.setPending({ inputs: [ref('B')], inputCount: 1 }); h.start('b');
        attempt.settle('unknown'); attempt.settle('accepted');
        expect(h.tracker.snapshot('a')?.additional).toMatchObject({ attempted: 1, unknown: 1, pending: 0, accepted: 0 });
        expect(h.tracker.snapshot('b')?.additional.attempted).toBe(0);
    });
    it.each(['question-answer', 'permission-text'] as const)('records %s before resolve and keeps rejected attempts', kind => {
        const h = harness(); h.tracker.setPending({ inputs: [ref('A')], inputCount: 1 }); h.start('a');
        h.tracker.attempt(kind, 'a').settle('rejected');
        expect(h.tracker.snapshot()?.additional).toMatchObject({ attempted: 1, accepted: 0, pending: 0, items: [{ kind, state: 'rejected' }] });
    });
    it.each(['claude-transient', 'codex-capacity', 'claude-account-switch'] as const)('carries %s root and all additional attempts across provider restart', kind => {
        const h = harness(); h.tracker.setPending({ inputs: [ref('A')], inputCount: 1 }); h.start('a');
        h.tracker.attempt('steer').settle('accepted');
        h.tracker.continuePending(kind);
        expect(h.end('a', 'failed').ev).toMatchObject({ inputEvidence: { terminal: false, continuation: { kind, state: 'pending' } } });
        const inherited = h.tracker.takeContinuation()!;
        h.tracker.setPending({ inputs: [], inputCount: 0, continuation: inherited }); h.start('retry');
        expect(h.tracker.snapshot()).toMatchObject({ rootBatchId: inherited.rootBatchId, inputCount: 1,
            additional: { attempted: 1, accepted: 1 }, continuation: { kind, state: 'running', rootExclusive: false } });
        expect(h.end('retry').ev).toMatchObject({ inputEvidence: { terminal: true, continuation: { state: 'completed' } } });
    });
    it.each(['cancelled', 'replaced'] as const)('settles a queued continuation as %s without leaking its root', state => {
        const h = harness(); h.tracker.setPending({ inputs: [ref('A')], inputCount: 1 }); h.start('a');
        h.tracker.continuePending('claude-account-switch'); h.end('a', 'failed');
        h.tracker.takeContinuation(); // dequeued/queued continuation is still cancellable before dispatch
        h.tracker.cancelContinuation(state);
        expect(h.tracker.snapshot()).toMatchObject({ terminal: true, continuation: { state } });
        expect(h.tracker.takeContinuation()).toBeUndefined();
        h.tracker.setPending({ inputs: [ref('B')], inputCount: 1 }); h.start('b');
        expect(h.tracker.snapshot()?.inputs).toEqual([ref('B')]);
    });
    it('rejects a cancelled retry snapshot and refreshes late additional ACKs through its chain', () => {
        const h = harness(); h.tracker.setPending({ inputs: [ref('A')], inputCount: 1 }); h.start('a');
        const attempt = h.tracker.attempt('steer');
        h.tracker.continuePending('codex-capacity'); h.end('a', 'failed');
        const inherited = h.tracker.takeContinuation()!;
        expect(h.tracker.isContinuationCurrent(inherited)).toBe(true);
        h.tracker.setPending({ inputs: [], inputCount: 0, continuation: inherited }); h.start('retry');
        attempt.settle('accepted');
        expect(h.tracker.snapshot('retry')?.additional).toMatchObject({ attempted: 1, pending: 0, accepted: 1 });
        h.tracker.continuePending('codex-capacity'); h.end('retry', 'failed');
        const queued = h.tracker.takeContinuation()!;
        h.tracker.cancelContinuation('replaced');
        expect(h.tracker.isContinuationCurrent(queued)).toBe(false);
    });
    it('labels a background follow-up with its original root and degrades mixed consumption', () => {
        const h = harness(); h.tracker.setPending({ inputs: [ref('A')], inputCount: 1 }); h.start('a');
        h.tracker.rememberBackground('task', 'a'); h.end('a');
        const original = h.tracker.snapshot()!;
        h.tracker.rearmBackground(['task']); h.start('followup');
        expect(h.tracker.snapshot()).toMatchObject({ rootBatchId: original.rootBatchId, inputs: [ref('A')],
            continuation: { kind: 'background', state: 'running', rootExclusive: true } });
        h.tracker.rememberBackground('task2', 'followup'); h.end('followup');
        h.tracker.setPending({ inputs: [ref('B')], inputCount: 1 }); h.tracker.rearmBackground(['task2']); h.start('b');
        expect(h.tracker.snapshot()).toMatchObject({ inputs: [ref('B')], coverage: 'incomplete', incompleteReasons: ['background-co-consumption'] });
    });
    it('cannot claim complete attribution when an additional write precedes the provider turn id', () => {
        const h = harness(); h.tracker.setPending({ inputs: [ref('A')], inputCount: 1 });
        h.tracker.attempt('steer', null).settle('accepted'); h.start('a');
        expect(h.tracker.snapshot()).toMatchObject({ coverage: 'incomplete', incompleteReasons: ['additional-turn-unresolved'] });
    });
    it('degrades missing batches, duplicate IDs, count mismatch and overflow without losing total counts', () => {
        const h = harness(); h.start('none'); expect(h.tracker.snapshot()?.coverage).toBe('incomplete');
        h.tracker.setPending({ inputs: [ref('A'), ref('A')], inputCount: 3 }); h.start('duplicate');
        expect(h.tracker.snapshot()?.incompleteReasons).toEqual(expect.arrayContaining(['duplicate-server-id', 'input-count-mismatch']));
        h.tracker.setPending({ inputs: Array.from({ length: 300 }, (_, i) => ref(`${i}${'x'.repeat(120)}`)), inputCount: 300 });
        h.start('large');
        for (let i = 0; i < 150; i++) h.tracker.attempt('steer').settle('accepted');
        const end = h.end('large');
        expect(end.ev).toMatchObject({ inputEvidence: { inputCount: 300, coverage: 'incomplete', additional: { attempted: 150, accepted: 150 } } });
        expect(() => sessionEnvelopeSchema.parse(JSON.parse(JSON.stringify(end)))).not.toThrow();
    });
    it('never stamps subagent output or truncates a too-large final into success', () => {
        const h = harness(); h.tracker.setPending({ inputs: [ref('A')], inputCount: 1 }); h.start('a');
        const child = createEnvelope('agent', { t: 'text', text: 'child' }, { turn: 'a', subagent: 'abcdefghijklmnopqrstuvwx' });
        expect(h.tracker.stamp(child)).toBe(child);
        const huge = h.tracker.stamp(createEnvelope('agent', { t: 'final-answer', text: '가'.repeat(23000), requestId: 'req-1' }, { turn: 'a' }));
        // The answer is still delivered, only without evidence; the downgrade is its own revision.
        expect(huge.ev).toEqual({ t: 'final-answer', text: '가'.repeat(23000), requestId: 'req-1' });
        expect(h.events.at(-1)?.ev).toMatchObject({ t: 'turn-input-evidence', inputEvidence: { coverage: 'incomplete' } });
        expect(h.tracker.snapshot()?.incompleteReasons).toContain('answer-too-large');
    });
    it('keeps automation carry/replacement semantics separate from complete batch evidence', () => {
        const automation = new AutomationTurnTracker(); const h = harness();
        automation.arm('run'); h.tracker.setPending({ inputs: [ref('scheduled')], inputCount: 1 });
        automation.observe(h.start('a'));
        h.tracker.continuePending('claude-transient');
        const failed = automation.observe(h.end('a', 'failed'))!;
        automation.carry(failed);
        expect(automation.userInput()).toEqual([{ runId: 'run', status: 'failed', finalAnswer: null, silent: false }]);
        h.tracker.cancelContinuation('replaced');
        expect(h.tracker.snapshot()?.continuation.state).toBe('replaced');
    });
});

describe('HubInputGate and retained queue entries', () => {
    it('rejects wrong host, malformed/unknown guard, local and ABA epochs', () => {
        const gate = new HubInputGate('session', 'host', false); gate.transition('remote');
        const guard = { v: 1, targetSessionId: 'session', expectedRuntimeId: 'host', expectedMode: 'remote', expectedModeEpoch: gate.modeEpoch };
        expect(gate.check({ ref: ref('A'), guard })?.state).toBe('accepted');
        expect(gate.check({ ref: ref('A'), guard: { ...guard, v: 2 } })?.reason).toBe('invalid-guard');
        expect(gate.check({ ref: ref('A'), guard: { ...guard, expectedRuntimeId: 'previous' } })?.reason).toBe('runtime-mismatch');
        gate.transition('transitioning'); expect(gate.check({ ref: ref('A'), guard })?.state).toBe('rejected');
        gate.transition('local'); gate.transition('remote');
        expect(gate.check({ ref: ref('A'), guard })?.reason).toBe('mode-changed');
    });
    it('invalidates queued and already-dequeued guarded inputs while preserving human text, IDs and attachments', async () => {
        const gate = new HubInputGate('session', 'host', false); gate.transition('remote');
        const guard = { v: 1, targetSessionId: 'session', expectedRuntimeId: 'host', expectedMode: 'remote', expectedModeEpoch: gate.modeEpoch };
        let notifications = 0;
        const queue = new MessageQueue2<string>(mode => mode, () => notifications++);
        queue.setInputValidator(input => gate.check(input)?.state !== 'rejected');
        queue.push('guarded', 'mode', undefined, ['route-A'], undefined, undefined, { ref: ref('A'), guard });
        const attachment = { name: 'human.png', mimeType: 'image/png', data: new Uint8Array([1]) };
        queue.push('human', 'mode', [attachment], ['route-B'], undefined, undefined, { ref: ref('B') });
        const batch = (await queue.waitForMessagesAndGetAsString())!;
        expect(batch.inputCount).toBe(2); expect(batch.inputs).toEqual([ref('A'), ref('B')]);
        gate.transition('local');
        const surviving = queue.revalidateBatch(batch)!;
        expect(surviving).toMatchObject({ message: 'human', inputCount: 1, inputs: [ref('B')], attachments: [attachment], requestIds: ['route-B'] });
        queue.push('stale', 'mode', undefined, undefined, undefined, undefined, { ref: ref('A'), guard });
        expect(queue.size()).toBe(0); expect(notifications).toBe(2);
    });
    it('keeps channel isolation and routing slots independent from REST witnesses', async () => {
        const queue = new MessageQueue2<string>(mode => mode);
        queue.push('A', 'mode', undefined, ['route-A'], undefined, undefined, { ref: ref('A') });
        queue.pushIsolated('channel', 'mode', undefined, ['route-channel'], 'channel-id');
        queue.push('B', 'mode', undefined, undefined, undefined, undefined, { ref: ref('B') });
        const a = (await queue.waitForMessagesAndGetAsString())!;
        const channel = (await queue.waitForMessagesAndGetAsString())!;
        const b = (await queue.waitForMessagesAndGetAsString())!;
        expect(a.channelRequestId).toBeUndefined(); expect(a.inputs).toEqual([ref('A')]);
        expect(channel.inputs).toEqual([{ kind: 'channel', channelRequestId: 'channel-id' }]);
        expect(channel.channelRequestId).toBe('channel-id');
        expect(b.channelRequestId).toBeUndefined(); expect(b.inputs).toEqual([ref('B')]);
    });
});
