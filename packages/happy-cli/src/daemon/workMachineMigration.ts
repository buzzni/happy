/**
 * `happy work-machine target-approval | export | import | restore-proof`
 * (aplus-dev-studio specs/work-machine-migration plan 5.1, 5.4, 5.6).
 *
 * - target-approval: the target binds a fresh per-job recipient key to its device signing key.
 * - export: on the stopped source, seals the planned selection with the existing archive envelope,
 *   uploads it in parts and submits the manifest the source device signs. `--check` runs the same
 *   selection and credential scan without stopping anything, sealing or uploading.
 * - import: on the target, verifies the manifest signature and every part, restores into staging,
 *   places the data at the same absolute paths without overwriting anything, writes the session
 *   recovery records, rotates the machine data key and reports the execution-replace proof.
 * - restore-proof: on the original source, rotates its data key and signs the restore scope.
 *
 * State lives in `HAPPY_HOME/work-machine-transfer/<jobId>/` (0700): the recipient key, the sealed
 * export with its part digests (a rerun resumes the same bytes), downloaded parts and the restore
 * report (a rerun re-sends it after a lost answer). Restore proofs are kept in
 * `HAPPY_HOME/work-machine-restore/<machineId>-<generation>.json` for the same reason.
 *
 * Uploaded object = sealed archive ‖ receipt JSON ‖ uint32be(receipt length) ‖ "WMR1". The manifest
 * field list of plan 5.6 has no receipt, so it travels inside the signed part digests.
 */
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import {
    appendFile, copyFile, cp, lstat, mkdir, open, readFile, rename, rm, stat, statfs, truncate, writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import nacl from 'tweetnacl';
import { z } from 'zod';
import { encodeBase64, wrapDataEncryptionKey } from '@/api/encryption';
import { parseCredentials, replacePrivateFile } from '@/persistence';
import { loadOrCreateDeviceKeys, type DeviceKeys } from './deviceKeys';
import { readWorkMachineExecutionBinding, workMachineSigningIdentity } from './workMachineCredential';
import { extractWorkMachineArchive, packWorkMachineArchive, selectWorkMachineTransfer } from './workMachineTransferArchive';
import {
    digestRange, openWorkMachineTransfer, workMachineIdentifier, type WorkMachineDeviceProof, type WorkMachinePart,
} from './workMachineTransferClient';
import { proveWorkMachineArchiveRecipient, restoreWorkMachineArchive, sealWorkMachineArchive, type WorkMachineArchiveApproval } from './workMachineTransferEnvelope';

export const WORK_MACHINE_PART_SIZE = 8 * 1024 ** 2;
const RECEIPT_MAGIC = Buffer.from('WMR1');
/** A receipt is a few KiB of JSON; the bound keeps a hostile length from sizing an allocation. */
const MAX_RECEIPT_BYTES = 64 * 1024;
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const deviceId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const manifestSchema = z.object({
    jobId: workMachineIdentifier,
    machineId: workMachineIdentifier,
    archiveVersion: z.union([z.number().int().nonnegative(), workMachineIdentifier]),
    sourceDeviceId: deviceId,
    generation: z.number().int().min(1),
    partSize: z.number().int().positive().max(64 * 1024 ** 2),
    totalBytes: z.number().int().positive(),
    parts: z.array(z.object({ n: z.number().int().nonnegative(), size: z.number().int().positive(), sha256: sha256Hex })).min(1).max(100_000),
    sessions: z.array(z.object({
        sessionId: workMachineIdentifier,
        provider: z.enum(['claude', 'codex']),
        nativeId: z.string().min(1).max(200),
        lastProcessedSeq: z.number().int().nonnegative(),
    })).max(5000),
    paths: z.array(z.string()).min(1).max(10_000),
    createdAt: z.number().int().positive(),
});
type Manifest = z.infer<typeof manifestSchema>;
const exportStateSchema = manifestSchema.omit({ jobId: true, machineId: true, sourceDeviceId: true, generation: true })
    .extend({ md5: z.array(z.string()) });
const recipientFileSchema = z.object({ approval: z.unknown(), recipientSecret: z.string() });
const restoredSchema = z.object({ deviceId, dataEncryptionKey: z.string(), proof: z.unknown(), manifestSha256: sha256Hex });
const placingSchema = z.object({ manifestSha256: sha256Hex, placed: z.array(z.string()) });
const restoreProofSchema = z.object({
    deviceId, dataEncryptionKey: z.string(),
    proof: z.object({ issuedAt: z.number(), publicKey: z.string(), signature: z.string() }),
    machineKeySha256: sha256Hex,
});

type TransferEndpoint = {
    home: string;
    studioUrl: string;
    jobId: string;
    token: string;
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<unknown>;
};

async function jobDirectory(home: string, jobId: string, ...parts: string[]): Promise<string> {
    const path = join(home, 'work-machine-transfer', workMachineIdentifier.parse(jobId), ...parts);
    await mkdir(path, { recursive: true, mode: 0o700 });
    return path;
}

async function readJson(path: string): Promise<unknown> {
    const contents = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
    });
    return contents === null ? null : JSON.parse(contents);
}

