# Happy CPU Optimization Spec

## Goal

Happy가 상시 실행 중일 때 CPU를 많이 소비하는 프로세스인지 판단하고, 기능 영향 없이 줄일 수 있는 반복 작업과 대량 처리 경로를 최적화한다.

2026-07-04 사용자 clarification: 여기서 우선 판단해야 하는 CPU는 Kubernetes `happy-server` pod CPU가 아니라 `main.axstudio-4.ryan.coder` 같은 SSH 개발 머신의 CPU다. 따라서 서버 pod 최적화는 별도 트랙으로 남기되, 1차 효과 판단은 SSH 머신에서 `happy-cli daemon start-sync` 아래로 실행되는 원격 RPC/상태 확인/agent session 프로세스에 둔다.

## Baseline Findings

- `slopus/happy` 기준: `happy@1.1.10`, commit `d2ef88deffa337546f0c477f28385d470188cb38`
- `buzzni/happy` 기준: `@namsangboy/happy-cli@1.1.10-aplus.38`, commit `262030379f0725f3ff7e8c59f8f94bbe5be00053`
- 현재 로컬에서 장기 실행 중인 Happy daemon은 `node .../packages/happy-cli/dist/index.mjs daemon start-sync` 하나였다.
- 5초 관찰 기준 Happy daemon CPU는 대부분 `0.0%`, 한 번 `0.4%`로 측정되었다.
- 같은 시점 CPU 상위 프로세스는 Happy가 아니라 Codex 앱 renderer/service/app-server, WindowServer, VM 프로세스였다.
- Kubernetes prod 실측:
  - namespace: `aplus-dev-studio-prod-shared`
  - pod: `happy-server-6c7c5b64cc-l2lnp`
  - image: `101047223697.dkr.ecr.ap-northeast-2.amazonaws.com/aplus/dev-studio-happy-server:6fa1cc8`
  - CPU: 약 `353m~388m`
  - active WebSocket connections: `317`
  - session-scoped connections: `288`
  - session-alive events since pod start: 약 `97k+`
  - preview relay requests since pod start: `126`
  - event loop p99 lag: 약 `21~23ms`
  - Redis stream lag: `0ms`
- SSH 머신 실측:
  - host: `main.axstudio-4.ryan.coder`
  - hostname: `coder-011c066d-c630-48f0-891a-b45ae212d155-dc6787f46-tvm57`
  - CPU cores: `16`
  - load average: 약 `13~15`
  - `top` 순간 CPU: user 약 `24%`, system 약 `40%`, idle 약 `34%`
  - 장기 실행 `happy-cli daemon start-sync` 자체 순간 CPU는 약 `0~1%`
  - Happy가 띄운 session wrapper와 자식 `claude`/`codex app-server`가 누적 CPU를 사용
  - 짧게 반복 생성되는 `__APLUS_SERVICE_LISTEN`, `docker ps`, `saycode-status`, `npm list -g --depth=0 --json` 계열 프로세스가 관찰됨
  - `/home/coder/.happy/logs`는 약 `193MB`, 현재 daemon log 단일 파일은 약 `40MB`

현재 근거만으로는 Happy daemon 자체가 idle 상태에서 CPU-heavy 프로세스라고 보기 어렵다. 다만 SSH 머신에서 보이는 부하는 Happy daemon의 generic bash RPC를 통해 A+ web-ui/status 코드가 짧은 shell, Docker, Node/npm 프로세스를 반복 실행하는 형태로 나타난다. 따라서 사용자가 말한 머신 CPU 최적화에는 `happy-server`보다 `happy-cli` 실행 경로와 A+ 호출부 최적화가 더 직접적이다.

Prod `happy-server` 기준으로는 preview relay보다 session keep-alive 처리량이 더 강한 CPU 후보로 보인다. session-alive는 각 이벤트마다 session validation/cache hit 처리, DB update queue, user-scoped ephemeral activity broadcast를 수행한다.

단, 이 서버 최적화는 SSH 머신 CPU에는 직접적인 효과가 작다. 서버 pod CPU를 줄이는 작업과 SSH 머신 process churn을 줄이는 작업은 별도로 우선순위를 매겨야 한다.

## Scope

### In Scope

- `packages/happy-cli`
  - session receive polling 완화
  - daemon machine keep-alive 중 CLI/auth 재탐지 캐싱
  - remote terminal 출력 batching
  - remote terminal idle timer reset throttle
- `packages/happy-server`
  - preview relay/rewrite의 불필요한 rewrite skip
  - RPC presence polling 부하 완화 검토
  - 대용량 preview response buffering/base64 비용 개선 검토
