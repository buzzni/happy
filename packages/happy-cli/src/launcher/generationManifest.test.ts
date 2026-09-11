import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, fsyncSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    createGenerationManifest,
    generationScopeDigest,
    type GenerationNativeObservation,
} from './generationManifest';

const NOW = 1_800_000_000_000;
const KEY = { runId: 'run-1', attemptId: 'attempt-1', epoch: 2 };

describe('generation manifest', () => {
    let root: string;

    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gen-manifest-')); });
    afterEach(() => { rmSync(root, { recursive: true, force: true }); });

    it('a generation this supervisor never launched is not something to prove', () => {
        expect(createGenerationManifest(root).proveStopped(KEY))
            .toEqual({ proven: false, detail: 'never-launched' });
    });

    it('a launched generation with no observed termination is unknown, not stopped', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        expect(manifest.proveStopped(KEY)).toEqual({ proven: false, detail: 'termination-unknown' });
    });

    it('the never-launched / unknown distinction survives a restart', () => {
        createGenerationManifest(root).recordLaunch({ key: KEY, launchedAt: NOW });
        const reopened = createGenerationManifest(root);
        expect(reopened.proveStopped(KEY)).toMatchObject({ detail: 'termination-unknown' });
        expect(reopened.proveStopped({ ...KEY, epoch: 9 })).toMatchObject({ detail: 'never-launched' });
    });

    it('ids containing the delimiter cannot collide into one record', () => {
        // `a__b` + `c` 와 `a` + `b__c` 는 구분자 이름에서 같은 파일이 된다.
        const left = { runId: 'a__b', attemptId: 'c', epoch: 0 };
        const right = { runId: 'a', attemptId: 'b__c', epoch: 0 };
        expect(generationScopeDigest(left)).not.toBe(generationScopeDigest(right));
        const manifest = createGenerationManifest(root);
        manifest.recordLaunch({ key: left, launchedAt: NOW });
        manifest.recordTermination({ key: left, observedEmptyAt: NOW });
        expect(manifest.proveStopped(left)).toMatchObject({ proven: true });
        expect(manifest.proveStopped(right)).toMatchObject({ proven: false, detail: 'never-launched' });
    });

    it('proves a generation observed empty, and stays proven after the cgroup is gone', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordTermination({ key: KEY, observedEmptyAt: NOW });
        // cgroup 디렉터리는 이미 사라졌다. 그래도 증명은 남는다.
        expect(manifest.proveStopped(KEY)).toMatchObject({
            proven: true, record: { observedEmptyAt: NOW },
        });
    });

    it('re-proving is idempotent and keeps the first observation', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordTermination({ key: KEY, observedEmptyAt: NOW });
        manifest.recordTermination({ key: KEY, observedEmptyAt: NOW + 5_000 });
        const first = manifest.proveStopped(KEY);
        const second = manifest.proveStopped(KEY);
        expect(first).toEqual(second);
        expect(first).toMatchObject({ record: { observedEmptyAt: NOW } });
    });

    it('survives a restart — a new manifest object reads the same evidence', () => {
        createGenerationManifest(root).recordTermination({ key: KEY, observedEmptyAt: NOW });
        expect(createGenerationManifest(root).proveStopped(KEY)).toMatchObject({ proven: true });
    });

    it('proveStopped matches the full requested scope, not just the epoch', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordTermination({ key: KEY, observedEmptyAt: NOW });
        expect(manifest.proveStopped({ ...KEY, epoch: 3 }))
            .toEqual({ proven: false, detail: 'never-launched' });
        expect(manifest.proveStopped({ ...KEY, runId: 'run-2' }))
            .toEqual({ proven: false, detail: 'never-launched' });
        expect(manifest.proveStopped({ ...KEY, attemptId: 'other' }))
            .toEqual({ proven: false, detail: 'never-launched' });
    });

    it('refuses to overwrite a record it cannot read', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        writeFileSync(join(root, `${generationScopeDigest(KEY)}.json`), '{broken');
        expect(() => manifest.recordTermination({ key: KEY, observedEmptyAt: NOW }))
            .toThrow(/unreadable/);
    });

    it('a damaged record is unreadable, never treated as absence or as proof', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordTermination({ key: KEY, observedEmptyAt: NOW });
        writeFileSync(join(root, `${generationScopeDigest(KEY)}.json`), '{not json');
        expect(manifest.proveStopped(KEY)).toEqual({ proven: false, detail: 'record-unreadable' });
    });

    it('a record whose contents name another scope is not this scope’s answer', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordTermination({ key: KEY, observedEmptyAt: NOW });
        writeFileSync(join(root, `${generationScopeDigest(KEY)}.json`), JSON.stringify({
            version: 1, runId: 'someone-else', attemptId: 'x', epoch: 0,
            launchedAt: NOW, observedEmptyAt: NOW,
        }));
        expect(manifest.proveStopped(KEY)).toEqual({ proven: false, detail: 'record-unreadable' });
    });

    it('refuses a manifest root that is writable by others', () => {
        const open = mkdtempSync(join(tmpdir(), 'gen-open-'));
        chmodSync(open, 0o777);
        expect(() => createGenerationManifest(open)).toThrow(/writable by others/);
        rmSync(open, { recursive: true, force: true });
    });

    it('refuses a manifest root owned by someone else', () => {
        expect(() => createGenerationManifest(root, { ownerUid: 999_999 }))
            .toThrow(/unexpected owner/);
    });

    it('leaves no partial file behind for a reader to trust', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordTermination({ key: KEY, observedEmptyAt: NOW });
        expect(require('node:fs').readdirSync(root).filter((e: string) => e.endsWith('.tmp'))).toEqual([]);
    });

    describe('proving every launched generation below an epoch', () => {
        it('nothing launched means nothing to prove', () => {
            expect(createGenerationManifest(root).proveAllBelow(5)).toMatchObject({ proven: true });
        });

        it('a launched generation with no termination blocks the proof', () => {
            const manifest = createGenerationManifest(root);
            manifest.recordLaunch({ key: { runId: 'run-1', attemptId: 'a', epoch: 1 }, launchedAt: NOW });
            expect(manifest.proveAllBelow(5)).toMatchObject({ proven: false, detail: 'termination-unknown' });
        });

        it('does not require generations that were never launched', () => {
            // epoch 0,2 만 띄웠다. 1 은 존재한 적이 없으므로 증명 대상이 아니다.
            const manifest = createGenerationManifest(root);
            for (const epoch of [0, 2]) {
                const key = { runId: 'run-1', attemptId: 'a', epoch };
                manifest.recordLaunch({ key, launchedAt: NOW });
                manifest.recordTermination({ key, observedEmptyAt: NOW });
            }
            expect(manifest.proveAllBelow(5)).toMatchObject({ proven: true });
        });

        it('generations at or above the epoch are not required', () => {
            const manifest = createGenerationManifest(root);
            manifest.recordLaunch({ key: { runId: 'run-1', attemptId: 'a', epoch: 7 }, launchedAt: NOW });
            expect(manifest.proveAllBelow(5)).toMatchObject({ proven: true });
        });

        it('covers every run and attempt — the contract is runtime-wide', () => {
            const manifest = createGenerationManifest(root);
            manifest.recordLaunch({ key: { runId: 'other-run', attemptId: 'z', epoch: 0 }, launchedAt: NOW });
            expect(manifest.proveAllBelow(Number.MAX_SAFE_INTEGER))
                .toMatchObject({ proven: false, detail: 'termination-unknown' });
        });

        it('an unreadable record blocks the proof instead of being skipped', () => {
            const manifest = createGenerationManifest(root);
            const key = { runId: 'run-1', attemptId: 'a', epoch: 0 };
            manifest.recordLaunch({ key, launchedAt: NOW });
            writeFileSync(join(root, `${generationScopeDigest(key)}.json`), 'broken');
            expect(manifest.proveAllBelow(5)).toMatchObject({ proven: false, detail: 'record-unreadable' });
        });

        it('an oversize record is unreadable, not ignored', () => {
            const manifest = createGenerationManifest(root);
            const key = { runId: 'run-1', attemptId: 'a', epoch: 0 };
            manifest.recordLaunch({ key, launchedAt: NOW });
            writeFileSync(join(root, `${generationScopeDigest(key)}.json`), 'x'.repeat(8192));
            expect(manifest.proveAllBelow(5)).toMatchObject({ proven: false, detail: 'record-unreadable' });
        });
    });

    it('refuses ids that would escape the manifest directory', () => {
        const manifest = createGenerationManifest(root);
        for (const runId of ['../escape', 'a/b', '']) {
            expect(() => manifest.proveStopped({ ...KEY, runId })).toThrow(/safe id/);
        }
        expect(() => manifest.proveStopped({ ...KEY, epoch: -1 })).toThrow(/epoch/);
    });
});

