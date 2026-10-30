/** Network ports of the host owner contact: A+ relay lookup and the session-DEK Happy RPC.
 * The destination comes from daemon trust, the bearer stays in this process and is never logged. */
import { z } from 'zod';
import { canonicalOwnerRelayJson, type OwnershipRelayContact } from '@slopus/happy-wire';
import type { OwnerContactSource, SessionOwnerContactDependencies } from './sessionOwnerContact';

const MAX_LOOKUP_BYTES = 512 * 1024;
const lookupSchema = z.object({ contacts: z.array(z.unknown()).max(100) }).strict();

export function createOwnerContactNetwork(input: {
    /** The daemon's trusted Studio origin (never a request, provider or project value). */
    origin: string;
    /** Happy account credential of this host; used only as the A+ machine-auth bearer. */
    token(): Promise<string | null>;
    /** Session-DEK-bound Happy RPC to `contact.method`; one attempt, no failover. */
    rpc(method: string, request: unknown, signal: AbortSignal): Promise<unknown>;
    fetch?: typeof fetch;
}): Pick<SessionOwnerContactDependencies, 'lookup' | 'currentContact' | 'exchange'> {
    const origin = new URL(input.origin).origin, fetcher = input.fetch ?? fetch;
    async function lookup(source: OwnerContactSource, signal: AbortSignal): Promise<unknown[]> {
        const token = await input.token();
        if (!token) throw new Error('owner-contact-unauthenticated');
        const url = `${origin}/api/v2/session-ownership/${encodeURIComponent(source.sessionId)}/relays/lookup`;
        const response = await fetcher(url, { method: 'POST', redirect: 'error', signal,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
            body: JSON.stringify({ machineId: source.machineId, callerBindingId: source.callerBindingId, hostEpoch: source.hostEpoch }) });
        if (!response.ok) throw new Error('owner-contact-lookup-unavailable');
        const text = await response.text();
        if (Buffer.byteLength(text) > MAX_LOOKUP_BYTES) throw new Error('owner-contact-lookup-unavailable');
        return lookupSchema.parse(JSON.parse(text)).contacts;
    }
    return {
        lookup,
        /** Registration/revocation recheck: the same signed contact must still be served for this binding. */
        async currentContact(contact: OwnershipRelayContact, signal: AbortSignal) {
            const expected = canonicalOwnerRelayJson(contact);
            const contacts = await lookup({ sessionId: contact.hubId, machineId: contact.machineId, happyAccountId: contact.happyAccountId,
                callerBindingId: contact.callerBindingId, hostEpoch: contact.hostEpoch }, signal);
            return contacts.some(candidate => { try { return canonicalOwnerRelayJson(candidate) === expected; } catch { return false; } });
        },
        exchange: (contact, request, signal) => input.rpc(contact.method, request, signal),
    };
}
