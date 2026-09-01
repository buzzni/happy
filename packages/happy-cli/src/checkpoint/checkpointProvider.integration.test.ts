import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeRemote } from '@/claude/claudeRemote';
import type { EnhancedMode } from '@/claude/loop';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import { SandboxConfigSchema } from '@/persistence';
import { CHECKPOINT_SPAWN_CONTEXT_ENV_KEY } from './checkpointSpawnContext';
import { createCheckpointSessionComposition } from './checkpointSessionComposition';

const providerSmokeEnabled = process.env.HAPPY_RUN_CHECKPOINT_PROVIDER_SMOKE === '1';

describe.skipIf(process.platform !== 'darwin' || !providerSmokeEnabled)(
    'checkpoint protected provider smoke',
    { timeout: 180_000 },
    () => {
        let projectPath: string;
        let checkpointRoot: string;
        let client: CodexAppServerClient | null;

        beforeEach(async () => {
            projectPath = await mkdtemp('/var/tmp/happy-checkpoint-provider-project-');
            checkpointRoot = await mkdtemp('/var/tmp/happy-checkpoint-provider-store-');
            client = null;
            await writeFile(join(projectPath, 'README.md'), '# Provider smoke\n');
        });

        afterEach(async () => {
            await client?.disconnect();
            await rm(projectPath, { recursive: true, force: true });
            await rm(checkpointRoot, { recursive: true, force: true });
        });

        it('applies a real Codex file edit only through the protected turn boundary', async () => {
            const events: Array<{
                type: string;
                message?: string;
                command?: unknown;
                cwd?: unknown;
                output?: unknown;
            }> = [];
            const composition = await createCheckpointSessionComposition({
                provider: 'codex',
                platform: 'darwin',
                projectPath,
                sessionId: 'provider-smoke-codex',
                sandboxConfig: SandboxConfigSchema.parse({
                    checkpointProtection: {
                        secretPatterns: ['.env*'],
                        maxFileBytes: 1024 * 1024,
                        maxFiles: 100,
                        maxTotalBytes: 16 * 1024 * 1024,
                    },
                    extraWritePaths: [],
                    denyReadPaths: [],
                    networkMode: 'allowed',
                    allowLocalBinding: false,
                }),
                env: {
                    [CHECKPOINT_SPAWN_CONTEXT_ENV_KEY]: JSON.stringify({
                        schemaVersion: 1,
                        projectId: 'provider-smoke-project',
                        worktreeId: null,
                        checkpointRoot,
                    }),
                },
            });
            client = new CodexAppServerClient(
                composition.sandboxConfig,
                composition.beforeTurn,
                composition.completeTurn,
            );
            client.setEventHandler((event) => {
                events.push({
                    type: event.type,
                    ...('message' in event && typeof event.message === 'string'
                        ? { message: event.message }
                        : {}),
                    ...('command' in event ? { command: event.command } : {}),
                    ...('cwd' in event ? { cwd: event.cwd } : {}),
                    ...('output' in event ? { output: event.output } : {}),
                });
            });
            await client.connect();
            await client.startThread({
                cwd: projectPath,
                approvalPolicy: 'never',
                sandbox: 'danger-full-access',
            });

            const result = await client.sendTurnAndWait(
                "Run this shell command in the current workspace exactly once: printf 'protected codex\\n' > provider-smoke.txt\n"
                    + 'Do not modify any other file. Finish immediately after the command succeeds.',
                { approvalPolicy: 'never', sandbox: 'danger-full-access' },
            );

            expect(result.aborted).toBe(false);
            try {
                expect(await readFile(join(projectPath, 'provider-smoke.txt'), 'utf8'))
                    .toBe('protected codex\n');
            } catch (error) {
                throw new Error(`Codex provider smoke did not apply the file: ${JSON.stringify(events)}`, {
                    cause: error,
                });
            }
        });

        it('applies a real Claude file edit only through the protected turn boundary', async () => {
            const hookSettingsPath = join(checkpointRoot, 'claude-settings.json');
            await writeFile(hookSettingsPath, '{}\n');
            const composition = await createCheckpointSessionComposition({
                provider: 'claude-remote',
                platform: 'darwin',
                projectPath,
                sessionId: 'provider-smoke-claude',
                sandboxConfig: SandboxConfigSchema.parse({
                    checkpointProtection: {
                        secretPatterns: ['.env*'],
                        maxFileBytes: 1024 * 1024,
                        maxFiles: 100,
                        maxTotalBytes: 16 * 1024 * 1024,
                    },
                    extraWritePaths: [],
                    denyReadPaths: [],
                    networkMode: 'allowed',
                    allowLocalBinding: false,
                }),
                env: {
                    [CHECKPOINT_SPAWN_CONTEXT_ENV_KEY]: JSON.stringify({
                        schemaVersion: 1,
                        projectId: 'provider-smoke-project',
                        worktreeId: null,
                        checkpointRoot,
                    }),
                },
            });
            const mode: EnhancedMode = {
                permissionMode: 'bypassPermissions',
                allowedTools: ['Bash', 'Write', 'Edit'],
            };

            const result = await claudeRemote({
                sessionId: null,
                path: projectPath,
                allowedTools: ['Bash', 'Write', 'Edit'],
                hookSettingsPath,
                exitAfterFirstTurn: true,
                sandbox: composition.claudeSandbox,
                beforeTurn: composition.beforeTurn,
                completeTurn: composition.completeTurn,
                nextMessage: async () => ({
                    message: "Run this shell command in the current workspace exactly once: printf 'protected claude\\n' > provider-smoke.txt\n"
                        + 'Do not modify any other file. Finish immediately after the command succeeds.',
                    mode,
                }),
                onReady: () => {},
                canCallTool: async () => ({ behavior: 'allow' }) as any,
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: () => {},
            });

            expect(result).toBe('turn-complete');
            await expect(readFile(join(projectPath, 'provider-smoke.txt'), 'utf8'))
                .resolves.toBe('protected claude\n');
        });
    },
);
