# 릴레이 cross-replica 라우팅 (relay-cross-replica-routing)

> 출처: aplus-dev-studio `specs/happy-server-horizontal-scale` 의 "V2 정정".
> 2026-08-07 prod 장애 후 replicas=1 로 롤백된 상태이며, 이 스펙이
> replicas>=2 재전환의 마지막 코드 관문이다.
> 상태: **Phase 0 (Planning) — 사용자 승인 대기. 코드 변경 없음.**

## 1. 문제 (변경 불가 배경)

데몬 RPC 는 `rpc:{userId}:{method}` room + `fetchSockets()` 로 이미
cross-replica 지만, **머신 소켓을 직접 찾는 세 경로는 프로세스 로컬**이다:

| 위치 | 기능 | 조회 방식 |
|---|---|---|
| `app/api/routes/previewRoutes.ts:81` | 프리뷰 HTTP 릴레이 | `eventRouter.getConnections()` |
| `modules/preview/previewWebSocketRelay.ts:94` | 프리뷰 WS 릴레이 | `eventRouter.getConnections()` |
| `app/api/socket/terminalRelayHandler.ts:58` | 원격 터미널 | `eventRouter.getConnections()` |

`eventRouter.userConnections` 는 `Map` 이다 (`eventRouter.ts:220`).
replicas>=2 에서 브라우저 요청이 데몬 소켓 없는 replica 에 떨어지면:

- 프리뷰 HTTP → 502 `Machine offline`
- 프리뷰 WS → 터널 open 실패
- 터미널 → `Machine not connected for this user`

데몬과 브라우저가 서로 다른 replica 에 붙을 확률이 있으므로, replica 2개
기준 **약 50% 실패**한다. Redis 클러스터 버스가 완전히 건강해도 발생한다 —
`#134` 의 Sentinel 수정과는 **독립적인 결함**이다.

## 2. 목표 (Goal)

replicas>=2 에서 프리뷰 HTTP·프리뷰 WS·터미널이 브라우저와 데몬의 replica
배치와 무관하게 동작한다.

## 3. 비범위 (Non-Goals)

- RPC 경로 재작업 (이미 cross-replica)
- 인그레스 sticky/affinity 정리 (k8s-manifests 쪽 별건)
- E2EE 모델 변경 — 릴레이는 지금처럼 불투명 프레임만 옮긴다
- 터미널/터널의 replica 간 **이전(migration)** — replica 가 죽으면 해당
  세션은 지금처럼 끊긴다. 재연결은 클라이언트 몫이다.

## 4. 기술 전제 (검증 완료)

- **T1 (확인)** `user:{userId}:machine:{machineId}` room 이 이미 존재한다
  (`eventRouter.ts:238` `addConnection`). 별도 레지스트리 없이
  `io.in(room).fetchSockets()` 로 머신 소켓을 cross-replica 조회할 수 있다.
- **T2 (확인)** `RemoteSocket.timeout(ms).emitWithAck()` 는 단일 응답을
  반환한다 — `RemoteSocket` 이 `expectSingleResponse: true` 로
  `BroadcastOperator` 를 만든다 (`broadcast-operator.js:376`). 즉 로컬
  `socket.emitWithAck()` 와 반환 형태가 같아 호출부 수정이 불필요하다.
  `rpcHandler.ts:229` 가 이미 프로덕션에서 이 패턴을 쓴다.
- **T3 (확인)** Socket.IO 는 모든 소켓을 자기 `socket.id` 이름의 room 에
  자동 조인시킨다 → `io.to(socketId).emit()` 은 cross-replica 로 동작한다.
- **T4 (제약, 핵심)** `RemoteSocket` 에는 **리스너를 붙일 수 없다.**
  데몬이 보내는 인바운드 이벤트(`proxy-ws-data`, `proxy-ws-close`,
  `terminal-frame`, `terminal-closed`)는 **데몬이 붙어 있는 replica 에서만**
  발생한다. 따라서 "데몬 → 브라우저" 방향은 조회만으로 해결되지 않는다.
