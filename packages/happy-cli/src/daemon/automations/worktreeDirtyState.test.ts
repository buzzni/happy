import { describe, expect, it } from 'vitest';

import { describeUnsavedWorktreeChanges, hasUnsavedWorktreeChanges } from './worktreeDirtyState';

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

// 2026-09-05 프로덕션 — 리뷰 워커가 제출을 끝낸 뒤 `.agenttask-3446-result.json` 을
// worktree 루트에 남겼다. 그 한 줄 때문에 정리가 거부됐고, 자동화가 worktree 게이트에
// 걸려 그 저장소의 리뷰가 통째로 멈췄다(aplus#3447 이 2시간 넘게 대기). 결과는 이미
// 서버에 제출된 뒤라 파일에는 잃을 것이 없다.
describe('에이전트가 남긴 제출 결과 파일', () => {
  it('does not hold a worktree hostage for a scratch result the agent already submitted', () => {
    expect(hasUnsavedWorktreeChanges('?? .agenttask-3446-result.json\n')).toBe(false);
  });

  it('still protects a real untracked file that only looks similar', () => {
    expect(hasUnsavedWorktreeChanges('?? agenttask-notes.md\n')).toBe(true);
    expect(hasUnsavedWorktreeChanges('?? src/.agenttask-3446-result.json\n')).toBe(true);
  });

  it('keeps protecting real work that sits next to the scratch file', () => {
    expect(hasUnsavedWorktreeChanges('?? .agenttask-3446-result.json\n M src/app.ts\n')).toBe(true);
  });
});

// 2026-09-05 — 로그는 "worktree is dirty" 만 말했고, 무엇이 dirty 한지 알아내려면
// 사람이 직접 git status 를 쳐야 했다. 그 사이 리뷰 큐는 멈춰 있었다.
describe('describeUnsavedWorktreeChanges', () => {
  it('names what is actually blocking so nobody has to run git status by hand', () => {
    expect(describeUnsavedWorktreeChanges('?? memory/\n M src/app.ts\n?? notes.md\n'))
      .toEqual(['src/app.ts', 'notes.md']);
  });

  it('is empty when nothing blocks', () => {
    expect(describeUnsavedWorktreeChanges('?? memory/\n')).toEqual([]);
  });

  it('caps the list so one log line cannot become a thousand', () => {
    const many = Array.from({ length: 50 }, (_, i) => `?? file${i}.txt`).join('\n');

    expect(describeUnsavedWorktreeChanges(many)).toHaveLength(10);
  });
});

