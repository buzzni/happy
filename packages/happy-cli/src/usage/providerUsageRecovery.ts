import { opendirSync, readFileSync, statSync, existsSync, type Dir } from 'node:fs';
import { join } from 'node:path';
import { isAcknowledgedCiphertext } from './managedUsageSpool';
import { decrypt } from '@/api/encryption';
import { logger } from '@/ui/logger';
import { ProviderUsageSpool } from './providerUsageSpool';
import type { ProviderUsageEventV1 } from '@slopus/happy-wire';
export type UsageRecoverySession = { sessionId: string; key: Uint8Array; variant: 'legacy' | 'dataKey' };
type Candidate = { name: string; file: string };
type Options = {
    root: string; server: string; recoveryKey: Uint8Array; eventRoot?: string;
    resolve: (id: string, sealedSession?: UsageRecoverySession) => Promise<UsageRecoverySession | null>;
    send: (event: ProviderUsageEventV1) => Promise<boolean | { held: 'authorization-denied'; authorization: string }>;
    authorization?: () => Promise<string | null>;
    legacyPage?: () => Promise<UsageRecoverySession[] | { sessions: UsageRecoverySession[]; done: boolean }>;
    batchSize?: number;
};
/** Bounded, cursor-based local discovery. Empty queues never cause network requests. */
export class ProviderUsageRecovery {
    private directories?: Dir;
    private probe?: { name: string; reader: Dir };
    private legacy?: Candidate;
    private current?: ProviderUsageSpool;
    private running?: Promise<void>;
    private timer?: ReturnType<typeof setTimeout>;
    private stopped = false;
    private delay = 1000;
    constructor(private readonly options: Options) {}
    start(): void {
        if (this.stopped || this.timer) return;
        const tick = async () => { await this.runOnce(); if (!this.stopped) { this.timer = setTimeout(tick, this.delay); this.timer.unref(); } };
        this.timer = setTimeout(tick, 0); this.timer.unref();
    }
    runOnce(): Promise<void> {
        if (this.stopped) return Promise.resolve();
        if (this.running) return this.running;
        this.running = this.scan().catch(() => {
            this.delay = Math.min(300_000, this.delay * 2);
            logger.warn('[USAGE] Daemon recovery deferred; pending files retained');
        }).finally(() => { this.running = undefined; });
        return this.running;
    }
    private pending(): Candidate | undefined {
        const opts = this.options;
        if (!this.directories) {
            try { this.directories = opendirSync(opts.root); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
        }
        let budget = 100;
        for (let i = 0; i < 32; i++) {
            if (!this.probe) {
                const entry = this.directories.readSync();
                if (!entry) { this.directories.closeSync(); this.directories = undefined; return; }
                if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
                try { this.probe = { name: entry.name, reader: opendirSync(join(opts.eventRoot ?? opts.root, entry.name)) }; }
                catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
            }
            while (budget-- > 0) {
                const file = this.probe.reader.readSync();
                if (!file) { this.probe.reader.closeSync(); this.probe = undefined; break; }
                if (!file.isFile() || !/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
                if (opts.eventRoot && isAcknowledgedCiphertext(join(opts.root, this.probe.name, `${file.name}.ack`), join(opts.eventRoot, this.probe.name, file.name))) continue;
                const candidate = { name: this.probe.name, file: file.name };
                this.probe.reader.closeSync(); this.probe = undefined;
                return candidate;
            }
            if (budget <= 0) return;
        }
        return undefined;
    }
    private spool(session: UsageRecoverySession): ProviderUsageSpool {
        const opts = this.options;
        return new ProviderUsageSpool({ ...opts, ...session, root: opts.eventRoot ?? opts.root, ackRoot: opts.eventRoot ? opts.root : undefined });
    }
    private async scan(): Promise<void> {
        const opts = this.options;
        if (!this.current) {
            const candidate = this.pending();
            if (candidate) {
                const manifest = join(opts.root, candidate.name, 'identity.enc');
                if (!existsSync(manifest)) this.legacy ??= candidate;
                else {
                    try {
                        if (statSync(manifest).size > 4096) throw new Error('oversize identity');
                        const identity = decrypt(opts.recoveryKey, 'dataKey', Buffer.from(readFileSync(manifest, 'utf8'), 'base64'));
                        if (!identity) logger.warn('[USAGE] Recovery identity cannot be opened with current credentials; encrypted files retained');
                        if (identity?.version === 1 && identity.server === new URL(opts.server).origin && typeof identity.sessionId === 'string') {
                            const sealed = identity.variant === 'dataKey' && typeof identity.key === 'string' && Buffer.from(identity.key, 'base64').length === 32
                                ? { sessionId: identity.sessionId, key: Buffer.from(identity.key, 'base64'), variant: 'dataKey' as const } : undefined;
                            const authorization = await opts.authorization?.();
                            if (authorization && sealed && this.spool(sealed).isHeld(authorization)) {
                                this.delay = 1000; return;
                            }
                            const session = await opts.resolve(identity.sessionId, sealed);
                            if (!session || session.sessionId !== identity.sessionId) throw new Error('credential unavailable');
                            const spool = this.spool(session);
                            if (spool.directory !== join(opts.eventRoot ?? opts.root, candidate.name)) throw new Error('key mismatch');
                            this.current = spool;
                        }
                    } catch { logger.warn('[USAGE] Recovery identity unavailable; pending directory retained'); }
                }
            }
        }
        if (this.legacy && opts.legacyPage) {
            try {
                const result = await opts.legacyPage();
                const sessions = Array.isArray(result) ? result : result.sessions;
                for (const session of sessions.slice(0, 20)) {
                    const spool = this.spool(session);
                    if (spool.directory !== join(opts.root, this.legacy.name)) continue;
                    const authorized = await opts.resolve(session.sessionId, session);
                    if (!authorized || this.spool(authorized).directory !== spool.directory) throw new Error('legacy authorization unavailable');
                    spool.registerRecovery(this.legacy.file);
                    if (!this.current) this.current = spool;
                    this.legacy = undefined; break;
                }
                if (this.legacy && (Array.isArray(result) || result.done)) {
                    logger.warn('[USAGE] Legacy spool has no authorized usable key; pending files retained'); this.legacy = undefined;
                }
            } catch { logger.warn('[USAGE] Legacy discovery unavailable; pending files retained'); }
        }
        if (!this.current) { this.delay = this.probe || this.directories ? 1000 : 30_000; return; }
        const spool = this.current;
        const batch = spool.readBatch(Math.max(1, Math.min(100, opts.batchSize ?? 100)));
        let failed = false;
        for (const event of batch.events) {
            if (this.stopped) break;
            try {
                const result = await opts.send(event);
                if (result === true) { spool.remove(event.sourceEventId); spool.clearHold(); }
                else if (typeof result === 'object' && result.held === 'authorization-denied') {
                    const authorization = result.authorization;
                    if (!authorization) throw new Error('hold authorization identity unavailable');
                    spool.hold(authorization); spool.closeReader(); this.current = undefined; this.delay = 1000;
                    logger.warn('[USAGE] Managed replay authorization denied; session queue held until protected daemon credential changes', { sessionId: event.sessionId });
                    return;
                } else failed = true;
            }
            catch { failed = true; }
        }
        if (batch.done) { spool.closeReader(); this.current = undefined; }
        if (failed) { this.delay = Math.min(300_000, this.delay * 2); logger.warn('[USAGE] Daemon replay unacknowledged; pending files retained'); }
        else this.delay = 1000;
    }
    async stop(): Promise<void> {
        this.stopped = true; clearTimeout(this.timer); await this.running;
        this.current?.closeReader(); this.current = undefined;
        this.probe?.reader.closeSync(); this.probe = undefined;
        this.directories?.closeSync(); this.directories = undefined;
    }
}
