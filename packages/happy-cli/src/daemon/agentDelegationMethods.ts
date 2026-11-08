/**
 * aplus-dev-studio specs/cross-machine-agent-delegation (happy spec R1–R5, R8–R11) — the
 * `agent-delegation:*` machine RPCs.
 *
 * Link management (`install-target`, `install-source`, `revoke`, `list`, `targets`) is reachable only
 * with this machine's own key: neither the server lane nor the delegation lane lists them. `spawn` and
 * `session-key` are delegation-lane calls and need the peer the lane names; on any other lane they
 * refuse rather than guess one.
 *
 * A delegated spawn takes a narrow request and builds the child's environment here. The requester's
 * environment, sandbox configuration and credentials are not accepted: the child runs under this
 * machine's policy.
 */
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { logger } from '@/ui/logger';
import type { RpcCallContext } from '@/api/rpc/types';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { parseOutputFormat } from '@/claude/structuredOutput';
import { parseAiAuthSelection } from './sessionEnv';
import { DAEMON_RESTARTING_CODE } from './restartDrainLifecycle';
import type { AgentDelegationStore } from './agentDelegationStore';

export const AGENT_DELEGATION_CAPABILITY = { version: 1 } as const;
/** Same ceiling as the CLI's AGENT_MAX_DEPTH: a delegated child is a generation like any other. */
export const AGENT_DELEGATION_MAX_DEPTH = 2;
/** The env names the child's `happy agent` reads; DELEGATED_FROM is what refuses a second hop. */
export const DELEGATED_FROM_ENV = 'SAYCODE_AGENT_DELEGATED_FROM';

export interface AgentDelegationHost {
    store: AgentDelegationStore;
    /** Whether the session still has a live process here (counts toward `target_busy`). */
    isSessionLive: (sessionId: string) => boolean;
    /** The session's data key as this machine persisted it, or legacy; null when unknown here. */
    readSessionKey: (sessionId: string) => { variant: 'dataKey'; key: string } | { variant: 'legacy' } | null;
    /** How many delegated children may run here at once (D-5). */
    concurrencyLimit: number;
    directoryExists?: (path: string) => Promise<boolean>;
}

/**
 * D-5: how many delegated children this machine runs at once — the CLI's machine spawn budget
 * (Desktop `cli/domain/spawnBudget.ts`, ADR-063): ~2GiB per agent, two per core, between 4 and 32.
 * Static capacity only, so a refusal does not come and go with load.
 */
export function delegationConcurrencyLimit(capacity: { cpuCount: number; totalMemoryBytes: number }): number {
    const cores = Number.isFinite(capacity.cpuCount) ? Math.max(0, Math.floor(capacity.cpuCount)) : 0;
    const memory = Number.isFinite(capacity.totalMemoryBytes) ? Math.max(0, capacity.totalMemoryBytes) : 0;
    if (cores <= 0 || memory <= 0) return 4;
    return Math.min(Math.max(Math.min(Math.floor(memory / (2 * 1024 ** 3)), cores * 2), 4), 32);
}

type Register = (method: string, handler: (params: unknown, context?: RpcCallContext) => unknown) => void;

const ABSOLUTE_DIRECTORY = /^(\/|[A-Za-z]:[\\/])/;

const SpawnRequestSchema = z.object({
    parentSessionId: z.string().min(1).max(128),
    directory: z.string().min(1).max(4096).regex(ABSOLUTE_DIRECTORY),
    agent: z.enum(['claude', 'codex', 'gemini', 'grok', 'openclaw', 'opencode']).default('claude'),
    model: z.string().min(1).max(200).optional(),
    effort: z.string().min(1).max(32).optional(),
    initialPrompt: z.string().refine((value) => value.trim().length > 0, 'initial prompt must not be empty'),
    outputFormat: z.unknown().optional(),
    aiAuthSelection: z.unknown().optional(),
    /** The child's generation, already one deeper than the parent, and its spawn ceiling. */
    agentGrant: z.object({
        depth: z.number().int().min(1),
        maxSpawn: z.number().int().min(0).max(1000),
        agentId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    }).strict(),
}).strict();

type SpawnReply =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; code: string; errorMessage: string; deadlineAt?: number };

const refuse = (code: string, errorMessage: string): SpawnReply => ({ type: 'error', code, errorMessage });

async function isDirectory(path: string): Promise<boolean> {
    try { return (await stat(path)).isDirectory(); } catch { return false; }
}

/** The lane's per-call gate: a linked machine stops only the sessions it started here. */
export function delegationLaneAdmission(store: AgentDelegationStore) {
    return (method: string, params: unknown, peer: string): { error: string; code: string } | null => {
        if (method !== 'stop-session') return null;
        const sessionId = (params as { sessionId?: unknown } | null)?.sessionId;
        return typeof sessionId === 'string' && store.childOf(sessionId, peer)
            ? null
            : { error: 'No such session was started by this machine', code: 'session_not_found' };
    };
}

