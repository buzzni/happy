/** Host-private launch identity. This registry is never reconstructed from provider env/argv. */
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import { z } from 'zod';
import { OwnershipCallerBindingSchema, canonicalOrgSetupTokenJson, ownershipId } from '@slopus/happy-wire';
type Caller = z.infer<typeof OwnershipCallerBindingSchema>;
export function createAgentCallerBindings(deps: {
    identity(): { machineId: string; happyAccountId: string; epoch: string } | null;
    live(binding: Caller): boolean;
}) {
    const hostEpoch = randomUUID();
    const callers = new Map<string, { caller: Caller; key: Uint8Array; registrationEpoch: string }>();
    function current(sessionId: string) {
        const entry = callers.get(sessionId), identity = deps.identity();
        if (!entry || !identity) throw new Error('caller-unavailable');
        if (entry.registrationEpoch !== identity.epoch || entry.caller.machineId !== identity.machineId || entry.caller.happyAccountId !== identity.happyAccountId) {
            entry.key.fill(0); callers.delete(sessionId); throw new Error('identity-changed');
        }
        if (!deps.live(entry.caller)) throw new Error('caller-not-running');
        return entry;
    }
    return {
        /** Trusted daemon preparation/resume only; never register this method as an RPC. */
        prepare(input: { sessionId: string; scope: string; depth: number }) {
            const identity = deps.identity(); if (!identity) throw new Error('identity-unknown');
            const keys = nacl.sign.keyPair();
            const caller = OwnershipCallerBindingSchema.parse({ ...input, machineId: identity.machineId, happyAccountId: identity.happyAccountId,
                callerBindingId: randomUUID(), runtimeId: randomUUID(), hostEpoch, callerPublicKey: Buffer.from(keys.publicKey).toString('base64url') });
            callers.get(input.sessionId)?.key.fill(0);
            callers.set(input.sessionId, { caller, key: keys.secretKey, registrationEpoch: identity.epoch });
            return { ...caller };
        },
        async query(raw: unknown) {
            const input = z.object({ sessionId: ownershipId, nonce: z.string().min(16).max(256) }).strict().parse(raw);
            const entry = current(input.sessionId);
            return { version: 1 as const, nonce: input.nonce, caller: { ...entry.caller } };
        },
        /** T1c host adapter receives this closure, not the key. Signed bytes use the canonical contact protocol. */
        sign(binding: Caller, request: unknown): string {
            const entry = current(binding.sessionId);
            if (canonicalOrgSetupTokenJson(entry.caller) !== canonicalOrgSetupTokenJson(binding)) throw new Error('caller-changed');
            return Buffer.from(nacl.sign.detached(new TextEncoder().encode(canonicalOrgSetupTokenJson(request)), entry.key)).toString('base64url');
        },
        revoke(sessionId: string) { callers.get(sessionId)?.key.fill(0); callers.delete(sessionId); },
    };
}
