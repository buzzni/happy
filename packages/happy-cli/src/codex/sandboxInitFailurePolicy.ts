/**
 * bwrap 샌드박스 초기화가 실패했을 때 조용히 계속 진행할지, 아니면 스폰을 즉시
 * 실패시킬지 정하는 판정.
 *
 * networkMode 가 'blocked' 가 아니면 호출자는 네트워크를 명시적으로 요청한
 * 것이다. 그런데 초기화가 실패하면 Codex 는 sandboxManagedByHappy=false 로
 * 떨어져 permissionMode 기반 네이티브 정책을 쓰고, read-only 의 그 정책
 * ({ type: 'readOnly' })에는 networkAccess 필드 자체가 없다 — 네트워크가
 * 통째로 사라진다. 조용히 계속 돌다가 몇 분 뒤 exec_command 안의 네트워크
 * 호출이 실패할 때가 돼서야 드러나느니, 스폰 시점에 바로 실패하는 편이 낫다.
 */
import type { SandboxConfig } from '@/persistence';

export function isNetworkRequiredSandboxFailureFatal(
  sandboxConfig: SandboxConfig | undefined,
): boolean {
  return sandboxConfig?.enabled === true && sandboxConfig.networkMode !== 'blocked';
}
