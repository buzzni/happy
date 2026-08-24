# daemon-rpc-ack-guard

## 배경

2026-08-23 04:45 (KST) 서버 도달 불가로 daemon 소켓이 37초 끊겼다가 재연결된 직후,
daemon(pid 17681)이 1초 만에 스스로 종료했다. 직전까지 14시간 반 동안 무중단으로
돌던 daemon 이다. 실행 중이던 세션 21개가 daemon 을 잃었고, 이후 세션들은
`[CONTROL CLIENT] Daemon is not running, file is stale` 를 3초마다 반복했다.

실제 로그 타임라인 (`~/.happy_remote/logs/2026-08-22-14-05-24-pid-17681-daemon.log`):

| 시각 | 사건 |
|---|---|
| 08-22 14:05:24 | daemon 기동. 이후 14시간 30분 무중단, disconnect 0회 |
| 04:44:25 | `session-idle-reaper` → `ECONNREFUSED 54.116.239.230:443, 3.35.154.44:443` |
| 04:44:56 | `Disconnected from server — reason: transport close` |
| 04:44:59~04:45:32 | 재연결 12회 시도, 중간에 `Connection error: timeout` (37초 단절) |
| 04:45:33.183 | 재연결 성공 |
| 04:45:33.459 | 밀려 있던 RPC 폭주 유입 — 1초간 `bash` 633, `automation-list` 50, `read-opencode-models` 14, `readFile` 7, `writeFile` 2, `spawn-happy-session` 1, `resume-happy-session` 1 |
| 04:45:33.460 | 첫 `FATAL: Unhandled promise rejection TypeError: callback is not a function` |
| 04:45:34.375 | `Process exiting with code: 0`. 그 1초 사이 동일 에러 **2293회** |

`daemon.state.json` 에 원인이 그대로 기록됐다:

```json
"state": "stopped",
"stateReason": "Shutdown by exception: callback is not a function"
```

## 결함

`src/api/apiMachine.ts` 와 `src/api/apiSession.ts` 의 `rpc-request` 리스너가 동일하게
무방비였다:

```ts
this.socket.on('rpc-request', async (data, callback) => {
    logger.debugLargeJson(`[API MACHINE] Received RPC request:`, data);
    callback(await this.rpcHandlerManager.handleRequest(data));   // ← 크래시 지점
});
```

로그상 매 FATAL 직전에 `Handler returned { hasResult: true }` 와
`Sending encrypted response` 가 정상적으로 찍힌다. 즉 핸들러는 성공했고, 결과를
돌려주는 `callback(...)` 호출 자체가 터졌다 — 재연결 직후 유입된 패킷 일부에
ack callback 이 실려 오지 않았다.

결함이 세 겹으로 쌓여 하나의 요청 오류를 머신 전체 장애로 증폭시켰다:

1. **`callback` 이 함수인지 확인하지 않는다.** ack 없는 패킷이 오면 즉시 `TypeError`.

2. **async 리스너에 `try/catch` 가 없다.** socket.io 는 리스너의 반환 promise 를
   await 하지 않으므로, 이 `TypeError` 는 unhandled rejection 으로 새어나간다.

3. **daemon 의 `unhandledRejection` 정책이 프로세스 전체 종료다.**
   `src/daemon/run.ts` 가 모든 unhandled rejection 을 `requestShutdown('exception')`
   으로 처리한다. 요청 1건의 오류가 daemon 전체를 죽인다.

타입 선언도 실제 계약과 어긋나 있었다. `apiMachine.ts` 의 `ServerToDaemonEvents` 와
`api/types.ts` 의 `ServerToClientEvents` 가 `callback` 을 필수로 선언해,
무방비 호출을 타입상 안전해 보이게 만들었다.

### 범위 밖 — ack 가 왜 누락됐는가

happy-server 의 유일한 발신 경로(`rpcHandler.ts:230`)는 `emitWithAck` 를 쓰므로
정상 경로에서는 ack 가 항상 붙는다. 재연결 직후 어댑터 재전달 과정에서 ack id 가
유실된 것으로 보이나, 클라이언트 로그만으로는 단정할 수 없고 서버측
`rpcHandler` 로그가 필요하다. **이 spec 은 그 원인을 다루지 않는다.**

근거: 네트워크 단절은 방아쇠일 뿐이다. ack 누락 원인이 무엇이든, 위 3개 결함이
없었다면 daemon 은 살아남았어야 한다. 클라이언트는 서버가 ack 를 보내주리라는
가정 위에 생존을 걸어서는 안 된다.

## 요구사항

- **R1** `rpc-request` 리스너는 어떤 경우에도 rejection 을 밖으로 내보내지 않는다.
- **R2** `callback` 이 함수가 아니면 응답 전달만 건너뛰고, 그 사실을 로그로 남긴다.
- **R3** ack 가 없어도 핸들러는 실행한다. `bash` / `writeFile` /
  `spawn-happy-session` 등은 부수효과가 있는 메서드이고, ack 유실은 호출자가
  요청을 철회했다는 증거가 아니다. 건너뛰는 것은 이미 전달 불가능했던 응답뿐이다.
- **R4** machine 과 session 두 클라이언트에 동일하게 적용한다. 같은 소켓 프로토콜
  계약이므로 요구사항이 바뀌면 반드시 같이 바뀐다.
- **R5** 이벤트 타입 선언이 `callback` 을 optional 로 표현해, 무방비 호출이 다시
  타입상 안전해 보이지 않게 한다.

## 비목표

- `daemon/run.ts` 의 `unhandledRejection = 전체 종료` 정책은 건드리지 않는다.
  이 정책은 기동 malfunction 을 드러내는 장치라 무작정 완화하면 다른 사고를 숨긴다.
  R1 로 이 경로에서 rejection 이 나오지 않게 하는 것이 이번 범위다.
- ack 누락의 서버측 원인 규명 (위 "범위 밖" 참조).
- 재연결 시 RPC 폭주 자체의 완화(백프레셔/중복 제거).
