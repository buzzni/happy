import { describe, expect, it } from 'vitest';

import {
  MAX_WORKTREE_CLEANUP_ATTEMPTS,
  shouldGiveUpWorktreeCleanup,
} from './worktreeCleanupGiveUp';

// 2026-08-30 프로덕션 — 리뷰가 끝난 worktree 11개가 지워지지 않고 2.3GB 를 물었다.
// git 이 서브모듈 때문에 remove 를 거부했는데, 재시도 횟수 제한이 없어 매분 다시
// 시도하며 누적 1,192회 실패했다. 실패해도 아무도 모르고 디스크만 찼다.
//
// --force 로 그 원인은 없앴지만, 원인을 하나 없애는 것과 "영원히 재시도하지 않는
// 구조" 는 다른 문제다. 다음 원인이 또 나와도 무한 반복되면 안 된다.
describe('shouldGiveUpWorktreeCleanup', () => {
  it('keeps retrying while attempts remain', () => {
    expect(shouldGiveUpWorktreeCleanup(1)).toBe(false);
    expect(shouldGiveUpWorktreeCleanup(MAX_WORKTREE_CLEANUP_ATTEMPTS - 1)).toBe(false);
  });

  it('gives up once the attempt budget is spent', () => {
    expect(shouldGiveUpWorktreeCleanup(MAX_WORKTREE_CLEANUP_ATTEMPTS)).toBe(true);
    expect(shouldGiveUpWorktreeCleanup(MAX_WORKTREE_CLEANUP_ATTEMPTS + 5)).toBe(true);
  });

  it('treats a missing attempt count as the first try', () => {
    // 이 필드가 생기기 전에 기록된 journal 은 attempts 가 없다. 그것을 포기로
    // 읽으면 기존 worktree 가 통째로 방치된다.
    expect(shouldGiveUpWorktreeCleanup(undefined)).toBe(false);
  });

  it('bounds the budget so a stuck worktree cannot spin for a day', () => {
    // 60초 간격이므로 예산이 커지면 그만큼 오래 돈다. 상한을 명시적으로 고정한다.
    expect(MAX_WORKTREE_CLEANUP_ATTEMPTS).toBeGreaterThan(1);
    expect(MAX_WORKTREE_CLEANUP_ATTEMPTS).toBeLessThanOrEqual(20);
  });
});
