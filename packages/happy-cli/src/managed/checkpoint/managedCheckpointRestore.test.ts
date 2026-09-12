import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import * as tar from 'tar';
import { gzipSync, gunzipSync } from 'node:zlib';
import { claudeStateRequirements } from './managedClaudeStateLayout';
import { deriveClaudeTranscriptDependencies } from './managedClaudeTranscriptDerivation';
import type { ProviderStateScopeV1 } from './managedProviderStateScope';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManagedCheckpoint } from './managedCheckpointArchive';
import { sealCheckpointBuffer } from './managedCheckpointCrypto';
import { restoreManagedCheckpoint, ManagedCheckpointRestoreError } from './managedCheckpointRestore';
import { checkpointManifestDigest, parseManagedCheckpointManifest, serializeManagedCheckpointManifest, type ManagedCheckpointManifest } from './managedCheckpointManifest';

const nativeFaults = vi.hoisted(() => ({ splitInflate: false, delayInflateEnd: false, read: '' as '' | 'grow' | 'error', suffix: '', handles: 0 }));
vi.mock('node:zlib', async () => {
    const actual = await vi.importActual<typeof import('node:zlib')>('node:zlib');
    const { Transform } = await import('node:stream');
    return { ...actual, createGunzip: (...args: Parameters<typeof actual.createGunzip>) => {
        if (!nativeFaults.splitInflate && !nativeFaults.delayInflateEnd) return actual.createGunzip(...args);
        const chunks: Buffer[] = [];
        return new Transform({
            transform(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); },
            flush(done) {
                const bytes = actual.gunzipSync(Buffer.concat(chunks));
                if (nativeFaults.delayInflateEnd) { this.push(bytes); setTimeout(done, 30); }
                else { this.push(bytes.subarray(0, 1)); setImmediate(() => { this.push(bytes.subarray(1)); done(); }); }
            },
        });
    } };
});
vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
        const handle = await actual.open(...args);
        const path = String(args[0]);
        if (!nativeFaults.read || !path.includes('/.managed-checkpoint-') || !path.endsWith(nativeFaults.suffix)) return handle;
        nativeFaults.handles++;
        let first = true;
        return new Proxy(handle, { get(target, property) {
            if (property === 'close') return async () => { try { await target.close(); } finally { nativeFaults.handles--; } };
            if (property === 'read') return async (...readArgs: Parameters<typeof target.read>) => {
                if (nativeFaults.read === 'error') throw new Error('/private/transcript-secret');
                const value = await target.read(...readArgs);
                if (first) { first = false; await actual.appendFile(path, '!'); }
                return value;
            };
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
        } });
    } };
});

const created: string[] = [];
const key = randomBytes(32);
const checkpointId = 'a'.repeat(64);
const tenant = { tenantId: 'co_1', projectId: 'pr_1' };
const volume = { volumeId: 'vol_1', deviceUuid: 'dev-1' };

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mc-restore-'));
    created.push(dir);
    return dir;
}

