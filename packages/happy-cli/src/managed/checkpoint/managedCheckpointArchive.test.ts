import { execFileSync } from 'node:child_process';
import { writeFileSync, chmodSync, unlinkSync, symlinkSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as tar from 'tar';

import { createManagedCheckpoint, type CheckpointAreaSource } from './managedCheckpointArchive';
import {
    parseManagedCheckpointManifest,
    serializeManagedCheckpointManifest,
} from './managedCheckpointManifest';
import { openCheckpointFile } from './managedCheckpointCrypto';

const created: string[] = [];

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mc-archive-'));
    created.push(dir);
    return dir;
}

async function openArchive(
    product: Awaited<ReturnType<typeof createManagedCheckpoint>>,
    area: 'project' | 'provider-state',
): Promise<Buffer> {
    const plain = join(await scratch(), 'archive.tar.gz');
    await openCheckpointFile({
        source: product.objects.get(area)!,
        destination: plain,
        key,
        binding: { tenantId: 'co_1', projectId: 'pr_1', checkpointId, area },
    });
    return readFile(plain);
}

afterEach(async () => {
    while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

const key = randomBytes(32);
const checkpointId = 'a'.repeat(64);

let outputSeq = 0;

async function checkpointInput(sources: { area: 'project' | 'provider-state'; root: string }[]) {
    return {
        outputDir: join(await scratch(), `out-${outputSeq += 1}`),
        checkpointId,
        tenant: { tenantId: 'co_1', projectId: 'pr_1' },
        volume: { volumeId: 'vol_1', deviceUuid: 'dev-1' },
        image: { imageVersion: 'managed-runtime@1.2.3' },
        sources,
        key,
        now: () => 1_700_000_000_000,
    };
}

describe('an area with nothing to archive', () => {
    /*
     * 실측에서 이것이 `stage-archive` 의 정체였습니다: provider-state 의 모든
     * 항목이 허용목록 밖이라 포함할 경로가 **0개**가 되고, tar 가
     * `TypeError: no paths specified to add to archive` 를 던집니다. `code` 가
     * 없는 TypeError 라 coordinator 는 `checkpoint-failed` 로밖에 말할 수 없었고,
     * 그 줄로는 아무도 무엇을 해야 할지 알 수 없었습니다.
     *
     * 빈 area 는 라이브러리 오류가 아니라 **이 runtime 이 대답해야 하는 사실**
     * 입니다: 담기로 한 area 에서 아무것도 담지 못했다는 것.
     */
    it('shouldRefuseWithACodeThatNamesTheAreaRatherThanThrowFromTheTarLibrary', async () => {
        const root = await scratch();
        // provider state 배치가 `sessions/` 가 아니면 전부 제외된다 — 실제 트리가
        // 그랬습니다(`.claude/projects/<slug>/<uuid>.jsonl`).
        await mkdir(join(root, '.claude', 'projects', '-workspace-project'), { recursive: true });
        await writeFile(join(root, '.claude', 'projects', '-workspace-project', 'x.jsonl'), '{}\n');

        await expect(createManagedCheckpoint({
            checkpointId: 'a'.repeat(64),
            tenant: { tenantId: 'user:7', projectId: 'pr_1' },
            volume: { volumeId: 'vol_1', deviceUuid: 'uuid-1' },
            image: { imageVersion: 'img@1' },
            sources: [{ area: 'provider-state', root }],
            key: randomBytes(32),
            outputDir: await scratch(),
            now: () => 1,
        })).rejects.toMatchObject({ code: 'area-empty-provider-state' });
    });
});

describe('createManagedCheckpoint', () => {
    it('shouldArchiveProjectFilesAndGitMetadataAndRecordWhatItLeftOut', async () => {
        const root = await scratch();
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/index.ts'), 'export const a = 1;\n');
        await mkdir(join(root, '.git'), { recursive: true });
        await writeFile(join(root, '.git/HEAD'), 'ref: refs/heads/main\n');
        await mkdir(join(root, 'node_modules/left-pad'), { recursive: true });
        await writeFile(join(root, 'node_modules/left-pad/index.js'), 'module.exports = 1;\n');
        await mkdir(join(root, '.ssh'), { recursive: true });
        await writeFile(join(root, '.ssh/id_rsa'), 'PRIVATE');

        const result = await createManagedCheckpoint(await checkpointInput([{ area: 'project', root }]));

        const paths = result.manifest.entries.map((entry) => entry.path).sort();
        expect(paths).toContain('src/index.ts');
        expect(paths).toContain('.git/HEAD');
        expect(paths.some((path) => path.startsWith('node_modules'))).toBe(false);
        expect(paths.some((path) => path.startsWith('.ssh'))).toBe(false);
        expect(result.manifest.excluded).toEqual(expect.arrayContaining([
            { area: 'project', path: 'node_modules', reason: 'regeneratable' },
            { area: 'project', path: '.ssh', reason: 'credential' },
        ]));
    });

    it('shouldProduceAnEncryptedArchiveThatExtractsBackToTheSameContent', async () => {
        const root = await scratch();
        await mkdir(join(root, 'a/b'), { recursive: true });
        await writeFile(join(root, 'a/b/file.txt'), 'contents\n');

        const result = await createManagedCheckpoint(await checkpointInput([{ area: 'project', root }]));
        const archive = await openArchive(result, 'project');

        const target = await scratch();
        await new Promise<void>((resolve, reject) => {
            const extract = tar.x({ cwd: target, strict: true, preservePaths: false });
            extract.on('end', resolve);
            extract.on('error', reject);
            extract.end(archive);
        });
        expect(await readFile(join(target, 'a/b/file.txt'), 'utf8')).toBe('contents\n');
    });

    it('shouldNotArchiveProviderCredentialsWithProviderState', async () => {
        const root = await scratch();
        await mkdir(join(root, 'sessions/s1'), { recursive: true });
        await writeFile(join(root, 'sessions/s1/rollout.jsonl'), '{}\n');
        await mkdir(join(root, 'sessions/other'), { recursive: true });
        await writeFile(join(root, 'sessions/other/rollout.jsonl'), 'someone else\n');
        await writeFile(join(root, 'auth.json'), '{"token":"secret"}');
        await writeFile(join(root, 'history.jsonl'), 'personal\n');

        const result = await createManagedCheckpoint({
            ...await checkpointInput([{ area: 'provider-state', root }]),
            providerStateSessions: ['s1'],
        });
        const archive = await openArchive(result, 'provider-state');

        expect(result.manifest.entries.map((entry) => entry.path)).toEqual(
            expect.arrayContaining(['sessions/s1/rollout.jsonl']),
        );
        expect(archive.includes(Buffer.from('secret'))).toBe(false);
        expect(archive.includes(Buffer.from('personal'))).toBe(false);
        expect(archive.includes(Buffer.from('someone else'))).toBe(false);
        expect(result.manifest.excluded).toEqual(expect.arrayContaining([
            { area: 'provider-state', path: 'auth.json', reason: 'credential' },
            { area: 'provider-state', path: 'history.jsonl', reason: 'personal-history' },
            { area: 'provider-state', path: 'sessions/other', reason: 'not-allowlisted' },
        ]));
        // The manifest has to survive being written down and read back, which
        // is where a reason the schema does not know about actually bites: the
        // producer builds it happily and the restore side refuses to parse it.
        expect(parseManagedCheckpointManifest(serializeManagedCheckpointManifest(result.manifest)))
            .toEqual(result.manifest);
    });

    it('shouldExcludeSymlinksLeavingTheAreaAndKeepInternalOnes', async () => {
        const root = await scratch();
        await mkdir(join(root, 'a'), { recursive: true });
        await writeFile(join(root, 'a/real.txt'), 'real\n');
        await symlink('../a/real.txt', join(root, 'a/inside.link'));
        await symlink('/etc/passwd', join(root, 'a/outside.link'));

        const result = await createManagedCheckpoint(await checkpointInput([{ area: 'project', root }]));
        const paths = result.manifest.entries.map((entry) => entry.path);
        expect(paths).toContain('a/inside.link');
        expect(paths).not.toContain('a/outside.link');
        expect(result.manifest.excluded).toEqual(expect.arrayContaining([
            { area: 'project', path: 'a/outside.link', reason: 'link-escape' },
        ]));
    });

    it('shouldCarryASanitizedGitConfigInTheManifestAndKeepTheTokenOutOfTheArchive', async () => {
        const root = await scratch();
        await mkdir(join(root, '.git'), { recursive: true });
        await writeFile(join(root, '.git/config'), [
            '[remote "origin"]',
            '\turl = https://oauth2:ghp_secret_token@github.com/acme/repo.git',
            '[http "https://github.com/"]',
            '\textraHeader = Authorization: Bearer ghp_secret_token',
        ].join('\n'));

        const result = await createManagedCheckpoint(await checkpointInput([{ area: 'project', root }]));
        const archive = await openArchive(result, 'project');
        const entry = result.manifest.entries.find((candidate) => candidate.path === '.git/config')!;

        expect(archive.includes(Buffer.from('ghp_secret_token'))).toBe(false);
        expect(entry.inline).toBeDefined();
        expect(entry.inline).not.toContain('ghp_secret_token');
        expect(entry.inline).toContain('url = https://github.com/acme/repo.git');
        expect(entry.sha256).toBe(createHash('sha256').update(entry.inline!).digest('hex'));
        expect(entry.bytes).toBe(Buffer.byteLength(entry.inline!));
        // Carried by the manifest, so it is not one of the archive's entries.
        expect(result.manifest.areas[0]!.entryCount)
            .toBe(result.manifest.entries.filter((candidate) => candidate.inline === undefined).length);
    });

    it('shouldRecordTheSha256OfEachArchivedFile', async () => {
        const root = await scratch();
        await writeFile(join(root, 'f.txt'), 'abc');
        const result = await createManagedCheckpoint(await checkpointInput([{ area: 'project', root }]));
        const entry = result.manifest.entries.find((candidate) => candidate.path === 'f.txt')!;
        expect(entry.sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
        expect(entry.bytes).toBe(3);
    });

    it('shouldBindTheManifestDigestToTheProducedCheckpoint', async () => {
        const root = await scratch();
        await writeFile(join(root, 'f.txt'), 'abc');
        const result = await createManagedCheckpoint(await checkpointInput([{ area: 'project', root }]));
        expect(result.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(result.manifest.tenant).toEqual({ tenantId: 'co_1', projectId: 'pr_1' });
        expect(result.manifest.image).toEqual({ imageVersion: 'managed-runtime@1.2.3' });
    });

    it('shouldNotStartArchivingBeforeTheSealedObjectPathIsClaimed', async () => {
        const root = await scratch();
        await writeFile(join(root, 'f.txt'), 'contents\n');
        const input = await checkpointInput([{ area: 'project', root }]);
        await mkdir(input.outputDir, { recursive: true });
        await writeFile(join(input.outputDir, 'project.tar.gz.enc'), 'someone else');

        await expect(createManagedCheckpoint(input)).rejects.toThrow();
        // Refused without producing anything, and the object that was there is
        // untouched.
        expect(await readFile(join(input.outputDir, 'project.tar.gz.enc'), 'utf8')).toBe('someone else');
    });

    it('shouldRejectAGenuineReadFailureWithoutLeavingASealedObjectBehind', async () => {
        const root = await scratch();
        await writeFile(join(root, 'readable.txt'), 'fine\n');
        const unreadable = join(root, 'locked.bin');
        await writeFile(unreadable, randomBytes(64 * 1024));
        await chmod(unreadable, 0o000);
        const input = await checkpointInput([{ area: 'project', root }]);

        try {
            // Not the size limit: a real I/O failure on the tree being read.
            await expect(createManagedCheckpoint(input)).rejects.toThrow();
        } finally {
            await chmod(unreadable, 0o600);
        }

        // Nothing half-sealed is left where a later publish would find it and
        // hand it to the store.
        await expect(stat(join(input.outputDir, 'project.tar.gz.enc'))).rejects.toThrow();
    });

    it('shouldFailClosedWhenAnAreaExceedsTheArchiveLimit', async () => {
        const root = await scratch();
        await writeFile(join(root, 'f.txt'), randomBytes(256 * 1024));
        await expect(createManagedCheckpoint({
            ...await checkpointInput([{ area: 'project', root }]),
            maxArchiveBytes: 1024,
        })).rejects.toThrow('managed checkpoint archive is too large');
    });

    it('shouldRefuseAnAreaRootThatIsMissing', async () => {
        const root = await scratch();
        await expect(createManagedCheckpoint(await checkpointInput([{ area: 'project', root: join(root, 'nope') }])))
            .rejects.toThrow('managed checkpoint area root is unusable');
    });

    it('shouldRefuseAnAreaRootReachedThroughASymlink', async () => {
        const root = await scratch();
        await mkdir(join(root, 'real'), { recursive: true });
        await symlink(join(root, 'real'), join(root, 'link'));
        await expect(createManagedCheckpoint(await checkpointInput([{ area: 'project', root: join(root, 'link') }])))
            .rejects.toThrow('managed checkpoint area root is unusable');
    });

    it('shouldNotReadAnOversizedOrIrregularWorktreePointerWhole', async () => {
        const root = await scratch();
        await mkdir(join(root, '.git/worktrees/huge'), { recursive: true });
        // Far larger than a path, and read before the walk's size cap applies.
        await writeFile(join(root, '.git/worktrees/huge/gitdir'), Buffer.alloc(8 * 1024 * 1024, 0x41));
        await mkdir(join(root, '.git/worktrees/weird'), { recursive: true });
        await mkdir(join(root, '.git/worktrees/weird/gitdir'), { recursive: true });

        const result = await createManagedCheckpoint(await checkpointInput([{ area: 'project', root }]));

        expect(result.manifest.worktrees).toEqual([]);
        expect(result.manifest.excluded).toEqual(expect.arrayContaining([
            { area: 'project', path: '.git/worktrees/huge', reason: 'worktree-out-of-scope' },
            { area: 'project', path: '.git/worktrees/weird', reason: 'worktree-out-of-scope' },
        ]));
        expect(result.manifest.entries.some((entry) => entry.path.startsWith('.git/worktrees/'))).toBe(false);
    });

    it('shouldNotBlockOnAWorktreePointerThatIsNotARegularFile', async () => {
        const root = await scratch();
        await mkdir(join(root, '.git/worktrees/fifo'), { recursive: true });
        // A reader that opens this without O_NONBLOCK, or reads it whole,
        // waits for a writer that never comes — the checkpoint hangs instead
        // of refusing a pointer that cannot be one.
        execFileSync('mkfifo', [join(root, '.git/worktrees/fifo/gitdir')]);

        const result = await createManagedCheckpoint(await checkpointInput([{ area: 'project', root }]));

        expect(result.manifest.worktrees).toEqual([]);
        expect(result.manifest.excluded).toEqual(expect.arrayContaining([
            { area: 'project', path: '.git/worktrees/fifo', reason: 'worktree-out-of-scope' },
        ]));
    }, 10_000);
});

describe('the bytes a collector said it read', () => {
    /*
     * The archive already proves its manifest describes the bytes it sealed. What
     * it could not say is that those are the bytes some **other** reader — the
     * collector, whose buffers the derivation reasoned over — actually read. Collect
     * A, seal B, and both halves stay internally consistent.
     *
     * This binds the two, for `provider-state` regular files only.
     */
    const NATIVE = 'd6da1867-afd5-4637-bd7e-52a3e28c2fb8';
    const TRANSCRIPT = `.claude/projects/-workspace-project/${NATIVE}.jsonl`;
    const CONTENT = '{"row":1}\n';

    async function providerRoot(): Promise<string> {
        const root = await scratch();
        await mkdir(join(root, 'sessions', 'sess-live'), { recursive: true });
        await writeFile(join(root, 'sessions/sess-live/rollout.jsonl'), CONTENT);
        return root;
    }

    function digestOf(content: string): string {
        return createHash('sha256').update(content).digest('hex');
    }

    /** The one provider-state file today's rules admit. */
    const CARRIED = 'sessions/sess-live/rollout.jsonl';

    async function archive(over: {
        collectedProviderState?: readonly { path: string; bytes: number; sha256: string }[];
        sources?: { area: 'project' | 'provider-state'; root: string }[];
        outputDir?: string;
    }) {
        const base = await checkpointInput(over.sources ?? [
            { area: 'provider-state', root: await providerRoot() },
        ]);
        return createManagedCheckpoint({
            ...base,
            ...(over.outputDir ? { outputDir: over.outputDir } : {}),
            providerStateSessions: ['sess-live'],
            ...(over.collectedProviderState === undefined
                ? {}
                : { collectedProviderState: over.collectedProviderState }),
        });
    }

    it('shouldArchiveUnchangedWhenNoOneClaimsToHaveReadAnything', async () => {
        // The field absent is not an empty claim: today's behaviour, exactly.
        const result = await archive({});
        expect(result.manifest.entries.some((entry) => entry.path === CARRIED)).toBe(true);
    });

    it('shouldAcceptAClaimThatMatchesTheSealedBytes', async () => {
        const result = await archive({
            collectedProviderState: [
                { path: CARRIED, bytes: Buffer.byteLength(CONTENT), sha256: digestOf(CONTENT) },
            ],
        });
        const entry = result.manifest.entries.find((candidate) => candidate.path === CARRIED)!;
        expect(entry.sha256).toBe(digestOf(CONTENT));
    });

    it('shouldRefuseADigestThatIsNotTheSealedDigest', async () => {
        await expect(archive({
            collectedProviderState: [
                { path: CARRIED, bytes: Buffer.byteLength(CONTENT), sha256: digestOf('something else') },
            ],
        })).rejects.toMatchObject({ code: 'collected-bytes-mismatch' });
    });

    it('shouldRefuseASizeThatIsNotTheSealedSizeEvenWhenTheDigestAgrees', async () => {
        await expect(archive({
            collectedProviderState: [
                { path: CARRIED, bytes: Buffer.byteLength(CONTENT) + 1, sha256: digestOf(CONTENT) },
            ],
        })).rejects.toMatchObject({ code: 'collected-bytes-mismatch' });
    });

    it('shouldRefuseAPathTheArchiveDidNotCarry', async () => {
        await expect(archive({
            collectedProviderState: [
                { path: CARRIED, bytes: Buffer.byteLength(CONTENT), sha256: digestOf(CONTENT) },
                { path: 'sessions/sess-live/missing.jsonl', bytes: 1, sha256: digestOf('x') },
            ],
        })).rejects.toMatchObject({ code: 'collected-bytes-missing' });
    });

    it('shouldRefuseAProviderStateFileNobodyListed', async () => {
        const root = await providerRoot();
        await writeFile(join(root, 'sessions/sess-live/extra.jsonl'), 'x\n');
        await expect(archive({
            sources: [{ area: 'provider-state', root }],
            collectedProviderState: [
                { path: CARRIED, bytes: Buffer.byteLength(CONTENT), sha256: digestOf(CONTENT) },
            ],
        })).rejects.toMatchObject({ code: 'collected-bytes-unlisted' });
    });

    it('shouldRefuseAnExplicitlyEmptyClaimWhenProviderStateFilesWereCarried', async () => {
        // `[]` says the collection was empty. A carried file contradicts it.
        await expect(archive({ collectedProviderState: [] }))
            .rejects.toMatchObject({ code: 'collected-bytes-unlisted' });
    });

    it('shouldNotTreatAnEmptyClaimWithNoProviderStateAreaAsProofOfAnything', async () => {
        const root = await scratch();
        await writeFile(join(root, 'f.txt'), 'contents\n');
        const result = await archive({
            sources: [{ area: 'project', root }],
            collectedProviderState: [],
        });
        expect(result.manifest.areas.map((area) => area.area)).toEqual(['project']);
    });

    it('shouldRefuseANonEmptyClaimWithNoProviderStateSourceBeforeReadingAnything', async () => {
        /*
         * The comparison lives in the per-area loop, so without an answer here the
         * loop never runs and a claim about files goes unchecked. It is answered
         * beside the input validation, before any filesystem work: the output
         * directory is not created and the project root is never read.
         */
        const project = await scratch();
        await writeFile(join(project, 'f.txt'), 'contents\n');
        await chmod(project, 0o000);
        const outputDir = join(await scratch(), 'never-created');
        try {
            await expect(archive({
                outputDir,
                sources: [{ area: 'project', root: project }],
                collectedProviderState: [{ path: CARRIED, bytes: 1, sha256: digestOf('x') }],
            })).rejects.toMatchObject({ code: 'collected-bytes-missing' });
        } finally {
            await chmod(project, 0o700);
        }
        // Unreadable and never read: the refusal came before any of it.
        await expect(stat(outputDir)).rejects.toThrow();
    });

    it('shouldNotBeChangedByACallerThatEditsItsListWhileTheArchiveRuns', async () => {
        /*
         * The caller keeps its array and an archive spans many awaits. A list that
         * could be swapped after validation is a list that was checked and then not
         * used, so what is compared is a copy taken before the first await.
         */
        const digest = digestOf(CONTENT);
        const mutable = [{ path: CARRIED, bytes: Buffer.byteLength(CONTENT), sha256: digest }];
        const base = await checkpointInput([{ area: 'provider-state', root: await providerRoot() }]);
        const running = createManagedCheckpoint({
            ...base,
            providerStateSessions: ['sess-live'],
            collectedProviderState: mutable,
        });
        // Swapped the moment the call is under way.
        mutable[0]!.sha256 = digestOf('something else');
        mutable.length = 0;

        const result = await running;
        expect(result.manifest.entries.find((entry) => entry.path === CARRIED)?.sha256).toBe(digest);
    });

    describe('a caller that edits its own source list while the archive runs', () => {
        /*
         * Astra's probe, and the two edits beside it. `sources` is the caller's
         * array and the preflight is one `await` away from the loop: emptying it
         * afterwards produced an **empty manifest as a success** while a non-empty
         * claim went unchecked, and editing an element's `area` or `root` would
         * redirect what was admitted just as quietly.
         */
        async function providerSource() {
            const root = await providerRoot();
            return { area: 'provider-state' as const, root };
        }

        function claim() {
            return [{ path: CARRIED, bytes: Buffer.byteLength(CONTENT), sha256: digestOf(CONTENT) }];
        }

        it('shouldStillBindWhenTheSourceIsRemovedAfterThePreflight', async () => {
            const sources: CheckpointAreaSource[] = [await providerSource()];
            const base = await checkpointInput(sources);
            const running = createManagedCheckpoint({
                ...base,
                providerStateSessions: ['sess-live'],
                collectedProviderState: claim(),
            });
            sources.length = 0;

            const result = await running;
            // The area was archived from the snapshot, and the claim was checked
            // against it — not skipped into an empty success.
            expect(result.manifest.areas.map((area) => area.area)).toEqual(['provider-state']);
            expect(result.manifest.entries.some((entry) => entry.path === CARRIED)).toBe(true);
        });

        it('shouldNotBeRedirectedByAnEditToASourceObject', async () => {
            const other = await scratch();
            await writeFile(join(other, 'elsewhere.txt'), 'different\n');
            const sources: CheckpointAreaSource[] = [await providerSource()];
            const base = await checkpointInput(sources);
            const running = createManagedCheckpoint({
                ...base,
                providerStateSessions: ['sess-live'],
                collectedProviderState: claim(),
            });
            // The same object, pointed somewhere else, in the same tick.
            sources[0]!.root = other;
            sources[0]!.area = 'project';

            const result = await running;
            expect(result.manifest.areas.map((area) => area.area)).toEqual(['provider-state']);
            expect(result.manifest.entries.some((entry) => entry.path === CARRIED)).toBe(true);
        });

        it('shouldNotArchiveASourceTheCallerAddedAfterTheCallBegan', async () => {
            const extra = await scratch();
            await writeFile(join(extra, 'late.txt'), 'late\n');
            const sources: CheckpointAreaSource[] = [await providerSource()];
            const base = await checkpointInput(sources);
            const running = createManagedCheckpoint({
                ...base,
                providerStateSessions: ['sess-live'],
                collectedProviderState: claim(),
            });
            sources.push({ area: 'project' as const, root: extra });

            const result = await running;
            expect(result.manifest.areas.map((area) => area.area)).toEqual(['provider-state']);
        });

        it('shouldLeaveTheCallersOwnArrayAlone', async () => {
            const source = await providerSource();
            const sources = [source];
            const base = await checkpointInput(sources);
            await createManagedCheckpoint({
                ...base,
                providerStateSessions: ['sess-live'],
                collectedProviderState: claim(),
            });
            // Snapshotting is not moving: the caller keeps exactly what it passed.
            expect(sources).toHaveLength(1);
            expect(sources[0]).toBe(source);
            expect(sources[0]).toEqual({ area: 'provider-state', root: source.root });
        });
    });

    it('shouldRefuseANonEmptyClaimWhenNoProviderStateAreaWasArchived', async () => {
        /*
         * The comparison lives in the per-area loop, so without this the loop
         * simply never runs and a claim about files goes unchecked.
         */
        const root = await scratch();
        await writeFile(join(root, 'f.txt'), 'contents\n');
        await expect(archive({
            sources: [{ area: 'project', root }],
            collectedProviderState: [{ path: CARRIED, bytes: 1, sha256: digestOf('x') }],
        })).rejects.toMatchObject({ code: 'collected-bytes-missing' });
    });

    it('shouldNotCompareAProjectEntryThatSharesAListedPath', async () => {
        const project = await scratch();
        await mkdir(join(project, 'sessions/sess-live'), { recursive: true });
        // The same spelling in the project area, with different bytes.
        await writeFile(join(project, 'sessions/sess-live/rollout.jsonl'), 'different\n');
        const result = await archive({
            sources: [
                { area: 'project', root: project },
                { area: 'provider-state', root: await providerRoot() },
            ],
            collectedProviderState: [
                { path: CARRIED, bytes: Buffer.byteLength(CONTENT), sha256: digestOf(CONTENT) },
            ],
        });
        // Both carried, and only the provider-state one was bound.
        expect(result.manifest.entries.filter((entry) => entry.path === CARRIED)).toHaveLength(2);
    });

    it('shouldRefuseAListedPathWhoseSealedEntryIsADirectory', async () => {
        await expect(archive({
            collectedProviderState: [
                { path: CARRIED, bytes: Buffer.byteLength(CONTENT), sha256: digestOf(CONTENT) },
                { path: 'sessions/sess-live', bytes: 0, sha256: digestOf('') },
            ],
        })).rejects.toMatchObject({ code: 'collected-entry-not-a-file' });
    });

    describe('input the collector would never have produced', () => {
        it.each([
            ['the same path twice, identically', [
                { path: CARRIED, bytes: 10, sha256: digestOf(CONTENT) },
                { path: CARRIED, bytes: 10, sha256: digestOf(CONTENT) },
            ], 'collected-input-duplicate'],
            ['a digest that is not 64 hex', [{ path: CARRIED, bytes: 10, sha256: 'nope' }], 'collected-input-invalid'],
            ['a negative size', [{ path: CARRIED, bytes: -1, sha256: digestOf(CONTENT) }], 'collected-input-invalid'],
            ['a fractional size', [{ path: CARRIED, bytes: 1.5, sha256: digestOf(CONTENT) }], 'collected-input-invalid'],
            ['an empty path', [{ path: '', bytes: 1, sha256: digestOf(CONTENT) }], 'collected-input-invalid'],
            ['an unsafe path', [{ path: '../escape', bytes: 1, sha256: digestOf(CONTENT) }], 'collected-input-invalid'],
        ])('shouldRefuse %s', async (_name, collectedProviderState, code) => {
            await expect(archive({ collectedProviderState })).rejects.toMatchObject({ code });
        });

        it('shouldRefuseBeforeItTouchesTheFilesystem', async () => {
            // A malformed claim must not cost a walk or an output directory.
            const outputDir = join(await scratch(), 'never-created');
            await expect(archive({
                outputDir,
                collectedProviderState: [{ path: CARRIED, bytes: 1, sha256: 'nope' }],
            })).rejects.toMatchObject({ code: 'collected-input-invalid' });
            await expect(stat(outputDir)).rejects.toThrow();
        });

        it('shouldAcceptARealClaudePathAsInput', async () => {
            /*
             * The path check is the safe-relative-path rule, not the scope's
             * `include` verdict: today that verdict excludes every real Claude
             * path, so consulting it would refuse every honest claim.
             */
            await expect(archive({
                collectedProviderState: [
                    { path: CARRIED, bytes: Buffer.byteLength(CONTENT), sha256: digestOf(CONTENT) },
                    { path: TRANSCRIPT, bytes: 1, sha256: digestOf('x') },
                ],
            })).rejects.toMatchObject({ code: 'collected-bytes-missing' });
        });
    });

    describe('what a refusal leaves behind', () => {
        it('shouldRemoveTheArchivesItSealedInThisCallAndNothingElse', async () => {
            const outputDir = join(await scratch(), 'out');
            await mkdir(outputDir, { recursive: true });
            const bystander = join(outputDir, 'someone-elses.txt');
            await writeFile(bystander, 'not mine');

            const project = await scratch();
            await writeFile(join(project, 'f.txt'), 'contents\n');
            await expect(archive({
                outputDir,
                sources: [
                    { area: 'project', root: project },
                    { area: 'provider-state', root: await providerRoot() },
                ],
                collectedProviderState: [
                    { path: CARRIED, bytes: Buffer.byteLength(CONTENT), sha256: digestOf('other') },
                ],
            })).rejects.toMatchObject({ code: 'collected-bytes-mismatch' });

            // The project archive sealed before the refusal is gone...
            await expect(stat(join(outputDir, 'project.tar.gz.enc'))).rejects.toThrow();
            await expect(stat(join(outputDir, 'provider-state.tar.gz.enc'))).rejects.toThrow();
            // ...and a file this call never created is untouched.
            expect(await readFile(bystander, 'utf8')).toBe('not mine');
        });

        it('shouldLeaveASealerFailureToItsOwnErrorAndItsOwnCleanup', async () => {
            const outputDir = join(await scratch(), 'out');
            await mkdir(outputDir, { recursive: true });
            const claimed = join(outputDir, 'provider-state.tar.gz.enc');
            await writeFile(claimed, 'someone else');

            await expect(archive({
                outputDir,
                collectedProviderState: [
                    { path: CARRIED, bytes: Buffer.byteLength(CONTENT), sha256: digestOf(CONTENT) },
                ],
            })).rejects.toThrow();
            // Not deleted by this increment: it was never ours.
            expect(await readFile(claimed, 'utf8')).toBe('someone else');
        });
    });
});

const NATIVE_C_ID = 'd6da1867-afd5-4637-bd7e-52a3e28c2fb8';
const NATIVE_C_HOME = '/workspace/.codex';
const NATIVE_C_PROJECT = '.claude/projects/-workspace-project';
function nativeOptions() {
    return {
        scope: {
            version: 1 as const, provider: 'claude' as const, capability: 'native-resume' as const,
            generation: { projectId: 'pr_1', workspaceId: 'ws-1', runtimeId: 'rt-1', epoch: 2, provisioningOperationId: 'op-1' },
            sources: [{ attemptId: 'attempt-1', runId: 'run-1', happySessionId: 'happy-1', runtimeId: 'rt-1', epoch: 1, currentNativeId: NATIVE_C_ID, retainedNativeIds: [] as string[], metadataVersion: 1 }],
        },
        providerUid: 10601,
        limits: { maxTranscriptBytes: 65536, maxMetaBytes: 8192, maxArtifactBytes: 1048576, maxAggregateBytes: 4194304, maxEntries: 64, maxRecords: 128 },
        window: { stillProven: () => true },
    };
}

it.each(['missing', 'duplicate', 'noncanonical', 'foreign-project', 'legacy-options', 'false-window', 'throwing-window'] as const)
('refuses native %s before creating output or inspecting provider paths', async kind => {
    const input = { ...await checkpointInput([{ area: 'provider-state', root: NATIVE_C_HOME }]), nativeProviderState: nativeOptions() };
    if (kind === 'missing') input.sources = [];
    if (kind === 'duplicate') input.sources.push({ ...input.sources[0] });
    if (kind === 'noncanonical') input.sources[0].root = '/other';
    if (kind === 'foreign-project') input.nativeProviderState.scope.generation.projectId = 'foreign';
    if (kind === 'false-window') input.nativeProviderState.window.stillProven = () => false;
    if (kind === 'throwing-window') input.nativeProviderState.window.stillProven = () => { throw new Error('/private/secret'); };
    const request = kind === 'legacy-options' ? { ...input, providerStateSessions: [] } : input;
    await expect(createManagedCheckpoint(request)).rejects.toMatchObject({ code: kind.endsWith('window') ? 'native-window-not-proven' : 'native-input-invalid' });
    await expect(stat(input.outputDir)).rejects.toMatchObject({ code: 'ENOENT' });
});

// Canonical paths remain product policy. Only these test filesystem calls map to a disposable host tree.
const nativeFs = vi.hoisted(() => ({ home: '', touches: [] as string[], fds: new Set<number>(), failRm: '', ancestorRefused: false, handles: 0, foreignLeaf: '', failLstat: '' }));
vi.mock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const mapped = (path: string): string => nativeFs.home && (path === '/workspace/.codex' || path.startsWith('/workspace/.codex/'))
        ? nativeFs.home + path.slice('/workspace/.codex'.length) : path;
    return { ...actual,
        lstatSync: (path: string) => { const real = mapped(path); if (real !== path) nativeFs.touches.push(`lstat:${path}`); const result = actual.lstatSync(real); if (real !== path) result.uid = 10601; return result; },
        opendirSync: (path: string) => { const real = mapped(path); if (real !== path) nativeFs.touches.push(`opendir:${path}`); return actual.opendirSync(real); },
        openSync: (path: string, flags: number) => { const real = mapped(path); const fd = actual.openSync(real, flags); if (real !== path) { nativeFs.touches.push(`open:${path}`); nativeFs.fds.add(fd); } return fd; },
        fstatSync: (fd: number) => { const value = actual.fstatSync(fd); if (nativeFs.fds.has(fd)) value.uid = 10601; return value; },
        closeSync: (fd: number) => { nativeFs.fds.delete(fd); return actual.closeSync(fd); },
    };
});
vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const mapped = (path: string): string => nativeFs.home && (path === '/workspace/.codex' || path.startsWith('/workspace/.codex/'))
        ? nativeFs.home + path.slice('/workspace/.codex'.length) : path;
    return { ...actual,
        lstat: async (path: string) => { if (path === nativeFs.failLstat) throw new Error('/private/metadata-secret'); const real = mapped(path); if (real !== path) nativeFs.touches.push(`lstat-async:${path}`); const result = await actual.lstat(real); if (real !== path) result.uid = path === nativeFs.foreignLeaf ? 10602 : 10601; return result; },
        opendir: async (path: string) => {
            const real = mapped(path); if (real !== path) nativeFs.touches.push(`opendir-async:${path}`);
            const handle = await actual.opendir(real); nativeFs.handles++;
            return { read: () => handle.read(), close: async () => { try { await handle.close(); } finally { nativeFs.handles--; } } };
        },
        rm: async (path: string, options: Parameters<typeof actual.rm>[1]) => { if (path === nativeFs.failRm) throw new Error('/private/cleanup-secret'); return actual.rm(path, options); },
    };
});
vi.mock('tar', async () => {
    const actual = await vi.importActual<typeof import('tar')>('tar');
    return { ...actual, c: (options: tar.TarOptionsWithAliasesAsyncNoFile, paths: string[]) => actual.c({
        ...options, cwd: nativeFs.home && options.cwd === '/workspace/.codex' ? nativeFs.home : options.cwd,
    }, paths) };
});
vi.mock('@/daemon/managedRuntimeIdentity', async () => {
    const actual = await vi.importActual<typeof import('@/daemon/managedRuntimeIdentity')>('@/daemon/managedRuntimeIdentity');
    return { ...actual, trustedPathRefusal: (...args: Parameters<typeof actual.trustedPathRefusal>) => {
        if (nativeFs.home && args[0] === '/workspace') {
            nativeFs.touches.push('trusted-ancestors');
            return nativeFs.ancestorRefused ? { code: 'state-dir-unsafe', detail: 'fixture' } : null;
        }
        return actual.trustedPathRefusal(...args);
    } };
});

