import { describe, expect, it, vi } from 'vitest';
import { createId, isCuid } from '@paralleldrive/cuid2';
import {
    sessionEnvelopeSchema,
    sessionToolCallEndEventSchema,
    sessionToolCallStartEventSchema,
    type SessionEnvelope,
} from '@slopus/happy-wire';
import {
    mapCodexMcpMessageToSessionEnvelopes,
    mapCodexProcessorMessageToSessionEnvelopes,
    mapCodexThreadToSessionEnvelopes,
    type CodexTurnState,
} from '../utils/sessionProtocolMapper';

describe('mapCodexMcpMessageToSessionEnvelopes', () => {
    it('starts and ends turns for task lifecycle events', () => {
        const started = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'task_started', turn_id: 'provider-1' },
            { currentTurnId: null }
        );

        expect(started.envelopes).toHaveLength(1);
        expect(started.envelopes[0].ev.t).toBe('turn-start');
        expect(started.envelopes[0].turn).toBe(started.currentTurnId);
        expect(started.envelopes[0].turn).not.toBe(started.envelopes[0].id);
        expect(started.currentProviderTurnId).toBe('provider-1');

        const ended = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'task_complete', turn_id: 'provider-1' },
            {
                currentTurnId: started.currentTurnId,
                currentProviderTurnId: started.currentProviderTurnId,
            }
        );
        expect(ended.envelopes).toHaveLength(1);
        expect(ended.envelopes[0].ev.t).toBe('turn-end');
        if (ended.envelopes[0].ev.t === 'turn-end') {
            expect(ended.envelopes[0].ev.status).toBe('completed');
        }
        expect(ended.envelopes[0].turn).toBe(started.currentTurnId);
        expect(ended.currentTurnId).toBeNull();
        expect(ended.currentProviderTurnId).toBeNull();
    });

    it('keeps the active session turn when another task_started event arrives', () => {
        const activeSubagents = new Set<string>(['subagent-1']);
        const startedSubagents = new Set<string>(['subagent-1']);
        const result = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'task_started', turn_id: 'provider-nested' },
            {
                currentTurnId: 'session-root',
                currentProviderTurnId: 'provider-root',
                activeSubagents,
                startedSubagents,
            }
        );

        expect(result.currentTurnId).toBe('session-root');
        expect(result.currentProviderTurnId).toBe('provider-root');
        expect(result.envelopes).toHaveLength(0);
        expect(result.activeSubagents).toEqual(activeSubagents);
        expect(result.startedSubagents).toEqual(startedSubagents);
    });

    it('ignores completion for a different provider turn', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'task_complete', turn_id: 'provider-nested' },
            { currentTurnId: 'session-root', currentProviderTurnId: 'provider-root' }
        );

        expect(result.currentTurnId).toBe('session-root');
        expect(result.currentProviderTurnId).toBe('provider-root');
        expect(result.envelopes).toHaveLength(0);
    });

    it('maps abort lifecycle with cancelled turn-end status', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'turn_aborted' },
            { currentTurnId: 'turn-1' }
        );

        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0].ev).toEqual({
            t: 'turn-end',
            status: 'cancelled',
        });
        expect(result.currentTurnId).toBeNull();
    });

    // runCodex.ts's crash-catch handler synthesizes this exact call (type
    // 'turn_aborted', status 'failed', no turn_id) when sendTurnAndWait rejects
    // with a real error (process crash / connection failure) — i.e. no
    // task_complete/turn_aborted was ever received from codex for the open
    // turn. Without this close, the durable transcript is left with an
    // unclosed turn forever, and the dangling currentTurnId would make the
    // mapper treat the next task_started as a nested continuation (silently
    // dropping the next turn's turn-start too, per 'keeps the active session
    // turn when another task_started event arrives' above).
    it('closes an open turn for a synthetic crash abort (status failed, no turn_id)', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'turn_aborted', status: 'failed' },
            { currentTurnId: 'turn-1', currentProviderTurnId: 'provider-1' }
        );

        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0].ev).toEqual({
            t: 'turn-end',
            status: 'failed',
        });
        expect(result.currentTurnId).toBeNull();
        expect(result.currentProviderTurnId).toBeNull();
    });

    it('is a harmless no-op for a synthetic crash abort when no turn is open', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'turn_aborted', status: 'failed' },
            { currentTurnId: null, currentProviderTurnId: null }
        );

        expect(result.envelopes).toHaveLength(0);
        expect(result.currentTurnId).toBeNull();
    });

    it('maps agent text messages with turn context', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'agent_message', message: 'hello' },
            { currentTurnId: 'turn-1' }
        );

        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0].turn).toBe('turn-1');
        expect(result.envelopes[0].ev).toEqual({ t: 'text', text: 'hello' });
    });

    it('maps parent call linkage to subagent field', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'agent_message', message: 'subagent hello', parent_call_id: 'parent-call-1' },
            { currentTurnId: 'turn-1' }
        );

        expect(result.envelopes).toHaveLength(2);
        const subagent = result.envelopes[1].subagent;
        expect(typeof subagent).toBe('string');
        expect(isCuid(subagent!)).toBe(true);
        expect(result.envelopes[0]).toMatchObject({
            subagent,
            ev: { t: 'start' },
        });
        expect(subagent).not.toBe('parent-call-1');
    });

    it('emits stop for active subagents before turn-end', () => {
        const subagent = createId();
        const activeSubagents = new Set<string>([subagent]);
        const startedSubagents = new Set<string>([subagent]);
        const result = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'task_complete' },
            { currentTurnId: 'turn-1', activeSubagents, startedSubagents }
        );

        expect(result.envelopes).toHaveLength(2);
        expect(result.envelopes[0]).toMatchObject({
            subagent,
            ev: { t: 'stop' },
        });
        expect(result.envelopes[1].ev).toEqual({
            t: 'turn-end',
            status: 'completed',
        });
    });

    it('maps exec command begin to tool-call-start', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes(
            {
                type: 'exec_command_begin',
                call_id: 'call-1',
                command: 'ls -la',
                cwd: '/tmp',
            },
            { currentTurnId: 'turn-1' }
        );

        expect(result.envelopes).toHaveLength(1);
        const envelope = result.envelopes[0];
        expect(envelope.ev.t).toBe('tool-call-start');
        if (envelope.ev.t === 'tool-call-start') {
            expect(envelope.ev.call).toBe('call-1');
            expect(envelope.ev.name).toBe('CodexBash');
            expect(envelope.ev.title).toContain('Run `ls -la`');
            expect(envelope.ev.args).toEqual({ command: 'ls -la', cwd: '/tmp' });
        }
    });

    it('skips token_count messages', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'token_count', total_tokens: 10 },
            { currentTurnId: 'turn-1' }
        );

        expect(result.envelopes).toHaveLength(0);
        expect(result.currentTurnId).toBe('turn-1');
    });

    // A sub-agent the main thread spawned inside its turn (CodexAppServerClient `collab_agent_spawned`).
    describe('collab_agent_spawned', () => {
        const spawned = {
            type: 'collab_agent_spawned',
            call_id: 'call-spawn-1',
            turn_id: 'provider-1',
            thread_id: 'child-thread-1',
            label: 'Linnaeus [explorer]',
        };

        /** Every field is one the wire schemas know (strict: nothing stripped), and the envelope survives the wire. */
        function expectWireValid(envelope: SessionEnvelope): void {
            const eventSchema = envelope.ev.t === 'tool-call-start' ? sessionToolCallStartEventSchema : sessionToolCallEndEventSchema;
            expect(eventSchema.strict().parse(envelope.ev)).toEqual(envelope.ev);
            expect(sessionEnvelopeSchema.parse(JSON.parse(JSON.stringify(envelope)))).toEqual(envelope);
        }

        function withoutIdAndTime(envelope: SessionEnvelope): Omit<SessionEnvelope, 'id' | 'time'> {
            expect(isCuid(envelope.id)).toBe(true);
            expect(typeof envelope.time).toBe('number');
            const { id: _id, time: _time, ...rest } = envelope;
            return rest;
        }

        it('adds one CodexAgent row to the open turn, the child thread as its call id and no background task id', () => {
            const result = mapCodexMcpMessageToSessionEnvelopes(
                spawned,
                { currentTurnId: 'turn-1', currentProviderTurnId: 'provider-1' }
            );

            expect(result.envelopes.map(withoutIdAndTime)).toEqual([
                {
                    role: 'agent',
                    turn: 'turn-1',
                    ev: {
                        t: 'tool-call-start',
                        call: 'child-thread-1',
                        name: 'CodexAgent',
                        title: 'Linnaeus [explorer]',
                        description: 'Linnaeus [explorer]',
                        args: { agent: 'Linnaeus [explorer]' },
                    },
                },
                {
                    role: 'agent',
                    turn: 'turn-1',
                    // No `backgroundTaskId`: clients read that as a Claude launch whose completion answers a request again.
                    ev: { t: 'tool-call-end', call: 'child-thread-1' },
                },
            ]);
            for (const envelope of result.envelopes) expectWireValid(envelope);
            expect(result.currentTurnId).toBe('turn-1');
            expect(result.currentProviderTurnId).toBe('provider-1');
        });

        it('adds nothing and changes nothing when no turn is open', () => {
            const startedSubagents = new Set<string>(['subagent-1']);
            const activeSubagents = new Set<string>(['subagent-1']);
            const providerSubagentToSessionSubagent = new Map<string, string>([['parent-call-1', 'subagent-1']]);
            const providerTurnToProtocol = new Map<string, string>([['provider-0', 'turn-0']]);
            const state: CodexTurnState = {
                currentTurnId: null,
                currentProviderTurnId: null,
                // A turn-start would consume this; never opening one leaves it waiting.
                pendingRequestId: 'request-1',
                currentRequestId: null,
                startedSubagents,
                activeSubagents,
                providerSubagentToSessionSubagent,
                providerTurnToProtocol,
            };
            const before = structuredClone(state);

            const result = mapCodexMcpMessageToSessionEnvelopes(spawned, state);

            expect(result.envelopes).toEqual([]);
            expect(result.currentTurnId).toBeNull();
            expect(result.currentProviderTurnId).toBeNull();
            expect(result.startedSubagents).toBe(startedSubagents);
            expect(result.activeSubagents).toBe(activeSubagents);
            expect(result.providerSubagentToSessionSubagent).toBe(providerSubagentToSessionSubagent);
            expect(state).toEqual(before);
        });

        it('adds nothing once its turn has ended, so nothing follows the turn-end', () => {
            const started = mapCodexMcpMessageToSessionEnvelopes({ type: 'task_started', turn_id: 'provider-1' }, { currentTurnId: null });
            const ended = mapCodexMcpMessageToSessionEnvelopes(
                { type: 'task_complete', turn_id: 'provider-1' },
                { currentTurnId: started.currentTurnId, currentProviderTurnId: started.currentProviderTurnId }
            );
            expect(ended.envelopes.map((envelope) => envelope.ev.t)).toEqual(['turn-end']);

            const late = mapCodexMcpMessageToSessionEnvelopes(
                spawned,
                { currentTurnId: ended.currentTurnId, currentProviderTurnId: ended.currentProviderTurnId }
            );
            expect(late.envelopes).toEqual([]);
            expect(late.currentTurnId).toBeNull();
        });

        it('falls back to the Agent label and a generated call id, and omits a missing child thread id', () => {
            const result = mapCodexMcpMessageToSessionEnvelopes(
                { type: 'collab_agent_spawned', turn_id: 'provider-1' },
                { currentTurnId: 'turn-1' }
            );

            expect(result.envelopes).toHaveLength(2);
            const [start, end] = result.envelopes;
            expect(start.ev).toEqual({
                t: 'tool-call-start',
                call: expect.any(String),
                name: 'CodexAgent',
                title: 'Agent',
                description: 'Agent',
                args: { agent: 'Agent' },
            });
            const call = start.ev.t === 'tool-call-start' ? start.ev.call : '';
            expect(call.length).toBeGreaterThan(0);
            expect(end.ev).toEqual({ t: 'tool-call-end', call });
            for (const envelope of result.envelopes) {
                expect(envelope.turn).toBe('turn-1');
                expectWireValid(envelope);
            }
        });

        it.each([
            ['not strings', { call_id: 42, thread_id: 7, label: { nickname: 'Linnaeus' } }],
            ['empty', { call_id: '', thread_id: '', label: '  ' }],
        ])('treats a label, call id and child thread id that are %s as missing', (_case, fields) => {
            const result = mapCodexMcpMessageToSessionEnvelopes(
                { type: 'collab_agent_spawned', turn_id: 'provider-1', ...fields },
                { currentTurnId: 'turn-1' }
            );

            const [start, end] = result.envelopes;
            expect(start.ev).toMatchObject({ t: 'tool-call-start', name: 'CodexAgent', title: 'Agent', description: 'Agent', args: { agent: 'Agent' } });
            const call = start.ev.t === 'tool-call-start' ? start.ev.call : '';
            expect(call.length).toBeGreaterThan(0);
            expect(end.ev).toEqual({ t: 'tool-call-end', call });
            for (const envelope of result.envelopes) expectWireValid(envelope);
        });

        it('never ties the row to a session sub-agent, even when the message names a parent call', () => {
            const providerSubagentToSessionSubagent = new Map<string, string>();
            const result = mapCodexMcpMessageToSessionEnvelopes(
                { ...spawned, parent_call_id: 'parent-call-1', subagent: 'provider-subagent-1' },
                { currentTurnId: 'turn-1', providerSubagentToSessionSubagent }
            );

            expect(result.envelopes.map((envelope) => envelope.ev.t)).toEqual(['tool-call-start', 'tool-call-end']);
            for (const envelope of result.envelopes) expect(envelope).not.toHaveProperty('subagent');
            expect(result.providerSubagentToSessionSubagent.size).toBe(0);
            expect(result.startedSubagents.size).toBe(0);
            expect(result.activeSubagents.size).toBe(0);
        });
    });
});

