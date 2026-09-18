# 머신 소켓 중복 등록 (machine socket duplicate registration)

## 배경

2026-09-17~18, 한 머신(`3c78fd5e-…`)에서 세 가지 증상이 함께 보고됐다.

- 새 대화가 만들어지지 않는다.
- worktree 로 새 대화를 만들면 `Worktree 기준 branch를 확인하지 못했습니다.
  operation has timed out` 이 뜬다.
- 원격 터미널이 열리기는 하는데 입력이 먹지 않는다.

데몬 로그(`~/.happy_remote/logs/2026-09-17-10-56-17-pid-6097-daemon.log`)에서
셋의 공통 뿌리가 나왔다.

```
06:35:24.946  Disconnected from server — reason: transport close
06:35:28 ~ 06:36:16   Attempting reconnect  × 22 (정확히 3초 간격)
06:36:17.881  Connected to server          ← ①
06:36:17.895  Connected to server          ← ②   (14ms 뒤)
06:36:17.955  Disconnected — transport close
06:36:34.746  Connected to server          ← ③
06:36:34.773  Connected to server          ← ④
06:36:34.788  Connected to server          ← ⑤   (42ms 안에 3개)
06:36:35.319  [BACKOFF] retry 2: Daemon state version mismatch  × 8연속
```

`Keep-alive started → stopped → started` 가 번갈아 찍히고 곧바로 state version
mismatch 가 폭주한다. **하나의 데몬이 짧은 시간에 여러 소켓 연결을 성립시켰다.**

원인은 재연결 cadence 였다. `apiMachine.startSmartReconnect()` 는 직전 dial 의
성패와 **무관하게** 3초마다 `socket.connect()` 를 다시 불렀고(별도의 1초 one-shot
까지 있었다), 핸드셰이크가 느린 구간 — 슬립/웨이크, VPN 전환, 막 올라오는 서버 —
에서는 여러 dial 이 겹쳐 그중 여럿이 성립했다. 클라이언트는 Socket 객체를 하나만
들고 있으므로 **이 사실을 관측하지 못한다.** `apiSession` 에도 같은 코드가 있었다.

서버는 이것을 정리하지 않았다. `eventRouter.addConnection()` 은 새 머신 소켓을
room 에 `join` 만 하고 같은 `machineId` 의 이전 소켓을 끊지 않는다. 좀비는
engine.io 가 포기할 때까지(`pingInterval 15s + pingTimeout 45s`, 최대 60초) room
에 남는다 — 이미 `findMachineSockets.ts` 주석이 지적하던 사실이다.

그 60초 동안 `newestMachineSocket()` 이 좀비를 고르면 그리로 간 일은 **영원히
응답되지 않는다.** 호출자는 ack 타임아웃까지 기다릴 뿐이다
(`sessionCreation.ts` `DEFAULT_RPC_ACK_TIMEOUT_MS = 45_000`), 그리고 그 45초가
socket.io 문자열 그대로 `operation has timed out` 으로 UI 에 올라온다. 데스크톱은
worktree 기준 branch 조회 실패를 fail-closed 로 다루므로(App.tsx) 전송 자체가 막힌다.

데몬이 느려서가 아니다. 같은 로그에서 shell 실행 지연은 p50 0.14s / p99 5.73s /
최대 11.11s, 30초를 넘긴 건이 **0건**이다. `git worktree list --porcelain` 도 60KB
출력을 414ms 에 끝낸다. 타임아웃은 순수하게 전송 경로의 문제였다.

터미널은 한 겹 더 있었다. 릴레이는 세션을 열 때 `clientSocketId` /
`daemonSocketId` 를 **박제**하고 이후 모든 프레임을 그 id 로만 보낸다. 그런데
데스크톱 터미널 소켓은 `reconnection` 을 **켜고** 연다("blip 에 패널이 죽지 않도록",
specs/desktop-terminal-reliability). socket.io 재연결은 새 socket id 를 뜻하므로
재연결 순간 양방향이 동시에 끊긴다 — 입력은 죽은 id 로 emit 되어 조용히 사라지고
(`io.to(deadId).emit()` 은 no-op), 출력은 새 id 에서 올라와 짝의 어느 쪽과도
일치하지 않아 버려진다. 클라이언트가 말할 줄 아는 `terminal-resume` 은 서버에
핸들러가 없고 `caps` 도 내려주지 않아 죽은 코드였다.

감사 로그가 이 모양 그대로다. 정상 세션은 `bytesIn=662 bytesOut=270587` 인데,
문제 구간 다섯 세션은 전부 **`bytesIn=0`** 에 `bytesOut` 은 프롬프트 한 덩어리다.

