import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getProjectPath } from '@/claude/utils/path';
import { loadOrCreateDeviceKeys } from './deviceKeys';
import { getWorkMachineDeviceId, saveWorkMachineExecutionBinding, workMachineSigningIdentity } from './workMachineCredential';
import {
    assertWorkMachineTargetHome, checkWorkMachineExport, createWorkMachineRestoreProof, createWorkMachineTargetApproval, exportWorkMachine, importWorkMachine,
} from './workMachineMigration';
import { workMachineSessionStopPath, writeWorkMachineSessionStop } from './workMachineSessionStop';

const machineId = 'logical-machine';
const accountId = 'test-account';
const jobId = 'job-1';
const generation = 3;
const claudeId = '11111111-2222-4333-8444-555555555555';
const codexId = '019a0000-0000-7000-8000-000000000001';
const sourceToken = 'wmt_source_token_for_tests';
const targetToken = 'wmt_target_token_for_tests';
const noSleep = async () => undefined;

type Plan = Record<string, unknown>;
/** The Studio transfer API of plan 5.6 and a presigned object store, in one process. */
class FakeStudio {
    server: Server = createServer((req, res) => void this.handle(req).then(
        ({ status, body, headers }) => { res.writeHead(status, headers ?? {}); res.end(body); },
        () => { res.writeHead(500); res.end(); },
    ));
    origin = '';
    plan: Plan | null = null;
    objects = new Map<string, Buffer>();
    puts = new Map<number, number>();
    failPuts = new Map<number, number>();
    tamperGet = new Set<number>();
    manifest: { manifestB64: string; proof: unknown } | null = null;
    restored: Record<string, unknown> | null = null;

    async start() {
        await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
        const address = this.server.address();
        if (!address || typeof address === 'string') throw new Error('no address');
        this.origin = `http://127.0.0.1:${address.port}`;
    }
    async stop() {
        this.server.closeAllConnections();
        await new Promise<void>(resolve => this.server.close(() => resolve()));
    }

    private async handle(req: IncomingMessage): Promise<{ status: number; body?: Buffer | string; headers?: Record<string, string> }> {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks);
        const url = new URL(req.url!, this.origin);
        const object = /^\/objects\/(\d+)$/.exec(url.pathname);
        if (object) {
            const n = Number(object[1]);
            if (url.searchParams.get('method') !== req.method) return { status: 403 };
            const stored = this.objects.get(`part-${n}`);
            if (req.method === 'PUT') {
                this.puts.set(n, (this.puts.get(n) ?? 0) + 1);
                const failures = this.failPuts.get(n) ?? 0;
                if (failures > 0) { this.failPuts.set(n, failures - 1); return { status: 503 }; }
                this.objects.set(`part-${n}`, raw);
                return { status: 200 };
            }
            if (!stored) return { status: 404 };
            const etag = `"${createHash('md5').update(stored).digest('hex')}"`;
            if (req.method === 'HEAD') return { status: 200, headers: { 'content-length': String(stored.length), etag } };
            const body = Buffer.from(stored);
            if (this.tamperGet.has(n)) body[body.length - 1] ^= 1;
            return { status: 200, body, headers: { 'content-length': String(body.length) } };
        }
        const route = /^\/api\/work-machine-migrations\/([^/]+)\/transfer\/(.+)$/.exec(url.pathname);
        const auth = req.headers.authorization;
        const role = auth === `Bearer ${sourceToken}` ? 'source' : auth === `Bearer ${targetToken}` ? 'target' : null;
        if (!route || route[1] !== jobId || !role) return { status: 403 };
        const json = (value: unknown) => ({ status: 200, body: JSON.stringify(value), headers: { 'content-type': 'application/json' } });
        const body = raw.length ? JSON.parse(raw.toString('utf8')) : null;
        const [, , action] = route;
        if (action === 'plan' && req.method === 'GET' && role === 'source') return json(this.plan);
        const part = /^parts\/(\d+)$/.exec(action);
        if (part && req.method === 'POST') {
            const allowed = role === 'source' ? ['PUT', 'HEAD'] : ['GET', 'HEAD'];
            if (!allowed.includes(body.method)) return { status: 403 };
            return json({ url: `${this.origin}/objects/${part[1]}?method=${body.method}`, expiresAt: Date.now() + 60_000 });
        }
        if (action === 'manifest' && req.method === 'POST' && role === 'source') { this.manifest = body; return { status: 204 }; }
        if (action === 'manifest' && req.method === 'GET' && role === 'target') return this.manifest ? json(this.manifest) : { status: 404 };
        if (action === 'restored' && req.method === 'POST' && role === 'target') { this.restored = body; return { status: 204 }; }
        return { status: 404 };
    }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Migration Test', '-c', 'user.email=test@example.invalid',
    ...args,
], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

