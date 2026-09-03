import type { SandboxConfig } from '@/persistence';

export type CheckpointRestartBinding = {
    sessionId: string;
    projectId: string;
    worktreeId: string | null;
    projectPath: string;
};

type CheckpointRestartTarget = CheckpointRestartBinding & {
    pid: number;
    active: boolean;
    knownStopped: boolean;
    sandboxConfig: SandboxConfig;
    terminate(): Promise<void>;
};

type CheckpointRestartDependencies = {
    resolveTarget(sessionId: string): Promise<CheckpointRestartTarget | null>;
    isProcessAlive(pid: number): boolean;
    resume(
        sessionId: string,
        environmentVariables: Record<string, string>,
    ): Promise<{ type: string; sessionId?: string; errorMessage?: string }>;
};

export async function restartCheckpointProtectedSession(
    binding: CheckpointRestartBinding,
    dependencies: CheckpointRestartDependencies,
): Promise<{ sessionId: string }> {
    const target = await dependencies.resolveTarget(binding.sessionId);
    if (!target) throw new Error('checkpoint protected restart target is unavailable');
    if (
        target.sessionId !== binding.sessionId
        || target.projectId !== binding.projectId
        || target.worktreeId !== binding.worktreeId
        || target.projectPath !== binding.projectPath
    ) {
        throw new Error('checkpoint protected restart binding mismatch');
    }
    if (!target.sandboxConfig.checkpointProtection) {
        throw new Error('checkpoint protected restart target is not protected');
    }
    if (!target.active && !target.knownStopped) {
        throw new Error('checkpoint protected restart cannot prove the previous provider stopped');
    }
    const { checkpointProtection: _checkpointProtection, ...sandboxConfig } = target.sandboxConfig;
    if (target.active && target.pid > 0 && dependencies.isProcessAlive(target.pid)) {
        await target.terminate();
        if (dependencies.isProcessAlive(target.pid)) {
            throw new Error('checkpoint protected restart target did not stop');
        }
    }
    const result = await dependencies.resume(binding.sessionId, {
        HAPPY_PROJECT_SANDBOX_CONFIG: JSON.stringify(sandboxConfig),
    });
    if (result.type !== 'success' || result.sessionId !== binding.sessionId) {
        throw new Error(result.errorMessage ?? 'checkpoint protected restart failed');
    }
    return { sessionId: result.sessionId };
}
