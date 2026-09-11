/**
 * specs/managed-cloud-byos §5.36 — the credential a managed daemon runs as.
 *
 * ## Why a managed daemon cannot use the ordinary path
 *
 * `authAndSetupMachineIfNeeded` does two things that are right for BYOS and
 * wrong here. It runs an **interactive** authentication when no credential is
 * on disk — there is nobody at a terminal in a cloud runtime — and it invents a
 * machine id with `randomUUID()`. The parent has already registered this
 * runtime's Machine and holds its id; a daemon that generated its own would
 * publish readiness for a machine nobody is listening on, and the marker check
 * would refuse the boot anyway.
 *
 * So the managed path consumes a credential the trusted parent issued, and
 * consumes it from a place the agent cannot write.
 *
 * ## What is in it, and why each part
 *
 *  - `machineId` — the Machine the parent registered. An address, not a name
 *    this process may choose.
 *  - `token` — a bearer of the **daemon's own purpose**. Never the account
 *    bearer: that one reaches every session on the account, and this process
 *    runs code the customer's agent can influence.
 *  - `machineKey` — the raw 32 bytes the parent wrapped for this Machine.
 *    Without it the daemon cannot read anything encrypted for the machine. It
 *    is a secret, which is exactly why it lives here and not in the boot input
 *    file: this record is rewritable on renewal, and root-only.
 *  - `expiresAt` — the daemon credential is short-lived by design. It is
 *    recorded so an expired one is *known* to be expired rather than discovered
 *    when the server refuses it.
 *  - `serverOrigin` — which Happy this credential is for. A credential is only
 *    valid against the server that issued it, and sending it elsewhere is
 *    sending a bearer token to a host of somebody else's choosing.
 *
 * ## Never a fallback
 *
 * Every failure to read this is a refusal. There is no path from "the managed
 * credential is missing or expired" to "authenticate as a person instead" —
 * that path ends with a cloud runtime holding an account bearer.
 */
import { constants, promises as fs } from 'node:fs';
import { randomUUID, type KeyObject } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

import {
    assertProvisioningStat,
    readRootProtectedFile,
    trustedPathRefusal,
    type ManagedProvisioningDeps,
} from '@/daemon/managedRuntimeIdentity';

import { canonicalManagedPayloadDigest, verifyManagedDispatchMaterial, type ManagedTokenFailure } from './managedDispatchToken';

export const MANAGED_DAEMON_CREDENTIAL_VERSION = 1;

/** The raw machine key is 32 bytes; anything else is not that key. */
const MACHINE_KEY_BYTES = 32;

export type ManagedDaemonCredential = {
    machineId: string;
    token: string;
    machineKey: Uint8Array;
    /**
     * The account public key the machine key was wrapped for.
     *
     * Public, and carried rather than derived: `Credentials` of the `dataKey`
     * kind are the pair, and a daemon that filled this in from anywhere else
     * would be claiming its key belongs to an account nobody said it did.
     */
    accountPublicKey: Uint8Array;
    expiresAt: number;
    serverOrigin: string;
};

export type ManagedDaemonCredentialRefusal =
    | 'absent'
    | 'unusable'
    | 'expired'
    | 'wrong-machine';

/**
 * Why a renewal was not applied. Each is a different next move for the parent:
 * stop sending this one, send a later one, look at the runtime's disk, or
 * finish provisioning first.
 */
export type ManagedCredentialReplaceRefusal =
    | 'credential-not-mine'
    | 'credential-not-newer'
    | 'credential-unreadable'
    | 'credential-unwritable'
    | 'credential-durability-unknown';

export type ManagedCredentialReplaceOutcome =
    | { ok: true; expiresAt: number }
    | { ok: false; reason: ManagedCredentialReplaceRefusal };

export type ManagedDaemonCredentialOutcome =
    | { ok: true; credential: ManagedDaemonCredential }
    | { ok: false; reason: ManagedDaemonCredentialRefusal };

export function managedDaemonCredentialPath(stateDir: string): string {
    return join(stateDir, 'daemon-credential.json');
}

