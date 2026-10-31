/**
 * The daemon's organization requirements gate for one session process (aplus-dev-studio-desktop
 * specs/codexcli-org-requirements R10, plan 결정 4).
 *
 * The runner feeds it every `/api/me/mcp-config` answer (`onRequirements`) and asks it at fixed points:
 * - `prepare`: the session's first mode, after the command-line default and the sandbox rule (R10.1);
 * - `checkTurn`: a turn about to run — model judgment (R10.2, R10.2a), runtimes it cannot enforce
 *   (R10.7), the resolved permission mode clipped to the ceiling, the five-minute refresh (R15);
 * - `clampPermissionResponse`: an approval answer's `mode` and `allowTools` (R10.3, Claude);
 * - `ceilingCaused` / `recordCeilingDenial`: an unattended prompt only the ceiling raised (R10.12);
 * - `toolRules`: the tool policy gate's organization rules (R10.4).
 *
 * Without a document every answer is the input unchanged and nothing is published: a session outside
 * any organization runs byte-for-byte as before. Clips and refusals go to the audit and to agentState
 * `orgRequirements.lastEnforcement` (a repeated clip once per session, R10.6). The gate never ends the
 * session; a refused turn is the caller's to close as failed.
 *
 * This protects against agents, automations and other clients, not against the PC's own user, who can
 * delete the last known good or set `HAPPY_ORG_REQUIREMENTS=off` (plan "위협 모델" ②/③).
 */

import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createEnvelope, type OrgRequirementEnforcement, type OrgRequirementReason, type OrgRequirementsAgentState, type SessionEnvelope } from '@slopus/happy-wire';
import type { OrgToolRules } from '@/toolPolicy/evaluate';
import { toolGlobMatches } from '@/toolPolicy/rules';
import { isToolPolicyEnabled } from '@/toolPolicy/claudeHook';
import { createOrgRequirementsAuditLog, type OrgRequirementsAuditRecord } from './audit';
import {
    clampPermissionMode,
    judgeModel,
    normalizeModelSelection,
    permissionModeRank,
    type ModelOrigin,
    type OrgAgent,
    type OrgAiModelsItem,
    type OrgRequirementsDocument,
} from './resolve';
import { createOrgRequirementsSnapshot, type OrgRequirementsFetchOutcome } from './snapshot';
import { createOrgRequirementsStore, type OrgScopeKey } from './store';

export const ORG_REQUIREMENTS_ENV = 'HAPPY_ORG_REQUIREMENTS';
/** The daemon's own variable naming the project a spawn was made for (a scope hint, never a grant). */
export const ORG_SCOPE_HINT_ENV = 'HAPPY_ORG_SCOPE_PROJECT_ID';

/** A PC operator's switch. A spawn request cannot carry it: the daemon strips every `HAPPY_` request variable. */
export function isOrgRequirementsEnabled(env: NodeJS.ProcessEnv): boolean {
    return env[ORG_REQUIREMENTS_ENV]?.trim().toLowerCase() !== 'off';
}

/** The daemon's own hint for one spawn: the project it was made for, when that is a usable id. */
export function orgScopeHintEnvironment(projectId: string | null | undefined): Record<string, string> {
    const value = projectId?.trim();
    return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? { [ORG_SCOPE_HINT_ENV]: value } : {};
}

/**
 * Machine metadata `orgRequirements` (R24): what this runtime enforces. Absent with the switch off, so
 * Desktop never claims enforcement the daemon is not doing.
 */
export function orgRequirementsMachineCapability(env: NodeJS.ProcessEnv): { version: 1; enforced: string[] } | undefined {
    if (!isOrgRequirementsEnabled(env)) return undefined;
    // Organization tool rules are enforced by the tool policy gate, which `HAPPY_TOOL_POLICY=off` removes.
    return { version: 1, enforced: ['models', 'permissionMode', ...(isToolPolicyEnabled(env) ? ['tools'] : []), 'autopilot'] };
}

