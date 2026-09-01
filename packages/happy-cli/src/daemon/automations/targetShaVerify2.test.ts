import { describe, expect, it } from 'vitest';

import { reviewWorktreeRequestFromDispatchInput } from './agentTaskReviewObjects';

// 검증용 임시 테스트 (머지 금지). 리뷰 워커가 대상 SHA 에서 테스트를 실제로
// 실행할 수 있는지 확인하기 위한 파일이며, 확인 후 삭제합니다.
describe('대상 SHA 테스트 실행 검증', () => {
  it('dispatch input 에서 worktree 요청을 만든다', () => {
    expect(reviewWorktreeRequestFromDispatchInput({ prNumber: 323, headSha: 'a'.repeat(40) }))
      .toEqual({ pullRequest: { number: 323, expectedHeadSha: 'a'.repeat(40) } });
  });

  it('브랜치 이름 같은 값은 받지 않는다', () => {
    expect(reviewWorktreeRequestFromDispatchInput({ prNumber: 323, headSha: 'main' })).toBeNull();
  });
});
