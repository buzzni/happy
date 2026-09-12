/**
 * Takes a checkpoint, in the order plan §7 specifies, and makes it the current
 * one only once all of it is on the store.
 *
 * ```
 * drain writes → prove the provider settled → flush databases → archive
 *              → upload → verify → publish manifest
 *              → compare-and-set the latest pointer → release the drain
 * ```
 *
 * The order is the correctness argument, not a style choice:
 *
 *  - **flush before archive**, because the archive copies files and a database
 *    whose committed state is still in a WAL is not in those files.
 *  - **verify before publish**, because the manifest is the claim that the
 *    objects exist and are intact; publishing it first would make a torn
 *    upload indistinguishable from a good one.
 *  - **the proof re-checked immediately before the pointer**, because the
 *    pointer is the thing that makes an archive *the* checkpoint. Finding out
 *    afterwards that the proof had died is too late: an unsafe checkpoint is
 *    already the latest one, and a restore reads it. The objects are orphaned
 *    instead, which costs bytes and nothing else.
 *  - **the pointer last, and conditionally**, because the pointer is what a
 *    restore reads. Nothing incomplete is ever pointed at, and a second
 *    runtime that published while this one was working wins the race instead
 *    of being silently overwritten.
 *  - **release the drain in `finally`**, because a failed checkpoint must not
 *    leave the agent unable to write.
 *  - **the provider proof inside the drained window, before the flush**, because
 *    the proof's first step is that admission is closed — and tool admission is
 *    closed by *this* drain. A proof taken before the drain was held would be
 *    asserting an exclusion nobody had. It is also before anything is archived,
 *    so a refusal costs no bytes and leaves the checkpoint id clean.
 *
 * ## One owner of the drain
 *
 * This function acquires the drain and releases it, and nothing else does. The
 * quiescence gate only *observes* it (`isDraining`, `inFlight`, `writes`): two
 * acquirers of one drain deadlock every checkpoint, since the second call finds
 * `drain-in-progress`. So the proof is invoked here, as a step, rather than run
 * by a caller that would have to hold the drain to make it mean anything.
 *
 * An engine with no flush adapter stops this before anything is archived. Plan
 * §7 is explicit that unsupported databases are surfaced rather than quietly
 * succeeding, and the caller has to say, in as many words, that it wants a
 * checkpoint without them.
 */
import { join } from 'node:path';

import { createManagedCheckpoint, type CheckpointAreaSource } from './managedCheckpointArchive';
import { sealCheckpointBuffer } from './managedCheckpointCrypto';
import type { CheckpointDrain } from './managedCheckpointDrain';
import type { ProviderStateScopeV1 } from './managedProviderStateScope';
import type {
    ProviderQuiescence,
    ProviderQuiescenceRefusal,
    ProviderStateObservation,
} from './managedProviderQuiescence';
import { flushCheckpointDatabases, type CheckpointFlushDeps, type CheckpointFlushResult } from './managedCheckpointFlush';
import { serializeManagedCheckpointManifest, type ManagedCheckpointManifest } from './managedCheckpointManifest';
import {
    putCheckpointObject,
    putCheckpointPointer,
    readCheckpointPointer,
    verifyCheckpointObject,
    type CheckpointFetch,
} from './managedCheckpointObjectStore';
import type { CheckpointArea } from './managedCheckpointScope';

export const MANAGED_CHECKPOINT_POINTER_VERSION = 1;

/**
 * Which stage a failure that named nothing happened in.
 *
 * The archive and crypto paths throw plain `Error`s — "area root is unusable",
 * "key must be 32-byte", "archive is too large" — and a plain Error has no
 * `code`, so the coordinator could only report its catch-all
 * (`checkpoint-failed`). The first live checkpoint to clear the quiescence gate
 * failed exactly there, and the line could not say where it stopped.
 *
 * A closed set of stage names, and nothing from the thrower travels with them:
 * the message may hold a path, and the paths here are the tenant's.
 *
 * Errors that already carry a `code` are left alone — a store's `upload-failed`
 * or this file's `pointer-conflict` is more precise than the stage it happened
 * in, and replacing it would be a loss.
 */
