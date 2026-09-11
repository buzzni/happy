/**
 * The launcher's side of a managed launch: two phases, with the daemon's
 * registration in between.
 *
 * The runtime already had a two-phase launch — `prepare-launch` parks a
 * generation and returns its pid, the daemon records it, `release-launch` lets
 * it exec — but what it parked was the runtime's *fixed* workload with the
 * runtime's *fixed* environment. No tool broker, no provider plan, no executor
 * identity: the agent came up with none of the isolation the managed contract
 * is about. This is the piece that makes the parked generation the composed
 * one, without giving up the split.
 *
 * ## Why the two phases survive
 *
 * `launchManagedRun` does prepare, register and release in a single call — its
 * `register` callback is the daemon's bookkeeping, which in this architecture
 * lives in a different process. So `register` is wired to a gate that the
 * runtime opens when `release-launch` arrives. The composition still cannot
 * release before registration, and the daemon still cannot register before it
 * has a pid.
 *
 * ## The gate has two ends
 *
 * Opening the gate **is** the release: `register` returning is what lets the
 * supervisor exec. So a generation that must not run is folded by *rejecting*
 * the gate, not by opening it — a rejection propagates out of `onAcquired`,
 * which is exactly where the supervisor aborts the park and never execs.
 * Abandoning by opening the gate would launch the run the deadline was there
 * to prevent.
 *
 * ## What this module owns after the launch
 *
 * A composed run holds two things the supervisor knows nothing about: a tool
 * broker listening for this run, and a provider generation. Both belong to
 * whoever holds `{session, run}` — so this keeps them rather than dropping
 * them on the floor, and `close` is how a stop or a shutdown takes them down
 * with a real proof. A generation that could not be proven empty is reported
 * as unproven; it is never folded into a success.
 *
 * ## Fail closed
 *
 * A runtime with no managed configuration refuses. Launching anyway would run
 * the agent under the runtime's fixed workload with no broker and no separate
 * executor uid, which is worse than not launching: it looks like a managed run
 * and is not one.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { launchManagedRun, type ManagedRunLaunchDeps } from './managedRunLaunch';
import {
    ManagedProviderLaunchError,
    type ManagedProviderRun,
    type ObservedProviderExit,
    type ProviderRunSupervisor,
    type ProviderSupervisorConfig,
} from './managedProviderRun';
import type { ManagedToolSession } from './managedToolSession';
import type { StopOutcome } from './supervisor';
import type { GenerationKey } from './generationManifest';
import type { BrokerTool } from './toolBroker';
import type { ToolExecutorDeps } from './toolExecutor';
import type { ManagedSpawnEnvelope } from '@/managed/managedSpawnBootstrap';

/** What a runtime needs to know before it can launch a managed generation. */
export type ManagedGenerationLaunchConfig = {
    /** The active marker: its isolation axes are the run's. */
    identity: Parameters<typeof launchManagedRun>[0]['identity'];
    /** `executorHelper` — isolates one tool call. Not the generation helper. */
    toolHelperPath: string;
    /** `execHelper` — runs the provider generation. */
    providerHelperPath: string;
    /** The provider executable the generation script invokes. */
    execPath: string;
    tools: BrokerTool[];
    scope: string[];
    ttlMs: number;
    toolTimeoutMs: number;
    /**
     * The Happy this runtime was provisioned for, from the stored daemon
     * credential.
     *
     * Held here as well as inside `providerEnvironment` because the two do
     * different jobs: that one tells the child where its server is, this one
     * decides whether an envelope may be launched at all.
     */
    serverOrigin: string;
    /** Builds this run's provider environment from its verified envelope. */
    providerEnvironment: (envelope: ManagedSpawnEnvelope) => Record<string, string>;
    /** The generation's cgroup for a key. */
    cgroupPathFor: (key: GenerationKey) => string;
    /** Reads a generation cgroup's `cgroup.events`. Injected for tests only. */
    readCgroupEvents?: (path: string) => string;
    /** The provider's own state directory. Required before a codex run parks. */
    codexHome: string;
    /** Per-run supervisor, sharing the runtime's ledger and watchdog. */
    createProviderSupervisor: (config: ProviderSupervisorConfig) => ProviderRunSupervisor;
    /**
     * Told whenever something could not be proven stopped. The runtime decides
     * what that means; swallowing it here would leave a live generation
     * looking finished. Codes only — never a provider's text.
     */
    onUnprovenTermination: (info: { tool: string; detail?: string }) => void;
    writeFile: (file: { path: string; contents: string; mode: number }) => void;
    readProcEnviron: (pid: number) => Record<string, string>;
    lstatPath: Parameters<typeof launchManagedRun>[0]['lstatPath'];
    /** Shared with the checkpoint runner so writes and archives use one gate. */
    checkpointDrain?: Parameters<typeof launchManagedRun>[0]['checkpointDrain'];
    executorDeps?: ToolExecutorDeps;
    monotonicNow?: () => number;
    /** Test seam. Production uses the accepted composition. */
    launch?: typeof launchManagedRun;
};

