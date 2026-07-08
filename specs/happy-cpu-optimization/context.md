# Happy CPU Optimization Context

## Current State

2026-07-04 기준으로 `slopus/happy`와 `buzzni/happy`를 비교했다.

- upstream remote: `https://github.com/slopus/happy.git`
- buzzni remote: `https://github.com/buzzni/happy.git`
- 로컬 경로: `/Users/ganghyejun/buzzni/projects/aplus-dev-studio/vendor/happy`
- 현재 브랜치: `codex/session-start-webhook-wait`

## Observations

- 로컬에서 Happy daemon은 실행 중이었지만 idle CPU가 높지 않았다.
- `buzzni/happy`는 upstream 대비 208개 파일, 약 2만 줄 규모의 기능 추가가 있다.
- CPU 위험은 daemon idle loop보다 기능 사용 중 처리량이 큰 경로에 집중되어 있다.
- 사용자 clarification 이후, 우선 대상 CPU는 Kubernetes pod가 아니라 SSH 개발 머신 CPU다.
- Kubernetes 접근 확인:
  - SSH: `main.axstudio-4.ryan.coder`
  - kubectl context: `idc-k8s-admin`
  - `kubctl` 명령은 없고 `kubectl` 사용 가능
- Prod `happy-server` 실측:
  - namespace: `aplus-dev-studio-prod-shared`
  - pod: `happy-server-6c7c5b64cc-l2lnp`
  - CPU: `353m~388m`
  - memory: 약 `234Mi`
  - replicas: `1`
  - resource request/limit: CPU `500m`/`2`, memory `512Mi`/`2Gi`
  - current active WebSocket connections: `317`
  - session-scoped: `288`
  - session-alive total since pod start: `97k+`
  - preview route requests since pod start: `126`
  - `rpc_fetchsockets_timeouts_total{context="lookup"}`: `168+`
  - `get-state` RPC `not_available` calls wait around the 15s reconnect grace window.
- SSH 머신 실측:
  - target: `main.axstudio-4.ryan.coder`
  - hostname: `coder-011c066d-c630-48f0-891a-b45ae212d155-dc6787f46-tvm57`
  - cores: `16`
  - load average: 약 `13~15`
  - memory: `64GiB` 중 used 약 `31GiB`, available 약 `33GiB`
  - `happy-cli daemon start-sync` PID `920402`, uptime 약 `7h+`
  - daemon 자체 순간 CPU는 약 `0~1%`
  - `top` 순간 CPU는 user 약 `24%`, system 약 `40%`, idle 약 `34%`
  - Happy daemon 자식 session wrapper와 그 자식 `claude`/`codex app-server`가 누적 CPU를 사용
  - `pgrep` 10초 샘플에서 `__APLUS_SERVICE_LISTEN`, `docker ps`, `/home/coder/.local/bin/saycode-status`가 반복 생성됨
  - 첫 process snapshot에서 `npm list`가 `92.9%` CPU로 관찰되었고, 이는 `saycode-status`의 CLI version 조회 경로와 일치한다.
  - `/home/coder/.local/bin/saycode-status`는 매 호출마다 Python subprocess로 `npm list -g --depth=0 --json`를 실행해 `@namsangboy/happy-cli` 버전을 찾는다.
  - `/home/coder/.happy`는 약 `193MB`, 현재 daemon log는 약 `40MB`

## Key Code References

- `packages/happy-cli/src/api/apiSession.ts`
  - 5초 receive polling
  - keepAlive에서 daemon runtime report
- `packages/happy-cli/src/api/apiMachine.ts`
  - 20초 machine keep-alive
  - CLI availability/resume support 재탐지
  - preview proxy socket event
  - remote terminal relay
- `packages/happy-cli/src/daemon/daemonTerminalSessions.ts`
  - terminal idle timer reset
- `packages/happy-cli/src/daemon/previewProxy.ts`
  - 50MiB body buffering/base64 response
- `packages/happy-server/sources/app/api/routes/previewRoutes.ts`
  - response body decode/rewrite
- `packages/happy-server/sources/modules/preview/rewriteHtml.ts`
  - HTML/JS/CSS regex rewrite
- `packages/happy-server/sources/app/api/socket/rpcHandler.ts`
  - RPC lookup/presence polling
- `packages/happy-server/sources/app/api/socket/sessionUpdateHandler.ts`
  - session-alive validation, DB update queue, ephemeral broadcast
- `packages/happy-server/sources/app/events/eventRouter.ts`
  - user-scoped ephemeral broadcast fan-out
- `packages/web-ui/src/lib/sync/runPreviewContainerRemote.ts`
  - remote preview/container status polling, host listener checks, Docker registry cache
- `packages/web-ui/server/specFileRemote.ts`
  - remote spec list/read shell command generation
- `packages/web-ui/server/machineUnion.ts`
  - machine resource fallback JSON probe command generation
- `/home/coder/.local/bin/saycode-status`
  - Happy CLI version 조회를 위해 `npm list -g --depth=0 --json` 실행

## Decision Notes

- SSH 머신 CPU 관점의 1차 최적화 대상은 `happy-cli` 자체라기보다 `happy-cli`를 통해 반복 실행되는 A+ caller/status 명령이다.
- Happy daemon 단일 프로세스는 현재 실측에서 CPU-heavy로 보기 어렵다.
- `happy-server` 최적화는 Kubernetes pod CPU에는 효과가 있을 수 있지만, SSH 머신 CPU 문제에는 직접적인 효과가 작다.
- Prod 실측 기준 서버 1순위는 preview가 아니라 session-alive fan-out/throttle이다. 다만 이는 SSH 머신 최적화와 별도 우선순위다.
- `saycode-status`의 `npm list`는 저위험 고효과 후보로 보인다. 기능적으로는 CLI version 표시만 필요하므로 TTL cache 또는 package metadata direct read로 대체 가능하다.
- remote preview/status polling은 이미 일부 최적화가 들어갔지만, 현재 `main.axstudio-4.ryan.coder`에서는 여전히 여러 UI/status surface가 동시에 같은 상태 확인 스크립트를 만들 수 있다.
- 현재 문서 작성 단계에서는 코드 수정과 테스트 실행을 하지 않았다.
