/**
 * The organization requirements gate, as the Claude runner meets it (aplus-dev-studio-desktop
 * specs/codexcli-org-requirements R10.1–R10.3, R10.10, R10.12).
 *
 * The launcher hands every batch to `checkTurn` at the moment it would become the running turn — the
 * one point every new turn passes (a person's message, the spawn's first prompt, a channel or follow-up
 * turn, a queued account continuation) — and gets back the mode to run, or a refusal to close as failed.
 * A transient-failure retry repeats the turn already checked, with its mode: a running turn is not cut
 * mid-way (R15), and the next turn is checked again.
 * The permission handler asks `declinesForCeiling` before raising a prompt and `clampAnswer` before
 * applying one; the terminal launcher asks `localLaunchArgs`. Without a document each is a no-op.
 */

import { randomUUID } from 'node:crypto';
import type { TurnAttendance } from '@/api/turnAttendance';
import type { RawJSONLines } from './types';
import type { OrgRequirementsGate } from '@/orgRequirements/gate';
import type { OrgModelRequest } from '@/orgRequirements/resolve';
import type { EnhancedMode, PermissionMode } from './loop';
import { mapToClaudeMode } from './utils/permissionMode';
import { isZaiClaudeRuntime } from '@/utils/initialPrompt';

export type { OrgModelRequest };

export type ClaudeOrgTurn =
    | { kind: 'refuse'; message: string }
    | { kind: 'run'; mode: EnhancedMode; modeClamped: boolean };

export interface ClaudeOrgRequirements {
    checkTurn(mode: EnhancedMode): ClaudeOrgTurn;
    /** An unattended turn, and only the ceiling made this prompt ask: decline without waiting (R10.12). */
    declinesForCeiling(tool: { edit: boolean }): boolean;
    recordCeilingDenial(toolName: string): void;
    clampAnswer<T extends { mode?: string; allowTools?: string[] }>(answer: T): T;
    /**
     * Auto-routing may raise a checked batch's model at the engine boundary (its floor). A routed model
     * the organization does not allow is not applied: the checked model runs instead.
     */
    allowsRoutedModel(model: string): boolean;
    /** The terminal (local mode) command line: no bypass flag and an explicit clipped mode under a ceiling (R10.10). */
    localLaunchArgs(args: string[] | undefined): { args: string[] | undefined; allowBypass: boolean };
}

/**
 * The one line a refused turn says (R10.2), as an assistant transcript record so the protocol mapper opens
 * and stamps the turn exactly as for a reply. `model: 'system'` marks it as not from the provider, like the
 * remote `/mcp` answers.
 */
export function orgRefusalTranscriptRecord(claudeSessionId: string | null, text: string): RawJSONLines {
    return {
        type: 'assistant',
        uuid: randomUUID(),
        parentUuid: null,
        isSidechain: false,
        sessionId: claudeSessionId || 'unknown',
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', model: 'system', content: [{ type: 'text', text }] },
    } as unknown as RawJSONLines;
}

/** Variables Claude Code reads to pick a model behind the one a turn names (R10.8). */
const MODEL_SELECTION_ENV = [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
] as const;

/**
 * While an organization restricts models, a request's environment must not run a model the turn did not
 * name: the turn's model goes to the SDK explicitly, and these go. A Z.AI runtime keeps them — its tier
 * mapping is the daemon's own environment, and without it every model name misses. Returns what was removed.
 */
export function stripModelSelectionEnv(env: Record<string, string | undefined>, extra: Record<string, string> | undefined): string[] {
    if (isZaiClaudeRuntime(env as NodeJS.ProcessEnv)) return [];
    const removed = new Set<string>();
    for (const key of MODEL_SELECTION_ENV) {
        if (env[key] !== undefined) { delete env[key]; removed.add(key); }
        if (extra && extra[key] !== undefined) { delete extra[key]; removed.add(key); }
    }
    return [...removed];
}

/**
 * The model an off-turn chat title runs on (R10.2). The title job starts when a message is queued, before
 * the turn is checked: the model it was queued with may be the runtime default or a model the organization
 * refuses. While models are restricted, only the launched query's model — the checked turn's — titles.
 */
