/**
 * One session's tool policy enforcement point (aplus-dev-studio specs/agent-tool-policy R3, R11, R13, R16).
 *
 * Adapters (the Claude PreToolUse hook, the cua-driver shadow proxy and the stdio bridge) hand a
 * pending call to `decide`. It resolves the target app, evaluates the call against the
 * current rules, and for `ask` raises an ordinary permission request through the session's
 * approver and waits — up to 30 minutes — for a person. Grants are created only from that answer.
 *
 * Failure direction: an evaluation error is `ask`; `ask` with nobody to ask is `blocked`. In local
 * (terminal) mode the person is at Claude's own prompt, so `ask` goes there instead (`terminalPrompt`;
 * measured 2026-10-22: a hook "ask" makes the Claude 2.1.285 TUI ask even under bypassPermissions,
 * and a persistent "don't ask again" rule does not skip it). That answer never reaches the daemon,
 * so it creates no grant and no R13 denial memory.
 */

import {
    blockedMessage,
    coverageGaps,
    evaluateToolCall,
    isPolicyExcludedTool,
    parseMcpToolName,
    requiredCuaTarget,
    type CuaTargetRequest,
    type ListedTool,
    type OrgToolRules,
    type PolicyCallInput,
    type PolicyTarget,
    type PolicyVerdict,
} from './evaluate';
import { BUILTIN_TABLES, type CuaAction, type MachinePolicy, type ToolPolicyTables } from './rules';
import type { PolicyGrantStore } from './grants';
import type { TargetResolver } from './targetResolver';
import type { ToolPolicyAuditLog, ToolPolicyOutcome } from './audit';
import { composePolicyDenyMessage } from '@/utils/permissionDenyMessage';

export const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The abort reason the gate gives a policy approval it stops waiting for (codexcli-approval-session-binding
 * T15). Approvers compare `signal.reason` with it to record the withdrawal as `expired` rather than
 * `aborted`; any other abort (the hook went away) stays `aborted`.
 */
export const APPROVAL_TIMEOUT_ABORT_REASON = Object.freeze({ kind: 'tool-policy-approval-timeout' as const });

/** Rides on `agentState.requests[id].policy` (R11). Clients that do not know it show a plain prompt. */
export interface PermissionPolicyMeta {
    reasonCode: string;
    ruleId: string;
    humanOnly: boolean;
    target?: PolicyTarget;
    action?: CuaAction | 'session_meta';
    grantOffer: 'once' | 'session';
}

export interface PolicyApprovalAnswer {
    browserClientConsent?: { leaseMinutes: 15 | 60 | 1440; rememberSameScope: boolean };
    approved: boolean;
    /** R11.3: absent from older clients, which means `once`. */
    policyGrant: 'once' | 'session';
    /** An older client's reason. A policy deny never had a default sentence in it, so it is read as the person's own. */
    reason?: string;
    /** Only what the person wrote. Wins over `reason`. */
    userReason?: string;
}

export interface PolicyApprover {
    /** Rejects when `signal` aborts; the request is then withdrawn. */
    requestPolicyApproval(request: {
        id: string;
        toolName: string;
        args: Record<string, unknown>;
        policy: PermissionPolicyMeta;
        signal: AbortSignal;
    }): Promise<PolicyApprovalAnswer>;
}

export interface PreToolUseCall {
    toolName: string;
    toolInput: unknown;
    toolUseId?: string;
    /** Absent: the Claude hook. The proxy and the bridge cannot hand `ask` to a terminal prompt. */
    origin?: 'cua-proxy' | 'bridge';
    /** Shadow proxy: the pid of the snapshot that issued this call's `element_token` (R5.1). */
    elementPid?: number;
    /** Proxy and bridge: the tool's `tools/list` annotations (R8, trusted only to tighten). */
    annotations?: PolicyCallInput['annotations'];
    /** Claude hook: the session's permission mode, when Claude sent it. */
    permissionMode?: string;
}

export type HookVerdict =
    /** Let Claude's normal permission flow run, as it would without a policy. */
    | { kind: 'pass' }
    /** A person approved it here; skip Claude's own prompt. */
    | { kind: 'allow' }
    /** Local (terminal) mode: let Claude's own prompt ask the person at the keyboard. */
    | { kind: 'ask'; reason: string; reasonCode: string }
    | { kind: 'deny'; reason: string; reasonCode: string };

export interface ToolPolicyGate {
    decide(call: PreToolUseCall, signal: AbortSignal): Promise<HookVerdict>;
    /** R9: a server's tool list as an adapter saw it; each gap is recorded once per session. */
    toolsListed(tools: ListedTool[]): void;
}

