import { resolve } from 'node:path';
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { DANGEROUS_FILES, getDangerousDirectories } from '@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js';
import type { SandboxConfig } from '@/persistence';
import { buildSandboxRuntimeConfig } from './config';
import { allowElectronInSeatbelt } from './electronSeatbelt';
import type { SandboxPolicyMode } from './sandboxPolicy';

/**
 * 런타임은 wrap 시점 cwd 기준으로 DANGEROUS_FILES·디렉터리(.vscode, .idea 등)를 스스로 쓰기 금지한다.
 * 같은 경로가 denyWrite 에도 있으면 bwrap 인자에 두 번 들어가고, 그 경로가 아직 없으면 /dev/null 을
 * 두 번 덮다가 bwrap 0.4.0(Ubuntu 20.04)이 "Can't create file ... Permission denied" 로 죽는다.
 */
function withoutRuntimeMandatoryDenies(config: SandboxRuntimeConfig, cwd: string): SandboxRuntimeConfig {
    const runtimeDenies = new Set(
        [...DANGEROUS_FILES, ...getDangerousDirectories()].map((name) => resolve(cwd, name)),
    );
    return {
        ...config,
        filesystem: {
            ...config.filesystem,
            denyWrite: config.filesystem.denyWrite.filter((path) => !runtimeDenies.has(path)),
        },
    };
}

export async function initializeSandbox(
    sandboxConfig: SandboxConfig,
    sessionPath: string,
    /** 생략하면 개인 머신(owner-choice)으로 본다 — sandboxPolicy.ts */
    policyMode: SandboxPolicyMode = 'owner-choice',
): Promise<() => Promise<void>> {
    const runtimeConfig = withoutRuntimeMandatoryDenies(
        buildSandboxRuntimeConfig(sandboxConfig, sessionPath, policyMode),
        process.cwd(),
    );
    await SandboxManager.initialize(runtimeConfig);

    return async () => {
        await SandboxManager.reset();
    };
}

export async function wrapCommand(command: string): Promise<string> {
    // macOS seatbelt 는 Electron 부팅에 필요한 mach 서비스를 닫아 둔다 — electronSeatbelt.ts 참조.
    // Linux(bwrap) 등 다른 래퍼에는 손대지 않는다.
    return allowElectronInSeatbelt(await SandboxManager.wrapWithSandbox(command));
}

export async function wrapForMcpTransport(
    command: string,
    args: string[],
): Promise<{ command: 'sh'; args: ['-c', string] }> {
    const wrappedCommand = await wrapCommand(`${command} ${args.join(' ')}`.trim());
    return {
        command: 'sh',
        args: ['-c', wrappedCommand],
    };
}
