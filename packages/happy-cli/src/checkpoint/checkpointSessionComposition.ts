import { randomUUID } from 'node:crypto';
import type { SandboxConfig } from '@/persistence';
import { buildSandboxRuntimeConfig } from '@/sandbox/config';
import type { QueryOptions } from '@/claude/sdk';
import { createCheckpointRuntime } from './checkpointRuntime';
import { readCheckpointSpawnContext } from './checkpointSpawnContext';
import type { CheckpointProvider } from './checkpointExclusionPolicy';

export type CheckpointSessionComposition = {
    sandboxConfig: SandboxConfig | undefined;
    beforeTurn?: () => Promise<void>;
    claudeSandbox?: QueryOptions['sandbox'];
};

export async function createCheckpointSessionComposition(input: {
    provider: CheckpointProvider;
    platform: NodeJS.Platform;
    projectPath: string;
    sessionId: string;
    sandboxConfig: SandboxConfig | undefined;
    env: Record<string, string | undefined>;
}): Promise<CheckpointSessionComposition> {
    const protection = input.sandboxConfig?.checkpointProtection;
    if (!protection) return { sandboxConfig: input.sandboxConfig };
    if (!input.sandboxConfig?.enabled) {
        throw new Error('checkpoint protection requires an enabled sandbox');
    }

    const context = readCheckpointSpawnContext(input.env);
    if (!context) {
        throw new Error('checkpoint protection requires authoritative checkpoint spawn context');
    }
    const runtime = await createCheckpointRuntime({
        provider: input.provider,
        platform: input.platform,
        projectPath: input.projectPath,
        checkpointRoot: context.checkpointRoot,
        binding: {
            sessionId: input.sessionId,
            projectId: context.projectId,
            worktreeId: context.worktreeId,
        },
        protection,
    });
    if (runtime.status !== 'protected') {
        const reason = runtime.status === 'unavailable' ? runtime.reason : 'disabled';
        throw new Error(`checkpoint protection unavailable: ${reason}`);
    }

    const sandboxConfig: SandboxConfig = {
        ...input.sandboxConfig,
        denyWritePaths: [...new Set([
            ...input.sandboxConfig.denyWritePaths,
            ...runtime.denyWritePaths,
        ])],
    };
    const beforeTurn = async () => {
        await runtime.beforeTurn(randomUUID());
    };
    if (input.provider !== 'claude-remote') {
        return { sandboxConfig, beforeTurn };
    }

    const sandboxRuntime = buildSandboxRuntimeConfig(sandboxConfig, input.projectPath);
    return {
        sandboxConfig,
        beforeTurn,
        claudeSandbox: {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            enableWeakerNetworkIsolation: sandboxRuntime.enableWeakerNetworkIsolation,
            network: sandboxRuntime.network,
            filesystem: sandboxRuntime.filesystem,
        },
    };
}
