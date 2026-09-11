import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createCheckpointDrain } from './managedCheckpointDrain';
import { publishManagedCheckpoint, ManagedCheckpointPublishError } from './managedCheckpointPublisher';

const created: string[] = [];
const key = randomBytes(32);
const checkpointId = 'a'.repeat(64);
const tenant = { tenantId: 'co_1', projectId: 'pr_1' };
const volume = { volumeId: 'vol_1', deviceUuid: 'dev-1' };

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mc-publish-'));
    created.push(dir);
    return dir;
}

afterEach(async () => {
    while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

/** An object store just real enough to observe order and preconditions. */
function fakeStore() {
    const objects = new Map<string, Buffer>();
    const etags = new Map<string, string>();
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const raw = String(url);
        const method = init?.method ?? 'GET';
        // Stands in for SigV4's method binding: a URL minted for one method is
        // rejected for another, exactly as a real signed URL is.
        const signedFor = /[?&]m=([A-Z]+)/.exec(raw);
        if (signedFor && signedFor[1] !== method) return new Response(null, { status: 403 });
        const key = raw.replace(/\?m=[A-Z]+$/, '');
        calls.push(`${method} ${key}`);
        if (method === 'PUT') {
            const headers = (init?.headers ?? {}) as Record<string, string>;
            const existing = objects.get(key);
            if (headers['if-none-match'] === '*' && existing) return new Response(null, { status: 412 });
            if (headers['if-match'] && headers['if-match'] !== `"${etags.get(key)}"`) {
                return new Response(null, { status: 412 });
            }
            const chunks: Buffer[] = [];
            const body = init?.body;
            if (typeof body === 'string') chunks.push(Buffer.from(body));
            else if (body) for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
                chunks.push(Buffer.from(chunk));
            }
            const stored = Buffer.concat(chunks);
            objects.set(key, stored);
            const etag = createHash('md5').update(stored).digest('hex');
            etags.set(key, etag);
            return new Response(null, { status: 200, headers: { etag: `"${etag}"` } });
        }
        const stored = objects.get(key);
        if (!stored) return new Response(null, { status: 404 });
        if (method === 'HEAD') {
            return new Response(null, {
                status: 200,
                headers: { 'content-length': String(stored.length), etag: `"${etags.get(key)}"` },
            });
        }
        return new Response(stored, { status: 200, headers: { etag: `"${etags.get(key)}"` } });
    };
    return { objects, etags, calls, fetchImpl: fetchImpl as unknown as typeof globalThis.fetch };
}

async function projectRoot(): Promise<string> {
    const root = await scratch();
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/index.ts'), 'export const a = 1;\n');
    return root;
}

// A signed URL authorises one method, so the upload and the verification are
// different URLs — as they are against a private bucket.
const targets = {
    objects: new Map([['project' as const, {
        putUrl: 'https://store.invalid/project.enc?m=PUT',
        headUrl: 'https://store.invalid/project.enc?m=HEAD',
    }]]),
    manifest: {
        putUrl: 'https://store.invalid/manifest.enc?m=PUT',
        headUrl: 'https://store.invalid/manifest.enc?m=HEAD',
    },
    pointer: { putUrl: 'https://store.invalid/latest.json', getUrl: 'https://store.invalid/latest.json' },
};

async function publish(overrides: Record<string, unknown> = {}) {
    const store = (overrides.store as ReturnType<typeof fakeStore>) ?? fakeStore();
    const result = await publishManagedCheckpoint({
        checkpointId, tenant, volume, image: { imageVersion: 'img@1' },
        sources: [{ area: 'project', root: (overrides.root as string) ?? await projectRoot() }],
        key,
        workDir: join(await scratch(), 'work'),
        drain: (overrides.drain as ReturnType<typeof createCheckpointDrain>) ?? createCheckpointDrain(),
        drainBudgetMs: 1000,
        flushDeps: (overrides.flushDeps as never) ?? { run: async () => ({ code: 0, stdout: '0|0|0' }) },
        targets,
        now: () => 1_700_000_000_000,
        fetchImpl: store.fetchImpl,
        ...(overrides.publish as object ?? {}),
    });
    return { result, store };
}