describe('mapCodexProcessorMessageToSessionEnvelopes', () => {
    it('maps reasoning tool lifecycle to start/text/end session events', () => {
        const startEvents = mapCodexProcessorMessageToSessionEnvelopes({
            type: 'tool-call',
            callId: 'reasoning-1',
            name: 'CodexReasoning',
            input: { title: 'Plan changes' },
            id: 'legacy-id-1',
        }, { currentTurnId: 'turn-1' });

        expect(startEvents).toHaveLength(1);
        expect(startEvents[0].ev.t).toBe('tool-call-start');

        const endEvents = mapCodexProcessorMessageToSessionEnvelopes({
            type: 'tool-call-result',
            callId: 'reasoning-1',
            output: { content: 'Step 1, Step 2', status: 'completed' },
            id: 'legacy-id-2',
        }, { currentTurnId: 'turn-1' });

        expect(endEvents).toHaveLength(2);
        expect(endEvents[0].ev.t).toBe('text');
        if (endEvents[0].ev.t === 'text') {
            expect(endEvents[0].ev.thinking).toBe(true);
        }
        expect(endEvents[1].ev).toEqual({ t: 'tool-call-end', call: 'reasoning-1' });
    });

    it('maps reasoning text to thinking text event', () => {
        const events = mapCodexProcessorMessageToSessionEnvelopes({
            type: 'reasoning',
            message: 'Working through options',
            id: 'legacy-id-3',
        }, { currentTurnId: 'turn-1' });

        expect(events).toHaveLength(1);
        expect(events[0].ev).toEqual({
            t: 'text',
            text: 'Working through options',
            thinking: true,
        });
    });
});