async function machinesFixture(root: string, studio: FakeStudio) {
    const sourceHome = join(root, 'source-happy');
    const targetHome = join(root, 'target-happy');
    const claudeConfigDir = join(root, 'claude');
    const codexHome = join(root, 'codex');
    const project = join(root, 'workspace', 'project');
    await mkdir(sourceHome, { mode: 0o700 });
    await mkdir(targetHome, { mode: 0o700 });
    await mkdir(project, { recursive: true });
    git(project, 'init', '--template=');
    await writeFile(join(project, 'tracked.txt'), 'original\n');
    await writeFile(join(project, 'large.bin'), randomBytes(20_000));
    git(project, 'add', '.');
    git(project, 'commit', '-m', 'fixture');
    await writeFile(join(project, 'tracked.txt'), 'dirty\n');
    await writeFile(join(project, 'draft.txt'), 'untracked\n');
    const claudeRecord = join(getProjectPath(project, claudeConfigDir), `${claudeId}.jsonl`);
    await mkdir(join(claudeRecord, '..'), { recursive: true });
    await writeFile(claudeRecord, JSON.stringify({ sessionId: claudeId, cwd: project, message: 'clue before migration' }) + '\n');
    await writeFile(join(claudeConfigDir, '.credentials.json'), '{"claudeAiOauth":{}}');
    const codexRecord = join(codexHome, 'sessions', '2026', '11', '22', `rollout-2026-11-22T00-00-00-${codexId}.jsonl`);
    await mkdir(join(codexRecord, '..'), { recursive: true });
    await writeFile(codexRecord, JSON.stringify({ type: 'session_meta', payload: { id: codexId, cwd: project } }) + '\n');
    await writeFile(join(codexHome, 'auth.json'), '{"tokens":{}}');
    await writeFile(join(sourceHome, 'access.key'), '{"token":"source-account-token"}', { mode: 0o600 });
    const record = (field: string, nativeId: string, lastProcessedSeq: number) => ({
        encryptionKey: randomBytes(32).toString('base64'), encryptionVariant: 'dataKey', seq: 12, metadataVersion: 1,
        agentStateVersion: 1, savedAt: 1, metadata: { path: project, host: 'source', [field]: nativeId }, lastProcessedSeq,
    });
    const sessions = { 'claude-session': record('claudeSessionId', claudeId, 7), 'codex-session': record('codexThreadId', codexId, 9) };
    await writeFile(join(sourceHome, 'sessions.json'), JSON.stringify({ sessions }), { mode: 0o600 });
    // Both session processes stopped cleanly between turns (workMachineSessionStop.ts).
    for (const [sessionId, lastProcessedSeq, provider] of [['claude-session', 7, { claudeSessionId: claudeId }], ['codex-session', 9, { codexThreadId: codexId }]] as const) {
        writeWorkMachineSessionStop(workMachineSessionStopPath(sourceHome, sessionId), {
            v: 1, sessionId, cleanStop: true, stoppedAt: 1_000, lastProcessedSeq, turnInFlight: false, inputSkipped: false, ...provider,
        });
    }
    const sourceDeviceId = await getWorkMachineDeviceId(sourceHome, machineId);
    await saveWorkMachineExecutionBinding(sourceHome, { accountId, machineId, generation, deviceId: sourceDeviceId, serverOrigin: 'https://happy.invalid' });

    const accountPublicKey = nacl.box.keyPair().publicKey;
    const targetMachineKey = randomBytes(32);
    await writeFile(join(targetHome, 'access.key'), JSON.stringify({
        token: 'target-account-token',
        encryption: { publicKey: Buffer.from(accountPublicKey).toString('base64'), machineKey: targetMachineKey.toString('base64') },
    }), { mode: 0o600 });
    const approval = await createWorkMachineTargetApproval({
        home: targetHome, machineId, jobId, accountId, generation, sourceDeviceId, expiresAt: Date.now() + 600_000, maxBytes: 64 * 1024 ** 2,
    });
    studio.plan = {
        jobId, machineId, generation, archiveVersion: 1, approval,
        sessions: [{ sessionId: 'claude-session' }, { sessionId: 'codex-session' }], projectPaths: [project], expiresAt: Date.now() + 600_000,
    };
    const exportInput = {
        home: sourceHome, claudeConfigDir, codexHome, studioUrl: studio.origin, jobId, token: sourceToken, partSize: 4096, sleep: noSleep,
    };
    const importInput = { home: targetHome, claudeConfigDir, codexHome, studioUrl: studio.origin, jobId, token: targetToken, sleep: noSleep };
    /** The target is a different PC: nothing of the source's planned data exists at those paths. */
    const vacateSource = async () => {
        await rename(join(root, 'workspace'), join(root, 'source-workspace'));
        await rename(claudeRecord, `${claudeRecord}.source`);
        await rename(codexRecord, `${codexRecord}.source`);
    };
    return { sourceHome, targetHome, project, claudeRecord, codexRecord, sessions, exportInput, importInput, vacateSource, sourceDeviceId };
}

