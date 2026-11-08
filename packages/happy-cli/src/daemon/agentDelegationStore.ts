/**
 * aplus-dev-studio specs/cross-machine-agent-delegation (happy spec R1–R5) — the delegation links a
 * person installed from Desktop, kept in the happy home's `agent-delegation.json` (owner-only).
 *
 * `asTarget`: machines allowed to start agents here, each with the key its requests are sealed with.
 * `asSource`: machines this one may start agents on. `children`: sessions a linked machine started
 * here, so a stop or a key request is answered only for the peer that created the session.
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
const FileSchema = z.object({
    version: z.literal(1),
    asTarget: z.array(TargetLinkSchema).max(AGENT_DELEGATION_MAX_LINKS),
    asSource: z.array(SourceLinkSchema).max(AGENT_DELEGATION_MAX_LINKS),
    children: z.array(ChildSchema).max(MAX_CHILDREN),
});

type DelegationFile = z.infer<typeof FileSchema>;
export type DelegatedChild = z.infer<typeof ChildSchema>;

const EMPTY: DelegationFile = { version: 1, asTarget: [], asSource: [], children: [] };

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
                    return { next: { ...current, asTarget, children: current.children.filter((child) => child.peer !== peerMachineId) }, result: { removed: true } };
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
        recordChild(child: { sessionId: string; peer: string; parentSessionId: string }): Promise<void> {
            return mutate((current) => {
                const children = [...current.children.filter((entry) => entry.sessionId !== child.sessionId), { ...child, createdAt: now() }];
                return { next: { ...current, children: children.slice(-MAX_CHILDREN) }, result: undefined };
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
