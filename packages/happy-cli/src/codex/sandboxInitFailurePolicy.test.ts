import { describe, expect, it } from 'vitest';

import { isSandboxFallbackNetworkLoss } from './sandboxInitFailurePolicy';

// 2026-08-28 프로덕션 — bwrap 초기화가 socat 부재로 실패하자 조용히 "계속 진행"했다.
// 그 결과 sandboxManagedByHappy=false 가 되어 --permission-mode read-only 가 Codex
// 네이티브 readOnly 정책(네트워크 없는 타입)으로 떨어졌다. 워커는 몇 분을 돌다가
// exec_command 안의 curl 이 DNS 를 못 찾을 때가 돼서야 실패가 드러났다.
//
// 2026-08-31 회귀 — 그 수정이 permissionMode 를 보지 않아, 폴백해도 네트워크가
// 멀쩡한 workspaceWrite/dangerFullAccess 세션까지 스폰 시점에 전부 죽였다.
// 스튜디오는 모든 codex 세션을 --dangerously-skip-permissions(= dangerFullAccess)
// 로 띄우므로 죽을 이유가 없는 세션만 골라 죽는 상태가 됐다. 네트워크를 실제로
// 잃는 경우로 판정을 좁힌다.
describe('isSandboxFallbackNetworkLoss', () => {
  it('loses network when the native fallback is read-only and network was required', () => {
    expect(isSandboxFallbackNetworkLoss({ enabled: true, networkMode: 'allowed' } as never, 'read-only'))
      .toBe(true);
  });

  it('loses network for custom network mode too — it also requested network', () => {
    expect(isSandboxFallbackNetworkLoss({ enabled: true, networkMode: 'custom' } as never, 'read-only'))
      .toBe(true);
  });

  it('keeps network on workspace-write fallback — that policy sets networkAccess: true', () => {
    expect(isSandboxFallbackNetworkLoss({ enabled: true, networkMode: 'allowed' } as never, 'workspace-write'))
      .toBe(false);
  });

  it('keeps network on danger-full-access fallback — what the studio actually spawns', () => {
    expect(isSandboxFallbackNetworkLoss({ enabled: true, networkMode: 'allowed' } as never, 'danger-full-access'))
      .toBe(false);
  });

  it('does not fire when the sandbox deliberately blocked network — no regression there', () => {
    expect(isSandboxFallbackNetworkLoss({ enabled: true, networkMode: 'blocked' } as never, 'read-only'))
      .toBe(false);
  });

  it('does not fire when no sandbox was requested at all', () => {
    expect(isSandboxFallbackNetworkLoss(undefined, 'read-only')).toBe(false);
  });

  it('does not fire when the config exists but is not enabled', () => {
    expect(isSandboxFallbackNetworkLoss({ enabled: false, networkMode: 'allowed' } as never, 'read-only'))
      .toBe(false);
  });
});
