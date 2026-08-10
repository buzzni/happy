# 계획 (relay-cross-replica-routing)

> 상태: **Phase 1~4 완료 (2026-08-09).** dev·prod 양쪽에서 크로스 배치
> 스모크 통과(실패 0건), prod replicas=2 재전환 완료. §6(세션 spawn RPC)
> 까지 실행돼 `happy-server-horizontal-scale` AC1 의 마지막 미확인 항목이
> 닫혔다. 남은 것은 그 spec 쪽 AC3(1주 관측)·AC2(클라이언트 재연결 실측).
> D1=serverSideEmit, D2=Redis+로컬 캐시, D3=단계 분할 배포로 확정 (spec.md §7).

## Phase 1 — 프리뷰 HTTP 릴레이 (무상태, 저위험) — **완료 (2026-08-08)**

- [x] 공용 조회 모듈 `app/events/findMachineSockets.ts` 신설 —
      `io.in('user:{u}:machine:{m}').timeout(2s).fetchSockets()` +
      `clientType`/`machineId` 방어 필터. Phase 2·3 도 이걸 쓴다.
      반환은 `{ sockets, degraded }` — `degraded` 는 어댑터 조회 자체가
      실패했다는 뜻이라 "머신 없음" 과 구분된다 (AC5).
- [x] `eventRouter` 에 `get server()` 추가 (io 접근자).
- [x] `previewRoutes.findMachineSockets()` → 공용 모듈 위임, 호출부 `await`.
- [x] `PreviewRelayOutcome` 에 `lookup-degraded` 추가. 상태코드는 502 그대로
      (checkPortReachable 계약 불변), reason 토큰만 분리 (AC5).
- [x] 조회 실패 시 502 를 `reason=lookup-degraded` 로 로깅.

### 계획과 달랐던 점

`relayProxyHttpRequest()` 시그니처가 "변경 없음" 일 거라 적었는데 **틀렸다.**
파라미터 타입 `Array<Pick<Socket,'id'|'timeout'>>` 은 `RemoteSocket` 을
구조적으로 받지 못한다 — `Socket.timeout()` 은 `Socket` 을,
`RemoteSocket.timeout()` 은 `BroadcastOperator` 를 반환한다. 런타임은 둘 다
`emitWithAck` 를 갖지만 타입이 안 맞는다. `PreviewRelayMachineSocket`
구조적 인터페이스로 좁혀 해결했다 (previewWebSocketRelay 의
`PreviewWsMachineSocket` 과 같은 패턴).

- 테스트: `findMachineSockets.spec.ts` 8건 신규,
  `previewRoutesFailureLog.spec.ts` 에 lookup-degraded 분리 1건 추가.
  `previewRoutesCredentials.spec.ts` 의 `getConnections` 스텁을 room 조회
  shim 으로 교체 (같은 픽스처에 production 과 동일한 필터 적용).
- 검증: `pnpm typecheck` 클린, vitest **529 passed**. 단일 replica 경로 불변(AC4).
- 미검증: AC1(실제 크로스 배치 스모크)은 Phase 4 에서 확인한다.

## Phase 2 — 터미널 (T3 활용) — **완료 (2026-08-08)**

- [x] **구조적 커밋 선행** — `TerminalSession` 이 소켓 객체 대신
      `clientSocketId`/`daemonSocketId` 를 들고, 모든 emit 이
      `io.to(socketId)` 로. replicas=1 에서 no-op.
      프레임 전달 경로에 테스트가 없었어서 6건 추가 (양방향 프레임,
      resize 방향 제한, 세션 밖 소켓 차단, 양쪽 disconnect).
- [x] 머신 소켓 조회를 Phase 1 공용 모듈로 교체 + `degraded` 로깅.
- [x] **`newestMachineSocket()` 신설.** 기존 "가장 최근 소켓" 규칙은 Set
      삽입 순서에 의존했는데 cross-replica `fetchSockets()` 는 순서를
      보장하지 않는다. `socket.data.connectedAt` 스탬프(socket.ts 미들웨어)로
      결정적 정렬. 스탬프 없는 구 소켓은 기존 last-wins 로 폴백.
- [x] Redis 공유 저장소 + 로컬 write-through 캐시 (D2-a).
      역방향 인덱스 `terminal:socket:{id}` 도 둔다 — 데몬이 세션을 한 번도
      캐시하지 않은 replica 에서 끊겨도 클라이언트에 알릴 수 있어야 한다.
      Redis 실패는 로컬 상태로 degrade (throw 금지).