async function exists(path: string): Promise<boolean> {
    return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
    });
}

async function withDeviceKeys<T>(home: string, machineId: string, work: (keys: DeviceKeys) => Promise<T> | T): Promise<T> {
    const keys = await loadOrCreateDeviceKeys(home, machineId);
    try {
        return await work(keys);
    } finally {
        keys.signing.secretKey.fill(0);
        keys.recipient.secretKey.fill(0);
    }
}

/** The plan 5.6 device signature: ed25519 over `JSON.stringify(scope)`, SPKI public key. */
function signScope(keys: DeviceKeys, scope: (issuedAt: number) => unknown[]): WorkMachineDeviceProof {
    const issuedAt = Date.now();
    const message = Buffer.from(JSON.stringify(scope(issuedAt)));
    return {
        issuedAt,
        publicKey: workMachineSigningIdentity(keys.signing.publicKey).publicKey,
        signature: Buffer.from(nacl.sign.detached(message, keys.signing.secretKey)).toString('base64url'),
    };
}

const accessKeySchema = z.object({ encryption: z.object({ machineKey: z.string() }).passthrough() }).passthrough();
/** Names the machine key in access.key without keeping a copy of it. */
async function machineKeyDigest(home: string): Promise<string | null> {
    const stored = accessKeySchema.safeParse(await readJson(join(home, 'access.key')));
    return stored.success ? createHash('sha256').update(stored.data.encryption.machineKey).digest('hex') : null;
}

/**
 * Replaces this home's machine data key and returns the new envelope (base64, as machine
 * registration sends it: 105 bytes) with the proof-scope digest, base64url sha256 over those bytes.
 * Only `encryption.machineKey` changes: the token, `neverEscrowed` (the new key goes to the
 * account key alone, never to the server) and any field a newer CLI added stay as they were.
 * The previous access.key is kept once beside it.
 */
async function rotateMachineDataKey(home: string, backupSuffix: string): Promise<{ dataEncryptionKey: string; digest: string }> {
    const accessKey = join(home, 'access.key');
    const raw = await readJson(accessKey);
    const credentials = parseCredentials(raw);
    const stored = accessKeySchema.safeParse(raw);
    if (credentials?.encryption.type !== 'dataKey' || !stored.success) {
        throw new Error('This home needs a dataKey account login (access.key) to rotate the machine data key');
    }
    await copyFile(accessKey, `${accessKey}.before-${backupSuffix}`, constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
    });
    const machineKey = randomBytes(32);
    try {
        const envelope = wrapDataEncryptionKey(machineKey, credentials.encryption.publicKey);
        await replacePrivateFile(accessKey, JSON.stringify({
            ...stored.data, encryption: { ...stored.data.encryption, machineKey: encodeBase64(machineKey) },
        }, null, 2));
        return { dataEncryptionKey: encodeBase64(envelope), digest: createHash('sha256').update(envelope).digest('base64url') };
    } finally {
        machineKey.fill(0);
    }
}

