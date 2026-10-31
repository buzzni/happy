/**
 * The organization requirements gate of one runner process, assembled the same way for every runner
 * (aplus-dev-studio-desktop specs/codexcli-org-requirements R10, R14–R16).
 *
 * Account sessions only — a managed run fetches no config and its envelope is checked by Studio
 * (R10.11) — and not with `HAPPY_ORG_REQUIREMENTS=off`. State lives under the root the daemon names for
 * every spawn (`HAPPY_LESSON_DAEMON_HOME`), so a staged per-session home does not lose the last known
 * good; a runner started outside a daemon uses its own home. The daemon's project hint is consumed
 * either way, so the agent's own children never inherit it.
 */

import type { OrgRequirementsAgentState } from '@slopus/happy-wire';
import type { AgentState } from '@/api/types';
import { fetchAplusMcpConfigSnapshot } from '@/aplus/fetchAplusMcpServers';
import { configuration } from '@/configuration';
import { lessonStateRoot } from '@/memory/lessonSessionHost';
import { consumeOrgScopeHint, createOrgRequirementsGate, isOrgRequirementsEnabled, orgAccountKey, type OrgRequirementsGate } from './gate';
import type { OrgAgent } from './resolve';

export interface SessionOrgRequirements {
    gate: OrgRequirementsGate;
    /** One requirements lookup on this session's mcp-config (`lifecycle: requirements-refresh`). */
    lookup(): Promise<void>;
}

/** The organization gate's name for an ACP agent; one Studio has no key for judges as `opencode` does. */
export function liteRuntimeAgent(agentName: string): OrgAgent {
    return agentName === 'gemini' || agentName === 'grok' || agentName === 'openclaw' || agentName === 'opencode' ? agentName : 'opencode';
}

export type LiteRuntimeTurn = { kind: 'run'; substituteModel?: string } | { kind: 'refuse'; message: string };

/**
 * For a runtime that enforces neither a permission ceiling nor tool rules (Gemini, the ACP agents,
 * OpenClaw — R10.7): its config lookup carries no session id, so the requirements lookup is its own,
 * started now and awaited only by the first turn. Every turn is refused while a ceiling below bypass or
 * a tool rule applies; otherwise only the model is judged.
 */
export function createLiteRuntimeTurnGate(org: SessionOrgRequirements | null): (turn: { model?: string | null }) => Promise<LiteRuntimeTurn> {
    if (!org) return async () => ({ kind: 'run' });
    const ready = org.lookup().catch(() => undefined);
    return async (turn) => {
        await ready;
        const verdict = org.gate.checkTurn({
            permissionMode: 'default',
            model: turn.model ?? null,
            modelOrigin: turn.model ? 'explicit' : 'none',
            enforcesCeilingAndTools: false,
        });
        if (verdict.kind === 'refuse') return { kind: 'refuse', message: verdict.message };
        return verdict.substituteModel ? { kind: 'run', substituteModel: verdict.substituteModel } : { kind: 'run' };
    };
}

export function createSessionOrgRequirementsGate(input: {
    agent: OrgAgent;
    /** Null for a managed run. */
    credentials: Parameters<typeof orgAccountKey>[0] & { token: string } | null;
    machineId: string | null | undefined;
    session: {
        readonly sessionId: string;
        updateAgentState(update: (state: AgentState) => AgentState): unknown;
    };
    env?: NodeJS.ProcessEnv;
}): SessionOrgRequirements | null {
    const env = input.env ?? process.env;
    const projectHint = consumeOrgScopeHint(env);
    const { credentials, machineId, session } = input;
    if (!credentials || !machineId || !isOrgRequirementsEnabled(env)) return null;
    const lookup = async () => {
        await fetchAplusMcpConfigSnapshot(credentials.token, machineId, {
            sessionId: session.sessionId,
            lifecycle: 'requirements-refresh',
            onRequirements: (outcome) => gate.onRequirements(outcome),
        });
    };
    const gate = createOrgRequirementsGate({
        agent: input.agent,
        happyHomeDir: lessonStateRoot(env) ?? configuration.happyHomeDir,
        serverUrl: configuration.serverUrl,
        accountKey: orgAccountKey(credentials),
        sessionId: () => session.sessionId,
        projectHint,
        publish: (orgRequirements: OrgRequirementsAgentState | null) => session.updateAgentState((current) => {
            const { orgRequirements: _previous, ...rest } = current;
            return orgRequirements ? { ...rest, orgRequirements } : rest;
        }),
        refresh: lookup,
    });
    return { gate, lookup };
}
