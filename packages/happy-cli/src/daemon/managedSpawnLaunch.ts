/**
 * The daemon's half of a managed launch.
 *
 * `managed:spawn` used to go through `spawnSession`, which is the ordinary
 * daemon spawn: a detached `happy` child, in the daemon's own environment,
 * with none of the isolation the managed contract is about. The supervisor was
 * only ever asked fencing questions. This is the part that actually routes the
 * spawn through it.
 *
 * The launcher's launch is two-phase — `prepare-launch` parks a generation and
 * returns its pid, `release-launch` lets it exec — and the daemon's
 * registration goes **between** them. That order is the point: a child that
 * runs before the daemon knows its pid is a child nobody can stop.
 *
 * ## What a failure is allowed to claim
 *
 * `started: false` is the only thing that lets a run be recorded as failed, so
 * it is returned only where nothing can have exec'd:
 *
 * - the supervisor is not wired at all, or
 * - `prepare-launch` refused — a park happens before `execve`, so a refusal to
 *   park is a refusal to run.
 *
 * Everything after the park is uncertain and says so, because the gate may
 * already have been opened by the time the answer got back. A reconciliation
 * pass decides what happened; this path does not guess.
 *
 * Nothing here carries the envelope's content. It holds a scoped bearer and
 * the session's raw key, so what crosses back is a pid, a session id that the
 * parent already chose, and a short code.
 */
import { randomBytes } from 'node:crypto';

import {
    encodeManagedReportCredential,
    type ManagedReportCredential,
} from './launch/managedReportCredential';

/** A name for one launch. Safe id characters, because the registry keys on it. */
const makeLaunchId = (): string => randomBytes(16).toString('hex');

import type { ManagedSpawnContext, ManagedSpawnOutcome } from './managedRpcHandlers';

/** The part of the launcher client this path uses. */
export type ManagedLaunchBackend = {
    /**
     * Asks the supervisor to stop a generation. The answer is a proof: it is
     * `requested: true` only where the generation was observed empty.
     */
    requestStop: (key: { runId: string; attemptId: string; epoch: number })
        => Promise<{ requested: boolean; detail: string }>;
    prepareLaunch: (request: {
        key: { runId: string; attemptId: string; epoch: number };
        leaseExpiresMonotonic: number;
        bootstrap: Buffer;
        reportCredential: Buffer;
    }) => Promise<{ prepared: true; pid: number | null; handle: string } | { prepared: false; detail: string }>;
    releaseLaunch: (handle: string) => Promise<{ released: boolean; detail: string }>;
};

export type ManagedSpawnLaunchInput = {
    /** Absent when the boot path bound no supervisor. Then nothing launches. */
    backend: ManagedLaunchBackend | null;
    context: ManagedSpawnContext;
    /**
     * Daemon bookkeeping for the parked child, run **before** it is released.
     * The session id is the parent's — the envelope carries an already-created
     * session — so this never creates one.
     */
    register: (entry: {
        pid: number;
        sessionId: string;
        /** Names this launch in the report registry. */
        launchId: string;
        /** Signs this launch's reports. Never logged, never in an environment. */
        secret: Buffer;
        /**
         * The envelope's own encryption identity.
         *
         * The child reports the key it was given, and the registry compares.
         * Registering without it makes every legitimate report look like a
         * session whose envelope was swapped — `encryption-mismatch` — so the
         * value comes from the envelope rather than from the first report.
         */
        encryption: { encryptionKey: string; encryptionVariant: 'legacy' | 'dataKey' };
    }) => void;
    /** Undoes `register` when the release did not happen. */
    unregister: (entry: { pid: number }) => void;
    /**
     * Waits for the child to report itself, and says which session it reported.
     *
     * Called **before** the release, because the report can arrive the instant
     * the child execs; arming afterwards races the very thing being waited
     * for. `exec-attempted` is not a running agent — the helper can die between
     * the ACK and `execve` — so the old contract's "success" was a child that
     * had reported in, and this is what keeps it.
     */
    waitForChildReady: (pid: number) => Promise<
        { ready: true; sessionId: string } | { ready: false; detail: string }
    >;
    /**
     * Where this launch reports. Loopback, and the child's only route — it
     * cannot read the daemon's state file across uids.
     */
    reportBaseUrl: string;
};

