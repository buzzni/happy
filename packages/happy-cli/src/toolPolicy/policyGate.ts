/**
 * One session's tool policy enforcement point (aplus-dev-studio specs/agent-tool-policy R3, R11, R13, R16).
 *
 * Adapters (the Claude PreToolUse hook today; the cua-driver proxy and the stdio bridge in I1b)
 * hand a pending call to `decide`. It resolves the target app, evaluates the call against the
 * current rules, and for `ask` raises an ordinary permission request through the session's
 * approver and waits — up to 30 minutes — for a person. Grants are created only from that answer.
 *
 * Failure direction: an evaluation error is `ask`; `ask` with nobody to ask is `blocked`.
 */

import {
    blockedMessage,
    evaluateToolCall,
    isPolicyExcludedTool,
    requiredCuaTarget,
    type PolicyTarget,
    type PolicyVerdict,
} from './evaluate';
import { BUILTIN_TABLES, type CuaAction, type MachinePolicy, type ToolPolicyTables } from './rules';
import type { PolicyGrantStore } from './grants';
import type { TargetResolver } from './targetResolver';
import type { ToolPolicyAuditLog, ToolPolicyOutcome } from './audit';

export const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

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
    approved: boolean;
    /** R11.3: absent from older clients, which means `once`. */
    policyGrant: 'once' | 'session';
    reason?: string;
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
}

export type HookVerdict =
    /** Let Claude's normal permission flow run, as it would without a policy. */
    | { kind: 'pass' }
    /** A person approved it here; skip Claude's own prompt. */
    | { kind: 'allow' }
    | { kind: 'deny'; reason: string; reasonCode: string };

export interface ToolPolicyGate {
    decide(call: PreToolUseCall, signal: AbortSignal): Promise<HookVerdict>;
}

export function createToolPolicyGate(deps: {
    loadMachinePolicy: () => MachinePolicy;
    resolver: TargetResolver;
    grants: PolicyGrantStore;
    audit: ToolPolicyAuditLog;
    approver: () => PolicyApprover | null;
    /** A run with nobody to answer (run-once automation): `ask` becomes `blocked`. */
    unattended: boolean;
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

    const refuse = (call: PreToolUseCall, verdict: PolicyVerdict, reasonCode: string, outcome: ToolPolicyOutcome): HookVerdict => {
        audit(call, verdict, outcome, 'blocked', reasonCode);
        return { kind: 'deny', reasonCode, reason: blockedMessage({ ...verdict, reasonCode }, call.toolName, tables) };
    };

    const evaluate = async (call: PreToolUseCall, args: Record<string, unknown>): Promise<PolicyVerdict> => {
        const request = requiredCuaTarget(call.toolName, args, tables);
        const target = request.kind === 'none' ? undefined : await deps.resolver.resolve(request);
        return evaluateToolCall({ toolName: call.toolName, args, platform, target }, deps.loadMachinePolicy(), deps.grants.view(), tables, now());
    };

    return {
        decide: async (call, signal) => {
            if (isPolicyExcludedTool(call.toolName, tables)) return { kind: 'pass' };
            const args = isRecord(call.toolInput) ? call.toolInput : {};
            let verdict: PolicyVerdict;
            try {
                verdict = await evaluate(call, args);
            } catch {
                verdict = evaluationErrorVerdict(call.toolName, tables);
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
            if (deps.unattended) return refuse(call, verdict, 'unattended_no_approver', 'unattended');
            const approver = deps.approver();
            if (!approver) return refuse(call, verdict, 'no_approver', 'unattended');

            const controller = new AbortController();
            const onAbort = () => controller.abort();
            signal.addEventListener('abort', onAbort, { once: true });
            let timedOut = false;
            const timer = setTimeout(() => { timedOut = true; controller.abort(); }, approvalTimeoutMs);
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
                    return refuse(call, verdict, 'user_denied', 'denied');
                }
                if (answer.policyGrant === 'session' && verdict.grantOffer === 'session') deps.grants.grant(verdict.grantKeys);
                audit(call, verdict, 'approved', 'ask');
                return { kind: 'allow' };
            } catch {
                return refuse(call, verdict, timedOut ? 'approval_timeout' : 'aborted', timedOut ? 'timeout' : 'aborted');
            } finally {
                clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
            }
        },
    };
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