export async function createWorkMachineTargetApproval(input: {
    home: string; machineId: string; jobId: string; accountId: string; generation: number;
    sourceDeviceId: string; expiresAt: number; maxBytes: number;
}): Promise<WorkMachineArchiveApproval> {
    const directory = await jobDirectory(input.home, input.jobId);
    const recipient = nacl.box.keyPair();
    try {
        const approval = await withDeviceKeys(input.home, input.machineId, keys => proveWorkMachineArchiveRecipient({
            taskId: input.jobId, machineId: input.machineId, accountId: input.accountId, generation: input.generation,
            sourceDeviceId: input.sourceDeviceId, targetDeviceId: workMachineSigningIdentity(keys.signing.publicKey).deviceId,
            expiresAt: input.expiresAt, maxBytes: input.maxBytes,
        }, { signing: keys.signing, recipient }));
        await writeFile(join(directory, 'recipient.json'), JSON.stringify({
            approval, recipientSecret: Buffer.from(recipient.secretKey).toString('base64url'),
        }), { mode: 0o600, flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'EEXIST') throw new Error(`A recipient approval already exists for job ${input.jobId}`);
            throw error;
        });
        return approval;
    } finally {
        recipient.secretKey.fill(0);
    }
}

/** The Studio plan, checked against this home's execution binding: this must be its source. */
async function sourcePlan(client: ReturnType<typeof openWorkMachineTransfer>, input: TransferEndpoint) {
    const plan = await client.plan();
    const binding = await readWorkMachineExecutionBinding(input.home);
    if (plan.jobId !== input.jobId || !binding || binding.machineId !== plan.machineId || binding.generation !== plan.generation) {
        throw new Error('This home is not the source work machine and generation of the transfer plan');
    }
    const approval = plan.approval as WorkMachineArchiveApproval;
    if (approval?.taskId !== input.jobId || approval.machineId !== plan.machineId || approval.generation !== plan.generation
        || approval.sourceDeviceId !== binding.deviceId) {
        throw new Error('The target approval in the plan is for a different job, machine, generation or source device');
    }
    return { plan, binding, approval };
}

/**
 * `export --check`: the export's selection and credential scan while the source still runs (during
 * drain), so a blocker shows before freeze. Nothing is sealed, uploaded or signed, and the sessions'
 * stop records are not required yet: they exist only once the session processes have stopped.
 */
export async function checkWorkMachineExport(input: TransferEndpoint & { claudeConfigDir: string; codexHome: string }): Promise<{ sessions: string[]; paths: string[] }> {
    const { plan } = await sourcePlan(openWorkMachineTransfer(input), input);
    const selection = await selectWorkMachineTransfer({
        happyHome: input.home, claudeConfigDir: input.claudeConfigDir, codexHome: input.codexHome,
        projectPaths: plan.projectPaths, sessionIds: plan.sessions.map(session => session.sessionId), requireStopRecords: false,
    });
    return { sessions: selection.sessions.map(session => session.sessionId), paths: selection.roots };
}

