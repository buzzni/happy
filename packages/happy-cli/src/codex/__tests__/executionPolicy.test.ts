import { describe, expect, it } from 'vitest';
import { resolveCodexExecutionPolicy, resolveCodexSandboxPolicy } from '../executionPolicy';

describe('resolveCodexExecutionPolicy', () => {
    it('forces never + danger-full-access when sandbox is managed by Happy', () => {
        const policy = resolveCodexExecutionPolicy('default', true);

        expect(policy).toEqual({
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });
    });

    it('maps codex default mode to untrusted + workspace-write without managed sandbox', () => {
        const policy = resolveCodexExecutionPolicy('default', false);

        expect(policy).toEqual({
            approvalPolicy: 'untrusted',
            sandbox: 'workspace-write',
        });
    });

    it('maps read-only mode to never + read-only without managed sandbox', () => {
        const policy = resolveCodexExecutionPolicy('read-only', false);

        expect(policy).toEqual({
            approvalPolicy: 'never',
            sandbox: 'read-only',
        });
    });

    it('maps safe-yolo mode to on-failure + workspace-write without managed sandbox', () => {
        const policy = resolveCodexExecutionPolicy('safe-yolo', false);

        expect(policy).toEqual({
            approvalPolicy: 'on-failure',
            sandbox: 'workspace-write',
        });
    });

    it('maps yolo mode to never + danger-full-access without managed sandbox', () => {
        const policy = resolveCodexExecutionPolicy('yolo', false);

        expect(policy).toEqual({
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });
    });

    it('maps bypassPermissions mode to never + danger-full-access without managed sandbox', () => {
        const policy = resolveCodexExecutionPolicy('bypassPermissions', false);

        expect(policy).toEqual({
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });
    });
});

describe('resolveCodexSandboxPolicy', () => {
    it('adds every canonical root to workspace-write turns', () => {
        expect(resolveCodexSandboxPolicy('workspace-write', ['/repo/frontend', '/repo/backend'])).toEqual({
            type: 'workspaceWrite',
            writableRoots: ['/repo/frontend', '/repo/backend'],
            networkAccess: true,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
        });
    });

    it('does not pretend roots are enforced by read-only or full-access modes', () => {
        expect(resolveCodexSandboxPolicy('read-only', ['/repo/frontend'])).toEqual({ type: 'readOnly' });
        expect(resolveCodexSandboxPolicy('danger-full-access', ['/repo/frontend'])).toEqual({ type: 'dangerFullAccess' });
    });
});
