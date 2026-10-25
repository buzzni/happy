/**
 * Pure tool-call decision (aplus-dev-studio specs/agent-tool-policy R1–R8, R12, R13).
 *
 * Input: the tool name, its arguments, the already-resolved target app (cua-driver only), the
 * machine rules and a view of the conversation's grants. Output: `allow | ask | blocked` with the
 * reason, the rule, the table version and — for `blocked` — the three-part message the model sees.
 * No I/O here: the gate (policyGate.ts) resolves targets, holds grants and asks people.
 *
 * Combination order (R2): fixed builtin blocks → machine rules (most restrictive wins, a builtin
 * `floor` turns their `allow` into `ask`) → builtin defaults → a session grant turns `ask` into
 * `allow` (never `blocked`).
 *
 * The machine file is user-writable, so it is never trusted to open anything on its own (spec 제약
 * "보안"): past an app's grade it can at most turn the builtin `blocked` into a person's `ask`.
 */

import {
    BUILTIN_TABLES,
    classifyApp,
    gradeAllows,
    toolGlobMatches,
    type AppCategory,
    type AppClassification,
    type AppGrade,
    type AppIdentity,
    type CuaAction,
    type MachinePolicy,
    type MachineRule,
    type ToolPolicyDecision,
    type ToolPolicyTables,
} from './rules';

export type CuaTargetRequest =
    | { kind: 'none' }
    | { kind: 'pid'; pid: number }
    | { kind: 'frontmost' }
    | { kind: 'launch'; app: AppIdentity }
    /** Only an `element_token`: the pid lives in an earlier snapshot this adapter never saw. */
    | { kind: 'unknown' };

export type TargetResolution = { status: 'resolved'; app: AppIdentity } | { status: 'unresolved' };

