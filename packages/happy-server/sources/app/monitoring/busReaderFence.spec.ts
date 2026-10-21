import { describe, expect, it, vi } from 'vitest';
import { createBusReaderFence } from './busReaderFence';

function setup(overrides: Partial<Parameters<typeof createBusReaderFence>[0]> = {}) {
    let now = 0;
    const onFence = vi.fn();
    const fence = createBusReaderFence({ now: () => now, onFence, ...overrides });
    return { fence, onFence, advance: (ms: number) => { now += ms; }, at: () => now };
}

describe('createBusReaderFence', () => {
    it('fences a replica whose reads keep timing out while its writes stay fast (2026-10-21 incident)', () => {
        const { fence, onFence, advance } = setup();
        for (let second = 0; second <= 20; second += 5) {
            fence.recordWrite('success', 0.004);
            fence.recordRead('failure');
            fence.recordLag(32_000 + second * 1000);
            fence.evaluate();
            advance(5_000);
        }
        expect(onFence).toHaveBeenCalledTimes(1);
        expect(onFence.mock.calls[0][0]).toMatch(/reads stalled/);
    });

    it('does not fence while Redis is slow for writes too (shared outage must not drain every replica)', () => {
        const { fence, onFence, advance } = setup();
        for (let i = 0; i < 10; i += 1) {
            fence.recordWrite('success', 3.2);
            fence.recordRead('failure');
            fence.recordLag(60_000);
            fence.evaluate();
            advance(5_000);
        }
        expect(onFence).not.toHaveBeenCalled();
    });

    it('does not fence when writes are failing', () => {
        const { fence, onFence, advance } = setup();
        for (let i = 0; i < 10; i += 1) {
            fence.recordWrite('failure', 0.01);
            fence.recordRead('failure');
            fence.recordLag(60_000);
            fence.evaluate();
            advance(5_000);
        }
        expect(onFence).not.toHaveBeenCalled();
    });

    it('requires the stall to last the whole sustain window', () => {
        const { fence, onFence, advance } = setup();
        fence.recordWrite('success', 0.01);
        fence.recordRead('failure'); fence.recordRead('failure'); fence.recordRead('failure');
        fence.evaluate();
        advance(10_000);
        fence.recordWrite('success', 0.01);
        fence.recordRead('success');
        fence.recordLag(5);
        fence.evaluate();
        advance(10_000);
        fence.recordWrite('success', 0.01);
        fence.evaluate();
        expect(onFence).not.toHaveBeenCalled();
    });

    it('treats a large lag alone as a stall even while reads succeed slowly', () => {
        const { fence, onFence, advance } = setup();
        for (let i = 0; i <= 4; i += 1) {
            fence.recordWrite('success', 0.01);
            fence.recordRead('success');
            fence.recordLag(20_000 + i * 5_000);
            fence.evaluate();
            advance(5_000);
        }
        expect(onFence).toHaveBeenCalledTimes(1);
        expect(onFence.mock.calls[0][0]).toMatch(/lag/);
    });

    it('ignores a short burst of read failures that recovers', () => {
        const { fence, onFence, advance } = setup();
        fence.recordWrite('success', 0.01);
        fence.recordRead('failure'); fence.recordRead('failure');
        fence.recordRead('success');
        fence.recordRead('failure');
        fence.evaluate();
        advance(30_000);
        fence.recordWrite('success', 0.01);
        fence.evaluate();
        expect(onFence).not.toHaveBeenCalled();
    });

    it('needs a recent fast write, not one from long ago', () => {
        const { fence, onFence, advance } = setup();
        fence.recordWrite('success', 0.01);
        advance(60_000);
        for (let i = 0; i < 6; i += 1) {
            fence.recordRead('failure');
            fence.recordLag(90_000);
            fence.evaluate();
            advance(5_000);
        }
        expect(onFence).not.toHaveBeenCalled();
    });

    it('fences at most once', () => {
        const { fence, onFence, advance } = setup();
        for (let i = 0; i < 12; i += 1) {
            fence.recordWrite('success', 0.01);
            fence.recordRead('failure');
            fence.recordLag(90_000);
            fence.evaluate();
            advance(5_000);
        }
        expect(onFence).toHaveBeenCalledTimes(1);
    });

    it('can be disabled', () => {
        const { fence, onFence, advance } = setup({ enabled: false });
        for (let i = 0; i < 12; i += 1) {
            fence.recordWrite('success', 0.01);
            fence.recordRead('failure');
            fence.recordLag(90_000);
            fence.evaluate();
            advance(5_000);
        }
        expect(onFence).not.toHaveBeenCalled();
    });
});