export function readManagedDaemonCredential(input: {
    stateDir: string;
    /** The Machine the marker says this runtime is. Compared, never adopted. */
    expectedMachineId: string;
    now: number;
    deps: ManagedProvisioningDeps;
}): ManagedDaemonCredentialOutcome {
    const path = managedDaemonCredentialPath(input.stateDir);
    // The parent directory is walked; the leaf is judged on its own descriptor
    // with `O_NOFOLLOW`, where it can be judged atomically.
    if (trustedPathRefusal(dirname(resolve(path)), input.deps.getuid(), 'unreadable', input.deps)) {
        return { ok: false, reason: 'unusable' };
    }
    const file = readRootProtectedFile(path, input.deps.statGate ?? assertProvisioningStat);
    if (file.kind === 'absent') return { ok: false, reason: 'absent' };
    if (file.kind !== 'ok') return { ok: false, reason: 'unusable' };

    let parsed: unknown;
    try {
        parsed = JSON.parse(file.content);
    } catch {
        return { ok: false, reason: 'unusable' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: 'unusable' };
    }
    const record = parsed as Record<string, unknown>;
    if (record.version !== MANAGED_DAEMON_CREDENTIAL_VERSION) return { ok: false, reason: 'unusable' };

    const machineId = typeof record.machineId === 'string' ? record.machineId.trim() : '';
    const token = typeof record.token === 'string' ? record.token.trim() : '';
    const serverOrigin = typeof record.serverOrigin === 'string' ? record.serverOrigin.trim() : '';
    const expiresAt = record.expiresAt;
    const machineKeyB64 = typeof record.machineKey === 'string' ? record.machineKey : '';
    const publicKeyB64 = typeof record.accountPublicKey === 'string' ? record.accountPublicKey : '';
    if (machineId === '' || token === '' || serverOrigin === ''
        || machineKeyB64 === '' || publicKeyB64 === '') {
        return { ok: false, reason: 'unusable' };
    }
    if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)) {
        return { ok: false, reason: 'unusable' };
    }
    // An origin that is not an absolute http(s) URL is not somewhere a bearer
    // may be sent. A relative or scheme-less value would be resolved against
    // whatever the process happens to think the default is.
    let origin: string;
    try {
        const url = new URL(serverOrigin);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme');
        origin = url.origin;
    } catch {
        return { ok: false, reason: 'unusable' };
    }

    const machineKey = Buffer.from(machineKeyB64, 'base64');
    // Re-encoding catches the values `Buffer.from` silently accepts: a short
    // string, a truncated one, anything that is not this key.
    if (machineKey.length !== MACHINE_KEY_BYTES
        || machineKey.toString('base64') !== machineKeyB64) {
        return { ok: false, reason: 'unusable' };
    }
    const accountPublicKey = Buffer.from(publicKeyB64, 'base64');
    if (accountPublicKey.length !== MACHINE_KEY_BYTES
        || accountPublicKey.toString('base64') !== publicKeyB64) {
        return { ok: false, reason: 'unusable' };
    }

    // Compared against the marker, because the two are separate records and a
    // credential for another Machine is a credential that would publish this
    // runtime's readiness somewhere else.
    if (machineId !== input.expectedMachineId) return { ok: false, reason: 'wrong-machine' };
    // Expiry is its own answer: renewal can fix it, and the caller should say
    // so rather than reporting a runtime with no credential at all.
    if (expiresAt <= input.now) return { ok: false, reason: 'expired' };

    return {
        ok: true,
        credential: {
            machineId,
            token,
            machineKey: new Uint8Array(machineKey),
            accountPublicKey: new Uint8Array(accountPublicKey),
            expiresAt,
            serverOrigin: origin,
        },
    };
}

/**
 * Writes the credential, replacing whatever was there.
 *
 * Unlike the launcher binding and the volume seal, this record is **meant** to
 * be replaced: renewal issues a new bearer for the same Machine, and a daemon
 * that could not take the new one would stop working when the old one expired.
 * What must not change is which Machine it is for — that is the caller's check,
 * and `readManagedDaemonCredential` refuses a mismatch on the way back in.
 *
 * Written to a temporary file in the same directory and renamed, so a crash
 * leaves either the old credential or the new one, never a half-written record
 * that reads as `unusable` and takes the runtime down.
 */
