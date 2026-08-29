/**
 * 장수 브랜치끼리 오가는 승격·동기화 PR 을 리뷰 대상에서 제외한다.
 *
 * 2026-08-29 프로덕션 — automation 이 head=main, base=product 인 승격 PR 을
 * 리뷰하려다 매분 실패했다. main 은 계속 움직이므로 이벤트를 잡은 시점의 SHA 로
 * checkout 하면 영영 어긋난다(GitHub worktree HEAD mismatch).
 *
 * 그리고 애초에 리뷰 대상으로 부적합하다 — 승격 PR 이 나르는 커밋들은 이미 각자
 * 자기 PR 에서 리뷰를 거친 것들이다. 다시 리뷰하면 같은 코드를 두 번 본다.
 *
 * head 와 base 가 **둘 다** 장수 브랜치일 때만 제외한다. `release/happy-cli-158`
 * 처럼 실제 변경을 담은 브랜치는 이름이 길어도 리뷰 대상으로 남긴다.
 */
const LONG_LIVED_BRANCHES = new Set(['main', 'master', 'develop', 'product', 'staging']);

export function isPromotionPullRequest(pr: {
  headRefName: string;
  baseRefName: string;
}): boolean {
  return LONG_LIVED_BRANCHES.has(pr.headRefName) && LONG_LIVED_BRANCHES.has(pr.baseRefName);
}
