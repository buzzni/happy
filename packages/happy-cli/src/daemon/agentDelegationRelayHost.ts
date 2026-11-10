/**
 * The daemon side of the delegation relay (`agentDelegationRelay.ts`): which sessions this machine
 * holds a key for, one server message page, the session's own encryption, and the server's ownership
 * answer asked as this machine. Kept apart from the relay's rules so those stay pure and testable.
 */
import axios from 'axios';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import type { PersistedSession } from '@/persistence';
import { createAgentRelationAuthority, type AgentRelationHost } from './agentRelationAuthority';
import type { AgentDelegationRelayHost, RelaySessionBinding } from './agentDelegationRelay';

const REQUEST_TIMEOUT_MS = 30_000;

type Get = (url: string, options: { params: Record<string, number>; headers: Record<string, string>; timeout: number }) => Promise<{ data: unknown }>;
type Post = (url: string, body: unknown, options: { headers: Record<string, string>; timeout: number }) => Promise<unknown>;

export function createAgentDelegationRelayHost(input: {
    serverUrl: string;
    /** This machine; a persisted session recorded for another machine is not offered. */
    machineId: string;
    token: () => Promise<string | null>;
    readSessions: () => Record<string, PersistedSession>;
    isSessionLive: (sessionId: string) => boolean;
    /** This machine's server-confirmed identity (`readAgentRelationHost`); null proves no ownership. */
    relationHost: () => Promise<AgentRelationHost | null>;
    get?: Get;
    post?: Post;
    fetch?: typeof fetch;
}): Omit<AgentDelegationRelayHost, 'store'> {
    const get: Get = input.get ?? ((url, options) => axios.get(url, options));
    const post: Post = input.post ?? ((url, body, options) => axios.post(url, body, options));
    const messagesUrl = (sessionId: string) => `${input.serverUrl}/v3/sessions/${encodeURIComponent(sessionId)}/messages`;
    async function headers(): Promise<Record<string, string>> {
        const token = await input.token();
        if (!token) throw new Error('this machine is not signed in');
        return { Authorization: `Bearer ${token}` };
    }

    return {
        sessions: () => Object.entries(input.readSessions()).flatMap(([sessionId, session]): RelaySessionBinding[] => {
            if (session.metadata?.machineId !== input.machineId || typeof session.metadata.path !== 'string') return [];
            let encryptionKey: Uint8Array;
            try { encryptionKey = decodeBase64(session.encryptionKey); } catch { return []; }
            if (encryptionKey.length !== 32) return [];
            return [{
                sessionId,
                directory: session.metadata.path,
                title: session.metadata.summary?.text || session.metadata.name || null,
                updatedAt: session.savedAt,
                encryptionKey,
                encryptionVariant: session.encryptionVariant,
            }];
        }),
        isSessionLive: input.isSessionLive,
        async ownedBy(requesterSessionId, sessionIds) {
            const host = await input.relationHost();
            if (!host) return new Set();
            const verdicts = await createAgentRelationAuthority({ host, callerSessionId: requesterSessionId, ...(input.fetch ? { fetch: input.fetch } : {}) })
                .inspectMany(sessionIds);
            return new Set(sessionIds.filter((id) => verdicts[id]?.relation === 'own-sibling'));
        },
        async fetchPage(binding, cursor) {
            const params: Record<string, number> = 'afterSeq' in cursor ? { limit: cursor.limit, after_seq: cursor.afterSeq } : { limit: cursor.limit, before_seq: cursor.beforeSeq };
            const response = await get(messagesUrl(binding.sessionId), { params, headers: await headers(), timeout: REQUEST_TIMEOUT_MS });
            const messages = (response.data as { messages?: unknown } | null)?.messages;
            if (!Array.isArray(messages)) throw new Error('the server answered no message list');
            return messages.flatMap((message) => {
                const row = message as { seq?: unknown; localId?: unknown; createdAt?: unknown; content?: { t?: unknown; c?: unknown } };
                if (!Number.isSafeInteger(row.seq) || row.content?.t !== 'encrypted' || typeof row.content.c !== 'string') return [];
                return [{
                    seq: row.seq as number,
                    localId: typeof row.localId === 'string' ? row.localId : null,
                    createdAt: typeof row.createdAt === 'number' ? row.createdAt : null,
                    ciphertext: row.content.c,
                }];
            });
        },
        decrypt: (binding, ciphertext) => decrypt(binding.encryptionKey, binding.encryptionVariant, decodeBase64(ciphertext)),
        async postUserMessage(binding, message) {
            const content = encodeBase64(encrypt(binding.encryptionKey, binding.encryptionVariant, message.content));
            await post(messagesUrl(binding.sessionId), { messages: [{ localId: message.localId, content }] }, {
                headers: { ...await headers(), 'Content-Type': 'application/json', 'X-Happy-Client': 'cli-daemon/agent-delegation-relay' },
                timeout: REQUEST_TIMEOUT_MS,
            });
        },
    };
}
