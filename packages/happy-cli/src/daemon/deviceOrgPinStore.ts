import { constants } from 'node:fs';
import { open, link, readdir, readFile, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalOrgSetupTokenJson, verifyOrgSetupTokenDocument, type OrgSetupTokenDocument } from '@slopus/happy-wire';
import type { DeviceKeys } from './deviceKeys';
import { protectStandaloneObservationDirectory } from './standaloneLaunchJournal';

export type DeviceOrgPin = { publicKey: string; approval: OrgSetupTokenDocument };
const schema = z.object({ version: z.literal(1), policy: z.literal('signed-required'), publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/), approval: z.unknown() }).strict();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** Windows PowerShell ACL checks open every entry of the device directory and cannot open a path past
 * MAX_PATH. The directory itself is ~200 chars deep on Windows, so pin names stay short: 64 bits of the
 * company hash (a collision only fails closed, because the stored approval names its company). */
const pinName = (companyId: string) => 'org-' + hash(companyId).slice(0, 16) + '.json';
const LEGACY_PIN_NAME = /^org-([0-9a-f]{16})[0-9a-f]{48}\.json$/;

/** CLI ≤ 1.1.10-aplus.338 named pins with the full company hash, ~279 chars deep on every Windows install,
 * which made the next daemon start fail its ACL check as "reapproval required". Rename them before the
 * device directory is checked. A legacy pin that disagrees with an existing short one is left in place
 * (fail closed); its contents are never trusted here, only compared. */
export async function migrateLegacyOrgPinNames(home: string, machineId: string): Promise<void> {
    const directory = join(home, 'device-' + hash(machineId));
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const name of names) {
        const short = LEGACY_PIN_NAME.exec(name)?.[1];
        if (!short) continue;
        const legacy = join(directory, name), target = join(directory, 'org-' + short + '.json');
        try { await link(legacy, target); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            if (!(await readFile(legacy)).equals(await readFile(target))) continue;
        }
        await unlink(legacy);
    }
}
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
        try { file = await open(join(directory, pinName(companyId)), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
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
            const temporary = join(directory, 'org-' + randomBytes(4).toString('hex') + '.tmp');
            try {
                const file = await open(temporary, 'wx', 0o600);
                try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
                await protectStandaloneObservationDirectory(directory);
                // Publish a fully flushed file without replacing any existing pin, even across processes.
                try { await link(temporary, join(directory, pinName(companyId))); }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                    if (canonicalOrgSetupTokenJson(await get(companyId)) !== serialized) throw new Error('ORG_PIN_CONFLICT');
                }
                await syncDirectory();
            } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
        },
    };
}