afterEach(() => { nativeFs.home = ''; nativeFs.touches = []; nativeFs.fds.clear(); nativeFs.failRm = ''; nativeFs.ancestorRefused = false; nativeFs.foreignLeaf = ''; nativeFs.failLstat = ''; });

async function nativeTree() {
    const home = await scratch();
    await mkdir(join(home, NATIVE_C_PROJECT), { recursive: true, mode: 0o755 });
    await writeFile(join(home, NATIVE_C_PROJECT, `${NATIVE_C_ID}.jsonl`), JSON.stringify({
        type: 'user', sessionId: NATIVE_C_ID, uuid: 'u1', message: { role: 'user', content: 'hello' },
    }) + '\n', { mode: 0o644 });
    nativeFs.home = home;
    return home;
}

it('collects actual transcript bytes and produces a strict native v2 without invented directories', async () => {
    await nativeTree();
    const input = { ...await checkpointInput([{ area: 'provider-state', root: NATIVE_C_HOME }]), nativeProviderState: nativeOptions() };
    const product = await createManagedCheckpoint(input);
    expect(product.manifest.schemaVersion).toBe(2);
    expect(product.manifest.entries).toHaveLength(4);
    expect(product.manifest.entries.every(entry => entry.mode < 0o10000)).toBe(true);
    expect(parseManagedCheckpointManifest(serializeManagedCheckpointManifest(product.manifest))).toEqual(product.manifest);
    expect((await openArchive(product, 'provider-state')).length).toBeGreaterThan(0);
    expect(nativeFs.fds.size).toBe(0);
    expect(nativeFs.touches.filter(value => value === 'trusted-ancestors')).toHaveLength(2);
});