export async function launchManagedSpawn(input: ManagedSpawnLaunchInput): Promise<ManagedSpawnOutcome> {
    if (!input.backend) {
        // Falling back to an ordinary daemon spawn here is the failure this
        // whole path exists to prevent: it would look like a managed run.
        return { type: 'error', errorMessage: 'launcher-unavailable', started: false };
    }
    const { context } = input;
    const sessionId = context.envelope.bootstrap.sessionId;

    /*
     * Minted **before** the launch, because the child has to receive it — and
     * the only moment anything reaches this child is the descriptors the
     * launcher inherits to it at `prepare-launch`. A secret minted afterwards
     * could only travel through the environment, where every tool call the
     * agent makes would inherit it.
     *
     * It rides on its own document rather than inside the envelope: the
     * envelope is the parent's, signed and re-parsed precisely so nothing the
     * parent did not validate can be smuggled in with it.
     */
    const credential: ManagedReportCredential = {
        launchId: makeLaunchId(),
        secret: randomBytes(32),
        reportBaseUrl: input.reportBaseUrl,
    };

    const prepared = await input.backend.prepareLaunch({
        key: { runId: context.runId, attemptId: context.attemptId, epoch: context.epoch },
        leaseExpiresMonotonic: context.leaseExpiresMonotonic,
        bootstrap: context.bootstrapEnvelope,
        reportCredential: encodeManagedReportCredential(credential),
    });
    if (!prepared.prepared) {
        return { type: 'error', errorMessage: `launch-refused:${prepared.detail}`, started: false };
    }
    if (prepared.pid === null) {
        // Parked with no pid to register. Releasing it would put a child
        // beyond the daemon's reach, so it is left for the supervisor's
        // release deadline — which means its fate is not ours to claim.
        return { type: 'error', errorMessage: 'prepared-without-pid' };
    }

    // The same identity the child was handed. A registry entry under a
    // different id would refuse every report the child actually signs.
    input.register({
        pid: prepared.pid,
        sessionId,
        launchId: credential.launchId,
        secret: credential.secret,
        encryption: {
            encryptionKey: context.envelope.bootstrap.rawKeyBase64,
            encryptionVariant: context.envelope.bootstrap.encryptionVariant,
        },
    });
    // Armed before the gate opens, never after.
    const ready = input.waitForChildReady(prepared.pid);
    const released = await input.backend.releaseLaunch(prepared.handle);
    if (!released.released) {
        // The gate may have been opened before the answer came back. The
        // registration goes away, but the outcome stays reconcilable.
        void ready.catch(() => undefined);
        input.unregister({ pid: prepared.pid });
        return { type: 'error', errorMessage: `release-failed:${released.detail}` };
    }

    const reported = await ready.catch(() => ({ ready: false as const, detail: 'child-ready-failed' }));
    if (!reported.ready) {
        // Released and then silent. The child may be running, so the run stays
        // reconcilable rather than being closed as failed.
        return { type: 'error', errorMessage: `child-not-ready:${reported.detail}` };
    }
    if (reported.sessionId !== sessionId) {
        /*
         * The parent already created this session and the envelope names it.
         * A child reporting a different one means two records claim this run,
         * and accepting either would attach the receipt to the wrong one.
         */
        return { type: 'error', errorMessage: 'child-reported-another-session' };
    }
    return { type: 'success', sessionId, pid: prepared.pid };
}

/**
 * The daemon's stop for a managed generation.
 *
 * A signal to the tracked pid is **not** a stop. That pid is the provider the
 * supervisor parked; the run's tools execute in the generation's cgroup under
 * a different uid, and the broker that grants them is held by the launcher.
 * `SIGTERM` to one process leaves both, and leaves no proof either way. The
 * supervisor is the only side that can kill the generation and observe it
 * empty, and taking the broker down with it is part of the same call.
 */
export async function stopManagedGeneration(input: {
    backend: Pick<ManagedLaunchBackend, 'requestStop'> | null;
    key: { runId: string; attemptId: string; epoch: number };
}): Promise<{ stopped: boolean; detail: string }> {
    if (!input.backend) {
        // No supervisor, no proof. Signalling the pid instead would report a
        // stop nobody observed.
        return { stopped: false, detail: 'launcher-unavailable' };
    }
    const outcome = await input.backend.requestStop(input.key);
    return { stopped: outcome.requested, detail: outcome.detail };
}

export type ManagedStopRoute =
    /** Not a managed runtime: the ordinary daemon stop path applies. */
    | { route: 'signal' }
    | { route: 'supervisor'; key: { runId: string; attemptId: string; epoch: number } }
    /** A managed session whose generation identity this daemon does not hold. */
    | { route: 'refuse'; detail: string };

/**
 * Which stop a tracked session is allowed to get.
 *
 * On a managed runtime every session is a managed generation, so none of them
 * may be stopped by signalling a pid. A daemon restart hydrates tracked
 * sessions from disk but not the generation identity — that belongs to the
 * supervisor — so a restarted daemon knows the pid and not the run. Falling
 * through to a signal there would stop neither the generation's tools nor its
 * broker, and would prove nothing either way, so it is refused instead:
 * `managed:stop` carries the verified run identity and is the way in.
 */
export function decideManagedStopRoute(input: {
    managedRuntimeActive: boolean;
    key: { runId: string; attemptId: string; epoch: number } | undefined;
}): ManagedStopRoute {
    if (input.key) return { route: 'supervisor', key: input.key };
    if (input.managedRuntimeActive) return { route: 'refuse', detail: 'unknown-generation' };
    return { route: 'signal' };
}