export type ManagedGenerationPrepared =
    | { prepared: true; pid: number | null; handle: string }
    | { prepared: false; detail: string };

/** What a fold left behind. `terminated` is observed, never assumed. */
export type ManagedGenerationFolded = {
    released: false;
    terminated: boolean;
    detail: string;
};

export type ManagedGenerationClosed = { proven: boolean; detail: string };

export type ManagedGenerationRenewed =
    | { renewed: true; leaseExpiresMonotonic: number }
    | { renewed: false; detail: string };

/**
 * The supervisor instance that actually launched a generation.
 *
 * Its lease deadline lives in that instance, so it is the only one that can
 * refuse a renewal of a generation whose deadline has already passed. Asking a
 * different instance finds no deadline at all, and "no deadline" reads as
 * "nothing to refuse" — which resurrects an expired generation.
 */
type GenerationAuthority = ProviderRunSupervisor & {
    renewLease?: (input: {
        key: GenerationKey;
        renewalSeq: number;
        leaseExpiresMonotonic: number;
    }) => ManagedGenerationRenewed;
};

export type ManagedGenerationLauncher = {
    prepare: (input: {
        key: GenerationKey;
        envelope: ManagedSpawnEnvelope;
        leaseExpiresMonotonic: number;
        statusFd: number;
        releaseFd: number;
        inherit?: Array<{ childFd: number; parentFd: number }>;
    }) => Promise<ManagedGenerationPrepared>;
    release: (handle: string) => Promise<{ released: boolean; detail: string }>;
    /** Folds a parked generation without ever letting it exec. */
    abandon: (handle: string) => Promise<ManagedGenerationFolded>;
    /** Stops a released generation and takes its broker down. */
    close: (handle: string) => Promise<ManagedGenerationClosed>;
    /**
     * Same, for every generation this launcher still owns.
     *
     * One row per generation, each carrying its own proof. An unproven one
     * stays owned, so a later call retries it.
     */
    closeAll: () => Promise<Array<ManagedGenerationClosed & { handle: string }>>;
    /** Handles of released generations still owned here. */
    liveHandles: () => string[];
    /** The handle of a live generation for a key, if this launcher owns one. */
    handleForKey: (key: GenerationKey) => string | null;
    /**
     * Renews against the supervisor that launched this generation.
     *
     * `no-generation-authority` means this launcher never launched it — the
     * caller decides who else may answer, rather than this saying yes.
     */
    renewGeneration: (input: {
        key: GenerationKey;
        renewalSeq: number;
        leaseExpiresMonotonic: number;
    }) => ManagedGenerationRenewed;
    parkedCount: () => number;
    /**
     * What the helper's watcher actually saw of this generation's provider
     * leaving, or `null` for "not seen".
     *
     * A checkpoint that archives `provider-state` needs this: `null` and a
     * clean zero lead to different answers, and the launcher is the only place
     * that holds the observation.
     */
    observedProviderExit: (handle: string) => ObservedProviderExit | null;
    /**
     * How many generations this launcher has seen settle as `exec-attempted`.
     *
     * Read it as exactly that. It is **not** a count of workloads that ran:
     * `exec-attempted` says the helper reached the exec, not that anything
     * succeeded. A generation whose outcome is unknown, and one reconciled
     * from a previous runtime, are absent from it entirely — so zero here
     * never means "no provider ever wrote", and it is not evidence about
     * writers.
     *
     * It answers one question, which is the one the quiescence gate asks: did
     * the number change across a proof. A generation refused at setup ran
     * nothing, so counting it would invalidate a proof on the strength of a
     * provider that never existed.
     *
     * The increment happens when the launch promise settles, which is after
     * `prepare` returned. Admission therefore has to stay closed across
     * `prepare` and `release` too, not only across the exec — a proof taken
     * between them would miss a generation already on its way.
     */
    providerStarts: () => number;
    /**
     * Generations **this launcher still owns** that it can never produce an
     * exit observation for — kept alive by a failed launch or a failed stop,
     * with no run left to ask.
     *
     * Scoped to this launcher's own map, and that is the whole of it. A
     * generation reconciled from a previous runtime is handled straight off
     * the manifest and is never inserted here, so this number says nothing
     * about it. Runtime-wide coverage is the manifest's `listOpen`, and
     * anything asking "is every generation accounted for" must consult that
     * separately rather than reading this as the answer.
     */
    unobservableGenerations: () => number;
    /**
     * Refuses new generations and reports how many are already on their way.
     *
     * `providerStarts` only moves when a launch settles, which is after
     * `prepare` has returned — so a generation prepared but not yet released
     * is invisible to a restart check and would appear during a proof rather
     * than invalidating it. The window this closes is `prepare` to settle,
     * not the exec.
     *
     * Idempotent: closing an already-closed admission reports the same thing.
     */
    closeLaunchAdmission: () => { closed: boolean; inFlight: number };
    /** Lets generations be prepared again. Nothing may rely on a proof after. */
    reopenLaunchAdmission: () => void;
    /**
     * The generations this launcher currently owns, by identity.
     *
     * By identity and not by count. A generation's manifest record is closed
     * by `recordTermination` while it is still owned here — the broker close
     * follows, and a close that fails keeps it owned indefinitely — so the
     * manifest's open set and this set are not nested. Comparing their sizes
     * cancels a closed-but-owned generation against an unrelated open one and
     * reports full coverage while a generation nobody is watching stays open.
     */
    ownedGenerationKeys: () => GenerationKey[];
    /**
     * The live generations, as the things that can be asked to end their
     * input.
     *
     * Only generations this launcher actually launched appear here: one kept
     * alive by a failed launch has no run to ask, and `endInput` must not
     * report an end for a generation nothing spoke to.
     */
    liveGenerations: () => Array<{
        /**
         * This generation's own key, assigned when the entry was created.
         *
         * Carried out so an answer can be kept **against the generation that
         * gave it**. The alternative — pairing answers with
         * `ownedGenerationKeys()` by position — pairs two different
         * populations: a generation whose manifest record is closed is still
         * owned there while having no run left to speak to, so the lists differ
         * in length and in order exactly when something has gone wrong.
         */
        handle: string;
        /**
         * This generation's identity, copied out of its own entry.
         *
         * Carried so a terminal answer stays attached to the generation that
         * gave it all the way to whatever matches it against a signed parent
         * inventory — with no reverse lookup, and no pairing against
         * `ownedGenerationKeys()`, which is a different population.
         */
        key: GenerationKey;
        awaitGracefulStop: (budgetMs: number) => Promise<{
            stopped: boolean;
            detail: string;
            /** The native session this generation named, as it spelled it. */
            nativeId?: string;
            /** It named two. Neither is usable; see `managedProviderRun`. */
            identity?: 'conflict';
        }>;
    }>;
    /**
     * How many live generations still have something alive in them.
     *
     * Non-destructive, which is the point: `stop()` proves emptiness by
     * killing the cgroup, and a checkpoint needs to know *before* it archives
     * whether anything could still be writing.
     *
     * A cgroup the kernel has removed counts as empty — it only removes empty
     * ones, so that is an observation. A read that fails any other way counts
     * as **one writer**, because the alternative is reporting quiet nobody saw.
     */
    writersRemaining: () => Promise<number>;
};