it('prunes credentials and foreign slugs before either collector or archive touches their paths', async () => {
    const home = await nativeTree();
    await mkdir(join(home, NATIVE_C_PROJECT, '.ssh'), { recursive: true });
    await writeFile(join(home, NATIVE_C_PROJECT, '.ssh', 'secret'), 'secret');
    await symlink('/absent/private', join(home, '.claude', 'settings.json'));
    await symlink('/absent/private', join(home, '.claude', 'projects', 'foreign-slug'));
    const input = { ...await checkpointInput([{ area: 'provider-state', root: NATIVE_C_HOME }]), nativeProviderState: nativeOptions() };
    const product = await createManagedCheckpoint(input);
    expect(product.manifest.schemaVersion).toBe(2);
    expect(nativeFs.touches.filter(value => /settings\.json|foreign-slug|\.ssh/.test(value))).toEqual([]);
});

it('keeps native identity, scope, sources, limits and window function owned across the first await', async () => {
    await nativeTree();
    const input = { ...await checkpointInput([{ area: 'provider-state', root: NATIVE_C_HOME }]), nativeProviderState: nativeOptions() };
    const output = input.outputDir;
    const pending = createManagedCheckpoint(input);
    input.sources[0].area = 'project'; input.sources[0].root = '/private/foreign'; input.sources.length = 0;
    input.nativeProviderState.scope.generation.projectId = 'foreign';
    input.nativeProviderState.scope.sources[0].currentNativeId = '00000000-0000-4000-8000-000000000000';
    input.nativeProviderState.limits.maxEntries = 1;
    input.nativeProviderState.window.stillProven = () => false;
    input.tenant.projectId = 'foreign'; input.volume.volumeId = 'foreign'; input.image.imageVersion = 'foreign';
    input.checkpointId = 'f'.repeat(64); input.outputDir = '/private/foreign-output';
    const product = await pending;
    expect(product.manifest.tenant.projectId).toBe('pr_1');
    expect(product.manifest.volume.volumeId).toBe('vol_1');
    expect(product.manifest.checkpointId).toBe(checkpointId);
    expect(product.objects.get('provider-state')).toBe(join(output, 'provider-state.tar.gz.enc'));
    expect((await openArchive(product, 'provider-state')).length).toBeGreaterThan(0);
    expect(input.tenant.projectId).toBe('foreign');
});

