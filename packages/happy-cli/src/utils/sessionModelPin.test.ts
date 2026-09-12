import { describe, expect, it } from 'vitest';
import {
    applySessionModelPinPatch,
    applySessionModelPinTurn,
    createSessionModelPinPublisher,
    publishedSessionModelPin,
    type SessionModelPin,
} from './sessionModelPin';
import type { Metadata } from '@/api/types';

const NO_PIN: SessionModelPin = {};

function turn(overrides: Partial<Parameters<typeof applySessionModelPinTurn>[0]['turn']> = {}) {
    return {
        specifiesModel: false,
        specifiesEffort: false,
        ...overrides,
    };
}

describe('applySessionModelPinTurn', () => {
    it('publishes the pin the user chose', () => {
        const result = applySessionModelPinTurn({
            pin: NO_PIN,
            published: NO_PIN,
            turn: turn({ specifiesModel: true, model: 'claude-opus-5', specifiesEffort: true, effort: 'high' }),
        });
        expect(result.pin).toEqual({ model: 'claude-opus-5', effort: 'high' });
        expect(result.patch).toEqual({ currentModelCode: 'claude-opus-5', currentThoughtLevelCode: 'high' });
    });

    it('does not republish a pin that is already advertised', () => {
        const result = applySessionModelPinTurn({
            pin: { model: 'claude-opus-5', effort: 'high' },
            published: { model: 'claude-opus-5', effort: 'high' },
            turn: turn({ specifiesModel: true, model: 'claude-opus-5', specifiesEffort: true, effort: 'high' }),
        });
        expect(result.patch).toBeNull();
    });

    // R2 — the highest-risk rule. A session with no pin runs the runtime default,
    // which is NOT a pin: advertising it would silently switch every client off
    // auto-routing for sessions the user never pinned.
    it('clears the advertised pin when the user resets to default', () => {
        const result = applySessionModelPinTurn({
            pin: { model: 'claude-opus-5', effort: 'high' },
            published: { model: 'claude-opus-5', effort: 'high' },
            turn: turn({ specifiesModel: true, model: undefined, specifiesEffort: true, effort: undefined }),
        });
        expect(result.pin).toEqual(NO_PIN);
        expect(result.patch).toEqual({ currentModelCode: null, currentThoughtLevelCode: null });
    });

    it('advertises nothing for a session that never had a pin', () => {
        const result = applySessionModelPinTurn({ pin: NO_PIN, published: NO_PIN, turn: turn() });
        expect(result.patch).toBeNull();
    });

    // R3 — a router pick must never become the session's pin, or the next client
    // reads it back as a user choice and auto-routing is frozen for good.
    it('ignores a model the client auto-routed', () => {
        const result = applySessionModelPinTurn({
            pin: NO_PIN,
            published: NO_PIN,
            turn: turn({
                specifiesModel: true,
                model: 'claude-sonnet-5',
                specifiesEffort: true,
                effort: 'medium',
                source: 'auto',
            }),
        });
        expect(result.pin).toEqual(NO_PIN);
        expect(result.patch).toBeNull();
    });

    it('keeps an existing pin when a later turn auto-routes', () => {
        const result = applySessionModelPinTurn({
            pin: { model: 'claude-opus-5', effort: 'high' },
            published: { model: 'claude-opus-5', effort: 'high' },
            turn: turn({ specifiesModel: true, model: 'claude-haiku-4-5', source: 'auto' }),
        });
        expect(result.pin).toEqual({ model: 'claude-opus-5', effort: 'high' });
        expect(result.patch).toBeNull();
    });

    // Absent marker = user pin, so desktop and web need no change.
    it('treats a missing source marker as a user pin', () => {
        const result = applySessionModelPinTurn({
            pin: NO_PIN,
            published: NO_PIN,
            turn: turn({ specifiesModel: true, model: 'claude-opus-5' }),
        });
        expect(result.pin).toEqual({ model: 'claude-opus-5' });
        expect(result.patch).toEqual({ currentModelCode: 'claude-opus-5', currentThoughtLevelCode: null });
    });

    it('leaves each half of the pin alone when the turn does not speak to it', () => {
        const result = applySessionModelPinTurn({
            pin: { model: 'claude-opus-5', effort: 'high' },
            published: { model: 'claude-opus-5', effort: 'high' },
            turn: turn({ specifiesEffort: true, effort: 'max' }),
        });
        expect(result.pin).toEqual({ model: 'claude-opus-5', effort: 'max' });
        expect(result.patch).toEqual({ currentModelCode: 'claude-opus-5', currentThoughtLevelCode: 'max' });
    });

    it('converges when the advertised value drifted from the pin', () => {
        const result = applySessionModelPinTurn({
            pin: { model: 'claude-opus-5' },
            published: { model: 'claude-haiku-4-5' },
            turn: turn(),
        });
        expect(result.patch).toEqual({ currentModelCode: 'claude-opus-5', currentThoughtLevelCode: null });
    });

    it('treats an empty model string as no pin', () => {
        const result = applySessionModelPinTurn({
            pin: { model: 'claude-opus-5' },
            published: { model: 'claude-opus-5' },
            turn: turn({ specifiesModel: true, model: '' }),
        });
        expect(result.pin).toEqual(NO_PIN);
        expect(result.patch).toEqual({ currentModelCode: null, currentThoughtLevelCode: null });
    });
});