- [x] `countActiveSessionsForUser` 를 `SCARD` 로 전역화 — 기존 로컬 카운트는
      replicas=2 에서 사용자당 상한을 사실상 2배로 만들었다.
- 검증: typecheck 클린, vitest **547 passed** (신규 18건).
  dev 실제 Redis 대상 스모크로 cold-cache 조회·전역 카운트·역방향 인덱스·
  전역 삭제·TTL 을 확인 (테스트 키 정리 완료).
- 미검증: AC3(실제 크로스 배치 터미널 왕복)은 Phase 4.

### 원래 계획 (참고)

- [ ] `terminalSessions.ts` 의 `TerminalSession` 에서 `clientSocket`/
      `daemonSocket`(Socket 객체) → `clientSocketId`/`machineId`/`daemonSocketId`
      (문자열)로 교체. **구조적 변경**으로 먼저 커밋하고, 로컬 Map 유지한 채
      기존 테스트 통과 확인.
- [ ] 공유 저장소 도입 (D2 결정 따름). 로컬 캐시로 프레임당 조회 제거(AC6).
- [ ] `terminalRelayHandler.ts`
      - 머신 소켓 조회 → room + `fetchSockets()` (T1). 최신 소켓 1개 선택
        규칙(주석 44-56행)은 유지 — PTY 중복 spawn 방지.
      - 클라이언트→데몬: `io.to('user:{u}:machine:{m}').emit(...)`
      - 데몬→클라이언트: `io.to(clientSocketId).emit(...)` (T3)
      - `socket === session.clientSocket` 동일성 비교를 `socket.id ===
        session.clientSocketId` 로 교체
      - `disconnect` 정리: 소켓 객체 비교 → id 비교
- [ ] `countActiveSessionsForUser` 가 전체 replica 기준이 되도록 조정
      (지금은 로컬 Map 이라 replicas=2 면 사용자당 상한이 사실상 2배)
- 테스트: `terminalRelayHandler.spec.ts`, `terminalSessions.spec.ts` 회귀 +
  cross-replica 케이스.

## Phase 3 — 프리뷰 WS (T4·T5) — **완료 (2026-08-08)**

- [x] `previewWsTunnels.ts` 신설 — 터널 레지스트리 + replica 간 hand-off.
      `deliverDaemonData/Close` 는 **로컬이면 바로 쓰고, 아니면 broadcast**
      한다. 같은 replica 인 흔한 경우에 fan-out 을 내지 않는 게 핵심이다.
- [x] `wireMachineSocket()`(터널 open 시점에 데몬 Socket 에 리스너 부착)를
      **`previewWsMachineHandler()`(커넥션 시점, 데몬의 replica 에서 등록)**
      로 대체. T4 때문에 RemoteSocket 에는 리스너를 못 붙인다.
- [x] `registerPreviewWsClusterListeners(io)` — peer 가 넘긴 프레임 수신.
- [x] 터널 엔트리가 `owner: IoSocket` → `ownerSocketId: string`.
      브라우저→데몬 emit 은 `io.to(daemonSocketId)`.
- [x] 데몬 disconnect 시 로컬 정리 + `preview-ws-daemon-gone` 브로드캐스트 —
      브라우저 소켓은 어느 replica 에나 있을 수 있다.
- [x] 조회 실패(`degraded`)를 "머신 없음" 과 구분해 로깅.
- 검증: typecheck 클린, vitest **558 passed** (신규 11건).
  **dev 실제 Redis 로 `serverSideEmit` 자체를 검증** — 양방향 전달 확인,
  그리고 발신 노드에는 되돌아오지 않음(로컬 중복 쓰기 없음)까지 확인.
  D1 가정이 실제로 성립하는지가 Phase 3 전체의 전제였다.
- 미검증: AC2(실제 크로스 배치 HMR 왕복)는 Phase 4.

### 원래 계획 (참고)

- [ ] D1 결정에 따른 replica 간 바이트 전달 경로 구현.
- [ ] `findMachineSockets()` → room 기반 (T1).
- [ ] `openPreviewWsTunnel()` 은 `PreviewWsMachineSocket` 인터페이스로 이미
      추상화돼 있어 `RemoteSocket` 을 그대로 받는다 — 변경 최소.
- [ ] `wireMachineSocket()` 재설계: 지금은 데몬 Socket 에 리스너를 붙이는데,
      `RemoteSocket` 에는 불가능(T4). 데몬 소켓이 **로컬인 replica** 에서만
      리스너를 걸고, 터널 소유 replica 가 다르면 D1 경로로 넘긴다.
