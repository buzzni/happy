# daemon-handoff-state-race

## 배경

2026-08-17 12:05 (KST) 글로벌 `@buzzni/happy-cli` 번들이 교체되어 daemon handoff 가
일어난 뒤, 정상 기동한 daemon 이 60초 만에 스스로 종료했다. 아무도 재기동하지 않아
머신이 약 24시간 동안 서버에서 offline 이었다.

실제 로그 타임라인:

| 시각 | 사건 |
|---|---|
| 12:05:21 | 구 daemon(3058947) `Daemon bundle replaced on disk` → handoff 시작 |
| 12:05:24 | 구 daemon 종료, state 파일 제거, `daemon start` 스폰 |
| 12:05:26 / 12:05:29 | `daemon start` 래퍼 2개(2901411, 2901469)가 각각 `ensureDaemonRunning()` 폴링 시작 |
| 12:05:29 | 새 daemon(2901432) 정상 기동 → state 기록 → `wss://saycode.ai` 접속 성공 |
| 12:05:27~34 | 두 폴러가 죽은 pid(3058947)를 약 100회 state 파일에 되씀 |
| 12:05:47 | 세션 프로세스가 `Daemon is not running, file is stale` 반복 시작 |
| 12:06:29 | daemon(2901432) heartbeat 가 남의 pid 를 보고 자살 |
| ~ 08-18 12:04 | daemon 부재. 수동 재기동으로 복구 |

## 결함

1. **죽은 pid 로 자살한다.** `src/daemon/run.ts` heartbeat 는
   `daemonState.pid !== process.pid` 만으로 "다른 daemon 이 떴다" 고 판단한다.
   그 pid 가 살아 있는지 확인하지 않으므로, 낡은 pid 가 파일에 남아 있기만 하면
   멀쩡한 daemon 이 종료된다.

2. **읽기 함수가 쓴다.** `checkIfDaemonRunningAndCleanupStaleState()` 는 pid 가
   죽어 있으면 그 상태를 `crashed` 로 파일에 되쓴다. `ensureDaemonRunning()` 이
   이 함수를 100ms 간격으로 5초간 호출하므로, 그 사이 새 daemon 이 기록한 상태를
   낡은 pid 로 계속 덮어쓴다. 폴러가 스스로 자기 종료 조건을 파괴하는 루프다.

## 요구사항

- R1. heartbeat 는 state 파일의 pid 가 **살아 있는 다른 프로세스**일 때만 자살한다.
      죽은 pid 면 자살하지 않고 자기 상태로 파일을 되찾는다.
- R2. `checkIfDaemonRunningAndCleanupStaleState()` 의 crashed 마킹은, 읽은 뒤
      파일이 그대로일 때만 기록한다. 다른 프로세스가 그 사이 파일을 바꿨으면
      쓰지 않는다.
- R3. 기존 동작 보존: 진짜로 살아 있는 다른 daemon 이 파일을 소유했으면 기존처럼
      자살한다. 죽은 daemon 의 `crashed` 마킹은 세션 복구에 쓰이므로 계속 남긴다.

## 비목표

- 서비스 매니저 도입, handoff 구조 재설계 (run.ts 의 기존 TODO 참고)
- daemon 자살 후 재기동을 담당하는 supervisor 추가
