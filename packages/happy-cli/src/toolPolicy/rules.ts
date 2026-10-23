/**
 * Tool policy rule sources (aplus-dev-studio specs/agent-tool-policy R2, R3, R10, R14).
 *
 * - `builtin`: the data file `tables.v1.json` (app categories, cua-driver action table, system key
 *   combos, MCP verb dictionaries). Shipped in the package so Desktop's managed-extension broker can
 *   read the same table (plan.md "결정: 집행 위치" — one copy, never two).
 * - `machine`: `<HAPPY_HOME_DIR>/tool-policy.json`, written by Desktop and re-read when its mtime
 *   changes (at most every 2 seconds). It is a user-writable file, so it can only add `machine`
 *   rules — it can never lift a builtin `blocked` or `floor` (that is decided in evaluate.ts).
 *
 * A malformed rule or an unreadable file degrades to `ask`, never to `blocked` (R3): one typo in a
 * hand-edited file must not stop every tool, and must not silently open one either.
 */

import { readFileSync, statSync } from 'node:fs';
import tablesJson from './tables.v1.json';

export type ToolPolicyDecision = 'allow' | 'ask' | 'blocked';
export type AppCategory = 'browser' | 'terminal' | 'shell' | 'trading' | 'media' | 'self' | 'other';
export type AppGrade = 'read' | 'click' | 'full' | 'denied';
export type CuaAction = 'observe' | 'pointer' | 'pointer_full' | 'keyboard' | 'app_control' | 'clipboard_read' | 'clipboard_write';
type CuaToolGroup = CuaAction | 'session_meta' | 'ask_always' | 'admin';

interface AppMatchers {
    bundleIds?: string[];
    bundleIdPrefixes?: string[];
    /** Also match `<bundleId>.` children (Chrome app shims `com.google.Chrome.app.*`). */
    bundleIdChildren?: boolean;
    aumids?: string[];
    exeNames?: string[];
    processNames?: string[];
    nameIncludes?: string[];
    /** Lowercase prefixes of the display name or executable basename (helpers: `Saycode Helper (Renderer)`). */
    namePrefixes?: string[];
    /** Lowercase fragments of the executable path (`/saycode.app/` covers every helper inside the bundle). */
    pathIncludes?: string[];
}

export interface ToolPolicyTables {
    policyVersion: string;
    grades: Record<AppCategory, AppGrade>;
    alternatives: Record<AppCategory, string>;
    apps: Record<Exclude<AppCategory, 'other'>, AppMatchers>;
    gradeOverrides: Record<string, AppGrade>;
    cuaDriver: {
        server: string;
        actionMinimumGrade: Record<CuaAction, AppGrade>;
        tools: Record<CuaToolGroup, string[]>;
        /** Tools that drive a browser tab over CDP: their target is always a `browser`, whatever is in front. */
        browserScopedTools: string[];
        maxKeysPerAction: number;
    };
    systemKeyCombos: Partial<Record<NodeJS.Platform, string[]>>;
    mcp: {
        /**
         * Which words of a tool name the verb rule reads. Only `all` exists (2026-10-23.1, every word); Desktop reads
         * it to tell this rule from the older first-two-words one when it labels tools for a runtime it did not ship with.
         */
        verbWords?: 'all';
        excludedServers: string[];
        highRiskVerbs: string[];
        writeVerbs: string[];
        /** Dictionary words that are also nouns; followed by a read verb they name a read tool. */
        nounFirstWords: string[];
        readVerbs: string[];
    };
}

export const BUILTIN_TABLES: ToolPolicyTables = tablesJson as unknown as ToolPolicyTables;

const GRADE_ORDER: Record<AppGrade, number> = { denied: -1, read: 0, click: 1, full: 2 };

/** True when `have` permits an action needing `need`. `denied` permits nothing. */
export function gradeAllows(have: AppGrade, need: AppGrade): boolean {
    return have !== 'denied' && GRADE_ORDER[have] >= GRADE_ORDER[need];
}

/**
 * Tool-name glob. Segments are split on `__`; `*` stays inside one segment, except that a final
 * segment that is exactly `*` also covers every deeper segment — so `mcp__*` is every server's
 * tools and `mcp__a__*` is server `a` only (spec 용어 "tool").
 */