type Parked = {
    openGate: () => void;
    failGate: (error: Error) => void;
    settled: Promise<Settled>;
    /** The launch's own rejection, kept because `settled` maps it to a value. */
    launchError: () => unknown;
};

/** `terminated` is present only where a stop was actually observed. */
type Settled = { released: boolean; detail: string; terminated?: boolean };

/**
 * A generation this launcher is still answerable for.
 *
 * Not only released ones: a fold whose stop was never observed stays here too.
 * Dropping it would leave a possibly-live generation that no later `close` or
 * `closeAll` can reach, and would let a shutdown see an empty map and conclude
 * there was nothing left to take down.
 */
type Live = {
    key: GenerationKey;
    stop: () => Promise<StopOutcome>;
    /** Asked, never copied: the run records the exit whenever it happens. */
    observedExit?: () => ObservedProviderExit | null;
    /** Present only for a generation this launcher launched and can speak to. */
    awaitGracefulStop?: (budgetMs: number) => Promise<{
        stopped: boolean;
        detail: string;
        nativeId?: string;
        identity?: 'conflict';
    }>;
    /** `null` once the broker has been proven down; the stop may still be open. */
    close: (() => Promise<{ proven: boolean; detail: string }>) | null;
};

/**
 * Two origins are the same server.
 *
 * Parsed rather than string-compared so that a trailing slash or a default
 * port does not read as a different Happy — and an unparseable value is never
 * the same as anything, rather than throwing here.
 */
