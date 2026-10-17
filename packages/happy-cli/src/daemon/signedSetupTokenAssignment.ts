/**
 * specs/org-setup-token-device-approval contract §4·§5 — server-lane setup-token delivery.
 * The daemon trusts only the organization key it pinned after local confirmation: the
 * approval must be that pin, every assignment statement must be signed by that key for
 * this principal, and the opened payload must carry exactly the signed accounts. Accepted
 * statement revisions are persisted so an older or conflicting statement is refused after
 * a restart. Installation itself stays on the existing sealed setup-token path.
 */
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalOrgSetupTokenJson, verifyOrgSetupTokenDocument, type OrgSetupTokenDocument } from '@slopus/happy-wire';
import type { DeviceKeys } from './deviceKeys';
import { openSetupTokenAssignment, type SetupTokenAssignmentRecipient } from './setupTokenAssignmentWire';
import { protectStandaloneObservationDirectory } from './standaloneLaunchJournal';

type AssignmentBody = Extract<OrgSetupTokenDocument['body'], { kind: 'ai-assignment' }>;
type Pin = { publicKey: string; approval: OrgSetupTokenDocument };
const MAX_STATEMENTS = 16;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fail(code: string): never {
    throw new Error(code);
}
/** Only an RPC error code leaves the verifier; anything else would carry paths or parser text to the caller. */
async function failingWith<T>(code: string, work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch { fail(code); }
}
/** A document for another key is a context problem and a malformed one is bad input, not a forgery. */
function verified(document: string, key: Uint8Array) {
    return verifyOrgSetupTokenDocument(document, key).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : '';
        fail(message === 'Invalid signature' ? 'SIGNATURE_INVALID' : message === 'Signing key mismatch' ? 'CONTEXT_MISMATCH' : 'AI_GROUP_INVALID_INPUT');
    });
}

/** contract §4 credentialDigest, computed from the opened payload; the web server signs the same value. */
export function setupTokenAccountDigest(input: { companyId: string; managedAccountId: string; credentialGeneration: number; displayName: string; accessToken: string }): string {
    return hash('saycode/setup-token-account/v1\n' + canonicalOrgSetupTokenJson({ ...input, provider: 'claude' }));
}

