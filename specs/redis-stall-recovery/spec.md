# Redis 연결 멈춤에도 소켓 재연결이 막히지 않게 한다

## 배경 — 2026-09-23 prod 장애 (KST 22:15 ~ 22:32)

- happy-server 두 replica 에서 Redis 연결이 half-open 으로 멈췄다. TCP 는 살아 있고
  응답만 오지 않았다. 22:32 에 `redis client error (ECONNRESET)` 가 찍히며 풀렸다.
- 그 17분 동안 **재연결하는 모든 클라이언트** 가 연결하지 못했다. ingress 로그를
  보면 WebSocket 은 파드까지 101 로 올라오지만 전부 정확히 20초(클라이언트
  connect timeout) 뒤 닫혔다. 인증 미들웨어 로그(`Token verified`)도 거의 없었다.
- 원인: `connectionStateRecovery` 가 켜져 있으면 socket.io 는 `pid` 를 가진
  재연결 클라이언트에 대해 **인증 미들웨어보다 먼저**
  `adapter.restoreSession()`(Redis `MULTI GET/DEL` + `XRANGE`)을 await 한다
  (`socket.io/dist/namespace.js` `_createSocket`). ioredis 에는 명령 시한이
  없었으므로 이 await 가 끝나지 않았다.
- 증상: daemon 머신 소켓이 RPC room 에서 빠져 desktop 에
  `Worktree 기준 branch를 확인하지 못했습니다. RPC method not available` 이
  표시됐다. daemon 을 재시작하면 새 프로세스는 `pid` 가 없어 이 단계를
  건너뛰므로 바로 붙었다.
- 17분이라는 길이: 요청이 항상 in-flight(adapter 가 100ms 마다 `XREAD`)라
  TCP keepalive 가 적용되지 않는다. 커널 재전송 한도(`tcp_retries2`)까지 버틴 것과
  일치한다. 그래서 keepalive 설정으로는 해결되지 않는다.
- Redis 가 왜 멈췄는지는 확인하지 못했다. sentinel-0/2 가 사고 전부터 tilt 모드를
  반복하고 있었지만 직접 원인이라고 단정할 수 없다.

## 요구사항

1. `restoreSession` 이 `RESTORE_SESSION_TIMEOUT_MS`(3초) 안에 끝나지 않으면
   reject 한다. socket.io 는 이를 "복구할 세션 없음" 으로 처리해 일반 연결을
   진행한다. 빠진 이벤트는 클라이언트의 기존 REST 재조회 경로가 메운다.
2. 모든 `createRedisClient()` 클라이언트는 명령 시한(`commandTimeout` 5초)을 갖는다.
   어떤 호출자도 멈춘 연결에서 무기한 기다리지 않는다.
3. `ready` 상태의 클라이언트는 5초마다 PING 한다. PING 이 명령 시한을 넘기면
   연결을 교체(`disconnect(true)`)한다. `disconnectTimeout` 뒤 소켓을 destroy 하므로
   half-open 에서도 멈추지 않고, Sentinel 모드에선 master 를 다시 묻는다.
   명령 시한만으로는 연결이 그대로 남기 때문에 이 교체가 필요하다.
4. 두 경로 모두 1분에 한 번으로 제한된 로그를 남긴다 (AGENTS.md §1.13).