- **T5 (제약)** 프리뷰 WS 의 브라우저 쪽은 Socket.IO 소켓이 아니라 원시
  TCP `NetSocket` 이다(HTTP upgrade 를 받은 replica 에 고정). 따라서 T3 을
  쓸 수 없고, 바이트를 **소유 replica 로 넘기는 별도 경로**가 필요하다.

## 5. 방향

경로별로 난이도가 다르므로 3단계로 나눈다.

1. **프리뷰 HTTP** — 무상태 요청/응답. T1+T2 로 조회만 바꾸면 끝난다.
2. **터미널** — 클라이언트가 Socket.IO 소켓이므로 T3 이 쓸 수 있다.
   세션 레코드를 소켓 객체 대신 **식별자**(`clientSocketId`, `machineId`)로
   바꾸고 공유 저장소에 두면, 데몬 replica 에서도 조회해
   `io.to(clientSocketId).emit()` 로 되돌릴 수 있다.
3. **프리뷰 WS** — T5 때문에 replica 간 바이트 전달 경로가 필요하다.
   이 부분이 유일한 미결 설계 결정이다 (§7 D1).

## 6. 인수 기준 (Acceptance Criteria)

- AC1: replicas=2 에서 브라우저와 데몬을 **서로 다른 replica 에 강제 배치**한
  상태로 프리뷰 HTTP GET/POST 가 성공한다.
- AC2: 같은 배치에서 프리뷰 WS(HMR) 터널이 열리고 양방향 프레임이 흐른다.
- AC3: 같은 배치에서 터미널 open → 입력 → 출력 → close 가 동작한다.
- AC4: 브라우저와 데몬이 **같은** replica 에 있는 경우도 회귀 없이 동작한다
  (기존 단일 replica 경로).
- AC5: 데몬 소켓이 없을 때는 지금과 동일한 오류를 반환한다
  (502 `Machine offline` / `Machine not connected for this user`) —
  cross-replica 조회 실패를 "머신 없음" 으로 오인하지 않는다.
- AC6: 프레임당 Redis 왕복을 추가하지 않는다 (터미널 키 입력·HMR 스트림이
  Redis RTT 에 묶이면 안 된다).

## 7. 승인 필요 결정 (Decisions)

- **D1: 프리뷰 WS 의 replica 간 바이트 전달 경로.**
  - (a) `io.serverSideEmit()` — 어댑터 내장, 코드 최소. 단 **모든** replica 로
    브로드캐스트하므로 HMR 트래픽이 replica 수에 비례해 낭비된다.
  - (b) Redis pub/sub 채널을 소유 replica 별로 두고 타깃 전송. 낭비 없음,
    코드와 수명주기 관리가 늘어난다.
  - 권장: replicas 2~3 규모에서는 **(a)** 로 시작하고, 낭비가 지표로
    보이면 (b) 로 옮긴다. 프레임 크기가 크고 빈도가 높으면 (b).
- **D2: 터미널 세션 공유 저장소.**
  - (a) Redis (TTL) + replica 로컬 캐시 — 정확하지만 코드량 증가.
  - (b) `io.serverSideEmit` 으로 open/close 시점에만 레코드를 복제하고
    각 replica 가 로컬 Map 유지 — 프레임당 조회 없음(AC6 유리), 단
    전달 보장이 없어 유실 시 해당 터미널만 실패.
  - 권장: **(a)** 를 쓰되 로컬 캐시로 AC6 를 만족. 터미널은 세션 수가
    적고(사용자당 최대 5) open/close 빈도가 낮아 Redis 비용이 무시할 만하다.
- **D3: 단계 분할 배포 여부.** Phase 1(프리뷰 HTTP)만 먼저 머지·배포하고
  replicas=2 는 Phase 3 까지 끝난 뒤에 올릴지. 권장: 그렇게 한다 —
  Phase 1 은 단일 replica 에서 무해한 no-op 이라 리스크가 낮다.