/** The stored metadata with the capability brought up to date; undefined when nothing changes. */
export function orgRequirementsMetadataUpdate<M extends { orgRequirements?: unknown }>(stored: M | null, capability: ReturnType<typeof orgRequirementsMachineCapability>): M | undefined {
    if (!stored || JSON.stringify(stored.orgRequirements) === JSON.stringify(capability)) return undefined;
    const { orgRequirements: _previous, ...rest } = stored;
    return (capability ? { ...rest, orgRequirements: capability } : rest) as M;
}

/** The project hint the daemon handed this spawn, read once and removed so the agent's children never see it. */
export function consumeOrgScopeHint(env: NodeJS.ProcessEnv): string | null {
    const value = env[ORG_SCOPE_HINT_ENV]?.trim();
    delete env[ORG_SCOPE_HINT_ENV];
    return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}

/**
 * A stable account identity for the cache file names, from the account's key material (else its token),
 * never stored itself.
 */
export function orgAccountKey(credentials: { token?: string; encryption?: { type: 'legacy'; secret: Uint8Array } | { type: 'dataKey'; publicKey: Uint8Array } }): string {
    const { encryption } = credentials;
    const hash = createHash('sha256');
    if (encryption?.type === 'legacy') hash.update('legacy').update(encryption.secret);
    else if (encryption?.type === 'dataKey') hash.update('dataKey').update(encryption.publicKey);
    else hash.update('token').update(credentials.token ?? '');
    return hash.digest('hex');
}

export interface OrgTurnInput {
    /** The mode the turn would run with, after the runner's own resolution (bypass→default guard, sandbox rule). */
    permissionMode: string;
    /** The model asked for, before any runtime substitution (Z.AI); `undefined`/`null`: none named. */
    model: string | null | undefined;
    modelOrigin: ModelOrigin;
    fallbackModel?: string | null;
    /** False for a runtime with no ceiling or tool-rule enforcement (Gemini, ACP agents — R10.7). */
    enforcesCeilingAndTools?: boolean;
}

export type OrgTurnVerdict =
    | { kind: 'refuse'; reason: 'requirement_model_denied' | 'requirement_model_unknown' | 'requirement_runtime_unsupported'; message: string }
    | {
        kind: 'run';
        permissionMode: string;
        modeClamped: boolean;
        /** Run this model id instead, with that model's default effort (R10.2a). */
        substituteModel?: string;
        /** `fallbackModel` is outside the set: leave it out (the turn still runs). */
        dropFallbackModel: boolean;
    };

export interface OrgRequirementsGate {
    onRequirements(outcome: OrgRequirementsFetchOutcome): void;
    prepare(permissionMode: string): { permissionMode: string; clamped: boolean };
    checkTurn(input: OrgTurnInput): OrgTurnVerdict;
    /** The mode as the session advertises it (metadata `permissionMode`): clipped, nothing recorded. */
    displayPermissionMode(mode: string): string;
    clampPermissionResponse<T extends { mode?: string; allowTools?: string[] }>(answer: T): T;
    /** The last checked turn: would its requested mode have run this prompt without asking? */
    ceilingCaused(tool: { edit: boolean }): boolean;
    recordCeilingDenial(toolName: string): void;
    /** False while a ceiling below bypass applies: bypass must not be reachable from a terminal either (R10.10). */
    bypassAllowed(): boolean;
    /** The ceiling while it is below bypass, else null (Codex approval policy under Happy's sandbox, R10.9). */
    approvalCeiling(): 'default' | 'acceptEdits' | null;
    restrictsModels(): boolean;
    /** A model chosen for the turn after it was checked (auto-routing's floor): allowed as an explicit choice? */
    modelAllowed(model: string): boolean;
    toolRules(): OrgToolRules | null;
    /** Tool globs of `blocked` rules naming no target or action: blocked whatever the call says (R10.2, R10.3). */
    blockedTools(): string[];
    autopilotDisabled(): boolean;
    /** Organization tool rule verdicts from the tool policy gate (R17). */
    auditToolRule(entry: { tool: string; decision: string; reasonCode: string; ruleId: string }): void;
    /** Listen for a different document coming into force. */
    onChange(listener: () => void): () => void;
}

