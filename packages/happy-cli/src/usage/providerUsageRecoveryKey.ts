import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { decrypt, encrypt } from '@/api/encryption';
import type { Credentials } from '@/persistence';
import { logger } from '@/ui/logger';
const digest = (material: Uint8Array) => createHash('sha256').update(material).digest('hex');
const master = (material: Uint8Array) => new Uint8Array(createHash('sha256').update('happy-usage-recovery-v1').update(material).digest());
const file = (root: string, material: Uint8Array) => join(root, `recovery-key-${digest(material)}.enc`);
export function usageRecoveryMaterial(credentials: Credentials): Uint8Array {
    return credentials.encryption.type === 'legacy' ? credentials.encryption.secret : credentials.encryption.machineKey;
}
/** Compatibility: pre-key-wrapper manifests used this derived key directly. */
export function loadUsageRecoveryKey(root: string, material: Uint8Array): Uint8Array {
    let text: string;
    try { text = readFileSync(file(root, material), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return master(material); throw error; }
    const value = decrypt(master(material), 'dataKey', Buffer.from(text, 'base64'));
    if (value?.version !== 1 || typeof value.key !== 'string' || Buffer.from(value.key, 'base64').length !== 32) throw new Error('usage recovery key unavailable; encrypted queues retained');
    return new Uint8Array(Buffer.from(value.key, 'base64'));
}
/** Called by the already-authorized machine rotation/reseed commit, BEFORE replacing access.key. */
export async function rewrapUsageRecoveryKey(root: string, previous: Credentials, next: Credentials): Promise<void> {
    if (previous.token !== next.token) throw new Error('usage recovery rewrap requires the same authorized account');
    const oldMaterial = usageRecoveryMaterial(previous), newMaterial = usageRecoveryMaterial(next);
    const key = loadUsageRecoveryKey(root, oldMaterial);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const target = file(root, newMaterial), temporary = `${target}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
        fd = openSync(temporary, 'wx', 0o600);
        writeFileSync(fd, Buffer.from(encrypt(master(newMaterial), 'dataKey', { version: 1, key: Buffer.from(key).toString('base64') })).toString('base64'));
        fsyncSync(fd); closeSync(fd); fd = undefined;
        renameSync(temporary, target);
        if (process.platform !== 'win32') { fd = openSync(root, 'r'); fsyncSync(fd); closeSync(fd); fd = undefined; }
    } finally {
        if (fd !== undefined) { try { closeSync(fd); } catch { logger.warn('[USAGE] Recovery key handle cleanup failed'); } }
        try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn('[USAGE] Recovery key temporary retained'); }
    }
}