describe('a generation is launched once', () => {
    let root: string;
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gen-once-')); });
    afterEach(() => { rmSync(root, { recursive: true, force: true }); });

    it('accepts the first launch', () => {
        expect(createGenerationManifest(root).recordLaunch({ key: KEY, launchedAt: NOW }))
            .toEqual({ ok: true });
    });

    it('refuses a second launch of the same generation while it is open', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        expect(manifest.recordLaunch({ key: KEY, launchedAt: NOW + 1 }))
            .toEqual({ ok: false, reason: 'already-launched' });
    });

    it('refuses relaunching a terminated generation — that would make a live child look stopped', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        manifest.recordTermination({ key: KEY, observedEmptyAt: NOW + 10 });
        expect(manifest.recordLaunch({ key: KEY, launchedAt: NOW + 20 }))
            .toEqual({ ok: false, reason: 'already-terminated' });
        // 종료 증거가 그대로 남아 새 workload 를 덮지 않는다.
        expect(manifest.proveStopped(KEY)).toMatchObject({ proven: true });
    });

    it('refuses when the existing record cannot be read', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        writeFileSync(join(root, `${generationScopeDigest(KEY)}.json`), '{broken');
        expect(manifest.recordLaunch({ key: KEY, launchedAt: NOW + 1 }))
            .toEqual({ ok: false, reason: 'record-unreadable' });
    });
});

