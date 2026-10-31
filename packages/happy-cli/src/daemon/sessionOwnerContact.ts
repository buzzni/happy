/** Host-only owner-contact-v1 port. Remote adapters never receive a signing key. */
import { randomUUID, randomBytes } from 'node:crypto';
import {
    OwnerContactRequestSchema, OwnershipRelayContactSchema, OwnershipCallerBindingSchema,
    canonicalOwnerRelayJson, ownershipFresh, verifyOwnership, verifyOwnerRelayReply,
    OwnerRelayReplySchema, type OwnerContactRequest, type OwnerRelayRequest, type OwnerRelayReply, type OwnershipRelayContact,
} from '@slopus/happy-wire';
import { z } from 'zod';
import type { createAgentCallerBindings } from './agentCallerBinding';
type Binding = z.infer<typeof OwnershipCallerBindingSchema>;
export interface SessionOwnerContactDependencies {
    /** Trusted host configuration, never a request/provider environment switch. Default OFF. */
    enabled?: boolean;
    binding: Binding;
    registry: Pick<ReturnType<typeof createAgentCallerBindings>, 'query' | 'signRelay' | 'revokeBinding'>;
    now(): number;
    trust: { issuer: string; audience: string; publicKey(keyId: string): Uint8Array | null };
    /** Machine-authenticated A+ lookup limited to this source binding. No arbitrary target or URL. */
    lookup(source: OwnerContactSource, signal: AbortSignal): Promise<unknown[]>;
    /** Recheck registration/revocation against current authority, including after the reply. */
    currentContact(contact: OwnershipRelayContact, signal: AbortSignal): Promise<boolean>;
    /** Session-DEK-bound Happy RPC, pinned to contact.method; no retry/failover. */
    exchange(contact: OwnershipRelayContact, request: OwnerRelayRequest, signal: AbortSignal): Promise<unknown>;
    /** Operation pin table capacity; defaults to 512. */
    pinLimit?: number;
}
export type OwnerContactSource = { sessionId: string; machineId: string; happyAccountId: string; callerBindingId: string; hostEpoch: string };
export interface SessionOwnerContact { call(raw: unknown): Promise<OwnerRelayReply>; close(): void }
/** Desktop P0a §4.5: an operation stays on the instance it was first sent to; its creation journal and
 * localId dedupe live only there. Keyed by wire ids; other operations keep a Desktop-free selection. */
function operationKey(request: OwnerContactRequest): string | null {
    switch (request.operation) {
        case 'spawn-owned-child': case 'owned-child-status': return JSON.stringify(['child', request.payload.operationId]);
        case 'prompt-own-session': return JSON.stringify(['prompt', request.targetSessionId, request.localId]);
        default: return null;
    }
}
/** A verified stored-prompt receipt ends an operation's pin: the row is found again by localId on the
 * server, so a retry after a lost receipt gets the same receipt from any valid Desktop. A verified not_owned
 * prompt was refused before storage (P0a §5.1), and a non-allowed status of an operation this host never sent
 * a spawn for has no journal here to recover, so neither holds anything on a Desktop. An owned child that was
 * spawned never ends here: a verified started/failed may not have reached the CLI or its lineage record, and
 * only the original Desktop's journal answers the status that recovers it, so its pin lasts the host's lifetime.
 * pending/parked, any other unknown/unavailable, a timeout or a rejected reply end nothing. */
function finished(reply: OwnerRelayReply, spawned: boolean): boolean {
    switch (reply.operation) {
        case 'prompt-own-session': return reply.result === 'allowed' || reply.result === 'not_owned';
        case 'owned-child-status': return !spawned && reply.result !== 'allowed';
        default: return false;
    }
}
/** 512: the Desktop CLI spawn budget is at most 32 per 6 hours per host, so lifetime child pins alone take
 * four days at full budget to fill it; finished prompts are reclaimed. A full table refuses new operations. */