- A+ caller side
  - remote preview/status polling 중복 호출 완화
  - `saycode-status`의 CLI version 조회 캐싱 또는 `npm list` 제거
  - spec/resource polling을 shell RPC 대신 cached/coalesced API로 전환 검토

### Out of Scope

- `happy-app` UI 개선
- 기능 동작 변경이 필요한 preview/terminal 프로토콜 대개편
- 운영 인프라 스케일링 변경
- unrelated refactor

## CPU Risk Areas

| Area | Current Behavior | Risk | Primary Files |
| --- | --- | --- | --- |
| session-alive fan-out | session-scoped client가 2초마다 alive 전송, 서버가 매번 validation/queue/broadcast 수행 | prod에서 초당 100건 이상 처리 가능, user-scoped fan-out까지 발생 | `packages/happy-server/sources/app/api/socket/sessionUpdateHandler.ts`, `packages/happy-server/sources/app/events/eventRouter.ts` |
| SSH machine status scripts | web-ui/status 경로가 Happy bash RPC로 short-lived shell/Docker/npm 명령을 반복 실행 | system CPU와 process creation 증가. SSH 머신 부하에 직접 영향 | `packages/web-ui/src/lib/sync/runPreviewContainerRemote.ts`, `/home/coder/.local/bin/saycode-status`, `packages/web-ui/server/specFileRemote.ts`, `packages/web-ui/server/machineUnion.ts` |
| session receive polling | 연결된 session마다 5초마다 REST catch-up 수행 | 세션 수가 많을 때 서버 요청과 복호화 비용 누적 | `packages/happy-cli/src/api/apiSession.ts` |
| daemon capability detection | machine keep-alive 20초마다 `command -v` 다중 실행 및 resume auth 확인 | 작지만 반복적인 child process/crypto 비용 | `packages/happy-cli/src/api/apiMachine.ts`, `packages/happy-cli/src/utils/detectCLI.ts`, `packages/happy-cli/src/resume/localHappyAgentAuth.ts` |
| remote terminal output | PTY chunk마다 encrypt + base64 + Socket.IO emit + idle timer reset | 대량 출력 시 daemon CPU 증가 | `packages/happy-cli/src/api/apiMachine.ts`, `packages/happy-cli/src/daemon/daemonTerminalSessions.ts` |
| preview relay | 최대 50MiB buffer/base64 왕복 후 HTML/JS/CSS regex rewrite | 큰 dev bundle/asset 요청 시 CPU와 memory 증가 | `packages/happy-cli/src/daemon/previewProxy.ts`, `packages/happy-server/sources/app/api/routes/previewRoutes.ts`, `packages/happy-server/sources/modules/preview/rewriteHtml.ts` |
| RPC presence polling | 장기 RPC 호출 중 2초마다 `fetchSockets()` presence poll | 서버/Redis adapter 부하 | `packages/happy-server/sources/app/api/socket/rpcHandler.ts` |

## Requirements

1. Idle daemon CPU가 증가하지 않아야 한다.
2. Remote control, reconnect catch-up, preview relay, remote terminal 기능을 유지해야 한다.
3. 최적화는 기능 결과를 바꾸지 않는 구조적/성능 변경으로 제한한다.
4. 변경마다 관련 테스트를 먼저 작성하거나 기존 테스트로 회귀를 고정한다.
5. 기능 영향이 있는 프로토콜 변경은 별도 spec으로 분리한다.
6. 측정 가능한 기준을 남긴다.

## Success Criteria

- Happy daemon idle CPU가 로컬 측정에서 지속적으로 1% 미만이다.
- SSH 머신에서 short-lived shell/Docker/npm 상태 확인 프로세스 생성 빈도가 감소한다.
- `saycode-status`가 매 호출마다 `npm list -g --depth=0 --json`를 실행하지 않는다.
- session receive polling이 정상 socket update 흐름에서는 고정 5초 REST polling보다 적게 호출된다.
- session-alive 서버 처리에서 동일 session의 중복 activity broadcast가 throttle/debounce된다.
- CLI availability/auth detection이 20초마다 매번 shell/crypto 작업을 반복하지 않는다.
- remote terminal 대량 출력에서 프레임 수와 idle timer reset 횟수가 줄고, 출력 순서와 내용은 동일하다.
- preview subdomain mode 또는 rewrite 불필요 content에서 no-op full-body rewrite를 피한다.
- 관련 unit/integration 테스트가 통과한다.
