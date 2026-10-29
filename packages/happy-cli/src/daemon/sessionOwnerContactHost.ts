/** Host bootstrap of the owner contact (Desktop P0a §4.4 step 1, T1c-b2 H2).
 * Runs after the actual session create/resume and before the provider starts. The host owns the key;
 * the daemon vouches for the remaining binding fields from its own launch state. */
import nacl from 'tweetnacl';
import { z } from 'zod';
import { OwnerContactRequestSchema, OwnershipCallerBindingSchema, rotationDecodeBinary } from '@slopus/happy-wire';
import { adoptAgentCallerBinding } from './agentCallerBinding';
import { createSessionOwnerContact, type SessionOwnerContact } from './sessionOwnerContact';
import { createOwnerContactNetwork } from './sessionOwnerContactNetwork';
import { startSessionOwnerContactLocal } from './sessionOwnerContactLocal';
import { OWNER_CONTACT_SWITCH } from './agentCallerLaunches';

type Caller = z.infer<typeof OwnershipCallerBindingSchema>;
const issuedSchema = z.object({ caller: OwnershipCallerBindingSchema, trust: z.object({ issuer: z.string().min(1), audience: z.string().min(1),
    publicKeys: z.record(z.string(), z.string()), lookupOrigin: z.string().url() }).strict() }).strict();
export interface OwnerContactHostSession {
    sessionId: string;
    /** ApiSessionClient.runtimeId of this host, the runtime that advertises agentContact. */
    runtimeId: string;
    callOwnerRelay(method: string, request: unknown, signal: AbortSignal): Promise<unknown>;
}
export interface OwnerContactHost { binding: Caller; contact: SessionOwnerContact; close(): void }

export async function startSessionOwnerContactHost(input: {
    /** Rollout switch (HAPPY_OWNER_CONTACT_V1). Default OFF: no key, report or lookup. */
    enabled?: boolean;
    session: OwnerContactHostSession;
    hostPid?: number;
    /** False once this host stops serving the session; stale bindings then refuse to sign. */
    live(): boolean;
    /** Private daemon bootstrap (control server `/caller-binding`). Carries only the public key. */
    issue(report: { sessionId: string; runtimeId: string; hostPid: number; callerPublicKey: string }): Promise<unknown>;
    token(): Promise<string | null>;
    fetch?: typeof fetch;
    now?: () => number;
}): Promise<OwnerContactHost | null> {
    if (input.enabled !== true) return null;
    const keys = nacl.sign.keyPair();
    const callerPublicKey = Buffer.from(keys.publicKey).toString('base64url');
    try {
        const issued = issuedSchema.parse(await input.issue({ sessionId: input.session.sessionId, runtimeId: input.session.runtimeId,
            hostPid: input.hostPid ?? process.pid, callerPublicKey }));
        const binding = issued.caller;
        if (binding.sessionId !== input.session.sessionId || binding.runtimeId !== input.session.runtimeId
            || binding.callerPublicKey !== callerPublicKey) throw new Error('caller-binding-mismatch');
        const registry = adoptAgentCallerBinding({ binding, secretKey: keys.secretKey, live: input.live });
        const { issuer, audience, publicKeys, lookupOrigin } = issued.trust;
        const contact = createSessionOwnerContact({ enabled: true, binding, registry, now: input.now ?? Date.now,
            trust: { issuer, audience, publicKey: keyId => {
                const value = Object.hasOwn(publicKeys, keyId) ? publicKeys[keyId] : undefined;
                try { return value ? rotationDecodeBinary(value, 32) : null; } catch { return null; }
            } },
            ...createOwnerContactNetwork({ origin: lookupOrigin, token: input.token, fetch: input.fetch,
                rpc: (method, request, signal) => input.session.callOwnerRelay(method, request, signal) }) });
        return { binding: { ...binding }, contact, close: () => contact.close() };
    } catch {
        // Unavailable owner relay never blocks the host, provider, existing reads or descendant control.
        keys.secretKey.fill(0);
        return null;
    }
}

/** startHappyServer wiring before the provider starts. Broker hosts receive the contact through the
 * broker's private IPC; direct hosts get an owner-only local port whose address is the only env value.
 * Switch OFF or a managed session: exactly the existing broker launch, no key, report or env change. */
export async function startHostOwnerContact<Broker>(input: {
    env: NodeJS.ProcessEnv;
    session: OwnerContactHostSession & { getManagedOrigin(): string | null };
    hostPid?: number;
    issue(report: { sessionId: string; runtimeId: string; hostPid: number; callerPublicKey: string }): Promise<unknown>;
    token(): Promise<string | null>;
    fetch?: typeof fetch;
    startBroker(contact: SessionOwnerContact | undefined): Promise<Broker | null>;
}): Promise<{ broker: Broker | null; close(): Promise<void> }> {
    if (input.env[OWNER_CONTACT_SWITCH] !== '1' || input.session.getManagedOrigin() !== null) {
        return { broker: await input.startBroker(undefined), close: async () => {} };
    }
    // An inherited address names another host's contact; this host advertises only its own.
    delete input.env.SAYCODE_OWNER_CONTACT_SOCKET;
    let closed = false;
    const host = await startSessionOwnerContactHost({ enabled: true, session: input.session, hostPid: input.hostPid,
        live: () => !closed, issue: input.issue, token: input.token, fetch: input.fetch });
    // Main cannot tell a broker caller from a direct one, so the broker's fixed entry policy lives here:
    // a broker agent command below depth 0 gets no sibling/parent exposure or prompt (Desktop P0a §2.3).
    const brokerContact: SessionOwnerContact | undefined = host && host.binding.depth > 0 ? { close: () => host.contact.close(),
        call: async raw => {
            const request = OwnerContactRequestSchema.parse(raw);
            if (request.entry === 'agent') throw new Error('owner-contact-unavailable');
            return host.contact.call(request);
        } } : host?.contact;
    const broker = await input.startBroker(brokerContact);
    const local = host && !broker ? await startSessionOwnerContactLocal({ enabled: true, contact: host.contact }).catch(() => null) : null;
    const address = local?.environment.SAYCODE_OWNER_CONTACT_SOCKET;
    if (address) input.env.SAYCODE_OWNER_CONTACT_SOCKET = address;
    return { broker, async close() {
        closed = true;
        if (address && input.env.SAYCODE_OWNER_CONTACT_SOCKET === address) delete input.env.SAYCODE_OWNER_CONTACT_SOCKET;
        host?.close();
        await local?.close();
    } };
}
