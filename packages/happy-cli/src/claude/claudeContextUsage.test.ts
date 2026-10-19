import { describe, expect, it } from 'vitest';
import contract from './__fixtures__/context-usage-snapshot.v1.json';
import { ClaudeContextUsageTracker, type ClaudeContextUsageSnapshot } from './claudeContextUsage';

const MODEL = 'claude-sonnet-4-5-20250929';

function createTracker() {
    const frames: ClaudeContextUsageSnapshot[] = [];
    let epochs = 0;
    const tracker = new ClaudeContextUsageTracker(
        (snapshot) => frames.push(snapshot),
        () => `epoch-${++epochs}`,
    );
    return { tracker, frames };
}

const usage = (input: number, cacheRead = 0, cacheCreation = 0) => ({
    input_tokens: input,
    output_tokens: 500,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
});

describe('ClaudeContextUsageTracker', () => {
    it('produces the shared contract fixture for a result, a compaction and a reset, in that order', () => {
        const { tracker, frames } = createTracker();

        tracker.noteProviderModel(MODEL);
        expect(frames).toEqual([]);
        tracker.noteMainAssistant({ model: MODEL, usage: usage(4000, 100000, 20000) });
        tracker.noteTurnResult({ [MODEL]: { inputTokens: 1, outputTokens: 1, contextWindow: 200000 } });
        expect(frames).toEqual(contract.sequences.turnResult);
        expect(tracker.snapshot()).toEqual(contract.snapshot);

        tracker.noteCompactBoundary();
        tracker.noteMainAssistant({ model: MODEL, usage: usage(36000) });
        expect(frames.slice(2)).toEqual(contract.sequences.compaction);

        tracker.reset();
        tracker.noteMainAssistant({ model: MODEL, usage: usage(9000) });
        tracker.noteTurnResult({ [MODEL]: { contextWindow: 200000 } });
        expect(frames.slice(4)).toEqual(contract.sequences.reset);
    });

    it('measures occupancy from the input side of one request only, never the output', () => {
        const { tracker } = createTracker();
        tracker.noteMainAssistant({ model: MODEL, usage: { input_tokens: 10, output_tokens: 99999, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } });
        expect(tracker.snapshot().used).toBe(60);
        // The next request replaces the value; it is not a running total.
        tracker.noteMainAssistant({ model: MODEL, usage: { input_tokens: 5, output_tokens: 1 } });
        expect(tracker.snapshot().used).toBe(5);
    });

    it('ignores usage it cannot read as a real request size', () => {
        const { tracker, frames } = createTracker();
        // The Z.AI-compatible path reports zeros on assistant messages: 0% would be a guess.
        tracker.noteMainAssistant({ model: MODEL, usage: { input_tokens: 0, output_tokens: 0 } });
        tracker.noteMainAssistant({ model: MODEL, usage: { input_tokens: Number.NaN, output_tokens: 1 } });
        tracker.noteMainAssistant({ model: MODEL, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: '5' } });
        tracker.noteMainAssistant({ model: MODEL, usage: { input_tokens: -1, output_tokens: 1 } });
        tracker.noteMainAssistant({ model: MODEL, usage: null });
        // No model, nothing to pair a window with.
        tracker.noteMainAssistant({ model: undefined, usage: usage(10) });
        tracker.noteMainAssistant({ model: '  ', usage: usage(10) });
        expect(frames).toEqual([]);
        expect(tracker.hasValue()).toBe(false);
    });

    it('does not emit again when a streamed block repeats the same request size', () => {
        const { tracker, frames } = createTracker();
        tracker.noteMainAssistant({ model: MODEL, usage: usage(100) });
        tracker.noteMainAssistant({ model: MODEL, usage: { ...usage(100), output_tokens: 900 } });
        expect(frames).toHaveLength(1);
    });

    it('caches windows per model and pairs occupancy with the window of its own model (R3)', () => {
        const { tracker } = createTracker();
        tracker.noteMainAssistant({ model: 'model-a', usage: usage(100) });
        expect(tracker.noteTurnResult({
            'model-a': { contextWindow: 200000 },
            'model-b': { contextWindow: 1000000 },
        })).toBe(true);
        expect(tracker.snapshot()).toMatchObject({ used: 100, window: 200000, model: 'model-a' });

        // Switching to a model already seen this session shows at once, before its turn ends.
        tracker.noteMainAssistant({ model: 'model-b', usage: usage(300) });
        expect(tracker.snapshot()).toMatchObject({ used: 300, window: 1000000, model: 'model-b' });

        // A model never reported stays unknown rather than borrowing another model's window.
        tracker.noteMainAssistant({ model: 'model-c', usage: usage(300) });
        expect(tracker.snapshot()).toMatchObject({ used: 300, window: null, model: 'model-c' });

        // The next result overwrites the cache.
        tracker.noteMainAssistant({ model: 'model-a', usage: usage(100) });
        tracker.noteTurnResult({ 'model-a': { contextWindow: 1000000 } });
        expect(tracker.snapshot()).toMatchObject({ window: 1000000 });
    });

    it('reports whether a turn result changed what is shown, so the caller can resend instead', () => {
        const { tracker, frames } = createTracker();
        tracker.noteMainAssistant({ model: MODEL, usage: usage(100) });
        expect(tracker.noteTurnResult({ [MODEL]: { contextWindow: 200000 } })).toBe(true);
        expect(tracker.noteTurnResult({ [MODEL]: { contextWindow: 200000 } })).toBe(false);
        // Another model's window is cached but the shown snapshot did not move.
        expect(tracker.noteTurnResult({ other: { contextWindow: 1000000 } })).toBe(false);
        expect(frames).toHaveLength(2);
    });

    it('accepts only a positive finite window from runtime input', () => {
        const { tracker } = createTracker();
        tracker.noteMainAssistant({ model: MODEL, usage: usage(100) });
        for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '200000', null]) {
            expect(tracker.noteTurnResult({ [MODEL]: { contextWindow: bad } })).toBe(false);
        }
        expect(tracker.noteTurnResult(null)).toBe(false);
        expect(tracker.noteTurnResult('nope')).toBe(false);
        expect(tracker.noteTurnResult({ [MODEL]: null })).toBe(false);
        expect(tracker.snapshot().window).toBeNull();
    });

    it('keeps model names that collide with Object.prototype as plain data', () => {
        const { tracker } = createTracker();
        tracker.noteMainAssistant({ model: '__proto__', usage: usage(100) });
        expect(tracker.snapshot().window).toBeNull();
        tracker.noteMainAssistant({ model: 'constructor', usage: usage(100) });
        expect(tracker.snapshot().window).toBeNull();
        tracker.noteTurnResult(JSON.parse('{"__proto__":{"contextWindow":5000},"constructor":{"contextWindow":7000}}'));
        expect(tracker.snapshot()).toMatchObject({ model: 'constructor', window: 7000 });
        tracker.noteMainAssistant({ model: '__proto__', usage: usage(100) });
        expect(tracker.snapshot()).toMatchObject({ model: '__proto__', window: 5000 });
    });

    it('pairs occupancy with the provider model, not the API id on the message (2026-10-19 measurement)', () => {
        const { tracker } = createTracker();
        tracker.noteProviderModel('claude-sonnet-4-5[1m]');
        tracker.noteMainAssistant({ model: 'claude-sonnet-4-5-20250929', usage: usage(300000) });
        // A subagent's request under the dated id reports the ordinary window beside the main one.
        tracker.noteTurnResult({
            'claude-sonnet-4-5[1m]': { contextWindow: 1000000 },
            'claude-sonnet-4-5-20250929': { contextWindow: 200000 },
        });
        expect(tracker.snapshot()).toMatchObject({ used: 300000, window: 1000000, model: 'claude-sonnet-4-5[1m]' });

        // A provider restarted on another model pairs the next response with that model.
        tracker.noteProviderModel('claude-sonnet-4-5-20250929');
        tracker.noteMainAssistant({ model: 'claude-sonnet-4-5-20250929', usage: usage(1000) });
        expect(tracker.snapshot()).toMatchObject({ used: 1000, window: 200000, model: 'claude-sonnet-4-5-20250929' });
    });

    it('falls back to the message model only when no provider init was seen', () => {
        const { tracker } = createTracker();
        tracker.noteProviderModel('  ');
        tracker.noteMainAssistant({ model: MODEL, usage: usage(100) });
        expect(tracker.snapshot().model).toBe(MODEL);
    });

    it('keeps the provider model across a reset: the process did not restart', () => {
        const { tracker } = createTracker();
        tracker.noteProviderModel('provider-model');
        tracker.noteMainAssistant({ model: 'api-id', usage: usage(100) });
        tracker.reset();
        tracker.noteMainAssistant({ model: 'api-id', usage: usage(100) });
        expect(tracker.snapshot()).toMatchObject({ model: 'provider-model', window: null });
    });

    it('a compaction hides occupancy but keeps the window cache (R5)', () => {
        const { tracker, frames } = createTracker();
        tracker.noteMainAssistant({ model: MODEL, usage: usage(150000) });
        tracker.noteTurnResult({ [MODEL]: { contextWindow: 200000 } });
        const epoch = tracker.snapshot().epoch;

        tracker.noteCompactBoundary();
        expect(frames.at(-1)).toMatchObject({ epoch, used: null, window: 200000 });
        // A second boundary with nothing left to clear is not a change.
        tracker.noteCompactBoundary();
        expect(frames).toHaveLength(3);
        expect(tracker.hasValue()).toBe(true);

        tracker.noteMainAssistant({ model: MODEL, usage: usage(20000) });
        expect(frames.at(-1)).toMatchObject({ epoch, used: 20000, window: 200000 });
    });

    it('a reset drops occupancy and every cached window, under a new epoch from seq 0 (R6)', () => {
        const { tracker, frames } = createTracker();
        tracker.noteMainAssistant({ model: 'model-a', usage: usage(100) });
        tracker.noteTurnResult({ 'model-a': { contextWindow: 200000 }, 'model-b': { contextWindow: 1000000 } });

        tracker.reset();
        expect(frames.at(-1)).toEqual({ version: 1, type: 'context-usage', epoch: 'epoch-2', seq: 0, used: null, window: null, model: null });
        expect(tracker.hasValue()).toBe(false);

        // The old session's cache must not show the new session before its own first result.
        tracker.noteMainAssistant({ model: 'model-a', usage: usage(100) });
        expect(tracker.snapshot().window).toBeNull();
        tracker.noteMainAssistant({ model: 'model-b', usage: usage(100) });
        expect(tracker.snapshot().window).toBeNull();
    });

    it('a reset with nothing shown sends nothing but still forgets cached windows', () => {
        const { tracker, frames } = createTracker();
        tracker.reset();
        expect(frames).toEqual([]);
        expect(tracker.snapshot().epoch).toBe('epoch-1');

        // A result whose turn had no readable main response (the Z.AI zeros) caches a window only.
        tracker.noteTurnResult({ [MODEL]: { contextWindow: 200000 } });
        expect(tracker.hasValue()).toBe(false);
        tracker.reset();
        expect(frames).toEqual([]);
        tracker.noteMainAssistant({ model: MODEL, usage: usage(100) });
        expect(tracker.snapshot().window).toBeNull();
    });

    it('returns snapshots the caller cannot mutate into the tracker', () => {
        const { tracker, frames } = createTracker();
        tracker.noteMainAssistant({ model: MODEL, usage: usage(100) });
        frames[0].used = 1;
        expect(tracker.snapshot().used).toBe(100);
    });
});
