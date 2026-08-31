import { describe, expect, it, vi } from 'vitest';

import { ensureAgentTaskReviewObjects, reviewShasFromDispatchInput } from './agentTaskReviewObjects';

// 2026-08-31 프로덕션 — hsmoa_backend AgentTask 리뷰가 이렇게 보고했다:
//   "전달된 baseSha/headSha Git 객체가 워크스페이스에 없어 소스 SHA 기반 테스트와
//    호출부 검증을 실행하지 못했습니다."
// 프로젝트 워크스페이스가 `+refs/heads/develop:...` 단일 refspec 의 shallow clone 이라
// PR 커밋이 존재하지 않았다. preset 은 "별도 PR checkout 이나 GitHub 조회로 context 를
// 다시 만들지 않는다" 이므로 워커가 스스로 fetch 할 수도 없다 — 즉 워커 잘못이 아니라
// 환경이 preset 이 요구하는 "호출부 문맥 확인"을 불가능하게 만들고 있었다.
describe('reviewShasFromDispatchInput', () => {
  it('reads both shas from a pr_review dispatch input', () => {
    expect(reviewShasFromDispatchInput({
      baseSha: 'd8a92208d3ff79fc38d57c90a4d39a683c4772d3',
      headSha: 'ef054977720ce178258498f432810d7a1459ee5e',
      prNumber: 21031,
    })).toEqual([
      'd8a92208d3ff79fc38d57c90a4d39a683c4772d3',
      'ef054977720ce178258498f432810d7a1459ee5e',
    ]);
  });

  it('ignores inputs without usable shas rather than guessing', () => {
    expect(reviewShasFromDispatchInput(null)).toEqual([]);
    expect(reviewShasFromDispatchInput({ prNumber: 1 })).toEqual([]);
    // 셸에 넘길 값이므로 40~64 hex 가 아니면 받지 않는다.
    expect(reviewShasFromDispatchInput({ baseSha: 'HEAD; rm -rf /', headSha: 'main' })).toEqual([]);
  });

  it('drops a duplicate when base and head are the same commit', () => {
    const sha = 'a'.repeat(40);
    expect(reviewShasFromDispatchInput({ baseSha: sha, headSha: sha })).toEqual([sha]);
  });
});

describe('ensureAgentTaskReviewObjects', () => {
  const base = 'd8a92208d3ff79fc38d57c90a4d39a683c4772d3';
  const head = 'ef054977720ce178258498f432810d7a1459ee5e';

  it('fetches the review commits into the workspace when they are missing', async () => {
    // 얕은 clone 의 실제 모습: cat-file 이 실패(객체 없음)하고 fetch 는 성공한다.
    const runCommand = vi.fn(async (command: { args: string[] }) => (
      command.args[0] === 'cat-file'
        ? { ok: false as const, error: 'Not a valid object name' }
        : { ok: true as const, stdout: '' }
    ));
    const result = await ensureAgentTaskReviewObjects({
      directory: '/repo', shas: [base, head], runCommand,
    });

    expect(result).toEqual({ ok: true, fetched: [base, head] });
    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({
      executable: 'git',
      // `--no-write-fetch-head` 를 넣으면 안 된다 — git 2.29+ 전용이고 프로덕션은
      // 2.25.1 이라 usage 만 출력한 뒤 exit 0 이 되어, 객체 없이 성공으로 보인다.
      args: ['fetch', '--no-tags', 'origin', base, head],
      cwd: '/repo',
    }));
  });

  it('skips the network when both commits are already present', async () => {
    const runCommand = vi.fn(async () => ({ ok: true as const, stdout: '' }));
    await ensureAgentTaskReviewObjects({
      directory: '/repo', shas: [base, head], runCommand, has: async () => true,
    });

    expect(runCommand).not.toHaveBeenCalled();
  });

  it('reports why the fetch failed instead of failing silently', async () => {
    // 객체가 없어도 리뷰 자체는 diff artifact 로 가능하다. 그래서 여기서 멈추지는
    // 않지만, 왜 문맥이 없는지는 반드시 드러나야 한다 — 조용히 넘어가면 리뷰 품질이
    // 낮아진 이유를 아무도 모른다 (AGENTS.md §1.13).
    const runCommand = vi.fn(async () => ({ ok: false as const, error: 'no such remote origin' }));
    // cat-file 도 fetch 도 실패한다 — 객체가 없고 가져오지도 못한 상태.
    const result = await ensureAgentTaskReviewObjects({
      directory: '/repo', shas: [base, head], runCommand,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('no such remote origin');
  });

  it('does nothing when there is no sha to fetch', async () => {
    const runCommand = vi.fn(async () => ({ ok: true as const, stdout: '' }));
    const result = await ensureAgentTaskReviewObjects({ directory: '/repo', shas: [], runCommand });

    expect(result).toEqual({ ok: true, fetched: [] });
    expect(runCommand).not.toHaveBeenCalled();
  });
});
