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
  // 기대 HEAD 를 체크아웃할 수 없다. worktree 준비는 tip 이 움직였으면 먼저 기대
  // SHA 를 직접 핀하므로(githubTriggerWorktree), 여기 도달했다는 것은 그 SHA 자체가
  // 없다는 뜻이다(force-push). 서버가 색인한 스냅샷이 사라졌으니 다시 checkout 해도
  // 같아지지 않는다. 단, PR 은 push 로 리뷰가 다시 걸리지 않으므로 이 이벤트를 접으면
  // 그 PR 은 이 cycle 에서 리뷰되지 않는다 — 그래서 핀이 먼저다.
  // 'HEAD lookup failed'(조회 자체 실패)는 네트워크·권한 문제일 수 있어 제외한다.
  /worktree HEAD mismatch/i,
];

export function isPermanentGithubTriggerFailure(error: string): boolean {
  return PERMANENT_PATTERNS.some((pattern) => pattern.test(error));
}