describe('open inventory and pending termination', () => {
    let root: string;
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gen-open-inv-')); });
    afterEach(() => { rmSync(root, { recursive: true, force: true }); });

    it('lists generations whose termination was never observed', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        const done = { runId: 'run-1', attemptId: 'a', epoch: 9 };
        manifest.recordLaunch({ key: done, launchedAt: NOW });
        manifest.recordTermination({ key: done, observedEmptyAt: NOW });
        const open = manifest.listOpen();
        expect(open.records.map((record) => record.epoch)).toEqual([KEY.epoch]);
        expect(open.unreadable).toBe(0);
    });

    it('the inventory survives a restart so a running child can be re-armed', () => {
        createGenerationManifest(root).recordLaunch({ key: KEY, launchedAt: NOW });
        expect(createGenerationManifest(root).listOpen().records).toHaveLength(1);
    });

    it('a requested-but-unobserved termination is pending, not stopped and not unknown', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        manifest.recordTerminationRequested({ key: KEY, requestedAt: NOW + 1 });
        // kill 뒤 관측 전에 죽은 상태다. 치웠다고 읽으면 안 된다.
        expect(manifest.proveStopped(KEY)).toEqual({ proven: false, detail: 'termination-pending' });
        expect(manifest.proveAllBelow(Number.MAX_SAFE_INTEGER))
            .toMatchObject({ proven: false, detail: 'termination-pending' });
        expect(manifest.listOpen().records).toHaveLength(1);
    });

    it('counts entries it cannot read instead of silently skipping them', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        writeFileSync(join(root, 'not-a-digest.json'), '{}');
        expect(manifest.listOpen().unreadable).toBe(1);
    });

    it('a record filed under the wrong digest is not trusted', () => {
        const manifest = createGenerationManifest(root);
        manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        manifest.recordTermination({ key: KEY, observedEmptyAt: NOW });
        const other = { runId: 'run-1', attemptId: 'a', epoch: 4 };
        // 다른 scope 의 이름으로 종료 기록을 갖다 놓아 증명을 만들 수 없다.
        writeFileSync(join(root, `${generationScopeDigest(other)}.json`), JSON.stringify({
            version: 1, ...KEY, launchedAt: NOW, terminationRequestedAt: null, observedEmptyAt: NOW,
        }));
        expect(manifest.proveAllBelow(Number.MAX_SAFE_INTEGER))
            .toMatchObject({ proven: false, detail: 'record-unreadable' });
    });
});

