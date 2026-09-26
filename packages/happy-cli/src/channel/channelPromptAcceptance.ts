import { randomUUID } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * Accepting one channel-relayed turn into a running session
 * (Saycode specs/desktop-messenger-channels — R7/R10/R12).
 *
 * Owned here rather than under one engine because both the Claude and Codex loops register the
 * same handler against it, and the ordering below is the contract they share — not an
 * implementation detail of either:
 *
 * - **Accepted means durable *and* queued.** The record is written through the session's outbox
 *   and the acknowledgement is awaited before anything claims acceptance. `sendSessionProtocolMessage`
 *   on its own only enqueues into an in-memory outbox, so returning at that point would report a
 *   request as safely taken when a crash would still lose it.
 * - **A proven failure is not a duplicate.** If the record provably never went out, the id is
 *   released so a retry is admitted rather than answered "already have it" for work that never
 *   ran. Anything less certain is remembered as `unknown` instead.
 * - **Ambiguity stays ambiguous, permanently.** A deadline, or a queue that threw after inserting,
 *   may or may not have admitted the work. That verdict is recorded and never expires: forgetting
 *   it would turn an uncertain request back into an executable one, which is the one outcome R7
 *   rules out. Evidence of execution is not evicted to save memory — new ids are refused instead.
 * - **Same id, different text is a conflict.** A redelivery repeats the payload; a *different*
 *   payload under a used id is either a bug or an attempt to reuse a handle, and neither should
 *   silently run.
 * - **The runtime is named.** The caller proved a specific process; if this is no longer that
 *   process, it refuses rather than accepting work that was authorized against another one.
 */

export type ChannelAcceptanceResult =
    | { ok: true; accepted: boolean; duplicate: boolean; protocolVersion: 1 }
    | { ok: false; error: string; unknown?: true };

/**
 * What happened to an id, once. `unknown` is a first-class outcome and is remembered: a retry for
 * an id whose fate is uncertain must stay uncertain rather than be admitted again or reported as
 * a clean duplicate.
 */
type AcceptanceState = 'accepted' | 'unknown';

export const CHANNEL_ACCEPTANCE_PROTOCOL_VERSION = 1;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_TEXT_BYTES = 64 * 1024;
/**
 * Hard ceilings. Reached by refusing new work, not by discarding what is already recorded — see
 * the class comment.
 */
const MAX_REMEMBERED = 2_000;
const MAX_IN_FLIGHT = 64;
const DEFAULT_ACK_DEADLINE_MS = 30_000;

export interface ChannelPromptRequest {
    text: string;
    requestId: string;
    /**
     * Required. This protocol only exists because probe-then-send is two operations; a delivery
     * that does not name the runtime it was authorized against cannot be checked against a
     * replacement, which is the whole point.
     */
    expectedRuntimeId: string;
}

/** Strict and bounded: unknown fields are refused rather than ignored. */
export function parseChannelPromptRequest(params: unknown): ChannelPromptRequest | null {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
    const record = params as Record<string, unknown>;
    for (const key of Object.keys(record)) {
        if (key !== 'text' && key !== 'requestId' && key !== 'expectedRuntimeId') return null;
    }
    const { text, requestId, expectedRuntimeId } = record;
    if (typeof text !== 'string' || text.trim().length === 0) return null;
    if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) return null;
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > MAX_REQUEST_ID_LENGTH) {
        return null;
    }
    if (typeof expectedRuntimeId !== 'string'
        || expectedRuntimeId.length === 0
        || expectedRuntimeId.length > MAX_REQUEST_ID_LENGTH) {
        return null;
    }
    return { text, requestId, expectedRuntimeId };
}

export interface ChannelAcceptanceDeps {
    /** This process's identity, so work authorized against another runtime is refused. */
    runtimeId: string;
    /**
     * True for a managed run, which answers exactly the prompt its envelope was admitted for.
     * Free-text arriving outside that admission is refused everywhere else in the loop
     * (`onUserMessage`, the follow-up handler); this path must not be the one exception, or a
     * channel message becomes a way to add unpriced work to an admitted run.
     */
    isManagedRun?: () => boolean;
    /**
     * Writes the display-only record and resolves once the server has acknowledged it.
     * `ambiguous` means the write may still land; only an explicit `provenNotWritten` is safe to
     * retry cleanly.
     */
    recordDurably(input: { text: string; localId: string }): Promise<
        { ok: true } | { ok: false; provenNotWritten: boolean }
    >;
    /**
     * Admits the turn. A throw is **ambiguous**, not a clean failure: the queue inserts the item
     * and only then runs its notification callbacks, so a throw can happen after the work is
     * already sitting in the queue. Releasing the id on every throw would let a retry queue it a
     * second time.
     */
    enqueue(input: { text: string; requestId: string }): void;
    /** Emits a live authenticated session event, never a transcript/history replay. */
    requestApproval?(input: { requestId: string; runtimeId: string; nonce: string }): void;
    now(): number;
}

