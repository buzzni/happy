import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { SandboxConfig } from '@/persistence';
import { buildSandboxRuntimeConfig } from '@/sandbox/config';
import type { QueryOptions } from '@/claude/sdk';
import { createCheckpointRuntime } from './checkpointRuntime';
import { readCheckpointSpawnContext } from './checkpointSpawnContext';
import type { CheckpointProvider } from './checkpointExclusionPolicy';
import { CheckpointTurnWorkspace } from './checkpointTurnWorkspace';
import { CheckpointTurnApplier, type CheckpointTurnApplyResult } from './checkpointTurnApply';
import { CheckpointWriterProcessTree } from './checkpointWriterProcessTree';

export type CheckpointTurnPreparation = {
    operationId: string;
    checkpointId: string;
    providerPath: string;
    sandboxConfig?: SandboxConfig;
    claudeSandbox?: QueryOptions['sandbox'];
};

export type CheckpointSessionComposition = {
    sandboxConfig: SandboxConfig | undefined;
    providerPath?: string;
    beforeTurn?: () => Promise<CheckpointTurnPreparation>;
    completeTurn?: (quiesceWriters: () => Promise<void>) => Promise<CheckpointTurnApplyResult>;
    protectedBashCwd?: () => string | null;
    trackProtectedWriter?: (child: ChildProcess) => void;
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

    const turnWorkspace = new CheckpointTurnWorkspace(context.checkpointRoot);
    const canonicalProjectPath = await realpath(input.projectPath);
    const workspaceBinding = {
        sessionId: input.sessionId,
        projectId: context.projectId,
        worktreeId: context.worktreeId,
    };
    const providerPath = turnWorkspace.pathFor({ ...workspaceBinding, operationId: 'path-slot' });
    const workspaceDenyWritePaths = [
        ...runtime.excludedPaths.map((path) => join(providerPath, path)),
        ...runtime.excludedPatterns.map((pattern) => join(providerPath, pattern)),
    ];
    const sandboxConfig: SandboxConfig = {
        ...input.sandboxConfig,
        sessionIsolation: 'custom',
        customWritePaths: [providerPath],
        denyWritePaths: [...new Set([
            ...input.sandboxConfig.denyWritePaths,
            ...runtime.denyWritePaths,
            ...workspaceDenyWritePaths,
            canonicalProjectPath,
        ])],
    };
    const sandboxRuntime = buildSandboxRuntimeConfig(sandboxConfig, providerPath);
    const claudeSandbox: QueryOptions['sandbox'] | undefined = input.provider === 'claude-remote'
        ? {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            enableWeakerNetworkIsolation: sandboxRuntime.enableWeakerNetworkIsolation,
            network: sandboxRuntime.network,
            filesystem: sandboxRuntime.filesystem,
        }
        : undefined;
    let activeTurn: CheckpointTurnPreparation | null = null;
    let acceptsProtectedWriters = false;
    const protectedWriterTree = new CheckpointWriterProcessTree();
    const beforeTurn = async () => {
        if (activeTurn) {
            throw new Error('checkpoint protected turn is already active');
        }
        const operationId = randomUUID();
        const snapshot = await runtime.beforeTurn(operationId);
        const workspace = await turnWorkspace.prepare({
            ...workspaceBinding,
            operationId,
            checkpointId: snapshot.checkpointId,
            projectPath: canonicalProjectPath,
            readOnlyPassthroughPaths: runtime.readOnlyPassthroughPaths,
        });
        activeTurn = {
            operationId,
            checkpointId: snapshot.checkpointId,
            providerPath: workspace.path,
            sandboxConfig,
            claudeSandbox,
        };
        acceptsProtectedWriters = true;
        return activeTurn;
    };
    const protectedBashCwd = () => acceptsProtectedWriters ? activeTurn?.providerPath ?? null : null;
    const completeTurn = async (quiesceWriters: () => Promise<void>) => {
        if (!activeTurn) {
            throw new Error('checkpoint protected turn is not active');
        }
        acceptsProtectedWriters = false;
        await quiesceWriters();
        await protectedWriterTree.quiesce(() => {});
        const completedTurn = activeTurn;
        const result = await new CheckpointTurnApplier(context.checkpointRoot).execute({
            ...workspaceBinding,
            operationId: completedTurn.operationId,
            checkpointId: completedTurn.checkpointId,
            projectPath: canonicalProjectPath,
            workspacePath: completedTurn.providerPath,
            excludedPaths: runtime.excludedPaths,
            excludedPatterns: runtime.excludedPatterns,
            readOnlyPassthroughPaths: runtime.readOnlyPassthroughPaths,
        });
        if (result.status === 'completed') {
            await turnWorkspace.remove({
                ...workspaceBinding,
                operationId: completedTurn.operationId,
            });
            activeTurn = null;
        }
        return result;
    };
    const trackProtectedWriter = (child: ChildProcess) => protectedWriterTree.track(child);
    if (input.provider !== 'claude-remote') {
        return {
            sandboxConfig,
            providerPath,
            beforeTurn,
            completeTurn,
            protectedBashCwd,
            trackProtectedWriter,
        };
    }

    return {
        sandboxConfig,
        providerPath,
        beforeTurn,
        completeTurn,
        protectedBashCwd,
        trackProtectedWriter,
        claudeSandbox,
    };
}