- [ ] `browserByTunnel` 에 소유 replica 식별자 추가.
- [ ] 데몬 disconnect 시 다른 replica 가 소유한 터널도 정리되도록 전파.
- 테스트: 기존 `previewWebSocketRelay.spec.ts` 회귀 + 소유 replica 분리 케이스.

## Phase 4 — 통합 검증 후 replicas=2 재전환

- [x] dev replicas=2 에서 **브라우저·데몬 강제 크로스 배치** 스모크
      (AC1·AC2·AC3) — **통과 (2026-08-09).** `smoke-cross-placement.mjs`
      실패 0건·건너뜀 0건. 아래 "Phase 4 스모크 결과" 참조.
- [x] prod 카나리 재전환 — k8s-manifests#1480(2026-08-09). replicas 1→2,
      PDB 복원, 두 replica 모두 `socketio_cluster_peers=1` 확인. baseline 은
      aplus-dev-studio#1746 로 전환 **전** replicas=1 상태에서 채집 완료
      (이전엔 baseline 없이 전환해 판정 불가였던 것을 고쳤다).
- [x] prod 에 대해 `smoke-cross-placement.mjs` 실행 — **통과 (2026-08-09),
      실패 0건·건너뜀 0건.** §6(세션 spawn RPC) 포함 6개 섹션 전부. 아래
      "prod 스모크 결과" 참조.
- [x] aplus-dev-studio `specs/happy-server-horizontal-scale` 갱신 —
      #1742/#1743/#1746 로 완료.

### Phase 4 스모크 결과 (2026-08-09, dev `aplus-dev-studio-dev-shared`)

배포 이미지: `happy-server:5b16a45` (= 이 spec 의 Phase 1·2·3 전부 포함,
`vendor/happy` 포인터 `42ba7259`). replica 2개
(`happy-server-6d49494469-f5vq6`, `-tmdqw`), 온라인 머신 1개
(`83049a09-161d-4b64-8e85-0303b5f17576`), machine-scoped 소켓 총 3개.

- **클러스터 버스**: 두 replica 모두 `socketio_cluster_peers=1` — 서로를
  본다. 이 값이 0 이면 `fetchSockets` 가 조용히 로컬 결과만 반환해 아래
  검사가 전부 무의미해지므로, 선행 관문으로 확인했다.
- **AC1 프리뷰 HTTP**: 두 replica 모두 `502 code=CONNECTION_REFUSED`
  (= 데몬이 답한 에러). `{ error: "Machine offline" }` 이 아니라는 게 핵심 —
  전자는 요청이 데몬까지 갔다 왔다는 증거고, 후자가 라우팅 실패다.
- **AC3 터미널**: 두 replica 모두 `terminal-open` 성공 (세션 발급됨).
- **AC2 프리뷰 WS**: 두 replica 모두 `502 Bad Gateway` (데몬 도달).
  `502 Machine Offline` 이었으면 실패다.

**왜 이게 크로스 배치의 증명인가**: 데몬은 정확히 한 replica 에만 붙어
있는데 **모든** replica 가 그 머신의 요청을 처리해냈다. 따라서 최소 한
쪽은 replica 를 건넜다. Service 를 거치지 않고 각 파드에 직접
port-forward 했기 때문에 "우연히 같은 replica 로 라우팅됐다" 로 통과할
길이 없다 — 구 `smoke-cross-replica.sh` 가 닫지 못했던 바로 그 구멍이다.

**이 스모크가 다루지 않은 것**: `happy-server-horizontal-scale` AC1 본문에
함께 적힌 **메시지 송수신과 세션 spawn RPC** 는 확인하지 않았다. 확인한
것은 프리뷰 HTTP·프리뷰 WS·터미널 세 릴레이 경로다 (이 spec 의 범위).

### 2026-08-09 (2차) — 메시지 송수신 / 세션 spawn RPC

**메시지 송수신**: 별도 스모크가 필요 없다고 판단한다. 메시지는 RPC(단일
소켓 지목)가 아니라 room 브로드캐스트(`eventRouter.emitUpdate` →
`user:{u}:session:{s}` / `user:{u}:user-scoped`)로 전달되고, 이건 애초에
V1 이 이미 증명한 Redis streams adapter 의 기본 기능이다 — "어느 replica 에
붙어 있든" 이 애초에 room 멤버십의 문제일 뿐 "올바른 replica 를 찾아야
하는" 문제가 아니다(RPC/릴레이 세 경로처럼 process-local Map 을 조회하는
코드가 없다). `socketio_cluster_peers=1`(양쪽 dev/prod 확인됨)이 이 경로가
살아있다는 증거다.

