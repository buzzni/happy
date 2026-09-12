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
 *
 * policyMode='mandatory'(공유 머신)에서는 위의 관용적 폴백을 전부 끊는다. 개인
 * 머신(owner-choice, 기본값)의 동작은 그대로다 — 자세한 구분 근거는 sandboxPolicy.ts.
 */
import { SandboxConfigSchema, type SandboxConfig } from '@/persistence';
import { logger } from '@/ui/logger';
import { MandatorySandboxError, type SandboxPolicyMode } from './sandboxPolicy';

export function resolveSessionSandboxConfig(input: {
    noSandbox: boolean;
    env: Record<string, string | undefined>;
    settings: { sandboxConfig?: SandboxConfig } | undefined;
    /** 생략하면 개인 머신(owner-choice)으로 본다. */
    policyMode?: SandboxPolicyMode;
}): SandboxConfig | undefined {
    const mandatory = input.policyMode === 'mandatory';

    if (input.noSandbox) {
        if (mandatory) throw new MandatorySandboxError('no-sandbox-flag');
        return undefined;
    }

    const injected = input.env.HAPPY_PROJECT_SANDBOX_CONFIG;
    if (injected !== undefined) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(injected);
        } catch (error) {
            // 깨진 주입 하나로 세션 전체를 죽이지 않는다. 로컬 설정으로 물러나되
            // 조용히 넘어가지는 않는다 — 이 경로가 조용해서 사고를 늦게 찾았다.
            const detail = error instanceof Error ? error.message : 'unknown';
            if (mandatory) throw new MandatorySandboxError('malformed-injection', detail);
            logger.debug(`[sandbox] Ignoring malformed HAPPY_PROJECT_SANDBOX_CONFIG: ${detail}`);
            return requireEnabled(input.settings?.sandboxConfig, mandatory);
        }
        if (
            typeof parsed === 'object'
            && parsed !== null
            && Object.prototype.hasOwnProperty.call(parsed, 'checkpointProtection')
        ) {
            return requireEnabled(SandboxConfigSchema.parse(parsed), mandatory);
        }
        try {
            return requireEnabled(SandboxConfigSchema.parse(parsed), mandatory);
        } catch (error) {
            if (error instanceof MandatorySandboxError) throw error;
            const detail = error instanceof Error ? error.message : 'unknown';
            if (mandatory) throw new MandatorySandboxError('malformed-injection', detail);
            logger.debug(`[sandbox] Ignoring malformed HAPPY_PROJECT_SANDBOX_CONFIG: ${detail}`);
        }
    }
    return requireEnabled(input.settings?.sandboxConfig, mandatory);
}

/** mandatory 머신에서 "설정이 없음"과 "설정이 껐음"은 둘 다 비격리 실행이다. */
function requireEnabled(
    config: SandboxConfig | undefined,
    mandatory: boolean,
): SandboxConfig | undefined {
    if (!mandatory) return config;
    if (config === undefined) throw new MandatorySandboxError('missing-config');
    if (config.enabled !== true) throw new MandatorySandboxError('disabled-config');
    return config;
}
