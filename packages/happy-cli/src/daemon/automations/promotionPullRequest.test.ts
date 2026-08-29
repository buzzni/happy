import { describe, expect, it } from 'vitest';

import { isPromotionPullRequest } from './promotionPullRequest';

// 2026-08-29 프로덕션 — automation 이 head=main, base=product 인 승격 PR 을
// 리뷰하려다 매분 실패했다. main 은 움직이는 브랜치라 이벤트를 잡은 시점의 SHA 로
// checkout 하면 영영 어긋난다(HEAD mismatch).
//
// 그리고 애초에 리뷰 대상으로 부적합하다 — 승격 PR 의 커밋들은 이미 main 에서
// 각각 리뷰를 거친 것들의 묶음이다.
describe('isPromotionPullRequest', () => {
  it('excludes a main -> product promotion', () => {
    expect(isPromotionPullRequest({ headRefName: 'main', baseRefName: 'product' })).toBe(true);
  });

  it('excludes a develop -> main sync', () => {
    expect(isPromotionPullRequest({ headRefName: 'develop', baseRefName: 'main' })).toBe(true);
  });

  it('excludes a main -> develop back-merge', () => {
    expect(isPromotionPullRequest({ headRefName: 'main', baseRefName: 'develop' })).toBe(true);
  });

  it('keeps a normal feature PR reviewable', () => {
    expect(isPromotionPullRequest({ headRefName: 'fix/some-bug', baseRefName: 'main' })).toBe(false);
  });

  it('keeps a release branch PR reviewable — it carries its own commits', () => {
    // release/* 는 장수 브랜치가 아니다. 실제 변경을 담으므로 리뷰 대상이다.
    expect(isPromotionPullRequest({ headRefName: 'release/happy-cli-158', baseRefName: 'main' })).toBe(false);
  });

  it('does not exclude a branch that merely starts with a long-lived name', () => {
    // 'mainline-refactor' 는 main 이 아니다 — 접두사 일치로 잘못 거르면 안 된다.
    expect(isPromotionPullRequest({ headRefName: 'mainline-refactor', baseRefName: 'main' })).toBe(false);
  });
});
