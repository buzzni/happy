# relay-cross-replica-routing 테스트 방법

이 문서는 `spawn-happy-session` 크로스 배치 스모크의 안전 계약과 릴레이
AC1~AC3를 검증하는 방법을 설명한다. 명령은 `vendor/happy` 루트에서 실행한다.

## 1. 로컬 회귀 테스트

최초 한 번 lockfile 기준으로 의존성을 설치한다.

```bash
corepack pnpm install --frozen-lockfile
```

spawn handler와 encryption 경로의 관련 테스트를 실행한다.

```bash
corepack pnpm --filter @buzzni/happy-cli exec vitest run \
  --project unit \
  src/api/apiMachine.spawnCreatedBy.test.ts \
  src/api/encryption.test.ts
```

확인하는 계약:

- null, 문자열, 배열 params는 `spawnSession()` 호출 전에 거부된다.
- dataKey variant에서 빈 params 복호화가 null을 반환해도 handler 첫 가드가
  `Spawn parameters must be an object` 오류로 차단한다.
- 오류는 `RpcHandlerManager`가 암호화된 응답으로 반환하며 세션은 생성되지 않는다.
- 정상 객체 params의 기존 createdBy, MCP, bootstrap 전달 동작은 유지된다.

타입과 스모크 스크립트 문법도 확인한다.

```bash
corepack pnpm --filter @buzzni/happy-cli typecheck
node --check specs/relay-cross-replica-routing/smoke-cross-placement.mjs
git diff --check
```

## 2. dev 클러스터 크로스 배치 스모크

이 단계는 선택 사항이며 로컬 unit test를 대체하지 않는다. 운영 클러스터에서는
변경 창과 담당자 승인 없이 실행하지 않는다.

사전 조건:

- 대상 namespace에 Running 상태의 happy-server replica가 2개 이상이다.
- Socket.IO Redis adapter와 `socketio_cluster_peers` metric이 배포되어 있다.
- 본인 소유의 Happy daemon이 온라인이다.
- `kubectl get pods`와 `kubectl port-forward` 권한이 있다.
- bearer token을 shell 환경변수로 준비하되 터미널 출력, 로그, 문서에 남기지 않는다.

dev namespace에서 실행한다.

```bash
SMOKE_TOKEN="$SMOKE_TOKEN" \
SMOKE_MACHINE="$SMOKE_MACHINE" \
node specs/relay-cross-replica-routing/smoke-cross-placement.mjs \
  aplus-dev-studio-dev-shared
```

`SMOKE_MACHINE`은 생략하면 첫 온라인 머신을 사용한다. 기본 `SMOKE_PORT=59999`는
닫힌 포트를 의도적으로 사용하며, daemon이 반환한 `CONNECTION_REFUSED` 또는
`502 Bad Gateway`도 올바른 왕복 증거로 판정한다.

성공 조건:

- 결과가 `실패 0건, 건너뜀 0건`이고 프로세스가 exit 0이다.
- 각 replica에서 HTTP, terminal, preview WS와 §6 spawn RPC가 모두 daemon 도달로
  판정된다.
- §6 실행 뒤 새 Happy session이 생기지 않는다. legacy는 decrypt 단계에서,
  dataKey는 spawn handler 첫 parameter guard에서 차단된다.
- `SMOKE_KEEP_PF`를 지정하지 않았다면 생성한 port-forward가 종료 시 정리된다.

실패 판정:

- `Machine offline`, `Machine not connected`, `RPC method not available`은
  cross-replica 라우팅 실패로 취급한다.
- token, 온라인 머신 또는 권한이 없어 SKIP이 발생하면 PASS가 아니다.
  `SMOKE_ALLOW_SKIP=1`은 진단용일 뿐 인수 검증에는 사용하지 않는다.