const inputSchema = z.object({
    approval: z.string().min(1).max(12_000),
    assignments: z.array(z.string().min(1).max(64 * 1024)).max(MAX_STATEMENTS),
    scope: z.string().min(1).max(512),
    sealedPayload: z.unknown(),
}).passthrough();
const stateSchema = z.object({
    version: z.literal(1),
    accepted: z.record(z.string(), z.object({ revision: z.number().int().positive(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
}).strict();

export function createSignedSetupTokenVerifier(deps: {
    home: string;
    machineId: string;
    keys: DeviceKeys;
    pins: { get(companyId: string): Promise<Pin | null> };
    recipient: Pick<SetupTokenAssignmentRecipient, 'keyId' | 'secretKey'>;
    now: () => number;
    killSwitch?: () => boolean;
}) {
    const directory = join(deps.home, 'device-' + hash(deps.machineId));
    let queue: Promise<unknown> = Promise.resolve();

    async function readState(companyId: string) {
        await failingWith('ASSIGNMENT_STATE_INVALID', () => protectStandaloneObservationDirectory(directory));
        let file;
        try { file = await open(join(directory, 'assignments-' + hash(companyId) + '.json'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1 as const, accepted: {} }; fail('ASSIGNMENT_STATE_INVALID'); }
        return failingWith('ASSIGNMENT_STATE_INVALID', async () => {
            try {
                const info = await file.stat();
                if (!info.isFile() || info.size > 1024 * 1024 || (process.platform !== 'win32' && (info.mode & 0o777) !== 0o600)) fail('ASSIGNMENT_STATE_INVALID');
                return stateSchema.parse(JSON.parse(await file.readFile('utf8')));
            } finally { await file.close(); }
        });
    }
    async function writeState(companyId: string, state: z.infer<typeof stateSchema>) {
        const temporary = join(directory, 'assignments-' + randomUUID() + '.tmp');
        await failingWith('ASSIGNMENT_STATE_INVALID', async () => {
            try {
                const file = await open(temporary, 'wx', 0o600);
                try { await file.writeFile(canonicalOrgSetupTokenJson(state)); await file.sync(); } finally { await file.close(); }
                await rename(temporary, join(directory, 'assignments-' + hash(companyId) + '.json'));
                // The rename itself must survive a crash, or an older revision becomes acceptable again after restart.
                if (process.platform !== 'win32') { const dir = await open(directory, constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); } }
            } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
        });
    }

    async function verifyOnce(raw: unknown) {
        // Kill switch, local trust and shape come before any decryption (contract §5 step 1).
        if (deps.killSwitch?.()) fail('CLAUDE_SETUP_TOKEN_ASSIGNMENT_DISABLED');
        const parsed = inputSchema.safeParse(raw);
        if (!parsed.success) fail('AI_GROUP_INVALID_INPUT');
        const { approval, assignments, ...outer } = parsed.data;
        const companyId = outer.scope;
        const pin = await failingWith('ORG_PIN_INVALID', () => deps.pins.get(companyId));
        if (!pin) fail('DEVICE_APPROVAL_REQUIRED');
        const pinKey = Buffer.from(pin.publicKey, 'base64url');
        const pinned = pin.approval.body;
        if (pinned.kind !== 'device-approval') fail('DEVICE_APPROVAL_REQUIRED');
        const presented = await verified(approval, pinKey);
        // Revocation and rotation are not accepted yet, so only the pinned approval itself is valid.
        if (canonicalOrgSetupTokenJson(presented) !== canonicalOrgSetupTokenJson(pin.approval)) fail('DEVICE_APPROVAL_MISMATCH');
        if (!assignments.length) fail('SIGNED_ASSIGNMENT_REQUIRED');
        const statements: AssignmentBody[] = [];
        for (const document of assignments) {
            const body = (await verified(document, pinKey)).body;
            if (body.kind !== 'ai-assignment' || body.companyId !== companyId
                || body.signingGeneration !== pinned.signingGeneration || body.signingKeyId !== pinned.signingKeyId) fail('CONTEXT_MISMATCH');
            statements.push(body as AssignmentBody);
        }
        let context: ReturnType<typeof openSetupTokenAssignment>;
        try { context = openSetupTokenAssignment(outer.sealedPayload, deps.recipient, deps.now()); }
        catch (error) { throw error instanceof Error && /^SETUP_TOKEN_/.test(error.message) ? error : new Error('SETUP_TOKEN_SEALED_PAYLOAD_INVALID'); }
        // Membership of the user group stays a server decision (D3); the principal must still be this machine's.
        const sharedPrincipal = context.principalType === 'machine';
        if (context.scope !== companyId || context.machineId !== deps.machineId
            || (sharedPrincipal
                ? pinned.machineType !== 'shared' || statements.some(body => body.target.kind !== 'machine' || body.target.id !== deps.machineId)
                : pinned.machineType !== 'dedicated' || context.userId !== pinned.ownerUserId || statements.some(body => body.target.kind !== 'user-group')))
            fail('CONTEXT_MISMATCH');

        const signed = new Map<string, { generation: number; digest: string }>();
        for (const body of statements) for (const entry of body.accounts) {
            const seen = signed.get(entry.managedAccountId);
            if (seen && (seen.generation !== entry.credentialGeneration || seen.digest !== entry.credentialDigest)) fail('ASSIGNMENT_CONTENT_MISMATCH');
            signed.set(entry.managedAccountId, { generation: entry.credentialGeneration, digest: entry.credentialDigest });
        }
        let accounts: unknown;
        try { accounts = (JSON.parse(context.payload) as { accounts?: unknown }).accounts; } catch { fail('ASSIGNMENT_CONTENT_MISMATCH'); }
        if (!Array.isArray(accounts) || accounts.length !== signed.size) fail('ASSIGNMENT_CONTENT_MISMATCH');
        const delivered = new Set<string>();
        for (const value of accounts as Array<Record<string, unknown>>) {
            const accessToken = (value?.credentials as { claudeAiOauth?: { accessToken?: unknown } } | undefined)?.claudeAiOauth?.accessToken;
            // Every delivered account must be an organization setup-token covered by the signed statements.
            if (value?.credentialType !== 'setup_token' || typeof value.managedAccountId !== 'string' || delivered.has(value.managedAccountId)
                || !Number.isSafeInteger(value.credentialGeneration) || typeof value.displayName !== 'string' || typeof accessToken !== 'string') fail('ASSIGNMENT_CONTENT_MISMATCH');
            const managedAccountId = value.managedAccountId as string;
            const expected = signed.get(managedAccountId);
            const digest = await failingWith('ASSIGNMENT_CONTENT_MISMATCH', async () => setupTokenAccountDigest({ companyId, managedAccountId,
                credentialGeneration: Number(value.credentialGeneration), displayName: value.displayName as string, accessToken: accessToken as string }));
            if (!expected || expected.generation !== value.credentialGeneration || expected.digest !== digest) fail('ASSIGNMENT_CONTENT_MISMATCH');
            delivered.add(managedAccountId);
        }

        const state = await readState(companyId);
        const next = { ...state.accepted };
        for (const body of statements) {
            const key = `${body.target.kind}:${body.bindingId}`;
            const digest = hash(canonicalOrgSetupTokenJson(body));
            const previous = next[key];
            if (previous && body.assignmentRevision < previous.revision) fail('REVISION_STALE');
            if (previous && body.assignmentRevision === previous.revision && previous.digest !== digest) fail('REVISION_CONFLICT');
            next[key] = { revision: body.assignmentRevision, digest };
        }
        // Persist before installing so a failed install retried with the same statement still passes, and an older one never does.
        await writeState(companyId, { version: 1, accepted: next });
        return outer;
    }

    return {
        /** Returns the plain setup-token-group-sync input once every signed check has passed. */
        verify(raw: unknown): Promise<Record<string, unknown>> {
            const run = queue.then(() => verifyOnce(raw));
            queue = run.catch(() => undefined);
            return run;
        },
    };
}
