/**
 * aplus-dev-studio specs/cross-machine-agent-delegation (happy spec R1–R5) — the delegation links a
 * person installed from Desktop, kept in the happy home's `agent-delegation.json` (owner-only).
 *
 * `asTarget`: machines allowed to start agents here, each with the key its requests are sealed with.
 * `asSource`: machines this one may start agents on. `children`: sessions a linked machine started
 * here, so a stop is answered only for the peer that created the session; kept apart from the links,
 * so revoking a link neither forgets a running child nor frees its slot. `requests`: spawn request ids
 * seen recently, so a sealed request replayed after a daemon restart does not start a second agent.
 *
 * Keys leave this module only as the lane's decoded keys and through `sourceLinks` (the local CLI
 * asks for them over the customer lane). `list` never carries one.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { replacePrivateFile } from '@/persistence';
import type { DelegationLink } from '@/api/rpc/types';

export const AGENT_DELEGATION_MAX_LINKS = 16;
const MAX_CHILDREN = 256;
const MAX_REQUESTS = 512;
/** Longer than the binding window (5 min) plus clock skew: past it the lane refuses the request as stale. */
export const SPAWN_REQUEST_MEMORY_MS = 15 * 60_000;

const machineId = z.string().min(1).max(128);
const keyId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const linkKey = z.string().refine((value) => {
    const bytes = Buffer.from(value, 'base64');
    return bytes.length === 32 && bytes.toString('base64') === value;
}, 'key must be 32 bytes in canonical base64');

export const TargetLinkInputSchema = z.object({
    sourceMachineId: machineId,
    keyId,
    key: linkKey,
    createdBy: z.object({ accountId: z.string().min(1).max(128), displayName: z.string().min(1).max(200).optional() }).strict(),
}).strict();

export const SourceLinkInputSchema = z.object({
    targetMachineId: machineId,
    keyId,
    key: linkKey,
    name: z.string().min(1).max(200),
    platform: z.string().min(1).max(32),
}).strict();

const TargetLinkSchema = TargetLinkInputSchema.extend({ createdAt: z.number() });
const SourceLinkSchema = SourceLinkInputSchema.extend({ createdAt: z.number() });
const ChildSchema = z.object({ sessionId: z.string().min(1), peer: machineId, parentSessionId: z.string().min(1), createdAt: z.number() });
const RequestSchema = z.object({ peer: machineId, requestId: z.string().min(1).max(128), at: z.number() });
const FileSchema = z.object({
    version: z.literal(1),
    asTarget: z.array(TargetLinkSchema).max(AGENT_DELEGATION_MAX_LINKS),
    asSource: z.array(SourceLinkSchema).max(AGENT_DELEGATION_MAX_LINKS),
    children: z.array(ChildSchema).max(MAX_CHILDREN),
    // Optional so a file written before it still reads.
    requests: z.array(RequestSchema).max(MAX_REQUESTS).optional(),
});

type DelegationFile = z.infer<typeof FileSchema>;
export type DelegatedChild = z.infer<typeof ChildSchema>;

const EMPTY: DelegationFile = { version: 1, asTarget: [], asSource: [], children: [], requests: [] };

function readFileState(path: string, log: (message: string) => void): DelegationFile {
    let raw: string;
    try { raw = readFileSync(path, 'utf8'); } catch { return EMPTY; }
    try {
        const parsed = FileSchema.safeParse(JSON.parse(raw));
        if (parsed.success) return parsed.data;
    } catch { /* reported below */ }
    // All or nothing: a half-valid file must not grant a link it no longer describes.
    log('[AGENT DELEGATION] Ignoring an unreadable agent-delegation.json');
    return EMPTY;
}

