import { describe, it, expect } from 'vitest';
import { getProcessStartedAt } from './processStartTime';

describe('getProcessStartedAt', () => {
  it('reads a plausible start time for the current process', () => {
    const startedAt = getProcessStartedAt(process.pid);

    expect(startedAt).toBeDefined();
    // Whole-second resolution can round the start slightly into the future
    // relative to Date.now(); anything beyond a second of slack is wrong.
    expect(startedAt!).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(startedAt!).toBeGreaterThan(Date.now() - 24 * 60 * 60 * 1000);
  });

  it('returns undefined for a PID that does not exist', () => {
    // PID 0 is never a readable user process via `ps -p`.
    expect(getProcessStartedAt(0)).toBeUndefined();
  });
});
