import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { SandboxConfig } from '@/persistence';
import { buildSandboxRuntimeConfig } from '@/sandbox/config';
import type { QueryOptions } from '@/claude/sdk';
import { createCheckpointRuntime } from './checkpointRuntime';
import { readCheckpointSpawnContext } from './checkpointSpawnContext';
import { CheckpointPolicyDriftError, type CheckpointProvider } from './checkpointExclusionPolicy';
import type { CheckpointEventPublisher } from './checkpointEventPublisher';
import { CheckpointProtectionStateStore } from './checkpointProtectionState';
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
    /** Removes a reserved-but-unused provider workspace; an active turn is left untouched. */
    dispose?: () => Promise<void>;
    /** Discards a turn that was opened but never dispatched, then rotates to a fresh workspace. */
    abortTurn?: () => Promise<void>;
    claudeSandbox?: QueryOptions['sandbox'];
};

export async function createCheckpointSessionComposition(input: {
    provider: CheckpointProvider;
    platform: NodeJS.Platform;
    projectPath: string;
    sessionId: string;
    sandboxConfig: SandboxConfig | undefined;
    env: Record<string, string | undefined>;
    checkpointEvents?: Pick<CheckpointEventPublisher, 'snapshot'>;
}): Promise<CheckpointSessionComposition> {
    const inputSandboxConfig = input.sandboxConfig;
    const protection = inputSandboxConfig?.checkpointProtection;
    if (!protection) return { sandboxConfig: input.sandboxConfig };
    if (!inputSandboxConfig.enabled) {
        throw new Error('checkpoint protection requires an enabled sandbox');
    }
    const context = readCheckpointSpawnContext(input.env);
    if (!context) {
        throw new Error('checkpoint protection requires authoritative checkpoint spawn context');
    }
    await mkdir(context.checkpointRoot, { recursive: true, mode: 0o700 });
    const canonicalCheckpointRoot = await realpath(context.checkpointRoot);
    const canonicalProjectPath = await realpath(input.projectPath);
    const workspaceBinding = {
        sessionId: input.sessionId,
        projectId: context.projectId,
        worktreeId: context.worktreeId,
    };
    const protectionState = new CheckpointProtectionStateStore(canonicalCheckpointRoot);
    const persistedProtection = await protectionState.read({
        ...workspaceBinding,
        projectPath: canonicalProjectPath,
    });
    if (persistedProtection.protection.status === 'unavailable') {
        const { checkpointProtection: _checkpointProtection, ...unprotectedSandbox } = inputSandboxConfig;
        return { sandboxConfig: unprotectedSandbox };
    }
    const runtime = await createCheckpointRuntime({
        provider: input.provider,
        platform: input.platform,
        projectPath: input.projectPath,
        checkpointRoot: canonicalCheckpointRoot,
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
    const checkpointEvents = input.checkpointEvents;
    if (!checkpointEvents) {
        throw new Error('checkpoint protection requires a durable event publisher');
    }

    const turnWorkspace = new CheckpointTurnWorkspace(canonicalCheckpointRoot);
    // specs/linux-checkpoint-enforcement-backend R3/R8 — bubblewrap cannot enforce glob deny
    // entries (it only leaves ws/** mount-point residue) and refuses to start when a deny entry is
    // a symlink inside the writable workspace. The passthrough target is already read-only through
    // the root ro-bind, so dropping these two kinds on Linux removes no guarantee. The selection is
    // by *source* (pattern-derived entries, passthrough entries), never by inspecting literal paths:
    // a project path may legitimately contain '[' or '?'.
    const linux = input.platform === 'linux';
    const patternEntries = (root: string) => runtime.excludedPatterns.map((pattern) => join(root, pattern));
    const sandboxConfigFor = (path: string): SandboxConfig => ({
        ...inputSandboxConfig,
        sessionIsolation: 'custom',
        customWritePaths: [path],
        denyWritePaths: [...new Set([
            ...inputSandboxConfig.denyWritePaths,
            ...(linux
                ? runtime.denyWritePaths.filter((entry) => !patternEntries(canonicalProjectPath).includes(entry))
                : runtime.denyWritePaths),
            ...runtime.excludedPaths
                .filter((excludedPath) => !linux || !runtime.readOnlyPassthroughPaths.includes(excludedPath))
                .map((excludedPath) => join(path, excludedPath)),
            ...(linux ? [] : patternEntries(path)),
            canonicalProjectPath,
        ])],
    });
    const claudeSandboxFor = (config: SandboxConfig, path: string): QueryOptions['sandbox'] => {
        const sandboxRuntime = buildSandboxRuntimeConfig(config, path);
        return {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            enableWeakerNetworkIsolation: sandboxRuntime.enableWeakerNetworkIsolation,
            network: sandboxRuntime.network,
            filesystem: sandboxRuntime.filesystem,
        };
    };
    let nextOperationId = randomUUID();
    let providerPath = (await turnWorkspace.reserve({ ...workspaceBinding, operationId: nextOperationId })).path;
    const sandboxConfig = sandboxConfigFor(providerPath);
    const claudeSandbox: QueryOptions['sandbox'] | undefined = input.provider === 'claude-remote'
        ? claudeSandboxFor(sandboxConfig, providerPath)
        : undefined;
    const rotateProviderPath = async () => {
        nextOperationId = randomUUID();
        providerPath = (await turnWorkspace.reserve({ ...workspaceBinding, operationId: nextOperationId })).path;
        Object.assign(sandboxConfig, sandboxConfigFor(providerPath));
        if (claudeSandbox) Object.assign(claudeSandbox, claudeSandboxFor(sandboxConfig, providerPath));
    };
    let activeTurn: CheckpointTurnPreparation | null = null;
    let frozenWorkspacePath: string | null = null;
    let acceptsProtectedWriters = false;
    const protectedWriterTree = new CheckpointWriterProcessTree();
    const beforeTurn = async () => {
        if (activeTurn) {
            throw new Error('checkpoint protected turn is already active');
        }
        const operationId = nextOperationId;
        const currentProtection = await protectionState.read({
            ...workspaceBinding,
            projectPath: canonicalProjectPath,
        });
        if (currentProtection.protection.status !== 'protected') {
            throw new Error('checkpoint protection unavailable: excluded-path');
        }
        if (currentProtection.pendingDecision) {
            throw new Error('checkpoint excluded path decision is pending');
        }
        let snapshot;
        try {
            snapshot = await runtime.beforeTurn(operationId);
        } catch (error) {
            if (error instanceof CheckpointPolicyDriftError) {
                await protectionState.reportPending({
                    ...workspaceBinding,
                    projectPath: canonicalProjectPath,
                    operationId,
                    source: 'policy-drift',
                    excluded: error.excluded,
                });
            }
            throw error;
        }
        await checkpointEvents.snapshot({
            operationId,
            checkpointId: snapshot.checkpointId,
            excluded: runtime.excludedPaths.map((path) => ({
                path,
                reason: excludedReasonFor(runtime, path),
            })),
        });
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
        if (!frozenWorkspacePath) {
            frozenWorkspacePath = (await turnWorkspace.freeze({
                ...workspaceBinding,
                operationId: completedTurn.operationId,
            })).path;
        }
        const result = await new CheckpointTurnApplier(canonicalCheckpointRoot).execute({
            ...workspaceBinding,
            operationId: completedTurn.operationId,
            checkpointId: completedTurn.checkpointId,
            projectPath: canonicalProjectPath,
            workspacePath: frozenWorkspacePath,
            excludedPaths: runtime.excludedPaths,
            excludedPatterns: runtime.excludedPatterns,
            readOnlyPassthroughPaths: runtime.readOnlyPassthroughPaths,
        });
        const excluded = result.entries.flatMap((entry) => (
            entry.action === 'conflict' && runtime.excludedReason(entry.path)
                ? [{ path: entry.path, reason: excludedReasonFor(runtime, entry.path) }]
                : []
        ));
        if (excluded.length > 0) {
            await protectionState.reportPending({
                ...workspaceBinding,
                projectPath: canonicalProjectPath,
                operationId: completedTurn.operationId,
                source: 'turn-apply',
                excluded,
            });
        }
        if (result.status === 'completed') {
            await turnWorkspace.remove({
                ...workspaceBinding,
                operationId: completedTurn.operationId,
            });
            activeTurn = null;
            frozenWorkspacePath = null;
            await rotateProviderPath();
        }
        return result;
    };
    const trackProtectedWriter = (child: ChildProcess) => protectedWriterTree.track(child);
    // specs/linux-checkpoint-enforcement-backend R4 — the gate opens the turn before the provider
    // process exists, so a turn that is never dispatched (reconnect failure, refused turn, session
    // exit) has to be discarded: its snapshot stays in the store as history, but the materialized
    // workspace is removed and the writable path rotates so it is never reused.
    const abortTurn = async () => {
        if (!activeTurn) return;
        const abandoned = activeTurn;
        acceptsProtectedWriters = false;
        await protectedWriterTree.quiesce(() => {});
        activeTurn = null;
        frozenWorkspacePath = null;
        await turnWorkspace.remove({ ...workspaceBinding, operationId: abandoned.operationId });
        await rotateProviderPath();
    };
    // specs/linux-checkpoint-enforcement-backend R4 — reserve() leaves an empty directory for the next
    // turn; a session that ends without starting it must not leak that directory.
    const dispose = async () => {
        if (activeTurn) return;
        await turnWorkspace.remove({ ...workspaceBinding, operationId: nextOperationId });
    };
    if (input.provider !== 'claude-remote') {
        return {
            sandboxConfig,
            get providerPath() { return providerPath; },
            beforeTurn,
            completeTurn,
            protectedBashCwd,
            trackProtectedWriter,
            dispose,
            abortTurn,
        };
    }

    return {
        sandboxConfig,
        get providerPath() { return providerPath; },
        beforeTurn,
        completeTurn,
        protectedBashCwd,
        trackProtectedWriter,
        dispose,
        abortTurn,
        claudeSandbox,
    };
}

function excludedReasonFor(
    runtime: Extract<Awaited<ReturnType<typeof createCheckpointRuntime>>, { status: 'protected' }>,
    path: string,
): 'secret' | 'ignored' | 'too-large' | 'file-limit' | 'total-size-limit' {
    const reason = runtime.excludedReason(path);
    if (!reason) throw new Error('checkpoint excluded conflict is missing from the policy');
    return reason;
}