const PIN_LIMIT = 512, PIN_TTL_MS = 24 * 60 * 60 * 1000;
type Pin = { desktopInstanceId: string; usedAt: number; sent: boolean; spawned: boolean; finished: boolean; inflight: number };
export function createSessionOwnerContact(deps: SessionOwnerContactDependencies): SessionOwnerContact {
    const binding = OwnershipCallerBindingSchema.parse(deps.binding);
    const enabled = deps.enabled === true;
    const lifetime = new AbortController();
    const same = (a: unknown, b: unknown) => canonicalOwnerRelayJson(a) === canonicalOwnerRelayJson(b);
    // Host-memory only (lost on host restart). A sent operation is never dropped until finished(): forgetting it
    // would re-bind its next call to another Desktop. Cleanup takes idle finished entries, oldest first
    // (unsent ones go when their last call ends); a table still full refuses only a new operation.
    const pins = new Map<string, Pin>(), pinLimit = deps.pinLimit ?? PIN_LIMIT;
    function claim(key: string, first: string | undefined): Pin | null {
        let pin = pins.get(key);
        if (!pin) {
            if (first === undefined) return null;
            for (const [k, p] of pins) if (p.inflight === 0 && p.finished && (deps.now() - p.usedAt > PIN_TTL_MS || pins.size >= pinLimit)) pins.delete(k);
            if (pins.size >= pinLimit) throw new Error('contact-unavailable');
            pin = { desktopInstanceId: first, usedAt: 0, sent: false, spawned: false, finished: false, inflight: 0 };
        }
        pins.delete(key); pins.set(key, pin);
        pin.usedAt = deps.now(); pin.inflight++;
        return pin;
    }
    function release(key: string, pin: Pin) {
        // A choice that never reached a Desktop binds nothing; a sent one stays even after a timeout.
        if (--pin.inflight === 0 && !pin.sent && pins.get(key) === pin) pins.delete(key);
    }
    async function current() {
        if (lifetime.signal.aborted) throw new Error('owner-contact-closed');
        const result = await deps.registry.query({ sessionId: binding.sessionId, nonce: randomUUID() });
        if (!same(result.caller, binding)) throw new Error('caller-changed');
    }
    function valid(contact: OwnershipRelayContact) {
        const key = deps.trust.publicKey(contact.keyId);
        return contact.issuer === deps.trust.issuer && contact.audience === deps.trust.audience
            && key !== null && verifyOwnership(contact, key) && ownershipFresh(contact, deps.now())
            && contact.hubId === binding.sessionId && contact.sourceRuntimeId === binding.runtimeId
            && contact.callerBindingId === binding.callerBindingId && contact.hostEpoch === binding.hostEpoch
            && contact.callerPublicKey === binding.callerPublicKey && contact.machineId === binding.machineId
            && contact.happyAccountId === binding.happyAccountId && contact.scope === binding.scope && contact.depth === binding.depth;
    }
    return {
        close() { lifetime.abort(); deps.registry.revokeBinding(binding); },
        async call(raw) {
            if (!enabled) throw new Error('owner-contact-disabled');
            // Snapshot before awaits; strict local schema rejects source/scope/authority injection.
            const local = OwnerContactRequestSchema.parse(JSON.parse(canonicalOwnerRelayJson(raw, 65536)));
            // A plain (unref'd, cleared) timer rather than AbortSignal.timeout, so the deadline is a normal timer.
            const deadline = new AbortController();
            const timer = setTimeout(() => deadline.abort(new DOMException('owner contact timed out', 'TimeoutError')), 20000);
            timer.unref?.();
            const signal = AbortSignal.any([lifetime.signal, deadline.signal]);
            const key = operationKey(local);
            let pin: Pin | null = null;
            // Once per call, from whichever ends first: the work, or the deadline over an adapter ignoring abort.
            const drop = () => { const held = pin; pin = null; if (key && held) release(key, held); };
            const work = async () => { try {
                await current();
                const candidates = await deps.lookup({ sessionId: binding.sessionId, machineId: binding.machineId,
                    happyAccountId: binding.happyAccountId, callerBindingId: binding.callerBindingId, hostEpoch: binding.hostEpoch }, signal);
                await current(); signal.throwIfAborted();
                if (!Array.isArray(candidates) || candidates.length > 100) throw new Error('contact-unavailable');
                const contacts = candidates.map(c => OwnershipRelayContactSchema.safeParse(c))
                    .flatMap(p => p.success && valid(p.data) ? [p.data] : [])
                    .sort((a, b) => a.desktopInstanceId < b.desktopInstanceId ? -1 : a.desktopInstanceId > b.desktopInstanceId ? 1 : 0);
                pin = key ? claim(key, contacts[0]?.desktopInstanceId) : null;
                // A pinned instance that is no longer a valid contact is unavailable; never fail over.
                const contact = pin ? contacts.find(c => c.desktopInstanceId === pin!.desktopInstanceId) : contacts[0];
                if (!contact || !await deps.currentContact(contact, signal)) throw new Error('contact-unavailable');
                await current(); signal.throwIfAborted();
                if (!valid(contact)) throw new Error('contact-unavailable');
                const request = await deps.registry.signRelay(binding, { ...local, requestId: randomUUID(), nonce: randomBytes(32).toString('base64url'),
                    sourceHubSessionId: binding.sessionId, sourceRuntimeId: binding.runtimeId, callerBindingId: binding.callerBindingId,
                    hostEpoch: binding.hostEpoch, sourceAuthority: contact.sourceAuthority, relayEpoch: contact.epoch });
                await current(); signal.throwIfAborted();
                if (pin) pin.sent = true;
                // A spawn makes the child's pin lifetime-long, even after an earlier status ended it.
                if (pin && local.operation === 'spawn-owned-child') { pin.spawned = true; pin.finished = false; }
                const rawReply = JSON.parse(canonicalOwnerRelayJson(await deps.exchange(contact, request, signal)));
                await current(); signal.throwIfAborted();
                if (!valid(contact) || !await deps.currentContact(contact, signal)
                    || !await verifyOwnerRelayReply(rawReply, request, contact, deps.now())) throw new Error('invalid-owner-reply');
                await current(); signal.throwIfAborted();
                if (!valid(contact)) throw new Error('contact-unavailable');
                const reply = OwnerRelayReplySchema.parse(rawReply);
                if (pin && finished(reply, pin.spawned)) pin.finished = true;
                return reply;
            } finally { drop(); } };
            // Bound even an adapter that ignores AbortSignal; never expose its exception/credentials.
            let onAbort: () => void = () => {};
            try {
                return await Promise.race([work(), new Promise<never>((_, reject) => {
                    onAbort = () => reject(new Error('owner-contact-unavailable'));
                    signal.addEventListener('abort', onAbort, { once: true });
                    if (signal.aborted) onAbort();
                })]);
            } catch { throw new Error('owner-contact-unavailable'); }
            finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); drop(); }
        },
    };
}
