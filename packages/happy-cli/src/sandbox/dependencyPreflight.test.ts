import { describe, expect, it, vi } from 'vitest';

import { reportSandboxDependencyPreflight } from './dependencyPreflight';

// 2026-08-28 프로덕션 — 이 머신에 socat 이 없어 bwrap 초기화가 실패했고, 그 사실이
// AgentTask 워커가 실제로 뜰 때까지 드러나지 않았다. 증상은 몇 분 뒤 exec_command
// 안의 curl DNS 실패로 나타나 원인과 멀리 떨어져 있었다. checkDependencies() 는
// 이미 공개 API 인데 initialize() 안에서만 불려서, 데몬은 자기 머신이 샌드박스를
// 못 쓴다는 걸 미리 알 방법이 없었다.
describe('reportSandboxDependencyPreflight', () => {
  it('logs the missing dependencies at daemon startup', () => {
    const logs: string[] = [];

    const ok = reportSandboxDependencyPreflight({
      check: () => ({ errors: ['socat not installed'], warnings: [] }),
      log: (message) => logs.push(message),
    });

    expect(ok).toBe(false);
    expect(logs.join('\n')).toContain('socat not installed');
  });

  it('names the consequence, not just the missing binary', () => {
    const logs: string[] = [];

    reportSandboxDependencyPreflight({
      check: () => ({ errors: ['socat not installed'], warnings: [] }),
      log: (message) => logs.push(message),
    });

    // 빠진 바이너리 이름만 찍으면 왜 문제인지 알 수 없다. 오늘 하루를 날린 이유가
    // 정확히 그것이다 — 네트워크가 필요한 작업이 못 돈다는 결론까지 적는다.
    expect(logs.join('\n')).toMatch(/network|네트워크/i);
  });

  it('stays quiet when every dependency is present', () => {
    const logs: string[] = [];

    const ok = reportSandboxDependencyPreflight({
      check: () => ({ errors: [], warnings: [] }),
      log: (message) => logs.push(message),
    });

    expect(ok).toBe(true);
    expect(logs).toEqual([]);
  });

  it('reports warnings without calling the machine unusable', () => {
    const logs: string[] = [];

    const ok = reportSandboxDependencyPreflight({
      check: () => ({ errors: [], warnings: ['seccomp filter unavailable'] }),
      log: (message) => logs.push(message),
    });

    // 경고는 샌드박스를 못 쓰게 만들지 않는다 — errors 와 같은 취급을 하면
    // 진짜 차단 요인이 노이즈에 묻힌다.
    expect(ok).toBe(true);
    expect(logs.join('\n')).toContain('seccomp filter unavailable');
  });

  it('never throws into daemon startup when the check itself blows up', () => {
    const logs: string[] = [];

    // 사전 점검이 데몬 기동을 막으면 안 된다.
    const ok = reportSandboxDependencyPreflight({
      check: () => { throw new Error('boom'); },
      log: (message) => logs.push(message),
    });

    expect(ok).toBe(true);
    expect(logs.join('\n')).toContain('boom');
  });
});
