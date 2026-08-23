# daemon-handoff-spawn-race

## 배경

2026-08-23 20:09 (KST), 번들 교체 handoff 후 daemon 이 사라졌다. 구 daemon 은 정상
종료(exit 0)했는데 후임이 뜨지 않았고, 아무도 눈치채지 못했다. 수동 복구까지
**1시간 40분** 동안 이 머신에 daemon 이 없었다.

실제 로그 (`~/.happy_remote/logs/2026-08-23-20-00-31-pid-33213-daemon.log`):

```
[20:09:32.155] [DAEMON RUN] Daemon bundle replaced on disk, preflighting new daemon before handoff
[20:09:32.155] [SPAWN HAPPY CLI] Spawning: happy daemon preflight in /Users/justin
[20:09:33.683] [SPAWN HAPPY CLI] Spawning: happy daemon start in /Users/justin
[20:09:33.683] [DAEMON RUN] Process exiting with code: 0
```

spawn 과 exit 이 **같은 밀리초**다. 이후 15분간 로그 디렉터리에 파일이 하나도
생기지 않았다 — 후임의 래퍼 로그조차 없다.

같은 저녁의 성공한 handoff 들과 대조하면:

| handoff | spawn → exit | 후임 |
|---|---|---|
| 19:43:24.650 → .654 | 4ms | 떴음 |
| 19:44:27.684 → .686 | 2ms | 떴음 |
| 20:00:30.890 → .891 | 1ms | 떴음 |
| **20:09:33.683 → .683** | **0ms** | **안 뜸** |

성공 사례에서 후임 래퍼 로그는 spawn 후 약 460ms 에 생긴다. 실패 사례는 그
지점에 도달조차 못 했다.

## 결함

### D1. spawn 반환 즉시 exit — 자식이 exec 되기 전에 부모가 죽는다

`daemon/run.ts` 의 handoff 는 `spawnHappyCLI(...)` 를 fire-and-forget 으로 호출하고,
`handoffToReplacedBundle` 은 그 호출이 반환하는 순간 `'handed-off'` 를 돌려준다.
호출부는 곧바로 `process.exit(0)` 한다.

`child_process.spawn` 은 비동기다. 핸들은 즉시 반환되지만 실제 fork/exec 은 libuv 가
이후 틱에 수행한다. `process.exit()` 은 그걸 기다리지 않는다. 반환된 `ChildProcess` 는
버려지고 `'spawn'` 이벤트도 기다리지 않으며, `detached: true` 인데 `unref()` 도 없다.

### D2. `stdio: 'ignore'` 가 증거를 없앤다

후임이 자기 로그 파일을 열기 전에 죽으면 그 이유를 알 방법이 구조적으로 없다.
같은 파일의 `preflightInstalledHappyCLI` 는 최소한 `exit` 이벤트와 종료 코드를
읽는데, 정작 진짜 기동 경로는 아무것도 보지 않는다.

### D3. handoff 후 생존 확인이 없다

`handoffToReplacedBundle` 은 후임이 떴는지 확인하지 않고 반환하고 구 daemon 은
죽는다. 후임이 안 뜨면 감지도 재시도도 없다. preflight 는 "새 번들이 일회성
control server 를 띄울 수 있다" 만 증명하지, 실제 기동 성공을 보장하지 않는다.

### D4. 로그 메시지가 사실과 다르다

`cleanupDaemonState()` 는 `"Daemon state file removed"` 를 찍지만
`clearDaemonState()` 는 파일을 지우지 않는다 — `{...current, state: 'stopped'}` 로
되쓰고 lock 파일만 unlink 한다. 이 조사에서 상태 파일에 남은 구 pid 를 보고
"누가 되썼는가" 를 한참 찾게 만들었다. 실제로는 구 daemon 자신의 teardown 이다.

## 요구사항

- **R1** 후임 spawn 은 자식이 실제로 시작됐음을 확인한 뒤에만 성공으로 친다.
  확인 신호는 `'spawn'` 이벤트이며, `'error'` 와 타임아웃은 실패다.
- **R2** 성공 시 `unref()` 해서 detached 후임이 부모보다 오래 산다.
- **R3** 후임의 stdio 는 버리지 않고 파일로 남긴다. 로그 파일을 못 열면 handoff 를
  막지 말고 `'ignore'` 로 물러난다.
- **R4** spawn 이 실패하면 재시도한다. teardown 이 이미 소켓·control server·상태
  파일·lock 을 놓은 뒤라 되돌릴 수 없고, 재시도가 유일한 복구 수단이다.
- **R5** 모든 재시도가 실패하면 조용히 끝내지 않는다. 이 프로세스는 더 이상
  daemon 이 아니므로 명확히 로그를 남기고 비정상 종료 코드로 끝낸다.
- **R6** D4 의 로그 문구를 실제 동작에 맞춘다.

## 비목표

- **teardown 순서를 바꾸지 않는다.** "spawn 먼저, 확인 후 teardown" 이 더
  안전해 보이지만, 후임이 살아 있는 구 daemon 의 상태 파일을 읽고
  `isDaemonRunningCurrentlyInstalledHappyVersion() === true` 로 판단해
  `already-running` 으로 빠진다. `run.ts` 의 teardown 주석이 경고하는 바로 그
  함정이다. 두 daemon 간 조정이 필요한 별도 설계 과제다.
- **`clearDaemonState` 가 상태 파일을 남기는 동작 자체는 그대로 둔다.** 추적
  세션 기록이 후임의 복구 근거다. 고치는 것은 문구뿐이다.
- 번들 교체 빈도(이 저녁 95분간 6회) 자체는 다루지 않는다.

## 알려진 한계

D1 이 이번 실패의 원인이라는 것은 **정황 증거**다. spawn→exit 간격과 후임 흔적
부재가 일관되지만, 1ms 도 성공한 사례가 있어 간격만으로 확정할 수 없다. 그리고
`stdio: 'ignore'` 때문에 자식 쪽 증거는 애초에 남지 않는다(D2). 다만 D1~D3 는
어느 것이 방아쇠였든 각각 독립적으로 실재하는 결함이다.
