/**
 * 데몬 기동 시 샌드박스 의존성을 미리 확인한다.
 *
 * `checkDependencies()` 는 이미 공개 API 인데 `initialize()` 안에서만 불린다.
 * 그래서 의존성이 빠진 머신은 AgentTask 워커가 실제로 뜰 때까지 그 사실을 모르고,
 * 증상은 몇 분 뒤 exec_command 안의 네트워크 호출 실패로 나타나 원인과 멀리
 * 떨어진다(2026-08-28: socat 부재로 하루를 씀). 기동 시점에 한 번 확인해 둔다.
 *
 * 사전 점검은 진단 도구다 — 실패해도 데몬 기동을 막지 않는다.
 */
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { SandboxConfigSchema } from '@/persistence';
import { initializeSandbox } from './manager';
import {
  describeSandboxCapabilityFailure,
  verifySandboxExecutionCapability,
  type SandboxExecutionCapability,
} from './executionCapability';
import { resolveSessionSandboxPolicyMode, type SandboxPolicyMode } from './sandboxPolicy';

export type SandboxDependencyPreflightDeps = {
  check: () => { errors: string[]; warnings: string[] };
  log: (message: string) => void;
};

const defaultDeps: SandboxDependencyPreflightDeps = {
  check: () => SandboxManager.checkDependencies(),
  log: (message) => console.warn(message),
};

/** @returns 샌드박스를 쓸 수 있으면 true. errors 가 있을 때만 false. */
export function reportSandboxDependencyPreflight(
  deps: SandboxDependencyPreflightDeps = defaultDeps,
): boolean {
  let result: { errors: string[]; warnings: string[] };
  try {
    result = deps.check();
  } catch (error) {
    deps.log(
      `[sandbox] Dependency preflight could not run: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
    return true;
  }

  for (const warning of result.warnings) {
    deps.log(`[sandbox] Dependency warning: ${warning}`);
  }
  if (result.errors.length === 0) return true;

  // 빠진 바이너리 이름만 찍으면 왜 문제인지 알 수 없다. 결론까지 적는다.
  deps.log(
    `[sandbox] Sandboxing is unavailable on this machine: ${result.errors.join(', ')}. `
    + `Sessions that require network access through the sandbox (AgentTask workers) will fail `
    + `to start until these are installed.`,
  );
  return false;
}

export type SandboxExecutionPreflightDeps = {
  policyMode: SandboxPolicyMode;
  initialize: () => Promise<() => Promise<void>>;
  verify: () => Promise<SandboxExecutionCapability>;
  log: (message: string) => void;
};

/**
 * 이 머신에서 샌드박스가 **실제로 명령을 실행할 수 있는지** 기동 시점에 남긴다.
 *
 * 의존성 검사와 initialize() 는 비특권 컨테이너에서도 통과하고, 감싼 자식이
 * namespace 생성에서 죽는다(2026-09-10 기본 Docker 프로브). 그래서 격리가 필수인
 * 머신에서는 세션을 기다리지 말고 여기서 확인해, 활성화 판단의 근거를 남긴다.
 *
 * 개인 머신에서는 아무것도 하지 않는다 — 없던 기동 비용을 넣지 않는다.
 * 진단은 실패해도 데몬 기동을 막지 않는다.
 *
 * @returns 격리가 필수인데 실행 능력이 없으면 false.
 */
export async function reportSandboxExecutionPreflight(
  deps: SandboxExecutionPreflightDeps = {
    policyMode: resolveSessionSandboxPolicyMode(),
    initialize: () => initializeSandbox(
      SandboxConfigSchema.parse({}),
      process.cwd(),
      'mandatory',
    ),
    verify: () => verifySandboxExecutionCapability(),
    log: (message) => console.warn(message),
  },
): Promise<boolean> {
  if (deps.policyMode !== 'mandatory') return true;

  let cleanup: (() => Promise<void>) | null = null;
  try {
    cleanup = await deps.initialize();
    const capability = await deps.verify();
    if (capability.ok) {
      deps.log('[sandbox] Mandatory isolation preflight: sandbox execution verified on this machine.');
      return true;
    }
    deps.log(
      `[sandbox] Mandatory isolation preflight FAILED — sessions on this machine will refuse to start. `
      + describeSandboxCapabilityFailure(capability),
    );
    return false;
  } catch (error) {
    deps.log(
      `[sandbox] Mandatory isolation preflight could not run: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  } finally {
    if (cleanup) {
      await cleanup().catch(() => {});
    }
  }
}