export class ManagedCheckpointStageError extends Error {
    constructor(readonly code:
        | 'stage-archive'
        /** Per area, because one of the two can fail while the other is fine. */
        | 'stage-archive-project'
        | 'stage-archive-provider-state'
        | 'stage-manifest-seal'
        | 'stage-upload'
        | 'stage-pointer') {
        super(`managed checkpoint failed at ${code}`);
        this.name = 'ManagedCheckpointStageError';
    }
}

/**
 * Runs one stage, naming it only if whatever threw named nothing itself.
 *
 * The name is asked for **after** the failure, so it can say how far the stage
 * had got — which area was being archived, say — rather than only which stage it
 * was.
 */
async function atStage<T>(
    code: () => ManagedCheckpointStageError['code'],
    run: () => Promise<T>,
): Promise<T> {
    try {
        return await run();
    } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== undefined) throw error;
        throw new ManagedCheckpointStageError(code());
    }
}

export class ManagedCheckpointPublishError extends Error {
    constructor(readonly code:
        | 'unsupported-database'
        | 'target-missing'
        | 'pointer-conflict'
        | 'pointer-unreadable'
        /**
         * The runtime archives provider state and nothing said which sessions
         * the archive has to cover, so whether it is recoverable cannot be
         * asserted. Refused rather than published: an archive that carries none
         * of the run's native state and still moves the pointer is a checkpoint
         * that looks good and restores nothing.
         */
        | 'provider-state-coverage-unknown'
        /** A session that had to be covered is not in the archive. */
        | 'provider-state-coverage-missing'
        /**
         * Provider state was targeted and this runtime cannot establish what a
         * complete archive of it would be.
         *
         * It can see which native session **this** generation ended — the
         * control-channel ack carries it, per generation. What it cannot see is
         * history: which earlier attempts this project needs in order to be
         * restorable. One live generation says nothing about that, and
         * `ownedGenerationKeys()` is a ledger of what must be answered for now,
         * not a recovery list.
         *
         * So this refuses structurally, before the first flush, until a signed
         * parent inventory and a provider-typed coverage contract say what the
         * archive must contain. Refusing on the strength of the allowlist
         * matching nothing would be an accident of which provider version is
         * installed — a session list alone once made a one-byte file look like
         * coverage and published it.
         */
        | 'provider-state-inventory-missing'
        /** A generation ended without naming the session it wrote. */
        | 'provider-state-identity-absent'
        /** A generation named two sessions; neither is usable. */
        | 'provider-state-identity-conflict'
        /** Nothing was observed ending, so there is nothing to be complete about. */
        | 'provider-state-identity-unobserved',
        /**
         * What the proof saw, as counts and closed codes.
         *
         * Deliberately **not** the observation itself: that carries native
         * session ids, and a refusal must not become the way one leaves the
         * runtime. Counts are enough to act on — they say whether to retry,
         * whether a generation misbehaved, and whether anything was seen at all.
         */
        readonly observation?: ProviderStateRefusalSummary,
    ) {
        super(`managed checkpoint publish refused: ${code}`);
        this.name = 'ManagedCheckpointPublishError';
    }
}

/** Counts only. No ids, no paths, nothing a generation chose. */
export type ProviderStateRefusalSummary = {
    completeness: ProviderStateObservation['completeness'];
    generations: number;
    /** Ended without naming a session. */
    unnamed: number;
    /** Named two. */
    conflicted: number;
    /** Would not end its input. */
    refused: number;
};

/**
 * Which refusal this proof earns.
 *
 * The signed inventory is missing in every case, so every branch refuses — but
 * "the inventory does not exist yet" and "this generation contradicted itself"
 * are different problems with different owners, and answering the first for the
 * second sends whoever reads it to the wrong place. A misbehaving generation is
 * named first because it is the one thing here that is actually wrong.
 */