export function orgTitleModel(gate: OrgRequirementsGate | null, requested: string | undefined, launched: string | undefined): string | undefined {
    return gate?.restrictsModels() ? launched : requested ?? launched;
}

/**
 * An organization tool glob as a Claude Code permission rule, or null where Claude Code has none (R10.2): an
 * exact name, or a whole MCP server (`mcp__srv__*` → `mcp__srv`). Any other glob stays with the tool policy hook.
 */
export function claudeDisallowRule(glob: string): string | null {
    if (!glob.includes('*')) return glob;
    const server = /^(mcp__[^*_]+(?:_[^*_]+)*)__\*$/.exec(glob);
    return server ? server[1] : null;
}

/** The turn's `disallowedTools` with the organization's blanket blocks added: the SDK refuses them even with no hook. */
function withOrgBlocks(disallowed: string[] | undefined, blocked: string[]): string[] | undefined {
    const added = blocked.map(claudeDisallowRule).filter((rule): rule is string => rule !== null && !(disallowed ?? []).includes(rule));
    return added.length === 0 ? disallowed : [...(disallowed ?? []), ...new Set(added)];
}

const BYPASS_FLAGS = new Set(['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions']);

export function createClaudeOrgRequirements(gate: OrgRequirementsGate, deps: {
    /** The runtime model substitution an accepted turn gets (`normalizeClaudeModelForRuntime` + runtime default). */
    normalizeModel: (model: string) => string | undefined;
    attendance: () => TurnAttendance;
    /** The session's first mode, after the command-line default and the sandbox rule. */
    initialPermissionMode: () => PermissionMode;
}): ClaudeOrgRequirements {
    return {
        checkTurn: (mode) => {
            const verdict = gate.checkTurn({
                permissionMode: mode.permissionMode,
                model: mode.orgModel?.requested ?? null,
                modelOrigin: mode.orgModel?.origin ?? 'none',
                fallbackModel: mode.fallbackModel,
            });
            if (verdict.kind === 'refuse') return { kind: 'refuse', message: verdict.message };
            const disallowedTools = withOrgBlocks(mode.disallowedTools, gate.blockedTools());
            if (!verdict.modeClamped && !verdict.substituteModel && !verdict.dropFallbackModel && disallowedTools === mode.disallowedTools) {
                return { kind: 'run', mode, modeClamped: false };
            }
            return {
                kind: 'run',
                modeClamped: verdict.modeClamped,
                mode: {
                    ...mode,
                    ...(disallowedTools !== mode.disallowedTools ? { disallowedTools } : {}),
                    permissionMode: verdict.permissionMode as PermissionMode,
                    // A model the person did not pick this turn: its default effort, as Desktop resets it (R10.2a).
                    ...(verdict.substituteModel ? { model: deps.normalizeModel(verdict.substituteModel), effort: undefined } : {}),
                    ...(verdict.dropFallbackModel ? { fallbackModel: undefined } : {}),
                },
            };
        },
        declinesForCeiling: (tool) => deps.attendance() === 'unattended' && gate.ceilingCaused(tool),
        recordCeilingDenial: (toolName) => gate.recordCeilingDenial(toolName),
        clampAnswer: (answer) => gate.clampPermissionResponse(answer),
        allowsRoutedModel: (model) => gate.modelAllowed(model),
        localLaunchArgs: (args) => {
            if (gate.bypassAllowed()) return { args, allowBypass: true };
            const kept: string[] = [];
            for (let i = 0; i < (args?.length ?? 0); i++) {
                const arg = args![i];
                if (BYPASS_FLAGS.has(arg)) continue;
                if (arg === '--permission-mode') { i++; continue; }
                if (arg.startsWith('--permission-mode=')) continue;
                kept.push(arg);
            }
            // Explicit: refused bypass would otherwise land the TUI in its own `auto` mode (T11 ⑤, Claude 2.1.305).
            const mode = mapToClaudeMode(gate.prepare(deps.initialPermissionMode()).permissionMode as PermissionMode);
            return { args: [...kept, '--permission-mode', mode], allowBypass: false };
        },
    };
}
