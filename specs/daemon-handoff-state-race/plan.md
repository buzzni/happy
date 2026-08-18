# plan

## Phase 1 — 소유권 판정 분리 (구조) — Done

`run.ts` heartbeat 안에 인라인으로 있던 pid 비교를
`src/daemon/daemonStateOwnership.ts` 의 순수 함수
`shouldYieldDaemonStateOwnership()` 로 추출한다.

검증: `daemonStateOwnership.test.ts` 4 케이스 통과, 기존 동작 불변.

## Phase 2 — 죽은 pid 로 자살하지 않는다 (동작) — Done

`shouldYieldDaemonStateOwnership` 이 `isPidAlive` 를 받아, 기록된 pid 가 살아 있는
다른 프로세스일 때만 true 를 돌려준다. `run.ts` 가 이 함수를 쓰도록 교체.

검증: "keeps running when the recorded pid belongs to a process that already died".

## Phase 3 — crashed 마킹을 compare-and-set 으로 (동작) — Done

`persistence.ts` 에 `readDaemonStateSnapshot()` (raw 동반 읽기) 와
`writeDaemonStateIfUnchanged()` 추가. `checkIfDaemonRunningAndCleanupStaleState()`
가 읽은 내용이 그대로일 때만 crashed 마커를 쓴다.

검증: `controlClient.test.ts` 5 케이스, `persistence.test.ts` CAS 3 케이스.
