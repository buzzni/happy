/**
 * Builds the lesson host a provider process uses for its own session.
 *
 * The daemon and the provider run in different processes, so the daemon's
 * supervisor is not reachable from a turn loop. This builds an equivalent one
 * here, and it is allowed to because everything it needs is already trusted in
 * this process:
 *
 *  - the **project id** comes from `HAPPY_CHECKPOINT_SPAWN_CONTEXT`, which the
 *    daemon writes and strips from caller-supplied environment, and which it
 *    only writes when it had an authoritative project binding;
 *  - the **workspace** is never taken from `cwd` or from that context. It is
 *    requested from the studio, which signs the project's own directory;
 *  - the **identity** is this run's account bearer, so a managed run — which
 *    has no account credential — gets nothing at all.
 *
 * Every absence returns `null`. A session without a lesson host runs exactly
 * as it did before this existed.
 */
import { resolve } from 'node:path';

import { logger } from '@/ui/logger';
import { readLessonOwner } from './lessonOwnerMarker';
import { readCheckpointSpawnContext } from '@/checkpoint/checkpointSpawnContext';

import { createLessonHostSupervisor } from './lessonHostSupervisor';
import {
    createLessonGrantVerifier,
    lessonGrantAudience,
} from './lessonGrantVerifier';
import {
    fetchLessonGrantPublicKey,
    requestLessonSnapshotGrant,
    type LessonHostRuntime,
} from './lessonHostRuntime';
import { createLessonTurnHost, type LessonTurnHost } from './lessonTurnHost';
import { createLessonReviewWorker, type LessonReviewWorker } from './lessonReviewWorker';
import { LessonReviewBudget } from './lessonReviewBudget';
import {
    createLessonReviewOutcomeStore,
    createLessonSettingsStore,
    lessonReviewLedgerPath,
    lessonReviewOutcomePath,
    lessonSettingsPath,
} from './lessonSettingsStore';
import type { LessonGatewayConfig, LessonPriceQuote } from './lessonReviewGateway';
import type { LessonTurnKind } from './lessonTurnEvidence';

/**
 * How long the whole bootstrap may take.
 *
 * Building this host makes three network calls — the verification key, the
 * snapshot grant, the store open. None of them is on the recall budget, so a
 * slow or unreachable studio would hold the first turn open for as long as the
 * socket took. The deadline bounds the whole sequence and a session that
 * misses it simply runs without lessons.
 */
export const LESSON_SESSION_BOOTSTRAP_BUDGET_MS = 3_000;

/**
 * How long a lease refresh may take on a turn's path.
 *
 * Short: it sits inside the recall budget, and a slow answer means this turn
 * runs without lessons rather than waits.
 */
export const LESSON_AUTHORIZE_BUDGET_MS = 500;

export interface LessonSessionHost {
    turn: LessonTurnHost | null;
    review: LessonReviewWorker | null;
    /**
     * What kind of session this is, decided from the daemon's own markers.
     *
     * The turn loop does not guess per message: an automation run is marked
     * when the daemon spawns it, and that mark is what keeps automation and
     * review turns from teaching the project.
     */
    sessionKind: LessonTurnKind;
    close(): Promise<void>;
}

/**
 * Reads the session kind from the environment the daemon wrote.
 *
 * `HAPPY_AUTOMATION_RUN_ONCE` and `HAPPY_AUTOMATION_RESUME_PROMPT` are set by
 * the daemon for automation runs; both are consumed by the runner before any
 * agent code executes, so this is read at construction while they are still
 * present. Absence means an ordinary session — the same reading the rest of
 * the runner already makes.
 */
/**
 * The state root the daemon uses for this machine.
 *
 * Written by the daemon into every session's environment so a provider can
 * tell whether it shares the daemon's root. Read-only here; a provider that
 * disagrees with it does not get to pick.
 */
export const LESSON_DAEMON_HOME_ENV = 'HAPPY_LESSON_DAEMON_HOME';

/**
 * The state root this session's lesson settings and ledger come from.
 *
 * Not the provider's own `HAPPY_HOME_DIR`. The daemon relocates that per
 * session for a collaborator's credentials, and both the settings file and the
 * spending ledger must be the machine's, not the session's: a private settings
 * file would miss the UI's "recall off" and default back to on, and a private
 * ledger would make the machine-wide budget stop bounding anything.
 *
 * So the daemon states its own root and every session uses it. This is a
 * *state* location only — the credential, the signed actor and the permissions
 * are unaffected, and a collaborator's session still acts as that
 * collaborator.
 *
 * `null` when the daemon said nothing. That is an old daemon or a runner
 * started outside one, and it is reported as unsupported rather than guessed:
 * a guess here silently re-enables recall for a user who turned it off.
 */