afterEach(async () => {
    nativeFaults.splitInflate = false; nativeFaults.delayInflateEnd = false; nativeFaults.read = ''; nativeFaults.suffix = '';
    while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

async function sourceTree(): Promise<string> {
    const root = await scratch();
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/index.ts'), 'export const a = 1;\n');
    await writeFile(join(root, 'README.md'), '# project\n');
    await symlink('../README.md', join(root, 'src/readme.link'));
    return root;
}

async function produce(root: string) {
    return createManagedCheckpoint({
        checkpointId, tenant, volume, image: { imageVersion: 'img@1' },
        sources: [{ area: 'project', root }], key, now: () => 1,
        outputDir: join(await scratch(), 'objects'),
    });
}

async function restoreInput(product: Awaited<ReturnType<typeof produce>>, destination: string, staging: string) {
    return {
        manifest: product.manifest,
        objects: product.objects,
        key,
        expected: { tenant, sourceVolume: volume, targetVolume: volume },
        destinations: new Map([['project' as const, destination]]),
        stagingRoot: staging,
    };
}

describe('restoreManagedCheckpoint', () => {
    it('shouldRestoreTheTreeAtADifferentAbsolutePath', async () => {
        const product = await produce(await sourceTree());
        const home = await scratch();
        const destination = join(home, 'restored/project');
        const result = await restoreManagedCheckpoint(await restoreInput(product, destination, home));

        expect(result.promoted).toBe(true);
        expect(result.manifestDigest).toBe(product.manifestDigest);
        expect(await readFile(join(destination, 'src/index.ts'), 'utf8')).toBe('export const a = 1;\n');
        expect(await readlink(join(destination, 'src/readme.link'))).toBe('../README.md');
    });

    it('shouldReplaceAnExistingTreeAndLeaveNoStagingBehind', async () => {
        const product = await produce(await sourceTree());
        const home = await scratch();
        const destination = join(home, 'project');
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, 'stale.txt'), 'old\n');

        await restoreManagedCheckpoint(await restoreInput(product, destination, home));

        await expect(stat(join(destination, 'stale.txt'))).rejects.toThrow();
        expect(await readFile(join(destination, 'README.md'), 'utf8')).toBe('# project\n');
        const leftovers = (await import('node:fs/promises')).readdir(home);
        expect((await leftovers).filter((name) => name.startsWith('.managed-checkpoint'))).toEqual([]);
    });

    it('shouldRefuseAnotherTenantsCheckpointWithoutTouchingTheVolume', async () => {
        const product = await produce(await sourceTree());
        const home = await scratch();
        const destination = join(home, 'project');
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, 'mine.txt'), 'mine\n');

        const input = await restoreInput(product, destination, home);
        await expect(restoreManagedCheckpoint({
            ...input,
            expected: {
                tenant: { tenantId: 'co_2', projectId: 'pr_1' },
                sourceVolume: volume,
                targetVolume: volume,
            },
        })).rejects.toMatchObject({ code: 'tenant-mismatch' });
        await expect(restoreManagedCheckpoint({
            ...input,
            expected: {
                tenant,
                sourceVolume: { volumeId: 'vol_2', deviceUuid: 'dev-1' },
                targetVolume: volume,
            },
        })).rejects.toMatchObject({ code: 'source-volume-mismatch' });

        expect(await readFile(join(destination, 'mine.txt'), 'utf8')).toBe('mine\n');
    });

    it('shouldRefuseAnArchiveWhoseChecksumDoesNotMatchTheManifest', async () => {
        const product = await produce(await sourceTree());
        const home = await scratch();
        const destination = join(home, 'project');
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, 'mine.txt'), 'mine\n');

        const otherTree = await scratch();
        await writeFile(join(otherTree, 'src'), 'not the same archive\n');
        const swapped = await createManagedCheckpoint({
            checkpointId, tenant, volume, image: { imageVersion: 'img@1' },
            sources: [{ area: 'project', root: otherTree }], key, now: () => 1,
            outputDir: join(await scratch(), 'objects'),
        });

        const input = await restoreInput(product, destination, home);
        await expect(restoreManagedCheckpoint({ ...input, objects: swapped.objects }))
            .rejects.toMatchObject({ code: 'archive-checksum-mismatch' });
        expect(await readFile(join(destination, 'mine.txt'), 'utf8')).toBe('mine\n');
    });

    it('shouldRefuseAnArchiveCarryingContentTheScopeForbids', async () => {
        const root = await scratch();
        await mkdir(join(root, '.ssh'), { recursive: true });
        await writeFile(join(root, '.ssh/id_rsa'), 'PRIVATE');
        await writeFile(join(root, 'ok.txt'), 'ok\n');
        const honest = await produce(root);

        // Forge a manifest+archive pair whose producer did not exclude it.
        const tar = await import('tar');
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
            const pack = tar.c({ cwd: root, gzip: true, portable: false, noDirRecurse: true, follow: false },
                ['ok.txt', '.ssh', '.ssh/id_rsa']);
            pack.on('data', (chunk: Buffer) => chunks.push(chunk));
            pack.on('end', resolve);
            pack.on('error', reject);
        });
        const archive = Buffer.concat(chunks);
        const empty = createHash('sha256').update('').digest('hex');
        const forged: ManagedCheckpointManifest = {
            ...honest.manifest,
            areas: [{
                area: 'project',
                archiveSha256: createHash('sha256').update(archive).digest('hex'),
                archiveBytes: archive.length,
                entryCount: 3,
            }],
            entries: [
                ...honest.manifest.entries,
                { area: 'project', path: '.ssh', type: 'directory', bytes: 0, mode: 0o755, sha256: empty },
                {
                    area: 'project', path: '.ssh/id_rsa', type: 'file', bytes: 7, mode: 0o644,
                    sha256: createHash('sha256').update('PRIVATE').digest('hex'),
                },
            ],
            excluded: [],
        };
        const home = await scratch();
        const destination = join(home, 'project');
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, 'mine.txt'), 'mine\n');
        const sealed = join(await scratch(), 'forged.enc');
        await sealCheckpointBuffer({
            plaintext: archive, destination: sealed, key,
            binding: { ...tenant, checkpointId, area: 'project' },
        });

        await expect(restoreManagedCheckpoint({
            manifest: forged,
            objects: new Map([['project' as const, sealed]]),
            key,
            expected: { tenant, sourceVolume: volume, targetVolume: volume },
            destinations: new Map([['project' as const, destination]]),
            stagingRoot: home,
        })).rejects.toMatchObject({ code: 'forbidden-content' });
        expect(await readFile(join(destination, 'mine.txt'), 'utf8')).toBe('mine\n');
    });

    it('shouldRefuseAnArchiveThatHoldsMoreThanTheManifestPromised', async () => {
        const root = await scratch();
        await writeFile(join(root, 'small.txt'), 'small\n');
        const honest = await produce(root);

        // The manifest still describes one small file; the archive does not.
        const bomb = await scratch();
        await writeFile(join(bomb, 'small.txt'), 'small\n');
        await writeFile(join(bomb, 'payload.bin'), Buffer.alloc(4 * 1024 * 1024, 0x41));
        const tar = await import('tar');
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
            const pack = tar.c({ cwd: bomb, gzip: true, portable: false, noDirRecurse: true, follow: false },
                ['small.txt', 'payload.bin']);
            pack.on('data', (chunk: Buffer) => chunks.push(chunk));
            pack.on('end', resolve);
            pack.on('error', reject);
        });
        const archive = Buffer.concat(chunks);
        const sealed = join(await scratch(), 'bomb.enc');
        await sealCheckpointBuffer({
            plaintext: archive, destination: sealed, key,
            binding: { ...tenant, checkpointId, area: 'project' },
        });
        const home = await scratch();

        await expect(restoreManagedCheckpoint({
            manifest: {
                ...honest.manifest,
                areas: [{
                    area: 'project',
                    archiveSha256: createHash('sha256').update(archive).digest('hex'),
                    archiveBytes: archive.length,
                    entryCount: honest.manifest.areas[0]!.entryCount,
                }],
            },
            objects: new Map([['project' as const, sealed]]),
            key,
            expected: { tenant, sourceVolume: volume, targetVolume: volume },
            destinations: new Map([['project' as const, join(home, 'project')]]),
            stagingRoot: home,
        })).rejects.toMatchObject({ code: 'archive-exceeds-manifest' });
    });

    it('shouldRefuseAnArchiveHoldingMoreEntriesThanTheManifestPromised', async () => {
        const root = await scratch();
        await writeFile(join(root, 'only.txt'), 'only\n');
        const honest = await produce(root);

        const many = await scratch();
        await writeFile(join(many, 'only.txt'), 'only\n');
        const names = ['only.txt'];
        for (let index = 0; index < 200; index += 1) {
            await writeFile(join(many, `extra-${index}.txt`), '');
            names.push(`extra-${index}.txt`);
        }
        const tar = await import('tar');
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
            const pack = tar.c({ cwd: many, gzip: true, portable: false, noDirRecurse: true, follow: false }, names);
            pack.on('data', (chunk: Buffer) => chunks.push(chunk));
            pack.on('end', resolve);
            pack.on('error', reject);
        });
        const archive = Buffer.concat(chunks);
        const sealed = join(await scratch(), 'many.enc');
        await sealCheckpointBuffer({
            plaintext: archive, destination: sealed, key,
            binding: { ...tenant, checkpointId, area: 'project' },
        });
        const home = await scratch();

        await expect(restoreManagedCheckpoint({
            manifest: {
                ...honest.manifest,
                areas: [{
                    area: 'project',
                    archiveSha256: createHash('sha256').update(archive).digest('hex'),
                    archiveBytes: archive.length,
                    entryCount: 1,
                }],
            },
            objects: new Map([['project' as const, sealed]]),
            key,
            expected: { tenant, sourceVolume: volume, targetVolume: volume },
            destinations: new Map([['project' as const, join(home, 'project')]]),
            stagingRoot: home,
        })).rejects.toMatchObject({ code: 'archive-exceeds-manifest' });
    });

    it('shouldRefuseAnArchiveWhoseTotalIsLargerEvenWhenEveryFileAndTheCountFit', async () => {
        const root = await scratch();
        await writeFile(join(root, 'a.bin'), Buffer.alloc(1024 * 1024, 0x41));
        await writeFile(join(root, 'b.bin'), Buffer.alloc(512 * 1024, 0x42));
        await writeFile(join(root, 'c.bin'), Buffer.alloc(512 * 1024, 0x43));
        const honest = await produce(root);

        // Same file count, no file larger than the largest promised, but the
        // sum is over budget.
        const bomb = await scratch();
        for (const name of ['a.bin', 'b.bin', 'c.bin']) {
            await writeFile(join(bomb, name), Buffer.alloc(1024 * 1024, 0x41));
        }
        const tar = await import('tar');
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
            const pack = tar.c({ cwd: bomb, gzip: true, portable: false, noDirRecurse: true, follow: false },
                ['a.bin', 'b.bin', 'c.bin']);
            pack.on('data', (chunk: Buffer) => chunks.push(chunk));
            pack.on('end', resolve);
            pack.on('error', reject);
        });
        const archive = Buffer.concat(chunks);
        const sealed = join(await scratch(), 'total.enc');
        await sealCheckpointBuffer({
            plaintext: archive, destination: sealed, key,
            binding: { ...tenant, checkpointId, area: 'project' },
        });
        const home = await scratch();

        await expect(restoreManagedCheckpoint({
            manifest: {
                ...honest.manifest,
                areas: [{
                    area: 'project',
                    archiveSha256: createHash('sha256').update(archive).digest('hex'),
                    archiveBytes: archive.length,
                    entryCount: 3,
                }],
            },
            objects: new Map([['project' as const, sealed]]),
            key,
            expected: { tenant, sourceVolume: volume, targetVolume: volume },
            destinations: new Map([['project' as const, join(home, 'project')]]),
            stagingRoot: home,
        })).rejects.toMatchObject({ code: 'archive-exceeds-manifest' });
    });

    it('shouldRestoreOntoADifferentVolumeThanTheCheckpointWasTakenOn', async () => {
        const product = await produce(await sourceTree());
        const home = await scratch();
        const destination = join(home, 'project');
        const input = await restoreInput(product, destination, home);

        const result = await restoreManagedCheckpoint({
            ...input,
            expected: {
                tenant,
                // No source constraint: the machine it came from is gone.
                targetVolume: { volumeId: 'vol_replacement', deviceUuid: 'dev-2' },
            },
        });

        expect(result.sourceVolume).toEqual(volume);
        expect(result.targetVolume).toEqual({ volumeId: 'vol_replacement', deviceUuid: 'dev-2' });
        // The manifest is evidence about the source and is never rewritten to
        // agree with where it landed.
        expect(product.manifest.volume).toEqual(volume);
        expect(await readFile(join(destination, 'README.md'), 'utf8')).toBe('# project\n');
    });

    it('shouldRefuseWhenTheExtractedTreeDoesNotMatchTheManifestEntries', async () => {
        const product = await produce(await sourceTree());
        const home = await scratch();
        const destination = join(home, 'project');
        const manifest: ManagedCheckpointManifest = {
            ...product.manifest,
            entries: [...product.manifest.entries, {
                area: 'project', path: 'ghost.txt', type: 'file', bytes: 1, mode: 0o644,
                sha256: 'f'.repeat(64),
            }],
        };
        await expect(restoreManagedCheckpoint({
            ...(await restoreInput(product, destination, home)),
            manifest,
        })).rejects.toMatchObject({ code: 'missing-entry' });
        await expect(stat(destination)).rejects.toThrow();
    });

    it('shouldPreserveTheExistingVolumeWhenPromotionFailsPartWay', async () => {
        const product = await produce(await sourceTree());
        const home = await scratch();
        const destination = join(home, 'project');
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, 'mine.txt'), 'mine\n');

        const real = (await import('node:fs/promises')).rename;
        let calls = 0;
        await expect(restoreManagedCheckpoint({
            ...(await restoreInput(product, destination, home)),
            deps: {
                rename: async (from: string, to: string) => {
                    calls += 1;
                    // First rename moves the old tree aside; the second, which
                    // would put the new one in place, is the one that fails.
                    if (calls === 2) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
                    await real(from, to);
                },
            },
        })).rejects.toMatchObject({ code: 'promotion-failed' });

        expect(await readFile(join(destination, 'mine.txt'), 'utf8')).toBe('mine\n');
    });

    it('shouldRefuseWhenTheExtractedTreeIsNotOwnedByTheExpectedUid', async () => {
        const product = await produce(await sourceTree());
        const home = await scratch();
        const destination = join(home, 'project');
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, 'mine.txt'), 'mine\n');

        await expect(restoreManagedCheckpoint({
            ...(await restoreInput(product, destination, home)),
            expectedUid: (process.getuid?.() ?? 0) + 1,
        })).rejects.toMatchObject({ code: 'ownership-mismatch' });
        expect(await readFile(join(destination, 'mine.txt'), 'utf8')).toBe('mine\n');
    });

    it('shouldKeepTheOriginalReachableWhenPromotionAndRollbackBothFail', async () => {
        const product = await produce(await sourceTree());
        const home = await scratch();
        const destination = join(home, 'project');
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, 'mine.txt'), 'mine\n');

        const real = (await import('node:fs/promises')).rename;
        let calls = 0;
        const error = await restoreManagedCheckpoint({
            ...(await restoreInput(product, destination, home)),
            deps: {
                rename: async (from: string, to: string) => {
                    calls += 1;
                    if (calls >= 2) throw Object.assign(new Error('EIO'), { code: 'EIO' });
                    await real(from, to);
                },
            },
        }).catch((caught: unknown) => caught);

        expect(error).toMatchObject({ code: 'promotion-unreconciled' });
        // The user's only copy sits beside the destination, outside staging,
        // and nothing cleaned it up.
        const displaced = (await readdir(home)).find((name) => name.includes('saycode-displaced'))!;
        expect(await readFile(join(home, displaced, 'mine.txt'), 'utf8')).toBe('mine\n');
        expect((await readdir(home)).some((name) => name.startsWith('managed-checkpoint-promotion-'))).toBe(true);
        // This is the one exit that needs a person: the verified trees stay
        // put so there is something to look at.
        expect((await readdir(home)).some((name) => name.startsWith('.managed-checkpoint-'))).toBe(true);
    });

    it('shouldRefuseWhenAnAreaHasNoDestination', async () => {
        const product = await produce(await sourceTree());
        const home = await scratch();
        await expect(restoreManagedCheckpoint({
            ...(await restoreInput(product, join(home, 'p'), home)),
            destinations: new Map(),
        })).rejects.toMatchObject({ code: 'area-missing' });
    });

    it('shouldSurfaceRestoreFailuresAsATypedErrorWithoutArchiveDetail', async () => {
        const product = await produce(await sourceTree());
        const home = await scratch();
        const error = await restoreManagedCheckpoint({
            ...(await restoreInput(product, join(home, 'p'), home)),
            key: randomBytes(32),
        }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ManagedCheckpointRestoreError);
        expect((error as ManagedCheckpointRestoreError).code).toBe('object-unreadable');
        expect((error as Error).message).toBe('managed checkpoint restore refused: object-unreadable');
    });
});

