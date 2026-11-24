import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { create as createTar, extract as extractTar } from 'tar';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import { getProjectPath } from '@/claude/utils/path';
import { getCheckpointObject, putCheckpointObject } from '@/managed/checkpoint/managedCheckpointObjectStore';
import { SandboxConfigSchema } from '@/persistence';
import { SessionWriteScopeFixture } from '@/testing/sessionWriteScopeFixture';
import { workMachineSigningIdentity } from './workMachineCredential';
import { proveWorkMachineArchiveRecipient, restoreWorkMachineArchive, sealWorkMachineArchive } from './workMachineTransferEnvelope';

describe.skipIf(process.env.HAPPY_WORK_MACHINE_NATIVE_INTEGRATION !== '1')('work machine provider history rehearsal', () => {
    it.each(['claude', 'codex'] as const)('keeps the %s native identity and context after encrypted transport', async provider => {
        const fixture = new SessionWriteScopeFixture({ provider, encryptionVariant: 'dataKey' });
        try {
            await fixture.start();
            const config = SandboxConfigSchema.parse({
                sessionIsolation: 'workspace', networkMode: 'custom',
                allowedDomains: ['127.0.0.1', 'localhost', fixture.modelHost],
            });
            const sessionId = await fixture.spawnSession(fixture.project, config);
            await fixture.send(sessionId, 'scope-marker-before-archive');
            await fixture.waitReply(sessionId, 'scope-marker-before-archive');
            const metadata = (await fixture.session(sessionId)).metadata;
            const nativeId = metadata[fixture.providerIdentityField] as string;
            expect(nativeId).toMatch(/^[0-9a-f-]{36}$/i);
            await writeFile(join(fixture.project, 'work-in-progress.txt'), 'saved workspace edit');
            await fixture.stopDaemon();

            const claudeHome = join(fixture.home, '.claude');
            const codexHome = join(fixture.home, '.codex');
            const nativePath = provider === 'claude'
                ? join(getProjectPath(fixture.project, claudeHome), `${nativeId}.jsonl`)
                : await (async () => {
                    const sessions = join(codexHome, 'sessions');
                    const entries = await readdir(sessions, { recursive: true });
                    const match = entries.filter(value => value.endsWith(`-${nativeId}.jsonl`));
                    expect(match).toHaveLength(1);
                    return join(sessions, match[0]);
                })();
            const record = join(fixture.happyHome, 'sessions.json');
            expect((await readFile(nativePath, 'utf8'))).toContain('scope-marker-before-archive');
            const selected = [fixture.project, nativePath, record];
            const contentDigest = createHash('sha256').update(await readFile(nativePath)).digest('hex');
            const sourceKeys = { signing: nacl.sign.keyPair(), recipient: nacl.box.keyPair() };
            const targetKeys = { signing: nacl.sign.keyPair(), recipient: nacl.box.keyPair() };
            const approval = proveWorkMachineArchiveRecipient({
                taskId: 'native-resume', machineId: 'isolated-machine', accountId: fixture.accountId, generation: 1,
                sourceDeviceId: workMachineSigningIdentity(sourceKeys.signing.publicKey).deviceId,
                targetDeviceId: workMachineSigningIdentity(targetKeys.signing.publicKey).deviceId,
                maxBytes: 16 * 1024 * 1024, expiresAt: Date.now() + 120_000,
            }, targetKeys);
            const encrypted = join(fixture.root, 'transfer.enc');
            const packed = createTar({ cwd: fixture.root, portable: true, strict: true }, selected.map(path => relative(fixture.root, path)));
            const receipt = await sealWorkMachineArchive({ approval, sourceKeys, source: Readable.from(packed), destination: encrypted });
            const object = join(fixture.root, 'object-store.enc');
            const server = createServer((req, res) => {
                if (req.url !== '/test-work-machine/object') { res.writeHead(404).end(); return; }
                const transfer = req.method === 'PUT' && req.headers['if-none-match'] === '*'
                    ? pipeline(req, createWriteStream(object, { flags: 'wx', mode: 0o600 })).then(() => res.writeHead(201).end())
                    : req.method === 'GET' ? pipeline(createReadStream(object), res) : Promise.resolve(res.writeHead(405).end());
                void transfer.catch(() => res.destroy());
            });
            const downloaded = join(fixture.root, 'target-download.enc');
            try {
                await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
                const address = server.address();
                if (!address || typeof address === 'string') throw new Error('Fixture object endpoint unavailable');
                const url = `http://127.0.0.1:${address.port}/test-work-machine/object`;
                const uploaded = await putCheckpointObject({ url, filePath: encrypted, ifAbsent: true });
                expect((await getCheckpointObject({ url, destination: downloaded })).bytes).toBe(uploaded.bytes);
            } finally {
                server.closeAllConnections();
                await new Promise<void>(resolve => server.close(() => resolve()));
            }
            const archive = await restoreWorkMachineArchive({ approval, targetKeys, source: downloaded, receipt, stagingRoot: fixture.root });
            const staging = join(fixture.root, 'target', 'filesystem');
            await mkdir(staging, { recursive: true, mode: 0o700 });
            await extractTar({ cwd: staging, file: archive.archivePath, strict: true });
            for (const path of selected) {
                const staged = join(staging, relative(fixture.root, path));
                await rename(path, `${path}.source`);
                await mkdir(dirname(path), { recursive: true });
                await rename(staged, path);
            }
            expect(createHash('sha256').update(await readFile(nativePath)).digest('hex')).toBe(contentDigest);
            expect(await readFile(join(fixture.project, 'work-in-progress.txt'), 'utf8')).toBe('saved workspace edit');

            await fixture.startDaemon();
            expect(await fixture.resumeSession(sessionId)).toBe(sessionId);
            await fixture.send(sessionId, 'scope-marker-after-archive');
            await fixture.waitReply(sessionId, 'scope-marker-after-archive');
            expect((await fixture.session(sessionId)).metadata[fixture.providerIdentityField]).toBe(nativeId);
            const resumed = [...fixture.modelRequests].reverse().find(body => body.includes('scope-marker-after-archive'));
            expect(resumed).toContain('scope-marker-before-archive');
            expect(fixture.failures).toEqual([]);
        } catch (error) {
            console.error(await fixture.diagnostics());
            throw error;
        } finally {
            await fixture.close();
        }
    });
});
