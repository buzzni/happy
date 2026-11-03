import { readFileSync } from 'node:fs';

/** Linux CLOCK_BOOTTIME domain, shared by parent and child and including suspend. */
export function reservationMonotonicNow(): number {
  if (process.platform !== 'linux') return Number(process.hrtime.bigint() / 1000000n);
  const value = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
  if (!Number.isFinite(value) || value < 0) throw new Error('RESERVATION_CLOCK_UNAVAILABLE');
  return Math.floor(value * 1000);
}