export interface PolicyCallInput {
    toolName: string;
    args: Record<string, unknown>;
    platform: NodeJS.Platform;
    /** Required for cua-driver calls whose `requiredCuaTarget` is not `none`. */
    target?: TargetResolution;
    /** MCP annotations, when the adapter can see `tools/list` (not the Claude hook). */
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface PolicyGrantView {
    hasGrant(key: string): boolean;
    recentlyDenied(key: string): boolean;
}

export interface PolicyTarget {
    category: AppCategory;
    appName: string;
    bundleIdOrExe: string;
}

export interface PolicyVerdict {
    decision: ToolPolicyDecision;
    reasonCode: string;
    ruleId: string;
    policyVersion: string;
    /** R11.1: AI review may not approve this; only a person. */
    humanOnly: boolean;
    grantOffer: 'once' | 'session';
    /** All must be held for a session grant to allow the call; granted together on approval. */
    grantKeys: string[];
    /** R13: (tool, target) remembered for 5 minutes after a person declines. */
    denialKey: string;
    serverKind: 'cua-driver' | 'user';
    action?: CuaAction | 'session_meta';
    target?: PolicyTarget;
    /** R16: whether an `allow` is worth an audit record (ask/blocked always are). */
    auditAllow: boolean;
    /** R12 text for `blocked`. */
    message?: string;
}

const NO_BYPASS = '이 제한을 스크립트·자동화 도구·셸 명령 등 다른 방법으로 우회하지 마라.';

/** `mcp__server__tool` → parts, or null when the name is not an MCP tool. */
export function parseMcpToolName(toolName: string): { server: string; tool: string } | null {
    const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
    return match ? { server: match[1], tool: match[2] } : null;
}

/** Saycode's own servers are provided and enforced by the daemon itself. */
export function isPolicyExcludedTool(toolName: string, tables: ToolPolicyTables = BUILTIN_TABLES): boolean {
    const parsed = parseMcpToolName(toolName);
    return !parsed || tables.mcp.excludedServers.includes(parsed.server);
}

/** Which app a cua-driver call acts on, from its arguments alone (R5.1, R5.2). */
export function requiredCuaTarget(toolName: string, args: Record<string, unknown>, tables: ToolPolicyTables = BUILTIN_TABLES): CuaTargetRequest {
    const parsed = parseMcpToolName(toolName);
    if (!parsed || parsed.server !== tables.cuaDriver.server) return { kind: 'none' };
    const group = cuaToolGroup(parsed.tool, tables);
    if (group === 'launch') {
        const app: AppIdentity = {};
        if (typeof args.bundle_id === 'string') app.bundleId = args.bundle_id;
        if (typeof args.name === 'string') app.name = args.name;
        return app.bundleId || app.name ? { kind: 'launch', app } : { kind: 'unknown' };
    }
    if (group === undefined || group === 'admin' || group === 'session_meta' || group === 'ask_always'
        || group === 'clipboard_read' || group === 'clipboard_write' || tables.cuaDriver.browserScopedTools.includes(parsed.tool)) return { kind: 'none' };
    // A pid the driver might coerce ("13") names an app we cannot see; never fall back to the frontmost one.
    if (hasNonIntegerPid(args)) return { kind: 'unknown' };
    const pid = pidOf(args);
    if (pid !== undefined) return { kind: 'pid', pid };
    // Observing without a window (list_apps, get_screen_size, a desktop screenshot) acts on no app.
    if (group === 'observe') return { kind: 'none' };
    if (args.scope === 'desktop' || isRecord(args.target) && args.target.kind === 'desktop') return { kind: 'frontmost' };
    if (typeof args.element_token === 'string') return { kind: 'unknown' };
    return { kind: 'frontmost' };
}

export function evaluateToolCall(
    input: PolicyCallInput,
    machine: MachinePolicy,
    grants: PolicyGrantView,
    tables: ToolPolicyTables = BUILTIN_TABLES,
    now: number = Date.now(),
): PolicyVerdict {
    const parsed = parseMcpToolName(input.toolName);
    const base = {
        policyVersion: tables.policyVersion,
        humanOnly: false,
        grantOffer: 'session' as const,
        grantKeys: [`tool:${input.toolName}`],
        denialKey: input.toolName,
        auditAllow: false,
    };
    if (!parsed) return { ...base, decision: 'allow', reasonCode: 'not_mcp', ruleId: 'builtin:not_mcp', serverKind: 'user' };

    const builtin = parsed.server === tables.cuaDriver.server
        ? cuaDefault(parsed.tool, input, machine, tables)
        : mcpDefault(parsed.tool, input, machine, tables);
    const { fixed, floor, appGrade, keyCombo, baseAction, ...rest } = builtin;
    let verdict: PolicyVerdict = { ...base, ...rest };
    // R3: a file that could not be read stands for "ask" — but not for watching the screen or opening a session.
    const ignoreDegraded = verdict.decision === 'allow' && (verdict.action === 'observe' || verdict.action === 'session_meta');
    const ruled = fixed ? null : applyMachineRules(input.toolName, verdict, floor === true, machine.rules, now, { baseAction, ignoreDegraded });
    if (ruled) verdict = { ...verdict, ...ruled };

    if (verdict.decision === 'ask') {
        if (verdict.grantOffer === 'session' && verdict.grantKeys.every((key) => grants.hasGrant(key))) {
            return { ...verdict, decision: 'allow', reasonCode: 'session_grant', ruleId: `session:${verdict.grantKeys.join('+')}`, auditAllow: verdict.serverKind === 'cua-driver' && verdict.action !== 'observe' };
        }
        if (grants.recentlyDenied(verdict.denialKey)) verdict = { ...verdict, decision: 'blocked', reasonCode: 'recently_denied', ruleId: 'session:recently_denied' };
    }
    return verdict.decision === 'blocked'
        ? { ...verdict, message: blockedMessage({ ...verdict, appGrade, keyCombo }, input.toolName, tables) }
        : verdict;
}

/** A builtin default before machine rules and grants. */
type BuiltinVerdict = Pick<PolicyVerdict, 'decision' | 'reasonCode' | 'ruleId' | 'serverKind'> & Partial<PolicyVerdict> & {
    /** R3 builtin blocks: no file can lift them. */
    fixed?: boolean;
    /** R8.1: a machine `allow` reads as `ask`. */
    floor?: boolean;
    /** For the R12 message only. */
    appGrade?: AppGrade;
    keyCombo?: string;
    /** The tool's own group when the arguments made it a different action (a paste is still `keyboard`). */
    baseAction?: CuaAction;
};

function cuaDefault(tool: string, input: PolicyCallInput, machine: MachinePolicy, tables: ToolPolicyTables): BuiltinVerdict {
    const group = cuaToolGroup(tool, tables);
    const common = { serverKind: 'cua-driver' as const };
    if (group === 'admin') return { ...common, decision: 'blocked', reasonCode: 'admin_tool', ruleId: 'builtin:admin_tool', fixed: true };
    if (group === undefined) return { ...common, decision: 'ask', reasonCode: 'unlisted_cua_tool', ruleId: 'builtin:unlisted_cua_tool' };
    if (group === 'session_meta') return { ...common, decision: 'allow', reasonCode: 'session_meta', ruleId: 'builtin:session_meta', action: 'session_meta' };
    if (group === 'ask_always') return { ...common, decision: 'ask', reasonCode: 'ask_always_tool', ruleId: 'builtin:ask_always_tool', grantOffer: 'once', floor: true };

    const baseAction: CuaAction = group === 'launch' ? 'app_control' : group;
    let action: CuaAction = baseAction;
    const keys = keyCheck(tool, input.args, input.platform, tables);
    if (keys.blocked) return { ...common, decision: 'blocked', reasonCode: keys.blocked, ruleId: `builtin:${keys.blocked}`, action, fixed: true, keyCombo: keys.combo };
    if (keys.clipboard) action = keys.clipboard;
    if (tool === 'click' && (input.args.button === 'right' || input.args.button === 'middle'
        || (typeof input.args.count === 'number' && input.args.count > 1) || keys.modifiers > 0)) action = 'pointer_full';

    const clipboardKeys = action === 'clipboard_read' || action === 'clipboard_write' ? [`clipboard:${action}`] : [];
    const browserScoped = tables.cuaDriver.browserScopedTools.includes(tool);
    const request = requiredCuaTarget(`mcp__${tables.cuaDriver.server}__${tool}`, input.args, tables);
    if (request.kind === 'none' && !browserScoped) {
        // Clipboard tools touch no app window; observing without a window acts on no app.
        if (action === 'observe') return { ...common, decision: 'allow', reasonCode: 'observe', ruleId: 'builtin:observe', action };
        return { ...common, decision: 'ask', reasonCode: 'clipboard_first_use', ruleId: 'builtin:clipboard_first_use', action, grantKeys: clipboardKeys, denialKey: `${tool}|clipboard`, auditAllow: true };
    }
    if (!browserScoped && (!input.target || input.target.status === 'unresolved')) {
        // Floor: an unknown target may be Saycode itself, so no blanket machine `allow` covers it (R5.1).
        return { ...common, decision: 'ask', reasonCode: 'target_unresolved', ruleId: 'builtin:target_unresolved', action, grantOffer: 'once', auditAllow: true, floor: true };
    }

    const app: AppClassification = browserScoped
        ? { category: 'browser', grade: tables.grades.browser, identifier: 'browser', appName: '브라우저' }
        : classifyApp((input.target as Extract<TargetResolution, { status: 'resolved' }>).app, machine.selfIdentity, tables);
    const target: PolicyTarget = { category: app.category, appName: app.appName, bundleIdOrExe: app.identifier };
    const scoped = {
        ...common, action, target, denialKey: `${tool}|${app.identifier}`, auditAllow: action !== 'observe', appGrade: app.grade,
        ...(action !== baseAction ? { baseAction } : {}),
    };
    if (app.grade === 'denied') {
        const reason = app.category === 'self' ? 'self_target' : app.category === 'media' ? 'media_target' : 'denied_app';
        return { ...scoped, decision: 'blocked', reasonCode: reason, ruleId: `builtin:${reason}`, fixed: true };
    }
    if (!gradeAllows(app.grade, tables.cuaDriver.actionMinimumGrade[action])) {
        // Floor: a machine `allow` here reads as a person's `ask`, and its grant covers this action only.
        return {
            ...scoped, decision: 'blocked', reasonCode: 'grade_exceeded', ruleId: `builtin:grade_${app.category}`,
            floor: true, humanOnly: true, grantKeys: [`app:${app.identifier}:${action}`],
        };
    }
    if (group === 'launch' && hasLaunchArguments(input.args)) {
        return { ...scoped, decision: 'ask', reasonCode: 'launch_with_arguments', ruleId: 'builtin:launch_with_arguments', humanOnly: true, grantOffer: 'once', floor: true };
    }
    if (action === 'observe') return { ...scoped, decision: 'allow', reasonCode: 'observe', ruleId: 'builtin:observe' };
    return {
        ...scoped,
        decision: 'ask',
        reasonCode: clipboardKeys.length ? 'clipboard_first_use' : 'first_app_use',
        ruleId: 'builtin:first_app_use',
        humanOnly: app.category === 'terminal' || app.category === 'shell',
        grantKeys: [`app:${app.identifier}`, ...clipboardKeys],
    };
}

function mcpDefault(tool: string, input: PolicyCallInput, machine: MachinePolicy, tables: ToolPolicyTables): BuiltinVerdict {
    const common = { serverKind: 'user' as const };
    // R8.3: annotations are the server's own claim, so they only ever tighten the verdict.
    const verb = verbOf(tool, tables);
    if (verb === 'high') {
        return { ...common, decision: 'ask', reasonCode: 'high_risk_write', ruleId: 'builtin:high_risk_write', humanOnly: true, floor: true, auditAllow: true };
    }
    if ((verb === 'write' && input.annotations?.readOnlyHint !== true) || input.annotations?.destructiveHint === true) {
        return machine.askWriteTools
            ? { ...common, decision: 'ask', reasonCode: 'write_tool', ruleId: 'machine:askWriteTools', auditAllow: true }
            : { ...common, decision: 'allow', reasonCode: 'write_tool', ruleId: 'builtin:write_tool', auditAllow: true };
    }
    return { ...common, decision: 'allow', reasonCode: 'default_allow', ruleId: 'builtin:default_allow' };
}

/**
 * R2.2: most restrictive matching machine rule; a builtin floor reads its `allow` as `ask`.
 * Rules on the tool's base action (`keyboard` for a paste combo) may only tighten the result.
 */
function applyMachineRules(
    toolName: string,
    verdict: PolicyVerdict,
    floor: boolean,
    rules: MachineRule[],
    now: number,
    options: { baseAction?: CuaAction; ignoreDegraded: boolean },
): Partial<PolicyVerdict> | null {
    const applies = (rule: MachineRule, action: PolicyVerdict['action']) => (rule.expiresAt === undefined || rule.expiresAt > now)
        && toolGlobMatches(rule.tool, toolName)
        && (rule.action === undefined || rule.action === action)
        && (rule.target === undefined || targetMatches(rule.target, verdict.target));
    const rank: Record<ToolPolicyDecision, number> = { allow: 0, ask: 1, blocked: 2 };
    const stricter = (a: MachineRule, b: MachineRule) => (rank[b.decision] > rank[a.decision] ? b : a);
    const ruled = ruleDecision(rules.filter((rule) => applies(rule, verdict.action) && !(options.ignoreDegraded && isDegradedRule(rule))));
    if (!options.baseAction) return ruled;
    const tightening = rules.filter((rule) => rule.action === options.baseAction && !isDegradedRule(rule) && applies(rule, options.baseAction));
    if (tightening.length === 0) return ruled;
    const strictest = tightening.reduce(stricter);
    if (rank[strictest.decision] <= rank[ruled?.decision ?? verdict.decision]) return ruled;
    return { decision: strictest.decision, reasonCode: 'machine_rule', ruleId: `machine:${strictest.id}` };

    function ruleDecision(matching: MachineRule[]): Partial<PolicyVerdict> | null {
        if (matching.length === 0) return null;
        // R3: a rule that could not be read stands for "ask", which may tighten but never loosen —
        // otherwise a half-written file would turn a builtin `blocked` into a prompt someone can approve.
        const degraded = matching.filter(isDegradedRule);
        const valid = matching.filter((rule) => !isDegradedRule(rule));
        if (valid.length === 0) {
            if (rank[verdict.decision] >= rank.ask) return null;
            return { decision: 'ask', reasonCode: 'machine_rule_invalid', ruleId: `machine:${degraded[0].id}` };
        }
        const strictest = valid.reduce(stricter);
        const decision = strictest.decision === 'allow' && floor ? 'ask' : strictest.decision;
        if (degraded.length > 0 && rank[decision] < rank.ask) {
            return { decision: 'ask', reasonCode: 'machine_rule_invalid', ruleId: `machine:${degraded[0].id}` };
        }
        return {
            decision,
            reasonCode: decision !== strictest.decision ? 'floor' : 'machine_rule',
            ruleId: `machine:${strictest.id}`,
        };
    }
}

function isDegradedRule(rule: MachineRule): boolean {
    return rule.id.endsWith(':invalid') || rule.id === 'file-unreadable';
}

function targetMatches(ruleTarget: string, target: PolicyTarget | undefined): boolean {
    if (!target) return false;
    return ruleTarget === target.category || ruleTarget.toLowerCase() === target.bundleIdOrExe.toLowerCase();
}

export interface ListedTool {
    /** Full `mcp__<server>__<tool>` name. */
    name: string;
    annotations?: PolicyCallInput['annotations'];
}

export interface CoverageGap {
    tool: string;
    reasonCode: 'unlisted_tool' | 'unlisted_write_tool';
    /** What the builtin default makes of a call to it today. */
    decision: ToolPolicyDecision;
}

/**
 * R9: tools a server lists that a server upgrade could open without anyone deciding — a write tool
 * no machine rule names (a wildcard `allow` does not count), or a cua-driver tool the action table
 * does not classify. Annotations are used only where the adapter saw `tools/list`.
 */
export function coverageGaps(tools: ListedTool[], machine: MachinePolicy, tables: ToolPolicyTables = BUILTIN_TABLES): CoverageGap[] {
    const gaps: CoverageGap[] = [];
    for (const listed of tools) {
        const parsed = parseMcpToolName(listed.name);
        if (!parsed || tables.mcp.excludedServers.includes(parsed.server)) continue;
        if (parsed.server === tables.cuaDriver.server) {
            if (cuaToolGroup(parsed.tool, tables) === undefined) gaps.push({ tool: listed.name, reasonCode: 'unlisted_tool', decision: 'ask' });
            continue;
        }
        const builtin = mcpDefault(parsed.tool, { toolName: listed.name, args: {}, platform: process.platform, annotations: listed.annotations }, machine, tables);
        if (builtin.reasonCode !== 'high_risk_write' && builtin.reasonCode !== 'write_tool') continue;
        const covered = machine.rules.some((rule) => !isDegradedRule(rule) && toolGlobMatches(rule.tool, listed.name)
            && (!rule.tool.includes('*') || rule.decision !== 'allow'));
        if (!covered) gaps.push({ tool: listed.name, reasonCode: 'unlisted_write_tool', decision: builtin.decision });
    }
    return gaps;
}

/** R12: ① what and why, ② what to call instead, ③ do not work around it. */
export function blockedMessage(verdict: Pick<PolicyVerdict, 'reasonCode' | 'target' | 'action'> & { appGrade?: AppGrade; keyCombo?: string }, toolName: string, tables: ToolPolicyTables = BUILTIN_TABLES): string {
    const target = verdict.target;
    const category = target?.category ?? 'other';
    const what = ((): string => {
        switch (verdict.reasonCode) {
            case 'self_target': return `Saycode 자신의 화면(${target?.appName})은 조작할 수 없다 — 자기 권한을 바꿀 수 있기 때문이다.`;
            case 'media_target': return `${target?.appName}은 미디어·전자책 앱이라 조작할 수 없다.`;
            case 'denied_app': return `${target?.appName}은 조작이 금지된 앱이다.`;
            case 'grade_exceeded': return `${target?.appName}(${category} 앱, 허용 등급 ${verdict.appGrade ?? tables.grades[category]})에는 ${verdict.action} 동작을 할 수 없다.`;
            case 'system_key_combo': return `시스템 키 조합${verdict.keyCombo ? ` ${verdict.keyCombo}` : ''}은 보낼 수 없다.`;
            case 'too_many_keys': return '한 동작에 키를 너무 많이 보낼 수 없다 (수식키가 아닌 키 1개, 전체 8개 이하).';
            case 'admin_tool': return `${toolName}은 컴퓨터 사용 도구 설정을 바꾸는 관리 도구라 에이전트가 부를 수 없다.`;
            case 'recently_denied': return `사용자가 방금 ${toolName}${target ? ` (${target.appName})` : ''} 호출을 거절했다.`;
            case 'user_denied': return `사용자가 ${toolName}${target ? ` (${target.appName})` : ''} 호출을 거절했다.`;
            case 'approval_timeout': return `${toolName} 호출 승인을 30분 안에 받지 못했다.`;
            case 'unattended_no_approver': return `${toolName}은 사람의 승인이 필요한데, 이 실행에는 승인할 사람이 없다.`;
            case 'no_approver': return `${toolName}은 Saycode 앱에서 승인을 받아야 하는데, 이 세션에서는 승인 요청을 띄울 수 없다.`;
            default: return `도구 정책이 ${toolName} 호출을 막았다 (${verdict.reasonCode}).`;
        }
    })();
    const instead = verdict.reasonCode === 'grade_exceeded' || verdict.reasonCode === 'self_target' || verdict.reasonCode === 'media_target'
        ? tables.alternatives[category]
        : verdict.reasonCode === 'recently_denied' || verdict.reasonCode === 'user_denied'
            ? '사용자가 다음 지시를 줄 때까지 이 호출을 반복하지 마라'
            : tables.alternatives.other;
    return `도구 정책으로 막힘: ${what} 대신: ${instead}. ${NO_BYPASS}`;
}

type CuaGroup = CuaAction | 'launch' | 'session_meta' | 'ask_always' | 'admin';

function cuaToolGroup(tool: string, tables: ToolPolicyTables): CuaGroup | undefined {
    if (tool === 'launch_app') return 'launch';
    for (const [group, tools] of Object.entries(tables.cuaDriver.tools)) {
        if (tools.includes(tool)) return group as CuaGroup;
    }
    return undefined;
}

function hasLaunchArguments(args: Record<string, unknown>): boolean {
    const nonEmpty = (value: unknown) => Array.isArray(value) && value.length > 0;
    return nonEmpty(args.urls) || nonEmpty(args.additional_arguments) || args.webkit_inspector_port !== undefined;
}

function hasNonIntegerPid(args: Record<string, unknown>): boolean {
    if (args.pid !== undefined && !Number.isInteger(args.pid)) return true;
    return isRecord(args.target) && args.target.pid !== undefined && !Number.isInteger(args.target.pid);
}

function pidOf(args: Record<string, unknown>): number | undefined {
    if (Number.isInteger(args.pid)) return args.pid as number;
    if (isRecord(args.target) && args.target.kind === 'window' && Number.isInteger(args.target.pid)) return args.target.pid as number;
    return undefined;
}

const MODIFIER_ALIASES: Record<string, string> = {
    meta: 'meta', super: 'meta', command: 'meta', cmd: 'meta', windows: 'meta', win: 'meta',
    ctrl: 'ctrl', control: 'ctrl', lctrl: 'ctrl', lcontrol: 'ctrl', rctrl: 'ctrl', rcontrol: 'ctrl',
    shift: 'shift', lshift: 'shift', rshift: 'shift', alt: 'alt', option: 'alt', opt: 'alt', fn: 'fn',
};
const KEY_ALIASES: Record<string, string> = { esc: 'escape', del: 'delete', ' ': 'space', '\t': 'tab', '\x1b': 'escape', '\x7f': 'delete', '\r': 'enter', '\b': 'backspace' };
const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'meta'];

