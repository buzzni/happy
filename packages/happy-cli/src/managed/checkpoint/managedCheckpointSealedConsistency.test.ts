/**
 * What the manifest claims has to be what the archive actually contains.
 *
 * `walkArea` lstat+digests every carried file, and then — later, when the sealer
 * pulls — `tar` opens the same paths **again**. Nothing used to sit between those
 * two reads. A file written in that window produced a manifest describing bytes
 * the sealed archive does not hold, and the first place that could notice was
 * restore's per-entry digest compare: after the pointer had been published and
 * the checkpoint advertised as usable.
 *
 * Comparing the source file before and after would only prove the file was
 * stable — an inference about a window. These tests require the stronger thing:
 * the entries are verified against the bytes that actually went into the tar.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as tar from 'tar';

import { createManagedCheckpoint } from './managedCheckpointArchive';
import { openCheckpointFile } from './managedCheckpointCrypto';
import { createCheckpointDrain } from './managedCheckpointDrain';
import { publishManagedCheckpoint } from './managedCheckpointPublisher';

const created: string[] = [];
const key = randomBytes(32);
const checkpointId = 'a'.repeat(64);
const tenant = { tenantId: 'co_1', projectId: 'pr_1' };
const volume = { volumeId: 'vol_1', deviceUuid: 'dev-1' };

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mc-sealed-'));
    created.push(dir);
    return dir;
}

afterEach(async () => {
    while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

/**
 * A tree whose last carried path is still unopened when the mutation lands.
 *
 * Eight 4MB files rather than one 32MB file, because `tar.c` runs four entry
 * jobs at a time: with a single big file ahead of it the target was opened and
 * read within the first batch, and the mutation — though it landed long before
 * the archive finished — changed nothing that tar had yet to read. The bytes are
 * random so gzip cannot collapse the window either.
 */
const AHEAD_OF_TARGET = 8;

async function slowProjectRoot(): Promise<{ root: string; late: string }> {
    const root = await scratch();
    for (let index = 0; index < AHEAD_OF_TARGET; index += 1) {
        await writeFile(join(root, `a-big-${index}.bin`), randomBytes(4 * 1024 * 1024));
    }
    const late = join(root, 'z-late.txt');
    await writeFile(late, 'original-content\n');
    return { root, late };
}

/**
 * The seam is production behaviour, not a test hook: `sealCheckpointStream`
 * claims the destination with `open(…, 'wx')` **before** anything pulls the tar
 * stream, so the sealed path appearing means the walk is over and the archive is
 * only now being read.
 */
async function whenSealingStarts(sealedPath: string): Promise<void> {
    for (let attempt = 0; attempt < 2000; attempt += 1) {
        try {
            await stat(sealedPath);
            return;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 2));
        }
    }
    throw new Error('the sealer never claimed its destination');
}

async function afterWalk(outputDir: string, change: () => Promise<void>): Promise<void> {
    await whenSealingStarts(join(outputDir, 'project.tar.gz.enc'));
    await change();
}

async function mutateAfterWalk(outputDir: string, late: string): Promise<void> {
    await whenSealingStarts(join(outputDir, 'project.tar.gz.enc'));
    /*
     * Same length as the walked content, different bytes: a size check alone
     * would not see this.
     *
     * Swapped by `rename`, not rewritten in place. `writeFile` truncates first,
     * and a `tar` read landing in that window fails with tar's own `EOF` —
     * a different defect, and a racy one. The rename makes the file change
     * atomically, so what is being tested is a manifest that disagrees with a
     * *successfully* produced archive.
     */
    const replacement = `${late}.next`;
    await writeFile(replacement, 'MUTATED-content!\n');
    await rename(replacement, late);
}

function input(sources: { area: 'project' | 'provider-state'; root: string }[], outputDir: string) {
    return {
        outputDir,
        checkpointId,
        tenant,
        volume,
        image: { imageVersion: 'img@1' },
        sources,
        key,
        now: () => 1_700_000_000_000,
    };
}