describe('applySessionModelPinPatch', () => {
    const base = {
        path: '/tmp/p',
        host: 'h',
        homeDir: '/home/u',
        happyHomeDir: '/home/u/.happy',
        happyLibDir: '/home/u/.happy/lib',
        happyToolsDir: '/home/u/.happy/tools',
    } as const satisfies Partial<Metadata>;

    it('writes both codes', () => {
        expect(applySessionModelPinPatch(
            { ...base },
            { currentModelCode: 'claude-opus-5', currentThoughtLevelCode: 'high' },
        )).toEqual({ ...base, currentModelCode: 'claude-opus-5', currentThoughtLevelCode: 'high' });
    });

    // A key left in place would keep advertising a pin the user removed.
    it('deletes the keys rather than writing an empty value', () => {
        const result = applySessionModelPinPatch(
            { ...base, currentModelCode: 'claude-opus-5', currentThoughtLevelCode: 'high' },
            { currentModelCode: null, currentThoughtLevelCode: null },
        );
        expect(result).toEqual(base);
        expect('currentModelCode' in result).toBe(false);
        expect('currentThoughtLevelCode' in result).toBe(false);
    });

    it('does not mutate the metadata it was given', () => {
        const metadata = { ...base, currentModelCode: 'claude-opus-5' };
        applySessionModelPinPatch(metadata, { currentModelCode: null, currentThoughtLevelCode: null });
        expect(metadata.currentModelCode).toBe('claude-opus-5');
    });

    it('leaves unrelated metadata untouched', () => {
        expect(applySessionModelPinPatch(
            { ...base, models: [{ code: 'a', value: 'A' }], name: 'n' },
            { currentModelCode: 'b', currentThoughtLevelCode: null },
        )).toEqual({ ...base, models: [{ code: 'a', value: 'A' }], name: 'n', currentModelCode: 'b' });
    });
});

describe('publishedSessionModelPin', () => {
    const base = {
        path: '/tmp/p',
        host: 'h',
        homeDir: '/home/u',
        happyHomeDir: '/home/u/.happy',
        happyLibDir: '/home/u/.happy/lib',
        happyToolsDir: '/home/u/.happy/tools',
    } as const satisfies Partial<Metadata>;

    it('reads both advertised codes', () => {
        expect(publishedSessionModelPin({ ...base, currentModelCode: 'claude-opus-5', currentThoughtLevelCode: 'high' }))
            .toEqual({ model: 'claude-opus-5', effort: 'high' });
    });

    it('reads an unpinned session as no pin', () => {
        expect(publishedSessionModelPin({ ...base })).toEqual({});
    });

    // Seeded from the session snapshot at startup, which may not exist yet.
    it('tolerates missing metadata', () => {
        expect(publishedSessionModelPin(undefined)).toEqual({});
    });
});

