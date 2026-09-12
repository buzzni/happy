import { describe, it, expect } from 'vitest';
import { resolveAllowedRoot, resolveDaemonAllowedRoot } from './resolveAllowedRoot';

describe('resolveAllowedRoot', () => {
    const homeDir = '/Users/namsangboy';

    it('uses an absolute registryWorkspaceRoot verbatim', () => {
        expect(resolveAllowedRoot({
            registryWorkspaceRoot: '/opt/work',
            homeDir,
        })).toBe('/opt/work');
    });

    it('joins a relative registryWorkspaceRoot under homeDir', () => {
        expect(resolveAllowedRoot({
            registryWorkspaceRoot: 'workspace/aplus-dev-studio-workspace',
            homeDir,
        })).toBe('/Users/namsangboy/workspace/aplus-dev-studio-workspace');
    });

    it('falls back to homeDir when registryWorkspaceRoot is null', () => {
        expect(resolveAllowedRoot({
            registryWorkspaceRoot: null,
            homeDir,
        })).toBe('/Users/namsangboy');
    });

    it('falls back to homeDir when registryWorkspaceRoot is undefined', () => {
        expect(resolveAllowedRoot({
            registryWorkspaceRoot: undefined,
            homeDir,
        })).toBe('/Users/namsangboy');
    });

    it('falls back to homeDir when registryWorkspaceRoot is empty string', () => {
        expect(resolveAllowedRoot({
            registryWorkspaceRoot: '',
            homeDir,
        })).toBe('/Users/namsangboy');
    });

    it('strips a trailing slash from registryWorkspaceRoot', () => {
        expect(resolveAllowedRoot({
            registryWorkspaceRoot: '/opt/work/',
            homeDir,
        })).toBe('/opt/work');
    });

    it('confines to <home>/workspace instead of the home directory under the workspace lockdown mode', () => {
        expect(resolveAllowedRoot({ registryWorkspaceRoot: null, homeDir, mode: 'workspace' }))
            .toBe('/Users/namsangboy/workspace');
        expect(resolveAllowedRoot({ registryWorkspaceRoot: '/opt/work', homeDir, mode: 'workspace' }))
            .toBe('/opt/work');
    });

    it('applies HAPPY_RPC_ALLOWED_ROOT from the daemon environment', () => {
        expect(resolveDaemonAllowedRoot({}, homeDir)).toBe('/Users/namsangboy');
        expect(resolveDaemonAllowedRoot({ HAPPY_RPC_ALLOWED_ROOT: 'workspace' }, homeDir))
            .toBe('/Users/namsangboy/workspace');
        expect(resolveDaemonAllowedRoot({ HAPPY_WORKSPACE_ROOT: '/srv/ws', HAPPY_RPC_ALLOWED_ROOT: 'workspace' }, homeDir))
            .toBe('/srv/ws');
    });
});
