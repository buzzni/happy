# tasks — cli-offline-handler-transfer

- [x] T0 spec 세트
- [x] T1 stub 등록 기록 + `transferOfflineRegistrations` (R4-a, R4-a2) — 실패 테스트 먼저
- [x] T2 `setupOfflineReconnection` swap 전 이전 (R4-b) — 순서 테스트
- [x] T3 러너 swap 통합 테스트: OpenClaw·ACP(기존 파일 확장), Codex(shutdown 테스트 확장)·Gemini(신규 파일, 기존 러너 테스트 없음) (R4-c, R4-d)
- [x] T3b Gemini 미뤄진 swap 중 메시지: stub `queueInput` (R4-b2) — 구조 분리 커밋 + 동작 커밋
- [x] T4 typecheck·관련 테스트·build
- [x] T5 셀프 리뷰·교차 리뷰 반영 (codex gpt-6.1-sol high: 3건 중 2건 반영)
- [ ] T6 PR·리뷰봇·CI·rebase
