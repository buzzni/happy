/**
 * Pure organization requirement judgments (aplus-dev-studio-desktop specs/codexcli-org-requirements
 * R3, R5, R10.1–R10.2a). No I/O: the snapshot decides which document a session uses, the gate decides
 * when to ask; this file says what a document means.
 *
 * Every rule here is pinned by the shared case table (happy-wire `fixtures/orgRequirements.v1.cases.json`);
 * Desktop and Studio keep copies of the same rows.
 */

import {
    OrgAiModelsItemSchema,
    OrgFixedOffItemSchema,
    OrgRequirementsEnvelopeSchema,
    ORG_PERMISSION_MODE_ORDER,
    type OrgToolRuleV1,
} from '@slopus/happy-wire';

export type OrgAgent = 'claude' | 'codex' | 'gemini' | 'grok' | 'openclaw' | 'opencode';

export type OrgAiModelsItem = { kind: 'allowedSet'; values: string[]; default: string | null; source: 'organization' | 'member' };
export type OrgRequirementItem =
    | OrgAiModelsItem
    | { kind: 'rules'; rules: OrgToolRuleV1[] }
    | { kind: 'ceiling'; max: string }
    | { kind: 'fixed'; value: false };

export interface OrgRequirementsDocument {
    schemaVersion: 1;
    companyId: string;
    revision: number;
    modelPolicyUpdatedAt: number | null;
    issuedAt: number;
    items: Record<string, OrgRequirementItem>;
}

export interface ParsedOrgRequirements {
    document: OrgRequirementsDocument;
    /** What was dropped or kept from `previous`, for the audit (spec R3). */
    issues: Array<{ key: string; reason: string }>;
}

/** An unknown `schemaVersion` or a broken envelope: the caller keeps its last known good (spec R3). */
export class OrgRequirementsDocumentError extends Error {
    constructor() {
        super('Invalid organization requirements document');
        this.name = 'OrgRequirementsDocumentError';
    }
}

type ItemKind = OrgRequirementItem['kind'];

const ITEM_KINDS: ReadonlyMap<string, ItemKind> = new Map([
    ['ai.models', 'allowedSet'],
    ['tools.rules', 'rules'],
    ['permissions.mode', 'ceiling'],
    ['approvals.aiReview', 'fixed'],
    ['autopilot.enabled', 'fixed'],
]);

function itemKind(key: string): ItemKind | undefined {
    const known = ITEM_KINDS.get(key);
    if (known) return known;
    // Whether a feature may be locked is the Desktop registry's call; the daemon enforces none of them.
    return /^developerFeatures\.[A-Za-z][A-Za-z0-9]{0,63}$/.test(key) ? 'fixed' : undefined;
}

const MAX_RULES = 200;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isRevision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
// Studio's validator limits (`isText`): trimmed non-empty, rule ids up to 128.
const isShortText = (value: unknown, max = 256): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

function parseRule(value: unknown, revision: number): { rule?: OrgToolRuleV1; issue?: string } {
    if (!isRecord(value) || !isShortText(value.id, 128) || !isShortText(value.tool)) return { issue: 'rule_dropped' };
    // Restrictive-only: an organization `allow` opens nothing, so the rule is not there at all.
    if (value.decision === 'allow') return { issue: `rule_dropped:${value.id}` };
    const optional = (field: 'target' | 'action') => (isShortText(value[field]) ? { [field]: value[field] as string } : {});
    const decision = value.decision === 'blocked' ? 'blocked' : 'ask';
    // No usable `since`: new in this revision, so an older grant cannot satisfy it (R1a).
    const since = isRevision(value.since) ? value.since : revision;
    const rule: OrgToolRuleV1 = { id: value.id, tool: value.tool, ...optional('target'), ...optional('action'), decision, since };
    return value.decision === 'ask' || value.decision === 'blocked' ? { rule } : { rule, issue: `rule_downgraded:${value.id}` };
}