describe('provider state has to be covered, or nothing is published', () => {
    /*
     * A live runtime archived `provider-state` and the allowlist let **nothing**
     * through: the tree is `.claude/projects/<slug>/<uuid>.jsonl`, not
     * `sessions/<id>/…`, and the boot passed no session list either. The archive
     * would have been produced, uploaded and pointed at — a checkpoint that
     * reports `saved` and restores none of the run's native state.
     *
     * A failure gets retried. An **empty success** is found at restore time, by
     * whoever needed it.
     */
    async function providerStateSources(overrides: { sessions?: readonly string[] } = {}) {
        const providerRoot = await scratch();
        await mkdir(join(providerRoot, 'sessions', 'sess-live'), { recursive: true });
        await writeFile(join(providerRoot, 'sessions', 'sess-live', 'rollout.jsonl'), '{}\n');
        const provider = {
            putUrl: 'https://store.invalid/provider.enc?m=PUT',
            headUrl: 'https://store.invalid/provider.enc?m=HEAD',
        };
        return {
            publish: {
                sources: [
                    { area: 'project' as const, root: await projectRoot() },
                    { area: 'provider-state' as const, root: providerRoot },
                ],
                ...(overrides.sessions ? { providerStateSessions: overrides.sessions } : {}),
                targets: {
                    ...targets,
                    objects: new Map([...targets.objects, ['provider-state' as const, provider]]),
                },
            },
        };
    }

    it('shouldRefuseWhenNothingSaysWhichSessionsTheArchiveMustCover', async () => {
        const { store } = { store: fakeStore() };
        await expect(publish({ store, ...await providerStateSources() }))
            .rejects.toMatchObject({ code: 'provider-state-identity-unobserved' });
        // 업로드 전에 멈춘다 — store 에 아무것도 남지 않는다.
        expect(store.calls.filter((call) => call.startsWith('PUT'))).toEqual([]);
    });

    it('shouldRefuseWhenTheSessionDirectoryIsThereButEmpty', async () => {
        /*
         * root 가 재현한 결함: `sessions/<id>` **디렉터리**만 있으면 커버리지를
         * 만족한 것으로 세고 pointer 까지 나갔다. 디렉터리는 그 세션의 상태가
         * 아니다 — 상태가 있었을 자리일 뿐이고, 복원하면 아무것도 없다.
         */
        const providerRoot = await scratch();
        await mkdir(join(providerRoot, 'sessions', 'sess-live'), { recursive: true });
        const provider = {
            putUrl: 'https://store.invalid/provider.enc?m=PUT',
            headUrl: 'https://store.invalid/provider.enc?m=HEAD',
        };
        const store = fakeStore();
        await expect(publish({
            store,
            publish: {
                sources: [
                    { area: 'project' as const, root: await projectRoot() },
                    { area: 'provider-state' as const, root: providerRoot },
                ],
                providerStateSessions: ['sess-live'],
                targets: {
                    ...targets,
                    objects: new Map([...targets.objects, ['provider-state' as const, provider]]),
                },
            },
        })).rejects.toMatchObject({ code: 'provider-state-identity-unobserved' });
        // pointer 는 물론이고 아무 PUT 도 없다.
        expect(store.calls.filter((call) => call.startsWith('PUT'))).toEqual([]);
    });

    it('shouldRefuseWhenTheOnlyFileForARequiredSessionIsEmpty', async () => {
        /*
         * 정규 파일 요구만으로는 **0바이트 파일**이 커버리지를 만족시킨다. 그것은
         * 디렉터리만 있는 경우와 같은 사실이다 — 그 세션의 상태가 담기지 않았다는
         * 것. 복원하면 이름만 있는 빈 파일이 나오고, 그 사이 checkpoint 는
         * `saved` 로 지나갔을 것이다.
         */
        const providerRoot = await scratch();
        await mkdir(join(providerRoot, 'sessions', 'sess-live'), { recursive: true });
        await writeFile(join(providerRoot, 'sessions', 'sess-live', 'rollout.jsonl'), '');
        const provider = {
            putUrl: 'https://store.invalid/provider.enc?m=PUT',
            headUrl: 'https://store.invalid/provider.enc?m=HEAD',
        };
        const store = fakeStore();
        await expect(publish({
            store,
            publish: {
                sources: [
                    { area: 'project' as const, root: await projectRoot() },
                    { area: 'provider-state' as const, root: providerRoot },
                ],
                providerStateSessions: ['sess-live'],
                targets: {
                    ...targets,
                    objects: new Map([...targets.objects, ['provider-state' as const, provider]]),
                },
            },
        })).rejects.toMatchObject({ code: 'provider-state-identity-unobserved' });
        expect(store.calls.filter((call) => call.startsWith('PUT'))).toEqual([]);
    });

    it('shouldRefuseWhenARequiredSessionIsNotInTheArchive', async () => {
        const store = fakeStore();
        await expect(publish({
            store,
            ...await providerStateSources({ sessions: ['sess-live', 'sess-absent'] }),
        })).rejects.toMatchObject({ code: 'provider-state-identity-unobserved' });
        expect(store.calls.filter((call) => call.startsWith('PUT'))).toEqual([]);
    });

    it('shouldNoLongerPublishOnASessionListAlone', async () => {
        /*
         * 이 자리에는 "필요한 세션이 전부 덮였으면 발행한다" 가 있었다. 그 성공
         * 경로가 열려 있는 한, 세션 목록을 넘기는 것만으로 1바이트 파일이
         * 커버리지처럼 보이고 pointer 가 움직인다 — 실제로 그렇게 발행됐다.
         *
         * 커버리지 검사 자체가 틀린 것은 아니다. 다만 **무엇을 덮어야 하는지**를
         * 서명된 inventory 가 말하기 전까지는 그 검사에 도달할 수 없어야 한다.
         * 위의 커버리지 어서션들은 그 계약이 생길 때 이 지점으로 돌아온다.
         */
        const store = fakeStore();
        await expect(publish({ store, ...await providerStateSources({ sessions: ['sess-live'] }) }))
            .rejects.toMatchObject({ code: 'provider-state-identity-unobserved' });
        expect(store.calls.filter((call) => call.startsWith('PUT'))).toEqual([]);
    });
});