**세션 spawn RPC**: `smoke-cross-placement.mjs` §6 신설 —
`${machineId}:spawn-happy-session` 를 암호화 없이(빈 `params`) 호출한다.
daemon 의 `RpcHandlerManager.handleRequest()` 는 핸들러 실행 전에
decrypt(decodeBase64(params)) 를 하고 전체를 try/catch 로 감싼다. legacy
variant 는 빈 bundle 복호화가 throw 되어 핸들러 전에 catch 된다. dataKey
variant 는 null 을 반환해 핸들러에 진입하므로, `spawn-happy-session` 핸들러
첫 줄의 null/비객체 parameter guard 가 로깅·destructuring·`spawnSession()` 전에
거부하도록 계약을 명시했다. 두 경우 모두 암호화된 에러 블롭으로 안전하게
반환되고 실제 세션은 만들어지지 않는다. 판정은 `rpc-call` 최상위 `ok` 만 본다:
`true` 는 daemon 도달, `false`+"not available" 은 라우팅 실패.

### prod 스모크 결과 (2026-08-09, `aplus-dev-studio-prod-shared`)

k8s-manifests#1480 재전환 직후 실행. **실패 0건·건너뜀 0건 — 6개 섹션 전부
통과.** replica 2개(`happy-server-6cb886c4b8-6tbv8`, `-nxq7w`), 머신 11개 중
온라인 5개, 대상 `8d7d1dde-41d2-4e39-bcb8-b7e0e7153ae0`.

| 섹션 | 결과 |
|---|---|
| 1. 클러스터 버스 | 두 replica 모두 `socketio_cluster_peers=1` |
| 3. AC1 프리뷰 HTTP | 두 replica 모두 `502 CONNECTION_REFUSED`(데몬 도달) |
| 4. AC3 터미널 | 두 replica 모두 `terminal-open` 성공 |
| 5. AC2 프리뷰 WS | 두 replica 모두 `502 Bad Gateway`(데몬 도달) |
| **6. AC1 세션 spawn RPC** | **두 replica 모두 daemon 도달** |

§6 이 통과하면서 `happy-server-horizontal-scale` AC1 의 마지막 미확인
항목이 닫혔다. dev(온라인 머신 1개)와 달리 prod 는 온라인 머신 5개·실사용
트래픽이 있는 환경이라 신호가 더 강하다.

**단, "최소 한 쪽은 replica 를 건넜다" 추론의 강도는 dev 보다 약하다.**
스크립트가 찍은 `machine-scoped 소켓 총합: 33` 은 `websocket_connections_total`
값인데, 이름과 달리 Counter 가 아니라 **Gauge**(`metrics2.ts` —
"Number of active WebSocket connections") 다. 즉 온라인 머신 5개에 활성
machine-scoped 소켓이 33개, 머신당 평균 6~7개다. 대상 머신이 두 replica
**양쪽에** 소켓을 갖고 있었다면 각 replica 가 로컬 소켓만으로 응답했을
수 있고, 그러면 "건넜다" 는 증명되지 않는다. 스크립트는 대상 머신의
소켓이 어느 replica 에 있는지 확인하지 않는다(메트릭에 machineId 라벨이
없어 분해 불가).
→ 그래도 **검사가 타는 코드 경로는 동일**하다(`findMachineSockets` 는
어느 경우든 `io.in(room).timeout().fetchSockets()` 클러스터 어댑터 경로를
탄다). 그리고 "모든 replica 가 이 머신의 요청을 처리해낸다" 는 사용자
관점의 명제 자체는 그대로 성립한다. 엄밀한 크로스 배치 증명은 소켓이
1개뿐이었던 dev 실행(2026-08-09, 위)이 담당한다.

## 리스크

- Phase 3 이 가장 크고, 실패 시 프리뷰 HMR 이 깨진다. Phase 1·2 와 별도
  PR 로 분리해 롤백 단위를 작게 유지한다.
- `countActiveSessionsForUser` 를 전역화하면 기존 사용자 체감 상한이
  바뀐다(느슨→엄격). 의도된 변경임을 릴리스 노트에 남긴다.
- 세 경로 모두 E2EE 프레임을 다루므로, 라우팅만 바꾸고 payload 는 절대
  건드리지 않는다.