const MESSAGES: Record<'requirement_model_denied' | 'requirement_model_unknown' | 'requirement_runtime_unsupported', (model: string) => string> = {
    requirement_model_denied: (model) => `조직 정책이 허용하지 않는 모델${model ? `(${model})` : ''}이라 이 메시지를 실행하지 않았어요. 허용된 모델을 골라 다시 보내 주세요.`,
    requirement_model_unknown: (model) => `모델 이름${model ? `(${model})` : ''}을 조직 정책으로 확인할 수 없어 이 메시지를 실행하지 않았어요. 모델을 다시 골라 보내 주세요.`,
    requirement_runtime_unsupported: () => '이 에이전트는 조직 정책(권한 상한·도구 규칙)을 지킬 수 없어 이 메시지를 실행하지 않았어요. Claude나 Codex로 대화를 이어 가 주세요.',
};

/**
 * A refused turn in the session protocol (R10.2): `turn-start`, the reason, `turn-end{failed}` — the
 * existing events, so an older Desktop, the web and mobile apps and a messenger channel all see a failed
 * turn and its sentence rather than a wait. `requestId` answers a channel request.
 */
export function refusedTurnEnvelopes(text: string, requestId: string | null | undefined): SessionEnvelope[] {
    const turn = randomUUID();
    const request = requestId ? { requestId } : {};
    return [
        createEnvelope('agent', { t: 'turn-start', ...request }, { turn }),
        createEnvelope('agent', { t: 'text', text }, { turn }),
        createEnvelope('agent', { t: 'turn-end', status: 'failed', ...request }, { turn }),
    ];
}

/** What the agent reads for an unattended prompt the ceiling declined (English, fixed — like the D1 expiry sentence). */
export function ceilingDenialMessage(): string {
    return 'The organization caps how much this agent may run without a person approving, and nobody can approve '
        + 'in this unattended run, so this request was declined automatically. Do not work around it with another '
        + 'command or tool for the same purpose. Finish what you can without it and report what you needed.';
}

const BYPASS_RANK = 4;
const ACCEPT_EDITS_RANK = 3;
const shown = (value: string | null | undefined) => (value ?? '').trim().slice(0, 64);