export async function exportWorkMachine(input: TransferEndpoint & {
    claudeConfigDir: string;
    codexHome: string;
    /** Tests only; the contract is 8 MiB. */
    partSize?: number;
}): Promise<{ manifestSha256: string; totalBytes: number; parts: number }> {
    const client = openWorkMachineTransfer(input);
    const { plan, binding, approval } = await sourcePlan(client, input);

    const directory = await jobDirectory(input.home, input.jobId, 'export');
    const sealed = join(directory, 'transfer.bin');
    const statePath = join(directory, 'export.json');
    const stored = exportStateSchema.safeParse(await readJson(statePath));
    let state = stored.success && stored.data.archiveVersion === plan.archiveVersion ? stored.data : null;
    if (!state) {
        // Anything here is an earlier version or an interrupted seal; a resumed upload must reuse identical bytes.
        await rm(directory, { recursive: true, force: true });
        await mkdir(directory, { mode: 0o700 });
        const selection = await selectWorkMachineTransfer({
            happyHome: input.home, claudeConfigDir: input.claudeConfigDir, codexHome: input.codexHome,
            projectPaths: plan.projectPaths, sessionIds: plan.sessions.map(session => session.sessionId), requireStopRecords: true,
        });
        const recordsFile = join(directory, 'records.json');
        await writeFile(recordsFile, JSON.stringify(selection.records), { mode: 0o600, flag: 'wx' });
        const receipt = await withDeviceKeys(input.home, plan.machineId, sourceKeys => sealWorkMachineArchive({
            approval, sourceKeys, source: packWorkMachineArchive(selection, recordsFile), destination: sealed,
        }));
        await rm(recordsFile);
        const receiptBytes = Buffer.from(JSON.stringify(receipt));
        const length = Buffer.alloc(4);
        length.writeUInt32BE(receiptBytes.length);
        await appendFile(sealed, Buffer.concat([receiptBytes, length, RECEIPT_MAGIC]));

        const partSize = input.partSize ?? WORK_MACHINE_PART_SIZE;
        const totalBytes = (await stat(sealed)).size;
        const parts: WorkMachinePart[] = [];
        const md5: string[] = [];
        for (let n = 0; n * partSize < totalBytes; n += 1) {
            const size = Math.min(partSize, totalBytes - n * partSize);
            const digest = await digestRange(sealed, n * partSize, size);
            parts.push({ n, size, sha256: digest.sha256 });
            md5.push(digest.md5);
        }
        state = {
            archiveVersion: plan.archiveVersion, partSize, totalBytes, parts, md5,
            sessions: selection.sessions, paths: selection.roots, createdAt: Date.now(),
        };
        await replacePrivateFile(statePath, JSON.stringify(state));
    }

    for (const part of state.parts) {
        await client.uploadPart({ ...part, file: sealed, start: part.n * state.partSize, md5: state.md5[part.n] });
    }
    const manifest: Manifest = {
        jobId: input.jobId, machineId: plan.machineId, archiveVersion: state.archiveVersion, sourceDeviceId: binding.deviceId,
        generation: plan.generation, partSize: state.partSize, totalBytes: state.totalBytes, parts: state.parts,
        sessions: state.sessions, paths: state.paths, createdAt: state.createdAt,
    };
    const bytes = Buffer.from(JSON.stringify(manifest));
    const proof = await withDeviceKeys(input.home, plan.machineId, keys => signScope(keys, issuedAt => [
        'happy-work-machine-export-v1', input.jobId, createHash('sha256').update(bytes).digest('base64url'), issuedAt,
    ]));
    await client.submitManifest({ manifestB64: bytes.toString('base64url'), proof });
    return { manifestSha256: createHash('sha256').update(bytes).digest('hex'), totalBytes: state.totalBytes, parts: state.parts.length };
}

