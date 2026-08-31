/**
 * worktree 정리를 몇 번까지 재시도할지 정한다.
 *
 * 2026-08-30 프로덕션 — 서브모듈 때문에 `git worktree remove` 가 거부되자
 * 재시도 제한이 없어 매분 다시 시도하며 누적 1,192회 실패했다. worktree 11개가
 * 2.3GB 를 물고 앉았고, 실패는 로그에만 쌓일 뿐 아무도 알지 못했다.
 *
 * 그 원인(--force 누락)은 따로 고쳤다. 이 상한은 **다음 원인**을 위한 것이다 —
 * 되돌릴 수 없는 실패를 영원히 재시도하는 구조 자체가 문제였다.
 *
 * 포기는 조용하지 않다. 호출부가 경고를 남겨, 남은 디렉터리를 사람이 치울 수
 * 있게 한다. 재시도 간격이 60초이므로 10회는 약 10분이다.
 */
export const MAX_WORKTREE_CLEANUP_ATTEMPTS = 10;

export function shouldGiveUpWorktreeCleanup(attempts: number | undefined): boolean {
  return (attempts ?? 0) >= MAX_WORKTREE_CLEANUP_ATTEMPTS;
}