export function registerAgentDelegationRpc(
    register: Register,
    host: AgentDelegationHost,
    deps: {
        spawn: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
        /** Files the child under its project, as an ordinary spawn does; failure never fails the spawn. */
        afterSpawn?: (input: { sessionId: string; directory: string }) => void | Promise<void>;
    },
): void {
    const { store } = host;
    const directoryExists = host.directoryExists ?? isDirectory;

    register('agent-delegation:install-target', async (params) => { await store.installTarget(params); return { ok: true }; });
    register('agent-delegation:install-source', async (params) => { await store.installSource(params); return { ok: true }; });
    register('agent-delegation:revoke', async (params) => {
        const input = z.object({ role: z.enum(['target', 'source']), peerMachineId: z.string().min(1).max(128) }).strict().parse(params);
        return store.revoke(input.role, input.peerMachineId);
    });
    register('agent-delegation:list', async () => ({ version: AGENT_DELEGATION_CAPABILITY.version, ...store.list() }));
    register('agent-delegation:targets', async () => ({ version: AGENT_DELEGATION_CAPABILITY.version, targets: store.sourceLinks() }));

    register('agent-delegation:spawn', async (params, context): Promise<SpawnReply> => {
        if (context?.lane !== 'delegation') return refuse('delegation_lane_required', 'Only a linked machine can start a delegated session');
        const link = store.targetLink(context.peer);
        // The lane opened the request with this link's key a moment ago; a revoke may have landed since.
        if (!link) return refuse('machine_not_delegatable', 'This machine no longer accepts work from the requesting machine');
        const parsed = SpawnRequestSchema.safeParse(params);
        if (!parsed.success) return refuse('invalid_request', parsed.error.issues.map((issue) => issue.message).join('; '));
        const request = parsed.data;
        if (request.agentGrant.depth > AGENT_DELEGATION_MAX_DEPTH) {
            return refuse('spawn_depth_exceeded', `depth ${request.agentGrant.depth} is past the ceiling of ${AGENT_DELEGATION_MAX_DEPTH}`);
        }
        if (!await directoryExists(request.directory)) {
            return refuse('project_not_found', `${request.directory} is not an existing directory on this machine`);
        }
        const running = store.children().filter((child) => host.isSessionLive(child.sessionId)).length;
        if (running >= host.concurrencyLimit) {
            return refuse('target_busy', `${running} delegated sessions are already running here (limit ${host.concurrencyLimit})`);
        }
        let outputFormat: ReturnType<typeof parseOutputFormat>;
        let aiAuthSelection: ReturnType<typeof parseAiAuthSelection>;
        try {
            outputFormat = parseOutputFormat(request.outputFormat);
            aiAuthSelection = parseAiAuthSelection(request.aiAuthSelection);
        } catch (error) {
            return refuse('invalid_request', error instanceof Error ? error.message : String(error));
        }

        let result: SpawnSessionResult;
        try {
            result = await deps.spawn({
                directory: request.directory,
                agent: request.agent,
                ...(request.model ? { model: request.model } : {}),
                ...(request.effort ? { effort: request.effort } : {}),
                initialPrompt: request.initialPrompt,
                ...(outputFormat ? { outputFormat } : {}),
                ...(aiAuthSelection ? { aiAuthSelection } : {}),
                // Built here, never copied: SCOPE is the directory, so the child sees its own tree only.
                environmentVariables: {
                    SAYCODE_AGENT_ENV: '1',
                    SAYCODE_AGENT_ROOT: request.directory,
                    SAYCODE_AGENT_SCOPE: request.directory,
                    SAYCODE_AGENT_DEPTH: String(request.agentGrant.depth),
                    SAYCODE_AGENT_MAX_SPAWN: String(request.agentGrant.maxSpawn),
                    SAYCODE_AGENT_ID: request.agentGrant.agentId,
                    [DELEGATED_FROM_ENV]: context.peer,
                },
                // D-6: the person who linked the machines, recorded when the link was installed.
                createdByAccountId: link.createdBy.accountId,
                ...(link.createdBy.displayName ? { createdByDisplayName: link.createdBy.displayName } : {}),
                delegatedFrom: { machineId: context.peer, sessionId: request.parentSessionId },
            });
        } catch (error) {
            logger.debug('[AGENT DELEGATION] Delegated spawn refused', { peer: context.peer });
            return refuse('target_refused', error instanceof Error ? error.message : String(error));
        }
        if (result.type === 'error') {
            return result.code === DAEMON_RESTARTING_CODE
                ? { type: 'error', code: result.code, errorMessage: result.errorMessage, ...(typeof result.deadlineAt === 'number' ? { deadlineAt: result.deadlineAt } : {}) }
                : refuse('target_refused', result.errorMessage);
        }
        if (result.type !== 'success') return refuse('target_refused', 'This machine needs approval to create the directory');

        try {
            await store.recordChild({ sessionId: result.sessionId, peer: context.peer, parentSessionId: request.parentSessionId });
        } catch (error) {
            // The session runs; only the peer's later stop/key requests will not find it.
            logger.debug('[AGENT DELEGATION] Could not record a delegated child', { error: String(error) });
        }
        try {
            await deps.afterSpawn?.({ sessionId: result.sessionId, directory: request.directory });
        } catch (error) {
            logger.debug('[AGENT DELEGATION] Project link for a delegated child failed', { error: String(error) });
        }
        logger.debug('[AGENT DELEGATION] Delegated session started', { peer: context.peer, sessionId: result.sessionId });
        return { type: 'success', sessionId: result.sessionId };
    });

    register('agent-delegation:session-key', async (params, context) => {
        const sessionId = (params as { sessionId?: unknown } | null)?.sessionId;
        const notFound = { type: 'error' as const, code: 'session_not_found', errorMessage: 'No such session was started by this machine' };
        if (context?.lane !== 'delegation' || typeof sessionId !== 'string' || !store.childOf(sessionId, context.peer)) return notFound;
        const key = host.readSessionKey(sessionId);
        return key ? { type: 'success' as const, sessionId, ...key } : notFound;
    });
}