export function createToolPolicyGate(deps: {
    loadMachinePolicy: () => MachinePolicy;
    resolver: TargetResolver;
    grants: PolicyGrantStore;
    audit: ToolPolicyAuditLog;
    approver: () => PolicyApprover | null;
    /**
     * Nobody can answer this turn (agent-tool-policy R3): `ask` becomes `blocked`. Read on every
     * decision, because it is the current turn's attendance (codexcli-approval-session-binding R10a,
     * Q9) — a person writing mid-turn makes the next `ask` wait for them.
     */
    unattended: () => boolean;
    /** True while the session runs in Claude's terminal UI, where a person answers Claude's own prompt. */
    terminalPrompt?: () => boolean;
    /**
     * The session's organization tool rules, read on every call (codexcli-org-requirements R10.4). Also
     * carries the document revision a conversation grant is stamped with (R1a), rules or not.
     */
    orgRules?: () => OrgToolRules | null;
    /** Organization verdicts, for the organization audit as well (R17). */
    orgAudit?: (entry: { tool: string; reasonCode: string; ruleId: string }) => void;
    platform?: NodeJS.Platform;
    tables?: ToolPolicyTables;
    now?: () => number;
    approvalTimeoutMs?: number;
    newRequestId?: () => string;
}): ToolPolicyGate {
    const tables = deps.tables ?? BUILTIN_TABLES;
    const platform = deps.platform ?? process.platform;
    const now = deps.now ?? Date.now;
    const approvalTimeoutMs = deps.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;

    const audit = (call: PreToolUseCall, verdict: PolicyVerdict, outcome?: ToolPolicyOutcome, decision = verdict.decision, reasonCode = verdict.reasonCode) => {
        if (decision === 'allow' && !verdict.auditAllow && outcome === undefined) return;
        deps.audit.record({
            at: now(),
            tool: call.toolName,
            server: verdict.serverKind,
            ...(verdict.action ? { action: verdict.action } : {}),
            ...(verdict.target ? { targetCategory: verdict.target.category, targetId: verdict.target.bundleIdOrExe } : {}),
            decision,
            reasonCode,
            ruleId: verdict.ruleId,
            policyVersion: verdict.policyVersion,
            ...(outcome ? { outcome } : {}),
        });
    };

    // The answer's reason goes to the model only; the audit records the outcome, never what the person wrote.
    const refuse = (call: PreToolUseCall, verdict: PolicyVerdict, reasonCode: string, outcome: ToolPolicyOutcome, answer: Pick<PolicyApprovalAnswer, 'reason' | 'userReason'> = {}): HookVerdict => {
        audit(call, verdict, outcome, 'blocked', reasonCode);
        return { kind: 'deny', reasonCode, reason: composePolicyDenyMessage(blockedMessage({ ...verdict, reasonCode }, call.toolName, tables), answer) };
    };

    const evaluate = async (call: PreToolUseCall, args: Record<string, unknown>, org: OrgToolRules | null): Promise<PolicyVerdict> => {
        const request = withSnapshotPid(requiredCuaTarget(call.toolName, args, tables), args, call.elementPid);
        const target = request.kind === 'none' ? undefined : await deps.resolver.resolve(request);
        return evaluateToolCall(
            { toolName: call.toolName, args, platform, target, ...(call.annotations ? { annotations: call.annotations } : {}) },
            deps.loadMachinePolicy(), deps.grants.view(), tables, now(), org,
        );
    };
    const covered = new Set<string>();

    return {
        decide: async (call, signal) => {
            if (isPolicyExcludedTool(call.toolName, tables)) return { kind: 'pass' };
            const args = isRecord(call.toolInput) ? call.toolInput : {};
            // Read before the grants are: a revoke from here on keeps this answer from granting (R18).
            const askedAt = deps.grants.revision();
            // One read per call: the rules judged and the revision a grant is stamped with are the same document's.
            const org = deps.orgRules?.() ?? null;
            let verdict: PolicyVerdict;
            try {
                verdict = await evaluate(call, args, org);
            } catch {
                verdict = evaluationErrorVerdict(call.toolName, tables);
            }
            if (verdict.decision !== 'allow' && (verdict.ruleId.startsWith('org:') || verdict.reasonCode === 'org_rule_revision')) {
                deps.orgAudit?.({ tool: call.toolName, reasonCode: verdict.reasonCode, ruleId: verdict.ruleId });
            }

            if (verdict.decision === 'allow') {
                audit(call, verdict);
                return { kind: 'pass' };
            }
            if (verdict.decision === 'blocked') {
                audit(call, verdict);
                return { kind: 'deny', reasonCode: verdict.reasonCode, reason: verdict.message ?? blockedMessage(verdict, call.toolName, tables) };
            }

            // The hook went away while the target was being looked up: nobody will read an answer.
            if (signal.aborted) return refuse(call, verdict, 'aborted', 'aborted');
            if (deps.unattended()) return refuse(call, verdict, 'unattended_no_approver', 'unattended');
            const approver = deps.approver();
            if (!approver && call.origin === undefined && deps.terminalPrompt?.()) {
                audit(call, verdict, 'terminal_prompt', 'ask');
                return { kind: 'ask', reasonCode: verdict.reasonCode, reason: askMessage(verdict, call.toolName) };
            }
            if (!approver) return refuse(call, verdict, 'no_approver', 'unattended');

            const controller = new AbortController();
            const onAbort = () => controller.abort();
            signal.addEventListener('abort', onAbort, { once: true });
            let timedOut = false;
            const timer = setTimeout(() => { timedOut = true; controller.abort(APPROVAL_TIMEOUT_ABORT_REASON); }, approvalTimeoutMs);
            try {
                const answer = await approver.requestPolicyApproval({
                    id: call.toolUseId ?? deps.newRequestId?.() ?? `policy-${now()}`,
                    toolName: call.toolName,
                    args,
                    policy: {
                        reasonCode: verdict.reasonCode,
                        ruleId: verdict.ruleId,
                        humanOnly: verdict.humanOnly,
                        ...(verdict.target ? { target: verdict.target } : {}),
                        ...(verdict.action ? { action: verdict.action } : {}),
                        grantOffer: verdict.grantOffer,
                    },
                    signal: controller.signal,
                });
                if (!answer.approved) {
                    deps.grants.recordDenial(verdict.denialKey);
                    return refuse(call, verdict, 'user_denied', 'denied', answer);
                }
                if (answer.policyGrant === 'session' && verdict.grantOffer === 'session') deps.grants.grant(verdict.grantKeys, askedAt, org?.revision ?? null);
                audit(call, verdict, 'approved', 'ask');
                return { kind: 'allow' };
            } catch {
                return refuse(call, verdict, timedOut ? 'approval_timeout' : 'aborted', timedOut ? 'timeout' : 'aborted');
            } finally {
                clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
            }
        },
        toolsListed: (tools) => {
            let gaps;
            try {
                gaps = coverageGaps(tools.filter((tool) => !covered.has(tool.name)), deps.loadMachinePolicy(), tables);
            } catch {
                return;
            }
            for (const gap of gaps) {
                covered.add(gap.tool);
                deps.audit.note({
                    at: now(),
                    tool: gap.tool,
                    server: parseMcpToolName(gap.tool)?.server === tables.cuaDriver.server ? 'cua-driver' : 'user',
                    decision: gap.decision,
                    reasonCode: gap.reasonCode,
                    ruleId: 'builtin:coverage',
                    policyVersion: tables.policyVersion,
                });
            }
        },
    };
}