describe('every record this ledger holds', () => {
    let root: string;

    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gen-manifest-all-')); });
    afterEach(() => {
        chmodSync(root, 0o700);
        rmSync(root, { recursive: true, force: true });
    });

    const OPEN = { runId: 'run-open', attemptId: 'a1', epoch: 1 };
    const PENDING = { runId: 'run-pending', attemptId: 'a2', epoch: 2 };
    const CLOSED = { runId: 'run-closed', attemptId: 'a3', epoch: 3 };

    function seeded() {
        const manifest = createGenerationManifest(root);
        manifest.recordLaunch({ key: OPEN, launchedAt: NOW });
        manifest.recordLaunch({ key: PENDING, launchedAt: NOW });
        manifest.recordTerminationRequested({ key: PENDING, requestedAt: NOW + 1 });
        manifest.recordLaunch({ key: CLOSED, launchedAt: NOW });
        manifest.recordTermination({ key: CLOSED, observedEmptyAt: NOW + 2 });
        return manifest;
    }

    /** A record written straight to disk, under the name of its own digest. */
    function plant(record: object, digestOf: object = record): void {
        writeFileSync(
            join(root, `${generationScopeDigest(digestOf as never)}.json`),
            JSON.stringify(record),
            { mode: 0o600 },
        );
    }

    it('lists the closed generations as well as the open ones', () => {
        const manifest = seeded();
        const all = manifest.listAll();
        expect(all.unreadable).toBe(0);
        expect(all.records.map((record) => record.runId).sort())
            .toEqual(['run-closed', 'run-open', 'run-pending']);
        // The closure it records is the observation, with the request kept.
        const closed = all.records.find((record) => record.runId === 'run-closed')!;
        expect(closed.observedEmptyAt).toBe(NOW + 2);
        const pending = all.records.find((record) => record.runId === 'run-pending')!;
        expect(pending).toMatchObject({ terminationRequestedAt: NOW + 1, observedEmptyAt: null });
    });

    it('keeps listOpen a subset of it', () => {
        const manifest = seeded();
        const all = manifest.listAll();
        const open = manifest.listOpen();
        expect(open.records.map((record) => record.runId).sort()).toEqual(['run-open', 'run-pending']);
        for (const record of open.records) expect(all.records).toContainEqual(record);
        expect(open.unreadable).toBe(all.unreadable);
    });

    it('answers the same after a restart over the same directory', () => {
        seeded();
        const reopened = createGenerationManifest(root).listAll();
        expect(reopened.records.map((record) => record.runId).sort())
            .toEqual(['run-closed', 'run-open', 'run-pending']);
        expect(reopened.unreadable).toBe(0);
    });

    it('counts a record whose ids are not safe segments rather than throwing', () => {
        /*
         * `generationScopeDigest` refuses an unsafe id by throwing, and the name
         * check calls it on the record's *own* contents. So one planted record with
         * a traversal id ended the whole listing as an exception — the inventory a
         * restart reconciles from became "the ledger could not be read at all",
         * which is not what happened and not what a caller can act on.
         */
        const manifest = seeded();
        writeFileSync(join(root, `${'a'.repeat(64)}.json`), JSON.stringify({
            version: 1, runId: '../escape', attemptId: 'a1', epoch: 1,
            launchedAt: NOW, terminationRequestedAt: null, observedEmptyAt: null,
        }), { mode: 0o600 });

        const all = manifest.listAll();
        expect(all.unreadable).toBe(1);
        expect(all.records).toHaveLength(3);
        expect(manifest.listOpen().unreadable).toBe(1);
    });

    it('answers the fencing proof on a ledger holding only that record, without throwing', () => {
        /*
         * Its own directory, one malformed record: nothing else can be reached
         * first, so the answer is the record's own and not an artefact of
         * `readdir` order. The shared name guard is what turns the digest throw
         * into this refusal — the traversal itself is unchanged.
         */
        const alone = mkdtempSync(join(tmpdir(), 'gen-manifest-unsafe-'));
        try {
            const manifest = createGenerationManifest(alone);
            writeFileSync(join(alone, `${'a'.repeat(64)}.json`), JSON.stringify({
                version: 1, runId: '../escape', attemptId: 'a1', epoch: 1,
                launchedAt: NOW, terminationRequestedAt: null, observedEmptyAt: null,
            }), { mode: 0o600 });

            expect(() => manifest.proveAllBelow(9)).not.toThrow();
            expect(manifest.proveAllBelow(9)).toEqual({ proven: false, detail: 'record-unreadable' });
            expect(manifest.listAll()).toEqual({ records: [], unreadable: 1 });
        } finally {
            rmSync(alone, { recursive: true, force: true });
        }
    });

    it.each([
        ['corrupt json', () => writeFileSync(join(root, `${'b'.repeat(64)}.json`), '{ not json', { mode: 0o600 })],
        ['oversize', () => writeFileSync(join(root, `${'c'.repeat(64)}.json`), 'x'.repeat(5000), { mode: 0o600 })],
        ['a name that is not a digest', () => writeFileSync(join(root, 'planted.json'), '{}', { mode: 0o600 })],
    ])('counts %s as unreadable without dropping the records it could read', (_name, plantIt) => {
        const manifest = seeded();
        plantIt();
        const all = manifest.listAll();
        expect(all.unreadable).toBe(1);
        expect(all.records).toHaveLength(3);
    });

    it('counts a record filed under another records digest as unreadable', () => {
        const manifest = seeded();
        // Valid content, wrong file name: the name is supposed to be its digest.
        plant({
            version: 1, runId: 'run-moved', attemptId: 'a9', epoch: 9,
            launchedAt: NOW, terminationRequestedAt: null, observedEmptyAt: null,
        }, { runId: 'run-other', attemptId: 'a8', epoch: 8 });
        const all = manifest.listAll();
        expect(all.unreadable).toBe(1);
        expect(all.records.map((record) => record.runId)).not.toContain('run-moved');
    });

    it('reports a directory it cannot read as unreadable, not as an empty ledger', () => {
        const manifest = seeded();
        chmodSync(root, 0o000);
        const all = manifest.listAll();
        chmodSync(root, 0o700);
        // An empty list here would tell a restart there was nothing to reconcile.
        expect(all).toEqual({ records: [], unreadable: 1 });
    });
});

