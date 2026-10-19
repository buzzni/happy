import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import contract from './__fixtures__/context-usage-snapshot.v1.json';
import {
    ClaudeContextUsageTracker,
    contextUsageSignalItem,
    createContextUsageEpochSource,
    withContextUsageSignals,
    type ClaudeContextUsageSnapshot,
} from './claudeContextUsage';

const MODEL = 'claude-sonnet-4-5-20250929';

/**
 * The contract fixture is a byte copy of Saycode Desktop `tests/fixtures/context-usage-snapshot.v1.json`,
 * the canonical one. Desktop checks the same hash: changing the file on one side only fails here.
 */
const CONTRACT_FIXTURE_SHA256 = '67f9210fc60d3a9fc7224b9f9a4c8ec81af14f5b4721ad339f6f95ff08f0c231';
const EPOCH_FORMAT = /^\d{13}-[0-9a-z]+$/;

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

describe('context-usage contract fixture', () => {
    it('is byte for byte the canonical Desktop fixture', () => {
        const bytes = readFileSync(join(__dirname, '__fixtures__/context-usage-snapshot.v1.json'));
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(CONTRACT_FIXTURE_SHA256);
    });

    it('is what the tracker sends before the first result, once the window is known, and after a reset', () => {
        const epochs = [contract.assistantWithWindow.epoch, contract.afterReset.epoch];
        const frames: ClaudeContextUsageSnapshot[] = [];
        const tracker = new ClaudeContextUsageTracker((snapshot) => frames.push(snapshot), () => epochs.shift()!);

        tracker.noteProviderModel(MODEL);
        tracker.noteMainAssistant({ model: MODEL, usage: usage(2000, 15000, 1000) });
        expect(frames.at(-1)).toEqual(contract.assistantBeforeFirstResult);
        tracker.noteTurnResult({ [MODEL]: { inputTokens: 1, outputTokens: 1, contextWindow: 200000 } });
        tracker.noteMainAssistant({ model: MODEL, usage: usage(4000, 100000, 20000) });
        expect(frames.at(-1)).toEqual(contract.assistantWithWindow);
        tracker.reset();
        expect(frames.at(-1)).toEqual(contract.afterReset);
    });

    it('uses the epoch format the tracker produces', () => {
        for (const snapshot of Object.values(contract)) expect(snapshot.epoch).toMatch(EPOCH_FORMAT);
        expect(new ClaudeContextUsageTracker(() => {}).snapshot().epoch).toMatch(/^\d{13}-[0-9a-f]{8}$/);
    });
});

describe('createContextUsageEpochSource', () => {
    const timeOf = (epoch: string) => Number(epoch.slice(0, 13));

    it('pads the millisecond time to 13 digits ahead of a random id', () => {
        const next = createContextUsageEpochSource(() => 1792400000000, () => '0b6f1c9e');
        expect(next()).toBe('1792400000000-0b6f1c9e');
        expect(createContextUsageEpochSource(() => 42, () => 'ab')()).toBe('0000000000042-ab');
    });

    it('rises strictly within a process, in the same millisecond and with the clock stepped back', () => {
        const clock = [1792400000000, 1792400000000, 1792399990000, 1792400000500];
        const next = createContextUsageEpochSource(() => clock.shift()!, () => 'x');
        expect([next(), next(), next(), next()].map(timeOf)).toEqual([1792400000000, 1792400000001, 1792400000002, 1792400000500]);
    });

    it('gives a reset a later epoch than the one it replaces', () => {
        const frames: ClaudeContextUsageSnapshot[] = [];
        const tracker = new ClaudeContextUsageTracker((snapshot) => frames.push(snapshot));
        tracker.noteMainAssistant({ model: MODEL, usage: usage(100) });
        tracker.reset();
        expect(timeOf(frames[1].epoch)).toBeGreaterThan(timeOf(frames[0].epoch));
    });
});