describe('createSessionModelPinPublisher', () => {
    const metadata: Metadata = {
        path: '/tmp/p',
        host: 'h',
        homeDir: '/home/u',
        happyHomeDir: '/home/u/.happy',
        happyLibDir: '/home/u/.happy/lib',
        happyToolsDir: '/home/u/.happy/tools',
    };

    function harness(initialPin: SessionModelPin = {}, publishedPin: SessionModelPin = {}) {
        const written: Metadata[] = [];
        let current: Metadata = { ...metadata, ...(publishedPin.model ? { currentModelCode: publishedPin.model } : {}) };
        const publisher = createSessionModelPinPublisher({
            initialPin,
            publishedPin,
            updateMetadata: (update) => {
                current = update(current);
                written.push(current);
            },
        });
        return { publisher, written, latest: () => current };
    }

    it('advertises a spawn-time pin on the startup converge call', () => {
        const { publisher, written, latest } = harness({ model: 'opus', effort: 'high' });
        publisher.publish({ specifiesModel: false, specifiesEffort: false });
        expect(written).toHaveLength(1);
        expect(latest().currentModelCode).toBe('opus');
        expect(latest().currentThoughtLevelCode).toBe('high');
    });

    it('stays silent for a session with no pin', () => {
        const { publisher, written } = harness();
        publisher.publish({ specifiesModel: false, specifiesEffort: false });
        publisher.publish({ specifiesModel: false, specifiesEffort: false });
        expect(written).toHaveLength(0);
    });

    it('writes once when the user pins, and not again on repeat turns', () => {
        const { publisher, written } = harness();
        publisher.publish({ specifiesModel: true, model: 'claude-opus-5', specifiesEffort: false });
        publisher.publish({ specifiesModel: true, model: 'claude-opus-5', specifiesEffort: false });
        publisher.publish({ specifiesModel: false, specifiesEffort: false });
        expect(written).toHaveLength(1);
    });

    it('deletes the advertised codes when the user resets to default', () => {
        const { publisher, latest } = harness({ model: 'claude-opus-5' }, { model: 'claude-opus-5' });
        publisher.publish({ specifiesModel: true, model: undefined, specifiesEffort: false });
        expect('currentModelCode' in latest()).toBe(false);
    });

    // The regression this whole feature turns on: a router pick must leave no trace.
    it('writes nothing for an auto-routed turn', () => {
        const { publisher, written } = harness();
        publisher.publish({ specifiesModel: true, model: 'claude-sonnet-5', specifiesEffort: true, effort: 'medium', source: 'auto' });
        publisher.publish({ specifiesModel: true, model: 'claude-haiku-4-5', specifiesEffort: true, effort: 'low', source: 'auto' });
        expect(written).toHaveLength(0);
    });

    it('restores the spawn-time pin after an abort reset', () => {
        const { publisher, latest } = harness({ model: 'opus' }, { model: 'opus' });
        publisher.publish({ specifiesModel: true, model: 'claude-haiku-4-5', specifiesEffort: false });
        expect(latest().currentModelCode).toBe('claude-haiku-4-5');
        publisher.reset();
        publisher.publish({ specifiesModel: false, specifiesEffort: false });
        expect(latest().currentModelCode).toBe('opus');
    });

    it('reports each published patch to the caller', () => {
        const seen: unknown[] = [];
        const publisher = createSessionModelPinPublisher({
            initialPin: {},
            publishedPin: {},
            updateMetadata: () => {},
            onPublish: (patch) => seen.push(patch),
        });
        publisher.publish({ specifiesModel: true, model: 'claude-opus-5', specifiesEffort: false });
        expect(seen).toEqual([{ currentModelCode: 'claude-opus-5', currentThoughtLevelCode: null }]);
    });
});
