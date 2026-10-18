---
기능: claude-transient-retry
상태: 진행중 — 2단계: 교차 리뷰 반영, PR 준비
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
- 이어가기 턴은 교훈 회수·리뷰 지시문 없이 나간다(D2). 그 턴의 리뷰 근거(`currentTurnMessages`)는 안내문 텍스트다.
- `--resume` 경로(checkpoint 보호 세션처럼 매 턴 제공자를 다시 띄우는 경우)의 합성 오류 메시지 병합은 실측하지 않았다.
  H9b 실기 확인 때 같이 본다.
- 실패한 시도의 합성 오류 메시지는 transcript 에 그대로 남는다(구 Desktop 에 "API Error" 줄이 보인 뒤 자동 재시도).
  H9b 에서 접어 보일지 결정.

## 교차 리뷰 반영 (2026-10-18, 2단계)
- major: 대기 중 큐가 닫히면(standalone drain) 대기 루프가 마이크로태스크로 무한 회전 → null 이 재시도 wake 때문이
  아니면 루프를 빠져나가 기존 종료 처리로 간다. 런처 경계 재현 테스트.
- 끝난 제공자 세대의 대기가 due 재시도를 가져가 버림 → 세대 종료 표시를 보고 가져가지 않는다. 다음 세대에서 나가는 테스트.
- 대기 취소가 idle 제공자를 죽임 → R5a 계약(abort RPC 가 대기만 지움, 제공자 유지).
- 안내문이 교훈 블록·지시문에 감싸임 → 우회(D2).
- 런처 경계 제외 테스트: 채널·슬래시 명령·run-once.

## 다음 시작점
PR → 리뷰 봇 → CI. 머지는 오케스트레이터.
