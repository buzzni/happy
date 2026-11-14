import { describe, expect, it, vi } from 'vitest';
import { createHostedTools } from './hostToolExecutor';
import { createProtectedToolAccess } from './protectedToolAccess';
import { createPolicyGrantStore } from './grants';
import type { PolicyApprover } from './policyGate';

function fixture(approved = true) {
    const approve = vi.fn<PolicyApprover['requestPolicyApproval']>(async () => ({ approved, hostToolConsentVersion: 1 as const, policyGrant: 'once' }));
    const access = createProtectedToolAccess({ grants: createPolicyGrantStore(), approver: () => ({ requestPolicyApproval: approve }), unattended: () => false });
    const executeMcp = vi.fn(async (_source: unknown, _operation: unknown, _signal: AbortSignal) => ({ tools: [{ name: 'inspect' }] }));
    const executeCommand = vi.fn(async () => ({ exitCode: 0, stdout: 'ok' }));
    const servers = { example: { command: process.execPath, args: ['-e', 'console.log("MCP")'] } };
    const host = createHostedTools({ access: () => access, servers: async () => servers, cwd: process.cwd(), executeMcp, executeCommand });
    return { host, approve, executeMcp, executeCommand, servers };
}

describe('host tool access boundary', () => {
    it('lists configured tools without starting their processes or asking for credentials', async () => {
        const { host, approve, executeMcp } = fixture();
        const result = await host.invoke({ action: 'list' }, new AbortController().signal);
        expect(JSON.stringify(result)).toContain('example');
        expect(JSON.stringify(result)).not.toContain('console.log');
        expect(approve).not.toHaveBeenCalled();
        expect(executeMcp).not.toHaveBeenCalled();
    });
    it('denial prevents even MCP discovery from launching a server', async () => {
        const { host, executeMcp } = fixture(false);
        await expect(host.invoke({ action: 'inspect', source: 'example' }, new AbortController().signal)).rejects.toThrow('TOOL_ACCESS_DENIED');
        expect(executeMcp).not.toHaveBeenCalled();
    });
    it('approves the exact command before shell-free execution', async () => {
        const { host, approve, executeCommand } = fixture();
        await host.invoke({ action: 'command', command: process.execPath, args: ['-e', 'console.log("ok")'] }, new AbortController().signal);
        expect(approve.mock.calls[0][0].args).toMatchObject({ toolAccessVersion: 1, boundary: 'host' });
        expect(executeCommand).toHaveBeenCalledTimes(1);
    });
    it('does not execute when server configuration changes while the person reviews it', async () => {
        const { host, approve, executeMcp, servers } = fixture();
        approve.mockImplementation(async () => {
            servers.example.args = ['-e', 'changed'];
            return { approved: true, hostToolConsentVersion: 1 as const, policyGrant: 'once' };
        });
        await expect(host.invoke({ action: 'inspect', source: 'example' }, new AbortController().signal)).rejects.toThrow('TOOL_ACCESS_CHANGED');
        expect(executeMcp).not.toHaveBeenCalled();
    });
    it('does not fall back to a disabled server or accept arbitrary connection fields', async () => {
        const { host, executeMcp } = fixture();
        await expect(host.invoke({ action: 'call', source: 'missing', tool: 'inspect', parameters: {} }, new AbortController().signal)).rejects.toThrow('HOST_TOOL_NOT_CONFIGURED');
        expect(executeMcp).not.toHaveBeenCalled();
    });
    it('preserves configured per-tool exclusions even when a person could approve', async () => {
        const { approve, executeMcp } = fixture();
        const access = createProtectedToolAccess({ grants: createPolicyGrantStore(), approver: () => ({ requestPolicyApproval: approve }), unattended: () => false });
        const host = createHostedTools({ access: () => access, cwd: process.cwd(), executeMcp,
            servers: async () => ({ example: { command: process.execPath, disabled_tools: ['delete'] } }) });
        await expect(host.invoke({ action: 'call', source: 'example', tool: 'delete', parameters: {} }, new AbortController().signal)).rejects.toThrow('HOST_TOOL_DISABLED');
        expect(approve).not.toHaveBeenCalled();
        expect(executeMcp).not.toHaveBeenCalled();
    });
    it('executes the approved argument snapshot when the caller mutates a nested value', async () => {
        const { host, approve, executeMcp } = fixture();
        const parameters = { nested: { path: 'approved' } };
        approve.mockImplementation(async () => { parameters.nested.path = 'changed'; return { approved: true, hostToolConsentVersion: 1 as const, policyGrant: 'once' }; });
        await host.invoke({ action: 'call', source: 'example', tool: 'read', parameters }, new AbortController().signal);
        expect(executeMcp.mock.calls[0]?.[1]).toMatchObject({ parameters: { nested: { path: 'approved' } } });
    });

});
