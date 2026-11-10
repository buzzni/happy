/**
 * aplus-dev-studio specs/cross-machine-agent-delegation R17–R22 (A7, A8) — the restricted relay a linked
 * machine reads and prompts sessions through.
 *
 * The session data key never leaves this machine: it is also the session's RPC key (`bash`, files,
 * permissions), so handing it over would step around the delegation lane (A7). Instead this machine
 * decrypts the page itself and the lane seals the answer with the link key.
 *
 * Reachable here: a child the requesting machine started through this link, or a session the server
 * says belongs to the requesting person (`/v1/session-ownership/relation`, asked as this machine). The
 * requesting CLI filters the same way, but this side enforces it — code on the other machine can call
 * the lane without the CLI. Everything else, including a session that does not exist, answers the same
 * `session_not_found`, so the relay names no other person's session.
 *
 * Only reading and a plain user prompt: no steer, no stop, no permission answers, no resume.
 */
import { z } from 'zod';
import { SESSION_OWNERSHIP_RELATION_MAX_TARGETS } from '@slopus/happy-wire';
import type { RpcCallContext } from '@/api/rpc/types';
import type { AgentDelegationStore } from './agentDelegationStore';

/** Advertised as `agentDelegation.relay`; a machine without it is never asked. */
export const AGENT_DELEGATION_RELAY_VERSION = 1;
/** A proven ownership is reused this long, so a `wait` polling the relay does not ask the server every few seconds. */
const OWNERSHIP_REUSE_MS = 60_000;
const MAX_LISTED = 100;
const MAX_PAGE = 200;
/** One listing spends at most this many server lookups (the relation route allows 120 a minute per account). */
const MAX_OWNERSHIP_LOOKUPS = 3;

/** What a listing needs; the key is decoded only for the one session a read or prompt names. */
export interface RelaySessionEntry {
    sessionId: string;
    directory: string;
    title: string | null;
    updatedAt: number;
}

export interface RelaySessionBinding extends RelaySessionEntry {
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
}

export type RelayCursor = { limit: number } & ({ beforeSeq: number } | { afterSeq: number });

export interface AgentDelegationRelayHost {
    store: Pick<AgentDelegationStore, 'targetLink' | 'childOf'>;
    /** Sessions this machine holds a key for. */
    sessions: () => readonly RelaySessionEntry[];
    /** One of them with its key; null when this machine holds no usable key for it. */
    binding: (sessionId: string) => RelaySessionBinding | null;
    isSessionLive: (sessionId: string) => boolean;
    /** The ids among `sessionIds` the server says belong to the person behind `requesterSessionId`; empty when it cannot say. */
    ownedBy: (requesterSessionId: string, sessionIds: string[]) => Promise<ReadonlySet<string>>;
    /** One server page, as `/v3/sessions/:id/messages` answers it. Throws when the server does. */
    fetchPage: (binding: RelaySessionBinding, cursor: RelayCursor) => Promise<Array<{ seq: number; localId: string | null; createdAt: number | null; ciphertext: string }>>;
    decrypt: (binding: RelaySessionBinding, ciphertext: string) => unknown;
    postUserMessage: (binding: RelaySessionBinding, message: { localId: string; content: Record<string, unknown> }) => Promise<void>;
    now?: () => number;
}

type Register = (method: string, handler: (params: unknown, context?: RpcCallContext) => unknown) => void;
type Reply = { type: 'error'; code: string; errorMessage: string } | ({ type: 'success' } & Record<string, unknown>);

const sessionId = z.string().min(1).max(128);
const ListSchema = z.object({ requesterSessionId: sessionId }).strict();
const ReadSchema = z.object({
    requesterSessionId: sessionId,
    sessionId,
    limit: z.number().int().min(1).max(MAX_PAGE).default(50),
    beforeSeq: z.number().int().min(1).optional(),
    afterSeq: z.number().int().min(0).optional(),
}).strict().refine((value) => value.beforeSeq === undefined || value.afterSeq === undefined, 'beforeSeq and afterSeq cannot both be given');
const PromptSchema = z.object({
    requesterSessionId: sessionId,
    sessionId,
    localId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    text: z.string().max(100_000).refine((value) => value.trim().length > 0, 'prompt must not be empty'),
}).strict();

const refuse = (code: string, errorMessage: string): Reply => ({ type: 'error', code, errorMessage });
const NOT_REACHABLE = refuse('session_not_found', 'No such session is reachable from the requesting machine');

