/**
 * bwrap 샌드박스 초기화가 실패했을 때, 그 폴백이 요청받은 네트워크를 실제로
 * 잃는지 판정한다.
 *
 * 초기화가 실패하면 Codex 는 sandboxManagedByHappy=false 로 떨어져
 * permissionMode 기반 네이티브 정책을 쓴다. 그 정책 중 read-only 만
 * ({ type: 'readOnly' }) networkAccess 필드 자체가 없어 네트워크가 통째로
 * 사라진다. workspaceWrite 는 networkAccess: true 를, dangerFullAccess 는
 * 무제한 접근을 그대로 가진다 — 이 둘은 폴백해도 네트워크를 잃지 않는다.
 *
 * networkMode 가 'blocked' 가 아니면 호출자가 네트워크를 명시적으로 요청한
 * 것이다. 요청한 네트워크를 잃는 조합에서만 조용히 진행하지 않는다.
 */
import type { SandboxConfig } from '@/persistence';
import type { SandboxMode } from './codexAppServerTypes';

export function isSandboxFallbackNetworkLoss(
  sandboxConfig: SandboxConfig | undefined,
  nativeSandbox: SandboxMode,
): boolean {
  if (sandboxConfig?.enabled !== true) return false;
  if (sandboxConfig.networkMode === 'blocked') return false;
  return nativeSandbox === 'read-only';
}