export async function writeManagedDaemonCredential(input: {
    stateDir: string;
    credential: ManagedDaemonCredential;
    /** Overridden only by tests; the default flushes the file and its directory. */
    syncDirectory?: (path: string) => Promise<void>;
    /** Overridden only by tests, to fail inside the window before publishing. */
    syncFile?: (handle: fs.FileHandle) => Promise<void>;
}): Promise<void> {
    const path = managedDaemonCredentialPath(input.stateDir);
    /*
     * A temporary of this call's own, created exclusively.
     *
     * One shared `.new` name is one shared **inode**: two refreshers — a
     * heartbeat and a reconnect, two daemons overlapping across a restart —
     * open it together, and the first to rename publishes a file the second is
     * still writing into. What comes back out is then neither credential, and
     * the runtime reads a token that was never issued.
     */
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const body = JSON.stringify({
        version: MANAGED_DAEMON_CREDENTIAL_VERSION,
        machineId: input.credential.machineId,
        token: input.credential.token,
        machineKey: Buffer.from(input.credential.machineKey).toString('base64'),
        accountPublicKey: Buffer.from(input.credential.accountPublicKey).toString('base64'),
        expiresAt: input.credential.expiresAt,
        serverOrigin: input.credential.serverOrigin,
    });
    try {
        const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try {
            await handle.writeFile(body);
            // Explicit rather than left to `O_CREAT`'s mode, which the umask
            // masks: this file holds the machine key.
            await handle.chmod(0o600);
            await (input.syncFile ?? ((h: fs.FileHandle) => h.sync()))(handle);
        } finally {
            await handle.close();
        }
        // `rename`, unlike the seal and the binding: a renewed credential is
        // *meant* to replace the previous one, and the replacement is atomic.
        await fs.rename(temporary, path);
    } catch (error) {
        // Only this call's own temporary. Removing temporaries as a class would
        // delete the file a concurrent writer is about to publish.
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        throw error;
    }
    try {
        await (input.syncDirectory ?? syncDirectoryEntry)(input.stateDir);
    } catch {
        // Rename succeeded; the new record may be visible without durable publication.
        throw new ManagedCredentialDurabilityUnknownError();
    }
}

export class ManagedCredentialDurabilityUnknownError extends Error {
    constructor() { super('credential-durability-unknown'); }
}

async function syncDirectoryEntry(path: string): Promise<void> {
    const dir = await fs.open(path, constants.O_RDONLY);
    try {
        await dir.sync();
    } finally {
        await dir.close();
    }
}

/**
 * Replaces the bearer this runtime authenticates with, in place.
 *
 * A renewal extends an identity; it does not move one. So everything that says
 * *which* Machine this is comes from the stored record — the machine key, the
 * account it is wrapped for, the origin that issued it — and the replacement
 * contributes exactly two things: a later bearer and a later expiry.
 *
 * The replacement still names the Machine and the origin it was issued for.
 * Those are compared, not adopted: the parent signs them into the dispatch
 * token's payload digest, so a mismatch means this is not the answer to a
 * renewal of *this* runtime, and applying it would point a live daemon at a
 * credential nobody issued for it.
 */
export async function replaceManagedDaemonCredential(input: {
    stateDir: string;
    /** The Machine the marker says this runtime is. */
    expectedMachineId: string;
    replacement: { token: string; expiresAt: number; machineId: string; serverOrigin: string };
    now: number;
    deps: ManagedProvisioningDeps;
    /** Overridden only by tests, to fail the publish. */
    write?: typeof writeManagedDaemonCredential;
}): Promise<ManagedCredentialReplaceOutcome> {
    /*
     * Read with `now: 0` — deliberately, and it is not a bypass of the expiry
     * guard.
     *
     * A runtime whose bearer has already lapsed is exactly the one that needs a
     * renewal, and refusing to read its record would make expiry unrecoverable.
     * What expires is the bearer; the identity axes in the record do not expire
     * with it, and those are all this function carries forward. The new bearer's
     * own window is checked below against the stored one.
     */
    const stored = readManagedDaemonCredential({
        stateDir: input.stateDir,
        expectedMachineId: input.expectedMachineId,
        now: 0,
        deps: input.deps,
    });
    // No record, or one this runtime may not use. There is nothing to extend,
    // and building one out of the replacement alone would invent a Machine.
    if (!stored.ok) return { ok: false, reason: 'credential-unreadable' };

    if (input.replacement.machineId !== stored.credential.machineId
        || input.replacement.serverOrigin !== stored.credential.serverOrigin) {
        return { ok: false, reason: 'credential-not-mine' };
    }
    // Strictly later. Equal is a replay of the renewal already applied, and the
    // window it would "extend" is the one already being lived in.
    if (input.replacement.expiresAt <= stored.credential.expiresAt) {
        return { ok: false, reason: 'credential-not-newer' };
    }

    try {
        await (input.write ?? writeManagedDaemonCredential)({
            stateDir: input.stateDir,
            credential: {
                ...stored.credential,
                token: input.replacement.token,
                expiresAt: input.replacement.expiresAt,
            },
        });
    } catch (error) {
        // A post-rename failure may leave the newer record visible. Neither
        // visibility nor a retry proves that the directory entry was durable.
        return { ok: false, reason: error instanceof ManagedCredentialDurabilityUnknownError
            ? 'credential-durability-unknown' : 'credential-unwritable' };
    }
    return { ok: true, expiresAt: input.replacement.expiresAt };
}


