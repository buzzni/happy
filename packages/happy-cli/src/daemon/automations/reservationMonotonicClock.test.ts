import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));
import { readFileSync } from 'node:fs';
import { reservationMonotonicNow } from './reservationMonotonicClock';
afterEach(() => vi.restoreAllMocks());
it('uses Linux boot elapsed time so a suspended machine cannot keep its old authority', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  vi.mocked(readFileSync).mockReturnValue('123.45 678.90\n');
  expect(reservationMonotonicNow()).toBe(123450);
  vi.mocked(readFileSync).mockReturnValue('183.45 678.90\n');
  expect(reservationMonotonicNow()).toBe(183450);
  vi.mocked(readFileSync).mockReturnValue('broken');
  expect(() => reservationMonotonicNow()).toThrow('RESERVATION_CLOCK_UNAVAILABLE');
});