const deviceSignatureValid = (proof: { publicKey: string; signature: string }, scope: unknown[]) => verify(
    null, Buffer.from(JSON.stringify(scope)),
    createPublicKey({ key: Buffer.from(proof.publicKey, 'base64url'), format: 'der', type: 'spki' }),
    Buffer.from(proof.signature, 'base64url'),
);

describe('work machine export and import over the Studio transfer API', () => {
    let root: string;
    let studio: FakeStudio;
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'work-machine-migration-test-'));
        studio = new FakeStudio();
        await studio.start();
    });
    afterEach(async () => {
        await studio.stop();
        await rm(root, { recursive: true, force: true });
    });

    it('restores the dirty project and Claude/Codex records at the same paths with the same sessions and cursors', async () => {
        const fixture = await machinesFixture(root, studio);
        const status = git(fixture.project, 'status', '--porcelain=v1');
        const head = git(fixture.project, 'rev-parse', 'HEAD');
        const claudeContents = await readFile(fixture.claudeRecord, 'utf8');
        const codexContents = await readFile(fixture.codexRecord, 'utf8');

        const exported = await exportWorkMachine(fixture.exportInput);
        const manifestBytes = Buffer.from(studio.manifest!.manifestB64, 'base64url');
        const manifest = JSON.parse(manifestBytes.toString('utf8'));
        expect(manifest).toMatchObject({
            jobId, machineId, archiveVersion: 1, sourceDeviceId: fixture.sourceDeviceId, generation, partSize: 4096,
            sessions: [
                { sessionId: 'claude-session', provider: 'claude', nativeId: claudeId, lastProcessedSeq: 7 },
                { sessionId: 'codex-session', provider: 'codex', nativeId: codexId, lastProcessedSeq: 9 },
            ],
            paths: [fixture.project, fixture.claudeRecord, fixture.codexRecord].sort(),
        });
        expect(manifest.parts.length).toBeGreaterThan(1);
        expect(manifest.parts.reduce((sum: number, part: { size: number }) => sum + part.size, 0)).toBe(manifest.totalBytes);
        const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
        expect(exported.manifestSha256).toBe(manifestSha256);
        const exportProof = studio.manifest!.proof as { issuedAt: number; publicKey: string; signature: string };
        expect(deviceSignatureValid(exportProof, [
            'happy-work-machine-export-v1', jobId, createHash('sha256').update(manifestBytes).digest('base64url'), exportProof.issuedAt,
        ])).toBe(true);

        await fixture.vacateSource();
        const imported = await importWorkMachine(fixture.importInput);

        expect(git(fixture.project, 'rev-parse', 'HEAD')).toBe(head);
        expect(git(fixture.project, 'status', '--porcelain=v1')).toBe(status);
        expect(await readFile(join(fixture.project, 'draft.txt'), 'utf8')).toBe('untracked\n');
        expect(await readFile(fixture.claudeRecord, 'utf8')).toBe(claudeContents);
        expect(await readFile(fixture.codexRecord, 'utf8')).toBe(codexContents);
        const targetSessions = JSON.parse(await readFile(join(fixture.targetHome, 'sessions.json'), 'utf8')).sessions;
        expect(targetSessions).toEqual(fixture.sessions);
        expect((await stat(join(fixture.targetHome, 'sessions.json'))).mode & 0o777).toBe(0o600);
        expect(await readFile(join(fixture.targetHome, 'access.key'), 'utf8')).not.toContain('source-account-token');

        const restored = studio.restored as { deviceId: string; dataEncryptionKey: string; proof: { issuedAt: number; publicKey: string; signature: string }; manifestSha256: string };
        expect(restored.manifestSha256).toBe(manifestSha256);
        expect(restored.deviceId).toBe(imported.deviceId);
        expect(restored.deviceId).not.toBe(fixture.sourceDeviceId);
        expect(deviceSignatureValid(restored.proof, [
            'happy-work-machine-replace-v1', machineId, generation, restored.deviceId,
            createHash('sha256').update(Buffer.from(restored.dataEncryptionKey, 'base64')).digest('base64url'), restored.proof.issuedAt,
        ])).toBe(true);
        expect(Buffer.from(restored.dataEncryptionKey, 'base64')).toHaveLength(105);
        expect(Buffer.from(restored.dataEncryptionKey, 'base64').toString('base64')).toBe(restored.dataEncryptionKey);
        const accessKey = JSON.parse(await readFile(join(fixture.targetHome, 'access.key'), 'utf8'));
        expect(accessKey.token).toBe('target-account-token');
        expect(Buffer.from(accessKey.encryption.machineKey, 'base64')).toHaveLength(32);

        // The report is repeatable after a lost answer, with the same key and proof.
        studio.restored = null;
        await importWorkMachine(fixture.importInput);
        expect(studio.restored).toEqual(restored);
    });

    it('checks the export during drain without stop records, uploads or a saved seal', async () => {
        const fixture = await machinesFixture(root, studio);
        await rm(join(fixture.sourceHome, 'work-machine-sessions'), { recursive: true });

        const checked = await checkWorkMachineExport(fixture.exportInput);

        expect(checked).toEqual({ sessions: ['claude-session', 'codex-session'], paths: [fixture.project, fixture.claudeRecord, fixture.codexRecord].sort() });
        expect(studio.puts.size).toBe(0);
        expect(studio.manifest).toBeNull();
        await expect(lstat(join(fixture.sourceHome, 'work-machine-transfer', jobId, 'export'))).rejects.toMatchObject({ code: 'ENOENT' });

        await writeFile(join(fixture.project, '.npmrc'), '//registry.npmjs.org/:_authToken=npm_secretvalue\n');
        const failure = await checkWorkMachineExport(fixture.exportInput).catch((error: Error) => error);
        expect((failure as Error).message).toContain(join(fixture.project, '.npmrc'));
        expect((failure as Error).message).not.toContain('npm_secretvalue');
    });

    it('resumes an interrupted upload without sending verified parts again', async () => {
        const fixture = await machinesFixture(root, studio);
        studio.failPuts.set(1, 100);
        await expect(exportWorkMachine(fixture.exportInput)).rejects.toThrow('part 1');
        expect(studio.manifest).toBeNull();
        expect(studio.puts.get(0)).toBe(1);

        studio.failPuts.set(1, 2);
        await exportWorkMachine(fixture.exportInput);
        expect(studio.puts.get(0)).toBe(1);
        expect(studio.manifest).not.toBeNull();
        await fixture.vacateSource();
        await importWorkMachine(fixture.importInput);
        expect(await readFile(join(fixture.project, 'draft.txt'), 'utf8')).toBe('untracked\n');
    });

    it('rejects a tampered part and places nothing', async () => {
        const fixture = await machinesFixture(root, studio);
        await exportWorkMachine(fixture.exportInput);
        await fixture.vacateSource();
        studio.tamperGet.add(1);
        await expect(importWorkMachine(fixture.importInput)).rejects.toThrow('part 1');
        await expect(lstat(fixture.project)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(lstat(fixture.claudeRecord)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(studio.restored).toBeNull();
    });

    it('rejects a manifest whose source signature does not match', async () => {
        const fixture = await machinesFixture(root, studio);
        await exportWorkMachine(fixture.exportInput);
        await fixture.vacateSource();
        const manifest = JSON.parse(Buffer.from(studio.manifest!.manifestB64, 'base64url').toString('utf8'));
        manifest.sessions[0].lastProcessedSeq = 0;
        studio.manifest = { ...studio.manifest!, manifestB64: Buffer.from(JSON.stringify(manifest)).toString('base64url') };
        await expect(importWorkMachine(fixture.importInput)).rejects.toThrow('signature');
        await expect(lstat(fixture.project)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(studio.restored).toBeNull();
    });

    it.each([
        ['a cursor that disagrees with the recovery record', (manifest: { sessions: { lastProcessedSeq: number }[] }) => { manifest.sessions[0].lastProcessedSeq = 0; }],
        ['a path inside the Happy home', (manifest: { paths: string[] }, targetHome: string) => { manifest.paths.push(join(targetHome, 'planted')); }],
    ] as const)('rejects a source-signed manifest with %s', async (_label, mutate) => {
        const fixture = await machinesFixture(root, studio);
        await exportWorkMachine(fixture.exportInput);
        await fixture.vacateSource();
        const manifest = JSON.parse(Buffer.from(studio.manifest!.manifestB64, 'base64url').toString('utf8'));
        (mutate as (value: typeof manifest, home: string) => void)(manifest, fixture.targetHome);
        const bytes = Buffer.from(JSON.stringify(manifest));
        const keys = await loadOrCreateDeviceKeys(fixture.sourceHome, machineId);
        const issuedAt = Date.now();
        const message = Buffer.from(JSON.stringify(['happy-work-machine-export-v1', jobId, createHash('sha256').update(bytes).digest('base64url'), issuedAt]));
        studio.manifest = {
            manifestB64: bytes.toString('base64url'),
            proof: { issuedAt, publicKey: workMachineSigningIdentity(keys.signing.publicKey).publicKey, signature: Buffer.from(nacl.sign.detached(message, keys.signing.secretKey)).toString('base64url') },
        };
        await expect(importWorkMachine(fixture.importInput)).rejects.toThrow(/does not match the signed manifest|will not restore/);
        await expect(lstat(fixture.project)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(lstat(join(fixture.targetHome, 'sessions.json'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(studio.restored).toBeNull();
    });

    it('refuses to overwrite a path that already exists on the target', async () => {
        const fixture = await machinesFixture(root, studio);
        await exportWorkMachine(fixture.exportInput);
        await fixture.vacateSource();
        await mkdir(fixture.project, { recursive: true });
        await expect(importWorkMachine(fixture.importInput)).rejects.toThrow(fixture.project);
        await expect(lstat(fixture.claudeRecord)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(lstat(join(fixture.targetHome, 'sessions.json'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(studio.restored).toBeNull();
    });

    // Medium 13: `happy auth login` on a fresh target PC writes a machine id of its own.
    it('takes over a home whose only machine id is the one a plain login minted', async () => {
        const fixture = await machinesFixture(root, studio);
        await exportWorkMachine(fixture.exportInput);
        await fixture.vacateSource();

        await expect(assertWorkMachineTargetHome(fixture.targetHome, undefined, machineId)).resolves.toBeUndefined();
        await expect(assertWorkMachineTargetHome(fixture.targetHome, 'login-minted-machine', machineId)).resolves.toBeUndefined();
        await expect(importWorkMachine({ ...fixture.importInput, configuredMachineId: 'login-minted-machine' })).resolves.toMatchObject({ machineId });
        // Once it holds sessions it is a machine of its own.
        await expect(assertWorkMachineTargetHome(fixture.targetHome, 'login-minted-machine', machineId))
            .rejects.toThrow('Another work machine is already configured in this home');
    });

    it('refuses a target home bound to another work machine or holding sessions, before placing anything', async () => {
        const fixture = await machinesFixture(root, studio);
        await exportWorkMachine(fixture.exportInput);
        await fixture.vacateSource();
        await writeFile(join(fixture.targetHome, 'sessions.json'), JSON.stringify({ sessions: { 'local-session': {} } }), { mode: 0o600 });

        await expect(importWorkMachine({ ...fixture.importInput, configuredMachineId: 'login-minted-machine' }))
            .rejects.toThrow('Another work machine is already configured in this home');
        await expect(lstat(fixture.project)).rejects.toMatchObject({ code: 'ENOENT' });

        await rm(join(fixture.targetHome, 'sessions.json'));
        const otherDevice = await getWorkMachineDeviceId(fixture.targetHome, 'other-machine');
        await saveWorkMachineExecutionBinding(fixture.targetHome, {
            accountId, machineId: 'other-machine', generation: 1, deviceId: otherDevice, serverOrigin: 'https://happy.invalid',
        });
        await expect(assertWorkMachineTargetHome(fixture.targetHome, 'other-machine', machineId))
            .rejects.toThrow('Another work machine is already configured in this home');
    });

    it('signs a restore proof with the original device for a new data key', async () => {
        const fixture = await machinesFixture(root, studio);
        const accountPublicKey = nacl.box.keyPair().publicKey;
        await writeFile(join(fixture.sourceHome, 'access.key'), JSON.stringify({
            token: 'source-account-token',
            encryption: { publicKey: Buffer.from(accountPublicKey).toString('base64'), machineKey: randomBytes(32).toString('base64') },
        }), { mode: 0o600 });
        const before = JSON.parse(await readFile(join(fixture.sourceHome, 'access.key'), 'utf8'));
        const result = await createWorkMachineRestoreProof({ home: fixture.sourceHome, machineId, generation: 4 });
        expect(result.deviceId).toBe(fixture.sourceDeviceId);
        expect(deviceSignatureValid(result.proof, [
            'happy-work-machine-restore-v1', machineId, 4, fixture.sourceDeviceId,
            createHash('sha256').update(Buffer.from(result.dataEncryptionKey, 'base64')).digest('base64url'), result.proof.issuedAt,
        ])).toBe(true);
        const after = JSON.parse(await readFile(join(fixture.sourceHome, 'access.key'), 'utf8'));
        expect(after.token).toBe(before.token);
        expect(after.encryption.machineKey).not.toBe(before.encryption.machineKey);
        await expect(createWorkMachineRestoreProof({ home: fixture.sourceHome, machineId: 'another-machine', generation: 4 })).rejects.toThrow();
    });

    // Medium 14: a rerun after a lost answer must not replace the key the first proof names.
    it('returns the same restore proof and key on a rerun for the same generation', async () => {
        const fixture = await machinesFixture(root, studio);
        await writeFile(join(fixture.sourceHome, 'access.key'), JSON.stringify({
            token: 'source-account-token',
            encryption: { publicKey: Buffer.from(nacl.box.keyPair().publicKey).toString('base64'), machineKey: randomBytes(32).toString('base64') },
        }), { mode: 0o600 });
        const first = await createWorkMachineRestoreProof({ home: fixture.sourceHome, machineId, generation: 4 });
        const keyAfterFirst = await readFile(join(fixture.sourceHome, 'access.key'), 'utf8');

        expect(await createWorkMachineRestoreProof({ home: fixture.sourceHome, machineId, generation: 4 })).toEqual(first);
        expect(await readFile(join(fixture.sourceHome, 'access.key'), 'utf8')).toBe(keyAfterFirst);

        const next = await createWorkMachineRestoreProof({ home: fixture.sourceHome, machineId, generation: 5 });
        expect(next.dataEncryptionKey).not.toBe(first.dataEncryptionKey);
    });

    it.each(['import', 'restore-proof'] as const)('keeps the access.key fields it does not own when %s replaces the key', async (operation) => {
        const fixture = await machinesFixture(root, studio);
        const home = operation === 'import' ? fixture.targetHome : fixture.sourceHome;
        const before = {
            token: `${operation}-account-token`, futureField: { kept: true },
            encryption: { publicKey: Buffer.from(nacl.box.keyPair().publicKey).toString('base64'), machineKey: randomBytes(32).toString('base64'), neverEscrowed: true },
        };
        await writeFile(join(home, 'access.key'), JSON.stringify(before), { mode: 0o600 });
        if (operation === 'import') {
            await exportWorkMachine(fixture.exportInput);
            await fixture.vacateSource();
            await importWorkMachine(fixture.importInput);
        } else {
            await createWorkMachineRestoreProof({ home, machineId, generation: 4 });
        }

        const after = JSON.parse(await readFile(join(home, 'access.key'), 'utf8'));
        expect(after).toEqual({ ...before, encryption: { ...before.encryption, machineKey: expect.any(String) } });
        expect(after.encryption.machineKey).not.toBe(before.encryption.machineKey);
    });
});