```
07:16:26 open → 07:31:26 close   bytesIn=0  bytesOut=526
07:17:52 open → 07:32:52 close   bytesIn=0  bytesOut=526
07:20:21 open → 07:35:21 close   bytesIn=0  bytesOut=526
```

## 불변식

> 한 머신에는 하나의 데몬이 있고, 따라서 서버에는 그 머신의 **살아 있는 소켓이
> 하나만** 있어야 한다.

> 세션의 socket id 는 **경로이지 신원이 아니다.** 양 끝은 같은 터미널을 유지한 채
> 정당하게 socket id 를 바꿀 수 있고, 릴레이는 그 변화를 따라가야 한다.

## 인수 조건

- **AC1** 응답을 기다리는 dial 이 있는 동안 새 dial 을 쌓지 않는다.
- **AC2** `connect` 도 `connect_error` 도 오지 않는 dial 이 cadence 를 영구히
  막지 못한다 (`RECONNECT_DIAL_TIMEOUT_MS` 로 만료된다). specs/daemon-socket-watchdog
  이 막으려던 결함 클래스를 새로 만들지 않는다.
- **AC3** 첫 재시도는 여전히 1초 근처다 — 흔한 blip 의 회복 속도를 늦추지 않는다.
  이후 지수 백오프, 상한 30초, 지터 포함.
- **AC4** 머신 소켓이 새로 붙으면 같은 `(userId, machineId)` 의 더 오래된 소켓이
  끊긴다. 동률(같은 ms, 또는 둘 다 미기록)은 socket id 로 결정론적으로 깨서
  **두 소켓이 서로를 끊어 데몬이 무소켓이 되는 일이 없다.**
- **AC5** cluster lookup 이 degraded 라 목록이 불완전해도 "여기 있는 게 전부 stale"
  로 읽지 않는다.
- **AC6** 터미널 프레임의 방향은 박제된 id 가 아니라 **소켓의 신원**으로 정한다 —
  데몬 쪽은 그 세션 머신의 machine-scoped 소켓, 클라이언트 쪽은 그 세션 소유자로
  인증된 소켓. 다른 사용자의 소켓은 여전히 어느 쪽도 아니다.
- **AC7** id 가 바뀌면 세션 레코드가 따라간다(역인덱스 포함).
- **AC8** 클라이언트 소켓의 disconnect 는 곧바로 close 가 아니다. PTY 는 계속
  돌고 있고 소켓은 설계상 재연결하므로, 유예 시간 안에 돌아오면 터미널을 되찾는다.
- **AC9** 교체되어 뒤늦게 죽는 소켓의 disconnect 가 자신을 대체한 살아 있는
  터미널을 무너뜨리지 못한다.
- **AC10** 데몬 소켓의 disconnect 는 그대로 즉시 close 다 — 데몬은 자기 소켓이
  끊길 때 로컬 PTY 를 모두 죽이므로(specs/remote-terminal/ Phase 2) 그 시점에
  shell 은 이미 없다.

## 구현

| 위치 | 역할 |
|---|---|
| `happy-cli/src/api/reconnectCadence.ts` | 공유 백오프 상수와 `reconnectDelayMs()` |
| `happy-cli/src/api/apiMachine.ts` | single-flight dial 가드, 백오프 cadence, `stopSmartReconnect()` |
| `happy-cli/src/api/apiSession.ts` | 같은 cadence (세션 소켓도 같은 결함이었다) |
| `happy-server/.../findMachineSockets.ts` | `supersededMachineSockets()`, `evictSupersededMachineSockets()` |
| `happy-server/.../api/socket.ts` | 머신 소켓 연결 시 축출을 fire-and-forget |
| `happy-server/.../terminalSessions.ts` | `rebindTerminalSessionSocket()` |
| `happy-server/.../terminalRelayHandler.ts` | 신원 기반 방향 판정, rebind, 클라이언트 재접속 유예 |

### 계약 변경

터미널 프레임의 클라이언트 쪽 판정이 "이 socket id 인가"에서 "이 세션 소유자로
인증된 소켓인가"로 바뀐다. 두 규칙의 신뢰 경계는 같다 — 어느 쪽이든 sessionId
(UUIDv4, 개설자에게만 반환된다)를 아는 것이 자격이고, 다른 사용자는 인증된
handshake 에서 걸러진다. 바뀌는 것은 **같은 사용자의 재연결이 자기 터미널을
되찾을 수 있다**는 점이다. `shouldDropFramesFromASocketOutsideTheSessionPair`
테스트는 실제로 지키던 경계(다른 사용자)를 명시하도록 고쳐 썼다.

## 상태

