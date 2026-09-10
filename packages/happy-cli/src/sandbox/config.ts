import { homedir, userInfo } from 'node:os';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import type { SandboxConfig } from '@/persistence';
import { configuration } from '@/configuration';
import {
    MandatorySandboxError,
    isUnsafeMandatoryWriteScope,
    sandboxTrustFloorPaths,
    type SandboxPolicyMode,
} from './sandboxPolicy';

/**
 * $HOME 은 spawn 페이로드로 올 수 있으므로 floor 기준으로 쓸 수 없다.
 * passwd 항목을 먼저 보고, 그것을 못 읽는 환경에서만 homedir() 로 물러난다.
 */
function trustedHomeDir(): string {
    try {
        return userInfo().homedir || homedir();
    } catch {
        return homedir();
    }
}

function expandPath(pathValue: string, sessionPath: string): string {
    const expandedHome = pathValue.replace(/^~(?=\/|$)/, homedir());
    // sandbox-runtime 0.0.37 recognises /tmp/... but misses the /tmp alias itself.
    if (process.platform === 'darwin' && resolve(sessionPath, expandedHome) === '/tmp'
        && realpathSync('/tmp') === '/private/tmp') {
        return '/private/tmp';
    }
    if (isAbsolute(expandedHome)) {
        return expandedHome;
    }

    return resolve(sessionPath, expandedHome);
}

function resolvePaths(paths: string[], sessionPath: string): string[] {
    return paths.map((pathValue) => expandPath(pathValue, sessionPath));
}

function getSharedAgentStatePaths(sessionPath: string): string[] {
    const codexHome = process.env.CODEX_HOME || '~/.codex';
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || '~/.claude';

    return [
        expandPath(codexHome, sessionPath),
        expandPath(claudeConfigDir, sessionPath),
    ];
}

function uniquePaths(paths: string[]): string[] {
    return [...new Set(paths)];
}

const CREDENTIAL_PATTERNS: RegExp[] = [
    /^(AWS|AZURE|GCP|GOOGLE)_/i,
    /^(ANTHROPIC|OPENAI|GEMINI)_API_KEY$/i,
    /_(SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE_KEY)$/i,
    /^(DATABASE_URL|REDIS_URL)$/i,
    /^S3_(ACCESS_KEY|SECRET_KEY|HOST)$/i,
    /^HAPPY_(MASTER_SECRET)$/i,
];

const SAFE_ENV_ALLOWLIST = new Set([
    'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'NODE_ENV', 'NODE_PATH', 'NODE_OPTIONS', 'NPM_CONFIG_PREFIX',
    'EDITOR', 'VISUAL', 'PAGER', 'TZ', 'TMPDIR',
    'WORKSPACE', 'HAPPY_PROJECT_SANDBOX_CONFIG', 'HAPPY_HOME_DIR',
    'PORT', 'HOST', 'DEBUG', 'VERBOSE',
    'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
    'COLORTERM', 'FORCE_COLOR', 'NO_COLOR',
]);

/**
 * Filter environment variables to remove credentials before passing to sandboxed processes.
 * Allowlisted vars always pass. Credential-pattern vars are always removed. Others pass through.
 */
export function filterCredentialsFromEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) continue;
        if (SAFE_ENV_ALLOWLIST.has(key)) {
            filtered[key] = value;
            continue;
        }
        const isCredential = CREDENTIAL_PATTERNS.some(pattern => pattern.test(key));
        if (!isCredential) {
            filtered[key] = value;
        }
    }
    return filtered;
}

export function buildSandboxRuntimeConfig(
    sandboxConfig: SandboxConfig,
    sessionPath: string,
    /** 생략하면 개인 머신(owner-choice)으로 본다 — sandboxPolicy.ts */
    policyMode: SandboxPolicyMode = 'owner-choice',
): SandboxRuntimeConfig {
    const extraWritePaths = resolvePaths(sandboxConfig.extraWritePaths, sessionPath);
    const sharedAgentStatePaths = getSharedAgentStatePaths(sessionPath);

    const allowWrite = (() => {
        switch (sandboxConfig.sessionIsolation) {
            case 'strict':
                return uniquePaths([resolve(sessionPath), ...extraWritePaths, ...sharedAgentStatePaths]);
            case 'workspace': {
                const workspaceRoot = sandboxConfig.workspaceRoot
                    ? expandPath(sandboxConfig.workspaceRoot, sessionPath)
                    : resolve(sessionPath);
                return uniquePaths([workspaceRoot, resolve(sessionPath), ...extraWritePaths, ...sharedAgentStatePaths]);
            }
            case 'custom':
                return uniquePaths([
                    ...resolvePaths(sandboxConfig.customWritePaths, sessionPath),
                    ...extraWritePaths,
                    ...sharedAgentStatePaths,
                ]);
        }
    })();

    const network = (() => {
        switch (sandboxConfig.networkMode) {
            case 'blocked':
                return {
                    allowedDomains: [] as string[],
                    deniedDomains: [] as string[],
                    allowLocalBinding: sandboxConfig.allowLocalBinding,
                    allowUnixSockets: [] as string[],
                };
            case 'allowed':
                return {
                    allowedDomains: undefined as unknown as string[],
                    deniedDomains: [] as string[],
                    allowLocalBinding: sandboxConfig.allowLocalBinding,
                    allowUnixSockets: [] as string[],
                };
            case 'custom':
                return {
                    allowedDomains: sandboxConfig.allowedDomains,
                    deniedDomains: sandboxConfig.deniedDomains,
                    allowLocalBinding: sandboxConfig.allowLocalBinding,
                    allowUnixSockets: [] as string[],
                };
        }
    })();

    const enableWeakerNetworkIsolation = sandboxConfig.networkMode === 'allowed'
        ? true
        : undefined;

    const mandatory = policyMode === 'mandatory';
    if (mandatory && isUnsafeMandatoryWriteScope(allowWrite, homedir())) {
        throw new MandatorySandboxError(
            'unsafe-write-scope',
            `쓰기 범위가 파일시스템/홈 루트입니다: ${allowWrite.join(', ')}`,
        );
    }
    const floor = mandatory
        ? sandboxTrustFloorPaths({
            homeDir: trustedHomeDir(),
            // 이 프로세스의 happyHomeDir 은 staged /tmp 홈일 수 있다. 그건
            // 세션 자신의 것이므로 floor 로 가리지 않는다 — 데몬의 홈만 덮는다.
            daemonHappyHomeDir: configuration.daemonHappyHomeDir,
        })
        : [];

    return {
        allowPty: true,
        enableWeakerNetworkIsolation,
        network,
        filesystem: {
            allowGitConfig: sandboxConfig.allowGitConfig === true && !sandboxConfig.checkpointProtection,
            denyRead: uniquePaths([...resolvePaths(sandboxConfig.denyReadPaths, sessionPath), ...floor]),
            allowWrite,
            denyWrite: uniquePaths([...resolvePaths(sandboxConfig.denyWritePaths, sessionPath), ...floor]),
        },
    };
}