describe('context-usage queue signals', () => {
    it('turns only system init and compact_boundary into queue items', () => {
        expect(contextUsageSignalItem({ type: 'system', subtype: 'init', model: 'claude-haiku-4-5' }))
            .toEqual({ __claudeContextUsageSignal: true, signal: { kind: 'provider-model', model: 'claude-haiku-4-5' } });
        expect(contextUsageSignalItem({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } }))
            .toEqual({ __claudeContextUsageSignal: true, signal: { kind: 'compact-boundary' } });
        for (const other of [null, 'init', { type: 'system', subtype: 'task_started' }, { type: 'assistant', subtype: 'init' }]) {
            expect(contextUsageSignalItem(other)).toBeNull();
        }
    });

    it('applies the signal items in their place and sends everything else on', () => {
        const order: string[] = [];
        const send = withContextUsageSignals(
            (message) => order.push(`send:${(message as { uuid: string }).uuid}`),
            (signal) => order.push(`signal:${signal.kind}`),
        );
        send({ uuid: 'a' });
        send(contextUsageSignalItem({ type: 'system', subtype: 'compact_boundary' }));
        send({ uuid: 'b' });
        expect(order).toEqual(['send:a', 'signal:compact-boundary', 'send:b']);
    });
});

describe('ClaudeContextUsageTracker', () => {
    it('emits each change as a new seq: result, compaction, reset', () => {
        const { tracker, frames } = createTracker();
        const frame = (epoch: string, seq: number, used: number | null, window: number | null, model: string | null) =>
            ({ version: 1, type: 'context-usage', epoch, seq, used, window, model });

        tracker.noteProviderModel(MODEL);
        expect(frames).toEqual([]);
        tracker.noteMainAssistant({ model: MODEL, usage: usage(4000, 100000, 20000) });
        tracker.noteTurnResult({ [MODEL]: { inputTokens: 1, outputTokens: 1, contextWindow: 200000 } });
        tracker.noteCompactBoundary();
        tracker.noteMainAssistant({ model: MODEL, usage: usage(36000) });
        tracker.reset();
        tracker.noteMainAssistant({ model: MODEL, usage: usage(9000) });
        tracker.noteTurnResult({ [MODEL]: { contextWindow: 200000 } });

        expect(frames).toEqual([
            frame('epoch-1', 1, 124000, null, MODEL),
            frame('epoch-1', 2, 124000, 200000, MODEL),
            frame('epoch-1', 3, null, 200000, MODEL),
            frame('epoch-1', 4, 36000, 200000, MODEL),
            frame('epoch-2', 0, null, null, null),
            frame('epoch-2', 1, 9000, null, MODEL),
            frame('epoch-2', 2, 9000, 200000, MODEL),
        ]);
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

    it('stops naming the provider model once the provider answers under another API id', () => {
        const { tracker } = createTracker();
        tracker.noteProviderModel('claude-opus-4-1[1m]');
        tracker.noteMainAssistant({ model: 'claude-opus-4-1-20250805', usage: usage(100) });
        tracker.noteTurnResult({ 'claude-opus-4-1[1m]': { contextWindow: 1000000 }, [MODEL]: { contextWindow: 200000 } });
        expect(tracker.snapshot()).toMatchObject({ model: 'claude-opus-4-1[1m]', window: 1000000 });

        // fallbackModel on overload: same process, no new init, another model answering.
        tracker.noteMainAssistant({ model: MODEL, usage: usage(180000) });
        expect(tracker.snapshot()).toMatchObject({ used: 180000, model: MODEL, window: 200000 });
        tracker.noteMainAssistant({ model: 'claude-other-dated', usage: usage(180000) });
        expect(tracker.snapshot()).toMatchObject({ model: 'claude-other-dated', window: null });

        // A new provider learns its own id again.
        tracker.noteProviderModel('claude-opus-4-1[1m]');
        tracker.noteMainAssistant({ model: 'claude-opus-4-1-20250805', usage: usage(100) });
        expect(tracker.snapshot()).toMatchObject({ model: 'claude-opus-4-1[1m]', window: 1000000 });
    });

    it('does not lend the init model its window when the first response is already a fallback', () => {
        const { tracker } = createTracker();
        tracker.noteProviderModel('claude-opus-4-1[1m]');
        tracker.noteMainAssistant({ model: 'claude-opus-4-1-20250805', usage: usage(100) });
        tracker.noteTurnResult({ 'claude-opus-4-1[1m]': { contextWindow: 1000000 } });

        // The provider restarts on Opus, and its very first response comes from the fallback.
        tracker.noteProviderModel('claude-opus-4-1[1m]');
        tracker.noteMainAssistant({ model: MODEL, usage: usage(180000) });
        // Not 18% of Opus's 1M: the window of the model that answered, or nothing.
        expect(tracker.snapshot()).toMatchObject({ used: 180000, model: MODEL, window: null });
        tracker.noteTurnResult({ [MODEL]: { contextWindow: 200000 } });
        expect(tracker.snapshot()).toMatchObject({ used: 180000, model: MODEL, window: 200000 });

        // Opus answering again is still recognised as the provider model.
        tracker.noteMainAssistant({ model: 'claude-opus-4-1-20250805', usage: usage(300000) });
        expect(tracker.snapshot()).toMatchObject({ used: 300000, model: 'claude-opus-4-1[1m]', window: 1000000 });
    });

    it('pairs an API id with the init model only by the same name or that name plus a date', () => {
        const pairedModel = (providerModel: string, apiModel: string) => {
            const { tracker } = createTracker();
            tracker.noteProviderModel(providerModel);
            tracker.noteMainAssistant({ model: apiModel, usage: usage(100) });
            return tracker.snapshot().model;
        };
        expect(pairedModel('claude-haiku-4-5', 'claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
        expect(pairedModel('claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001');
        expect(pairedModel('claude-sonnet-4-5[1m]', MODEL)).toBe('claude-sonnet-4-5[1m]');
        expect(pairedModel('glm-4.6', 'glm-4.6')).toBe('glm-4.6');
        // Anything it cannot confirm is paired by the message's own id (hidden until reported).
        expect(pairedModel('claude-haiku-4', 'claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001');
        expect(pairedModel('claude-opus-4-1', MODEL)).toBe(MODEL);
        expect(pairedModel('us.anthropic.claude-sonnet-4-5-20250929-v1:0', MODEL)).toBe(MODEL);
    });

    it('learns the provider API id only from a readable response', () => {
        const { tracker } = createTracker();
        tracker.noteProviderModel('claude-opus-4-1');
        // An API error message: zero usage under a synthetic id.
        tracker.noteMainAssistant({ model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } });
        tracker.noteMainAssistant({ model: 'claude-opus-4-1-20250805', usage: usage(100) });
        expect(tracker.snapshot().model).toBe('claude-opus-4-1');
    });

    it('falls back to the message model only when no provider init was seen', () => {
        const { tracker } = createTracker();
        tracker.noteProviderModel('  ');
        tracker.noteMainAssistant({ model: MODEL, usage: usage(100) });
        expect(tracker.snapshot().model).toBe(MODEL);
    });

    it('keeps the provider model across a reset: the process did not restart', () => {
        const { tracker } = createTracker();
        tracker.noteProviderModel('claude-haiku-4-5');
        tracker.noteMainAssistant({ model: 'claude-haiku-4-5-20251001', usage: usage(100) });
        tracker.reset();
        tracker.noteMainAssistant({ model: 'claude-haiku-4-5-20251001', usage: usage(100) });
        expect(tracker.snapshot()).toMatchObject({ model: 'claude-haiku-4-5', window: null });
    });

    it('hiding takes the meter down in the same epoch and keeps the window cache', () => {
        const { tracker, frames } = createTracker();
        tracker.hide();
        expect(frames).toEqual([]);

        tracker.noteProviderModel(MODEL);
        tracker.noteMainAssistant({ model: MODEL, usage: usage(100) });
        tracker.noteTurnResult({ [MODEL]: { contextWindow: 200000 } });
        tracker.hide();
        expect(frames.at(-1)).toEqual({ version: 1, type: 'context-usage', epoch: 'epoch-1', seq: 3, used: null, window: null, model: null });
        expect(tracker.hasValue()).toBe(false);

        // Back from the terminal: the same conversation, so the cached window still applies.
        tracker.noteMainAssistant({ model: MODEL, usage: usage(200) });
        expect(frames.at(-1)).toMatchObject({ epoch: 'epoch-1', seq: 4, used: 200, window: 200000 });
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
