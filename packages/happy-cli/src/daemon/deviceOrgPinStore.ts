import { constants } from 'node:fs';
import { open, link, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalOrgSetupTokenJson, verifyOrgSetupTokenDocument, type OrgSetupTokenDocument } from '@slopus/happy-wire';
import type { DeviceKeys } from './deviceKeys';
import { protectStandaloneObservationDirectory } from './standaloneLaunchJournal';

export type DeviceOrgPin = { publicKey: string; approval: OrgSetupTokenDocument };
const schema = z.object({ version: z.literal(1), policy: z.literal('signed-required'), publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/), approval: z.unknown() }).strict();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** Initial pins are immutable. Rotation/revocation require separate authenticated transitions.
 * Only the enrollment coordinator calls pin after both confirmations. No trust in remote flags.
 */
export function createDeviceOrgPinStore(deps: { home: string; machineId: string; keys: DeviceKeys }) {
    const directory = join(deps.home, 'device-' + hash(deps.machineId));
    async function validate(value: unknown, companyId?: string) {
        const record = schema.parse(value);
        const publicKey = Buffer.from(record.publicKey, 'base64url');
        if (publicKey.toString('base64url') !== record.publicKey) throw new Error('ORG_PIN_INVALID');
        const approval = await verifyOrgSetupTokenDocument(canonicalOrgSetupTokenJson(record.approval), publicKey);
        const body = approval.body;
        if (body.kind !== 'device-approval' || (companyId !== undefined && body.companyId !== companyId) ||
            body.machineId !== deps.machineId || body.deviceSigningPublicKey !== Buffer.from(deps.keys.signing.publicKey).toString('base64url') ||
            body.recipientPublicKey !== Buffer.from(deps.keys.recipient.publicKey).toString('base64url')) throw new Error('ORG_PIN_INVALID');
        return { version: 1 as const, policy: 'signed-required' as const, publicKey: record.publicKey, approval };
    }
    async function syncDirectory() {
        if (process.platform === 'win32') return;
        const handle = await open(directory, constants.O_RDONLY);
        try { await handle.sync(); } finally { await handle.close(); }
    }
    async function get(companyId: string) {
        await protectStandaloneObservationDirectory(directory);
        let file;
        try { file = await open(join(directory, 'org-' + hash(companyId) + '.json'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
        try {
            const info = await file.stat();
            if (!info.isFile() || info.size > 70000 || (process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600))) throw new Error('ORG_PIN_INVALID');
            const raw = await file.readFile('utf8');
            const record = await validate(JSON.parse(raw), companyId);
            if (canonicalOrgSetupTokenJson(record) !== raw) throw new Error('ORG_PIN_INVALID');
            return record;
        } finally { await file.close(); }
    }
    return {
        get,
        async pin(candidate: DeviceOrgPin): Promise<void> {
            const record = await validate({ version: 1, policy: 'signed-required', ...candidate });
            const serialized = canonicalOrgSetupTokenJson(record);
            const companyId = record.approval.body.companyId;
            const existing = await get(companyId);
            if (existing) {
                if (canonicalOrgSetupTokenJson(existing) !== serialized) throw new Error('ORG_PIN_CONFLICT');
                await syncDirectory();
                return;
            }
            const temporary = join(directory, 'org-' + randomUUID() + '.tmp');
            try {
                const file = await open(temporary, 'wx', 0o600);
                try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
                await protectStandaloneObservationDirectory(directory);
                // Publish a fully flushed file without replacing any existing pin, even across processes.
                try { await link(temporary, join(directory, 'org-' + hash(companyId) + '.json')); }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                    if (canonicalOrgSetupTokenJson(await get(companyId)) !== serialized) throw new Error('ORG_PIN_CONFLICT');
                }
                await syncDirectory();
            } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
        },
    };
}
