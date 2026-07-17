import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LOW_WATER_RATIO,
  DEFAULT_MAX_EVICTIONS_PER_TICK,
  DEFAULT_SESSION_MEMORY_BUDGET_RATIO,
  readSessionMemoryPressureConfig,
  sumSubtreeRss,
} from './sessionMemoryPressure';

const GIB = 1024 * 1024 * 1024;

describe('readSessionMemoryPressureConfig', () => {
  it('defaults the budget to half of total memory with an 80% low-water mark', () => {
    const config = readSessionMemoryPressureConfig({}, 32 * GIB);
    expect(config.disabled).toBe(false);
    expect(config.budgetBytes).toBe(Math.floor(32 * GIB * DEFAULT_SESSION_MEMORY_BUDGET_RATIO));
    expect(config.lowWaterBytes).toBe(Math.floor(config.budgetBytes * DEFAULT_LOW_WATER_RATIO));
    expect(config.maxEvictionsPerTick).toBe(DEFAULT_MAX_EVICTIONS_PER_TICK);
  });

  it('reads env overrides and clamps the low-water mark to the budget', () => {
    const config = readSessionMemoryPressureConfig({
      HAPPY_DAEMON_SESSION_MEMORY_BUDGET_MB: '1024',
      HAPPY_DAEMON_SESSION_MEMORY_LOW_WATER_MB: '4096',
      HAPPY_DAEMON_SESSION_EVICT_MAX_PER_TICK: '2',
      HAPPY_DAEMON_SESSION_PRESSURE_EVICTION_DISABLED: 'true',
    }, 32 * GIB);
    expect(config.disabled).toBe(true);
    expect(config.budgetBytes).toBe(1024 * 1024 * 1024);
    expect(config.lowWaterBytes).toBe(config.budgetBytes);
    expect(config.maxEvictionsPerTick).toBe(2);
  });
});

describe('sumSubtreeRss', () => {
  const psOutput = [
    '  100     1  200000', // session A wrapper: ~195 MiB
    '  101   100  400000', // session A agent child
    '  102   101   50000', // grandchild of A
    '  200     1  100000', // session B wrapper
    '  300     1  999999', // unrelated process
    'garbage line',
  ].join('\n');

  it('sums RSS over each root pid subtree in bytes', () => {
    const { totalBytes, bytesByRootPid } = sumSubtreeRss(psOutput, [100, 200]);
    expect(bytesByRootPid.get(100)).toBe((200000 + 400000 + 50000) * 1024);
    expect(bytesByRootPid.get(200)).toBe(100000 * 1024);
    expect(totalBytes).toBe((200000 + 400000 + 50000 + 100000) * 1024);
  });

  it('omits root pids missing from the snapshot so callers can fall back', () => {
    const { bytesByRootPid } = sumSubtreeRss(psOutput, [100, 555]);
    expect(bytesByRootPid.has(555)).toBe(false);
  });
});
