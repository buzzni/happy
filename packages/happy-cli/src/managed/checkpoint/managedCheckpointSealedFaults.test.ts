/**
 * Two ways the sealed-bytes check went wrong, both found by Astra against the
 * first increment.
 *
 * 1. `tar.c` de-duplicates by inode: the second path pointing at one inode is
 *    written as a `Link` header with no body. The validator saw a type it did
 *    not know and a digest of nothing, and refused an archive that was perfectly
 *    good — Astra's control extracted it and every entry matched the manifest.
 *    An ordinary project tree with a hardlink could never be checkpointed.
 * 2. A malformed gzip stream makes the parser emit `Z_DATA_ERROR` and never
 *    complete. `parser.end(cb)` was the only thing that settled the wait, so
 *    creation hung for ever with the sealed object still on disk: a worse
 *    outcome than the mismatch it was meant to catch.
 */
import { createHash, randomBytes } from 'node:crypto';
import { link, mkdtemp, mkdir, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as tar from 'tar';

import { createManagedCheckpoint } from './managedCheckpointArchive';
import { openCheckpointFile } from './managedCheckpointCrypto';

const created: string[] = [];
const key = randomBytes(32);
const checkpointId = 'a'.repeat(64);
const tenant = { tenantId: 'co_1', projectId: 'pr_1' };

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mc-faults-'));
    created.push(dir);
    return dir;
}

