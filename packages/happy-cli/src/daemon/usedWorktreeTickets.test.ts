/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary strict-followup-plan F0-b (daemon 2, Q12 a):
 * a used worktree ticket stays used until it expires, across a daemon restart too.
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DurableTicketGuard } from './usedWorktreeTickets';

const WINDOW = 60_000;

function guardFile(): string {
    return join(mkdtempSync(join(tmpdir(), 'used-tickets-')), 'worktree-used-tickets.json');
}

describe('DurableTicketGuard', () => {
    it('refuses a ticket used before a restart', async () => {
        const file = guardFile();
        expect(await new DurableTicketGuard({ file, windowMs: WINDOW, maxEntries: 10 }).admit('op-1', 1_000, 2_000)).toBe('admitted');
        const restarted = new DurableTicketGuard({ file, windowMs: WINDOW, maxEntries: 10 });
        expect(await restarted.admit('op-1', 1_000, 3_000)).toBe('replayed');
        expect(await restarted.admit('op-2', 1_000, 3_000)).toBe('admitted');
    });

    it('forgets tickets once they would fail the time check anyway', async () => {
        const file = guardFile();
        await new DurableTicketGuard({ file, windowMs: WINDOW, maxEntries: 10 }).admit('op-1', 1_000, 2_000);
        const later = new DurableTicketGuard({ file, windowMs: WINDOW, maxEntries: 10 });
        expect(await later.admit('op-2', 70_000, 70_000)).toBe('admitted');
        expect(JSON.parse(readFileSync(file, 'utf8')).entries).toEqual({ 'op-2': 130_000 });
    });

    it('keeps the record private to the daemon user', async () => {
        const file = guardFile();
        await new DurableTicketGuard({ file, windowMs: WINDOW, maxEntries: 10 }).admit('op-1', 1_000, 2_000);
        if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    });

    it('starts empty from an unreadable record rather than refusing every operation', async () => {
        const file = guardFile();
        writeFileSync(file, 'not json');
        expect(await new DurableTicketGuard({ file, windowMs: WINDOW, maxEntries: 10 }).admit('op-1', 1_000, 2_000)).toBe('admitted');
    });

    it('refuses when the window is full, as the in-memory guard does', async () => {
        const guard = new DurableTicketGuard({ file: guardFile(), windowMs: WINDOW, maxEntries: 1 });
        expect(await guard.admit('op-1', 1_000, 2_000)).toBe('admitted');
        expect(await guard.admit('op-2', 1_000, 2_000)).toBe('full');
    });

    it('admits one of two concurrent uses of the same ticket', async () => {
        const guard = new DurableTicketGuard({ file: guardFile(), windowMs: WINDOW, maxEntries: 10 });
        const answers = await Promise.all([guard.admit('op-1', 1_000, 2_000), guard.admit('op-1', 1_000, 2_000)]);
        expect(answers.sort()).toEqual(['admitted', 'replayed']);
    });
});