export function createAgentDelegationStore(input: { path: string; now?: () => number; log?: (message: string) => void }) {
    const now = input.now ?? Date.now;
    let state = readFileState(input.path, input.log ?? (() => {}));
    let laneLinks: DelegationLink[] = [];
    const refreshLaneLinks = () => {
        laneLinks = state.asTarget.map((link) => ({ peer: link.sourceMachineId, key: new Uint8Array(Buffer.from(link.key, 'base64')) }));
    };
    refreshLaneLinks();

    // One change at a time, each computed from the state the previous one left: two installs that
    // arrive together must not both start from the same file and lose one.
    let writing: Promise<unknown> = Promise.resolve();
    const mutate = <T>(change: (current: DelegationFile) => { next: DelegationFile | null; result: T }): Promise<T> => {
        const run = writing.then(async () => {
            const { next, result } = change(state);
            if (next) {
                await replacePrivateFile(input.path, JSON.stringify(next, null, 2));
                state = next;
                refreshLaneLinks();
            }
            return result;
        });
        writing = run.catch(() => {});
        return run;
    };
    const tooMany = () => new Error(`delegation link limit of ${AGENT_DELEGATION_MAX_LINKS} reached`);

    return {
        async installTarget(raw: unknown): Promise<void> {
            const link = TargetLinkInputSchema.parse(raw);
            return mutate((current) => {
                const others = current.asTarget.filter((entry) => entry.sourceMachineId !== link.sourceMachineId);
                if (others.length >= AGENT_DELEGATION_MAX_LINKS) throw tooMany();
                return { next: { ...current, asTarget: [...others, { ...link, createdAt: now() }] }, result: undefined };
            });
        },
        async installSource(raw: unknown): Promise<void> {
            const link = SourceLinkInputSchema.parse(raw);
            return mutate((current) => {
                const others = current.asSource.filter((entry) => entry.targetMachineId !== link.targetMachineId);
                if (others.length >= AGENT_DELEGATION_MAX_LINKS) throw tooMany();
                return { next: { ...current, asSource: [...others, { ...link, createdAt: now() }] }, result: undefined };
            });
        },
        revoke(role: 'target' | 'source', peerMachineId: string): Promise<{ removed: boolean }> {
            return mutate<{ removed: boolean }>((current) => {
                if (role === 'target') {
                    const asTarget = current.asTarget.filter((entry) => entry.sourceMachineId !== peerMachineId);
                    if (asTarget.length === current.asTarget.length) return { next: null, result: { removed: false } };
                    return { next: { ...current, asTarget }, result: { removed: true } };
                }
                const asSource = current.asSource.filter((entry) => entry.targetMachineId !== peerMachineId);
                if (asSource.length === current.asSource.length) return { next: null, result: { removed: false } };
                return { next: { ...current, asSource }, result: { removed: true } };
            });
        },
        list() {
            return {
                asTarget: state.asTarget.map(({ sourceMachineId, keyId, createdBy, createdAt }) => ({ sourceMachineId, keyId, createdBy, createdAt })),
                asSource: state.asSource.map(({ targetMachineId, keyId, name, platform, createdAt }) => ({ targetMachineId, keyId, name, platform, createdAt })),
            };
        },
        sourceLinks() {
            return state.asSource.map(({ targetMachineId, keyId, key, name, platform }) => ({ targetMachineId, keyId, key, name, platform }));
        },
        laneLinks(): readonly DelegationLink[] {
            return laneLinks;
        },
        targetLink(peerMachineId: string) {
            const link = state.asTarget.find((entry) => entry.sourceMachineId === peerMachineId);
            return link ? { createdBy: link.createdBy } : null;
        },
        /**
         * Over the limit, the oldest children that are no longer running go first; a running child is
         * never forgotten (its stop and its slot depend on this record).
         */
        recordChild(child: { sessionId: string; peer: string; parentSessionId: string }, isLive: (sessionId: string) => boolean = () => false): Promise<void> {
            return mutate((current) => {
                let children = [...current.children.filter((entry) => entry.sessionId !== child.sessionId), { ...child, createdAt: now() }];
                for (let index = 0; children.length > MAX_CHILDREN && index < children.length - 1;) {
                    if (isLive(children[index]!.sessionId)) index++;
                    else children = [...children.slice(0, index), ...children.slice(index + 1)];
                }
                if (children.length > MAX_CHILDREN) throw new Error(`more than ${MAX_CHILDREN} delegated sessions are running here`);
                return { next: { ...current, children }, result: undefined };
            });
        },
        /** True the first time a peer's request id is seen within the memory window; false for a repeat. */
        claimRequest(peer: string, requestId: string): Promise<boolean> {
            return mutate<boolean>((current) => {
                const at = now();
                const recent = (current.requests ?? []).filter((entry) => at - entry.at < SPAWN_REQUEST_MEMORY_MS);
                if (recent.some((entry) => entry.peer === peer && entry.requestId === requestId)) return { next: null, result: false };
                return { next: { ...current, requests: [...recent, { peer, requestId, at }].slice(-MAX_REQUESTS) }, result: true };
            });
        },
        childOf(sessionId: string, peerMachineId: string): boolean {
            return state.children.some((child) => child.sessionId === sessionId && child.peer === peerMachineId);
        },
        children(): readonly DelegatedChild[] {
            return state.children;
        },
    };
}

export type AgentDelegationStore = ReturnType<typeof createAgentDelegationStore>;
