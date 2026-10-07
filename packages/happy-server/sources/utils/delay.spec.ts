import { getEventListeners } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { delay } from './delay';

afterEach(() => {
    vi.useRealTimers();
});

it('removes the shutdown listener when the delay completes', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();

    for (let i = 0; i < 20; i++) {
        const pending = delay(100, controller.signal);
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(100);
        await pending;

        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    }
});

it('removes the shutdown listener when the delay is aborted', async () => {
    const controller = new AbortController();
    const pending = delay(100, controller.signal);

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    controller.abort();
    await pending;

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
});