function parseItem(kind: ItemKind, value: unknown, revision: number): { item: OrgRequirementItem; issues: string[] } | null {
    if (!isRecord(value) || value.kind !== kind) return null;
    if (kind === 'fixed') return OrgFixedOffItemSchema.safeParse(value).success ? { item: { kind, value: false }, issues: [] } : null;
    if (kind === 'ceiling') {
        return typeof value.max === 'string' && (ORG_PERMISSION_MODE_ORDER as readonly string[]).includes(value.max)
            ? { item: { kind, max: value.max }, issues: [] }
            : null;
    }
    if (kind === 'allowedSet') {
        const parsed = OrgAiModelsItemSchema.safeParse(value);
        if (!parsed.success) return null;
        const { values } = parsed.data;
        if (new Set(values).size !== values.length || !values.every((key) => isShortText(key))) return null;
        if (parsed.data.default !== null && !values.includes(parsed.data.default)) return null;
        return { item: { ...parsed.data, values: [...values] }, issues: [] };
    }
    if (!Array.isArray(value.rules) || value.rules.length > MAX_RULES) return null;
    const rules: OrgToolRuleV1[] = [];
    const issues: string[] = [];
    for (const entry of value.rules) {
        const parsed = parseRule(entry, revision);
        if (parsed.rule) rules.push(parsed.rule);
        if (parsed.issue) issues.push(parsed.issue);
    }
    return { item: { kind: 'rules', rules }, issues };
}

/**
 * spec R3: the envelope is trusted wholesale or not at all; each item is judged alone. An unknown key
 * is dropped, a broken known item keeps `previous`'s value (same organization) or is dropped, a fixed
 * `true` and a rule `allow` never pass, and a garbled rule decision becomes `ask`.
 */
export function parseOrgRequirements(value: unknown, previous?: OrgRequirementsDocument): ParsedOrgRequirements {
    const envelope = OrgRequirementsEnvelopeSchema.safeParse(value);
    if (!envelope.success || !isRevision(envelope.data.revision)) throw new OrgRequirementsDocumentError();
    const { companyId, revision, modelPolicyUpdatedAt, issuedAt } = envelope.data;
    const raw = (value as { items: Record<string, unknown> }).items;
    const items: Record<string, OrgRequirementItem> = {};
    const issues: ParsedOrgRequirements['issues'] = [];
    for (const key of Object.keys(raw)) {
        const kind = itemKind(key);
        if (!kind) {
            issues.push({ key, reason: 'unknown_item' });
            continue;
        }
        const parsed = parseItem(kind, raw[key], revision);
        if (parsed) {
            items[key] = parsed.item;
            for (const reason of parsed.issues) issues.push({ key, reason });
            continue;
        }
        const kept = previous && previous.companyId === companyId && Object.hasOwn(previous.items, key) ? previous.items[key] : undefined;
        if (kept) items[key] = kept;
        issues.push({ key, reason: kept ? 'invalid_item_kept_previous' : 'invalid_item' });
    }
    return { document: { schemaVersion: 1, companyId, revision, modelPolicyUpdatedAt, issuedAt, items }, issues };
}

// ---------------------------------------------------------------------------------------------
// Permission mode ceiling (spec R5.3, plan "권한 모드 순위")
// ---------------------------------------------------------------------------------------------

const ABOVE_EVERY_CEILING = ORG_PERMISSION_MODE_ORDER.length;

/**
 * Where a session mode sits in the ceiling order. `yolo` is bypass; `safe-yolo` runs as `default` in
 * Claude and as on-request/workspace-write (= `acceptEdits`) in Codex. Anything else is above every
 * ceiling, so an unknown value is clipped rather than trusted.
 */
export function permissionModeRank(agent: OrgAgent, mode: string): number {
    if (mode === 'yolo') return 4;
    if (mode === 'safe-yolo') return agent === 'codex' ? 3 : 2;
    const rank = (ORG_PERMISSION_MODE_ORDER as readonly string[]).indexOf(mode);
    return rank < 0 ? ABOVE_EVERY_CEILING : rank;
}

/** The highest mode of the agent's own vocabulary at or under the ceiling. */
function ceilingMode(agent: OrgAgent, ceiling: string): string {
    if (agent === 'codex' && ceiling === 'acceptEdits') return 'safe-yolo';
    return ceiling;
}

