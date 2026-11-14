/**
 * Keeps a provider usage event in memory until the server confirms it stored it.
 *
 * The server answers `provider-usage-report` with `{ success: true }` once the event is in its
 * durable outbox, and storing is idempotent on `sourceEventId`, so sending again is always safe.
 * An event leaves this list on that confirmation and on nothing else: no answer, a storage
 * failure, a refusal and the retry limit all keep it here and say so in the log.
 *
 * With a store, events survive restart and are recovered on session resume. Without one,
 * pending events are memory-only. Storage failures are reported and never treated as durable.
 */
import type { ProviderUsageEventV1 } from '@slopus/happy-wire';
import { logger } from '@/ui/logger';
import type { ProviderUsageStore } from './providerUsageSpool';

export const PROVIDER_USAGE_ACK_TIMEOUT_MS = 10_000;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;
/** Sends without a confirmation before an event waits for a sign that the server stores again. */
const MAX_ATTEMPTS = 5;
const CLOSE_WAIT_MS = 2000;
const CLOSE_REPORTED_IDS = 20;
/** What the server answers about the event itself: the same event gets the same answer again. */
const REFUSALS = new Set(['Invalid provider usage event', 'Session not found']);

type Ack = (error: Error | null, response?: unknown) => void;

type Unconfirmed = {
    event: ProviderUsageEventV1;
    attempts: number;
    durable: boolean;
    /** Sends still owed an answer; while any is, the event is not sent again by a retry. */
    inFlight: number;
    /** Why it is no longer retried on a timer, or null while it is. */
    held: string | null;
};

export class ProviderUsageDelivery {
    private readonly unconfirmed = new Map<string, Unconfirmed>();
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private retryDelayMs = RETRY_BASE_MS;
    private closed = false;
    private onAnswer: (() => void) | null = null;

    constructor(private readonly socket: {
        isConnected: () => boolean;
        /** Sends the event; `ack` is called with the server's answer, or an error when none came in time. */
        emit: (event: ProviderUsageEventV1, ack: Ack) => void;
    }, private readonly store?: ProviderUsageStore) {
        for (const event of store?.load() ?? []) {
            this.unconfirmed.set(event.sourceEventId, { event, attempts: 0, inFlight: 0, held: null, durable: true });
        }
    }

    send(event: ProviderUsageEventV1): void {
        let entry = this.unconfirmed.get(event.sourceEventId);
        if (!entry) {
            entry = { event, attempts: 0, inFlight: 0, held: null, durable: false };
            this.unconfirmed.set(event.sourceEventId, entry);
        }
        this.emit(entry);
    }

    /** A new connection: every unconfirmed event is asked again, refused and limited ones included. */
    resume(): void {
        for (const entry of this.unconfirmed.values()) {
            entry.held = null;
            entry.attempts = 0;
        }
        this.retryDelayMs = RETRY_BASE_MS;
        this.sendIdle();
    }

    unconfirmedIds(): string[] {
        return [...this.unconfirmed.keys()];
    }

    /**
     * Waits a bounded time for the answers still owed, then reports what stays unconfirmed.
     * Nothing is retried afterwards.
     */
    async close(): Promise<void> {
        this.closed = true;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        if (this.unconfirmed.size === 0) return;

        this.sendIdle();
        // An answer can only come over a live connection.
        if (this.socket.isConnected() && [...this.unconfirmed.values()].some(entry => entry.inFlight > 0)) {
            await new Promise<void>((resolve) => {
                const finish = () => {
                    clearTimeout(timer);
                    this.onAnswer = null;
                    resolve();
                };
                const timer = setTimeout(finish, CLOSE_WAIT_MS);
                this.onAnswer = () => {
                    if (![...this.unconfirmed.values()].some(entry => entry.inFlight > 0)) finish();
                };
            });
        }
        if (this.unconfirmed.size === 0) return;

        const reasons: Record<string, number> = {};
        for (const entry of this.unconfirmed.values()) {
            const reason = entry.held ?? 'unanswered';
            reasons[reason] = (reasons[reason] ?? 0) + 1;
        }
        logger.warn(this.store ? '[SOCKET] Provider usage events unconfirmed at close; only persisted events are recoverable; never-persisted events are lost with this process' : '[SOCKET] Provider usage events left unconfirmed at close; they are held in memory only and are lost with this process', {
            count: this.unconfirmed.size,
            reasons,
            neverPersistedCount: [...this.unconfirmed.values()].filter(entry => !entry.durable).length,
            neverPersistedSourceEventIds: [...this.unconfirmed.values()].filter(entry => !entry.durable).slice(0, CLOSE_REPORTED_IDS).map(entry => entry.event.sourceEventId),
            sourceEventIds: this.unconfirmedIds().slice(0, CLOSE_REPORTED_IDS),
        });
    }