export function toolGlobMatches(glob: string, toolName: string): boolean {
    const globParts = glob.split('__');
    const nameParts = toolName.split('__');
    for (let i = 0; i < globParts.length; i++) {
        const part = globParts[i];
        if (i === globParts.length - 1 && part === '*') return nameParts.length >= globParts.length;
        if (i >= nameParts.length || !segmentMatches(part, nameParts[i])) return false;
    }
    return globParts.length === nameParts.length;
}

function segmentMatches(pattern: string, value: string): boolean {
    const regex = new RegExp('^' + pattern.split('*').map(escapeRegExp).join('.*') + '$');
    return regex.test(value);
}

function escapeRegExp(text: string): string {
    return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

const VALID_GLOB = /^[A-Za-z0-9_.\-*:]+$/;
const DECISIONS: readonly ToolPolicyDecision[] = ['allow', 'ask', 'blocked'];
const CUA_ACTIONS: readonly CuaAction[] = ['observe', 'pointer', 'pointer_full', 'keyboard', 'app_control', 'clipboard_read', 'clipboard_write'];

export interface MachineRule {
    /** Stable id for audit (`machine:<id>`). */
    id: string;
    tool: string;
    /** App category or app identifier (bundle id / exe name). cua-driver calls only. */
    target?: string;
    action?: CuaAction;
    decision: ToolPolicyDecision;
    expiresAt?: number;
}

export interface SelfIdentity {
    pids: number[];
    bundleIds: string[];
    exeNames: string[];
}

export type MachinePolicyStatus = 'absent' | 'loaded' | 'unsupported' | 'unreadable';

export interface MachinePolicy {
    status: MachinePolicyStatus;
    revision: number | null;
    rules: MachineRule[];
    selfIdentity: SelfIdentity;
    /** R8.2 "쓰기 도구는 묻기". Optional in file v1; absent means allow + audit. */
    askWriteTools: boolean;
}

const EMPTY_SELF: SelfIdentity = { pids: [], bundleIds: [], exeNames: [] };

export const ABSENT_MACHINE_POLICY: MachinePolicy = {
    status: 'absent', revision: null, rules: [], selfIdentity: EMPTY_SELF, askWriteTools: false,
};

/** Every `mcp__*` call asks when the file exists but cannot be read (R3). */
const UNREADABLE_MACHINE_POLICY: MachinePolicy = {
    status: 'unreadable', revision: null, selfIdentity: EMPTY_SELF, askWriteTools: false,
    rules: [{ id: 'file-unreadable', tool: 'mcp__*', decision: 'ask' }],
};

/**
 * Parses file format v1:
 * `{ version: 1, revision, updatedAt, selfIdentity: { pids, bundleIds, exeNames }, rules: [Rule],
 *    audit: { enabled }, settings?: { askWriteTools } }`.
 * An unknown `version` ignores the whole file (builtin only). A malformed rule becomes an `ask`
 * rule over the narrowest glob that is still valid (its own, or `mcp__*`).
 */
export function parseMachinePolicy(raw: unknown): MachinePolicy {
    if (!isRecord(raw)) return UNREADABLE_MACHINE_POLICY;
    if (raw.version !== 1) return { ...ABSENT_MACHINE_POLICY, status: 'unsupported' };
    const rules = Array.isArray(raw.rules) ? raw.rules.map((rule, index) => parseRule(rule, index)) : [];
    const self = isRecord(raw.selfIdentity) ? raw.selfIdentity : {};
    const settings = isRecord(raw.settings) ? raw.settings : {};
    return {
        status: 'loaded',
        revision: typeof raw.revision === 'number' ? raw.revision : null,
        rules,
        selfIdentity: {
            pids: numbers(self.pids),
            bundleIds: strings(self.bundleIds),
            exeNames: strings(self.exeNames).map((name) => name.toLowerCase()),
        },
        askWriteTools: settings.askWriteTools === true,
    };
}

function parseRule(raw: unknown, index: number): MachineRule {
    const record = isRecord(raw) ? raw : {};
    const id = typeof record.id === 'string' && record.id ? record.id : `rule-${index}`;
    const tool = typeof record.tool === 'string' && VALID_GLOB.test(record.tool) ? record.tool : null;
    const decision = DECISIONS.includes(record.decision as ToolPolicyDecision) ? record.decision as ToolPolicyDecision : null;
    const target = record.target === undefined ? undefined : typeof record.target === 'string' && record.target ? record.target : null;
    const action = record.action === undefined ? undefined : CUA_ACTIONS.includes(record.action as CuaAction) ? record.action as CuaAction : null;
    const expiresAt = typeof record.expiresAt === 'number' ? record.expiresAt : undefined;
    if (!tool || !decision || target === null || action === null) {
        return { id: `${id}:invalid`, tool: tool ?? 'mcp__*', decision: 'ask' };
    }
    return { id, tool, decision, ...(target ? { target } : {}), ...(action ? { action } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}) };
}