export function createOrgRequirementsGate(options: {
    agent: OrgAgent;
    /** The daemon's home: the last known good outlives a staged per-session home. */
    happyHomeDir: string;
    serverUrl: string;
    accountKey: string;
    sessionId: () => string | null;
    projectHint: string | null;
    /** agentState `orgRequirements`; `null` removes it. Called only when the value changes. */
    publish: (state: OrgRequirementsAgentState | null) => void;
    /** One `/api/me/mcp-config` lookup with `lifecycle: 'requirements-refresh'` that ends in `onRequirements`. */
    refresh: () => Promise<void>;
    now?: () => number;
}): OrgRequirementsGate {
    const now = options.now ?? Date.now;
    const { agent } = options;
    const store = createOrgRequirementsStore({ happyHomeDir: options.happyHomeDir, serverUrl: options.serverUrl, accountKey: options.accountKey, now });
    const audit = createOrgRequirementsAuditLog({ path: join(options.happyHomeDir, 'logs', 'org-requirements.jsonl'), sessionId: options.sessionId });
    const scopes = (): OrgScopeKey[] => {
        const sessionId = options.sessionId();
        return [
            ...(sessionId ? [{ kind: 'session' as const, id: sessionId }] : []),
            ...(options.projectHint ? [{ kind: 'project' as const, id: options.projectHint }] : []),
        ];
    };
    const snapshot = createOrgRequirementsSnapshot({ store, audit, scopes, now });

    let seq = 0;
    let lastEnforcement: OrgRequirementEnforcement | undefined;
    let lastPublished = 'null';
    let lastTurn: { requested: number; applied: number } | null = null;
    let refreshing = false;
    let summaryWritten = false;

    const document = (): OrgRequirementsDocument | null => snapshot.current();
    const ceiling = (): string | null => {
        const item = document()?.items['permissions.mode'];
        return item?.kind === 'ceiling' ? item.max : null;
    };
    const aiModels = (): OrgAiModelsItem | null => {
        const item = document()?.items['ai.models'];
        return item?.kind === 'allowedSet' ? item : null;
    };
    const orgRules = () => {
        const item = document()?.items['tools.rules'];
        return item?.kind === 'rules' ? item.rules : [];
    };
    // Rules naming a target or an action are judged per call by the tool policy gate; a blanket block
    // also applies to what a turn or a remembered answer may allow.
    const blanketBlocks = () => orgRules().filter((rule) => rule.decision === 'blocked' && rule.target === undefined && rule.action === undefined);

    const republish = () => {
        const state = snapshot.publicState();
        const value: OrgRequirementsAgentState | null = state ? { ...state, ...(lastEnforcement ? { lastEnforcement } : {}) } : null;
        const serialized = JSON.stringify(value);
        if (serialized === lastPublished) return;
        lastPublished = serialized;
        options.publish(value);
    };

    const enforce = (item: string, requested: string | null, applied: string | null, reason: OrgRequirementReason, once = false) => {
        const current = document();
        const record: OrgRequirementsAuditRecord = { at: now(), item, requested, applied, reason, revision: current?.revision ?? null, companyId: current?.companyId ?? null };
        if (!audit.record(record, { once })) return;
        lastEnforcement = { seq: ++seq, at: record.at, item, requested, applied, reason, revision: current?.revision ?? 0 };
        republish();
    };

    snapshot.onChange(() => {
        const sessionId = options.sessionId();
        const current = document();
        if (!sessionId) return;
        if (current) {
            const autopilot = current.items['autopilot.enabled'];
            store.writeSessionSummary(sessionId, { companyId: current.companyId, autopilotDisabled: autopilot?.kind === 'fixed' });
            summaryWritten = true;
        } else if (summaryWritten) {
            store.writeSessionSummary(sessionId, null);
            summaryWritten = false;
        }
    });

    const clampMode = (mode: string): { mode: string; clamped: boolean } => {
        const max = ceiling();
        return max ? clampPermissionMode(agent, mode, max) : { mode, clamped: false };
    };

    return {
        onRequirements: (outcome) => {
            snapshot.ingest(outcome);
            republish();
        },
        prepare: (permissionMode) => {
            const result = clampMode(permissionMode);
            if (result.clamped) enforce('permissions.mode', permissionMode, result.mode, 'requirement_mode_clamped', true);
            return { permissionMode: result.mode, clamped: result.clamped };
        },
        checkTurn: (input) => {
            if (snapshot.shouldRefresh() && !refreshing) {
                refreshing = true;
                options.refresh().catch(() => undefined).finally(() => { refreshing = false; });
            }
            republish();
            const current = document();
            if (!current) {
                lastTurn = null;
                return { kind: 'run', permissionMode: input.permissionMode, modeClamped: false, dropFallbackModel: false };
            }
            const max = ceiling();
            const refuse = (reason: 'requirement_model_denied' | 'requirement_model_unknown' | 'requirement_runtime_unsupported', item: string, requested: string | null) => {
                lastTurn = null;
                enforce(item, requested, null, reason);
                return { kind: 'refuse' as const, reason, message: MESSAGES[reason](shown(requested)) };
            };
            const ceilingBelowBypass = max !== null && permissionModeRank(agent, max) < BYPASS_RANK;
            if (input.enforcesCeilingAndTools === false && (ceilingBelowBypass || orgRules().length > 0)) {
                return refuse('requirement_runtime_unsupported', ceilingBelowBypass ? 'permissions.mode' : 'tools.rules', agent);
            }

            const allowed = aiModels();
            const judgment = judgeModel({ agent, model: input.model, origin: input.modelOrigin, allowed });
            if (judgment.kind === 'deny') return refuse(judgment.reason, 'ai.models', input.model ?? null);
            if (judgment.kind === 'substitute') enforce('ai.models', input.model ?? null, judgment.model, 'requirement_model_substituted', true);

            let dropFallbackModel = false;
            if (allowed && input.fallbackModel) {
                const key = normalizeModelSelection(agent, input.fallbackModel);
                if (key === null || !allowed.values.includes(key)) {
                    dropFallbackModel = true;
                    enforce('ai.models', input.fallbackModel, null, 'requirement_fallback_removed', true);
                }
            }

            const clamp = clampMode(input.permissionMode);
            if (clamp.clamped) enforce('permissions.mode', input.permissionMode, clamp.mode, 'requirement_mode_clamped', true);
            lastTurn = { requested: permissionModeRank(agent, input.permissionMode), applied: permissionModeRank(agent, clamp.mode) };
            return {
                kind: 'run',
                permissionMode: clamp.mode,
                modeClamped: clamp.clamped,
                ...(judgment.kind === 'substitute' ? { substituteModel: judgment.model } : {}),
                dropFallbackModel,
            };
        },
        displayPermissionMode: (mode) => clampMode(mode).mode,
        clampPermissionResponse: (answer) => {
            if (!document()) return answer;
            const result = { ...answer };
            if (answer.mode !== undefined) {
                const clamp = clampMode(answer.mode);
                if (clamp.clamped) enforce('permissions.mode', answer.mode, clamp.mode, 'requirement_mode_clamped', true);
                result.mode = clamp.mode;
            }
            if (answer.allowTools) {
                const blocking = blanketBlocks();
                result.allowTools = answer.allowTools.filter((tool) => {
                    const blocked = blocking.some((rule) => toolGlobMatches(rule.tool, tool));
                    if (blocked) enforce('tools.rules', tool, null, 'requirement_tool_blocked', true);
                    return !blocked;
                });
            }
            return result;
        },
        ceilingCaused: ({ edit }) => {
            if (!lastTurn) return false;
            if (lastTurn.requested >= BYPASS_RANK && lastTurn.applied < BYPASS_RANK) return true;
            if (lastTurn.requested !== ACCEPT_EDITS_RANK || lastTurn.applied >= ACCEPT_EDITS_RANK) return false;
            // Claude acceptEdits runs only edits unasked; Codex safe-yolo (on-request) runs commands unasked too.
            return edit || agent === 'codex';
        },
        recordCeilingDenial: (toolName) => enforce('permissions.mode', toolName, ceiling(), 'requirement_ceiling'),
        bypassAllowed: () => {
            const max = ceiling();
            return max === null || permissionModeRank(agent, max) >= BYPASS_RANK;
        },
        approvalCeiling: () => {
            const max = ceiling();
            return max === 'default' || max === 'acceptEdits' ? max : max !== null && permissionModeRank(agent, max) < BYPASS_RANK ? 'default' : null;
        },
        restrictsModels: () => aiModels() !== null,
        modelAllowed: (model) => judgeModel({ agent, model, origin: 'explicit', allowed: aiModels() }).kind === 'allow',
        blockedTools: () => blanketBlocks().map((rule) => rule.tool),
        toolRules: () => {
            const current = document();
            return current ? { companyId: current.companyId, revision: current.revision, rules: orgRules() } : null;
        },
        autopilotDisabled: () => document()?.items['autopilot.enabled']?.kind === 'fixed',
        auditToolRule: (entry) => {
            const current = document();
            audit.record({
                at: now(),
                item: 'tools.rules',
                requested: entry.tool,
                applied: entry.ruleId,
                reason: entry.reasonCode === 'org_rule_revision' ? 'org_rule_revision' : entry.decision === 'blocked' ? 'requirement_tool_blocked' : 'tool_rule_ask',
                revision: current?.revision ?? null,
                companyId: current?.companyId ?? null,
            });
        },
        onChange: (listener) => snapshot.onChange(listener),
    };
}
