import { constants } from 'node:fs';
import { open, link, lstat, readdir, readFile, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalOrgSetupTokenJson, verifyOrgSetupTokenDocument, type OrgSetupTokenDocument } from '@slopus/happy-wire';
import { deviceDirectory, type DeviceKeys } from './deviceKeys';
import { protectStandaloneObservationDirectory } from './standaloneLaunchJournal';

export type DeviceOrgPin = { publicKey: string; approval: OrgSetupTokenDocument };
const schema = z.object({ version: z.literal(1), policy: z.literal('signed-required'), publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/), approval: z.unknown() }).strict();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** Windows PowerShell ACL checks open every entry of the device directory and cannot open a path past MAX_PATH.
 * The deepest Desktop root is C:\ProgramData\Saycode-Secrets-<SID>\machine-links\machines\<64 hex>\device-<64 hex>,
 * about 241 chars with a 50-char SID, so every entry name stays within this budget. */
export const DEVICE_ENTRY_NAME_BUDGET = 16;
/** Per-company state in the device directory: 32 bits of the company hash. A collision only fails closed, because
 * the stored approval and assignment statements name their company and are re-checked on read. */
export const deviceStateName = (kind: 'o' | 'a', companyId: string) => kind + '-' + hash(companyId).slice(0, 8) + '.json';
export const deviceTempName = (kind: 'o' | 'a') => kind + '-' + randomBytes(3).toString('hex') + '.tmp';
const LEGACY_LONG_NAME = /^(org|assignments)-([0-9a-f]{8})[0-9a-f]{56}\.json$/;
const LEGACY_TEMP_NAME = /^(?:org|assignments)-[0-9a-f-]{36}\.tmp$/;
const PIN_MAX_BYTES = 70000;
export type LegacyDeviceStateRename = { name: string; outcome: 'renamed' | 'duplicate' | 'quarantined' | 'removed' | 'skipped' };

/** CLI ≤ 1.1.10-aplus.338 named pins and the signed assignment state with the full company hash, ~279 chars deep on
 * every Windows install, so the next daemon start failed its ACL check as "reapproval required". Rename them before
 * the device directory is checked. Contents are never trusted here, only compared: a legacy file that disagrees with an
 * existing short one is set aside under a short name no store opens (left in place it would fail every start), and
 * anything that is not a plain file of pin size is left alone so the directory check still fails closed. */
export async function migrateLegacyDeviceState(home: string, machineId: string): Promise<LegacyDeviceStateRename[]> {
    const directory = deviceDirectory(home, machineId);
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const results: LegacyDeviceStateRename[] = [];
    for (const name of names) {
        const match = LEGACY_LONG_NAME.exec(name), temp = LEGACY_TEMP_NAME.test(name);
        if (!match && !temp) continue;
        const legacy = join(directory, name), info = await lstat(legacy);
        if (!info.isFile() || info.size > PIN_MAX_BYTES) { results.push({ name, outcome: 'skipped' }); continue; }
        // An older CLI's temp file was never published, so it holds no committed state.
        if (!match) { await unlink(legacy); results.push({ name, outcome: 'removed' }); continue; }
        const target = join(directory, (match[1] === 'org' ? 'o' : 'a') + '-' + match[2] + '.json');
        let outcome: LegacyDeviceStateRename['outcome'] = 'renamed';
        try { await link(legacy, target); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            outcome = (await readFile(legacy)).equals(await readFile(target)) ? 'duplicate' : 'quarantined';
            if (outcome === 'quarantined') await link(legacy, join(directory, 'q-' + randomBytes(3).toString('hex') + '.json'));
        }
        await unlink(legacy);
        results.push({ name, outcome });
    }
    return results;
}
/** Initial pins are immutable. Rotation/revocation require separate authenticated transitions.
 * Only the enrollment coordinator calls pin after both confirmations. No trust in remote flags.
 */
export function createDeviceOrgPinStore(deps: { home: string; machineId: string; keys: DeviceKeys }) {
    const directory = deviceDirectory(deps.home, deps.machineId);
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
        try { file = await open(join(directory, deviceStateName('o', companyId)), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
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
            const temporary = join(directory, deviceTempName('o'));
            try {
                const file = await open(temporary, 'wx', 0o600);
                try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
                await protectStandaloneObservationDirectory(directory);
                // Publish a fully flushed file without replacing any existing pin, even across processes.
                try { await link(temporary, join(directory, deviceStateName('o', companyId))); }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                    if (canonicalOrgSetupTokenJson(await get(companyId)) !== serialized) throw new Error('ORG_PIN_CONFLICT');
                }
                await syncDirectory();
            } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
        },
    };
}
