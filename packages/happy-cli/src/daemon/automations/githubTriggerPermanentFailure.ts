/**
 * worktree 준비 실패를 영구/일시로 가른다.
 *
 * 2026-08-29 프로덕션 — automation 이 매분 재시도했다. 원인은 머지 후 삭제된
 * 브랜치를 계속 checkout 하려는 것이었다:
 *
 *   fatal: couldn't find remote ref refs/heads/release/happy-cli-1.1.10-aplus.154
 *
 * worktree 준비가 실패하면 `outcome: 'ERROR'` 로 돌아가는데, 그 경로는
 * `persistGithubTriggerState` 에 도달하지 않아 이벤트가 소비되지 않는다. 삭제된
 * 브랜치는 몇 번을 다시 checkout 해도 없으므로 그 이벤트는 영원히 남는다.
 *
 * 모르는 실패는 일시로 둔다 — 영구로 접으면 복구 가능한 상황에서 이벤트를 조용히
 * 버리게 된다. 확실히 되돌릴 수 없는 것만 영구로 접는다.
 */
const PERMANENT_PATTERNS: RegExp[] = [
  // 브랜치가 삭제됐다 (머지 후 정리 등)
  /couldn't find remote ref/i,
  /Could not resolve to a PullRequest/i,
  /no pull requests found/i,
  // 기대 HEAD 와 실제가 다르다. 이벤트를 잡은 시점의 SHA 로 고정돼 있으므로 다시
  // checkout 해도 같아지지 않는다 — 특히 head 가 main 처럼 움직이는 브랜치면 영영
  // 어긋난다. 이 이벤트는 이미 낡았으니 소비하고, 최신 상태는 다음 폴링이 잡는다.
  // 'HEAD lookup failed'(조회 자체 실패)는 네트워크·권한 문제일 수 있어 제외한다.
  /worktree HEAD mismatch/i,
];

export function isPermanentGithubTriggerFailure(error: string): boolean {
  return PERMANENT_PATTERNS.some((pattern) => pattern.test(error));
}
