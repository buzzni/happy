import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import nacl from 'tweetnacl';
import { z } from 'zod';
import { protectStandaloneObservationDirectory } from './standaloneLaunchJournal';

export type DeviceKeys = { signing: nacl.SignKeyPair; recipient: nacl.BoxKeyPair };
const reapproval = (cause?: unknown) => new Error('Device key unavailable; reapproval required', cause === undefined ? undefined : { cause });
const binary = z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine(value => Buffer.from(value, 'base64url').toString('base64url') === value);
const recordSchema = z.object({ version: z.literal(1), machineId: z.string(), signingSeed: binary, signingPublic: binary, recipientSecret: binary, recipientPublic: binary }).strict();

async function syncDirectory(directory: string): Promise<void> {
    // Windows directory handles do not support Node's fsync; ACLs are checked separately.
    if (process.platform === 'win32') return;
    const handle = await open(directory, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
}
async function readKeys(directory: string, machineId: string): Promise<DeviceKeys> {
    await protectStandaloneObservationDirectory(directory);
    const file = await open(join(directory, 'keys.json'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let bytes: Buffer | undefined;
    try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > 4096 || (process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600))) throw reapproval();
        bytes = await file.readFile();
        const record = recordSchema.parse(JSON.parse(bytes.toString('utf8')));
        if (record.machineId !== machineId) throw reapproval();
        const seed = Buffer.from(record.signingSeed, 'base64url');
        const recipient = Buffer.from(record.recipientSecret, 'base64url');
        try {
            const keys = { signing: nacl.sign.keyPair.fromSeed(seed), recipient: nacl.box.keyPair.fromSecretKey(new Uint8Array(recipient)) };
            if (Buffer.from(keys.signing.publicKey).toString('base64url') !== record.signingPublic || Buffer.from(keys.recipient.publicKey).toString('base64url') !== record.recipientPublic) {
                keys.signing.secretKey.fill(0); keys.recipient.secretKey.fill(0);
                throw reapproval();
            }
            return keys;
        } finally { seed.fill(0); recipient.fill(0); }
    } finally { bytes?.fill(0); await file.close(); }
}

/** A new directory is an exclusive initialization claim. Never reclaim an incomplete existing directory.
 * Missing/corrupt keys require explicit re-enrollment; this does not load or preserve an old approval.
 * The caller supplies HAPPY_HOME and the authenticated local machine ID, never a remote path.
 */
export async function loadOrCreateDeviceKeys(home: string, machineId: string): Promise<DeviceKeys> {
    if (!isAbsolute(home) || !machineId || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(machineId) || /[\u0000-\u001f\u007f-\u009f]/.test(machineId)) throw reapproval();
    const root = await lstat(home);
    if (!root.isDirectory() || root.isSymbolicLink() || (process.platform !== 'win32' && (root.uid !== process.getuid?.() || (root.mode & 0o022) !== 0))) throw reapproval();
    const directory = join(home, 'device-' + createHash('sha256').update(machineId).digest('hex'));
    let created = false;
    try { await mkdir(directory, { mode: 0o700 }); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (created) {
        // Establish and verify Windows protection before writing any private bytes.
        await protectStandaloneObservationDirectory(directory, true);
        // mkdir grants exactly one initializer. Keep its unpublished path no longer than keys.json
        // so Windows PowerShell ACL checks can protect it whenever the committed path fits MAX_PATH.
        const temporary = join(directory, '.keys.tmp');
        const signing = nacl.sign.keyPair();
        const recipient = nacl.box.keyPair();
        let serialized: Buffer | undefined;
        try {
            serialized = Buffer.from(JSON.stringify({ version: 1, machineId, signingPublic: Buffer.from(signing.publicKey).toString('base64url'), recipientPublic: Buffer.from(recipient.publicKey).toString('base64url'), signingSeed: Buffer.from(signing.secretKey.subarray(0, 32)).toString('base64url'), recipientSecret: Buffer.from(recipient.secretKey).toString('base64url') }));
            const file = await open(temporary, 'wx', 0o600);
            try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
            await protectStandaloneObservationDirectory(directory);
            await rename(temporary, join(directory, 'keys.json'));
            await syncDirectory(directory);
            await syncDirectory(home);
        } finally {
            signing.secretKey.fill(0); recipient.secretKey.fill(0); serialized?.fill(0);
            await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
        }
    }
    // A simultaneous creator may still be flushing. A crashed creator stays fail-closed;
    // timeout never grants permission to generate replacement keys.
    const deadline = Date.now() + (process.platform === 'win32' ? 30_000 : 1_000);
    for (;;) {
        try {
            // A creator has not published keys.json yet. Do not inspect its partial directory
            // or spawn another PowerShell ACL check on every missing-file retry.
            await lstat(join(directory, 'keys.json'));
            return await readKeys(directory, machineId);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() >= deadline) throw reapproval(error);
            await delay(20);
        }
    }
}
