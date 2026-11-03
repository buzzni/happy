import { expect, it, vi } from 'vitest';
import { ReservationBackgroundRuns } from './reservationBackgroundRuns';
import type { ReservationRunJournal } from './reservationRunJournal';
it('admits synchronously, keeps the same conversation serial and lets another reservation proceed', async () => {
  const journal = { blocks: vi.fn(() => false) } as unknown as ReservationRunJournal;
  const runs = new ReservationBackgroundRuns(journal, vi.fn());
  let finish!: () => void; const wait = new Promise<void>(resolve => { finish = resolve; });
  expect(runs.start('a', 'same-chat', () => wait)).toBe(true);
  expect(runs.start('a', 'other-chat', vi.fn())).toBe(false);
  expect(runs.start('b', 'same-chat', vi.fn())).toBe(false);
  const other = vi.fn(async () => {});
  expect(runs.start('b', 'other-chat', other)).toBe(true);
  await Promise.resolve(); expect(other).toHaveBeenCalledOnce(); expect(runs.busy('a', 'same-chat')).toBe(true);
  finish(); await runs.drain(); expect(runs.count).toBe(0);
});
it('keeps a crashed or unconfirmed native turn blocked by its durable journal', async () => {
  let durable = false;
  const journal = { blocks: () => durable } as unknown as ReservationRunJournal, log = vi.fn();
  const runs = new ReservationBackgroundRuns(journal, log);
  expect(runs.start('a', 'chat', async () => { durable = true; throw new Error('contains-secret'); })).toBe(true);
  await runs.drain();
  expect(runs.start('a', 'chat', vi.fn())).toBe(false); expect(log.mock.calls.flat().join('')).not.toContain('contains-secret');
});

it('refuses only native admission when its journal is unreadable instead of throwing into the legacy tick', () => {
  const journal = { blocks: () => { throw new Error('corrupted'); } } as unknown as ReservationRunJournal;
  const runs = new ReservationBackgroundRuns(journal, vi.fn());
  expect(runs.start('a', 'chat', vi.fn())).toBe(false);
  expect(runs.count).toBe(0);
});

it('counts reserved GitHub work before claim without counting ordinary reservations against its concurrency limit', async () => {
  const runs = new ReservationBackgroundRuns({ blocks: () => false } as never, vi.fn());
  const github = runs.reserve('github', 'review', { github: true })!;
  const ordinary = runs.reserve('ordinary', 'chat')!;
  expect(runs.githubCount).toBe(1); expect(runs.count).toBe(2);
  github.release(); ordinary.release(); await runs.drain(); expect(runs.githubCount).toBe(0);
});
