import { describe, expect, it } from 'vitest';

import { isNetworkRequiredSandboxFailureFatal } from './sandboxInitFailurePolicy';

// 2026-08-28 프로덕션 — bwrap 초기화가 socat 부재로 실패하자 조용히 "계속 진행"했다.
// 그 결과 sandboxManagedByHappy=false 가 되어 --permission-mode read-only 가 Codex
// 네이티브 readOnly 정책(네트워크 없는 타입)으로 떨어졌다. 워커는 몇 분을 돌다가
// exec_command 안의 curl 이 DNS 를 못 찾을 때가 돼서야 실패가 드러났다. 네트워크가
// 명시적으로 필요했던 자리에서 조용히 열화하지 말고 스폰 시점에 바로 실패한다.
describe('isNetworkRequiredSandboxFailureFatal', () => {
  it('is fatal when network was explicitly required and sandbox failed to init', () => {
    expect(isNetworkRequiredSandboxFailureFatal({ enabled: true, networkMode: 'allowed' } as never))
      .toBe(true);
  });

  it('is fatal for custom network mode too — it also requested network', () => {
    expect(isNetworkRequiredSandboxFailureFatal({ enabled: true, networkMode: 'custom' } as never))
      .toBe(true);
  });

  it('is not fatal when the sandbox deliberately blocked network — no regression there', () => {
    expect(isNetworkRequiredSandboxFailureFatal({ enabled: true, networkMode: 'blocked' } as never))
      .toBe(false);
  });

  it('is not fatal when no sandbox was requested at all', () => {
    expect(isNetworkRequiredSandboxFailureFatal(undefined)).toBe(false);
  });

  it('is not fatal when the config exists but is not enabled', () => {
    expect(isNetworkRequiredSandboxFailureFatal({ enabled: false, networkMode: 'allowed' } as never))
      .toBe(false);
  });
});