afterEach(async () => {
    vi.doUnmock('tar');
    vi.resetModules();
    while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

function input(root: string, outputDir: string) {
    return {
        outputDir,
        checkpointId,
        tenant,
        volume: { volumeId: 'vol_1', deviceUuid: 'dev-1' },
        image: { imageVersion: 'img@1' },
        sources: [{ area: 'project' as const, root }],
        key,
        now: () => 1_700_000_000_000,
    };
}

describe('a project tree containing a hardlink', () => {
    it('shouldArchiveItAndStillHoldEveryManifestEntryAfterExtraction', async () => {
        const root = await scratch();
        await writeFile(join(root, 'a'), 'shared-bytes\n');
        // `tar.c` writes this one as `Link -> a`, with no body of its own.
        await link(join(root, 'a'), join(root, 'b'));
        const outputDir = join(await scratch(), 'out');

        const product = await createManagedCheckpoint(input(root, outputDir));

        const both = product.manifest.entries.filter((entry) => entry.path === 'a' || entry.path === 'b');
        expect(both.map((entry) => entry.type)).toEqual(['file', 'file']);
        expect(new Set(both.map((entry) => entry.sha256)).size).toBe(1);

        // Astra's control, run here: what comes back out is what the manifest
        // says, hardlink and all.
        const plain = join(await scratch(), 'project.tar.gz');
        await openCheckpointFile({
            source: product.objects.get('project')!,
            destination: plain,
            key,
            binding: { ...tenant, checkpointId, area: 'project' },
        });
        const target = await scratch();
        await tar.x({ file: plain, cwd: target, preserveOwner: false });
        for (const entry of both) {
            const bytes = await readFile(join(target, entry.path));
            expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
            expect(bytes.length).toBe(entry.bytes);
        }
    }, 30_000);

    it('shouldWriteEachHardlinkedPathAsItsOwnFileRatherThanALinkHeader', async () => {
        /*
         * The producer, not the verifier, is where this is settled: a `linkCache`
         * that remembers nothing makes every carried path a full `File` header, so
         * the archive holds what the manifest says it holds and the comparison
         * needs no `Link` grammar. Teaching it one would give a single set of bytes
         * a second identity to verify.
         */
        const root = await scratch();
        await writeFile(join(root, 'a'), 'shared-bytes\n');
        await link(join(root, 'a'), join(root, 'b'));
        const outputDir = join(await scratch(), 'out');

        const product = await createManagedCheckpoint(input(root, outputDir));
        const plain = join(await scratch(), 'project.tar.gz');
        await openCheckpointFile({
            source: product.objects.get('project')!,
            destination: plain,
            key,
            binding: { ...tenant, checkpointId, area: 'project' },
        });

        const headers: string[] = [];
        const parser = new tar.Parser({
            strict: true,
            onReadEntry: (entry) => {
                headers.push(`${String(entry.path)}|${String(entry.type)}|${entry.size}`);
                entry.resume();
            },
        });
        const sealed = await readFile(plain);
        await new Promise<void>((resolve, reject) => {
            parser.on('error', reject);
            parser.end(sealed, () => resolve());
        });
        expect(headers.sort()).toEqual(['a|File|13', 'b|File|13']);
    }, 30_000);
});

describe('a tar stream that cannot be parsed', () => {
    it('shouldRefuseAndCleanUpRatherThanWaitForACompletionThatNeverComes', async () => {
        const root = await scratch();
        await writeFile(join(root, 'file.txt'), 'unchanged');
        const outputDir = join(await scratch(), 'out');

        vi.resetModules();
        const actual = await vi.importActual<typeof import('tar')>('tar');
        vi.doMock('tar', () => ({
            ...actual,
            // A gzip header followed by rubbish: the parser reports
            // `Z_DATA_ERROR` and never reaches an end of stream.
            c: () => Readable.from([Buffer.from([31, 139, 8, 0, 0, 0, 0, 0, 0, 3, 255, 255, 255, 255])]),
        }));
        const { createManagedCheckpoint: create } = await import('./managedCheckpointArchive');

        await expect(create(input(root, outputDir)))
            .rejects.toMatchObject({ code: 'sealed-mismatch-project' });
        await expect(stat(join(outputDir, 'project.tar.gz.enc'))).rejects.toThrow();
    }, 15_000);

    it('shouldDoTheSameForAStreamOfRubbishWithNoGzipHeaderAtAll', async () => {
        const root = await scratch();
        await mkdir(join(root, 'dir'), { recursive: true });
        await writeFile(join(root, 'dir/file.txt'), 'unchanged');
        const outputDir = join(await scratch(), 'out');

        vi.resetModules();
        const actual = await vi.importActual<typeof import('tar')>('tar');
        vi.doMock('tar', () => ({ ...actual, c: () => Readable.from([Buffer.alloc(2048, 88)]) }));
        const { createManagedCheckpoint: create } = await import('./managedCheckpointArchive');

        await expect(create(input(root, outputDir)))
            .rejects.toMatchObject({ code: 'sealed-mismatch-project' });
        await expect(stat(join(outputDir, 'project.tar.gz.enc'))).rejects.toThrow();
    }, 15_000);
});

describe('a tar stream whose completion never comes on its own', () => {
    /*
     * Both of these were found by Fable against the first fix: the failure is
     * raised at `parser.end()` rather than mid-stream, so waiting on the end
     * callback alone hung **after** the sealer had finished, with the sealed
     * object on disk. Neither is a reachable input — the stream is produced in
     * process by `tar.c` — they are robustness of the check itself.
     *
     * Measured on the installed tar (7.5.7): every one of these emits `'error'`
     * (`Z_BUF_ERROR` for the truncation, `Z_DATA_ERROR` for the garbage), which
     * is what settles the wait. Absence of a synchronous end callback is *not*
     * treated as failure — a healthy archive delivered slowly still completes,
     * which the next test holds in place.
     */
    async function validArchiveBytes(root: string): Promise<Buffer> {
        const chunks: Buffer[] = [];
        for await (const chunk of tar.c(
            { cwd: root, gzip: true, portable: false, noDirRecurse: true, follow: false },
            ['file.txt'],
        )) {
            chunks.push(Buffer.from(chunk as Buffer));
        }
        return Buffer.concat(chunks);
    }

    async function refuseInjected(
        shape: (whole: Buffer) => Buffer[],
    ): Promise<void> {
        const root = await scratch();
        await writeFile(join(root, 'file.txt'), 'unchanged');
        const outputDir = join(await scratch(), 'out');
        const whole = await validArchiveBytes(root);

        vi.resetModules();
        const actual = await vi.importActual<typeof import('tar')>('tar');
        vi.doMock('tar', () => ({ ...actual, c: () => Readable.from(shape(whole)) }));
        const { createManagedCheckpoint: create } = await import('./managedCheckpointArchive');

        await expect(create(input(root, outputDir)))
            .rejects.toMatchObject({ code: 'sealed-mismatch-project' });
        await expect(stat(join(outputDir, 'project.tar.gz.enc'))).rejects.toThrow();
    }

    it('shouldRefuseAStreamTruncatedBeforeItsGzipTrailer', async () => {
        await refuseInjected((whole) => [whole.subarray(0, whole.length - 12)]);
    }, 15_000);

    it('shouldRefuseAValidStreamFollowedByTrailingGarbage', async () => {
        await refuseInjected((whole) => [Buffer.concat([whole, Buffer.alloc(64, 7)])]);
    }, 15_000);

    it('shouldStillAcceptAHealthyArchiveThatArrivesSlowlyAndInPieces', async () => {
        /*
         * The guard against reading "no terminal state yet" as a failure: this
         * archive is valid and its completion is not synchronous with the last
         * write, and it must still be produced.
         */
        const root = await scratch();
        await writeFile(join(root, 'file.txt'), 'unchanged');
        const outputDir = join(await scratch(), 'out');
        const whole = await validArchiveBytes(root);

        vi.resetModules();
        const actual = await vi.importActual<typeof import('tar')>('tar');
        vi.doMock('tar', () => ({
            ...actual,
            c: () => Readable.from((async function* () {
                for (let at = 0; at < whole.length; at += 7) {
                    await new Promise((resolve) => setTimeout(resolve, 1));
                    yield whole.subarray(at, at + 7);
                }
            })()),
        }));
        const { createManagedCheckpoint: create } = await import('./managedCheckpointArchive');

        const product = await create(input(root, outputDir));
        expect(product.manifest.entries.map((entry) => entry.path)).toEqual(['file.txt']);
    }, 30_000);

    it('shouldNotLeaveAnUnhandledRejectionBehindOnAnyOfThoseFailures', async () => {
        const seen: unknown[] = [];
        const record = (reason: unknown): void => { seen.push(reason); };
        process.on('unhandledRejection', record);
        try {
            await refuseInjected((whole) => [whole.subarray(0, whole.length - 12)]);
            await refuseInjected((whole) => [Buffer.concat([whole, Buffer.alloc(64, 7)])]);
            await refuseInjected(() => [Buffer.from([31, 139, 8, 0, 0, 0, 0, 0, 0, 3, 255, 255, 255, 255])]);
            // Rejections are reported a turn after they happen.
            await new Promise((resolve) => setTimeout(resolve, 50));
        } finally {
            process.off('unhandledRejection', record);
        }
        expect(seen).toEqual([]);
    }, 60_000);
});

describe('the parser lifecycle at the seams the API actually offers', () => {
    /*
     * Astra's lifecycle probe, as tests. Each case replaces `tar.Parser` with a
     * subclass that intervenes at one real seam — `write` throwing, `write`
     * refusing and then failing or draining, `end`'s completion callback being
     * held — because that is where the settle logic can be wrong without any
     * fixture stream showing it.
     *
     * The held-completion case is the one my delayed-input test could not see:
     * feeding a valid archive slowly still ends synchronously with the last
     * write, so an "it has not completed yet, call it failed" branch passed. Held
     * here, Astra's probe reported `returnedBeforeEndRelease: true` against that
     * branch — creation had already returned while completion was still pending.
     */
    type Seam = 'sync-write-throw' | 'backpressure-error' | 'backpressure-drain' | 'held-completion';

    async function withSeam(seam: Seam): Promise<{
        create: (root: string, outputDir: string) => Promise<unknown>;
        parser: () => { listenerCount(event: string): number };
        held: () => boolean;
        release: () => void;
    }> {
        vi.resetModules();
        const actual = await vi.importActual<typeof import('tar')>('tar');
        let instance: { listenerCount(event: string): number } | undefined;
        let release: (() => void) | undefined;
        let held = false;
        let first = true;
        class Seamed extends actual.Parser {
            constructor(options: ConstructorParameters<typeof actual.Parser>[0]) {
                super(options);
                instance = this as unknown as { listenerCount(event: string): number };
            }
            write(chunk: never, ...rest: never[]): boolean {
                if (seam === 'sync-write-throw' && first) {
                    first = false;
                    throw new Error('synthetic synchronous parser failure');
                }
                const accepted = super.write(chunk, ...rest);
                if (seam === 'backpressure-drain' && first) {
                    first = false;
                    queueMicrotask(() => this.emit('drain'));
                    return false;
                }
                if (seam === 'backpressure-error' && first) {
                    first = false;
                    queueMicrotask(() => this.emit('error', new Error('synthetic backpressure failure')));
                    return false;
                }
                return accepted;
            }
            end(...args: never[]): this {
                if (seam === 'held-completion') {
                    return super.end(...args.map((argument) => (
                        typeof argument === 'function'
                            ? ((() => { held = true; release = argument as () => void; }) as never)
                            : argument
                    )) as never[]);
                }
                return super.end(...args);
            }
        }
        vi.doMock('tar', () => ({ ...actual, Parser: Seamed }));
        const { createManagedCheckpoint: create } = await import('./managedCheckpointArchive');
        return {
            create: (root, outputDir) => create(input(root, outputDir)),
            parser: () => instance!,
            held: () => held,
            release: () => release!(),
        };
    }

    async function fixture(): Promise<{ root: string; outputDir: string }> {
        const root = await scratch();
        await writeFile(join(root, 'file'), 'valid unchanged content');
        return { root, outputDir: join(await scratch(), 'out') };
    }

    it('shouldStayPendingWhileTheEndCallbackIsHeldAndThenSucceedOnRelease', async () => {
        const seam = await withSeam('held-completion');
        const { root, outputDir } = await fixture();

        let settled = false;
        const producing = seam.create(root, outputDir).then(
            (product) => { settled = true; return product; },
            (error) => { settled = true; throw error; },
        );

        for (let attempt = 0; attempt < 200 && !seam.held(); attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 2));
        }
        expect(seam.held()).toBe(true);
        // Several turns with the completion withheld: nothing may have returned.
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(settled).toBe(false);

        seam.release();
        await expect(producing).resolves.toMatchObject({ manifest: { entries: expect.anything() } });
        expect(seam.parser().listenerCount('drain')).toBe(0);
    }, 30_000);

    it('shouldRefuseAndCleanUpWhenTheParserWriteThrowsSynchronously', async () => {
        const seam = await withSeam('sync-write-throw');
        const { root, outputDir } = await fixture();

        await expect(seam.create(root, outputDir)).rejects.toMatchObject({ code: 'sealed-mismatch-project' });
        await expect(stat(join(outputDir, 'project.tar.gz.enc'))).rejects.toThrow();
    }, 30_000);

    it('shouldRefuseAndLeaveNoDrainListenerWhenBackpressureIsFollowedByAFailure', async () => {
        const seam = await withSeam('backpressure-error');
        const { root, outputDir } = await fixture();

        await expect(seam.create(root, outputDir)).rejects.toMatchObject({ code: 'sealed-mismatch-project' });
        await expect(stat(join(outputDir, 'project.tar.gz.enc'))).rejects.toThrow();
        // The abandoned drain wait does not stay subscribed.
        expect(seam.parser().listenerCount('drain')).toBe(0);
    }, 30_000);

    it('shouldCarryOnAndLeaveNoDrainListenerWhenBackpressureIsFollowedByADrain', async () => {
        const seam = await withSeam('backpressure-drain');
        const { root, outputDir } = await fixture();

        await expect(seam.create(root, outputDir)).resolves.toMatchObject({
            manifest: { entries: expect.anything() },
        });
        expect(await stat(join(outputDir, 'project.tar.gz.enc'))).toBeTruthy();
        expect(seam.parser().listenerCount('drain')).toBe(0);
    }, 30_000);
});

describe('a symlink beside a hardlink', () => {
    it('shouldKeepBothShapesThroughTheArchive', async () => {
        const root = await scratch();
        await writeFile(join(root, 'file.txt'), 'unchanged');
        await link(join(root, 'file.txt'), join(root, 'hard'));
        const { symlink } = await import('node:fs/promises');
        await symlink('file.txt', join(root, 'soft'));
        const outputDir = join(await scratch(), 'out');

        const product = await createManagedCheckpoint(input(root, outputDir));

        const plain = join(await scratch(), 'project.tar.gz');
        await openCheckpointFile({
            source: product.objects.get('project')!,
            destination: plain,
            key,
            binding: { ...tenant, checkpointId, area: 'project' },
        });
        const target = await scratch();
        await tar.x({ file: plain, cwd: target, preserveOwner: false });
        expect(await readFile(join(target, 'hard'), 'utf8')).toBe('unchanged');
        expect(await readlink(join(target, 'soft'))).toBe('file.txt');
    }, 30_000);
});