function classifyProviderStateRefusal(observed: ProviderStateObservation | undefined): {
    code: 'provider-state-inventory-missing'
    | 'provider-state-identity-absent'
    | 'provider-state-identity-conflict'
    | 'provider-state-identity-unobserved';
    observation?: ProviderStateRefusalSummary;
} {
    // No gate, or a gate that answered nothing: the runtime cannot even say
    // what it failed to establish.
    if (observed === undefined) return { code: 'provider-state-identity-unobserved' };
    const summary: ProviderStateRefusalSummary = {
        completeness: observed.completeness,
        generations: observed.generations.length,
        unnamed: observed.generations.filter((entry) => entry.nativeId === null).length,
        conflicted: observed.generations.filter((entry) => entry.identity === 'conflict').length,
        refused: observed.generations.filter((entry) => !entry.stopped).length,
    };
    if (summary.generations === 0) return { code: 'provider-state-identity-unobserved', observation: summary };
    if (summary.conflicted > 0) return { code: 'provider-state-identity-conflict', observation: summary };
    if (summary.unnamed > 0) return { code: 'provider-state-identity-absent', observation: summary };
    /*
     * Everything this runtime can see is in order, and it is still not enough:
     * a known current session says nothing about the earlier attempts this
     * project needs to be restorable. Unconditional, and the only branch that
     * an otherwise-perfect tick reaches.
     */
    return { code: 'provider-state-inventory-missing', observation: summary };
}

/**
 * The provider's own state could not be proven settled, so nothing was archived.
 *
 * Its own class rather than a `ManagedCheckpointPublishError` code: this is not
 * a failure of the checkpoint machinery and must not be counted as one. The run
 * is healthy, the checkpoint simply may not be taken yet, and the id is clean
 * because this is thrown before the first flush.
 */
export class ManagedCheckpointProviderStateUnproven extends Error {
    constructor(readonly reason: ProviderQuiescenceRefusal) {
        super(`managed checkpoint refused: provider state unproven (${reason})`);
        this.name = 'ManagedCheckpointProviderStateUnproven';
    }
}

/**
 * The proof was taken, the archive was made, and then the proof stopped holding
 * before the pointer could be written.
 *
 * Distinct from `ManagedCheckpointProviderStateUnproven`, which refuses before
 * anything is archived: here the objects are on the store under this checkpoint
 * id, and nothing points at them. The id is spent — the objects were written
 * `ifAbsent`, so a re-run under the same id meets its own bytes — but nothing
 * unsafe was ever announced as the latest checkpoint.
 */
export class ManagedCheckpointProviderStateInvalidated extends Error {
    constructor() {
        super('managed checkpoint refused: provider state invalidated during the archive');
        this.name = 'ManagedCheckpointProviderStateInvalidated';
    }
}

/** What a restore reads first: which checkpoint is current, and its digest. */
export type ManagedCheckpointPointer = {
    schemaVersion: typeof MANAGED_CHECKPOINT_POINTER_VERSION;
    checkpointId: string;
    manifestDigest: string;
    createdAtMs: number;
};

/**
 * Each object is written once and never replaced (`ifAbsent`), so the keys the
 * parent signs must be scoped to this checkpoint. Only the pointer is a
 * compare-and-set; if the objects could be overwritten, the runtime that lost
 * the pointer race could still have replaced the winner's archive underneath
 * it — a pointer naming one manifest over another's bytes, which restores as
 * nothing at all.
 *
 * A signed URL authorises **one method**. SigV4 puts the HTTP method into the
 * canonical request that is signed, so a URL minted for `PUT` is rejected for
 * `HEAD` — a store that allowed it would be one with anonymous access, where
 * the signature was never the thing granting permission. So every object needs
 * its own pair, and the verification step gets a URL of its own rather than
 * reusing the upload's.
 *
 * https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html
 */
export type CheckpointObjectTarget = { putUrl: string; headUrl: string };

export type ManagedCheckpointPublishTargets = {
    objects: Map<CheckpointArea, CheckpointObjectTarget>;
    manifest: CheckpointObjectTarget;
    /** Signed PUT and GET URLs for the latest pointer. */
    pointer: { putUrl: string; getUrl: string };
};

