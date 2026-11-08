import { describe, expect, it } from 'vitest';
import type { SandboxConfig } from '@/persistence';
import { createSessionMetadata } from './createSessionMetadata';
import { BASH_PREFIX_MATCHER_CAPABILITY } from '@/claude/utils/bashPrefixMatcher';

function createSandboxConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
    return {
        enabled: true,
        workspaceRoot: '~/Developer',
        sessionIsolation: 'workspace',
        customWritePaths: [],
        denyReadPaths: ['~/.ssh', '~/.aws', '~/.gnupg'],
        extraWritePaths: ['/tmp'],
        denyWritePaths: ['.env'],
        networkMode: 'allowed',
        allowedDomains: [],
        deniedDomains: [],
        allowLocalBinding: true,
        ...overrides,
    };
}

describe('createSessionMetadata', () => {
    it('advertises support for per-message Saycode system prompt policy', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-1',
        });

        expect(metadata.runtimeCapabilities).toEqual({
            saycodeSystemPromptPreference: true,
        });
    });

    // aplus-dev-studio specs/e2ee-machine-control-boundary R18 — sealed with the session key.
    it('advertises the approval lifecycle only for a runner that wires it (codexcli-approval-session-binding T24)', () => {
        expect(createSessionMetadata({ flavor: 'claude', machineId: 'm', approvalLifecycle: true }).metadata.runtimeCapabilities)
            .toEqual({ saycodeSystemPromptPreference: true, approvalLifecycle: 1 });
        expect(createSessionMetadata({ flavor: 'gemini', machineId: 'm' }).metadata.runtimeCapabilities)
            .toEqual({ saycodeSystemPromptPreference: true });
    });

    // aplus-dev-studio-desktop specs/linked-pull-requests R1-3 — tool presence, not a version guess.
    it('advertises the linked pull request tools only for a runner that exposes them', () => {
        expect(createSessionMetadata({ flavor: 'codex', machineId: 'm', linkedPullRequestTools: true }).metadata.runtimeCapabilities)
            .toEqual({ saycodeSystemPromptPreference: true, linkedPullRequests: 1 });
        for (const flavor of ['claude', 'openclaw'] as const) {
            expect(createSessionMetadata({ flavor, machineId: 'm' }).metadata.runtimeCapabilities).not.toHaveProperty('linkedPullRequests');
        }
    });

    it('advertises bound session RPCs', () => {
        const { metadata } = createSessionMetadata({ flavor: 'claude', machineId: 'machine-1' });

        expect(metadata.rpcBinding).toEqual({ version: 1 });
    });

    it('advertises the Bash matcher only when the running runner supplies it', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude', machineId: 'machine-1',
            permissionGrants: BASH_PREFIX_MATCHER_CAPABILITY,
        });
        expect(metadata.runtimeCapabilities?.permissionGrants).toEqual({ bashPrefixMatcher: 'plain-v1' });
    });

    it.each(['claude', 'codex', 'gemini', 'opencode', 'openclaw', 'grok', 'acp'] as const)(
        'does not infer a %s session matcher from its flavor or machine identity', (flavor) => {
            const { metadata } = createSessionMetadata({ flavor, machineId: 'upgraded-machine' });
            expect(metadata.runtimeCapabilities).not.toHaveProperty('permissionGrants');
        },
    );
    // aplus-dev-studio specs/session-source-metadata — the runner hands over what the daemon asked for.
    it('records the session source only when the runner supplies one', () => {
        expect(createSessionMetadata({ flavor: 'codex', machineId: 'machine-1', source: 'schedule' }).metadata.source).toBe('schedule');
        expect(createSessionMetadata({ flavor: 'codex', machineId: 'machine-1' }).metadata).not.toHaveProperty('source');
    });

    // aplus-dev-studio specs/cross-machine-agent-delegation R9 — every flavor records it, from the daemon's env.
    it('records delegatedFrom only when the daemon handed both the machine and the session', () => {
        const env = process.env;
        try {
            process.env = { ...env, HAPPY_CREATED_BY_DELEGATED_FROM_MACHINE_ID: 'machine-a', HAPPY_CREATED_BY_DELEGATED_FROM_SESSION_ID: 'parent-1' };
            expect(createSessionMetadata({ flavor: 'codex', machineId: 'machine-b' }).metadata.delegatedFrom).toEqual({ machineId: 'machine-a', sessionId: 'parent-1' });
            process.env = { ...env, HAPPY_CREATED_BY_DELEGATED_FROM_MACHINE_ID: 'machine-a' };
            expect(createSessionMetadata({ flavor: 'claude', machineId: 'machine-b' }).metadata).not.toHaveProperty('delegatedFrom');
        } finally {
            process.env = env;
        }
        expect(createSessionMetadata({ flavor: 'claude', machineId: 'machine-b' }).metadata).not.toHaveProperty('delegatedFrom');
    });

    // aplus specs/org-llm-endpoints r3 — the web client and a recovery with no local record recognize an endpoint session by this.
    it('records the non-secret endpoint marker only for a session the daemon started on an organization LLM endpoint', () => {
        const env = process.env;
        try {
            process.env = { ...env, HAPPY_AI_AUTH_ORG_ENDPOINT_BINDING: 'binding-1:endpoint-1:target-a:3', ANTHROPIC_AUTH_TOKEN: 'endpoint-secret-token', ANTHROPIC_BASE_URL: 'https://llm.corp.example' };
            const { metadata } = createSessionMetadata({ flavor: 'claude', machineId: 'machine-b' });
            expect(metadata.orgLlmEndpoint).toEqual({ version: 1, bindingId: 'binding-1', endpointId: 'endpoint-1' });
            expect(JSON.stringify(metadata)).not.toMatch(/endpoint-secret-token|llm\.corp\.example|target-a/);
            process.env = { ...env, HAPPY_AI_AUTH_ORG_ENDPOINT_BINDING: '' };
            expect(createSessionMetadata({ flavor: 'claude', machineId: 'machine-b' }).metadata).not.toHaveProperty('orgLlmEndpoint');
        } finally {
            process.env = env;
        }
        expect(createSessionMetadata({ flavor: 'claude', machineId: 'machine-b' }).metadata).not.toHaveProperty('orgLlmEndpoint');
    });

    it('sets metadata.sandbox to the config when enabled', () => {
        const sandbox = createSandboxConfig();
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-1',
            startedBy: 'terminal',
            sandbox,
        });

        expect(metadata.sandbox).toEqual(sandbox);
    });

    it('sets metadata.sandbox to null when sandbox is disabled', () => {
        const sandbox = createSandboxConfig({ enabled: false });
        const { metadata } = createSessionMetadata({
            flavor: 'gemini',
            machineId: 'machine-2',
            startedBy: 'daemon',
            sandbox,
        });

        expect(metadata.sandbox).toBeNull();
    });

    it('sets metadata.sandbox to null when sandbox is not provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-3',
        });

        expect(metadata.sandbox).toBeNull();
    });

    it('sets metadata.dangerouslySkipPermissions to null when not provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-4',
        });

        expect(metadata.dangerouslySkipPermissions).toBeNull();
    });

    it('sets metadata.dangerouslySkipPermissions when provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-5',
            dangerouslySkipPermissions: true,
        });

        expect(metadata.dangerouslySkipPermissions).toBe(true);
    });

    it('sets fork lineage metadata when provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-6',
            parentSessionId: 'happy-source',
            forkedFromMessageId: 'message-2',
        });

        expect(metadata.parentSessionId).toBe('happy-source');
        expect(metadata.forkedFromMessageId).toBe('message-2');
    });

    it('sets metadata.createdBy when provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-7',
            createdBy: { accountId: 'acct-123', displayName: 'Ada' },
        });

        expect(metadata.createdBy).toEqual({ accountId: 'acct-123', displayName: 'Ada' });
    });

    it('omits metadata.createdBy when not provided (backward compatible)', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-8',
        });

        expect('createdBy' in metadata).toBe(false);
    });
});