/**
 * Reads the machine policy file at most once per `maxAgeMs`, and again only when its mtime or
 * size changed (R10: the next call after a settings change sees it).
 */
export function createMachinePolicyLoader(path: string, options: { now?: () => number; maxAgeMs?: number } = {}): () => MachinePolicy {
    const now = options.now ?? Date.now;
    const maxAgeMs = options.maxAgeMs ?? 2000;
    let cached: MachinePolicy = ABSENT_MACHINE_POLICY;
    let stamp: string | null = null;
    let checkedAt = Number.NEGATIVE_INFINITY;
    return () => {
        if (now() - checkedAt < maxAgeMs) return cached;
        checkedAt = now();
        let nextStamp: string;
        try {
            const stat = statSync(path);
            nextStamp = `${stat.mtimeMs}:${stat.size}`;
        } catch (error) {
            stamp = null;
            cached = (error as NodeJS.ErrnoException).code === 'ENOENT' ? ABSENT_MACHINE_POLICY : UNREADABLE_MACHINE_POLICY;
            return cached;
        }
        if (nextStamp === stamp) return cached;
        stamp = nextStamp;
        try {
            cached = parseMachinePolicy(JSON.parse(readFileSync(path, 'utf8')));
        } catch {
            cached = UNREADABLE_MACHINE_POLICY;
        }
        return cached;
    };
}

/** What the target resolver learned about one app. Any field may be missing. */
export interface AppIdentity {
    pid?: number;
    bundleId?: string;
    /** Windows AUMID when the window belongs to a packaged app. */
    aumid?: string;
    /** Executable path or basename. */
    executable?: string;
    name?: string;
}

export interface AppClassification {
    category: AppCategory;
    grade: AppGrade;
    /** The identifier rules and grants are keyed on: bundle id, then exe basename, then name. */
    identifier: string;
    appName: string;
}

/**
 * Category order follows Claude Desktop (`Esr` then name `Asr`), with Saycode's own `self` and
 * `media` checked first because both are always denied.
 */
export function classifyApp(app: AppIdentity, self: SelfIdentity, tables: ToolPolicyTables = BUILTIN_TABLES): AppClassification {
    const category = categoryOf(app, self, tables);
    const exe = app.executable ? basename(app.executable) : undefined;
    const identifier = app.bundleId ?? app.aumid ?? exe ?? (app.name ? app.name.toLowerCase() : 'unknown');
    const override = app.bundleId ? tables.gradeOverrides[app.bundleId] : undefined;
    return {
        category,
        grade: override ?? tables.grades[category],
        identifier,
        appName: app.name ?? exe ?? app.bundleId ?? 'unknown app',
    };
}