interface KeyCheck { blocked?: 'system_key_combo' | 'too_many_keys'; clipboard?: 'clipboard_read' | 'clipboard_write'; modifiers: number; combo?: string }

/** R7: system key combos, key count limits and clipboard semantics of hotkey/press_key/click. */
function keyCheck(tool: string, args: Record<string, unknown>, platform: NodeJS.Platform, tables: ToolPolicyTables): KeyCheck {
    const raw: unknown[] = tool === 'hotkey' ? asArray(args.keys)
        : tool === 'press_key' ? [...asArray(args.modifiers), args.key]
            : tool === 'click' ? asArray(args.modifier) : [];
    const names = raw.filter((key): key is string => typeof key === 'string');
    if (names.length === 0) return { modifiers: 0 };
    const mods = new Set<string>();
    const keys: string[] = [];
    for (const name of names) {
        const lower = name.length === 1 ? name.toLowerCase() : name.trim().toLowerCase();
        const modifier = MODIFIER_ALIASES[lower];
        if (modifier) mods.add(modifier);
        else keys.push(KEY_ALIASES[lower] ?? lower);
    }
    const ordered = MODIFIER_ORDER.filter((mod) => mods.has(mod));
    const combo = [...ordered, ...keys].join('+');
    if (keys.length > 1 || names.length > tables.cuaDriver.maxKeysPerAction) return { blocked: 'too_many_keys', modifiers: mods.size, combo };
    if ((tables.systemKeyCombos[platform] ?? []).includes(combo)) return { blocked: 'system_key_combo', modifiers: mods.size, combo };
    const key = keys[0];
    const command = mods.has('meta') || mods.has('ctrl');
    let clipboard: KeyCheck['clipboard'];
    if (command && key === 'v' || key === 'insert' && mods.has('shift')) clipboard = 'clipboard_read';
    if (command && (key === 'c' || key === 'x') || key === 'insert' && mods.has('ctrl') || key === 'delete' && mods.has('shift')) clipboard = 'clipboard_write';
    return { clipboard, modifiers: tool === 'click' ? mods.size : 0, combo };
}