export function clampPermissionMode(agent: OrgAgent, mode: string, ceiling: string): { mode: string; clamped: boolean } {
    const limit = permissionModeRank(agent, ceiling);
    if (permissionModeRank(agent, mode) <= limit) return { mode, clamped: false };
    return { mode: ceilingMode(agent, ceiling), clamped: true };
}

// ---------------------------------------------------------------------------------------------
// Models (spec R10.2, R10.2a)
// ---------------------------------------------------------------------------------------------

/**
 * Claude CLI tier aliases (happy-app sends them) and the Studio alias of the retired Fable key, as
 * the newest catalog model of each tier. Re-checked when the Claude CLI or the Studio catalog moves.
 */
const CLAUDE_MODEL_ALIASES: ReadonlyMap<string, string> = new Map([
    ['opus', 'claude-opus-5-5'],
    ['sonnet', 'claude-sonnet-5-5'],
    ['haiku', 'claude-haiku-5-5'],
    ['fable', 'claude-fable-5-1'],
    ['claude-fable-5', 'claude-fable-5-1'],
]);
/** Agents Studio keys by agent alone: any model is `<agent>:*`. */
const WILDCARD_AGENTS: ReadonlySet<OrgAgent> = new Set(['grok', 'openclaw']);
const MAX_MODEL_LENGTH = 256;

/**
 * The Studio selection key a requested model means. `null`: nothing was chosen (`default`, null, an
 * empty string) and R10.2a decides. `unknown`: not a model name at all (`requirement_model_unknown`).
 */
export function normalizeModelSelection(agent: OrgAgent, model: string | null | undefined): string | null {
    if (WILDCARD_AGENTS.has(agent)) return `${agent}:*`;
    if (model === null || model === undefined || model === '' || model === 'default') return null;
    if (model.length > MAX_MODEL_LENGTH) return 'unknown';
    const trimmed = model.trim();
    if (trimmed.length === 0 || /\s/.test(trimmed)) return 'unknown';
    // A context-window suffix (`[1m]`) names the same model.
    const id = trimmed.replace(/\[[^\]]*\]$/, '').toLowerCase();
    if (id.length === 0) return 'unknown';
    if (id === 'default') return null;
    return `${agent}:${agent === 'claude' ? CLAUDE_MODEL_ALIASES.get(id) ?? id : id}`;
}

/** Where the model a turn would run came from. */
export type ModelOrigin = 'explicit' | 'resume' | 'none';

export type ModelJudgment =
    | { kind: 'allow' }
    /** Run this model id (the key after its agent prefix) with the model's default effort. */
    | { kind: 'substitute'; model: string; key: string }
    | { kind: 'deny'; reason: 'requirement_model_denied' | 'requirement_model_unknown'; key: string | null };

/**
 * spec R10.2: an explicit model outside the set is refused, never swapped. R10.2a: nothing chosen, or a
 * model carried over from an earlier process, runs on the policy default of the same agent or that
 * agent's first allowed model; with none the turn is refused.
 */
export function judgeModel(input: { agent: OrgAgent; model: string | null | undefined; origin: ModelOrigin; allowed: OrgAiModelsItem | null }): ModelJudgment {
    const { agent, allowed } = input;
    if (!allowed) return { kind: 'allow' };
    const key = normalizeModelSelection(agent, input.origin === 'none' ? null : input.model);
    if (key !== null && allowed.values.includes(key)) return { kind: 'allow' };
    if (key === 'unknown' && input.origin === 'explicit') return { kind: 'deny', reason: 'requirement_model_unknown', key: null };
    if (key !== null && input.origin === 'explicit') return { kind: 'deny', reason: 'requirement_model_denied', key };
    // Studio has no key for an agent it does not list, and a wildcard agent outside the set has no model to swap in.
    if (WILDCARD_AGENTS.has(agent)) return { kind: 'deny', reason: 'requirement_model_denied', key };
    const prefix = `${agent}:`;
    const substitute = allowed.default?.startsWith(prefix) ? allowed.default : allowed.values.find((value) => value.startsWith(prefix));
    if (!substitute || substitute === `${agent}:*`) return { kind: 'deny', reason: 'requirement_model_denied', key };
    return { kind: 'substitute', model: substitute.slice(prefix.length), key: substitute };
}
