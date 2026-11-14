import { createHash, randomUUID } from 'node:crypto';
import { closeSync, rmdirSync, fsyncSync, mkdirSync, chmodSync, fchmodSync, openSync, linkSync, renameSync, existsSync, opendirSync, type Dir, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ProviderUsageEventV1Schema, type ProviderUsageEventV1 } from '@slopus/happy-wire';
import { decrypt, encrypt } from '@/api/encryption';
import { isAcknowledgedCiphertext, readBoundedUsageFile } from './managedUsageSpool';
import { logger } from '@/ui/logger';

export interface ProviderUsageStore {
    load(): ProviderUsageEventV1[];
    put(event: ProviderUsageEventV1): void;
    remove(sourceEventId: string): void;
}
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/** Per-session encrypted spool. Only an acknowledged event is removed; retries are server-idempotent. */
export class ProviderUsageSpool implements ProviderUsageStore {
    readonly directory: string;
    private reader: Dir | undefined;
    private observed = new Map<string, string>();
    constructor(private readonly scope: { root: string; server: string; sessionId: string; key: Uint8Array; variant: 'legacy' | 'dataKey'; recoveryKey?: Uint8Array; publicCiphertext?: boolean; ackRoot?: string }) {
        this.directory = join(scope.root, hash(JSON.stringify([new URL(scope.server).origin, scope.sessionId, scope.variant, hash(scope.key)])));
    }
    registerRecovery(pendingFile: string): void {
        if (!/^[a-f0-9]{64}\.json$/.test(pendingFile) || !existsSync(join(this.directory, pendingFile))) return;
        this.provisionRecovery();
    }
    /** Trusted parent provisioning: the key remains sealed in the daemon's private directory. */
    provisionRecovery(): void {
        if (!this.scope.recoveryKey || existsSync(join(this.directory, 'identity.enc'))) return;
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        this.commit('identity.enc', Buffer.from(encrypt(this.scope.recoveryKey, 'dataKey', {
            version: 1, server: new URL(this.scope.server).origin, sessionId: this.scope.sessionId,
            ...(this.scope.variant === 'dataKey' ? { key: Buffer.from(this.scope.key).toString('base64'), variant: 'dataKey' } : {}),
        })).toString('base64'));
    }
    /** Holds only a directory cursor, never a full queue in memory. */
    readBatch(limit: number): { events: ProviderUsageEventV1[]; done: boolean } {
        if (!this.reader) {
            try { this.reader = opendirSync(this.directory); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], done: true }; throw error; }
        }
        this.observed.clear();
        const events: ProviderUsageEventV1[] = [];
        const eventLimit = Math.max(1, Math.min(100, Math.floor(limit) || 1));
        // Bound filesystem work independently of the number of accepted events.
        for (let scanned = 0; scanned < 1000 && events.length < eventLimit; scanned++) {
            const entry = this.reader.readSync();
            if (!entry) { this.closeReader(); return { events, done: true }; }
            if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
            const event = this.readEvent(entry.name);
            if (event) events.push(event);
        }
        return { events, done: false };
    }
    closeReader(): void { this.reader?.closeSync(); this.reader = undefined; }
    private readEvent(file: string): ProviderUsageEventV1 | null {
        try {
            if (this.scope.ackRoot && isAcknowledgedCiphertext(join(this.scope.ackRoot, basename(this.directory), `${file}.ack`), join(this.directory, file))) return null;
            const ciphertext = readBoundedUsageFile(join(this.directory, file), 1024 * 1024);
            const event = ProviderUsageEventV1Schema.parse(decrypt(this.scope.key, this.scope.variant, Buffer.from(ciphertext, 'base64')));
            if (event.sessionId !== this.scope.sessionId || file !== `${hash(event.sourceEventId)}.json`) throw new Error('scope mismatch');
            if (this.scope.ackRoot) this.observed.set(event.sourceEventId, hash(ciphertext));
            return event;
        } catch {
            logger.warn('[USAGE] Unreadable spool event retained', { file });
            return null;
        }
    }
    load(): ProviderUsageEventV1[] {
        let files: string[];
        try { files = readdirSync(this.directory); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
        const events: ProviderUsageEventV1[] = [];
        for (const file of files.filter(name => name.endsWith('.json'))) {
            const event = this.readEvent(file);
            if (event) events.push(event);
        }
        if (events[0]) this.registerRecovery(`${hash(events[0].sourceEventId)}.json`);
        return events;
    }
    put(event: ProviderUsageEventV1): void {
        const parsed = ProviderUsageEventV1Schema.parse(event);
        if (parsed.sessionId !== this.scope.sessionId) throw new Error('Usage spool session mismatch');
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        if (this.scope.publicCiphertext) chmodSync(this.directory, 0o755);
        // Identity is committed before the first event: a crash at event commit must remain discoverable.
        this.provisionRecovery();
        const name = `${hash(parsed.sourceEventId)}.json`;
        if (!this.commit(name, Buffer.from(encrypt(this.scope.key, this.scope.variant, parsed)).toString('base64'))) {
            const existing = this.readEvent(name);
            if (!existing || JSON.stringify(existing) !== JSON.stringify(parsed)) throw new Error('Usage spool conflicting event retained');
        }

    }
    private commit(name: string, contents: string, replace = false): boolean {
        const temporary = join(this.directory, `${randomUUID()}.tmp`);
        let fd: number | undefined;
        try {
            fd = openSync(temporary, 'wx', this.scope.publicCiphertext ? 0o644 : 0o600);
            if (this.scope.publicCiphertext) fchmodSync(fd, 0o644);
            writeFileSync(fd, contents);
            fsyncSync(fd);
            closeSync(fd); fd = undefined;
            try { if (replace) renameSync(temporary, join(this.directory, name)); else linkSync(temporary, join(this.directory, name)); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
            this.syncDirectory();
            return true;
        } finally {
            if (fd !== undefined) { try { closeSync(fd); } catch { logger.warn('[USAGE] Temporary spool handle cleanup failed'); } }
            try { unlinkSync(temporary); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn('[USAGE] Temporary spool file cleanup failed'); }
        }
    }

    private privateStore(): ProviderUsageSpool {
        return new ProviderUsageSpool({ ...this.scope, root: this.scope.ackRoot ?? this.scope.root, publicCiphertext: false, ackRoot: undefined });
    }
    isHeld(authorization: string): boolean {
        const store = this.privateStore();
        const path = join(store.directory, 'held.enc');
        if (!existsSync(path)) return false;
        try {
            const proof = decrypt(this.scope.recoveryKey!, 'dataKey', Buffer.from(readBoundedUsageFile(path, 4096), 'base64'));
            return proof?.version === 1 && proof.sessionId === this.scope.sessionId && proof.server === new URL(this.scope.server).origin
                && proof.authorization === authorization && proof.reason === 'authorization-denied';
        } catch { logger.warn('[USAGE] Unreadable replay hold retained; server authorization still required'); return false; }
    }
    hold(authorization: string): void {
        if (!this.scope.recoveryKey) throw new Error('replay hold needs protected recovery identity');
        const store = this.privateStore(); mkdirSync(store.directory, { recursive: true, mode: 0o700 });
        store.commit('held.enc', Buffer.from(encrypt(this.scope.recoveryKey, 'dataKey', { version: 1, sessionId: this.scope.sessionId,
            server: new URL(this.scope.server).origin, authorization, reason: 'authorization-denied' })).toString('base64'), true);
    }
    clearHold(): void {
        const store = this.privateStore();
        try { unlinkSync(join(store.directory, 'held.enc')); store.syncDirectory(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    remove(sourceEventId: string): void {
        if (this.scope.ackRoot) {
            const directory = join(this.scope.ackRoot, basename(this.directory));
            const marker = new ProviderUsageSpool({ ...this.scope, root: this.scope.ackRoot, publicCiphertext: false, ackRoot: undefined });
            mkdirSync(directory, { recursive: true, mode: 0o700 });
            const digest = this.observed.get(sourceEventId);
            if (!digest) throw new Error('usage ACK has no observed ciphertext identity');
            marker.commit(`${hash(sourceEventId)}.json.ack`, JSON.stringify({ digest }), true);
            this.observed.delete(sourceEventId);
            return;
        }
        try { unlinkSync(join(this.directory, `${hash(sourceEventId)}.json`)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
        this.syncDirectory();
        // Never unlink identity/hold/temporary files: another writer may need them.
        // rmdir is atomic and refuses any nonempty directory, including concurrent writes.
        try { rmdirSync(this.directory); this.closeReader(); }
        catch (error) {
            if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) {
                logger.warn('[USAGE] Empty spool directory cleanup failed');
            }
        }
    }
    private syncDirectory(): void {
        // Windows cannot open directories for fsync; the event file was flushed before rename.
        if (process.platform === 'win32') return;
        const fd = openSync(this.directory, 'r');
        try { fsyncSync(fd); } finally { closeSync(fd); }
    }
}
