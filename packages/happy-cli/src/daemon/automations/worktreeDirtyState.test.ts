import { describe, expect, it } from 'vitest';

import { hasUnsavedWorktreeChanges } from './worktreeDirtyState';

// 2026-09-04 프로덕션 — 자동화 worktree 45개(23GB)가 지워지지 않고 쌓였다. 정리는
// `git status --porcelain` 이 한 줄이라도 있으면 "dirty" 로 보고 보존하는데, 실제
// 사유가 작업물이 아니었다:
//   ?? memory/        에이전트가 세션 중 만든 메모리 디렉토리
//    M vendor/happy   서브모듈 gitlink — 브랜치마다 달라 항상 modified
// 리뷰가 정상 종료해도 매번 dirty 라 영영 안 지워졌고, 그 자동화는 worktree 게이트에
// 걸려 다음 이벤트를 처리하지 못했다.
describe('hasUnsavedWorktreeChanges', () => {
  it('treats a clean worktree as removable', () => {
    expect(hasUnsavedWorktreeChanges('')).toBe(false);
    expect(hasUnsavedWorktreeChanges('  \n')).toBe(false);
  });

  it('keeps a worktree that has real source changes', () => {
    expect(hasUnsavedWorktreeChanges(' M src/app.ts\n')).toBe(true);
    expect(hasUnsavedWorktreeChanges('?? tests/pr807ReviewRepro.test.ts\n')).toBe(true);
    expect(hasUnsavedWorktreeChanges('A  src/new.ts\n')).toBe(true);
  });

  // 에이전트가 남기는 산출물은 잃을 작업물이 아니다.
  it('ignores agent scratch output', () => {
    expect(hasUnsavedWorktreeChanges('?? memory/\n')).toBe(false);
    expect(hasUnsavedWorktreeChanges('?? .omc/\n?? memory/notes.md\n')).toBe(false);
    expect(hasUnsavedWorktreeChanges('?? node_modules/\n')).toBe(false);
  });

  // 서브모듈 gitlink 는 브랜치마다 달라 항상 modified 다. 내용 변경이 아니다.
  it('ignores a submodule gitlink difference', () => {
    expect(hasUnsavedWorktreeChanges(' M vendor/happy\n')).toBe(false);
  });

  // 산출물과 진짜 변경이 섞여 있으면 지키는 쪽이 맞다.
  it('keeps the worktree when real changes are mixed with scratch output', () => {
    expect(hasUnsavedWorktreeChanges('?? memory/\n M src/app.ts\n')).toBe(true);
    expect(hasUnsavedWorktreeChanges(' M vendor/happy\n?? tests/repro.test.ts\n')).toBe(true);
  });

  // vendor/happy 안의 실제 변경은 gitlink 와 다르다 — 지켜야 한다.
  it('keeps a change inside the submodule path, not the gitlink itself', () => {
    expect(hasUnsavedWorktreeChanges(' M vendor/happy/src/index.ts\n')).toBe(true);
  });
});
