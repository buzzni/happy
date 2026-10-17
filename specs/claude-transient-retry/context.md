---
기능: claude-transient-retry
상태: 진행중 — 1단계 구현·검증 완료, 교차 리뷰 대기
마지막 갱신: 2026-10-18
---

# Context

- 브랜치 `hermes-claude-transient-retry`, worktree `/Users/justin/workspace/happy-wt/hermes-claude-transient-retry`
  (base origin/main 17d63765d). hermes 오케스트레이션 H9a. Desktop 표시는 H9b.
- 설계 결정은 spec.md D1~D7. 서버·Desktop 변경 없음.

## 검증 상태 (2026-10-18, 1단계)
- `vitest run --project unit src/claude/claudeRemote src/claude/claudeTransientRetry src/usage src/claude/claudeStandaloneDrain src/claude/setupTokenAccountSwitching`
  14 files / 196 passed. 새 테스트: 분류·간격·취소 19건, 런처 경계 5건(배선을 되돌리면 이어가기·사용자 메시지 대체·중단 3건이 실패).
- `./node_modules/.bin/tsc --noEmit` 통과.
- 실제 CLI(SDK 0.3.285 번들) 왕복: 503 으로 CLI 재시도 소진(usage 0) → 같은 대화에 안내문 → 두 번째 요청의 user 메시지가
  `hello there | (Automatic retry…)` 하나로 합쳐져 정상 답(usage 12/4). 런처 전체를 실제 CLI 로 돌린 검증은 아니다
  (런처 경계는 SDK query 를 흉내 낸 테스트).

## 열린 문제·후속 후보
- run-once 자동화·관리 실행 턴의 일시 장애 재시도(D6).
- 대기 중 백그라운드 작업 보고로 제공자가 스스로 턴을 시작해 끝나면 그 턴 경계에서 대기 중 재시도가 지워진다
  (세션이 다른 일로 넘어간 것으로 본다). 드문 경우라 그대로 둔다.
- 이어가기 턴의 교훈 회수·리뷰 근거는 안내문 텍스트다(원래 요청은 실패한 턴에 있다). 교훈 품질에 미치는 영향은 작다.
- 실패한 시도의 합성 오류 메시지는 transcript 에 그대로 남는다(구 Desktop 에 "API Error" 줄이 보인 뒤 자동 재시도).
  H9b 에서 접어 보일지 결정.

## 다음 시작점
교차 리뷰 → PR.