describe('mapCodexThreadToSessionEnvelopes', () => {
    it('backfills Codex thread turns as session envelopes with codex item ids', () => {
        const envelopes = mapCodexThreadToSessionEnvelopes({
            turns: [{
                id: 'turn-1',
                startedAt: 100,
                completedAt: 101,
                status: 'completed',
                items: [
                    { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'hello codex' }] },
                    { id: 'agent-1', type: 'agentMessage', text: 'hello human' },
                ],
            }],
        });

        expect(envelopes.map((envelope) => envelope.ev.t)).toEqual([
            'turn-start',
            'text',
            'text',
            'turn-end',
        ]);
        expect(envelopes[1]).toMatchObject({
            role: 'user',
            id: 'user-1',
            codexItemId: 'user-1',
            ev: { t: 'text', text: 'hello codex' },
        });
        expect(envelopes[2]).toMatchObject({
            role: 'agent',
            id: 'agent-1',
            turn: 'turn-1',
            codexItemId: 'agent-1',
            ev: { t: 'text', text: 'hello human' },
        });
    });

    it('backfills Codex command execution items as tool calls', () => {
        const envelopes = mapCodexThreadToSessionEnvelopes({
            turns: [{
                id: 'turn-1',
                startedAt: 100,
                items: [
                    {
                        id: 'cmd-1',
                        type: 'commandExecution',
                        command: 'pnpm test',
                        cwd: '/tmp/project',
                        aggregatedOutput: 'ok',
                    },
                ],
            }],
        });

        expect(envelopes.map((envelope) => envelope.ev.t)).toEqual([
            'turn-start',
            'tool-call-start',
            'text',
            'tool-call-end',
            'turn-end',
        ]);
        expect(envelopes[1]).toMatchObject({
            role: 'agent',
            turn: 'turn-1',
            ev: { t: 'tool-call-start', call: 'cmd-1', name: 'CodexBash' },
        });
        expect(envelopes[2]).toMatchObject({
            role: 'agent',
            turn: 'turn-1',
            ev: { t: 'text', text: 'ok', thinking: true },
        });
        expect(envelopes[3]).toMatchObject({
            role: 'agent',
            turn: 'turn-1',
            ev: { t: 'tool-call-end', call: 'cmd-1' },
        });
    });

    it('uses one fallback timestamp pair for historical tool items without provider timestamps', () => {
        const dateSpy = vi
            .spyOn(Date, 'now')
            .mockReturnValueOnce(10_000)
            .mockReturnValueOnce(20_000);

        try {
            const envelopes = mapCodexThreadToSessionEnvelopes({
                turns: [{
                    id: 'turn-without-times',
                    items: [
                        {
                            id: 'cmd-1',
                            type: 'commandExecution',
                            command: 'pnpm test',
                            aggregatedOutput: 'ok',
                        },
                    ],
                }],
            });

            expect(envelopes.map((envelope) => envelope.time)).toEqual([
                10_000,
                10_000,
                10_000,
                20_000,
                20_000,
            ]);
        } finally {
            dateSpy.mockRestore();
        }
    });
});