describe('a carried file written between the walk and the tar read', () => {
    it('shouldRefuseTheAreaRatherThanSealAnArchiveTheManifestDoesNotDescribe', async () => {
        const { root, late } = await slowProjectRoot();
        const outputDir = join(await scratch(), 'out');

        const producing = createManagedCheckpoint(input([{ area: 'project', root }], outputDir));
        const mutating = mutateAfterWalk(outputDir, late);

        await expect(producing).rejects.toMatchObject({ code: 'sealed-mismatch-project' });
        await mutating;

        // Nothing half-sealed is left where a later publish would find it.
        await expect(stat(join(outputDir, 'project.tar.gz.enc'))).rejects.toThrow();
    }, 120_000);

    it('shouldStopThePublisherBeforeItsFirstUpload', async () => {
        const { root, late } = await slowProjectRoot();
        const workDir = join(await scratch(), 'work');
        const puts: string[] = [];
        // Only the pointer read is answered: the publisher reads `latest.json`
        // before it archives, so a store that refuses everything would stop at
        // `pointer-unreadable` and prove nothing about uploads.
        const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
            const method = init?.method ?? 'GET';
            if (method === 'PUT') {
                puts.push(String(url));
                return new Response(null, { status: 200, headers: { etag: '"e"' } });
            }
            return new Response(null, { status: 404 });
        }) as unknown as typeof globalThis.fetch;

        const publishing = publishManagedCheckpoint({
            checkpointId, tenant, volume, image: { imageVersion: 'img@1' },
            sources: [{ area: 'project', root }],
            key,
            workDir,
            drain: createCheckpointDrain(),
            drainBudgetMs: 10_000,
            flushDeps: { run: async () => ({ code: 0, stdout: '0|0|0' }) } as never,
            targets: {
                objects: new Map([['project' as const, {
                    putUrl: 'https://store.invalid/project.enc',
                    headUrl: 'https://store.invalid/project.enc',
                }]]),
                manifest: {
                    putUrl: 'https://store.invalid/manifest.enc',
                    headUrl: 'https://store.invalid/manifest.enc',
                },
                pointer: {
                    putUrl: 'https://store.invalid/latest.json',
                    getUrl: 'https://store.invalid/latest.json',
                },
            },
            now: () => 1_700_000_000_000,
            fetchImpl,
        });
        const mutating = mutateAfterWalk(workDir, late);

        await expect(publishing).rejects.toThrow();
        await mutating;
        expect(puts).toEqual([]);
    }, 120_000);
});

describe('a carried file chmod-ed between the walk and the tar read', () => {
    /*
     * Restore refuses on mode as well as on bytes (`entry-mismatch` covers
     * both), so an archive whose every byte agrees with the manifest and whose
     * mode does not is still an unrestorable checkpoint. Bytes alone are not the
     * whole claim.
     */
    it('shouldRefuseEvenThoughEveryByteStillAgrees', async () => {
        const { root, late } = await slowProjectRoot();
        const outputDir = join(await scratch(), 'out');

        const producing = createManagedCheckpoint(input([{ area: 'project', root }], outputDir));
        const changing = afterWalk(outputDir, () => chmod(late, 0o400));

        await expect(producing).rejects.toMatchObject({ code: 'sealed-mismatch-project' });
        await changing;
        expect(await readFile(late, 'utf8')).toBe('original-content\n');
    }, 120_000);
});

describe('a source that fails while the parser is still mid-stream', () => {
    /*
     * The verification must not become a second thing that can hang: the parser
     * is fed from inside the generator, so an archive abandoned mid-stream has
     * to end it on the way out. The size limit is a real mid-stream throw — it
     * fires after chunks have already been written to the parser.
     */
    it('shouldStillRejectWithTheOriginalFailureAndLeaveNothingSealed', async () => {
        const { root } = await slowProjectRoot();
        const outputDir = join(await scratch(), 'out');

        await expect(createManagedCheckpoint({
            ...input([{ area: 'project', root }], outputDir),
            maxArchiveBytes: 64 * 1024,
        })).rejects.toThrow('managed checkpoint archive is too large');

        await expect(stat(join(outputDir, 'project.tar.gz.enc'))).rejects.toThrow();
    }, 30_000);
});

describe('an unmutated tree', () => {
    it('shouldStillArchiveAndVerifyBothAreas', async () => {
        const project = await scratch();
        await mkdir(join(project, 'src'), { recursive: true });
        await writeFile(join(project, 'src/index.ts'), 'export const a = 1;\n');
        // A synthetic `sessions/<id>/…` shape, which is what the current scope
        // rule allows. This says nothing about whether the production provider
        // writes that layout today — it does not.
        const provider = await scratch();
        await mkdir(join(provider, 'sessions', 'sess-1'), { recursive: true });
        await writeFile(join(provider, 'sessions', 'sess-1', 'rollout.jsonl'), '{"k":1}\n');

        const outputDir = join(await scratch(), 'out');
        const product = await createManagedCheckpoint({
            ...input([
                { area: 'project', root: project },
                { area: 'provider-state', root: provider },
            ], outputDir),
            providerStateSessions: ['sess-1'],
        });

        expect([...product.objects.keys()].sort()).toEqual(['project', 'provider-state']);
        // And the sealed bytes really are the manifest's bytes.
        for (const area of ['project', 'provider-state'] as const) {
            const plain = join(await scratch(), `${area}.tar.gz`);
            await openCheckpointFile({
                source: product.objects.get(area)!,
                destination: plain,
                key,
                binding: { tenantId: tenant.tenantId, projectId: tenant.projectId, checkpointId, area },
            });
            const digests = new Map<string, string>();
            const parser = new tar.Parser({
                strict: true,
                onReadEntry: (entry) => {
                    const hash = createHash('sha256');
                    entry.on('data', (chunk: Buffer) => hash.update(chunk));
                    entry.on('end', () => {
                        digests.set(String(entry.path).replace(/\/$/, ''), hash.digest('hex'));
                    });
                    entry.resume();
                },
            });
            const sealed = await readFile(plain);
            await new Promise<void>((resolve, reject) => {
                parser.on('error', reject);
                parser.end(sealed, () => resolve());
            });
            for (const entry of product.manifest.entries.filter((e) => e.area === area && e.type === 'file' && e.inline === undefined)) {
                expect(digests.get(entry.path)).toBe(entry.sha256);
            }
        }
    }, 60_000);
});