function verifiedManifest(signed: { manifestB64: string; proof: WorkMachineDeviceProof }, approval: WorkMachineArchiveApproval, jobId: string) {
    const bytes = Buffer.from(signed.manifestB64, 'base64url');
    const { issuedAt, publicKey, signature } = signed.proof;
    const der = Buffer.from(publicKey, 'base64url');
    const scope = ['happy-work-machine-export-v1', jobId, createHash('sha256').update(bytes).digest('base64url'), issuedAt];
    let valid = false;
    try {
        valid = createHash('sha256').update(der).digest('base64url') === approval.sourceDeviceId
            && verify(null, Buffer.from(JSON.stringify(scope)), createPublicKey({ key: der, format: 'der', type: 'spki' }), Buffer.from(signature, 'base64url'));
    } catch { /* An unparsable key is an invalid signature. */ }
    if (!valid) throw new Error('The transfer manifest signature does not match the approved source device');
    const manifest = manifestSchema.parse(JSON.parse(bytes.toString('utf8')));
    const contiguous = manifest.parts.every((part, index) => part.n === index
        && (index === manifest.parts.length - 1 ? part.size <= manifest.partSize : part.size === manifest.partSize));
    if (manifest.jobId !== jobId || manifest.machineId !== approval.machineId || manifest.sourceDeviceId !== approval.sourceDeviceId
        || manifest.generation !== approval.generation || !contiguous
        || manifest.parts.reduce((sum, part) => sum + part.size, 0) !== manifest.totalBytes) {
        throw new Error('The transfer manifest does not describe this job, machine, generation and source');
    }
    return { manifest, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function readSessionStore(home: string): Promise<Record<string, unknown> & { sessions: Record<string, unknown> }> {
    const stored = await readJson(join(home, 'sessions.json'));
    if (stored === null) return { sessions: {} };
    const parsed = z.object({ sessions: z.record(z.string(), z.unknown()) }).passthrough().safeParse(stored);
    if (!parsed.success) throw new Error('This home has an unreadable session store');
    return parsed.data;
}

/**
 * A target home may take the logical machine id when it has none, the same one, or only the id a
 * plain `happy auth login` minted: no work machine binding and no sessions of its own.
 */
export async function assertWorkMachineTargetHome(home: string, configuredMachineId: string | undefined, machineId: string): Promise<void> {
    if (!configuredMachineId || configuredMachineId === machineId) return;
    if (await readWorkMachineExecutionBinding(home) || Object.keys((await readSessionStore(home)).sessions).length) {
        throw new Error('Another work machine is already configured in this home');
    }
}

async function assertNothingToOverwrite(home: string, manifest: Manifest, placed: ReadonlySet<string>): Promise<void> {
    for (const path of manifest.paths) {
        if (!placed.has(path) && await exists(path)) throw new Error(`Refusing to overwrite an existing path on this machine: ${path}`);
    }
    const { sessions } = await readSessionStore(home);
    const taken = manifest.sessions.find(session => session.sessionId in sessions);
    if (taken) throw new Error(`Session ${taken.sessionId} already has a recovery record on this machine`);
}

async function assertDiskSpace(staging: string, manifest: Manifest): Promise<void> {
    const free = async (path: string) => {
        let probe = path;
        while (!await exists(probe)) probe = dirname(probe);
        const info = await statfs(probe);
        return info.bavail * info.bsize;
    };
    // Parts and the assembled object, then the decrypted archive and its extraction.
    if (await free(staging) < 3 * manifest.totalBytes) throw new Error('Not enough disk space to stage the transfer');
    for (const path of manifest.paths) {
        if (await free(path) < manifest.totalBytes) throw new Error(`Not enough disk space to restore ${path}`);
    }
}

const inside = (root: string, path: string) => path === root || path.startsWith(`${root}/`);

/**
 * The manifest is signed, but only as far as the source can be trusted. The records must agree with
 * the signed cursors and provider identities, and each root must be a Claude/Codex record location
 * or a project directory outside this machine's Happy, Claude and Codex homes.
 */
async function assertRestorableRoots(
    manifest: Manifest, records: Record<string, unknown>, staging: string,
    homes: { home: string; claudeConfigDir: string; codexHome: string },
): Promise<void> {
    if (Object.keys(records).length !== manifest.sessions.length) throw new Error('The transfer archive carries sessions outside the signed manifest');
    for (const session of manifest.sessions) {
        const record = z.object({
            lastProcessedSeq: z.number(),
            metadata: z.object({ claudeSessionId: z.string().optional(), codexThreadId: z.string().optional() }).passthrough(),
        }).passthrough().safeParse(records[session.sessionId]);
        const nativeId = record.success ? record.data.metadata[session.provider === 'claude' ? 'claudeSessionId' : 'codexThreadId'] : undefined;
        if (!record.success || record.data.lastProcessedSeq !== session.lastProcessedSeq || nativeId !== session.nativeId) {
            throw new Error(`The recovery record of session ${session.sessionId} does not match the signed manifest`);
        }
    }
    for (const path of manifest.paths) {
        const providerRecord = dirname(dirname(path)) === join(homes.claudeConfigDir, 'projects')
            || (inside(join(homes.codexHome, 'sessions'), path) && /^rollout-.*\.jsonl$/.test(basename(path)));
        const staged = await lstat(join(staging, 'fs', path)).catch(() => null);
        const project = !providerRecord && !!staged?.isDirectory()
            && ![homes.home, homes.claudeConfigDir, homes.codexHome].some(home => inside(home, path) || inside(path, home));
        if (!staged || (!providerRecord && !project)) throw new Error(`The transfer manifest names a path this machine will not restore: ${path}`);
    }
}

async function movePath(source: string, destination: string): Promise<void> {
    await mkdir(dirname(destination), { recursive: true });
    if (await exists(destination)) throw new Error(`Refusing to overwrite an existing path on this machine: ${destination}`);
    try {
        await rename(source, destination);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        await cp(source, destination, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
        await rm(source, { recursive: true, force: true });
    }
}

/** Downloads (keeping parts that already verify), then assembles the sealed archive and its receipt. */
async function downloadArchive(client: ReturnType<typeof openWorkMachineTransfer>, manifest: Manifest, directory: string) {
    const partsDirectory = join(directory, 'parts');
    await mkdir(partsDirectory, { recursive: true, mode: 0o700 });
    for (const part of manifest.parts) {
        const path = join(partsDirectory, `part-${part.n}`);
        if (await exists(path) && (await stat(path)).size === part.size && (await digestRange(path, 0, part.size)).sha256 === part.sha256) continue;
        await rm(path, { force: true });
        await client.downloadPart(part, path);
    }
    const sealed = join(directory, 'transfer.bin');
    await rm(sealed, { force: true });
    await writeFile(sealed, '', { mode: 0o600, flag: 'wx' });
    for (const part of manifest.parts) {
        await pipeline(createReadStream(join(partsDirectory, `part-${part.n}`)), createWriteStream(sealed, { flags: 'a' }));
    }
    const trailer = Buffer.alloc(8);
    const handle = await open(sealed, 'r');
    let receipt: unknown;
    let sealedBytes: number;
    try {
        await handle.read(trailer, 0, 8, manifest.totalBytes - 8);
        const length = trailer.readUInt32BE(0);
        sealedBytes = manifest.totalBytes - 8 - length;
        if (!trailer.subarray(4).equals(RECEIPT_MAGIC) || sealedBytes <= 0 || length > MAX_RECEIPT_BYTES) throw new Error('The transfer archive has no receipt');
        const receiptBytes = Buffer.alloc(length);
        await handle.read(receiptBytes, 0, length, sealedBytes);
        receipt = JSON.parse(receiptBytes.toString('utf8'));
    } finally {
        await handle.close();
    }
    await truncate(sealed, sealedBytes);
    await rm(partsDirectory, { recursive: true, force: true });
    return { sealed, receipt };
}

export async function importWorkMachine(input: TransferEndpoint & {
    claudeConfigDir: string;
    codexHome: string;
    /** This home's settings.machineId; the caller replaces it with the imported one afterwards. */
    configuredMachineId?: string;
}): Promise<{ machineId: string; deviceId: string; manifestSha256: string }> {
    const client = openWorkMachineTransfer(input);
    const directory = await jobDirectory(input.home, input.jobId);
    const recipientFile = recipientFileSchema.safeParse(await readJson(join(directory, 'recipient.json')));
    if (!recipientFile.success) throw new Error(`No target approval was created on this machine for job ${input.jobId}`);
    const approval = recipientFile.data.approval as WorkMachineArchiveApproval;
    const importDirectory = await jobDirectory(input.home, input.jobId, 'import');
    const reportPath = join(importDirectory, 'restored.json');
    const pending = restoredSchema.safeParse(await readJson(reportPath));
    if (pending.success) {
        await client.restored(pending.data as Parameters<typeof client.restored>[0]);
        return { machineId: approval.machineId, deviceId: pending.data.deviceId, manifestSha256: pending.data.manifestSha256 };
    }
    if (parseCredentials(await readJson(join(input.home, 'access.key')))?.encryption.type !== 'dataKey') {
        throw new Error('Log in to the same account (dataKey) on this machine before importing');
    }

    const { manifest, sha256 } = verifiedManifest(await client.manifest(), approval, input.jobId);
    const placedPath = join(importDirectory, 'placed.json');
    if (!await exists(placedPath)) {
        // Paths an interrupted run of this same manifest already moved in: a rerun finishes the rest
        // instead of refusing its own work. A path is listed only after its move completed.
        const placingPath = join(importDirectory, 'placing.json');
        const placing = placingSchema.safeParse(await readJson(placingPath));
        const placed = new Set(placing.success && placing.data.manifestSha256 === sha256 ? placing.data.placed : []);
        await assertWorkMachineTargetHome(input.home, input.configuredMachineId, approval.machineId);
        await assertNothingToOverwrite(input.home, manifest, placed);
        await assertDiskSpace(importDirectory, manifest);
        const { sealed, receipt } = await downloadArchive(client, manifest, importDirectory);
        const recipientSecret = Buffer.from(recipientFile.data.recipientSecret, 'base64url');
        const archive = await withDeviceKeys(input.home, approval.machineId, keys => restoreWorkMachineArchive({
            approval, receipt, source: sealed, stagingRoot: importDirectory,
            targetKeys: { signing: keys.signing, recipient: nacl.box.keyPair.fromSecretKey(new Uint8Array(recipientSecret)) },
        })).finally(() => recipientSecret.fill(0));
        await rm(sealed, { force: true });
        const staging = join(importDirectory, 'staging');
        await rm(staging, { recursive: true, force: true });
        try {
            const records = await extractWorkMachineArchive({ archivePath: archive.archivePath, roots: manifest.paths, staging });
            await assertRestorableRoots(manifest, records, staging, input);
            await assertNothingToOverwrite(input.home, manifest, placed);
            for (const path of manifest.paths) {
                if (placed.has(path) && await exists(path)) continue;
                await movePath(join(staging, 'fs', path), path);
                placed.add(path);
                await replacePrivateFile(placingPath, JSON.stringify({ manifestSha256: sha256, placed: [...placed] }));
            }
            const store = await readSessionStore(input.home);
            await replacePrivateFile(join(input.home, 'sessions.json'), JSON.stringify({ ...store, sessions: { ...store.sessions, ...records } }));
        } finally {
            await rm(dirname(archive.archivePath), { recursive: true, force: true });
            await rm(staging, { recursive: true, force: true });
        }
        await writeFile(placedPath, JSON.stringify({ manifestSha256: sha256 }), { mode: 0o600 });
    }

    const { dataEncryptionKey, digest } = await rotateMachineDataKey(input.home, `work-machine-${input.jobId}`);
    const report = await withDeviceKeys(input.home, approval.machineId, keys => {
        const identity = workMachineSigningIdentity(keys.signing.publicKey).deviceId;
        return {
            deviceId: identity,
            dataEncryptionKey,
            proof: signScope(keys, issuedAt => ['happy-work-machine-replace-v1', approval.machineId, approval.generation, identity, digest, issuedAt]),
            manifestSha256: sha256,
        };
    });
    await replacePrivateFile(reportPath, JSON.stringify(report));
    await client.restored(report);
    return { machineId: approval.machineId, deviceId: report.deviceId, manifestSha256: sha256 };
}

/**
 * One restore proof per (machine, generation). The result is kept with a digest of the key it
 * names, so a rerun after a lost answer returns the same proof instead of replacing a key the
 * operator may already have handed to the rollback. A crash before it is kept leaves a key nobody
 * was given, which a rerun may replace.
 */
export async function createWorkMachineRestoreProof(input: { home: string; machineId: string; generation: number }) {
    const binding = await readWorkMachineExecutionBinding(input.home);
    if (!binding || binding.machineId !== input.machineId) throw new Error('This home is not the original device of that work machine');
    const pendingDirectory = join(input.home, 'work-machine-restore');
    await mkdir(pendingDirectory, { recursive: true, mode: 0o700 });
    const pendingPath = join(pendingDirectory, `${workMachineIdentifier.parse(input.machineId)}-${input.generation}.json`);
    const pending = restoreProofSchema.safeParse(await readJson(pendingPath));
    if (pending.success) {
        const { machineKeySha256, ...proof } = pending.data;
        if (machineKeySha256 !== await machineKeyDigest(input.home)) {
            throw new Error(`The machine data key changed after the restore proof for generation ${input.generation} was made`);
        }
        return proof;
    }
    return withDeviceKeys(input.home, input.machineId, async keys => {
        if (workMachineSigningIdentity(keys.signing.publicKey).deviceId !== binding.deviceId) {
            throw new Error('This home no longer holds the original device key');
        }
        const { dataEncryptionKey, digest } = await rotateMachineDataKey(input.home, `work-machine-restore-${input.generation}`);
        const proof = {
            deviceId: binding.deviceId,
            dataEncryptionKey,
            proof: signScope(keys, issuedAt => ['happy-work-machine-restore-v1', input.machineId, input.generation, binding.deviceId, digest, issuedAt]),
        };
        await replacePrivateFile(pendingPath, JSON.stringify({ ...proof, machineKeySha256: await machineKeyDigest(input.home) }));
        return proof;
    });
}
