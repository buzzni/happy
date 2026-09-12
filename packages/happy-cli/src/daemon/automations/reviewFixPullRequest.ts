/**
 * 리뷰가 만들어 낸 수정 PR 을 다시 리뷰 대상으로 삼지 않는다.
 *
 * 2026-09-03 프로덕션 — 스택 PR 전환 뒤 자동화가 자기 수정 PR 을 리뷰하고 그 위에
 * 또 수정을 쌓았다:
 *   #341 perf/token-streaming-…        ← 사람이 만든 원본
 *    └ #342 review-fix/341-74fd43c     ← 자동화 수정
 *       └ #344 review-fix/342-cd6c673  ← 자동화가 #342 를 리뷰해 만든 수정
 *
 * 수정 PR 도 새 PR 이라 트리거가 그대로 잡는다. dedupe 가 PR 당 cycle-1 이라
 * 폭주하지는 않지만 종료 보장이 없고, 사람이 봐야 할 PR 만 늘어난다. 같은 판단자를
 * 두 번 돌리는 것이라 새 정보도 적다. 자동 수정의 검토는 사람이 한다.
 *
 * 스택 PR 로 바꾸기 전에는 없던 현상이다 — 그때는 수정이 원본 브랜치에 커밋으로
 * 들어가 새 PR 이 생기지 않았다.
 */
const REVIEW_FIX_PREFIX = 'review-fix/';

export function isReviewFixPullRequest(pr: { headRefName: string }): boolean {
  return pr.headRefName.startsWith(REVIEW_FIX_PREFIX);
}
