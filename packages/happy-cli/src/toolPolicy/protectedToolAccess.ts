import { createHash, randomUUID } from 'node:crypto';
import type { PolicyGrantStore } from './grants';
import { APPROVAL_TIMEOUT_MS, type PolicyApprover } from './policyGate';

/** Host-owned identity and displayed scope, never a model-supplied claim of authority. */
export interface ProtectedToolScope {
    toolName: string;
    binding: string;
    target: Record<string, string | number | boolean | null>;
    args?: Record<string, unknown>;
}

/** Shared access approval for host adapters; adapters still enforce their operation/policy bounds. */
export function createProtectedToolAccess(deps: {
    grants: PolicyGrantStore;
    approver(): PolicyApprover | null;
    unattended(): boolean;
    timeoutMs?: number;
    /** Enforce current machine/organization policy; the returned revision binds reusable consent. */
    checkPolicy?(scope: ProtectedToolScope): string;
}) {
    let disposed = false;
    const pending = new Set<AbortController>();
    const lifetime = new AbortController();
    const authorize = async (scope: ProtectedToolScope, signal: AbortSignal): Promise<string | null> => {
        if (disposed || signal.aborted) throw new Error('TOOL_ACCESS_CANCELLED');
        scope = snapshotScope(scope);
        const policyRevision = deps.checkPolicy?.(scope) ?? "default";
        const target = Object.fromEntries(Object.entries(scope.target).sort(([a], [b]) => a.localeCompare(b)));
        const digest = createHash('sha256').update(JSON.stringify([scope.toolName, scope.binding, target, scope.args ?? {}, policyRevision])).digest('hex');
        const key = `protected-tool:${scope.toolName}:${digest}`;
        if (deps.grants.view().hasGrant(key)) return key;
        if (deps.grants.view().recentlyDenied(key)) throw new Error('TOOL_ACCESS_DENIED');
        const approver = deps.approver();
        if (deps.unattended() || !approver) throw new Error('TOOL_ACCESS_APPROVER_REQUIRED');
        const revision = deps.grants.revision();
        const controller = new AbortController();
        pending.add(controller);
        const abort = () => controller.abort();
        signal.addEventListener('abort', abort, { once: true });
        let timeout = false;
        const timer = setTimeout(() => { timeout = true; controller.abort(); }, deps.timeoutMs ?? APPROVAL_TIMEOUT_MS);
        let rejectAbort!: () => void;
        const cancelled = new Promise<never>((_, reject) => {
            rejectAbort = () => reject(new Error(timeout ? 'TOOL_ACCESS_APPROVAL_TIMEOUT' : 'TOOL_ACCESS_CANCELLED'));
            controller.signal.addEventListener('abort', rejectAbort, { once: true });
        });
        try {
            const answer = await Promise.race([approver.requestPolicyApproval({
                id: `protected-tool-${randomUUID()}`, toolName: scope.toolName,
                args: { toolAccessVersion: 1, boundary: 'host', target, operation: scope.args ?? {} },
                policy: { reasonCode: 'protected_tool_access', ruleId: 'builtin:protected_tool_access', humanOnly: true, grantOffer: 'session' },
                signal: controller.signal,
            }), cancelled]);
            if (disposed || signal.aborted || controller.signal.aborted) throw new Error('TOOL_ACCESS_CANCELLED');
            if ((deps.checkPolicy?.(scope) ?? 'default') !== policyRevision) throw new Error('TOOL_ACCESS_POLICY_CHANGED');
            if (deps.grants.revision() !== revision) throw new Error('TOOL_ACCESS_CHANGED');
            if (!answer.approved) { deps.grants.recordDenial(key); throw new Error('TOOL_ACCESS_DENIED'); }
            if (answer.hostToolConsentVersion !== 1) throw new Error('TOOL_ACCESS_CLIENT_UPDATE_REQUIRED');
            if (answer.policyGrant === 'session') { deps.grants.grant([key], revision); return key; }
            return null;
        } finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            controller.signal.removeEventListener('abort', rejectAbort);
            pending.delete(controller);
        }
    };
    return {
        authorize,
        async run<T>(scope: ProtectedToolScope, signal: AbortSignal, work: (approvedScope: ProtectedToolScope, assertCurrent: () => void, signal: AbortSignal) => Promise<T>): Promise<T> {
            scope = snapshotScope(scope);
            const revision = deps.grants.revision();
            const policyRevision = deps.checkPolicy?.(scope) ?? 'default';
            signal = AbortSignal.any([signal, lifetime.signal]);
            const grantKey = await authorize(scope, signal);
            const assertCurrent = () => {
            if (disposed || signal.aborted) throw new Error('TOOL_ACCESS_CANCELLED');
            if ((grantKey !== null && !deps.grants.view().hasGrant(grantKey)) || deps.grants.revision() !== revision || (deps.checkPolicy?.(scope) ?? 'default') !== policyRevision) throw new Error('TOOL_ACCESS_CHANGED');
            };
            assertCurrent();
            return work(scope, assertCurrent, signal);
        },
        dispose() { disposed = true; lifetime.abort(); for (const controller of pending) controller.abort(); pending.clear(); },
    };
}

function snapshotScope(scope: ProtectedToolScope): ProtectedToolScope {
    if (!scope.toolName || !scope.binding || !scope.target || Object.keys(scope.target).length > 32
        || Object.values(scope.target).some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value))) throw new Error('TOOL_ACCESS_INVALID_SCOPE');
    const encoded = JSON.stringify(scope, (_key, value) => {
        if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint'
        || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('TOOL_ACCESS_INVALID_SCOPE');
        return value;
    });
    if (encoded.length > 16000) throw new Error('TOOL_ACCESS_INVALID_SCOPE');
    return JSON.parse(encoded) as ProtectedToolScope;
}