it.each(['unknown', 'symlink', 'mode', 'same-size-content', 'dirent-budget', 'ancestor'] as const)
('refuses post-collection %s and closes native handles without touching excluded content', async kind => {
    const home = await nativeTree();
    const input = { ...await checkpointInput([{ area: 'provider-state', root: NATIVE_C_HOME }]), nativeProviderState: nativeOptions() };
    const pending = createManagedCheckpoint(input);
    const transcript = join(home, NATIVE_C_PROJECT, `${NATIVE_C_ID}.jsonl`);
    if (kind === 'unknown') writeFileSync(join(home, NATIVE_C_PROJECT, 'unknown.bin'), 'x');
    if (kind === 'symlink') { unlinkSync(transcript); symlinkSync('/private/no-read', transcript); }
    if (kind === 'mode') chmodSync(transcript, 0o666);
    if (kind === 'same-size-content') writeFileSync(transcript, JSON.stringify({ type: 'user', sessionId: NATIVE_C_ID, uuid: 'u1', message: { role: 'user', content: 'HELLO' } }) + '\n');
    if (kind === 'dirent-budget') for (let i = 0; i < 70; i++) writeFileSync(join(home, `excluded-${i}`), 'x');
    if (kind === 'ancestor') nativeFs.ancestorRefused = true;
    await expect(pending).rejects.toMatchObject({ code: kind === 'same-size-content' ? 'sealed-mismatch-provider-state' : 'native-walk-refused' });
    expect(nativeFs.handles).toBe(0);
    expect(nativeFs.fds.size).toBe(0);
    expect(nativeFs.touches.some(value => value.includes('unknown.bin') || value.includes('excluded-'))).toBe(false);
    await expect(stat(join(input.outputDir, 'provider-state.tar.gz.enc'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('removes completed project output on later native refusal while preserving a preexisting provider object', async () => {
    await nativeTree();
    const project = await scratch(); await writeFile(join(project, 'keep.txt'), 'project');
    const input = { ...await checkpointInput([{ area: 'project', root: project }, { area: 'provider-state', root: NATIVE_C_HOME }]), nativeProviderState: nativeOptions() };
    await mkdir(input.outputDir); const survivor = join(input.outputDir, 'provider-state.tar.gz.enc');
    await writeFile(survivor, 'preexisting');
    await expect(createManagedCheckpoint(input)).rejects.toMatchObject({ code: 'native-output-failed' });
    expect(await readFile(survivor, 'utf8')).toBe('preexisting');
    await expect(stat(join(input.outputDir, 'project.tar.gz.enc'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['window', 'schema', 'cleanup'] as const)('closes final %s failures and reports completed-output cleanup uncertainty', async kind => {
    await nativeTree();
    let live = true;
    const input = { ...await checkpointInput([{ area: 'provider-state', root: NATIVE_C_HOME }]), nativeProviderState: nativeOptions() };
    input.nativeProviderState.window.stillProven = () => live;
    const owned = join(input.outputDir, 'provider-state.tar.gz.enc');
    input.now = () => {
        if (kind === 'schema') return NaN;
        if (kind === 'cleanup') nativeFs.failRm = owned;
        live = false;
        return 1;
    };
    const error = await createManagedCheckpoint(input).catch(value => value);
    expect(error.code).toBe(kind === 'schema' ? 'native-manifest-invalid' : kind === 'cleanup' ? 'native-cleanup-failed' : 'native-window-lost');
    expect(JSON.stringify(error)).not.toContain('/private/cleanup-secret');
    if (kind === 'cleanup') {
        expect(error.priorCode).toBe('native-window-lost');
        expect((await stat(owned)).isFile()).toBe(true);
        nativeFs.failRm = '';
    } else await expect(stat(owned)).rejects.toMatchObject({ code: 'ENOENT' });
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

async function nativeRichTree() {
    const home = await nativeTree();
    const raw = nativeRawFixture();
    const session = join(home, NATIVE_C_PROJECT, NATIVE_C_ID);
    await mkdir(join(session, 'subagents'), { recursive: true });
    await mkdir(join(session, 'tool-results'), { recursive: true });
    const files = {
        parent: join(home, NATIVE_C_PROJECT, `${NATIVE_C_ID}.jsonl`),
        child: join(session, 'subagents', `agent-${raw.agentId}.jsonl`),
        meta: join(session, 'subagents', `agent-${raw.agentId}.meta.json`),
        artifact: join(session, 'tool-results', raw.segment),
    };
    for (const kind of ['parent', 'child', 'meta', 'artifact'] as const) await writeFile(files[kind], raw[kind]);
    return { home, raw, files };
}

it('derives raw child/meta/artifact state with every shared current/retained association', async () => {
    const { home } = await nativeRichTree();
    const input = { ...await checkpointInput([{ area: 'provider-state', root: NATIVE_C_HOME }]), nativeProviderState: nativeOptions() };
    const other = '11111111-1111-4111-8111-111111111111';
    await writeFile(join(home, NATIVE_C_PROJECT, `${other}.jsonl`), JSON.stringify({ type: 'user', sessionId: other, uuid: 'u2', message: { role: 'user', content: 'other' } }) + '\n');
    input.nativeProviderState.scope.sources.push({ ...input.nativeProviderState.scope.sources[0], attemptId: 'attempt-2', currentNativeId: other, retainedNativeIds: [NATIVE_C_ID] });
    const product = await createManagedCheckpoint(input);
    expect(product.manifest.schemaVersion).toBe(2);
    if (product.manifest.schemaVersion !== 2) throw new Error('v2 expected');
    expect(product.manifest.nativeState.entries.find(entry => entry.kind === 'artifact')!.requiredBy).toEqual([
        { attemptId: 'attempt-1', nativeId: NATIVE_C_ID, role: 'current' },
        { attemptId: 'attempt-2', nativeId: NATIVE_C_ID, role: 'retained' },
    ]);
    expect(product.manifest.nativeState.entries.filter(entry => entry.kind === 'subagent-records' || entry.kind === 'subagent-meta')).toHaveLength(2);
    expect(parseManagedCheckpointManifest(serializeManagedCheckpointManifest(product.manifest))).toEqual(product.manifest);
    expect(nativeFs.fds.size).toBe(0);
});

it.each(['parent', 'child', 'meta', 'artifact'] as const)('binds original %s derivation bytes to the actual sealed tar', async kind => {
    const { files, raw } = await nativeRichTree();
    const input = { ...await checkpointInput([{ area: 'provider-state', root: NATIVE_C_HOME }]), nativeProviderState: nativeOptions() };
    const pending = createManagedCheckpoint(input);
    writeFileSync(files[kind], 'X' + raw[kind].slice(1));
    await expect(pending).rejects.toMatchObject({ code: 'sealed-mismatch-provider-state' });
    await expect(stat(join(input.outputDir, 'provider-state.tar.gz.enc'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['false', 'throw'] as const)('reports window loss inside the actual collector as native-window-lost (%s)', async behavior => {
    await nativeTree();
    const input = { ...await checkpointInput([{ area: 'provider-state', root: NATIVE_C_HOME }]), nativeProviderState: nativeOptions() };
    let calls = 0;
    input.nativeProviderState.window.stillProven = () => {
        if (++calls === 1) return true;
        if (behavior === 'throw') throw new Error('/private/window-secret');
        return false;
    };
    await expect(createManagedCheckpoint(input)).rejects.toMatchObject({ code: 'native-window-lost' });
    await expect(stat(input.outputDir)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('attempts every completed native-operation cleanup even when the first owned removal fails', async () => {
    await nativeTree();
    const project = await scratch(); await writeFile(join(project, 'keep.txt'), 'project');
    const input = { ...await checkpointInput([{ area: 'project', root: project }, { area: 'provider-state', root: NATIVE_C_HOME }]), nativeProviderState: nativeOptions() };
    let live = true; input.nativeProviderState.window.stillProven = () => live;
    const first = join(input.outputDir, 'project.tar.gz.enc');
    input.now = () => { nativeFs.failRm = first; live = false; return 1; };
    await expect(createManagedCheckpoint(input)).rejects.toMatchObject({ code: 'native-cleanup-failed', priorCode: 'native-window-lost' });
    expect((await stat(first)).isFile()).toBe(true);
    await expect(stat(join(input.outputDir, 'provider-state.tar.gz.enc'))).rejects.toMatchObject({ code: 'ENOENT' });
    nativeFs.failRm = '';
});

it.each(['uid', 'filesystem-error'] as const)('closes native archive %s after collection without leaking metadata paths', async kind => {
    await nativeTree();
    const input = { ...await checkpointInput([{ area: 'provider-state', root: NATIVE_C_HOME }]), nativeProviderState: nativeOptions() };
    const pending = createManagedCheckpoint(input);
    const leaf = `${NATIVE_C_HOME}/${NATIVE_C_PROJECT}/${NATIVE_C_ID}.jsonl`;
    if (kind === 'uid') nativeFs.foreignLeaf = leaf;
    else nativeFs.failLstat = leaf;
    const error = await pending.catch(value => value);
    expect(error.code).toBe('native-walk-refused');
    expect(error.message).not.toContain('/private/metadata-secret');
    expect(nativeFs.handles).toBe(0);
});