| | 상태 |
|---|---|
| AC1~AC3 (재연결 cadence) | 완료 — `apiMachine` / `apiSession` |
| AC4~AC5 (머신 소켓 축출) | 완료 — `findMachineSockets` / `socket.ts` |
| AC6~AC10 (터미널 릴레이) | 완료 — `terminalRelayHandler` / `terminalSessions` |

검증: happy-server 1,419 passed, happy-cli 7,024 passed, 양쪽 typecheck 통과.
신규 테스트는 축출 tie-break 7건, 백오프 7건, 릴레이 rebind/유예 6건.

**실사용 관측은 아직 못 했다.** 원인이 네트워크 플랩·슬립/웨이크 타이밍에 걸려
있어 단위 테스트로는 재현의 형태만 고정할 수 있다. 배포 뒤
`~/.happy_remote/logs/` 에서 세 가지를 확인할 것:

1. 같은 초 안의 `Connected to server` 연속 로그가 사라졌는가.
2. `[REMOTE-TERMINAL] close` 의 `bytesIn=0` 세션이 사라졌는가.
3. `operation has timed out` 재발 빈도.

### 짝이 되는 클라이언트 작업

데스크톱 쪽 두 건은 별도 저장소(`buzzni/aplus-dev-studio-desktop`)의
`specs/machine-rpc-timeout-recovery/` 에 있다 — 타임아웃 난 RPC 소켓을 풀에서
버리는 것과, branch 목록 조회 실패가 새 대화 전송을 막지 않게 하는 것. 이 스펙이
"실패를 만들지 않는 쪽", 저쪽이 "실패를 겪은 뒤 회복하는 쪽"이다.

## 다음에 할 일

우선순위 순.

1. **관측** (위 세 가지). 특히 터미널 세션이 정확히 900.0초에 닫히던 패턴 — 세 번
   연속 정확히 같은 값이었는데 로그만으로는 원인을 못 찾았다. 데몬의
   `killAllDaemonTerminalSessions` 도 `terminate session=` 도 찍히지 않았고 `TMOUT`
   도 어디에도 없다(확인함). rebind 로 함께 사라지는지 먼저 본다.
2. **`terminal-resume` 서버 구현.** 클라이언트는 이미 `seq` dedup, gap 감지,
   `resume(afterSeq)`, snapshot 처리를 갖추고 `caps` 를 기다리고 있는데
   (desktop `specs/desktop-terminal-reliability/` Phase 3) 서버가 안 내려줘 계속
   legacy 로 돈다. 이번 rebind 는 그 아래 단계만 깔았으므로, 재접속 구간에 데몬이
   뱉은 출력은 여전히 유실된다.
3. **폴링 부하 (P2).** 같은 21시간 로그에서 bash RPC 약 64,000건,
   `git fetch --unshallow --filter=blob:none` 7,945건, 폴링 대상 worktree 444개가
   관측됐다(디스크에는 aplus-dev-studio 1,030 / -desktop 342 / happy 197 디렉터리).
   실재하는 문제지만 원인도 작업도 별개이고, 고칠 코드는 대부분 데스크톱 쪽이다.
4. **세션 스코프 소켓 축출.** cadence 는 고쳤지만 서버 측 축출은 machine-scoped
   에만 넣었다. 세션 라우팅은 room 브로드캐스트라 같은 방식으로 조용히 유실되지는
   않으므로 급하지 않다.

## 이 스펙이 다루지 **않는** 것

- **재접속 구간에 흘러간 출력.** rebind 는 클라이언트의 첫 프레임에서 일어나므로,
  소켓이 떠 있던 사이 데몬이 뱉은 출력은 여전히 유실된다. 클라이언트가 이미
  말할 줄 아는 `terminal-resume`(seq + snapshot)을 서버에 구현하는 것이 후속 작업이다.
- **유예 타이머의 replica 지역성.** 클라이언트 소켓을 들고 있던 replica 가 창
  중간에 죽으면 세션 레코드는 스토어의 12시간 TTL 에 맡겨진다. 교차 replica
  타이머를 만들 만큼의 값은 아직 없다.
- **세션 스코프 소켓의 중복 등록 축출.** cadence 는 고쳤지만 서버 측 축출은
  machine-scoped 에만 넣었다. 세션 라우팅은 room 브로드캐스트라 같은 방식으로
  조용히 유실되지 않는다.
- **폴링 부하.** 같은 21시간 로그에서 bash RPC 약 64,000건, `git fetch --unshallow`
  7,945건, 폴링 대상 worktree 444개가 관측됐다. 실재하는 문제지만 별개의 원인이고
  별개의 작업이다.
