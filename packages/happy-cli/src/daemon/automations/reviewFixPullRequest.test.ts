import { describe, expect, it } from 'vitest';

import { isReviewFixPullRequest } from './reviewFixPullRequest';

// 2026-09-03 프로덕션 — 스택 PR 전환 뒤 자동화가 자기 수정 PR 을 다시 리뷰하고
// 그 위에 또 수정을 쌓았다:
//   #341 perf/token-streaming-…        ← 사람이 만든 원본
//    └ #342 review-fix/341-74fd43c     ← 자동화 수정
//       └ #344 review-fix/342-cd6c673  ← 자동화가 #342 를 리뷰해 만든 수정
// 수정 PR 도 새 PR 이라 트리거가 그대로 잡는다. dedupe 가 PR 당 cycle-1 이라
// 폭주하진 않지만 종료 보장이 없고, 사람이 봐야 할 PR 만 늘어난다. 같은 판단자를
// 두 번 돌리는 것이라 새 정보도 적다.
describe('isReviewFixPullRequest', () => {
  it('excludes a review fix pull request', () => {
    expect(isReviewFixPullRequest({ headRefName: 'review-fix/341-74fd43c' })).toBe(true);
  });

  it('excludes a fix stacked on another fix', () => {
    expect(isReviewFixPullRequest({ headRefName: 'review-fix/342-cd6c673' })).toBe(true);
  });

  // 독립 리뷰 preset 도 같은 접두사를 쓴다. 그쪽 산출물도 자동 리뷰 대상이 아니다.
  it('excludes the independent review preset naming too', () => {
    expect(isReviewFixPullRequest({ headRefName: 'review-fix/3296-auto-review' })).toBe(true);
  });

  it('keeps a normal feature branch reviewable', () => {
    expect(isReviewFixPullRequest({ headRefName: 'fix/some-bug' })).toBe(false);
    expect(isReviewFixPullRequest({ headRefName: 'perf/token-streaming' })).toBe(false);
  });

  // 접두사가 경계에서 끝나야 한다 — 사람이 만든 review-fixture 같은 이름을 막으면 안 된다.
  it('does not match a branch that merely starts with the same letters', () => {
    expect(isReviewFixPullRequest({ headRefName: 'review-fixture/parser' })).toBe(false);
    expect(isReviewFixPullRequest({ headRefName: 'review-fix' })).toBe(false);
  });
});