describe('a failure says which stage it happened in', () => {
    /*
     * The first live checkpoint that got past the quiescence gate failed as
     * `checkpoint-failed` — the coordinator's word for "something threw and it
     * had no `code`". Every plain `Error` in the archive and crypto paths lands
     * there, so the one thing the line could not say is the one thing needed:
     * where it stopped.
     *
     * Stage codes are a closed set and carry no message, path or URL — the
     * thrower's text stays where it was.
     */
    it('shouldNameTheAreaWhoseArchiveFailed', async () => {
        /*
         * 두 area 는 닮은 데가 없다 — 하나는 executor 가 쓰는 project 트리이고
         * 다른 하나는 provider 자신의 home 으로, 소유자·내용·허용목록이 전부
         * 다르다. 실측에서 `stage-archive` 만 나왔을 때 답할 수 없었던 것이
         * 정확히 "둘 중 어느 쪽인가" 였다.
         */
        await expect(publish({ root: join(await scratch(), 'absent') }))
            .rejects.toMatchObject({ code: 'stage-archive-project' });
    });

    it('shouldNotReachTheProviderStateArchiveStageAtAllForNow', async () => {
        /*
         * 이 자리에는 provider-state **archive** 가 실패했을 때 그 area 이름을
         * 내는지 보는 테스트가 있었다. 지금은 그 단계에 도달하지 못한다 —
         * provider-state 는 flush 전에 구조적으로 거절된다.
         *
         * 그래서 도달 불가능한 상태를 흉내 내는 대신, 실제로 일어나는 거절을
         * 적는다. area 이름 자체의 계약은 `stage-archive-project` 두 건이 계속
         * 지키고, provider-state 쪽 어서션은 inventory 계약이 생겨 archive 에
         * 다시 도달할 때 돌아온다.
         */
        const root = await projectRoot();
        await expect(publish({
            publish: {
                sources: [
                    { area: 'project', root },
                    { area: 'provider-state', root: join(await scratch(), 'absent') },
                ],
                targets: {
                    ...targets,
                    objects: new Map([
                        ...targets.objects,
                        ['provider-state' as const, {
                            putUrl: 'https://store.invalid/provider.enc?m=PUT',
                            headUrl: 'https://store.invalid/provider.enc?m=HEAD',
                        }],
                    ]),
                },
            },
        })).rejects.toMatchObject({ code: 'provider-state-identity-unobserved' });
    });

    it('shouldNameTheSealStageWhenTheManifestCannotBeSealed', async () => {
        // 봉인 재료가 잘못되면 `sealCheckpointBuffer` 는 평범한 Error 를 던진다.
        await expect(publish({ publish: { key: Buffer.alloc(8) } }))
            .rejects.toMatchObject({ code: 'stage-archive-project' });
    });

    it('shouldLeaveAnAlreadyCodedFailureAlone', async () => {
        /*
         * A store error already names itself (`upload-failed`), and a publish
         * refusal already names its contract (`pointer-conflict`). Wrapping
         * those would replace a precise answer with a coarser one.
         */
        const refusing = {
            ...fakeStore(),
            fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
                const path = String(url);
                if ((init?.method ?? 'GET') === 'PUT' && path.includes('project.enc')) {
                    return new Response(null, { status: 403 });
                }
                return new Response(null, { status: 404 });
            }) as unknown as typeof globalThis.fetch,
        };
        await expect(publish({ store: refusing })).rejects.toMatchObject({ code: 'upload-failed' });
    });
});