describe('v1 native state is unscoped', () => {
    it.each(['provider-only', 'mixed', 'areas-only', 'entries-only', 'no-provider-destination'] as const)(
        'shouldRefuse %s before staging or object reads and preserve destinations', async (shape) => {
            const product = await produce(await sourceTree());
            const home = await scratch();
            const destination = join(home, 'project');
            const providerDestination = join(home, 'provider');
            await mkdir(destination);
            await mkdir(providerDestination);
            await writeFile(join(destination, 'original'), 'project-original');
            await writeFile(join(providerDestination, 'original'), 'provider-original');
            const staging = join(home, 'not-created');
            const providerArea = { ...product.manifest.areas[0]!, area: 'provider-state' as const };
            if (shape !== 'entries-only') product.manifest.areas.push(providerArea);
            if (shape !== 'areas-only') product.manifest.entries.push({
                area: 'provider-state', path: 'sessions/s1/state', type: 'file', bytes: 0,
                mode: 0o600, sha256: createHash('sha256').update('').digest('hex'), inline: '',
            });
            if (shape === 'provider-only') {
                product.manifest.areas = [providerArea];
                product.manifest.entries = product.manifest.entries.filter(entry => entry.area === 'provider-state');
            }
            const input = await restoreInput(product, destination, staging);
            const destinations: Parameters<typeof restoreManagedCheckpoint>[0]['destinations'] = new Map(input.destinations);
            if (shape !== 'no-provider-destination') destinations.set('provider-state', providerDestination);
            let objectReads = 0;
            input.objects.get = () => { objectReads += 1; throw new Error('object must not be read'); };
            let promotions = 0;
            const outcome = restoreManagedCheckpoint({
                ...input, destinations, providerStateSessions: ['s1'],
                deps: { rename: async () => { promotions += 1; throw new Error('must not promote'); } },
            });
            await expect(outcome).rejects.toMatchObject({ code: 'provider-state-unscoped' });
            expect(objectReads).toBe(0);
            expect(promotions).toBe(0);
            await expect(stat(staging)).rejects.toMatchObject({ code: 'ENOENT' });
            expect(await readFile(join(destination, 'original'), 'utf8')).toBe('project-original');
            expect(await readFile(join(providerDestination, 'original'), 'utf8')).toBe('provider-original');
        },
    );

    it('shouldRestoreTheEntryTimeProjectManifestWhenTheCallerAddsProviderStateAfterTheFirstAwait', async () => {
        const product = await produce(await sourceTree());
        // Keep the mutation fixture separate from shared tenant/volume constants.
        product.manifest = structuredClone(product.manifest);
        const originalDigest = product.manifestDigest;
        const home = await scratch();
        const destination = join(home, 'project');
        const providerDestination = join(home, 'provider');
        await mkdir(providerDestination);
        await writeFile(join(providerDestination, 'original'), 'provider-original');
        const input = await restoreInput(product, destination, home);
        const destinations: Parameters<typeof restoreManagedCheckpoint>[0]['destinations'] = new Map(input.destinations);
        destinations.set('provider-state', providerDestination);
        const objectAreas: string[] = [];
        const get = input.objects.get.bind(input.objects);
        input.objects.get = (area) => { objectAreas.push(area); return get(area); };
        const renamed: string[] = [];
        const running = restoreManagedCheckpoint({
            ...input, destinations,
            deps: { rename: async (from, to) => {
                renamed.push(from, to);
                await (await import('node:fs/promises')).rename(from, to);
            } },
        });
        product.manifest.areas.push({ ...product.manifest.areas[0]!, area: 'provider-state' });
        product.manifest.entries.push({
            area: 'provider-state', path: 'sessions/s1/state', type: 'file', bytes: 0,
            mode: 0o600, sha256: createHash('sha256').update('').digest('hex'),
        });
        product.manifest.image.imageVersion = 'caller-mutated';
        const result = await running;
        expect(result.manifestDigest).toBe(originalDigest);
        expect(objectAreas).toEqual(['project']);
        expect(renamed.some(path => path === providerDestination || path.startsWith(`${providerDestination}.`))).toBe(false);
        expect(await readFile(join(providerDestination, 'original'), 'utf8')).toBe('provider-original');
        expect(await readFile(join(destination, 'README.md'), 'utf8')).toBe('# project\n');
        expect(product.manifest.image.imageVersion).toBe('caller-mutated');
        expect(Object.isFrozen(product.manifest)).toBe(false);
    });

    it('shouldUseOwnedInlinePathContentAndMetadataThroughPromotionAndDigest', async () => {
        const root = await sourceTree();
        await mkdir(join(root, '.git'));
        await writeFile(join(root, '.git/config'), '[core]\nrepositoryformatversion = 0\n');
        const product = await produce(root);
        // Keep the mutation fixture separate from shared tenant/volume constants.
        product.manifest = structuredClone(product.manifest);
        const originalDigest = product.manifestDigest;
        const inline = product.manifest.entries.find(entry => entry.inline !== undefined)!;
        expect(inline).toBeDefined();
        const originalContent = inline.inline;
        const home = await scratch();
        const destination = join(home, 'project');
        const running = restoreManagedCheckpoint(await restoreInput(product, destination, home));
        // Entry points and nested scalar metadata remain caller-owned and mutable.
        inline.path = 'redirected-inline';
        inline.inline = 'caller changed content';
        inline.sha256 = createHash('sha256').update(inline.inline).digest('hex');
        inline.bytes = Buffer.byteLength(inline.inline);
        product.manifest.volume.volumeId = 'caller-volume';
        product.manifest.checkpointId = 'b'.repeat(64);
        const result = await running;
        expect(result.manifestDigest).toBe(originalDigest);
        expect(result.checkpointId).toBe(checkpointId);
        expect(result.sourceVolume).toEqual(volume);
        expect(await readFile(join(destination, '.git/config'), 'utf8')).toBe(originalContent);
        await expect(stat(join(destination, 'redirected-inline'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(inline.path).toBe('redirected-inline');
    });
});

// BEGIN native raw fixture (also consumed by the isolated Linux driver).
function nativeRawFixture() {
    const NATIVE = 'd6da1867-afd5-4637-bd7e-52a3e28c2fb8';
    const AGENT = 'a4ec78d2c4e3608ba';
    const SEGMENT = 'bwmc1gbmg.txt';
    const MANAGED_CLAUDE_PROJECT_SLUG = '-workspace-project';
    const ARTIFACT_BYTES = 'BIGLINE' + String.fromCharCode(10);
function transcript(over: { withArtifact?: boolean } = {}): string {
    const rows: unknown[] = [
        {
            type: 'assistant', sessionId: NATIVE, uuid: 'a1',
            message: { role: 'assistant', content: [{
                type: 'tool_use', id: 'toolu_agent_1', name: 'Agent',
                input: { description: 'x', prompt: 'y', subagent_type: 'general-purpose', run_in_background: false },
            }] },
        },
        {
            type: 'user', sessionId: NATIVE, uuid: 'a2', sourceToolAssistantUUID: 'a1',
            toolUseResult: { agentId: AGENT, agentType: 'general-purpose', status: 'completed' },
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_agent_1', content: 'ok' }] },
        },
    ];
    if (over.withArtifact) {
        rows.push(
            {
                type: 'assistant', sessionId: NATIVE, uuid: 'b1',
                message: { role: 'assistant', content: [{
                    type: 'tool_use', id: 'toolu_big_1', name: 'Bash',
                    input: { command: 'seq 1 1000', run_in_background: false },
                }] },
            },
            {
                type: 'user', sessionId: NATIVE, uuid: 'b2', sourceToolAssistantUUID: 'b1',
                toolUseResult: {
                    stdout: 'BIGLINE',
                    persistedOutputPath:
                        `/workspace/.codex/.claude/projects/${MANAGED_CLAUDE_PROJECT_SLUG}/${NATIVE}/tool-results/${SEGMENT}`,
                    persistedOutputSize: Buffer.byteLength(ARTIFACT_BYTES),
                },
                message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_big_1', content: 'ok' }] },
            },
        );
    }
    return rows.map((row) => JSON.stringify(row)).join(String.fromCharCode(10)) + String.fromCharCode(10);
}

function childTranscript(): string {
    const rows = [
        { type: 'user', isSidechain: true, agentId: AGENT, sessionId: NATIVE, uuid: 'c1', message: { role: 'user', content: 'go' } },
        { type: 'assistant', isSidechain: true, agentId: AGENT, sessionId: NATIVE, uuid: 'c2', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    ];
    return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

function childMeta(): string {
    return JSON.stringify({
        agentType: 'general-purpose',
        description: 'probe subagent',
        toolUseId: 'toolu_agent_1',
        spawnDepth: 1,
        requestShape: 'foreground',
        requestNonInteractive: true,
    });
}


    return { parent: transcript({ withArtifact: true }), child: childTranscript(), meta: childMeta(), artifact: ARTIFACT_BYTES, nativeId: NATIVE, agentId: AGENT, segment: SEGMENT };
}
// END native raw fixture.
const nativeProject = '.claude/projects/-workspace-project';
function expectedNativeScope(shared = false): ProviderStateScopeV1 {
    const scope: ProviderStateScopeV1 = {
        version: 1, provider: 'claude', capability: 'native-resume',
        generation: { projectId: 'pr_1', workspaceId: 'ws-1', runtimeId: 'rt-1', epoch: 2, provisioningOperationId: 'op-1' },
        sources: [{ attemptId: 'attempt-1', runId: 'run-1', happySessionId: 'happy-1', runtimeId: 'rt-1', epoch: 1,
            currentNativeId: nativeRawFixture().nativeId, retainedNativeIds: [], metadataVersion: 1 }],
    };
    if (shared) scope.sources = [...scope.sources, { ...scope.sources[0], attemptId: 'attempt-2', currentNativeId: '11111111-1111-4111-8111-111111111111', retainedNativeIds: [scope.sources[0].currentNativeId] }];
    return scope;
}
function nativeLimits() {
    return { maxArchiveBytesPerArea: 1_048_576, maxExpandedBytesPerArea: 4_194_304,
        maxEntriesPerArea: 128, maxTarMetaBytes: 8192, maxTranscriptBytes: 65536, maxMetaBytes: 8192,
        maxArtifactBytes: 65536, maxAggregateReadBytes: 262144, maxRecords: 128 };
}
async function nativeProduct(shared = false) {
    const raw = nativeRawFixture();
    const session = `${nativeProject}/${raw.nativeId}`;
    const files = new Map([
        [session + '.jsonl', Buffer.from(raw.parent)],
        [`${session}/subagents/agent-${raw.agentId}.jsonl`, Buffer.from(raw.child)],
        [`${session}/subagents/agent-${raw.agentId}.meta.json`, Buffer.from(raw.meta)],
        [`${session}/tool-results/${raw.segment}`, Buffer.from(raw.artifact)],
    ]);
    const derived = deriveClaudeTranscriptDependencies({ nativeId: raw.nativeId, canonicalCwd: '/workspace/project', providerHome: '/workspace/.codex',
        records: raw.parent.trim().split('\n').map(line => JSON.parse(line)),
        children: new Map([[raw.agentId, { records: raw.child.trim().split('\n').map(line => JSON.parse(line)), meta: JSON.parse(raw.meta) }]]) });
    if (!derived.derived) throw new Error('fixture derivation');
    const scope = expectedNativeScope(shared);
    const dependencies = new Map([[raw.nativeId, { complete: true as const, subagents: derived.subagents, references: derived.references }]]);
    if (shared) {
        const nativeId = scope.sources[1].currentNativeId;
        files.set(`${nativeProject}/${nativeId}.jsonl`, Buffer.from(JSON.stringify({ type: 'user', sessionId: nativeId, uuid: 'u', message: { role: 'user', content: 'other' } }) + '\n'));
        dependencies.set(nativeId, { complete: true, subagents: [], references: [] });
    }
    const required = claudeStateRequirements({ canonicalCwd: '/workspace/project', providerHome: '/workspace/.codex', sources: scope.sources,
        dependencies });
    if (!required.ok) throw new Error('fixture layout');
    const root = await scratch();
    for (const entry of required.entries) {
        if (entry.kind === 'ancestry') await mkdir(join(root, entry.path), { recursive: true, mode: 0o700 });
        else await writeFile(join(root, entry.path), files.get(entry.path)!, { mode: 0o600 });
    }
    const chunks: Buffer[] = [];
    for await (const chunk of tar.c({ cwd: root, gzip: true, noDirRecurse: true, portable: true }, required.entries.map(entry => entry.path))) chunks.push(Buffer.from(chunk));
    const archive = Buffer.concat(chunks);
    const object = join(await scratch(), 'sealed');
    await sealCheckpointBuffer({ plaintext: archive, destination: object, key, binding: { ...tenant, checkpointId, area: 'provider-state' } });
    const manifest: ManagedCheckpointManifest = {
        schemaVersion: 2, checkpointId, tenant, volume, image: { imageVersion: 'img@1' }, createdAtMs: 1,
        areas: [{ area: 'provider-state', archiveSha256: createHash('sha256').update(archive).digest('hex'), archiveBytes: archive.length, entryCount: required.entries.length }],
        entries: required.entries.map(entry => { const body = files.get(entry.path); return { area: 'provider-state', path: entry.path,
            type: entry.kind === 'ancestry' ? 'directory' : 'file', mode: entry.kind === 'ancestry' ? 0o700 : 0o600,
            bytes: body?.length ?? 0, sha256: createHash('sha256').update(body ?? '').digest('hex') }; }),
        nativeState: { layoutVersion: 1, providerStateScope: scope, entries: required.entries.map(entry => ({ ...entry, requiredBy: [...entry.requiredBy] })) }, excluded: [], worktrees: [],
    };
    parseManagedCheckpointManifest(serializeManagedCheckpointManifest(manifest));
    return { manifest, objects: new Map([['provider-state' as const, object]]), archive, root, raw, files };
}
async function nativeInput(product: Awaited<ReturnType<typeof nativeProduct>>) {
    const home = await scratch();
    const destination = join(home, 'provider');
    await mkdir(destination); await writeFile(join(destination, 'survivor'), 'old');
    return { manifest: product.manifest, objects: product.objects, key, expected: { tenant, sourceVolume: volume, targetVolume: { volumeId: 'replacement', deviceUuid: 'new' } },
        destinations: new Map([['provider-state' as const, destination]]), stagingRoot: join(home, 'staging'),
        nativeRestore: { expectedSourceScope: expectedNativeScope(), limits: nativeLimits() } };
}
it('requires independently supplied native scope before staging a v2', async () => {
    const input = await nativeInput(await nativeProduct());
    const { nativeRestore: _native, ...without } = input;
    await expect(restoreManagedCheckpoint(without)).rejects.toMatchObject({ code: 'native-scope-required' });
    await expect(stat(input.stagingRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(input.destinations.get('provider-state')!, 'survivor'), 'utf8')).toBe('old');
});

it.each(['scope', 'limits', 'destination', 'legacy-hints', 'manifest', 'version'] as const)('refuses native %s before any staging I/O', async kind => {
    const input = await nativeInput(await nativeProduct());
    let code = 'native-input-invalid';
    if (kind === 'scope') { input.nativeRestore.expectedSourceScope.sources[0].metadataVersion++; code = 'native-scope-mismatch'; }
    if (kind === 'limits') input.nativeRestore.limits.maxRecords = NaN;
    if (kind === 'destination') { input.destinations.clear(); code = 'area-missing'; }
    if (kind === 'manifest') { input.manifest.entries[0].path = '../escape'; code = 'native-manifest-invalid'; }
    if (kind === 'version') { Object.assign(input.manifest, { schemaVersion: 3 }); code = 'native-manifest-invalid'; }
    const request = kind === 'legacy-hints' ? { ...input, providerStateSessions: [] } : input;
    await expect(restoreManagedCheckpoint(request)).rejects.toMatchObject({ code });
    await expect(stat(input.stagingRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});

async function replaceNativeArchive(product: Awaited<ReturnType<typeof nativeProduct>>, archive: Buffer) {
    const object = join(await scratch(), 'sealed-replacement');
    await sealCheckpointBuffer({ plaintext: archive, destination: object, key, binding: { ...tenant, checkpointId, area: 'provider-state' } });
    product.objects.set('provider-state', object);
    Object.assign(product.manifest.areas.find(area => area.area === 'provider-state')!, { archiveSha256: createHash('sha256').update(archive).digest('hex'), archiveBytes: archive.length });
}
it.each(['expanded', 'nested-gzip', 'duplicate', 'metadata'] as const)('bounds actual %s archive before promotion', async kind => {
    const product = await nativeProduct();
    const input = await nativeInput(product);
    let code = 'native-budget-exceeded';
    if (kind === 'expanded') input.nativeRestore.limits.maxExpandedBytesPerArea = product.manifest.entries.reduce((total, entry) => total + entry.bytes, 0);
    if (kind === 'nested-gzip') { await replaceNativeArchive(product, gzipSync(product.archive)); code = 'extract-failed'; }
    if (kind === 'duplicate') {
        const chunks: Buffer[] = [];
        const paths = product.manifest.entries.map(entry => entry.path);
        for await (const chunk of tar.c({ cwd: product.root, gzip: true, noDirRecurse: true, portable: true }, [...paths, paths[0]])) chunks.push(Buffer.from(chunk));
        await replaceNativeArchive(product, Buffer.concat(chunks));
        code = 'archive-exceeds-manifest';
    }
    if (kind === 'metadata') {
        const body = Buffer.alloc(9000, 32);
        const header = new tar.Header({ path: 'pax', type: 'ExtendedHeader', size: body.length, mode: 0o600 });
        header.encode();
        await replaceNativeArchive(product, gzipSync(Buffer.concat([header.block!, body, Buffer.alloc((512 - body.length % 512) % 512), Buffer.alloc(1024)])));
        code = 'forbidden-content';
    }
    await expect(restoreManagedCheckpoint(input)).rejects.toMatchObject({ code });
    expect(await readFile(join(input.destinations.get('provider-state')!, 'survivor'), 'utf8')).toBe('old');
});

it('restores real parent, child, meta and artifact bytes only after native closure', async () => {
    const product = await nativeProduct();
    const input = await nativeInput(product);
    const result = await restoreManagedCheckpoint(input);
    expect(result.manifestDigest).toBe(checkpointManifestDigest(product.manifest));
    expect(result.targetVolume).toEqual({ volumeId: 'replacement', deviceUuid: 'new' });
    for (const [path, bytes] of product.files) {
        expect(await readFile(join(input.destinations.get('provider-state')!, path))).toEqual(bytes);
        expect((await stat(join(input.destinations.get('provider-state')!, path))).mode & 0o7777).toBe(0o600);
    }
});

async function resealNativeTree(product: Awaited<ReturnType<typeof nativeProduct>>) {
    const chunks: Buffer[] = [];
    for await (const chunk of tar.c({ cwd: product.root, gzip: true, noDirRecurse: true, portable: true }, product.manifest.entries.filter(entry => entry.area === 'provider-state').map(entry => entry.path))) chunks.push(Buffer.from(chunk));
    await replaceNativeArchive(product, Buffer.concat(chunks));
}
async function replaceNativeFile(product: Awaited<ReturnType<typeof nativeProduct>>, path: string, bytes: Buffer) {
    await writeFile(join(product.root, path), bytes);
    const entry = product.manifest.entries.find(entry => entry.path === path)!;
    entry.bytes = bytes.length;
    entry.sha256 = createHash('sha256').update(bytes).digest('hex');
    await resealNativeTree(product);
}
it.each(['child', 'artifact', 'meta-binding', 'artifact-size', 'unknown-record', 'records-budget'] as const)('refuses authenticated self-consistent %s before replacing destinations', async kind => {
    const product = await nativeProduct();
    if (product.manifest.schemaVersion !== 2) throw new Error('fixture');
    const session = `${nativeProject}/${product.raw.nativeId}`;
    if (kind === 'child' || kind === 'artifact') {
        const drop = kind === 'child' ? '/subagents' : '/tool-results';
        product.manifest.entries = product.manifest.entries.filter(entry => !entry.path.includes(drop));
        product.manifest.nativeState.entries = product.manifest.nativeState.entries.filter(entry => !entry.path.includes(drop));
        product.manifest.areas[0].entryCount = product.manifest.entries.length;
        await resealNativeTree(product);
    }
    if (kind === 'meta-binding') await replaceNativeFile(product, `${session}/subagents/agent-${product.raw.agentId}.meta.json`, Buffer.from(product.raw.meta.replace('toolu_agent_1', 'toolu_agent_2')));
    if (kind === 'artifact-size') await replaceNativeFile(product, `${session}/tool-results/${product.raw.segment}`, Buffer.from(product.raw.artifact + '!'));
    if (kind === 'unknown-record') await replaceNativeFile(product, session + '.jsonl', Buffer.from(product.raw.parent + '{"type":"not-supported"}\n'));
    parseManagedCheckpointManifest(serializeManagedCheckpointManifest(product.manifest));
    const input = await nativeInput(product);
    if (kind === 'records-budget') input.nativeRestore.limits.maxRecords = 1;
    await expect(restoreManagedCheckpoint(input)).rejects.toMatchObject({ code: kind === 'records-budget' ? 'native-budget-exceeded' : 'native-dependency-invalid' });
    expect(await readFile(join(input.destinations.get('provider-state')!, 'survivor'), 'utf8')).toBe('old');
});

it('owns native manifest, scope, limits, area paths and destination identity across the first await', async () => {
    const product = await nativeProduct();
    const input = await nativeInput(product);
    const destination = input.destinations.get('provider-state')!;
    const manifestDigest = checkpointManifestDigest(input.manifest);
    const pending = restoreManagedCheckpoint(input);
    input.nativeRestore.expectedSourceScope.sources[0].metadataVersion++;
    input.nativeRestore.limits.maxRecords = 1;
    input.manifest.entries[0].path = 'mutated';
    input.objects.clear(); input.destinations.clear();
    input.expected.targetVolume.volumeId = 'mutated';
    input.stagingRoot = '/not-the-owned-path';
    const result = await pending;
    expect(result.manifestDigest).toBe(manifestDigest);
    expect(result.targetVolume.volumeId).toBe('replacement');
    expect(await readFile(join(destination, `${nativeProject}/${product.raw.nativeId}.jsonl`), 'utf8')).toBe(product.raw.parent);
});

it.each(['escaping-link', 'worktree-name'] as const)('refuses native mixed %s before any staging writes', async kind => {
    const product = await nativeProduct();
    const input = await nativeInput(product);
    if (kind === 'escaping-link') product.manifest.entries.push({ area: 'project', path: 'escape', type: 'symlink', bytes: 0, mode: 0o777,
        linkTarget: '/outside-private-staging', sha256: createHash('sha256').update('/outside-private-staging').digest('hex') });
    else product.manifest.worktrees.push({ name: '../../../../outside', path: 'worktree' });
    await expect(restoreManagedCheckpoint(input)).rejects.toMatchObject({ code: 'forbidden-content' });
    await expect(stat(input.stagingRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('requires shared current and retained dependencies with every association and reads each file once', async () => {
    const product = await nativeProduct(true);
    const input = await nativeInput(product);
    input.nativeRestore.expectedSourceScope = expectedNativeScope(true);
    input.nativeRestore.limits.maxAggregateReadBytes = [...product.files.values()].reduce((sum, bytes) => sum + bytes.length, 0);
    const result = await restoreManagedCheckpoint(input);
    expect(result.manifestDigest).toBe(checkpointManifestDigest(product.manifest));
    for (const [path, bytes] of product.files) expect(await readFile(join(input.destinations.get('provider-state')!, path))).toEqual(bytes);
});

it.each(['maxArchiveBytesPerArea', 'maxExpandedBytesPerArea', 'maxEntriesPerArea', 'maxTarMetaBytes', 'maxTranscriptBytes', 'maxMetaBytes', 'maxArtifactBytes', 'maxAggregateReadBytes', 'maxRecords'] as const)
('requires a positive safe explicit %s budget', async key => {
    const input = await nativeInput(await nativeProduct());
    input.nativeRestore.limits[key] = 0;
    await expect(restoreManagedCheckpoint(input)).rejects.toMatchObject({ code: 'native-input-invalid' });
    await expect(stat(input.stagingRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['compressed', 'expanded', 'aggregate', 'transcript', 'meta', 'artifact'] as const)('honors exact %s byte budget and refuses one byte less', async kind => {
    const product = await nativeProduct();
    const limit = kind === 'compressed' ? 'maxArchiveBytesPerArea' : kind === 'expanded' ? 'maxExpandedBytesPerArea' : kind === 'aggregate' ? 'maxAggregateReadBytes' : kind === 'transcript' ? 'maxTranscriptBytes' : kind === 'meta' ? 'maxMetaBytes' : 'maxArtifactBytes';
    const bytes = kind === 'compressed' ? product.archive.length : kind === 'expanded' ? gunzipSync(product.archive).length : kind === 'aggregate' ? [...product.files.values()].reduce((sum, bytes) => sum + bytes.length, 0) : Buffer.byteLength(kind === 'transcript' ? product.raw.parent : kind === 'meta' ? product.raw.meta : product.raw.artifact);
    const exact = await nativeInput(product);
    exact.nativeRestore.limits[limit] = bytes;
    expect((await restoreManagedCheckpoint(exact)).promoted).toBe(true);
    const over = await nativeInput(product);
    over.nativeRestore.limits[limit] = bytes - 1;
    await expect(restoreManagedCheckpoint(over)).rejects.toMatchObject({ code: 'native-budget-exceeded' });
    expect(await readFile(join(over.destinations.get('provider-state')!, 'survivor'), 'utf8')).toBe('old');
});

it('verifies every area before the single joint promotion', async () => {
    const product = await nativeProduct();
    const project = await produce(await sourceTree());
    product.manifest.areas.unshift(...project.manifest.areas);
    product.manifest.entries.unshift(...project.manifest.entries);
    const input = await nativeInput(product);
    const projectDestination = join(await scratch(), 'project');
    await mkdir(projectDestination); await writeFile(join(projectDestination, 'survivor'), 'project-old');
    const objects = new Map<import('./managedCheckpointScope').CheckpointArea, string>(input.objects);
    const destinations = new Map<import('./managedCheckpointScope').CheckpointArea, string>(input.destinations);
    objects.set('project', project.objects.get('project')!); destinations.set('project', projectDestination);
    await replaceNativeFile(product, `${nativeProject}/${product.raw.nativeId}/subagents/agent-${product.raw.agentId}.meta.json`, Buffer.from(product.raw.meta.replace('toolu_agent_1', 'toolu_agent_2')));
    objects.set('provider-state', product.objects.get('provider-state')!);
    let renames = 0;
    await expect(restoreManagedCheckpoint({ ...input, objects, destinations, deps: { rename: async () => { renames++; } } })).rejects.toMatchObject({ code: 'native-dependency-invalid' });
    expect(renames).toBe(0);
    expect(await readFile(join(projectDestination, 'survivor'), 'utf8')).toBe('project-old');
    expect(await readFile(join(destinations.get('provider-state')!, 'survivor'), 'utf8')).toBe('old');
});

it('rejects nested gzip before the tar parser even when the leading magic arrives in two chunks', async () => {
    const product = await nativeProduct();
    await replaceNativeArchive(product, gzipSync(product.archive));
    const input = await nativeInput(product);
    input.nativeRestore.limits.maxExpandedBytesPerArea = 4096;
    expect(product.archive.length).toBeLessThan(4096);
    expect(gunzipSync(product.archive).length).toBeGreaterThan(4096);
    // Fault seam splits actual first-inflate bytes; it is not a different gzip format.
    nativeFaults.splitInflate = true;
    await expect(restoreManagedCheckpoint(input)).rejects.toMatchObject({ code: 'extract-failed' });
    expect(await readFile(join(input.destinations.get('provider-state')!, 'survivor'), 'utf8')).toBe('old');
});
it.each(['grow', 'error'] as const)('closes native descriptors on actual read %s without promotion or raw error disclosure', async kind => {
    const product = await nativeProduct();
    const input = await nativeInput(product);
    nativeFaults.read = kind;
    nativeFaults.suffix = `${product.raw.nativeId}.jsonl`;
    const error = await restoreManagedCheckpoint(input).catch(error => error);
    expect(error).toBeInstanceOf(ManagedCheckpointRestoreError);
    expect(error.code).toBe(kind === 'grow' ? 'native-budget-exceeded' : 'native-dependency-invalid');
    expect(error.message).not.toContain('private');
    expect(nativeFaults.handles).toBe(0);
    expect(await readFile(join(input.destinations.get('provider-state')!, 'survivor'), 'utf8')).toBe('old');
});

it('completes extraction when tar has processed entries before the decompressor ends', async () => {
    const product = await nativeProduct();
    const input = await nativeInput(product);
    // Delay only the decompressor's EOF so tar can complete pending filesystem work
    // first. Its subsequent end() can emit finish synchronously.
    nativeFaults.delayInflateEnd = true;
    expect((await restoreManagedCheckpoint(input)).promoted).toBe(true);
});

async function nativeMixedWorktree() {
    const product = await nativeProduct();
    const root = await scratch();
    const name = '.valid name';
    await writeFile(join(root, 'readme.txt'), 'leaf-target');
    await symlink('readme.txt', join(root, 'leaf-link'));
    await mkdir(join(root, '.git/worktrees', name), { recursive: true });
    await mkdir(join(root, 'worktree'));
    await writeFile(join(root, '.git/worktrees', name, 'gitdir'), join(root, 'worktree/.git') + '\n');
    await writeFile(join(root, 'worktree/.git'), `gitdir: ${join(root, '.git/worktrees', name)}\n`);
    await writeFile(join(root, '.git/config'), '[core]\nrepositoryformatversion = 0\n');
    const project = await produce(root);
    expect(project.manifest.worktrees).toEqual([{ name, path: 'worktree' }]);
    product.manifest.areas.unshift(...project.manifest.areas);
    product.manifest.entries.unshift(...project.manifest.entries);
    product.manifest.worktrees = project.manifest.worktrees;
    const input = await nativeInput(product);
    const destination = join(await scratch(), 'project');
    await mkdir(destination); await writeFile(join(destination, 'survivor'), 'project-old');
    const objects = new Map<import('./managedCheckpointScope').CheckpointArea, string>(input.objects);
    const destinations = new Map<import('./managedCheckpointScope').CheckpointArea, string>(input.destinations);
    objects.set('project', project.objects.get('project')!); destinations.set('project', destination);
    return { product, input: { ...input, objects, destinations }, destination, name };
}
it('preserves valid single-component worktree names and project inline members in a joint native restore', async () => {
    const { product, input, destination, name } = await nativeMixedWorktree();
    expect(product.manifest.entries.some(entry => entry.inline !== undefined)).toBe(true);
    expect((await restoreManagedCheckpoint(input)).promoted).toBe(true);
    expect(await readlink(join(destination, 'leaf-link'))).toBe('readme.txt');
    expect(await readFile(join(destination, 'leaf-link'), 'utf8')).toBe('leaf-target');
    expect(await readFile(join(destination, 'worktree/.git'), 'utf8')).toBe(`gitdir: ${join(destination, '.git/worktrees', name)}\n`);
    expect(await readFile(join(destination, '.git/worktrees', name, 'gitdir'), 'utf8')).toBe(join(destination, 'worktree/.git') + '\n');
});
it('refuses a B-valid authenticated worktree traversal before rewriting an outside sentinel', async () => {
    const { product, input, destination } = await nativeMixedWorktree();
    const outside = join(input.stagingRoot, '..', 'outside');
    await mkdir(outside); await writeFile(join(outside, 'gitdir'), 'outside-original');
    product.manifest.worktrees[0].name = '../../../../../outside';
    parseManagedCheckpointManifest(serializeManagedCheckpointManifest(product.manifest));
    await expect(restoreManagedCheckpoint(input)).rejects.toMatchObject({ code: 'forbidden-content' });
    expect(await readFile(join(outside, 'gitdir'), 'utf8')).toBe('outside-original');
    expect(await readFile(join(destination, 'survivor'), 'utf8')).toBe('project-old');
    await expect(stat(input.stagingRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses a repeated tar member even when the total materialized count fits', async () => {
    const product = await nativeProduct();
    const paths = product.manifest.entries.map(entry => entry.path);
    paths[paths.length - 1] = paths[0];
    const chunks: Buffer[] = [];
    for await (const chunk of tar.c({ cwd: product.root, gzip: true, noDirRecurse: true, portable: true }, paths)) chunks.push(Buffer.from(chunk));
    await replaceNativeArchive(product, Buffer.concat(chunks));
    const input = await nativeInput(product);
    await expect(restoreManagedCheckpoint(input)).rejects.toMatchObject({ code: 'archive-exceeds-manifest' });
    expect(await readFile(join(input.destinations.get('provider-state')!, 'survivor'), 'utf8')).toBe('old');
});

it.each(['parent', 'child', 'meta', 'artifact'] as const)('checks the same raw %s buffer digest that native derivation consumes', async kind => {
    const product = await nativeProduct();
    const session = `${nativeProject}/${product.raw.nativeId}`;
    const path = kind === 'parent' ? session + '.jsonl' : kind === 'child' ? `${session}/subagents/agent-${product.raw.agentId}.jsonl` : kind === 'meta' ? `${session}/subagents/agent-${product.raw.agentId}.meta.json` : `${session}/tool-results/${product.raw.segment}`;
    const changed = kind === 'parent' ? product.raw.parent.replace('"prompt":"y"', '"prompt":"z"') : kind === 'child' ? product.raw.child.replace('done', 'tone') : kind === 'meta' ? product.raw.meta.replace('probe', 'other') : product.raw.artifact.replace('BIGLINE', 'BIGLINA');
    expect(Buffer.byteLength(changed)).toBe(product.files.get(path)!.length);
    await writeFile(join(product.root, path), changed);
    // Re-authenticate the changed tar, deliberately retaining the old per-entry digest.
    await resealNativeTree(product);
    const input = await nativeInput(product);
    await expect(restoreManagedCheckpoint(input)).rejects.toMatchObject({ code: 'entry-mismatch' });
    expect(await readFile(join(input.destinations.get('provider-state')!, 'survivor'), 'utf8')).toBe('old');
});

it('includes many small metadata headers in the expanded byte limit', async () => {
    const product = await nativeProduct();
    const body = Buffer.from('17 comment=hello\n');
    const header = new tar.Header({ path: 'pax', type: 'ExtendedHeader', size: body.length, mode: 0o600 });
    header.encode();
    const meta = Buffer.concat([header.block!, body, Buffer.alloc(512 - body.length)]);
    const original = gunzipSync(product.archive);
    await replaceNativeArchive(product, gzipSync(Buffer.concat([...Array.from({ length: 16 }, () => meta), original])));
    const input = await nativeInput(product);
    input.nativeRestore.limits.maxExpandedBytesPerArea = original.length;
    await expect(restoreManagedCheckpoint(input)).rejects.toMatchObject({ code: 'native-budget-exceeded' });
    expect(await readFile(join(input.destinations.get('provider-state')!, 'survivor'), 'utf8')).toBe('old');
});

it('refuses a negative effective tar file size before any member is restored', async () => {
    const product = await nativeProduct();
    const header = new tar.Header({ path: `${nativeProject}/${product.raw.nativeId}.jsonl`, type: 'File', size: -1, mode: 0o600 });
    header.encode();
    await replaceNativeArchive(product, gzipSync(Buffer.concat([header.block!, Buffer.alloc(1024)])));
    const input = await nativeInput(product);
    await expect(restoreManagedCheckpoint(input)).rejects.toMatchObject({ code: 'archive-exceeds-manifest' });
    expect(await readFile(join(input.destinations.get('provider-state')!, 'survivor'), 'utf8')).toBe('old');
});

it('refuses a B-valid declared artifact that no actual transcript references', async () => {
    const product = await nativeProduct();
    if (product.manifest.schemaVersion !== 2) throw new Error('fixture');
    const artifact = product.manifest.entries.find(entry => entry.path.endsWith('/' + product.raw.segment))!;
    const inventory = product.manifest.nativeState.entries.find(entry => entry.path === artifact.path)!;
    const path = artifact.path.replace(product.raw.segment, 'extra.txt');
    await writeFile(join(product.root, path), product.raw.artifact, { mode: 0o600 });
    product.manifest.entries.push({ ...artifact, path });
    product.manifest.nativeState.entries.push({ ...inventory, path });
    product.manifest.areas[0].entryCount++;
    parseManagedCheckpointManifest(serializeManagedCheckpointManifest(product.manifest));
    await resealNativeTree(product);
    const input = await nativeInput(product);
    await expect(restoreManagedCheckpoint(input)).rejects.toMatchObject({ code: 'native-dependency-invalid' });
    expect(await readFile(join(input.destinations.get('provider-state')!, 'survivor'), 'utf8')).toBe('old');
});


it.each([undefined, '2'] as const)('refuses schema version %s instead of falling through to legacy restore', async schemaVersion => {
    const input = await nativeInput(await nativeProduct());
    Object.assign(input.manifest, { schemaVersion });
    await expect(restoreManagedCheckpoint(input)).rejects.toMatchObject({ code: 'native-manifest-invalid' });
    await expect(stat(input.stagingRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses v2 project members with no matching declared area instead of silently omitting their verification', async () => {
    const product = await nativeProduct();
    product.manifest.entries.push({ area: 'project', path: 'ignored.txt', type: 'file', bytes: 0, mode: 0o600, sha256: createHash('sha256').update('').digest('hex') });
    parseManagedCheckpointManifest(serializeManagedCheckpointManifest(product.manifest));
    const input = await nativeInput(product);
    await expect(restoreManagedCheckpoint(input)).rejects.toMatchObject({ code: 'native-manifest-invalid' });
    await expect(stat(input.stagingRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses non-directory project ancestry before an inline write can reach an outside sentinel', async () => {
 const product=await nativeProduct();
 const input=await nativeInput(product);
 const outside=join(input.stagingRoot,'outside');
 await mkdir(outside,{recursive:true});await writeFile(join(outside,'config'),'outside-original');
 const links=[['x','.'],['z','x/..'],['y','z/../outside']];
 const chunks:Buffer[]=[];
 for(const [path,linkpath] of links){const h=new tar.Header({path,linkpath,type:'SymbolicLink',size:0,mode:0o777});h.encode();chunks.push(h.block!);}
 chunks.push(Buffer.alloc(1024));const archive=gzipSync(Buffer.concat(chunks));
 const object=join(await scratch(),'project-sealed');
 await sealCheckpointBuffer({plaintext:archive,destination:object,key,binding:{...tenant,checkpointId,area:'project'}});
 const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
 product.manifest.areas.unshift({area:'project',archiveSha256:createHash('sha256').update(archive).digest('hex'),archiveBytes:archive.length,entryCount:4});
 product.manifest.entries.unshift(...links.map(([path,linkTarget])=>({area:'project' as const,path,linkTarget,type:'symlink' as const,mode:0o777,bytes:Buffer.byteLength(linkTarget),sha256:sha(linkTarget)})),{area:'project',path:'y/config',type:'file',mode:0o600,bytes:5,inline:'owned',sha256:sha('owned')});
 // Legacy producer represents symlink bytes as the target byte length; tar header size is zero.
 for(const e of product.manifest.entries) if(e.type==='symlink')e.bytes=0;
 parseManagedCheckpointManifest(serializeManagedCheckpointManifest(product.manifest));
 const objects=new Map<import('./managedCheckpointScope').CheckpointArea,string>(input.objects);objects.set('project',object);
 const destinations=new Map<import('./managedCheckpointScope').CheckpointArea,string>(input.destinations);destinations.set('project',join(await scratch(),'project'));
 const refusal = await restoreManagedCheckpoint({...input,objects,destinations}).catch(error => error);
 expect(await readFile(join(outside,'config'),'utf8')).toBe('outside-original');
 expect(refusal).toMatchObject({ code: 'forbidden-content' });
 expect(await readdir(input.stagingRoot)).toEqual(['outside']);
});

it.each(['missing', 'file'] as const)('refuses %s project ancestry before staging, preserving inline/worktree destinations', async kind => {
    const { product, input, destination } = await nativeMixedWorktree();
    const path = '.git/worktrees';
    if (kind === 'missing') product.manifest.entries = product.manifest.entries.filter(entry => entry.area !== 'project' || entry.path !== path);
    else Object.assign(product.manifest.entries.find(entry => entry.area === 'project' && entry.path === path)!, { type: 'file', bytes: 0 });
    parseManagedCheckpointManifest(serializeManagedCheckpointManifest(product.manifest));
    await expect(restoreManagedCheckpoint(input)).rejects.toMatchObject({ code: 'forbidden-content' });
    expect(await readFile(join(destination, 'survivor'), 'utf8')).toBe('project-old');
    await expect(stat(input.stagingRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});
