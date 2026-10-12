/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary strict-followup-plan F0-b (daemon 2, Q12 a) —
 * worktree tickets used on this machine, kept on disk until they expire.
 *
 * The in-memory guard forgot every ticket when the daemon restarted, so a ticket used just before a
 * restart could run again inside its validity window. The record lives in the daemon's own home
 * (internal IO only; remote file handlers cannot reach it, R11) and is written atomically, 0600.
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger } from '@/ui/logger';
import type { NonceAdmission } from '@/api/rpc/rpcNonceGuard';

type Record = { v: 1; entries: { [opId: string]: number } };

export class DurableTicketGuard {
    /** opId → when a replay of it would fail the time check anyway. Null until read from disk. */
    private entries: Map<string, number> | null = null;
    /** Admissions run one at a time: two uses of one ticket must not both see it unused. */
    private queue: Promise<unknown> = Promise.resolve();

    constructor(private readonly options: { file: string; windowMs: number; maxEntries: number }) {}

    admit(opId: string, issuedAt: number, now: number): Promise<NonceAdmission> {
        const next = this.queue.then(() => this.admitNow(opId, issuedAt, now));
        this.queue = next.catch(() => undefined);
        return next;
    }

    private async admitNow(opId: string, issuedAt: number, now: number): Promise<NonceAdmission> {
        const entries = await this.load();
        for (const [seen, expiresAt] of entries) {
            if (expiresAt < now) entries.delete(seen);
        }
        if (entries.has(opId)) return 'replayed';
        if (entries.size >= this.options.maxEntries) return 'full';
        entries.set(opId, issuedAt + this.options.windowMs);
        await this.save(entries);
        return 'admitted';
    }

    private async load(): Promise<Map<string, number>> {
        if (this.entries) return this.entries;
        const entries = new Map<string, number>();
        try {
            const parsed = JSON.parse(await readFile(this.options.file, 'utf8')) as Partial<Record>;
            for (const [opId, expiresAt] of Object.entries(parsed?.entries ?? {})) {
                if (typeof expiresAt === 'number' && Number.isFinite(expiresAt)) entries.set(opId, expiresAt);
            }
        } catch (error) {
            // Missing on first use; unreadable after a crash mid-write is not possible (rename), but a
            // hand-edited file must not stop every worktree operation.
            if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
                logger.debug('[worktree-ops] used-ticket record unreadable, starting empty', { error: String(error) });
            }
        }
        this.entries = entries;
        return entries;
    }

    private async save(entries: Map<string, number>): Promise<void> {
        const record: Record = { v: 1, entries: Object.fromEntries(entries) };
        await mkdir(dirname(this.options.file), { recursive: true, mode: 0o700 });
        const temporary = `${this.options.file}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, this.options.file);
    }
}