export type ManagedCredentialReceiverOutcome = ManagedCredentialReplaceOutcome
    | { ok: false; reason: `token-${ManagedTokenFailure}` | 'token-wrong-project' | 'token-unknown-key'
        | 'malformed-request' | 'credential-expired' | 'credential-busy' | 'credential-clock-invalid' };

/** An internal receiver; production must install exactly one under supervisor ownership. */
export function createManagedCredentialReceiver(input: {
    runtimeId: string;
    workspaceId: string;
    projectId: string;
    keyId: string;
    provisioningOperationId: string;
    happyMachineId: string;
    stateDir: string;
    verifier: KeyObject;
    now: () => number;
    deps: ManagedProvisioningDeps;
    /** Test-only writer observation; production uses the durable writer. */
    write?: typeof writeManagedDaemonCredential;
}): { replace(request: unknown): Promise<ManagedCredentialReceiverOutcome> } {
    const { runtimeId, workspaceId, projectId, keyId, provisioningOperationId,
        happyMachineId, stateDir, verifier, now, write } = input;
    const deps = { ...input.deps };
    let busy = false;
    return {
        async replace(request) {
            if (busy) return { ok: false, reason: 'credential-busy' };
            busy = true;
            try {
                let replacement: { token: string; machineId: string; serverOrigin: string; expiresAt: number };
                let observedNow: number;
                try {
                    if (!request || typeof request !== 'object' || Array.isArray(request)) {
                        return { ok: false, reason: 'malformed-request' };
                    }
                    const envelope = request as Record<string, unknown>;
                    const dispatchToken = envelope.token;
                    if (typeof dispatchToken !== 'string') return { ok: false, reason: 'malformed-request' };
                    const params = envelope.params;
                    const paramsDigest = canonicalManagedPayloadDigest(params ?? {});
                    try { observedNow = now(); } catch { return { ok: false, reason: 'credential-clock-invalid' }; }
                    if (!Number.isSafeInteger(observedNow) || observedNow < 0) return { ok: false, reason: 'credential-clock-invalid' };
                    const verified = verifyManagedDispatchMaterial({ token: dispatchToken, verifier, runtimeId, workspaceId,
                        provisioningOperationId, op: 'credential', paramsDigest, now: observedNow });
                    if (!verified.ok) return { ok: false, reason: `token-${verified.reason}` };
                    if (verified.claims.projectId !== projectId) return { ok: false, reason: 'token-wrong-project' };
                    if (verified.claims.kid !== keyId) return { ok: false, reason: 'token-unknown-key' };
                    const normalized = normalizeManagedCredentialParams(params, () => {
                        observedNow = now();
                        return observedNow;
                    });
                    if (!normalized.ok) return normalized;
                    // All request fields and admitted axes are owned before the first write await.
                    replacement = normalized.replacement;
                } catch {
                    return { ok: false, reason: 'malformed-request' };
                }
                try {
                    return await replaceManagedDaemonCredential({ stateDir, expectedMachineId: happyMachineId,
                        replacement, now: observedNow, deps, write });
                } catch {
                    // The durable writer's errors are classified by replace; this is a failed stored read.
                    return { ok: false, reason: 'credential-unreadable' };
                }
            } finally {
                busy = false;
            }
        },
    };
}


type ManagedCredentialReplacement = { token: string; machineId: string; serverOrigin: string; expiresAt: number };

function normalizeManagedCredentialParams(params: unknown, now: () => number):
    | { ok: true; replacement: ManagedCredentialReplacement }
    | { ok: false; reason: 'malformed-request' | 'credential-expired' | 'credential-clock-invalid' } {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, reason: 'malformed-request' };
    const body = params as Record<string, unknown>;
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const machineId = typeof body.machineId === 'string' ? body.machineId.trim() : '';
    const serverOrigin = typeof body.serverOrigin === 'string' ? body.serverOrigin.trim() : '';
    const expiresAt = body.expiresAt;
    if (!token || !machineId || !serverOrigin || typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)) {
        return { ok: false, reason: 'malformed-request' };
    }
    let observedNow: number;
    try { observedNow = now(); } catch { return { ok: false, reason: 'credential-clock-invalid' }; }
    if (!Number.isSafeInteger(observedNow) || observedNow < 0) return { ok: false, reason: 'credential-clock-invalid' };
    if (expiresAt <= observedNow) return { ok: false, reason: 'credential-expired' };
    return { ok: true, replacement: { token, machineId, serverOrigin, expiresAt } };
}