export function registerAgentDelegationRelay(register: Register, host: AgentDelegationRelayHost): void {
    const now = host.now ?? Date.now;
    const proven = new Map<string, number>();

    /**
     * Which of `entries` (newest first) the requester may reach: this link's children, then what the server calls theirs —
     * asked at most a hundred at a time and no more than `MAX_OWNERSHIP_LOOKUPS` times, stopping once `want` are found.
     * `true` marks a child.
     */
    async function reachable(peer: string, requester: string, entries: readonly RelaySessionEntry[], want: number): Promise<Map<string, boolean>> {
        const reach = new Map<string, boolean>();
        let pending: string[] = [];
        let lookups = 0;
        const ask = async () => {
            const ids = pending;
            pending = [];
            lookups++;
            const owned = await host.ownedBy(requester, ids).catch(() => new Set<string>());
            for (const id of ids) {
                const key = `${peer}\0${requester}\0${id}`;
                if (owned.has(id)) { proven.set(key, now()); reach.set(id, false); } else proven.delete(key);
            }
        };
        for (const entry of entries) {
            if (reach.size >= want) break;
            if (entry.sessionId === requester) continue;
            if (host.store.childOf(entry.sessionId, peer)) { reach.set(entry.sessionId, true); continue; }
            const at = proven.get(`${peer}\0${requester}\0${entry.sessionId}`);
            if (at !== undefined && now() - at < OWNERSHIP_REUSE_MS) { reach.set(entry.sessionId, false); continue; }
            if (lookups >= MAX_OWNERSHIP_LOOKUPS) continue;
            pending.push(entry.sessionId);
            if (pending.length === SESSION_OWNERSHIP_RELATION_MAX_TARGETS) await ask();
        }
        if (pending.length && lookups < MAX_OWNERSHIP_LOOKUPS) await ask();
        return reach;
    }

    /** The lane, the link, then the session: `delegated` says whether it is this link's child. */
    async function admit(context: RpcCallContext | undefined, requester: string, target: string)
        : Promise<{ ok: true; binding: RelaySessionBinding; peer: string } | { ok: false; reply: Reply }> {
        if (context?.lane !== 'delegation') return { ok: false, reply: refuse('delegation_lane_required', 'Only a linked machine can use the relay') };
        // The lane opened the request with this link's key a moment ago; a revoke may have landed since.
        if (!host.store.targetLink(context.peer)) return { ok: false, reply: refuse('machine_not_delegatable', 'This machine no longer accepts requests from the requesting machine') };
        const binding = host.binding(target);
        if (!binding || !(await reachable(context.peer, requester, [binding], 1)).has(target)) return { ok: false, reply: NOT_REACHABLE };
        return { ok: true, binding, peer: context.peer };
    }

    register('agent-delegation:relay-sessions', async (params, context): Promise<Reply> => {
        if (context?.lane !== 'delegation') return refuse('delegation_lane_required', 'Only a linked machine can use the relay');
        if (!host.store.targetLink(context.peer)) return refuse('machine_not_delegatable', 'This machine no longer accepts requests from the requesting machine');
        const parsed = ListSchema.safeParse(params);
        if (!parsed.success) return refuse('invalid_request', parsed.error.issues.map((issue) => issue.message).join('; '));
        const entries = [...host.sessions()].sort((a, b) => b.updatedAt - a.updatedAt);
        const reach = await reachable(context.peer, parsed.data.requesterSessionId, entries, MAX_LISTED);
        const sessions = entries.filter((entry) => reach.has(entry.sessionId)).slice(0, MAX_LISTED).map((entry) => ({
            id: entry.sessionId,
            directory: entry.directory,
            title: entry.title,
            active: host.isSessionLive(entry.sessionId),
            updatedAt: entry.updatedAt,
            delegated: reach.get(entry.sessionId) === true,
        }));
        return { type: 'success', sessions };
    });

    register('agent-delegation:relay-read', async (params, context): Promise<Reply> => {
        if (context?.lane !== 'delegation') return refuse('delegation_lane_required', 'Only a linked machine can use the relay');
        const parsed = ReadSchema.safeParse(params);
        if (!parsed.success) return refuse('invalid_request', parsed.error.issues.map((issue) => issue.message).join('; '));
        const request = parsed.data;
        const admitted = await admit(context, request.requesterSessionId, request.sessionId);
        if (!admitted.ok) return admitted.reply;
        const cursor: RelayCursor = request.afterSeq !== undefined
            ? { limit: request.limit, afterSeq: request.afterSeq }
            : { limit: request.limit, beforeSeq: request.beforeSeq ?? 2147483647 };
        let page: Awaited<ReturnType<AgentDelegationRelayHost['fetchPage']>>;
        try { page = await host.fetchPage(admitted.binding, cursor); } catch (error) {
            return refuse('relay_failed', `This machine could not read the session: ${error instanceof Error ? error.message : String(error)}`);
        }
        const messages = [...page].sort((a, b) => a.seq - b.seq).flatMap((message) => {
            let content: unknown;
            try { content = host.decrypt(admitted.binding, message.ciphertext); } catch { content = null; }
            return content && typeof content === 'object' ? [{ seq: message.seq, localId: message.localId, createdAt: message.createdAt, content }] : [];
        });
        return {
            type: 'success',
            session: { id: admitted.binding.sessionId, directory: admitted.binding.directory, active: host.isSessionLive(admitted.binding.sessionId) },
            messages,
        };
    });

    register('agent-delegation:relay-prompt', async (params, context): Promise<Reply> => {
        if (context?.lane !== 'delegation') return refuse('delegation_lane_required', 'Only a linked machine can use the relay');
        const parsed = PromptSchema.safeParse(params);
        if (!parsed.success) return refuse('invalid_request', parsed.error.issues.map((issue) => issue.message).join('; '));
        const request = parsed.data;
        const admitted = await admit(context, request.requesterSessionId, request.sessionId);
        if (!admitted.ok) return admitted.reply;
        // No resume: a prompt to a session with no process here would wait unseen (R19).
        if (!host.isSessionLive(request.sessionId)) return refuse('session_not_running', 'The session is not running on this machine');
        try {
            await host.postUserMessage(admitted.binding, {
                localId: request.localId,
                content: {
                    role: 'user',
                    content: { type: 'text', text: request.text },
                    meta: { sentFrom: 'agent-delegation', delegatedFrom: { machineId: admitted.peer, sessionId: request.requesterSessionId } },
                },
            });
        } catch (error) {
            return refuse('relay_failed', `This machine could not send the prompt: ${error instanceof Error ? error.message : String(error)}`);
        }
        return { type: 'success', localId: request.localId };
    });
}