export function sameManagedOrigin(a: string, b: string): boolean {
    try {
        return new URL(a).origin === new URL(b).origin;
    } catch {
        return false;
    }
}

const keyOf = (key: GenerationKey): string => `${key.runId}\x00${key.attemptId}\x00${key.epoch}`;

/** Only a code. A provider's or a store's text is not the daemon's to receive. */
function codeOf(error: unknown): string {
    const code = (error as { code?: unknown })?.code;
    return typeof code === 'string' ? code : 'launch-failed';
}

export function createManagedGenerationLauncher(
    config: ManagedGenerationLaunchConfig,
): ManagedGenerationLauncher {
    const launch = config.launch ?? launchManagedRun;
    const parked = new Map<string, Parked>();
    const live = new Map<string, Live>();
    let providerStarts = 0;
    /**
     * Launches that have begun and not yet settled.
     *
     * Counted separately from `parked`: a released generation leaves the
     * parked map immediately but its launch settles later, and that gap is
     * exactly where a start would otherwise go unseen.
     */
    let launchesInFlight = 0;
    let admissionClosed = false;
    /** The launching supervisor per generation. Dropped only with its proof. */
    const authorities = new Map<string, GenerationAuthority>();

    /**
     * Takes a generation down and reports what was actually observed.
     *
     * **The handle is given up only against proof.** Deleting it first and
     * then failing would leave nothing for a later `close` or `closeAll` to
     * retry, and would let a shutdown read the empty map as "nothing left".
     * What was proven is remembered so a retry does not close a broker twice.
     */
    const closeLive = async (handle: string): Promise<ManagedGenerationClosed> => {
        const entry = live.get(handle);
        if (!entry) return { proven: false, detail: 'unknown-handle' };
        // The generation first: closing the broker while the provider is still
        // running takes the tools away from a live child.
        let stopped = await entry.stop().catch(() => ({ stopped: false as const, detail: 'stop-failed' }));
        if (!stopped.stopped) {
            // One retry. A first attempt that observes nothing is common, and
            // folding it into "stopped" is how a live child is recorded as gone.
            stopped = await entry.stop().catch(() => ({ stopped: false as const, detail: 'stop-failed' }));
        }
        const closed = entry.close === null
            ? { proven: true, detail: 'already-closed' }
            : await entry.close().catch(() => ({ proven: false, detail: 'close-failed' }));
        if (!stopped.stopped) config.onUnprovenTermination({ tool: 'generation', detail: stopped.detail });
        if (!closed.proven) config.onUnprovenTermination({ tool: 'session', detail: closed.detail });
        if (stopped.stopped && closed.proven) {
            live.delete(handle);
            authorities.delete(keyOf(entry.key));
            return { proven: true, detail: 'observed-empty' };
        }
        // Still owned. A broker already proven down is not closed again.
        live.set(handle, { ...entry, close: closed.proven ? null : entry.close });
        return { proven: false, detail: stopped.stopped ? closed.detail : stopped.detail };
    };

    /**
     * A run that was set up but never exec'd still opened a broker and a
     * grant. `startManagedProviderRun` already asked the generation to stop but
     * discards the answer, so this asks again — and keeps the handle if the
     * answer is not a proof.
     */
    const discard = async (
        started: { session: ManagedToolSession; run: ManagedProviderRun },
        kind: string,
        handle: string,
        key: GenerationKey,
    ): Promise<Settled> => {
        live.set(handle, { key, stop: () => started.run.stop(), close: () => started.session.close() });
        const proof = await closeLive(handle);
        return { released: false, detail: kind, terminated: proof.proven };
    };

    return {
        observedProviderExit(handle) {
            return live.get(handle)?.observedExit?.() ?? null;
        },
        providerStarts: () => providerStarts,
        closeLaunchAdmission() {
            admissionClosed = true;
            /*
             * `parked` is deliberately not added. A parked generation always
             * has an unsettled launch behind it, so it is already counted
             * here — adding both reports one generation as two and makes an
             * idle runtime look busy to whoever is waiting for it.
             */
            return { closed: true, inFlight: launchesInFlight };
        },
        reopenLaunchAdmission() {
            admissionClosed = false;
        },
        ownedGenerationKeys: () => [...live.values()].map((entry) => entry.key),
        liveGenerations: () => [...live.entries()].flatMap(([handle, entry]) => (entry.awaitGracefulStop
            // Copied, not shared: the caller holds this across awaits, and an
            // entry replaced meanwhile must not rewrite an answer already given.
            ? [{ handle, key: { ...entry.key }, awaitGracefulStop: entry.awaitGracefulStop }]
            : [])),
        async writersRemaining() {
            const read = config.readCgroupEvents
                ?? ((path: string) => readFileSync(join(path, 'cgroup.events'), 'utf8'));
            let remaining = 0;
            for (const entry of live.values()) {
                try {
                    if (!/^populated 0$/m.test(read(config.cgroupPathFor(entry.key)))) remaining += 1;
                } catch (error) {
                    // Removed by the kernel, which only removes empty ones.
                    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
                    remaining += 1;
                }
            }
            return remaining;
        },
        unobservableGenerations: () => {
            let unobservable = 0;
            for (const entry of live.values()) if (!entry.observedExit) unobservable += 1;
            return unobservable;
        },
        async prepare(input) {
            const now = (config.monotonicNow ?? (() => Number(process.hrtime.bigint() / 1_000_000n)))();
            const remainingLeaseMs = input.leaseExpiresMonotonic - now;
            if (remainingLeaseMs <= 0) {
                // Nothing to launch into: the write lease is already gone.
                return { prepared: false, detail: 'lease-already-expired' };
            }
            /*
             * Before anything exists to clean up.
             *
             * An envelope naming another Happy is not a variant of this run —
             * it asks the runtime to hand this generation's scoped token to a
             * server the operator never provisioned, while `HAPPY_SERVER_URL`
             * still says ours. Refused here rather than at the child, because
             * by the time a bootstrap fd is inherited that document already
             * carries the token.
             *
             * Compared against the stored origin, never against the envelope's
             * own field: an envelope checked against itself always agrees.
             */
            if (!sameManagedOrigin(input.envelope.bootstrap.serverOrigin, config.serverOrigin)) {
                // The axis only. Neither origin is this daemon's to echo, and
                // the token travels beside them.
                return { prepared: false, detail: 'envelope-origin-untrusted' };
            }

            if (admissionClosed) {
                // A checkpoint is holding the runtime still. Refused rather
                // than queued: the caller retries, and a generation parked
                // behind a proof would start the moment the proof was taken.
                return { prepared: false, detail: 'launch-admission-closed' };
            }

            const grantTtl = Math.min(config.ttlMs, remainingLeaseMs);

            const handle = randomBytes(16).toString('hex');
            let openGate: () => void = () => undefined;
            let failGate: (error: Error) => void = () => undefined;
            const gate = new Promise<void>((resolve, reject) => { openGate = resolve; failGate = reject; });
            let parkedPid: number | null = null;
            let signalParked: () => void = () => undefined;
            const parkedSignal = new Promise<void>((resolve) => { signalParked = resolve; });

            const running = launch({
                identity: config.identity,
                request: {
                    agent: input.envelope.agent as never,
                    model: input.envelope.model,
                    ...(input.envelope.effort ? { effort: input.envelope.effort } : {}),
                    providerEnv: config.providerEnvironment(input.envelope),
                    /*
                     * `planProviderLaunch` refuses a codex run without a
                     * run-private codex home — before the park, so the refusal
                     * arrives as a launch failure rather than as a codex that
                     * reads somebody else's provider config.
                     */
                    ...(input.envelope.agent === 'codex' ? { codexHome: config.codexHome } : {}),
                    tools: config.tools,
                    scope: config.scope,
                    /*
                     * The grant cannot outlive the right to write. A tool grant
                     * still valid after the lease has gone is a run whose tools
                     * work after it has lost permission to touch the volume, so
                     * the lease is the authority and the configured value can
                     * only shorten it.
                     */
                    ttlMs: grantTtl,
                    toolTimeoutMs: config.toolTimeoutMs,
                },
                cgroupPath: config.cgroupPathFor(input.key),
                toolHelperPath: config.toolHelperPath,
                providerHelperPath: config.providerHelperPath,
                execPath: config.execPath,
                key: input.key,
                statusFd: input.statusFd,
                releaseFd: input.releaseFd,
                leaseExpiresMonotonic: input.leaseExpiresMonotonic,
                // Captured, because this instance holds the generation's lease
                // deadline and is the only one that can refuse a renewal of it.
                createSupervisor: (supervisorConfig: ProviderSupervisorConfig) => {
                    const created = config.createProviderSupervisor(supervisorConfig);
                    authorities.set(keyOf(input.key), created as GenerationAuthority);
                    return created;
                },
                writeFile: config.writeFile,
                readProcEnviron: config.readProcEnviron,
                lstatPath: config.lstatPath,
                ...(input.inherit ? { inherit: input.inherit } : {}),
                onUnprovenTermination: config.onUnprovenTermination,
                // The daemon registers between the phases; this is where the
                // composition waits for it. Rejecting aborts the park.
                register: async (pid: number) => {
                    parkedPid = pid;
                    signalParked();
                    await gate;
                },
                ...(config.checkpointDrain ? { checkpointDrain: config.checkpointDrain } : {}),
                ...(config.executorDeps ? { executorDeps: config.executorDeps } : {}),
                ...(config.monotonicNow ? { monotonicNow: config.monotonicNow } : {}),
            } as Parameters<typeof launchManagedRun>[0]);

            // From here until the launch settles, this generation exists as
            // far as a quiescence proof is concerned, whatever the outcome.
            launchesInFlight += 1;
            let launchError: unknown = null;
            const settled: Promise<Settled> = running.then(
                async (started) => {
                    // `exec-attempted` is the only outcome where anything ran.
                    // Reporting the others as released would put a run that was
                    // refused at setup into the ledger as launched.
                    if (started.run.outcome.kind !== 'exec-attempted') {
                        return discard(started, started.run.outcome.kind, handle, input.key);
                    }
                    providerStarts += 1;
                    live.set(handle, {
                        key: input.key,
                        stop: () => started.run.stop(),
                        close: () => started.session.close(),
                        observedExit: started.run.observedExit,
                        awaitGracefulStop: started.run.awaitGracefulStop,
                    });
                    return { released: true, detail: 'exec-attempted' };
                },
                (error: unknown) => {
                    launchError = error;
                    /*
                     * Retained here, not in `abandon`. This rejection is also
                     * how an ordinary `prepare` or `release` fails, and those
                     * paths just return — so a generation whose stop was never
                     * observed would be dropped with nothing left to retry it.
                     * `launchManagedRun` has already closed the broker on this
                     * path, so only the generation is still in question.
                     */
                    if (error instanceof ManagedProviderLaunchError && !error.stopOutcome.stopped) {
                        live.set(handle, { key: error.key, stop: error.stop, close: null });
                    }
                    return { released: false, detail: codeOf(error) };
                },
            ).finally(() => {
                // Settled either way. Whatever it became — a start, a discard,
                // or a generation still owned — it is no longer on its way.
                launchesInFlight -= 1;
            });

            // Whichever comes first: parked, or the whole thing failing before
            // it got that far.
            const outcome = await Promise.race([
                parkedSignal.then(() => 'parked' as const),
                settled.then(() => 'settled' as const),
            ]);
            if (outcome === 'settled') {
                const result = await settled;
                return { prepared: false, detail: result.detail };
            }

            parked.set(handle, { openGate, failGate, settled, launchError: () => launchError });
            return { prepared: true, pid: parkedPid, handle };
        },

        async release(handle) {
            const entry = parked.get(handle);
            // One use only: the same handle cannot release twice.
            if (!entry) return { released: false, detail: 'unknown-handle' };
            parked.delete(handle);
            entry.openGate();
            const result = await entry.settled;
            return { released: result.released, detail: result.detail };
        },

        async abandon(handle) {
            const entry = parked.get(handle);
            if (!entry) return { released: false, terminated: false, detail: 'unknown-handle' };
            parked.delete(handle);
            /*
             * Rejected, not opened. The rejection travels out of `onAcquired`,
             * which is where the supervisor aborts the park — the child is
             * killed before `execve` instead of being let go.
             */
            const abandoned = new Error('generation abandoned');
            entry.failGate(abandoned);

            const result = await entry.settled;
            // The abort path comes back as an outcome, not a throw: the
            // composition already stopped the generation and closed the
            // broker, and `terminated` is what it observed doing so.
            if (result.terminated !== undefined) {
                return { released: false, terminated: result.terminated, detail: result.detail };
            }
            const error = entry.launchError();

            if (error instanceof ManagedProviderLaunchError && error.stopOutcome.stopped) {
                // The evidence that came with the throw is a proof.
                return { released: false, terminated: true, detail: result.detail };
            }
            if (!live.has(handle)) {
                // No typed stop evidence came back with the failure, so nothing
                // was retained. Whether the generation is empty is not
                // something to assume.
                config.onUnprovenTermination({ tool: 'generation', detail: result.detail });
                return { released: false, terminated: false, detail: result.detail };
            }
            // Retained by the rejection handler; finish it here with proof.
            const proof = await closeLive(handle);
            return { released: false, terminated: proof.proven, detail: result.detail };
        },

        close: closeLive,

        async closeAll() {
            const results: Array<ManagedGenerationClosed & { handle: string }> = [];
            for (const handle of Array.from(live.keys())) {
                results.push({ handle, ...(await closeLive(handle)) });
            }
            return results;
        },

        liveHandles: () => Array.from(live.keys()),

        handleForKey(key) {
            const wanted = keyOf(key);
            for (const [handle, entry] of live) {
                if (keyOf(entry.key) === wanted) return handle;
            }
            return null;
        },

        renewGeneration({ key, renewalSeq, leaseExpiresMonotonic }) {
            const authority = authorities.get(keyOf(key));
            if (!authority) return { renewed: false, detail: 'no-generation-authority' };
            if (!authority.renewLease) return { renewed: false, detail: 'renew-unsupported' };
            return authority.renewLease({ key, renewalSeq, leaseExpiresMonotonic });
        },

        parkedCount: () => parked.size,
    };
}

export type { ManagedRunLaunchDeps };