    private persist(entry: Unconfirmed): void {
        if (!this.store || entry.durable) return;
        try { this.store.put(entry.event); entry.durable = true; }
        catch {
            logger.warn('[SOCKET] Provider usage persistence failed; live delivery remains available', { sourceEventId: entry.event.sourceEventId });
            this.scheduleRetry();
        }
    }

    private emit(entry: Unconfirmed): void {
        this.persist(entry);
        if (!this.socket.isConnected()) return;
        entry.inFlight += 1;
        this.socket.emit(entry.event, (error, response) => {
            entry.inFlight -= 1;
            // Confirmed meanwhile by another send of the same event: this answer changes nothing.
            if (this.unconfirmed.get(entry.event.sourceEventId) === entry) this.settle(entry, error, response);
            this.onAnswer?.();
        });
    }

    private settle(entry: Unconfirmed, error: Error | null, response: unknown): void {
        const sourceEventId = entry.event.sourceEventId;
        const answer = !error && response !== null && typeof response === 'object'
            ? response as { success?: unknown; error?: unknown }
            : null;
        if (answer?.success === true) {
            try { this.store?.remove(sourceEventId); }
            catch {
                logger.warn('[SOCKET] Acknowledged usage spool cleanup failed; retained for idempotent retry');
                this.scheduleRetry();
                return;
            }
            this.unconfirmed.delete(sourceEventId);
            this.retryDelayMs = RETRY_BASE_MS;
            // The server stores again: events that ran out of attempts get another round.
            for (const other of this.unconfirmed.values()) {
                if (other.held !== 'retry-limit') continue;
                other.held = null;
                other.attempts = 0;
            }
            if (!this.closed) this.sendIdle();
            return;
        }
        // Another send of the same event is still out; its answer decides.
        if (entry.inFlight > 0) return;

        if (answer?.success === false && typeof answer.error === 'string' && REFUSALS.has(answer.error)) {
            entry.held = `refused: ${answer.error}`;
            logger.warn('[SOCKET] Provider usage event refused by the server; kept unconfirmed until the next connection', {
                sourceEventId, error: answer.error,
            });
            return;
        }
        entry.attempts += 1;
        if (entry.attempts >= MAX_ATTEMPTS) {
            entry.held = 'retry-limit';
            logger.warn('[SOCKET] Provider usage event unconfirmed at the retry limit; kept until the server stores again or reconnects', {
                sourceEventId, attempts: entry.attempts,
            });
            return;
        }
        logger.debug('[SOCKET] Provider usage event not confirmed; will retry', { sourceEventId, attempts: entry.attempts });
        this.scheduleRetry();
    }

    private scheduleRetry(): void {
        if (this.closed || this.retryTimer) return;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.sendIdle();
        }, this.retryDelayMs);
        this.retryTimer.unref?.();
        this.retryDelayMs = Math.min(RETRY_MAX_MS, this.retryDelayMs * 2);
    }

    /** Sends what is neither held nor waiting for an answer. */
    private sendIdle(): void {
        for (const entry of this.unconfirmed.values()) {
            if (entry.held === null && entry.inFlight === 0) this.emit(entry);
            else this.persist(entry);
        }
    }
}