interface AcceptedRecord {
    at: number;
    payloadHash: string;
    state: AcceptanceState;
}

function hashPayload(text: string): string {
    return bytesToHex(sha256(new TextEncoder().encode(text)));
}

export class ChannelPromptAcceptance {
    private readonly seen = new Map<string, AcceptedRecord>();
    /** In-flight acceptances, so two concurrent calls for one id do not both admit. */
    private readonly inFlight = new Map<string, { payloadHash: string; result: Promise<ChannelAcceptanceResult> }>();

    private readonly cancelled = new Set<string>();
    private readonly started = new Set<string>();
    private readonly permits = new Set<string>();
    private readonly approvalWaiters = new Map<string, { nonce: string; finish: (allow: boolean) => void }>();

    constructor(private readonly deps: ChannelAcceptanceDeps) {}

    /** Authenticated session RPC; cancellation is scoped to one immutable request/runtime pair. */
    cancel(params: unknown): { ok: true; state: 'cancelled' | 'already-started' } | { ok: false; error: string } {
        if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, error: 'invalid cancellation' };
        const value = params as Record<string, unknown>;
        if (Object.keys(value).some(key => key !== 'requestId' && key !== 'expectedRuntimeId')
            || typeof value.requestId !== 'string' || !value.requestId || value.requestId.length > MAX_REQUEST_ID_LENGTH
            || value.expectedRuntimeId !== this.deps.runtimeId) return { ok: false, error: 'invalid cancellation' };
        if (this.started.has(value.requestId)) return { ok: true, state: 'already-started' };
        if (!this.seen.has(value.requestId) && !this.inFlight.has(value.requestId)
            && !this.cancelled.has(value.requestId) && this.rememberedCount() >= MAX_REMEMBERED) {
            return { ok: false, error: 'this session has too many recorded channel requests' };
        }
        this.cancelled.add(value.requestId);
        this.approvalWaiters.get(value.requestId)?.finish(false);
        return { ok: true, state: 'cancelled' };
    }

    /** Called synchronously at the actual provider boundary, after preparation awaits. */
    beginExecution(requestId: string): boolean {
        if (this.cancelled.has(requestId) || this.started.has(requestId)
            || this.seen.get(requestId)?.state !== 'accepted' || !this.permits.delete(requestId)) return false;
        this.started.add(requestId);
        return true;
    }

    /** A queued request must obtain fresh authority when it is actually ready to execute. */
    prepareExecution(requestId: string): Promise<boolean> {
        if (this.cancelled.has(requestId) || this.started.has(requestId) || this.approvalWaiters.has(requestId) || this.permits.has(requestId)
            || this.seen.get(requestId)?.state !== 'accepted' || !this.deps.requestApproval) return Promise.resolve(false);
        const nonce = randomUUID();
        return new Promise(resolve => {
            const timer = setTimeout(() => finish(false), DEFAULT_ACK_DEADLINE_MS);
            const finish = (allow: boolean) => {
                if (this.approvalWaiters.get(requestId)?.nonce !== nonce) return;
                clearTimeout(timer);
                this.approvalWaiters.delete(requestId);
                if (allow && !this.cancelled.has(requestId)) this.permits.add(requestId);
                else this.cancelled.add(requestId);
                resolve(allow && !this.cancelled.has(requestId));
            };
            this.approvalWaiters.set(requestId, { nonce, finish });
            try { this.deps.requestApproval!({ requestId, runtimeId: this.deps.runtimeId, nonce }); }
            catch { finish(false); }
        });
    }

    /** A single-use response from Core, over the existing authenticated encrypted session RPC. */
    authorize(params: unknown): { ok: true; applied: true } | { ok: false; error: string } {
        if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, error: 'invalid authorization' };
        const value = params as Record<string, unknown>;
        if (Object.keys(value).some(key => !['requestId', 'expectedRuntimeId', 'nonce', 'decision'].includes(key))
            || value.expectedRuntimeId !== this.deps.runtimeId || typeof value.requestId !== 'string'
            || value.requestId.length === 0 || value.requestId.length > MAX_REQUEST_ID_LENGTH
            || typeof value.nonce !== 'string' || value.nonce.length !== 36 || (value.decision !== 'allow' && value.decision !== 'deny')) {
            return { ok: false, error: 'invalid authorization' };
        }
        const waiter = this.approvalWaiters.get(value.requestId);
        if (!waiter || waiter.nonce !== value.nonce) return { ok: false, error: 'authorization expired or does not match' };
        waiter.finish(value.decision === 'allow');
        return { ok: true, applied: true };
    }

    private rememberedCount(): number {
        return new Set([...this.seen.keys(), ...this.inFlight.keys(), ...this.cancelled]).size;
    }

    async accept(params: unknown): Promise<ChannelAcceptanceResult> {
        const request = parseChannelPromptRequest(params);
        if (!request) return { ok: false, error: 'text, requestId and expectedRuntimeId are required' };

        if (this.deps.isManagedRun?.() === true) {
            // Refused before anything is recorded or queued. Extending managed admission is a
            // separate protocol and deliberately not part of this feature.
            return { ok: false, error: 'a managed run cannot take channel messages' };
        }

        if (request.expectedRuntimeId !== this.deps.runtimeId) {
            // The caller proved a different process. Accepting here would run work whose
            // capability proof belongs to a runtime this one has replaced.
            return { ok: false, error: 'this session is running a different runtime' };
        }

        if (this.cancelled.has(request.requestId)) return { ok: false, error: 'this channel request was cancelled' };
        const payloadHash = hashPayload(request.text);
        const existing = this.seen.get(request.requestId);
        if (existing) {
            if (existing.payloadHash !== payloadHash) {
                return { ok: false, error: 'that request id was already used with different text' };
            }
            return existing.state === 'accepted'
                ? { ok: true, accepted: false, duplicate: true, protocolVersion: 1 }
                // Never reported as a clean duplicate: the first attempt's fate is unknown, and
                // saying "already have it" would claim work that may never have been admitted.
                : { ok: false, error: 'the request could not be confirmed', unknown: true };
        }

        const running = this.inFlight.get(request.requestId);
        if (running) {
            // Same id, different text must not ride an in-flight success.
            if (running.payloadHash !== payloadHash) {
                return { ok: false, error: 'that request id was already used with different text' };
            }
            return running.result;
        }
        if (this.inFlight.size >= MAX_IN_FLIGHT) {
            return { ok: false, error: 'too many channel requests are in flight' };
        }
        // Capacity is enforced by refusing *new* ids, never by forgetting old ones. Evicting an
        // `accepted` record would let a redelivery run the work again; evicting an `unknown` one
        // would turn a request whose fate nobody knows back into an executable one.
        if (this.rememberedCount() >= MAX_REMEMBERED) {
            return { ok: false, error: 'this session has too many recorded channel requests' };
        }

        const result = this.admit(request, payloadHash).finally(() => {
            this.inFlight.delete(request.requestId);
        });
        this.inFlight.set(request.requestId, { payloadHash, result });
        return result;
    }

    private async admit(request: ChannelPromptRequest, payloadHash: string): Promise<ChannelAcceptanceResult> {
        let durable: { ok: true } | { ok: false; provenNotWritten: boolean };
        try {
            durable = await this.deps.recordDurably({ text: request.text, localId: `channel:${request.requestId}` });
        } catch {
            // A throw says nothing about whether the write landed. Treated as ambiguous unless the
            // implementation proves otherwise.
            return this.remember(request.requestId, payloadHash, 'unknown',
                { ok: false, error: 'the request could not be confirmed', unknown: true });
        }
        if (!durable.ok) {
            if (durable.provenNotWritten) {
                // Nothing landed, so nothing is remembered and a retry starts clean.
                return { ok: false, error: 'the request could not be recorded' };
            }
            return this.remember(request.requestId, payloadHash, 'unknown',
                { ok: false, error: 'the request could not be confirmed', unknown: true });
        }

        if (this.cancelled.has(request.requestId)) {
            return { ok: false, error: 'this channel request was cancelled' };
        }
        try {
            this.deps.enqueue({ text: request.text, requestId: request.requestId });
        } catch {
            // The queue inserts before it notifies, so a throw may follow a successful insert.
            // Remembered as unknown: a retry must not queue the same work a second time, and must
            // not be told it was cleanly accepted either.
            return this.remember(request.requestId, payloadHash, 'unknown',
                { ok: false, error: 'the request could not be confirmed', unknown: true });
        }

        return this.remember(request.requestId, payloadHash, 'accepted',
            { ok: true, accepted: true, duplicate: false, protocolVersion: 1 });
    }

    private remember(
        requestId: string,
        payloadHash: string,
        state: AcceptanceState,
        result: ChannelAcceptanceResult,
    ): ChannelAcceptanceResult {
        this.seen.set(requestId, { at: this.deps.now(), payloadHash, state });
        return result;
    }

}

export const CHANNEL_ACK_DEADLINE_MS = DEFAULT_ACK_DEADLINE_MS;
