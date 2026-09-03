/**
 * 세션이 어떤 sandbox 설정으로 뜰지 정하는 단일 판정.
 *
 * daemon 은 서버가 지시한 설정(예: AgentTask pr_review 의 networkMode:'allowed')을
 * HAPPY_PROJECT_SANDBOX_CONFIG 로 실어 보낸다. 그 주입은 로컬 머신 설정보다 우선한다 —
 * 머신마다 다른 개인 설정 때문에 서버가 지시한 실행 조건이 바뀌면 안 되기 때문이다.
 *
 * 이 판정이 Claude 경로에만 있고 Codex 경로에 없어서, agent=codex 로 도는 pr_review
 * 워커가 샌드박스 없이 떴고 Codex 네이티브 readOnly 정책(네트워크 없음)으로 떨어져
 * lifecycle 콜백을 전부 놓쳤다(2026-08-28). 그래서 양쪽이 함께 쓰는 자리로 올린다.
 */
import { SandboxConfigSchema, type SandboxConfig } from '@/persistence';
import { logger } from '@/ui/logger';

export function resolveSessionSandboxConfig(input: {
    noSandbox: boolean;
    env: Record<string, string | undefined>;
    settings: { sandboxConfig?: SandboxConfig } | undefined;
}): SandboxConfig | undefined {
    if (input.noSandbox) return undefined;

    const injected = input.env.HAPPY_PROJECT_SANDBOX_CONFIG;
    if (injected !== undefined) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(injected);
        } catch (error) {
            // 깨진 주입 하나로 세션 전체를 죽이지 않는다. 로컬 설정으로 물러나되
            // 조용히 넘어가지는 않는다 — 이 경로가 조용해서 사고를 늦게 찾았다.
            logger.debug(
                `[sandbox] Ignoring malformed HAPPY_PROJECT_SANDBOX_CONFIG: ${
                    error instanceof Error ? error.message : 'unknown'
                }`,
            );
            return input.settings?.sandboxConfig;
        }
        if (
            typeof parsed === 'object'
            && parsed !== null
            && Object.prototype.hasOwnProperty.call(parsed, 'checkpointProtection')
        ) {
            return SandboxConfigSchema.parse(parsed);
        }
        try {
            return SandboxConfigSchema.parse(parsed);
        } catch (error) {
            logger.debug(
                `[sandbox] Ignoring malformed HAPPY_PROJECT_SANDBOX_CONFIG: ${
                    error instanceof Error ? error.message : 'unknown'
                }`,
            );
        }
    }
    return input.settings?.sandboxConfig;
}
