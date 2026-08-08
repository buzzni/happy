# 계획 (relay-cross-replica-routing)

> 상태: **Phase 1 진행 중** (2026-08-08 승인).
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

## Phase 2 — 터미널 (T3 활용)

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

## Phase 3 — 프리뷰 WS (T4·T5, 가장 어려움)

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

- [ ] dev replicas=2 에서 **브라우저·데몬 강제 크로스 배치** 스모크
      (AC1·AC2·AC3). `happy-server-horizontal-scale` 의 미해결 항목
      "AC1 크로스 배치 확인" 을 여기서 닫는다.
- [ ] prod 카나리 + baseline 재채집 (이전 baseline 은 Prometheus retention
      에서 소실).
- [ ] aplus-dev-studio `specs/happy-server-horizontal-scale` 갱신.

## 리스크

- Phase 3 이 가장 크고, 실패 시 프리뷰 HMR 이 깨진다. Phase 1·2 와 별도
  PR 로 분리해 롤백 단위를 작게 유지한다.
- `countActiveSessionsForUser` 를 전역화하면 기존 사용자 체감 상한이
  바뀐다(느슨→엄격). 의도된 변경임을 릴리스 노트에 남긴다.
- 세 경로 모두 E2EE 프레임을 다루므로, 라우팅만 바꾸고 payload 는 절대
  건드리지 않는다.
