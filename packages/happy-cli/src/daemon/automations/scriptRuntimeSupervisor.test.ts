import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScriptRuntimeSupervisor } from './scriptRuntimeSupervisor';
import type { ScriptRuntimeReadiness } from './scriptRuntimeReadiness';

const IMAGE = { image: `node@sha256:${'b'.repeat(64)}`, source: 'release' as const };
const dockerDown = () => Object.assign(new Error('Command failed: docker info'), { stderr: 'failed to connect to the docker API at unix:///x.sock' });

function setup(overrides: { preflight?: () => Promise<typeof IMAGE>; probe?: () => Promise<void> } = {}) {
  const published: Array<{ readiness: ScriptRuntimeReadiness; protocol: number }> = [];
  const worker = { tick: vi.fn(async (): Promise<void> => undefined), stop: vi.fn(async (): Promise<void> => undefined) };
  const deps = {
    preflight: vi.fn(overrides.preflight ?? (async () => IMAGE)),
    createWorker: vi.fn(async () => worker),
    probe: vi.fn(overrides.probe ?? (async () => undefined)),
    publish: (readiness: ScriptRuntimeReadiness, protocol: number) => { published.push({ readiness, protocol }); },
    now: () => Date.now(),
    log: () => undefined,
  };
  return { deps, worker, published, supervisor: createScriptRuntimeSupervisor(deps) };
}

describe('script runtime supervisor', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_700_000_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  it('advertises protocol 5 once the first preflight passes', async () => {
    const { supervisor, published, deps } = setup();
    await supervisor.start();
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ protocol: 5, readiness: { state: 'ready', imageSource: 'release' } });
    expect(deps.createWorker).toHaveBeenCalledTimes(1);
    await supervisor.stop();
  });

  it('stays on protocol 4 with the reason while docker is down, then upgrades when it comes up', async () => {
    let up = false;
    const { supervisor, published, deps } = setup({ preflight: async () => { if (!up) throw dockerDown(); return IMAGE; } });
    await supervisor.start();
    expect(published.at(-1)).toMatchObject({ protocol: 4, readiness: { state: 'unavailable', code: 'DOCKER_UNAVAILABLE' } });
    expect(deps.createWorker).not.toHaveBeenCalled();

    up = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(published.at(-1)).toMatchObject({ protocol: 5, readiness: { state: 'ready' } });
    expect(deps.createWorker).toHaveBeenCalledTimes(1);
    await supervisor.stop();
  });

  it('backs off between retries up to a ceiling instead of hammering docker', async () => {
    const { supervisor, deps } = setup({ preflight: async () => { throw dockerDown(); } });
    await supervisor.start();
    const calls = () => deps.preflight.mock.calls.length;
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(29_000); expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000); expect(calls()).toBe(2);   // 30s
    await vi.advanceTimersByTimeAsync(60_000); expect(calls()).toBe(3);  // +60s
    await vi.advanceTimersByTimeAsync(120_000); expect(calls()).toBe(4); // +2m
    await vi.advanceTimersByTimeAsync(300_000); expect(calls()).toBe(5); // +5m
    await vi.advanceTimersByTimeAsync(600_000); expect(calls()).toBe(6); // +10m (ceiling)
    await vi.advanceTimersByTimeAsync(600_000); expect(calls()).toBe(7);
    await supervisor.stop();
  });

  it('does not retry failures that only a restart with different configuration can fix', async () => {
    const { supervisor, deps, published } = setup({ preflight: async () => { throw new Error('IMMUTABLE_IMAGE_REQUIRED'); } });
    await supervisor.start();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(deps.preflight).toHaveBeenCalledTimes(1);
    expect(published.at(-1)).toMatchObject({ protocol: 4, readiness: { code: 'IMAGE_INVALID' } });
    await supervisor.stop();
  });

  it('runs only one preflight at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { supervisor, deps } = setup({ preflight: async () => { await gate; return IMAGE; } });
    const first = supervisor.start();
    const second = supervisor.start();
    release();
    await Promise.all([first, second]);
    expect(deps.preflight).toHaveBeenCalledTimes(1);
    await supervisor.stop();
  });

  it('withdraws protocol 5 after two failed health probes and recovers without recreating the worker', async () => {
    let healthy = true;
    const { supervisor, published, deps } = setup({ probe: async () => { if (!healthy) throw dockerDown(); } });
    await supervisor.start();
    healthy = false;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(published.at(-1)?.protocol).toBe(5);                  // one failure is not loss
    await vi.advanceTimersByTimeAsync(120_000);
    expect(published.at(-1)).toMatchObject({ protocol: 4, readiness: { state: 'unavailable', code: 'DOCKER_UNAVAILABLE' } });

    healthy = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(published.at(-1)).toMatchObject({ protocol: 5, readiness: { state: 'ready' } });
    expect(deps.createWorker).toHaveBeenCalledTimes(1);
    await supervisor.stop();
  });

  it('stops claiming new runs while unavailable', async () => {
    let healthy = true;
    const { supervisor, worker } = setup({ probe: async () => { if (!healthy) throw dockerDown(); } });
    await supervisor.start();
    await supervisor.tick();
    expect(worker.tick).toHaveBeenCalledTimes(1);
    healthy = false;
    await vi.advanceTimersByTimeAsync(240_000);
    await supervisor.tick();
    expect(worker.tick).toHaveBeenCalledTimes(1);
    await supervisor.stop();
  });

  it('never probes or re-runs preflight while a run is in flight, and keeps that run alive', async () => {
    let finish!: () => void;
    const { supervisor, worker, deps } = setup();
    worker.tick.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    await supervisor.start();
    const running = supervisor.tick();
    deps.probe.mockClear(); deps.preflight.mockClear();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(deps.probe).not.toHaveBeenCalled();
    expect(deps.preflight).not.toHaveBeenCalled();
    expect(worker.stop).not.toHaveBeenCalled();
    finish();
    await running;
    await supervisor.stop();
  });

  it('stops its timers and the worker on shutdown', async () => {
    const { supervisor, worker, deps } = setup();
    await supervisor.start();
    await supervisor.stop();
    deps.probe.mockClear();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(deps.probe).not.toHaveBeenCalled();
    expect(worker.stop).toHaveBeenCalledTimes(1);
  });
});
