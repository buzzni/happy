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