describe('publishManagedCheckpoint', () => {
    it('shouldUploadAndVerifyEveryObjectBeforeItMovesTheLatestPointer', async () => {
        const { result, store } = await publish();

        const pointerWrite = store.calls.indexOf('PUT https://store.invalid/latest.json');
        expect(store.calls.indexOf('PUT https://store.invalid/project.enc')).toBeLessThan(pointerWrite);
        expect(store.calls.indexOf('HEAD https://store.invalid/project.enc')).toBeLessThan(pointerWrite);
        expect(store.calls.indexOf('PUT https://store.invalid/manifest.enc')).toBeLessThan(pointerWrite);
        expect(store.calls.indexOf('HEAD https://store.invalid/manifest.enc')).toBeLessThan(pointerWrite);
        expect(JSON.parse(store.objects.get('https://store.invalid/latest.json')!.toString())).toEqual({
            schemaVersion: 1,
            checkpointId,
            manifestDigest: result.manifestDigest,
            createdAtMs: 1_700_000_000_000,
        });
    });

    it('shouldNotPublishAManifestThatNamesAnObjectTheStoreDoesNotHold', async () => {
        const store = fakeStore();
        const dropping = {
            ...store,
            fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
                // The upload reports success and the store does not keep it.
                if (String(url).includes('project.enc') && (init?.method ?? 'GET') === 'PUT') {
                    return new Response(null, { status: 200, headers: { etag: '"deadbeefdeadbeefdeadbeefdeadbeef"' } });
                }
                return store.fetchImpl(url, init);
            }) as unknown as typeof globalThis.fetch,
        };
        await expect(publish({ store: dropping })).rejects.toMatchObject({ code: 'missing' });
        expect(store.objects.has('https://store.invalid/latest.json')).toBe(false);
    });

    it('shouldSealTheManifestSoTheStoreNeverSeesProjectContent', async () => {
        const root = await projectRoot();
        await mkdir(join(root, '.git'), { recursive: true });
        await writeFile(join(root, '.git/config'), '[remote "origin"]\n\turl = https://github.com/acme/private-name.git\n');
        const { store } = await publish({ root });
        const stored = store.objects.get('https://store.invalid/manifest.enc')!;
        expect(stored.includes(Buffer.from('private-name'))).toBe(false);
        expect(stored.subarray(0, 5).toString()).toBe('SCKP2');
    });

    it('shouldStopBeforeArchivingWhenADatabaseHasNoFlushAdapter', async () => {
        const root = await projectRoot();
        await writeFile(join(root, 'app.db'), Buffer.concat([Buffer.from('SQLite format 3\0', 'binary'), Buffer.alloc(8)]));
        const store = fakeStore();
        await expect(publish({
            root,
            store,
            flushDeps: { run: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } },
        })).rejects.toBeInstanceOf(ManagedCheckpointPublishError);
        // Nothing at all was read or written: the refusal is a preflight.
        expect(store.calls).toEqual([]);
    });

    it('shouldTakeTheCheckpointAnywayWhenTheCallerSaysSoAndReportWhatWasNotFlushed', async () => {
        const root = await projectRoot();
        await writeFile(join(root, 'app.db'), Buffer.concat([Buffer.from('SQLite format 3\0', 'binary'), Buffer.alloc(8)]));
        const { result } = await publish({
            root,
            flushDeps: { run: async () => ({ code: 1, stdout: '' }) },
            publish: { acknowledgeUnsupportedDatabases: true },
        });
        expect(result.flush.unsupported).toEqual([{ path: 'app.db', reason: 'flush-failed' }]);
    });

    it('shouldRefuseToOverwriteAnObjectAnotherCheckpointAlreadyWrote', async () => {
        const store = fakeStore();
        store.objects.set('https://store.invalid/project.enc', Buffer.from('another checkpoint'));
        store.etags.set('https://store.invalid/project.enc', 'other');

        await expect(publish({ store })).rejects.toMatchObject({ code: 'object-exists' });
        // The bytes that were there stay there, and nothing was pointed at.
        expect(store.objects.get('https://store.invalid/project.enc')).toEqual(Buffer.from('another checkpoint'));
        expect(store.objects.has('https://store.invalid/latest.json')).toBe(false);
    });

    it('shouldRefuseToOverwriteAManifestAnotherCheckpointAlreadyWrote', async () => {
        const store = fakeStore();
        store.objects.set('https://store.invalid/manifest.enc', Buffer.from('another manifest'));
        store.etags.set('https://store.invalid/manifest.enc', 'other');

        await expect(publish({ store })).rejects.toMatchObject({ code: 'object-exists' });
        expect(store.objects.get('https://store.invalid/manifest.enc')).toEqual(Buffer.from('another manifest'));
        expect(store.objects.has('https://store.invalid/latest.json')).toBe(false);
    });

    it('shouldRefuseWhenThePointerExistsButItsVersionIsUnknown', async () => {
        const store = fakeStore();
        store.objects.set('https://store.invalid/latest.json', Buffer.from('{"schemaVersion":1}'));
        const versionless = {
            ...store,
            fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
                const response = await store.fetchImpl(url, init);
                if (String(url).includes('latest.json') && (init?.method ?? 'GET') === 'GET') {
                    // A store that answers without an ETag gives no version to
                    // compare against.
                    return new Response(await response.text(), { status: response.status });
                }
                return response;
            }) as unknown as typeof globalThis.fetch,
        };

        await expect(publish({ store: versionless })).rejects.toMatchObject({ code: 'pointer-unreadable' });
        // The existing pointer is left exactly as it was.
        expect(store.objects.get('https://store.invalid/latest.json')!.toString()).toBe('{"schemaVersion":1}');
    });

    it('shouldLeaveAnotherRuntimesPointerAloneWhenItPublishedFirst', async () => {
        const store = fakeStore();
        // Another runtime's pointer is already there, so this run's
        // create-if-absent precondition fails.
        store.objects.set('https://store.invalid/latest.json', Buffer.from('{"schemaVersion":1}'));
        store.etags.set('https://store.invalid/latest.json', 'other');
        const winner = store.objects.get('https://store.invalid/latest.json')!;

        // Reads the pointer, then someone replaces it before the CAS.
        const racing = {
            ...store,
            fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
                if (String(url).endsWith('latest.json') && (init?.method ?? 'GET') === 'GET') {
                    return new Response(null, { status: 404 });
                }
                return store.fetchImpl(url, init);
            }) as unknown as typeof globalThis.fetch,
        };

        await expect(publish({ store: racing })).rejects.toMatchObject({ code: 'pointer-conflict' });
        expect(store.objects.get('https://store.invalid/latest.json')).toEqual(winner);
    });

    it('shouldHoldTheDrainForTheWholeCheckpointAndAlwaysReleaseIt', async () => {
        const drain = createCheckpointDrain();
        let drainedDuringArchive = false;
        await publish({
            drain,
            flushDeps: { run: async () => { drainedDuringArchive = drain.isDraining(); return { code: 0, stdout: '0|0|0' }; } },
            root: await (async () => {
                const root = await projectRoot();
                await writeFile(join(root, 'app.db'), Buffer.concat([
                    Buffer.from('SQLite format 3\0', 'binary'), Buffer.alloc(8),
                ]));
                return root;
            })(),
        });
        expect(drainedDuringArchive).toBe(true);
        expect(drain.isDraining()).toBe(false);
        expect(() => drain.beginWrite()).not.toThrow();
    });

    it('shouldReleaseTheDrainEvenWhenTheCheckpointFails', async () => {
        const drain = createCheckpointDrain();
        await expect(publish({
            drain,
            store: {
                ...fakeStore(),
                fetchImpl: (async () => new Response(null, { status: 500 })) as unknown as typeof globalThis.fetch,
            },
        })).rejects.toThrow();
        expect(drain.isDraining()).toBe(false);
    });
});

