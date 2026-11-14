import { describe, expect, it, vi } from 'vitest';
import { createPolicyGrantStore } from './grants';
import type { PolicyApprover } from './policyGate';
import { createProtectedToolAccess } from './protectedToolAccess';

function fixture() {
    const grants = createPolicyGrantStore();
    const requestPolicyApproval = vi.fn<PolicyApprover['requestPolicyApproval']>(async () => ({ approved: true, hostToolConsentVersion: 1 as const, policyGrant: 'session' }));
    const access = createProtectedToolAccess({ grants, approver: () => ({ requestPolicyApproval }), unattended: () => false });
    const scope = { toolName: 'mcp__example__inspect', binding: 'server-config-digest', target: { profile: 'one' } };
    return { grants, requestPolicyApproval, access, scope };
}

describe('protected tool access', () => {
    it('asks a human before execution and reuses only the approved binding and target', async () => {
        const { access, scope, requestPolicyApproval } = fixture();
        const signal = new AbortController().signal;
        await access.authorize(scope, signal);
        await access.authorize(scope, signal);
        expect(requestPolicyApproval).toHaveBeenCalledTimes(1);
        expect(requestPolicyApproval.mock.calls[0][0].policy.humanOnly).toBe(true);
        await access.authorize({ ...scope, binding: 'changed-config' }, signal);
        await access.authorize({ ...scope, target: { profile: 'two' } }, signal);
        expect(requestPolicyApproval).toHaveBeenCalledTimes(3);
    });

    it('rejects a late approval after cancellation without creating a grant', async () => {
        const { access, scope, requestPolicyApproval, grants } = fixture();
        let answer!: (value: { approved: boolean; policyGrant: 'session'; hostToolConsentVersion?: 1 }) => void;
        requestPolicyApproval.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
        const controller = new AbortController();
        const pending = access.authorize(scope, controller.signal);
        controller.abort();
        answer({ approved: true, hostToolConsentVersion: 1 as const, policyGrant: 'session' });
        await expect(pending).rejects.toThrow('TOOL_ACCESS_CANCELLED');
        expect(grants.list()).toEqual([]);
    });

    it('does not execute or recreate a grant after revocation during approval', async () => {
        const { access, scope, requestPolicyApproval, grants } = fixture();
        let answer!: (value: { approved: boolean; policyGrant: 'session'; hostToolConsentVersion?: 1 }) => void;
        requestPolicyApproval.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
        const pending = access.authorize(scope, new AbortController().signal);
        grants.revoke('revoked-during-prompt');
        answer({ approved: true, hostToolConsentVersion: 1 as const, policyGrant: 'session' });
        await expect(pending).rejects.toThrow('TOOL_ACCESS_CHANGED');
        expect(grants.list()).toEqual([]);
    });

    it('keeps once approval scoped to one call', async () => {
        const { access, scope, requestPolicyApproval } = fixture();
        requestPolicyApproval.mockResolvedValue({ approved: true, hostToolConsentVersion: 1 as const, policyGrant: 'once' } as never);
        await access.authorize(scope, new AbortController().signal);
        await access.authorize(scope, new AbortController().signal);
        expect(requestPolicyApproval).toHaveBeenCalledTimes(2);
    });

    it('fails explicitly when there is nobody to approve', async () => {
        const grants = createPolicyGrantStore();
        const access = createProtectedToolAccess({ grants, approver: () => null, unattended: () => false });
        await expect(access.authorize(fixture().scope, new AbortController().signal)).rejects.toThrow('TOOL_ACCESS_APPROVER_REQUIRED');
    });
});


describe('protected tool access review regressions', () => {
    it('does not reuse consent when operation arguments change', async () => {
        const { access, scope, requestPolicyApproval } = fixture();
        const signal = new AbortController().signal;
        await access.authorize({ ...scope, args: { url: 'https://one.example' } }, signal);
        await access.authorize({ ...scope, args: { url: 'https://two.example' } }, signal);
        expect(requestPolicyApproval).toHaveBeenCalledTimes(2);
    });

    it('blocks dispatch after cancellation even with cached consent', async () => {
        const { access, scope } = fixture();
        const controller = new AbortController();
        await access.authorize(scope, controller.signal);
        const execute = vi.fn(async () => 'executed');
        const pending = access.run(scope, controller.signal, execute);
        controller.abort();
        await expect(pending).rejects.toThrow('TOOL_ACCESS_CANCELLED');
        expect(execute).not.toHaveBeenCalled();
    });

    it('ends pending approval on disposal even if an approver ignores abort', async () => {
        const { access, scope, requestPolicyApproval } = fixture();
        requestPolicyApproval.mockImplementation(() => new Promise(() => {}));
        const pending = access.authorize(scope, new AbortController().signal);
        access.dispose();
        await expect(pending).rejects.toThrow('TOOL_ACCESS_CANCELLED');
    });

    it('rechecks policy after the user answers and does not grant changed policy', async () => {
        const grants = createPolicyGrantStore();
        let revision = 'before';
        const access = createProtectedToolAccess({ grants, unattended: () => false, checkPolicy: () => revision,
            approver: () => ({ requestPolicyApproval: async () => {
                revision = 'after'; return { approved: true, hostToolConsentVersion: 1 as const, policyGrant: 'session' };
            } }),
        });
        await expect(access.authorize(fixture().scope, new AbortController().signal)).rejects.toThrow('TOOL_ACCESS_POLICY_CHANGED');
        expect(grants.list()).toEqual([]);
    });

    it('rejects invalid targets instead of hashing them as null', async () => {
        const { access, scope, requestPolicyApproval } = fixture();
        await expect(access.authorize({ ...scope, target: { tab: Number.NaN } }, new AbortController().signal)).rejects.toThrow('TOOL_ACCESS_INVALID_SCOPE');
        expect(requestPolicyApproval).not.toHaveBeenCalled();
    });
    it('refuses an expired cached grant at actual dispatch', async () => {
        let now = 0;
        const grants = createPolicyGrantStore({ now: () => now, grantTtlMs: 10 });
        const access = createProtectedToolAccess({ grants, unattended: () => false,
            approver: () => ({ requestPolicyApproval: async () => ({ approved: true, hostToolConsentVersion: 1 as const, policyGrant: 'session' }) }) });
        const scope = fixture().scope;
        await access.authorize(scope, new AbortController().signal);
        await expect(access.run(scope, new AbortController().signal, async (_scope, assertCurrent) => {
            now = 11; assertCurrent(); return 'executed';
        })).rejects.toThrow('TOOL_ACCESS_CHANGED');
    });

    it('refuses an old client that did not confirm the host-access warning', async () => {
        const { access, scope, requestPolicyApproval, grants } = fixture();
        requestPolicyApproval.mockResolvedValue({ approved: true, policyGrant: 'session' });
        await expect(access.authorize(scope, new AbortController().signal)).rejects.toThrow('TOOL_ACCESS_CLIENT_UPDATE_REQUIRED');
        expect(grants.list()).toEqual([]);
    });

});
