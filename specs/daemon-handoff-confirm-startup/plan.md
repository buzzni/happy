# plan — daemon-handoff-confirm-startup

## Phase 1 — 재현 테스트 (Done)
`'spawn'` 은 떴지만 명령이 exit 1 한 경우를 재현. 구현 부재로 실패 확인.

## Phase 2 — startDetachedHappyCLI (Done)
종료 코드 0 으로만 성공 판정. 타임아웃/에러는 실패이되 자식은 죽이지 않는다.
(R1, R2, R3)
- 검증: 18/18 통과

## Phase 3 — 로그 캡처 공용화 (Done)
`captureSpawnOutputStdio` 로 승격. `run.ts` 의 지역 헬퍼를 대체하고
`main.ts`, `ensureDaemonRunning.ts` 가 함께 쓴다. (R4, R5)

## Phase 4 — 호출부 연결 (Done)
handoff 가 `startDetachedHappyCLI` 를 쓰도록 교체.
- 검증: tsc 신규 오류 0

## Phase 5 — 회귀 (Done)
`ensureDaemonRunning.test.ts` 의 부분 mock 이 새 export 를 몰라 깨진 것을 수정.
- 검증: unit 스위트가 origin/main 기준선과 실패 목록까지 동일 (38 failed / 2216 passed)