export function lessonStateRoot(env: NodeJS.ProcessEnv): string | null {
    const daemonHome = env[LESSON_DAEMON_HOME_ENV]?.trim();
    return daemonHome ? resolve(daemonHome) : null;
}

export function readLessonSessionKind(env: NodeJS.ProcessEnv): LessonTurnKind {
    return env.HAPPY_AUTOMATION_RUN_ONCE || env.HAPPY_AUTOMATION_RESUME_PROMPT === '1'
        ? 'automation'
        : 'foreground';
}

/** Reads the studio origin the daemon configured. Never a request value. */
function studioOrigin(env: NodeJS.ProcessEnv): string | null {
    const configured = env.HAPPY_APLUS_MCP_CONFIG_URL;
    if (!configured) return null;
    try {
        return new URL(configured).origin;
    } catch {
        return null;
    }
}

/**
 * Asks the studio for this project's gateway and its settled price.
 *
 * Returns null on anything short of a complete, priced answer: an unpriced
 * gateway is not a cheaper gateway, it is one nothing may be spent against.
 */
async function readGateway(input: {
    studioBaseUrl: string;
    token: string;
    machineId: string;
    projectId: string;
    /** The caller this session acts as; the studio's answer must agree. */
    userId: string;
}): Promise<{ config: LessonGatewayConfig; quote: LessonPriceQuote; defaultModel: string } | null> {
    const url = new URL(
        `/api/projects/${encodeURIComponent(input.projectId)}/lesson-gateway/config`,
        input.studioBaseUrl,
    );
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    timer.unref?.();
    try {
        const response = await fetch(url.toString(), {
            method: 'POST',
            redirect: 'error',
            signal: controller.signal,
            headers: {
                Authorization: `Bearer ${input.token}`,
                'X-Aplus-Machine-Id': input.machineId,
                'Content-Type': 'application/json',
            },
        });
        if (!response.ok) return null;
        const body = await response.json() as {
            configured?: unknown;
            gateway?: { baseUrl?: unknown; model?: unknown; apiKey?: unknown; gatewayProjectId?: unknown; actorUserId?: unknown };
            quote?: LessonPriceQuote;
        };
        if (body.configured !== true || !body.gateway || !body.quote) return null;
        const { baseUrl, model, apiKey, gatewayProjectId, actorUserId } = body.gateway;
        if (typeof baseUrl !== 'string' || typeof apiKey !== 'string'
            || typeof gatewayProjectId !== 'string' || typeof model !== 'string') return null;
        /*
         * The studio says which caller it resolved this config for. If that is
         * not the caller this session runs as, the credential belongs to a
         * different attribution and must not be used here.
         */
        if (actorUserId !== input.userId) return null;
        /*
         * `model` is dropped from the config on purpose.
         *
         * It is the gateway's registered default, and it is needed to check
         * that a price exists for what will actually be called — which the
         * caller does below, against the quote. Sending it as the request
         * model would pin every review to that value even after an operator
         * changes the default, so the request omits it and the gateway applies
         * its own.
         */
        return {
            config: { baseUrl, apiKey, projectId: gatewayProjectId },
            quote: body.quote,
            defaultModel: model,
        };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Starts the bootstrap in the background and returns a host immediately.
 *
 * The bootstrap makes three authenticated calls. Awaiting them before the
 * first turn meant a cold or slow studio could add its whole budget to that
 * turn on top of the recall budget — and worse, a single slow call lost
 * lessons for the *entire session* rather than for one turn.
 *
 * So the session starts at once with a host whose turn and review surfaces
 * answer `unsupported` until the real one is ready, and every later turn uses
 * it. Nothing blocks, and a slow start costs one turn's recall rather than the
 * session's memory.
 */
export function createLazyLessonSessionHost(
    input: Parameters<typeof createLessonSessionHost>[0] & {
        /**
         * The bootstrap to run, for tests that need to decide when — and
         * whether — it lands. Production passes nothing.
         */
        bootstrap?: () => Promise<LessonSessionHost | null>;
    },
): LessonSessionHost {
    let ready: LessonSessionHost | null = null;
    let disposed = false;
    /*
     * The raw bootstrap, not the budgeted one.
     *
     * `createLessonSessionHost` exists for a caller that must have an answer
     * before it can continue, so it gives up at its deadline and closes a host
     * that arrives late. Wrapping it here would mean a studio that took four
     * seconds once left the whole session without lessons for good. Nothing is
     * waiting on this, so it runs to whatever conclusion it reaches and the
     * turn after it lands is the first one that recalls.
     */
    const pending = (input.bootstrap ?? (() => bootstrapLessonSessionHost(input)))().then((built) => {
        if (built && disposed) {
            // Disposed while starting: close it rather than leak the store.
            void built.close().catch(() => undefined);
            return null;
        }
        ready = built;
        return built;
    }).catch(() => null);

    /** Resolves to the ready host, or null while it is still starting. */
    const settled = () => ready;

    return {
        // Read once at construction from the same environment; it does not
        // depend on the network and must not wait for it.
        sessionKind: readLessonSessionKind(input.env ?? process.env),
        turn: {
            async recall(args) {
                const host = settled()?.turn;
                return host ? host.recall(args) : { outcome: 'unsupported' as const };
            },
            async acknowledge(ticket) {
                const host = settled()?.turn;
                return host ? host.acknowledge(ticket) : false;
            },
        },
        review: {
            async reviewFinishedTurn(args) {
                const host = settled()?.review;
                return host ? host.reviewFinishedTurn(args) : 'unsupported';
            },
        },
        async close() {
            /*
             * Closing must not wait on the bootstrap.
             *
             * This runs on the provider's exit path, and the thing being
             * awaited is a studio that may be exactly why the host never
             * became ready — awaiting it would hold shutdown open for as long
             * as that call takes. Setting `disposed` first is what makes the
             * wait unnecessary: whatever the bootstrap produces afterwards
             * sees it and closes itself in the `then` above.
             */
            disposed = true;
            const built = ready;
            ready = null;
            void pending;
            await built?.close().catch(() => undefined);
        },
    };
}

export async function createLessonSessionHost(input: {
    /** null for a managed run, which holds no account credential. */
    accountToken: string | null;
    machineId: string | null;
    sessionId: string;
    happyHomeDir: string;
    env?: NodeJS.ProcessEnv;
    budgetMs?: number;
}): Promise<LessonSessionHost | null> {
    /*
     * Bounded as a whole, not step by step.
     *
     * Each call has its own timeout, but three of them in sequence still add
     * up to something a user waits through before their first message is
     * sent. The session must start on time whatever the studio is doing.
     */
    const budgetMs = input.budgetMs ?? LESSON_SESSION_BOOTSTRAP_BUDGET_MS;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => { expired = true; resolve('timeout'); }, budgetMs);
        timer.unref?.();
    });
    /*
     * A bootstrap that finishes after the deadline still opened a store.
     * Handing back null and walking away would leave that handle open for the
     * life of the process, so the late result is closed here — the earlier
     * comment claimed it closed itself, and nothing did.
     */
    const work = bootstrapLessonSessionHost(input).then((built) => {
        if (built && expired) void built.close().catch(() => undefined);
        return built;
    });
    try {
        const raced = await Promise.race([work, deadline]);
        if (raced === 'timeout') {
            logger.debug('[lesson-host] bootstrap exceeded its budget; session runs without lessons');
            return null;
        }
        return raced;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function bootstrapLessonSessionHost(input: {
    accountToken: string | null;
    machineId: string | null;
    sessionId: string;
    /**
     * This provider's own home.
     *
     * Kept for the caller's convenience and deliberately **not** used as the
     * state root; see {@link lessonStateRoot}.
     */
    happyHomeDir: string;
    env?: NodeJS.ProcessEnv;
}): Promise<LessonSessionHost | null> {
    const env = input.env ?? process.env;
    const origin = studioOrigin(env);
    const spawnContext = readCheckpointSpawnContext(env);
    const projectId = spawnContext?.projectId ?? null;
    // Four things, all required. Any one missing and this session has no
    // lesson host — which is a state, not a failure.
    if (!input.accountToken || !input.machineId || !origin || !projectId) return null;
    /*
     * The daemon's root, whatever this provider's own `HAPPY_HOME_DIR` is.
     *
     * Settings and the spending ledger are the machine's, so a collaborator's
     * relocated home must not fork them. Nothing about the caller changes —
     * the grant, the actor and the permissions are all still this session's.
     */
    const stateRoot = lessonStateRoot(env);
    if (!stateRoot) {
        logger.debug('[lesson-host] daemon state root unknown; unsupported');
        return null;
    }
    /*
     * Only the side the daemon named injects.
     *
     * Without the marker CML's native hook is still doing this work, and a
     * host that injected anyway would put the same lessons in twice. The
     * daemon decided before this process started; this is that decision being
     * honoured, not re-made.
     */
    if (readLessonOwner(env) !== 'host') {
        logger.debug('[lesson-host] host injection is not enabled for this launch');
        return null;
    }

    const publicKey = await fetchLessonGrantPublicKey({
        studioBaseUrl: origin, token: input.accountToken, machineId: input.machineId,
    });
    if (!publicKey) return null;

    let verifier;
    try {
        verifier = createLessonGrantVerifier({
            publicKeyBase64: publicKey,
            machineId: input.machineId,
            audience: lessonGrantAudience(origin),
        });
    } catch {
        return null;
    }

    const supervisor = createLessonHostSupervisor({
        routeVerifier: () => verifier,
        requestSnapshotGrant: (project) => requestLessonSnapshotGrant({
            studioBaseUrl: origin, token: input.accountToken!, machineId: input.machineId!, projectId: project,
        }),
        machineId: () => input.machineId,
        studioBaseUrl: () => origin,
        studioToken: () => input.accountToken,
        settingsPathFor: (project) => lessonSettingsPath(stateRoot, project),
    });

    let runtime: LessonHostRuntime | null;
    try {
        runtime = await supervisor.ensureOpen(projectId);
    } catch {
        runtime = null;
    }
    if (!runtime) {
        await supervisor.close();
        return null;
    }
    const host = runtime.host();
    const issuer = runtime.issuer();
    if (!host || !issuer) {
        await supervisor.close();
        return null;
    }

    /*
     * The authenticated caller, as the studio signed it.
     *
     * Never derived from the machine id or anything else to hand: that value
     * becomes the CML actor and the gateway's `X-Api-User-Id`, so a
     * constructed one attributes work and spend to a person who never
     * authenticated. If the studio did not name a caller, this session has no
     * lesson host.
     */
    const userId = supervisor.openedUserId(projectId);
    if (!userId) {
        await supervisor.close();
        return null;
    }

    const settings = createLessonSettingsStore(lessonSettingsPath(stateRoot, projectId));
    const outcomes = createLessonReviewOutcomeStore(
        lessonReviewOutcomePath(stateRoot, projectId),
    );
    /**
     * Confirms the lease before every piece of host-initiated work.
     *
     * The bootstrap grant authorized one moment. Project, machine or account
     * access can be taken away afterwards and nothing local can see that, so
     * each turn and each review re-checks — and a caller the studio no longer
     * names gets no identity, which stops the work rather than continuing it
     * under a stale one.
     */
    const liveIdentity = async () => {
        const current = await supervisor.authorize(projectId, LESSON_AUTHORIZE_BUDGET_MS);
        if (current !== userId) return null;
        return { projectId, userId, machineId: input.machineId!, sessionId: input.sessionId };
    };

    return {
        // Read now, before the runner deletes the markers.
        sessionKind: readLessonSessionKind(env),
        turn: createLessonTurnHost({
            host,
            issuer,
            settings,
            identity: liveIdentity,
        }),
        review: createLessonReviewWorker({
            host,
            issuer,
            settings,
            budget: new LessonReviewBudget(lessonReviewLedgerPath(stateRoot)),
            gateway: async () => {
                const resolved = await readGateway({
                    studioBaseUrl: origin, token: input.accountToken!, machineId: input.machineId!,
                    projectId, userId,
                });
                if (!resolved) return null;
                /*
                 * The quote must price the model the gateway will actually
                 * use. The request omits the model, so the registered default
                 * is what gets called — and a quote for anything else prices a
                 * call that will not happen.
                 */
                if (resolved.quote.model !== resolved.defaultModel) return null;
                // The gateway spec pins `X-Project-Id` to the project's real
                // id; a different one would attribute spend elsewhere.
                if (resolved.config.projectId !== projectId) return null;
                return { config: resolved.config, quote: resolved.quote };
            },
            identity: liveIdentity,
            onOutcome: (outcome) => {
                logger.debug(`[lesson-review] ${outcome}`);
                /*
                 * Written where the UI can read it. The worker runs in the
                 * provider process and the snapshot is served by the daemon,
                 * so an in-memory value would leave the UI reporting a state
                 * nothing ever updates.
                 */
                void outcomes.record(outcome);
            },
        }),
        close: () => supervisor.close(),
    };
}


