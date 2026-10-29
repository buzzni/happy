/** Host-only owner-contact-v1 port. Remote adapters never receive a signing key. */
import { randomUUID, randomBytes } from 'node:crypto';
import {
    OwnerContactRequestSchema, OwnershipRelayContactSchema, OwnershipCallerBindingSchema,
    canonicalOwnerRelayJson, ownershipFresh, verifyOwnership, verifyOwnerRelayReply,
    OwnerRelayReplySchema, type OwnerRelayRequest, type OwnerRelayReply, type OwnershipRelayContact,
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
}
export type OwnerContactSource = { sessionId: string; machineId: string; happyAccountId: string; callerBindingId: string; hostEpoch: string };
export interface SessionOwnerContact { call(raw: unknown): Promise<OwnerRelayReply>; close(): void }
export function createSessionOwnerContact(deps: SessionOwnerContactDependencies): SessionOwnerContact {
    const binding = OwnershipCallerBindingSchema.parse(deps.binding);
    const enabled = deps.enabled === true;
    const lifetime = new AbortController();
    const same = (a: unknown, b: unknown) => canonicalOwnerRelayJson(a) === canonicalOwnerRelayJson(b);
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
            const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(20000)]);
            const work = async () => {
                await current();
                const candidates = await deps.lookup({ sessionId: binding.sessionId, machineId: binding.machineId,
                    happyAccountId: binding.happyAccountId, callerBindingId: binding.callerBindingId, hostEpoch: binding.hostEpoch }, signal);
                await current(); signal.throwIfAborted();
                if (!Array.isArray(candidates) || candidates.length > 100) throw new Error('contact-unavailable');
                const contacts = candidates.map(c => OwnershipRelayContactSchema.safeParse(c))
                    .flatMap(p => p.success && valid(p.data) ? [p.data] : [])
                    .sort((a, b) => a.desktopInstanceId < b.desktopInstanceId ? -1 : a.desktopInstanceId > b.desktopInstanceId ? 1 : 0);
                const contact = contacts[0];
                if (!contact || !await deps.currentContact(contact, signal)) throw new Error('contact-unavailable');
                await current(); signal.throwIfAborted();
                if (!valid(contact)) throw new Error('contact-unavailable');
                const request = await deps.registry.signRelay(binding, { ...local, requestId: randomUUID(), nonce: randomBytes(32).toString('base64url'),
                    sourceHubSessionId: binding.sessionId, sourceRuntimeId: binding.runtimeId, callerBindingId: binding.callerBindingId,
                    hostEpoch: binding.hostEpoch, sourceAuthority: contact.sourceAuthority, relayEpoch: contact.epoch });
                await current(); signal.throwIfAborted();
                const rawReply = JSON.parse(canonicalOwnerRelayJson(await deps.exchange(contact, request, signal)));
                await current(); signal.throwIfAborted();
                if (!valid(contact) || !await deps.currentContact(contact, signal)
                    || !await verifyOwnerRelayReply(rawReply, request, contact, deps.now())) throw new Error('invalid-owner-reply');
                await current(); signal.throwIfAborted();
                if (!valid(contact)) throw new Error('contact-unavailable');
                return OwnerRelayReplySchema.parse(rawReply);
            };
            // Bound even an adapter that ignores AbortSignal; never expose its exception/credentials.
            let onAbort: () => void = () => {};
            try {
                return await Promise.race([work(), new Promise<never>((_, reject) => {
                    onAbort = () => reject(new Error('owner-contact-unavailable'));
                    signal.addEventListener('abort', onAbort, { once: true });
                    if (signal.aborted) onAbort();
                })]);
            } catch { throw new Error('owner-contact-unavailable'); }
            finally { signal.removeEventListener('abort', onAbort); }
        },
    };
}