/**
 * An `element_token` names an element of an earlier `get_window_state` snapshot. The shadow proxy
 * saw that snapshot and passes its pid; the hook never does, so there the target stays unknown.
 * A token from one app's snapshot sent with another app's pid (or `scope: desktop`) leaves it to
 * cua-driver which window it acts on — that is not ours to guess, so the target is unknown (ask).
 */
function withSnapshotPid(request: CuaTargetRequest, args: Record<string, unknown>, elementPid: number | undefined): CuaTargetRequest {
    if (elementPid === undefined || !Number.isInteger(elementPid) || typeof args.element_token !== 'string') return request;
    if (request.kind === 'none' || request.kind === 'launch') return request;
    if (request.kind === 'pid' && request.pid === elementPid) return request;
    if (request.kind === 'unknown' && args.pid === undefined && args.target === undefined) return { kind: 'pid', pid: elementPid };
    return { kind: 'unknown' };
}

/**
 * The proxy knows an `element_token` names an app other than the target this call would otherwise
 * have (another pid, or desktop scope): a verdict reached without the snapshot does not hold.
 */
export function snapshotContradictsTarget(call: Pick<PreToolUseCall, 'toolName' | 'toolInput' | 'elementPid'>, tables: ToolPolicyTables = BUILTIN_TABLES): boolean {
    const args = isRecord(call.toolInput) ? call.toolInput : {};
    const request = requiredCuaTarget(call.toolName, args, tables);
    return request.kind !== 'unknown' && withSnapshotPid(request, args, call.elementPid).kind === 'unknown';
}

/** Shown in Claude's terminal prompt: what needs a person and why. */
function askMessage(verdict: PolicyVerdict, toolName: string): string {
    const target = verdict.target ? ` (${verdict.target.appName}${verdict.action ? `, ${verdict.action}` : ''})` : '';
    return `Saycode 도구 정책: ${toolName}${target} 호출은 사람의 확인이 필요하다 (${verdict.reasonCode}). 허용하면 이번 호출만 실행된다.`;
}

function evaluationErrorVerdict(toolName: string, tables: ToolPolicyTables): PolicyVerdict {
    return {
        decision: 'ask', reasonCode: 'evaluation_error', ruleId: 'builtin:evaluation_error', policyVersion: tables.policyVersion,
        humanOnly: false, grantOffer: 'once', grantKeys: [], denialKey: toolName,
        serverKind: toolName.startsWith(`mcp__${tables.cuaDriver.server}__`) ? 'cua-driver' : 'user', auditAllow: true,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
