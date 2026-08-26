# daemon-handoff-confirm-startup

## 배경

2026-08-25 01:14 (KST), 번들 교체 handoff 후 이 머신에 daemon 이 사라졌고
**약 6시간(01:14 → 07:04 수동 확인 시점)** 동안 돌아오지 않았다.

`daemon.state.json` 은 `state: 'crashed'`, `stateReason: 'Daemon PID not
running'` 이었다. `'stopped'` 가 아니라 `'crashed'` 라는 것은, 그 상태를 쓴 것이
죽은 daemon 자신이 아니라 나중에 pid 를 확인한 다른 CLI 호출이었다는 뜻이다.

### #234 는 여기서 제 몫을 했다

이번 handoff 는 `specs/daemon-handoff-spawn-race` 에서 고친 경로를 그대로 탔고,
그 수정이 **의도대로 동작했다**:

```
[01:14:26.658] [DAEMON RUN] Spawning replacement daemon (attempt 1)
[01:14:26.660] [DAEMON RUN] Replacement daemon started; exiting
```

`'spawn'` 이벤트가 떴으므로 exec 은 성공했다. 2026-08-23 의 실패 모드(자식이
exec 조차 되지 않음)는 재발하지 않았다.

그리고 #234 가 추가한 `daemon-handoff-replacement.log` 가 **이번 원인을 잡아냈다.**
이전이라면 `stdio: 'ignore'` 로 버려졌을 한 줄이다:

```
--- handoff from pid 34036 (attempt 1) at 2026-08-24T16:14:26.659Z ---
Failed to start daemon
```

### 실제로 일어난 일

후임 래퍼(pid 86031)의 로그가 전 과정을 보여준다:

| 시각 | 사건 |
|---|---|
| 01:14:27.139 | `daemon start` 가 `daemon start-sync` 를 detached spawn |
| 01:14:27.142 ~ 01:14:32.146 | 상태 파일을 100ms 간격 50회 폴링, 매번 `Daemon PID not running` |
| 01:14:32 | `Failed to start daemon` → `exit(1)` |

즉 `daemon start` 는 정상 실행됐고, 그것이 띄운 진짜 daemon(`start-sync`)이
5초 안에 뜨지 않았다. `start-sync` 는 **daemon 로그 파일조차 남기지 않았다** —
로거가 서기 전에 죽었다는 뜻이다.

## 결함

### D1. exec 성공을 기동 성공으로 오인한다 (주범)

`spawnDetachedHappyCLI` 는 `'spawn'` 이벤트에 resolve 한다. 그러나 `'spawn'` 은
"OS 가 프로세스를 exec 했다" 만 의미한다. `daemon start` 는 그 뒤 5초 동안
readiness 를 확인하고 **성공/실패를 종료 코드로 이미 보고하고 있는데**, handoff 는
그 답을 기다리지 않고 성공으로 단정한 뒤 구 daemon 을 종료시켰다.

이것은 `specs/daemon-handoff-spawn-race` 의 "알려진 한계" 절에 적어둔 바로 그
지점이다. 그때는 가설이었고 이번에 실제 장애로 확인됐다.

결과적으로 #234 가 넣은 재시도 로직도 **한 번도 발동하지 못했다.** 1차 시도가
성공으로 보고됐기 때문이다.

### D2. `start-sync` 의 출력이 또 버려진다

`start-sync` 가 왜 죽었는지 지금도 알 수 없다. `main.ts` 와
`ensureDaemonRunning.ts` 두 곳 모두 `stdio: 'ignore'` 로 띄우기 때문이다.
#234 가 handoff 경로에서 고친 것과 정확히 같은 결함이 한 단계 아래에 남아 있었고,
그래서 조사가 "5초 안에 안 떴다" 에서 멈춘다.

## 요구사항

- **R1** handoff 는 후임이 **기동을 확인한 뒤에만** 성공으로 친다. 확인 신호는
  `daemon start` 의 종료 코드 0 이다.
- **R2** 종료 코드가 0 이 아니면 실패로 처리해 기존 재시도 경로를 태운다.
  재시도는 안전하다 — `daemon start` 는 이미 떠 있는 daemon 을 감지해 성공을
  보고한다.
- **R3** 타임아웃은 "기동 실패" 가 아니라 "확인 불가" 로 처리한다. 자식을 죽이지
  않는다. 이미 정상 daemon 을 남겼는데 보고만 늦었을 수 있다.
- **R4** `start-sync` 를 띄우는 모든 지점에서 출력을 버리지 않는다
  (`main.ts`, `ensureDaemonRunning.ts`).
- **R5** 캡처 로그에는 어느 호출이 남긴 것인지 구분자를 붙인다.

## 비목표

- **`start-sync` 가 왜 죽었는지 규명하지 않는다.** 증거가 D2 때문에 존재하지
  않는다. R4 가 다음 재발 때 그 증거를 남긴다. 유력한 가설은 번들이 아직
  쓰이는 중이었다는 것이다 — handoff 는 `dist/index.mjs` 의 mtime 변화로
  촉발되는데, 설치는 파일 12개 이상을 순차로 덮으므로 `index.mjs` 가 바뀌었다는
  것이 설치 완료를 뜻하지 않는다. 실제로 08-24 20:08 과 22:50 에 preflight 가
  반쯤 설치된 번들에서 실패한 기록이 있다. 다만 이번 건에 대한 증거는 없다.
- **번들 안정화 대기(디바운스)를 넣지 않는다.** R1+R2 가 들어오면 1차 실패 후
  재시도가 도합 15초 이상에 걸쳐 일어나므로 설치가 끝날 시간이 충분하다.
  preflight 가 반쯤 설치된 번들을 잡는 경우는 이미 안전한 결말(현 daemon 유지)로
  끝난다. 디바운스는 정당한 업그레이드만 늦춘다.
- **5초 readiness 예산은 건드리지 않는다.** 이번 실패가 예산 부족 때문이라는
  증거가 없다. R4 가 근거를 만들어준 뒤에 판단할 문제다.
