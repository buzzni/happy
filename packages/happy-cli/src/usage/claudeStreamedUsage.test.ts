import { describe, expect, it, vi } from 'vitest';
import { ClaudeStreamedUsage } from './claudeStreamedUsage';

const started = { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 300 };

function harness() {
    const reported: Array<{ id: string; usage: unknown; final: boolean }> = [];
    const tracker = new ClaudeStreamedUsage();
    return {
        tracker, reported,
        assistant: (id: string, usage = started) => tracker.noteAssistant(id, usage, (reportedUsage, final) => reported.push({ id, usage: reportedUsage, final })),
        stream: (event: unknown, parent: string | null = null) => tracker.noteStreamEvent({ parent_tool_use_id: parent, event }),
        start: (id: string, parent: string | null = null) => tracker.noteStreamEvent({ parent_tool_use_id: parent, event: { type: 'message_start', message: { id, usage: started } } }),
        end: (usage: unknown, parent: string | null = null) => tracker.noteStreamEvent({ parent_tool_use_id: parent, event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage } }),
    };
}

describe('ClaudeStreamedUsage', () => {
    it('reports an assistant message once the stream ends it, with the usage it ended on', () => {
        const { reported, assistant, start, end } = harness();
        start('msg-1');
        assistant('msg-1');
        expect(reported).toEqual([]);

        end({ output_tokens: 5 });
        expect(reported).toEqual([{ id: 'msg-1', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 300 }, final: true }]);
    });

    it('reports at once a message that its own end overtook on the way', () => {
        const { reported, assistant, start, end } = harness();
        start('msg-1');
        end({ output_tokens: 5 });
        expect(reported).toEqual([]);

        assistant('msg-1');
        expect(reported).toEqual([{ id: 'msg-1', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 300 }, final: true }]);
    });

    it('reports duplicate assistant content blocks only once', () => {
        const { reported, assistant, start, end } = harness();
        start('msg-1');
        assistant('msg-1');
        assistant('msg-1');
        end({ output_tokens: 5 });
        expect(reported).toHaveLength(1);

        assistant('msg-1');
        expect(reported.map(({ usage, final }) => ({ usage, final }))).toEqual([
            { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 300 }, final: true }]);
    });

    it('takes every bucket the end reports and keeps the ones it does not', () => {
        const { reported, assistant, start, end } = harness();
        start('msg-1');
        assistant('msg-1');
        end({ input_tokens: 12, output_tokens: 5, cache_creation_input_tokens: 40, cache_read_input_tokens: null, server_tool_use: { web_search_requests: 1 } });
        expect(reported[0].usage).toEqual({ input_tokens: 12, output_tokens: 5, cache_creation_input_tokens: 40, cache_read_input_tokens: 300 });
    });

    it('pairs each end with the message started on the same stream, the main one or a sub-agent', () => {
        const { reported, assistant, start, end } = harness();
        start('msg-main');
        start('msg-child', 'toolu_task');
        assistant('msg-main');
        assistant('msg-child');

        end({ output_tokens: 7 }, 'toolu_task');
        expect(reported.map(({ id, usage }) => [id, (usage as { output_tokens: number }).output_tokens])).toEqual([['msg-child', 7]]);
        end({ output_tokens: 5 });
        expect(reported.map(({ id, usage }) => [id, (usage as { output_tokens: number }).output_tokens])).toEqual([['msg-child', 7], ['msg-main', 5]]);
    });

    it('does not give the end of one message to the next message of that stream', () => {
        const { reported, assistant, start, stream, end } = harness();
        start('msg-1');
        end({ output_tokens: 5 });
        stream({ type: 'message_stop' });
        end({ output_tokens: 99 });
        start('msg-2');
        assistant('msg-2');
        expect(reported).toEqual([]);
    });

    it('forgets the oldest end once more are waiting than any turn leaves behind', () => {
        const { reported, assistant, start, stream, end } = harness();
        for (let index = 0; index <= 512; index += 1) {
            start(`msg-${index}`);
            end({ output_tokens: index });
            stream({ type: 'message_stop' });
        }
        assistant('msg-0');
        assistant('msg-512');
        expect(reported.map(({ id, final }) => [id, final])).toEqual([['msg-512', true]]);
    });

    it('hands over at drain what never got its end, as observed and not as final', () => {
        const { tracker, reported, assistant, start, end } = harness();
        start('msg-1');
        assistant('msg-1');
        tracker.drain();
        expect(reported).toEqual([{ id: 'msg-1', usage: started, final: false }]);

        tracker.drain();
        end({ output_tokens: 5 });
        expect(reported).toHaveLength(1);
    });
});

describe('transcript finals without child stream deltas', () => {
    it('holds background child across turns and accepts a late final exactly once despite duplicate content blocks', () => {
        const { tracker, reported, assistant } = harness();
        assistant('child');
        tracker.drain(false);
        expect(reported).toEqual([]);
        tracker.noteTranscriptFinal('child', { input_tokens: 12, output_tokens: 7 });
        assistant('child');
        tracker.noteTranscriptFinal('child', { input_tokens: 12, output_tokens: 7 });
        tracker.drain();
        expect(reported).toEqual([{ id: 'child', usage: { input_tokens: 12, output_tokens: 7 }, final: true }]);
    });
    it('does not charge unobserved transcript history and marks interrupted pending usage estimated only at execution end', () => {
        const { tracker, reported, assistant } = harness();
        tracker.noteTranscriptFinal('history', started);
        expect(reported).toEqual([]);
        assistant('child', { ...started, output_tokens: 2 });
        tracker.drain(false);
        expect(reported).toEqual([]);
        tracker.drain();
        assistant('child');
        expect(reported).toEqual([{ id: 'child', usage: { ...started, output_tokens: 2 }, final: false }]);
    });
});

it('waits for the actual delta when transcript reconciliation races an open stream', () => {
    const tracker = new ClaudeStreamedUsage(); const report = vi.fn();
    tracker.noteStreamEvent({ parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'open' } } });
    tracker.noteAssistant('open', { input_tokens: 10, output_tokens: 0 }, report);
    tracker.noteTranscriptFinal('open', { input_tokens: 10, output_tokens: 2 });
    expect(report).not.toHaveBeenCalled();
    tracker.noteStreamEvent({ parent_tool_use_id: null, event: { type: 'message_delta', usage: { output_tokens: 9 } } });
    expect(report).toHaveBeenCalledExactlyOnceWith({ input_tokens: 10, output_tokens: 9 }, true);
});

it('accepts transcript reconciliation after a child stream has stopped without a delta', () => {
    const tracker = new ClaudeStreamedUsage(); const report = vi.fn();
    tracker.noteStreamEvent({ parent_tool_use_id: 'child', event: { type: 'message_start', message: { id: 'stopped' } } });
    tracker.noteAssistant('stopped', { input_tokens: 10, output_tokens: 0 }, report);
    tracker.noteStreamEvent({ parent_tool_use_id: 'child', event: { type: 'message_stop' } });
    tracker.noteTranscriptFinal('stopped', { input_tokens: 10, output_tokens: 9 });
    expect(report).toHaveBeenCalledExactlyOnceWith({ input_tokens: 10, output_tokens: 9 }, true);
});
