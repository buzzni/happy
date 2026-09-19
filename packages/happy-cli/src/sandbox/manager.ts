import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import type { SandboxConfig } from '@/persistence';
import { buildSandboxRuntimeConfig } from './config';
import { allowElectronInSeatbelt } from './electronSeatbelt';
import type { SandboxPolicyMode } from './sandboxPolicy';

export async function initializeSandbox(
    sandboxConfig: SandboxConfig,
    sessionPath: string,
    /** 생략하면 개인 머신(owner-choice)으로 본다 — sandboxPolicy.ts */
    policyMode: SandboxPolicyMode = 'owner-choice',
): Promise<() => Promise<void>> {
    const runtimeConfig = buildSandboxRuntimeConfig(sandboxConfig, sessionPath, policyMode);
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