function categoryOf(app: AppIdentity, self: SelfIdentity, tables: ToolPolicyTables): AppCategory {
    const exe = app.executable ? basename(app.executable) : undefined;
    const name = app.name?.toLowerCase();
    const apps = tables.apps;

    if (app.pid !== undefined && self.pids.includes(app.pid)) return 'self';
    if (app.bundleId && (inList(apps.self.bundleIds, app.bundleId) || self.bundleIds.includes(app.bundleId)
        || (apps.self.bundleIdPrefixes ?? []).some((prefix) => app.bundleId!.startsWith(prefix)))) return 'self';
    if (exe && (inList(apps.self.exeNames, exe) || self.exeNames.includes(exe))) return 'self';
    // `ps` fallback and `launch_app {name}` see only a path or a name; helpers live inside the app bundle.
    const path = app.executable?.toLowerCase();
    if (path && (apps.self.pathIncludes ?? []).some((part) => path.includes(part))) return 'self';
    if ([exe, name].some((value) => value && (apps.self.namePrefixes ?? []).some((prefix) => value.startsWith(prefix)))) return 'self';

    if (isMedia(app, exe, name, tables)) return 'media';

    if (app.bundleId) {
        const id = app.bundleId;
        if (inList(apps.browser.bundleIds, id)) return 'browser';
        if (inList(apps.terminal.bundleIds, id)) return 'terminal';
        if (inList(apps.trading.bundleIds, id)) return 'trading';
        if (apps.browser.bundleIdChildren && (apps.browser.bundleIds ?? []).some((parent) => id.startsWith(`${parent}.`))) return 'browser';
        if (inList(apps.shell.bundleIds, id)) return 'shell';
    }
    if (app.aumid) {
        if (inList(apps.browser.aumids, app.aumid)) return 'browser';
        if (inList(apps.terminal.aumids, app.aumid)) return 'terminal';
    }
    if (exe) {
        if (inList(apps.browser.exeNames, exe)) return 'browser';
        if (inList(apps.terminal.exeNames, exe) || exe.match(/^autohotkey.*\.exe$/)) return 'terminal';
        if (inList(apps.trading.exeNames, exe)) return 'trading';
        if (inList(apps.shell.exeNames, exe)) return 'shell';
        for (const variant of processNameVariants(app.executable!)) {
            if (inList(apps.browser.processNames, variant)) return 'browser';
            if (inList(apps.terminal.processNames, variant)) return 'terminal';
            if (inList(apps.trading.processNames, variant)) return 'trading';
        }
    }
    if (name) {
        if ((apps.trading.nameIncludes ?? []).some((part) => name.includes(part))) return 'trading';
        if ((apps.browser.nameIncludes ?? []).some((part) => name.includes(part))) return 'browser';
        if ((apps.terminal.nameIncludes ?? []).some((part) => name.includes(part))) return 'terminal';
        if ((apps.shell.nameIncludes ?? []).some((part) => name.includes(part))) return 'shell';
    }
    return 'other';
}

function isMedia(app: AppIdentity, exe: string | undefined, name: string | undefined, tables: ToolPolicyTables): boolean {
    const media = tables.apps.media;
    // A bundle id that starts with `<` is the "could not resolve" marker (policy-tables §1.1).
    if (app.bundleId && (app.bundleId.startsWith('<') || inList(media.bundleIds, app.bundleId))) return true;
    if (app.executable && processNameVariants(app.executable).some((variant) => inList(media.exeNames, variant))) return true;
    if (exe && inList(media.exeNames, exe)) return true;
    if (!name) return false;
    const collapsed = name.replace(/\s+/g, '');
    return (media.nameIncludes ?? []).some((part) => name.includes(part)
        || (part.includes(' ') && part.replace(/\s+/g, '') !== 'playbooks' && collapsed.includes(part.replace(/\s+/g, ''))));
}

function basename(path: string): string {
    return path.toLowerCase().split(/[\\/]/).pop() ?? '';
}

/** `/usr/bin/firefox-esr` → `firefox-esr`, `firefox`; snap and flatpak export names too (Claude `wsr`). */
function processNameVariants(path: string): string[] {
    const base = basename(path);
    const variants = [base, base.replace(/[-.]?\d+(\.\d+)*$/, '')];
    const lower = path.toLowerCase();
    if (lower.startsWith('/snap/bin/') && base.includes('.')) variants.push(base.split('.')[0]);
    else if (lower.includes('/exports/bin/') && base.includes('.')) variants.push(base.split('.').pop() ?? base);
    return variants;
}

function inList(list: string[] | undefined, value: string): boolean {
    return (list ?? []).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

function numbers(value: unknown): number[] {
    return Array.isArray(value) ? value.filter((item): item is number => Number.isInteger(item) && item > 0) : [];
}