/**
 * R8 verb dictionary: every word of the tool name (`_`, `-`, `.` and camelCase boundaries) against the
 * dictionary, the strongest grade winning — high > write. A dictionary noun (`message`, `email`) is a noun,
 * not a verb, as the first word before a read verb (`message_list`, the old two-word window, unchanged) and
 * from the third word on after a read verb in the same clause (`get_latest_release`, not `get_quote_and_trade`).
 * Splitting acronyms (`bulkURLDelete`) or not (`DElete`) are both tried, so no name reads weaker than before.
 */
export function verbOf(tool: string, tables: ToolPolicyTables = BUILTIN_TABLES): 'high' | 'write' | null {
    const camel = tool.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
    const grade = Math.max(verbGrade(camel, tables), verbGrade(camel.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2'), tables));
    return grade === 2 ? 'high' : grade === 1 ? 'write' : null;
}

const CLAUSE_WORDS = ['and', 'then', 'or'];

function verbGrade(name: string, tables: ToolPolicyTables): number {
    const { mcp } = tables;
    const words = name.toLowerCase().split(/[_\-.]+/).filter(Boolean);
    // A read verb covers only its own clause: `get_quote_and_trade` trades.
    const readBefore = (index: number) => {
        const clause = words.slice(0, index);
        const start = Math.max(...CLAUSE_WORDS.map((word) => clause.lastIndexOf(word))) + 1;
        return clause.slice(start).some((word) => mcp.readVerbs.includes(word));
    };
    const noun = (word: string, index: number) => mcp.nounFirstWords.includes(word)
        && (index === 0 ? mcp.readVerbs.includes(words[1]) : index >= 2 && readBefore(index));
    return Math.max(0, ...words.map((word, index) => noun(word, index) ? 0
        : mcp.highRiskVerbs.includes(word) ? 2 : mcp.writeVerbs.includes(word) ? 1 : 0));
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

