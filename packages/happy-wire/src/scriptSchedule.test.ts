import { describe, expect, it } from 'vitest';
import { nextScriptScheduledAt, planScriptSchedule } from './scriptSchedule';
import type { ScriptSchedule } from './scriptAutomation';

const ms = (value: string) => Date.parse(value);
describe('script scheduling', () => {
  it('has no due work without an enabled schedule and consumes a one-shot once', () => {
    expect(nextScriptScheduledAt(null, 0)).toBeNull();
    expect(nextScriptScheduledAt({ kind: 'at', at: 1000, enabled: false }, 0)).toBeNull();
    expect(nextScriptScheduledAt({ kind: 'at', at: 1000, enabled: true }, 999)).toBe(1000);
    expect(nextScriptScheduledAt({ kind: 'at', at: 1000, enabled: true }, 1000)).toBeNull();
    expect(planScriptSchedule({ schedule: { kind: 'at', at: 1000, enabled: true }, nextRunAt: 1000, now: 2000 }))
      .toEqual({ scheduledFor: 1000, nextRunAt: null, missedCount: 0 });
  });
  it('coalesces overdue intervals while preserving the original cadence', () => {
    expect(planScriptSchedule({ schedule: { kind: 'interval', minutes: 15, enabled: true }, nextRunAt: 900000, now: 3000000 }))
      .toEqual({ scheduledFor: 900000, nextRunAt: 3600000, missedCount: 2 });
  });
  it('uses the requested timezone and weekdays', () => {
    const daily = { kind: 'daily', hour: 9, minute: 0, timezone: 'Asia/Seoul', enabled: true } satisfies ScriptSchedule;
    expect(nextScriptScheduledAt(daily, ms('2026-09-08T00:00:00Z'))).toBe(ms('2026-09-09T00:00:00Z'));
    expect(nextScriptScheduledAt({ ...daily, kind: 'weekly', days: [1] }, ms('2026-09-08T00:00:00Z'))).toBe(ms('2026-09-14T00:00:00Z'));
  });
  it('skips a missing DST time and executes only the first occurrence of a repeated time', () => {
    const daily = { kind: 'daily', hour: 2, minute: 30, timezone: 'America/New_York', enabled: true } satisfies ScriptSchedule;
    expect(nextScriptScheduledAt(daily, ms('2026-03-08T00:00:00Z'))).toBe(ms('2026-03-09T06:30:00Z'));
    expect(nextScriptScheduledAt({ ...daily, hour: 1 }, ms('2026-11-01T00:00:00Z'))).toBe(ms('2026-11-01T05:30:00Z'));
    expect(nextScriptScheduledAt({ ...daily, hour: 1 }, ms('2026-11-01T05:30:00Z'))).toBe(ms('2026-11-02T06:30:00Z'));
  });
  it('reports missed daily slots once after downtime', () => {
    const schedule = { kind: 'daily', hour: 9, minute: 0, timezone: 'Asia/Seoul', enabled: true } satisfies ScriptSchedule;
    expect(planScriptSchedule({ schedule, nextRunAt: ms('2026-09-01T00:00:00Z'), now: ms('2026-09-08T01:00:00Z') }))
      .toEqual({ scheduledFor: ms('2026-09-01T00:00:00Z'), nextRunAt: ms('2026-09-09T00:00:00Z'), missedCount: 7 });
  });
});