describe('a native terminal observation', () => {
    let root: string;

    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gen-manifest-native-')); });
    afterEach(() => {
        chmodSync(root, 0o700);
        rmSync(root, { recursive: true, force: true });
    });

    const KEY_N = { runId: 'run-n', attemptId: 'a1', epoch: 1 };
    const SESSION = 'd6da1867-afd5-4637-bd7e-52a3e28c2fb8';
    const OTHER_SESSION = '330a1f93-cda9-4080-89a3-c780c9ade479';

    function observation(over: Partial<GenerationNativeObservation> = {}): GenerationNativeObservation {
        return {
            observedAt: NOW + 5,
            outcome: 'clean-stopped',
            nativeId: SESSION,
            detail: 'stopped',
            ...over,
        };
    }

    function launched(io?: { rename?: typeof renameSync; fsync?: typeof fsyncSync }) {
        // The launch is written with the real fs; only what happens afterwards is
        // injected, so a failure belongs to the observation and not to the setup.
        createGenerationManifest(root).recordLaunch({ key: KEY_N, launchedAt: NOW });
        return createGenerationManifest(root, io ? { io } : {});
    }

    function storedObservation(manifest = createGenerationManifest(root)) {
        return manifest.listAll().records.find((record) => record.runId === KEY_N.runId)?.nativeObservation;
    }

    it('stores the first proof of a launched generation', () => {
        const manifest = launched();
        expect(manifest.recordNativeObservation({ key: KEY_N, observation: observation() }))
            .toEqual({ ok: true, stored: 'first' });
        expect(storedObservation()).toEqual(observation());
    });

    it('refuses a generation it never launched, and writes nothing', () => {
        // An observation must not manufacture a launch that never happened.
        const manifest = createGenerationManifest(root);
        expect(manifest.recordNativeObservation({ key: KEY_N, observation: observation() }))
            .toEqual({ ok: false, reason: 'never-launched' });
        expect(manifest.listAll()).toEqual({ records: [], unreadable: 0 });
    });

    it('keeps an absent observation distinct from one that reported no identity', () => {
        const manifest = launched();
        expect(storedObservation()).toBeUndefined();
        manifest.recordNativeObservation({
            key: KEY_N,
            observation: observation({ outcome: 'native-unreported', nativeId: null }),
        });
        // Neither says the generation used no session; they differ only in
        // whether a proof happened.
        expect(storedObservation()).toMatchObject({ outcome: 'native-unreported', nativeId: null });
    });

    it('ignores a repeat that differs only in when it was observed', () => {
        const manifest = launched();
        manifest.recordNativeObservation({ key: KEY_N, observation: observation() });
        expect(manifest.recordNativeObservation({
            key: KEY_N, observation: observation({ observedAt: NOW + 999 }),
        })).toEqual({ ok: true, stored: 'duplicate-ignored' });
        // The stored time is when the fact was first proven.
        expect(storedObservation()?.observedAt).toBe(NOW + 5);
    });

    it('turns two disagreeing proofs into a conflict that survives a reopen', () => {
        const manifest = launched();
        manifest.recordNativeObservation({ key: KEY_N, observation: observation() });
        expect(manifest.recordNativeObservation({
            key: KEY_N, observation: observation({ nativeId: OTHER_SESSION }),
        })).toEqual({ ok: true, stored: 'first-conflicted' });

        const reopened = createGenerationManifest(root);
        expect(storedObservation(reopened))
            .toMatchObject({ outcome: 'conflict', nativeId: null, observedAt: NOW + 5 });
        // A peer that contradicted itself does not become trustworthy by
        // repeating one half.
        expect(reopened.recordNativeObservation({ key: KEY_N, observation: observation() }))
            .toEqual({ ok: true, stored: 'conflict-kept' });
        expect(storedObservation()).toMatchObject({ outcome: 'conflict', nativeId: null });
    });

    it('treats two spellings of one id as a conflict, not a duplicate', () => {
        const manifest = launched();
        manifest.recordNativeObservation({ key: KEY_N, observation: observation() });
        expect(manifest.recordNativeObservation({
            key: KEY_N, observation: observation({ nativeId: SESSION.toUpperCase() }),
        })).toEqual({ ok: true, stored: 'first-conflicted' });
    });

    it.each([
        ['an unknown outcome', { outcome: 'stopped-ish' as never }],
        ['an id that is not a session id', { nativeId: 'nope' }],
        ['an id on an outcome that reported none', { outcome: 'native-unreported' as const }],
        ['a detail that is a sentence', { detail: 'it stopped, eventually' }],
        ['an observation time of zero', { observedAt: 0 }],
    ])('refuses %s as input rather than storing it', (_name, over) => {
        const manifest = launched();
        expect(manifest.recordNativeObservation({ key: KEY_N, observation: observation(over) }))
            .toEqual({ ok: false, reason: 'observation-invalid' });
        expect(storedObservation()).toBeUndefined();
    });

    it.each([
        ['an unknown outcome', { outcome: 'stopped-ish' }],
        ['an id that is not a session id', { nativeId: 'nope' }],
        ['an id on an outcome that reported none', { outcome: 'native-unreported' }],
        ['an observation time of zero', { observedAt: 0 }],
        ['an outcome that is not a string', { outcome: 7 }],
    ])('reads a record whose stored field is malformed — %s — as unreadable', (_name, over) => {
        launched();
        const path = join(root, `${generationScopeDigest(KEY_N)}.json`);
        const record = JSON.parse(readFileSync(path, 'utf8'));
        writeFileSync(path, JSON.stringify({
            ...record,
            nativeObservation: { ...observation(), ...over },
        }), { mode: 0o600 });

        expect(createGenerationManifest(root).listAll()).toEqual({ records: [], unreadable: 1 });
    });

    it('survives the writers that rebuild the whole record', () => {
        /*
         * `recordTerminationRequested` and `recordTermination` reconstruct the
         * record from what was parsed, so a field they do not carry is erased by
         * the next ordinary write — from inside, not from a downgrade.
         */
        const manifest = launched();
        manifest.recordNativeObservation({ key: KEY_N, observation: observation() });
        manifest.recordTerminationRequested({ key: KEY_N, requestedAt: NOW + 10 });
        expect(storedObservation()).toEqual(observation());
        manifest.recordTermination({ key: KEY_N, observedEmptyAt: NOW + 20 });

        const reopened = createGenerationManifest(root);
        expect(storedObservation(reopened)).toEqual(observation());
        // And closure is what it was.
        expect(reopened.proveStopped(KEY_N)).toMatchObject({ proven: true });
    });

    it('keeps a conflict through those writers too', () => {
        const manifest = launched();
        manifest.recordNativeObservation({ key: KEY_N, observation: observation() });
        manifest.recordNativeObservation({ key: KEY_N, observation: observation({ nativeId: OTHER_SESSION }) });
        manifest.recordTerminationRequested({ key: KEY_N, requestedAt: NOW + 10 });
        manifest.recordTermination({ key: KEY_N, observedEmptyAt: NOW + 20 });
        expect(storedObservation(createGenerationManifest(root)))
            .toMatchObject({ outcome: 'conflict', nativeId: null });
    });

    it('does not change any fencing answer', () => {
        const manifest = launched();
        const before = {
            stopped: manifest.proveStopped(KEY_N),
            below: manifest.proveAllBelow(9),
        };
        manifest.recordNativeObservation({ key: KEY_N, observation: observation() });
        expect(manifest.proveStopped(KEY_N)).toEqual(before.stopped);
        expect(manifest.proveAllBelow(9)).toEqual(before.below);
    });

    describe('when the durable write fails', () => {
        it('reports a failure before the rename, leaving the record as it was', () => {
            const manifest = launched({
                rename: () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); },
            });
            expect(manifest.recordNativeObservation({ key: KEY_N, observation: observation() }))
                .toEqual({ ok: false, reason: 'write-refused' });
            // Untouched: the previous record is still the launch record.
            expect(storedObservation()).toBeUndefined();
            expect(createGenerationManifest(root).proveStopped(KEY_N))
                .toMatchObject({ detail: 'termination-unknown' });
        });

        it('reports durability as unknown when only the directory barrier failed', () => {
            let calls = 0;
            const manifest = launched({
                fsync: (fd: number) => {
                    // A durable write syncs the file first, then the directory.
                    // Only the second one fails here.
                    if (calls++ === 1) throw Object.assign(new Error('EIO'), { code: 'EIO' });
                    fsyncSync(fd);
                },
            });
            expect(manifest.recordNativeObservation({ key: KEY_N, observation: observation() }))
                .toEqual({ ok: false, reason: 'durability-unknown' });
            // The rename landed, so the field is there — its durability is what
            // is unknown, and nothing rolls back.
            expect(storedObservation()).toEqual(observation());
        });

        it('re-attempts the barrier on a retry rather than calling it a duplicate', () => {
            /*
             * The rename landed and its directory entry was never made durable.
             * Answering the retry `duplicate-ignored` on the value alone would
             * report success while nothing had made those bytes survive a crash.
             */
            let calls = 0;
            let failDirSync = true;
            const barrierAttempts: number[] = [];
            const manifest = launched({
                fsync: (fd: number) => {
                    // The first write syncs the file, then the directory; a
                    // retry that stores nothing syncs the directory alone.
                    const isDirectory = calls !== 0;
                    calls += 1;
                    if (!isDirectory) { fsyncSync(fd); return; }
                    barrierAttempts.push(fd);
                    if (failDirSync) throw Object.assign(new Error('EIO'), { code: 'EIO' });
                    fsyncSync(fd);
                },
            });
            expect(manifest.recordNativeObservation({ key: KEY_N, observation: observation() }))
                .toEqual({ ok: false, reason: 'durability-unknown' });
            const afterFirst = barrierAttempts.length;

            // Same observation again, barrier still failing.
            expect(manifest.recordNativeObservation({ key: KEY_N, observation: observation() }))
                .toEqual({ ok: false, reason: 'durability-unknown' });
            expect(barrierAttempts.length).toBeGreaterThan(afterFirst);

            // Now it succeeds: the retry is what makes it durable.
            failDirSync = false;
            const attemptsBefore = barrierAttempts.length;
            expect(manifest.recordNativeObservation({ key: KEY_N, observation: observation() }))
                .toEqual({ ok: true, stored: 'duplicate-ignored' });
            expect(barrierAttempts.length).toBeGreaterThan(attemptsBefore);
            expect(storedObservation()?.observedAt).toBe(NOW + 5);
        });

        it('re-attempts the barrier on a conflict-kept retry as well', () => {
            let syncs = 0;
            const manifest = launched({
                fsync: (fd: number) => { syncs += 1; fsyncSync(fd); },
            });
            manifest.recordNativeObservation({ key: KEY_N, observation: observation() });
            manifest.recordNativeObservation({ key: KEY_N, observation: observation({ nativeId: OTHER_SESSION }) });
            const before = syncs;
            expect(manifest.recordNativeObservation({ key: KEY_N, observation: observation() }))
                .toEqual({ ok: true, stored: 'conflict-kept' });
            // The only sync a `conflict-kept` can issue is the barrier itself.
            expect(syncs).toBeGreaterThan(before);
        });
    });
});
