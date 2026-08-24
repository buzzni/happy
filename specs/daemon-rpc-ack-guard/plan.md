# plan — daemon-rpc-ack-guard

## Phase 1 — 재현 테스트 (Done)

`src/api/rpc/rpcRequestListener.test.ts` 작성.
프로덕션의 무방비 로직을 그대로 옮긴 상태에서 실행해,
`TypeError: callback is not a function` 이 동일하게 재현되는 것을 확인.

- 검증: 7개 중 6개 실패, 실패 사유가 프로덕션 로그와 동일한 TypeError

## Phase 2 — 가드 구현 (Done)

`src/api/rpc/createRpcRequestListener` 로 리스너 생성을 분리하고
try/catch + callback 타입 가드를 넣음. 핸들러는 ack 유무와 무관하게 실행(R3).

- 검증: 7/7 통과

## Phase 3 — 두 호출부 연결 (Done)

`apiMachine.ts`, `apiSession.ts` 가 공통 리스너를 쓰도록 교체.
`apiMachine` 은 기존 `debugLargeJson` 요청 로깅을 `onRequest` 훅으로 보존.

- 검증: tsc 기준선 대비 신규 오류 0

## Phase 4 — 타입 선언 정정 (Done)

`ServerToDaemonEvents` / `ServerToClientEvents` 의 `callback` 을 optional 로.

- 검증: 의도적 타입 오류 주입 시 tsc 가 잡는지 확인 → 바인딩 정상

## Phase 5 — 회귀 확인 (Done)

- 검증: unit 스위트 기준선 대조. 38 failed / 1813 passed 로 기준선과 완전 동일
