import type { ScriptSchedule } from './scriptAutomation';

const MINUTE = 60_000;
const DAY = 86400_000;

function formatter(timezone: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
}

function localEpoch(format: Intl.DateTimeFormat, timestamp: number): number {
  const parts = Object.fromEntries(format.formatToParts(timestamp).map((part) => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
}

// Invert the local wall clock. Missing DST instants have no candidate; repeated
// instants have two, of which only the first is eligible, even after a restart.
function firstInstant(format: Intl.DateTimeFormat, wallTime: number): number | null {
  const candidates = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const probe = wallTime + hours * 60 * MINUTE;
    const candidate = wallTime - (localEpoch(format, probe) - probe);
    if (localEpoch(format, candidate) === wallTime) candidates.add(candidate);
  }
  return candidates.size ? Math.min(...candidates) : null;
}

/** Strictly after `after`; intervals are anchored to the supplied cursor. */
export function nextScriptScheduledAt(schedule: ScriptSchedule | null, after: number): number | null {
  if (!schedule?.enabled) return null;
  if (schedule.kind === 'at') return schedule.at > after ? schedule.at : null;
  if (schedule.kind === 'interval') return after + schedule.minutes * MINUTE;
  const format = formatter(schedule.timezone);
  const local = new Date(localEpoch(format, after));
  const firstDay = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  // Two weeks covers a weekly schedule whose only selected day has a DST gap.
  for (let day = 0; day <= 14; day++) {
    const date = firstDay + day * DAY;
    if (schedule.kind === 'weekly' && !schedule.days.includes(new Date(date).getUTCDay())) continue;
    const candidate = firstInstant(format, date + (schedule.hour * 60 + schedule.minute) * MINUTE);
    if (candidate !== null && candidate > after) return candidate;
  }
  throw new Error('SCRIPT_SCHEDULE_UNRESOLVABLE');
}

export function planScriptSchedule(input: {
  schedule: ScriptSchedule | null; nextRunAt: number | null; now: number;
}): { scheduledFor: number; nextRunAt: number | null; missedCount: number } | null {
  const { schedule, nextRunAt, now } = input;
  if (!schedule?.enabled || nextRunAt === null || nextRunAt > now) return null;
  if (schedule.kind === 'at') return { scheduledFor: nextRunAt, nextRunAt: null, missedCount: 0 };
  if (schedule.kind === 'interval') {
    const period = schedule.minutes * MINUTE;
    const missedCount = Math.floor((now - nextRunAt) / period);
    return { scheduledFor: nextRunAt, nextRunAt: nextRunAt + (missedCount + 1) * period, missedCount };
  }
  let cursor = nextScriptScheduledAt(schedule, nextRunAt);
  let missedCount = 0;
  while (cursor !== null && cursor <= now) {
    missedCount++;
    cursor = nextScriptScheduledAt(schedule, cursor);
  }
  return { scheduledFor: nextRunAt, nextRunAt: cursor, missedCount };
}
