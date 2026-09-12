import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import type { SandboxConfig } from '@/persistence';
import {
    initializeSandbox,
    wrapCommand,
    wrapForMcpTransport,
} from './manager';

const {
    mockInitialize,
    mockWrapWithSandbox,
    mockReset,
    mockBuildSandboxRuntimeConfig,
} = vi.hoisted(() => ({
    mockInitialize: vi.fn(),
    mockWrapWithSandbox: vi.fn(),
    mockReset: vi.fn(),
    mockBuildSandboxRuntimeConfig: vi.fn(),
}));

vi.mock('@anthropic-ai/sandbox-runtime', () => ({
    SandboxManager: {
        initialize: mockInitialize,
        wrapWithSandbox: mockWrapWithSandbox,
        reset: mockReset,
    },
}));

vi.mock('./config', () => ({
    buildSandboxRuntimeConfig: mockBuildSandboxRuntimeConfig,
}));

describe('sandbox manager', () => {
    const runtimeConfig: SandboxRuntimeConfig = {
        network: {
            allowedDomains: ['*'],
            deniedDomains: [],
            allowLocalBinding: true,
            allowUnixSockets: [],
        },
        filesystem: {
            denyRead: [],
            allowWrite: ['/tmp'],
            denyWrite: [],
        },
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockBuildSandboxRuntimeConfig.mockReturnValue(runtimeConfig);
        mockWrapWithSandbox.mockResolvedValue('sandbox wrapped command');
    });

    it('initializes sandbox for allowed network mode and returns cleanup function', async () => {
        const sandboxConfig: SandboxConfig = {
            enabled: true,
            sessionIsolation: 'workspace',
            customWritePaths: [],
            denyReadPaths: [],
            extraWritePaths: ['/tmp'],
            denyWritePaths: [],
            networkMode: 'allowed',
            allowedDomains: [],
            deniedDomains: [],
            allowLocalBinding: true,
        };

        const cleanup = await initializeSandbox(sandboxConfig, '/workspace/session');

        expect(mockBuildSandboxRuntimeConfig).toHaveBeenCalledWith(sandboxConfig, '/workspace/session', 'owner-choice');
        expect(mockInitialize).toHaveBeenCalledWith(runtimeConfig);

        await cleanup();
        expect(mockReset).toHaveBeenCalledTimes(1);
    });

    it('initializes sandbox runtime for blocked network mode', async () => {
        const sandboxConfig: SandboxConfig = {
            enabled: true,
            sessionIsolation: 'workspace',
            customWritePaths: [],
            denyReadPaths: [],
            extraWritePaths: ['/tmp'],
            denyWritePaths: [],
            networkMode: 'blocked',
            allowedDomains: [],
            deniedDomains: [],
            allowLocalBinding: false,
        };

        await initializeSandbox(sandboxConfig, '/workspace/session');

        expect(mockInitialize).toHaveBeenCalledWith(runtimeConfig);
    });

    it('wrapCommand delegates to SandboxManager.wrapWithSandbox', async () => {
        const wrapped = await wrapCommand('node script.js');

        expect(mockWrapWithSandbox).toHaveBeenCalledWith('node script.js');
        expect(wrapped).toBe('sandbox wrapped command');
    });

    it('wrapForMcpTransport returns sh -c wrapped command', async () => {
        mockWrapWithSandbox.mockResolvedValue('sandbox codex command');

        const wrapped = await wrapForMcpTransport('codex', ['mcp-server']);

        expect(mockWrapWithSandbox).toHaveBeenCalledWith('codex mcp-server');
        expect(wrapped).toEqual({
            command: 'sh',
            args: ['-c', 'sandbox codex command'],
        });
    });

});

// d2a6b42e 리뷰 결함 — 정책을 판정만 하고 이 경계까지 전달하지 않아 프로덕션에서
// floor 가 한 번도 적용되지 않았다. 실제 초기화 인자로 확인한다.
describe('sandbox manager policy boundary', () => {
    const sandboxConfig: SandboxConfig = {
        enabled: true,
        sessionIsolation: 'workspace',
        customWritePaths: [],
        denyReadPaths: [],
        extraWritePaths: ['/tmp'],
        denyWritePaths: [],
        networkMode: 'allowed',
        allowedDomains: [],
        deniedDomains: [],
        allowLocalBinding: true,
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockBuildSandboxRuntimeConfig.mockReturnValue({
            network: { allowedDomains: ['*'], deniedDomains: [], allowLocalBinding: true, allowUnixSockets: [] },
            filesystem: { denyRead: [], allowWrite: ['/tmp'], denyWrite: [] },
        } satisfies SandboxRuntimeConfig);
    });

    it('forwards the mandatory policy into the runtime config build', async () => {
        await initializeSandbox(sandboxConfig, '/tmp/session', 'mandatory');

        expect(mockBuildSandboxRuntimeConfig).toHaveBeenCalledWith(
            sandboxConfig,
            '/tmp/session',
            'mandatory',
        );
    });

    it('defaults to owner-choice when no policy is given', async () => {
        await initializeSandbox(sandboxConfig, '/tmp/session');

        expect(mockBuildSandboxRuntimeConfig).toHaveBeenCalledWith(
            sandboxConfig,
            '/tmp/session',
            'owner-choice',
        );
    });
});