export async function publishManagedCheckpoint(input: {
    checkpointId: string;
    tenant: { tenantId: string; projectId: string };
    volume: { volumeId: string; deviceUuid: string };
    image: { imageVersion: string };
    sources: CheckpointAreaSource[];
    providerStateSessions?: readonly string[];
    /**
     * Which sessions the parent says this checkpoint is meant to carry.
     *
     * **Delivered and not yet used.** The comparison it exists for belongs
     * inside the held drain, against the generations the quiescence proof
     * reports - and the trusted axes that needs (runtime, workspace, operation,
     * live lease epoch) are not available here. Inventing one from the held
     * keys, the source epochs or `expiresAt` would be an oracle nobody agreed
     * to, so nothing reads this yet.
     *
     * It is carried so the parser's output reaches the layer that will do the
     * comparison, and so that a hop dropping it fails a test rather than going
     * unnoticed. It changes no behaviour: the provider-state refusal above is
     * untouched and still fires before the first flush.
     */
    providerStateScope?: ProviderStateScopeV1;
    key: Buffer;
    /** Scratch space on the volume for the sealed objects. */
    workDir: string;
    drain: CheckpointDrain;
    drainBudgetMs: number;
    /**
     * The provider quiescence gate, invoked inside the drained window.
     *
     * Absent means this runtime archives no provider state — the caller decides
     * that, and refuses on its own when provider state *is* archived with no
     * gate to prove it. Present means the checkpoint does not proceed past the
     * drain until `prove()` says the provider settled.
     *
     * `stillProven` is read once more, **before the drain is released**, so the
     * answer describes the window the archive was taken in rather than the
     * moment the caller got around to asking.
     */
    providerState?: {
        prove: () => Promise<ProviderQuiescence>;
        stillProven: () => boolean;
    };
    flushDeps: CheckpointFlushDeps;
    targets: ManagedCheckpointPublishTargets;
    now: () => number;
    /** Take the checkpoint even though some databases could not be flushed. */
    acknowledgeUnsupportedDatabases?: boolean;
    fetchImpl?: CheckpointFetch;
}): Promise<{
    manifest: ManagedCheckpointManifest;
    manifestDigest: string;
    pointer: ManagedCheckpointPointer;
    pointerEtag: string | null;
    flush: CheckpointFlushResult;
    /**
     * Whether the proof still held when the pointer had been written and the
     * drain was still held. `null` when there was no gate to ask.
     */
    providerStateStillProven: boolean | null;
}> {
    const held = await input.drain.drain(input.drainBudgetMs);
    try {
        /*
         * 증명은 drain 을 잡은 **뒤**, 아무것도 굽기 **전**이다. 앞이면 닫히지
         * 않은 admission 위에서 증명한 것이 되고, 뒤면 증명 못 한 상태를 이미
         * 봉인한 뒤가 된다.
         */
        let observed: ProviderStateObservation | undefined;
        if (input.providerState) {
            const proof = await input.providerState.prove();
            if (!proof.quiesced) throw new ManagedCheckpointProviderStateUnproven(proof.reason);
            // The same proof, read in the window it is true for. Anything read
            // from this function's arguments was read before the drain was even
            // acquired.
            observed = proof.providerState;
        }
        /*
         * Before the flush, before the archive, before any upload — so a
         * refusal leaves nothing behind and costs nothing to retry.
         *
         * `observed` absent and `completeness` unestablished mean the same
         * thing here, deliberately: a proof that does not say provider state is
         * complete is a proof that provider state may not be archived. There is
         * no reading of "absent" that unlocks anything, which is why the type
         * has no arm claiming the opposite.
         */
        if (input.sources.some((source) => source.area === 'provider-state')) {
            const refusal = classifyProviderStateRefusal(observed);
            throw new ManagedCheckpointPublishError(refusal.code, refusal.observation);
        }
        const flush: CheckpointFlushResult = { flushed: [], unsupported: [] };
        for (const source of input.sources) {
            if (source.area !== 'project') continue;
            const result = await flushCheckpointDatabases({ root: source.root, deps: input.flushDeps });
            flush.flushed.push(...result.flushed);
            flush.unsupported.push(...result.unsupported);
        }
        if (flush.unsupported.length > 0 && input.acknowledgeUnsupportedDatabases !== true) {
            throw new ManagedCheckpointPublishError('unsupported-database');
        }

        // Read the pointer before producing, so the compare-and-set below is
        // against a version this run actually reasoned about.
        let previous: { body: string; etag: string | null } | null;
        try {
            previous = await readCheckpointPointer({
                url: input.targets.pointer.getUrl,
                fetchImpl: input.fetchImpl,
            });
        } catch {
            throw new ManagedCheckpointPublishError('pointer-unreadable');
        }

        /*
         * Per area, not one word for both.
         *
         * A live run failed here with `stage-archive` and the two areas are
         * nothing alike — one is the project tree the executor writes, the other
         * is the provider's own home, with different owners, different contents
         * and different allowlists. Knowing which of them threw is the whole
         * question, and `createManagedCheckpoint` walks them in order, so the
         * first source that has not been archived yet is the one that failed.
         */
        const archived = new Set<CheckpointArea>();
        const product = await atStage(
            () => {
                const failing = input.sources.find((source) => !archived.has(source.area));
                if (failing?.area === 'project') return 'stage-archive-project';
                if (failing?.area === 'provider-state') return 'stage-archive-provider-state';
                return 'stage-archive';
            },
            () => createManagedCheckpoint({
            checkpointId: input.checkpointId,
            tenant: input.tenant,
            volume: input.volume,
            image: input.image,
            sources: input.sources,
            providerStateSessions: input.providerStateSessions,
            key: input.key,
            outputDir: input.workDir,
            now: input.now,
            onAreaArchived: (area) => archived.add(area),
        }));

        /*
         * 발행 **전에** 확인한다.
         *
         * provider state 를 담기로 한 runtime 이 그 세션의 native state 를 하나도
         * 담지 못했으면, 그 checkpoint 는 복구 가능성을 주장할 수 없다. 조용히
         * `saved` 로 나가면 그 사실은 복원할 때까지 아무도 모른다 — 실패는
         * 재시도되지만 **비어 있는 성공**은 발견되지 않는다.
         *
         * 업로드 전에 던지므로 store 에는 아무것도 남지 않는다.
         */
        if (input.sources.some((source) => source.area === 'provider-state')) {
            const required = input.providerStateSessions ?? [];
            if (required.length === 0) {
                throw new ManagedCheckpointPublishError('provider-state-coverage-unknown');
            }
            const covered = new Set<string>();
            for (const entry of product.manifest.entries) {
                if (entry.area !== 'provider-state') continue;
                /*
                 * **파일이어야 한다.** `sessions/<id>` 디렉터리 항목 하나만으로
                 * 덮였다고 세면, 빈 디렉터리가 커버리지를 만족시키고 pointer 까지
                 * 나간다 — root 가 그것을 재현했다. 디렉터리는 그 세션의 상태가
                 * 아니라 그 상태가 있었을 자리다.
                 *
                 * 파일 요구는 **잠정**이다: 어떤 native 경로가 세션 하나를
                 * 복구하는 데 충분한지는 Fable 의 매핑 설계와 Astra 리뷰 뒤에
                 * 정해진다. 그때까지는 "무언가 실제 내용이 담겼다" 가 최소선이다.
                 */
                /*
                 * 정규 파일이고, **내용이 있어야** 한다. 0바이트 파일은 디렉터리만
                 * 있는 경우와 같은 사실을 다르게 쓴 것이다 — 그 세션의 상태가
                 * 담기지 않았다는 것. 복원하면 이름만 있는 빈 파일이 나온다.
                 */
                if (entry.type !== 'file' || entry.bytes <= 0) continue;
                // `sessions/<id>/<something>` — 세션 축은 두 번째 세그먼트이고,
                // 그 아래에 실제 파일이 있어야 한다.
                const segments = entry.path.split('/');
                if (segments[0] === 'sessions' && segments.length >= 3) covered.add(segments[1]!);
            }
            if (required.some((session) => !covered.has(session))) {
                throw new ManagedCheckpointPublishError('provider-state-coverage-missing');
            }
        }

        for (const [area, filePath] of product.objects) {
            const target = input.targets.objects.get(area);
            if (!target) throw new ManagedCheckpointPublishError('target-missing');
            const sent = await putCheckpointObject({
                url: target.putUrl, filePath, ifAbsent: true, fetchImpl: input.fetchImpl,
            });
            await verifyCheckpointObject({
                url: target.headUrl,
                expect: { bytes: sent.bytes, md5: sent.md5 },
                fetchImpl: input.fetchImpl,
            });
        }

        // The manifest is sealed too: it carries the sanitized `.git/config`,
        // which is the project's content and not the store's business.
        const manifestPath = join(input.workDir, 'manifest.json.enc');
        await atStage(() => 'stage-manifest-seal', () => sealCheckpointBuffer({
            plaintext: Buffer.from(serializeManagedCheckpointManifest(product.manifest), 'utf8'),
            destination: manifestPath,
            key: input.key,
            binding: {
                tenantId: input.tenant.tenantId,
                projectId: input.tenant.projectId,
                checkpointId: input.checkpointId,
                area: 'manifest',
            },
        }));
        const sentManifest = await putCheckpointObject({
            url: input.targets.manifest.putUrl,
            filePath: manifestPath,
            ifAbsent: true,
            fetchImpl: input.fetchImpl,
        });
        await verifyCheckpointObject({
            url: input.targets.manifest.headUrl,
            expect: { bytes: sentManifest.bytes, md5: sentManifest.md5 },
            fetchImpl: input.fetchImpl,
        });

        const pointer: ManagedCheckpointPointer = {
            schemaVersion: MANAGED_CHECKPOINT_POINTER_VERSION,
            checkpointId: input.checkpointId,
            manifestDigest: product.manifestDigest,
            createdAtMs: input.now(),
        };
        if (previous && previous.etag === null) {
            // The pointer is there and the store did not say which version.
            // Falling back to `expectedEtag: null` would send create-if-absent
            // against an object that exists — a write that can only ever fail,
            // reported as a conflict with a checkpoint nobody published. There
            // is no safe compare-and-set without a version, so this says so.
            throw new ManagedCheckpointPublishError('pointer-unreadable');
        }
        /*
         * 마지막 관문, CAS **직전**이다. 업로드 검증까지 끝났고 아직 아무것도
         * 최신으로 선언되지 않은 이 지점만이 되돌릴 수 있는 마지막 순간이다.
         * pointer 를 쓴 뒤에 알아내면 이미 불안전한 checkpoint 가 최신이다.
         */
        if (input.providerState && !input.providerState.stillProven()) {
            throw new ManagedCheckpointProviderStateInvalidated();
        }
        const written = await putCheckpointPointer({
            url: input.targets.pointer.putUrl,
            body: JSON.stringify(pointer),
            expectedEtag: previous?.etag ?? null,
            fetchImpl: input.fetchImpl,
        });
        if (!written.ok) {
            // Another runtime published while this one was working. Its
            // checkpoint is the current one; overwriting it here would make an
            // arbitrary one of the two win.
            throw new ManagedCheckpointPublishError('pointer-conflict');
        }

        return {
            manifest: product.manifest,
            manifestDigest: product.manifestDigest,
            pointer,
            pointerEtag: written.etag,
            flush,
            /*
             * CAS 를 통과한 뒤 한 번 더, 아직 drain 을 들고 있는 지금 묻는다.
             * 위의 관문과 다른 질문이다 — 저것은 막을 수 있는 마지막 순간이고,
             * 이것은 HTTP 왕복 동안 무너졌는지다. 그때는 pointer 가 이미 실렸으니
             * 되돌릴 수 없고, 남는 일은 save 로 기록하지 않는 것뿐이다. 반환 뒤에 물으면 그 사이에
             * 들어온 tool write 하나가 방금 실린 checkpoint 를 거절로 바꾼다 —
             * archive 가 찍힌 창을 설명하는 답이 아니게 된다.
             */
            providerStateStillProven: input.providerState
                ? input.providerState.stillProven()
                : null,
        };
    } finally {
        held.release();
    }
}
