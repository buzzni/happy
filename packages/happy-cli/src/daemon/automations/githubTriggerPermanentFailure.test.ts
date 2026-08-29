import { describe, expect, it } from 'vitest';

import { isPermanentGithubTriggerFailure } from './githubTriggerPermanentFailure';

// 2026-08-29 프로덕션 — automation cmt9b2cdh 가 매분 재시도했다.
//   GitHub pull request checkout failed:
//   fatal: couldn't find remote ref refs/heads/release/happy-cli-1.1.10-aplus.154
// 그 브랜치는 PR 머지 후 삭제된 것이었다. worktree 준비가 실패하면 outcome:'ERROR'
// 로 돌아가는데, 그 경로는 persistGithubTriggerState 에 도달하지 않아 이벤트가
// 소비되지 않는다. 삭제된 브랜치는 몇 번을 다시 checkout 해도 없다.
describe('isPermanentGithubTriggerFailure', () => {
  it('treats a missing remote ref as permanent', () => {
    expect(isPermanentGithubTriggerFailure(
      "GitHub pull request checkout failed: fatal: couldn't find remote ref refs/heads/release/happy-cli-1.1.10-aplus.154",
    )).toBe(true);
  });

  it('treats a deleted or unknown pull request as permanent', () => {
    expect(isPermanentGithubTriggerFailure(
      'GitHub pull request checkout failed: no pull requests found for branch',
    )).toBe(true);
    expect(isPermanentGithubTriggerFailure(
      'GitHub pull request checkout failed: Could not resolve to a PullRequest with the number of 999.',
    )).toBe(true);
  });

  it('keeps a network failure transient', () => {
    // 네트워크는 복구된다 — 영구로 접으면 멀쩡한 PR 의 리뷰를 통째로 버린다.
    expect(isPermanentGithubTriggerFailure(
      'GitHub pull request checkout failed: fatal: unable to access https://github.com/...: Could not resolve host: github.com',
    )).toBe(false);
  });

  it('keeps an auth failure transient — a token can be refreshed', () => {
    expect(isPermanentGithubTriggerFailure(
      'GitHub pull request checkout failed: HTTP 401: Bad credentials',
    )).toBe(false);
  });

  it('keeps a rate limit transient', () => {
    expect(isPermanentGithubTriggerFailure(
      'GitHub pull request checkout failed: HTTP 429: API rate limit exceeded',
    )).toBe(false);
  });

  it('defaults to transient for an unrecognised failure', () => {
    // 모르는 실패를 영구로 접으면 조용히 이벤트를 버리게 된다. 모르면 재시도한다.
    expect(isPermanentGithubTriggerFailure('GitHub worktree creation failed: disk full')).toBe(false);
  });
});
