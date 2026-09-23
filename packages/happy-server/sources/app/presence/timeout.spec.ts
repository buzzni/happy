import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    controller: new AbortController(),
    run: undefined as undefined | (() => Promise<void>),
    sessions: vi.fn(),
    machines: vi.fn(),
}));
vi.mock('@/storage/db', () => ({ db: {
    session: { findMany: state.sessions }, machine: { findMany: state.machines },
} }));
vi.mock('@/utils/forever', () => ({ forever: (_name: string, run: () => Promise<void>) => { state.run = run; } }));
vi.mock('@/utils/shutdown', () => ({ shutdownSignal: state.controller.signal }));
vi.mock('@/app/events/eventRouter', () => ({ eventRouter: {} }));
import { startTimeout } from './timeout';

it('finishes the presence loop after shutdown instead of querying the disconnected database again', async () => {
    state.sessions.mockResolvedValueOnce([]).mockRejectedValue(new Error('query after shutdown'));
    state.machines.mockImplementation(async () => { state.controller.abort(); return []; });
    startTimeout();
    await expect(state.run!()).resolves.toBeUndefined();
    expect(state.sessions).toHaveBeenCalledTimes(1);
    expect(state.machines).toHaveBeenCalledTimes(1);
});
