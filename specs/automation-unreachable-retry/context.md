---
기능: automation-unreachable-retry
상태: 진행중 — 교차 리뷰 반영·사용자 결정(lease 안 재시도) 반영 완료, PR 단계
마지막 갱신: 2026-10-17
---

# Context

- 브랜치 `hermes-automation-unreachable-retry`, worktree `/Users/justin/workspace/happy-wt/hermes-automation-unreachable-retry`
  (base origin/main 921b29282). hermes 오케스트레이션 H2.
- 설계 결정은 spec.md D1~D10. 서버·Desktop 변경 없음.
- 2026-10-17 사용자 결정: 서버 lease 계약을 바꾸지 않고 재시도를 lease 안(약 1·2·4분)으로 축소(R2).
  원 요구 5·15·30분은 5분 넘는 단절에서 성립하지 않는다(교차 리뷰 #1).

## 검증 상태
- `vitest run --project unit src/daemon/automations/` 36 files / 580 passed / 8 skipped (2단계).
- `tsc --noEmit` 통과.

## 열린 문제·후속 후보
- start 단계 연결 실패(D4): 새 claim 으로 재시도하려면 원래 run 이 "놓친 예약"으로 남는 이력 표시 설계가 필요.
- 커넥터 preflight 실패(CONNECTOR_RUNTIME_UNAVAILABLE·CONFIG_UNAVAILABLE): 원인이 연결성인지 구분하는 신호가 없다.
- 재시도 끝에 성공한 run 은 이력에 재시도 표시가 없다(D5) — 서버 스키마에 재시도 횟수 필드를 두는 것이 후속 후보.
- lease 를 넘는 긴 단절(약 4분 이상)은 재시도로 복구하지 않는다(사용자 결정). 다음 정규 회차에 맡긴다.
- 보류 중 run 은 서버에서 RUNNING 으로 보인다. Desktop 이력은 완료된 run 만 그리므로 표시 변화는 없다.

## 다음 시작점
PR 리뷰·CI → (배포 승인 시) happy-cli 릴리스·Desktop pin → 실기기 확인.
