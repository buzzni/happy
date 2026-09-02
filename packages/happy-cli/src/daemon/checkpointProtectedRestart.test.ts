import { describe, expect, it, vi } from 'vitest';
import { SandboxConfigSchema } from '@/persistence';
import { restartCheckpointProtectedSession } from './checkpointProtectedRestart';

describe('restartCheckpointProtectedSession', () => {
    const binding = {
        sessionId: 'session-1',
        projectId: 'project-1',
        worktreeId: null,
        projectPath: '/workspace/project',
    } as const;
    const sandboxConfig = SandboxConfigSchema.parse({
        checkpointProtection: {
            secretPatterns: ['.env*'],
            maxFileBytes: 1024,
            maxFiles: 100,
            maxTotalBytes: 4096,
        },
        denyWritePaths: ['existing-deny'],
    });

    it('terminates the exact protected child before resuming without checkpoint protection', async () => {
        const order: string[] = [];
        let alive = true;
        const terminate = vi.fn(async () => {
            order.push('terminate');
            alive = false;
        });
        const resume = vi.fn(async () => {
            order.push('resume');
            return { type: 'success' as const, sessionId: binding.sessionId };
        });

        await expect(restartCheckpointProtectedSession(binding, {
            resolveTarget: async () => ({
                ...binding,
                pid: 123,
                active: true,
                knownStopped: false,
                sandboxConfig,
                terminate,
            }),
            isProcessAlive: () => alive,
            resume,
        })).resolves.toEqual({ sessionId: binding.sessionId });

        expect(order).toEqual(['terminate', 'resume']);
        expect(resume).toHaveBeenCalledWith(binding.sessionId, {
            HAPPY_PROJECT_SANDBOX_CONFIG: JSON.stringify({
                ...sandboxConfig,
                checkpointProtection: undefined,
            }),
        });
    });

    it('rejects a changed binding before terminating the child', async () => {
        const terminate = vi.fn(async () => {});

        await expect(restartCheckpointProtectedSession(binding, {
            resolveTarget: async () => ({
                ...binding,
                projectId: 'other-project',
                pid: 123,
                active: true,
                knownStopped: false,
                sandboxConfig,
                terminate,
            }),
            isProcessAlive: () => true,
            resume: vi.fn(),
        })).rejects.toThrow('binding mismatch');

        expect(terminate).not.toHaveBeenCalled();
    });

    it('retries replacement spawn when the previous protected child is already stopped', async () => {
        const terminate = vi.fn(async () => {});
        const isProcessAlive = vi.fn(() => true);
        const resume = vi.fn(async () => ({
            type: 'success' as const,
            sessionId: binding.sessionId,
        }));

        await expect(restartCheckpointProtectedSession(binding, {
            resolveTarget: async () => ({
                ...binding,
                pid: 0,
                active: false,
                knownStopped: true,
                sandboxConfig,
                terminate,
            }),
            isProcessAlive,
            resume,
        })).resolves.toEqual({ sessionId: binding.sessionId });

        expect(terminate).not.toHaveBeenCalled();
        expect(isProcessAlive).not.toHaveBeenCalled();
        expect(resume).toHaveBeenCalledOnce();
    });

    it('refuses a persisted target when the daemon cannot prove the old provider stopped', async () => {
        const resume = vi.fn();

        await expect(restartCheckpointProtectedSession(binding, {
            resolveTarget: async () => ({
                ...binding,
                pid: 0,
                active: false,
                knownStopped: false,
                sandboxConfig,
                terminate: vi.fn(),
            }),
            isProcessAlive: vi.fn(),
            resume,
        })).rejects.toThrow('cannot prove the previous provider stopped');

        expect(resume).not.toHaveBeenCalled();
    });
});