describe('provider state is refused until a signed inventory says what it must contain', () => {
    /*
     * The bridge, not the feature.
     *
     * The runtime can now see, per generation, which native session ended and
     * whether that observation is trustworthy. What it still cannot see is
     * **history**: which earlier attempts this project needs to be restorable.
     * One live generation says nothing about that, and `ownedGenerationKeys()`
     * is a responsibility ledger rather than a recovery list.
     *
     * So provider state is refused structurally — before the flush, before the
     * archive, before any upload — and it stays refused until a signed parent
     * inventory and a provider-typed coverage contract exist. Not refused
     * because the allowlist happens to match nothing: that guarantee would be
     * an accident of which provider version is installed.
     */
    const ID = 'aabbccdd-11ee-4ff1-8abc-def123456789';

    async function providerStateRunWithRealFile() {
        // One byte under `sessions/<id>` — exactly the shape the old coverage
        // check would have accepted as proof that the session was archived.
        const providerRoot = await scratch();
        await mkdir(join(providerRoot, 'sessions', ID), { recursive: true });
        await writeFile(join(providerRoot, 'sessions', ID, 'rollout.jsonl'), 'x');
        return {
            sources: [
                { area: 'project' as const, root: await projectRoot() },
                { area: 'provider-state' as const, root: providerRoot },
            ],
            targets: {
                ...targets,
                objects: new Map([...targets.objects, ['provider-state' as const, {
                    putUrl: 'https://store.invalid/provider.enc?m=PUT',
                    headUrl: 'https://store.invalid/provider.enc?m=HEAD',
                }]]),
            },
        };
    }

    const observed = (generations: unknown[]) => ({
        prove: async () => ({
            quiesced: true as const,
            exitCode: 0 as const,
            signal: null,
            providerState: { completeness: 'history-unestablished' as const, generations },
        }),
        stillProven: () => true,
    });

    it('shouldStillBlameTheMissingInventoryWhenEveryGenerationWasClean', async () => {
        const store = fakeStore();
        const run = await providerStateRunWithRealFile();
        const flushed: unknown[] = [];
        await expect(publish({
            store,
            publish: {
                ...run,
                providerState: observed([
                    { handle: 'h1', stopped: true, detail: 'stopped', nativeId: ID, identity: null },
                ]),
                flushDeps: { run: async (...args: unknown[]) => { flushed.push(args); return { code: 0, stdout: '0|0|0' }; } },
            },
        })).rejects.toMatchObject({ code: 'provider-state-inventory-missing' });

        // Before flush, before archive, before upload: nothing left this runtime.
        expect(flushed).toEqual([]);
        expect(store.calls).toEqual([]);
        expect([...store.objects.keys()]).toEqual([]);
    });

    it('shouldSayTheGenerationNamedNoSessionRatherThanBlameTheInventory', async () => {
        const store = fakeStore();
        const run = await providerStateRunWithRealFile();
        await expect(publish({
            store,
            publish: {
                ...run,
                providerState: observed([
                    { handle: 'h1', stopped: true, detail: 'stopped', nativeId: null, identity: null },
                ]),
            },
        })).rejects.toMatchObject({ code: 'provider-state-identity-absent' });
        expect(store.calls).toEqual([]);
    });

    it('shouldSayTheGenerationContradictedItselfRatherThanBlameTheInventory', async () => {
        const store = fakeStore();
        const run = await providerStateRunWithRealFile();
        await expect(publish({
            store,
            publish: {
                ...run,
                providerState: observed([
                    { handle: 'h1', stopped: true, detail: 'stopped', nativeId: null, identity: 'conflict' },
                ]),
            },
        })).rejects.toMatchObject({ code: 'provider-state-identity-conflict' });
        expect(store.calls).toEqual([]);
    });

    it('shouldSayNothingWasObservedWhenNoGenerationEnded', async () => {
        // An empty observation is not the same fact as a clean one. The runtime
        // was asked and saw nothing, which is its own diagnosis.
        const store = fakeStore();
        const run = await providerStateRunWithRealFile();
        await expect(publish({
            store,
            publish: { ...run, providerState: observed([]) },
        })).rejects.toMatchObject({ code: 'provider-state-identity-unobserved' });
        expect(store.calls).toEqual([]);
    });

    it('shouldCarryWhatItSawWithoutCarryingWhoItSaw', async () => {
        /*
         * The refusal has to be actionable, and it must not become a way for a
         * session id or a path to travel out of the runtime. Counts and closed
         * codes only — the ids stay where they were observed.
         */
        const run = await providerStateRunWithRealFile();
        const error = await publish({
            publish: {
                ...run,
                providerState: observed([
                    { handle: 'h1', stopped: true, detail: 'stopped', nativeId: ID, identity: null },
                    { handle: 'h2', stopped: true, detail: 'stopped', nativeId: null, identity: 'conflict' },
                    { handle: 'h3', stopped: false, detail: 'exit-unclean', nativeId: null, identity: null },
                ]),
            },
        }).then(() => null, (caught: unknown) => caught);
        expect(error).toMatchObject({
            code: 'provider-state-identity-conflict',
            observation: { completeness: 'history-unestablished', generations: 3, conflicted: 1, unnamed: 2, refused: 1 },
        });
        expect(JSON.stringify((error as { observation: unknown }).observation)).not.toContain(ID);
    });

    it('shouldNotBeTalkedIntoPublishingByASessionListAlone', async () => {
        /*
         * The old door: `providerStateSessions` was the only thing standing
         * between an archive and the pointer, so supplying ids was enough to
         * make a one-byte file look like coverage. It no longer is.
         */
        const store = fakeStore();
        const run = await providerStateRunWithRealFile();
        await expect(publish({
            store,
            publish: {
                ...run,
                providerStateSessions: [ID],
                providerState: observed([
                    { handle: 'h1', stopped: true, detail: 'stopped', nativeId: ID, identity: null },
                ]),
            },
        })).rejects.toMatchObject({ code: 'provider-state-inventory-missing' });
        expect(store.calls).toEqual([]);
    });

    it('shouldRefuseWithNoGateAtAllRatherThanTrustTheCaller', async () => {
        // The refusal is a property of what this runtime can establish, not of
        // whether somebody remembered to pass a gate.
        const store = fakeStore();
        const run = await providerStateRunWithRealFile();
        await expect(publish({ store, publish: run }))
            .rejects.toMatchObject({ code: 'provider-state-identity-unobserved' });
        expect(store.calls).toEqual([]);
    });

    it('shouldLeaveAProjectOnlyCheckpointAlone', async () => {
        // Nothing here is about the project area, and a runtime that archives
        // no provider state is unaffected.
        const { result } = await publish({
            publish: {
                providerState: observed([
                    { handle: 'h1', stopped: true, detail: 'stopped', nativeId: ID, identity: null },
                ]),
            },
        });
        expect(result.pointer.checkpointId).toBe(checkpointId);
    });
});
