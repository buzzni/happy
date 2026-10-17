---
기능: automation-unreachable-retry
상태: 진행중 — 구현·관련 테스트·셀프 리뷰 완료, 교차 리뷰 대기 (push 없음)
마지막 갱신: 2026-10-17
---

# Context

- 브랜치 `hermes-automation-unreachable-retry`, worktree `/Users/justin/workspace/happy-wt/hermes-automation-unreachable-retry`
  (base origin/main 921b29282). hermes 오케스트레이션 H2.
- 설계 결정은 spec.md D1~D7. 서버·Desktop 변경 없음.

## 검증 상태
- `vitest run --project unit src/daemon/automations/` 36 files / 570 passed / 8 skipped.
- `tsc --noEmit` 통과.

## 열린 문제·후속 후보
- start 단계 연결 실패(D4): 새 claim 으로 재시도하려면 원래 run 이 "놓친 예약"으로 남는 이력 표시 설계가 필요.
- 커넥터 preflight 실패(CONNECTOR_RUNTIME_UNAVAILABLE·CONFIG_UNAVAILABLE): 원인이 연결성인지 구분하는 신호가 없다.
- 네트워크가 5분 넘게 끊기면 heartbeat 가 실패해 lease 가 끝나고, 다음 재시도의 사전 단계가 서버에서 거절되어
  (연결성 오류가 아니므로) 그때 최종 실패로 기록된다. 재시도 사다리가 짧아질 뿐 중복·누락은 없다.
- 보류 중 run 은 서버에서 RUNNING 으로 보인다. Desktop 이력은 완료된 run 만 그리므로 표시 변화는 없다.

## 다음 시작점
교차 리뷰 지적 반영 → PR → (배포 승인 시) happy-cli 릴리스·Desktop pin.
