# plan — daemon-handoff-spawn-race

## Phase 1 — 재현 테스트 (Done)
`spawnDetachedHappyCLI` 가 `'spawn'` 이벤트 전에는 resolve 하지 않음을 검증하는
테스트 작성. 구현 부재로 실패 확인.
- 검증: 9건 실패

## Phase 2 — spawn 확인 유틸 (Done)
`spawnDetachedHappyCLI` 구현 — `'spawn'` 대기, `'error'`/타임아웃 실패 처리,
`unref()`, 동기 throw 흡수. (R1, R2)
- 검증: 21/21 통과

## Phase 3 — 재시도와 실패 보고 (Done)
`handoffToReplacedBundle` 에 `spawnAttempts` 추가, `'replacement-not-started'`
반환값 신설. 던지는 시도도 실패로 간주하고 다음 시도로 넘어간다. (R4)
- 검증: 재시도/소진/throw 3케이스 통과

## Phase 4 — 호출부 연결 (Done)
`run.ts` 가 새 유틸을 쓰도록 교체. 후임 stdio 를
`daemon-handoff-replacement.log` 로 리다이렉트, 실패 시 `exit(1)`. (R3, R5)
- 검증: tsc 신규 오류 0

## Phase 5 — 로그 문구 정정 + 회귀 (Done)
`cleanupDaemonState` 문구 수정. (R6)
- 검증: unit 스위트가 origin/main 기준선과 실패 목록까지 동일 (22 failed / 2148 passed)
