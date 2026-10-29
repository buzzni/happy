# T1c-b2 H2 owner contact — host caller bootstrap·sessionOwnerContact·local typed port

2026-10-30. H1의 wire/codec(`docs/rn-t1cb2-h1-owner-relay-wire.md`)과 Desktop
`specs/reason-network-adoption/p0a-contract.md` §2.3·§4.4–4.6·§7.1을 사용한다.
Core의 기존 인증·세션 제어 경계이며 계약과 wire는 변경하지 않았다. 원격 Desktop main(D1),
A+ 서버(A1), owned child contact handoff(H3)는 범위 밖이며 그 경계는 fake/주입 port로 검증한다.

## 스위치 — 기본 OFF

`HAPPY_OWNER_CONTACT_V1=1`을 daemon과 host 프로세스가 각각 읽는다. 스위치는 경로를 여는 것뿐이며
source·owner·scope·depth의 근거가 아니다. OFF이면:

- host(`startHostOwnerContact`)는 키 생성·daemon 보고·lookup·소켓·env 변경 없이 기존과 같은
  `startSessionAgentBroker(..., undefined)`만 호출한다. managed 세션도 같다.
- daemon `/caller-binding`은 403, `agent-caller-binding`은 owned journal 밖에서 기존과 같은
  `caller-unavailable`이다.

ON이어도 trust 설정(`HAPPY_SESSION_OWNERSHIP_ENABLED/ISSUER/AUDIENCE/PUBLIC_KEYS`, 신뢰한
`HAPPY_APLUS_STUDIO_ORIGIN`)이 없거나 daemon이 거부하면 owner relay만 unavailable이고 host·provider·
기존 read/후손 제어는 그대로 시작한다.

## 구성과 결정

| 구성 | 책임 |
|---|---|
| `daemon/agentCallerLaunches.ts` | daemon이 자신이 띄운 host(`startedBy:'daemon'`, pid 일치, 생존)에 binding을 발급하고 `agent-caller-binding`에 답한다 |
| `daemon/sessionOwnerContactHost.ts` | host가 실제 ApiSession에서 키·binding·contact·local port 수명주기를 소유한다 |
| `daemon/sessionOwnerContactNetwork.ts` | A+ relay lookup(machine 인증)과 source-DEK Happy RPC port |
| `daemon/agentCallerBinding.ts` `adoptAgentCallerBinding` | daemon 발급 binding의 host 보유 키로 H1 서명, 폐기 |
| `api/apiSession.ts` `callOwnerRelay` | 기존 `rpc-call`에 세션 키로 암호화한 1회 호출(20초) |
| `daemon/controlServer.ts` `/caller-binding`, `controlClient.requestDaemonCallerBinding` | 기존 control secret 인증 경로. managed runtime은 거부 |
| `claude/utils/startHappyServer.ts` | Claude/Codex/ACP/Gemini가 공유하는 provider 시작 전 지점에서 연결 |

- **키 custody**: host가 provider 시작 전에 Ed25519 키를 만들고 공개키와 실제
  `ApiSessionClient.runtimeId`·sessionId·`process.pid`만 daemon에 보낸다. 비밀키는 host closure에만 있다.
  daemon이 machineId·happyAccountId(account profile)·scope(`SAYCODE_AGENT_SCOPE` 또는 launch cwd의
  realpath)·depth(daemon이 admit한 `SAYCODE_AGENT_DEPTH`, 없으면 0)·callerBindingId·hostEpoch를
  자신의 launch state로 채운다. 보고에 scope/depth 등 추가 필드가 있으면 거부한다.
- **선행 고정**: 같은 launch(pid)의 첫 보고만 binding을 만든다. host는 provider보다 먼저 보고하므로
  provider가 같은 control secret으로 위조해도 두 번째 보고로 거부된다. 재개는 새 host pid이므로 새
  binding이 이전 것을 대체하고, 이전 host는 현재 contact와 binding이 맞지 않아 서명·전송하지 못한다.
- **webhook 순서**: Claude는 session-started 보고가 이 지점보다 늦을 수 있다. 발급은 launch pid로 하되
  launch가 다른 sessionId를 이미 갖고 있으면 거부한다. 조회는 webhook이 같은 sessionId를 확정한 뒤에만
  답하며, 확정 전은 `caller-pending`(binding 유지), 다른 세션·종료·계정 변경은 폐기다.
- **lookup 제한**: 목적지는 daemon trust의 Studio origin뿐이고 요청 body는
  `{machineId, callerBindingId, hostEpoch}`로 고정이다(A+ `relays/lookup`). bearer는 host 프로세스의
  Happy credential이며 CLI/provider/로그로 나가지 않는다. `currentContact`는 같은 lookup이 서명된 동일
  contact를 계속 돌려주는지로 등록·철회를 재확인한다.
- **broker entry 정책**: main은 broker와 직접 경로를 구분할 수 없으므로 §2.3의 "broker agent 형제
  확장은 depth 0"을 host가 집행한다. depth≥1 binding의 broker IPC에서 `entry:'agent'` 요청은 lookup 전에
  거부한다. 직접 경로와 `entry:'chat'`은 모든 depth를 main 판정에 맡긴다.
- **직접 경로**: broker가 없으면 owner-only Unix socket(`sessionOwnerContactLocal`)을 열고 주소만
  `SAYCODE_OWNER_CONTACT_SOCKET`으로 provider env에 둔다. 상속된 주소는 먼저 지운다. 종료 시 binding 폐기,
  소켓·env 제거.
- 기존 broker protocol `{version:1,argv}`, broker ownership IPC, 기존 read/후손 분기는 변경하지 않았다.

## 남은 것 — H2 밖이거나 이 변경으로 완료되지 않은 것

- D1 main receiver·contact 등록, A+ 실서버와의 실제 왕복은 검증하지 않았다(fake port). source-DEK RPC
  params/result 형식은 기존 session RPC 규약(base64 암호문)을 따랐으며 D1이 같은 형식으로 받아야 한다.
- 터미널에서 직접 띄운 host는 daemon launch state가 없어 발급하지 않는다(fail-closed).
- mandatory/wrapped sandbox provider가 local socket에 접근할 수 있는지(AF_UNIX seccomp 등)와 Windows pipe는
  미구현이다. 해당 직접 경로 provider에서는 own 확장이 unavailable이다.
- owned child의 daemon 보유 binding을 child host에 넘기는 일은 H3다. 이 변경은 journal 세션의 기존
  `agent-caller-binding` 응답을 바꾸지 않는다.
- rollout(스위치 ON)은 T2r 활성화 체크리스트에서 다룬다.

## 검증

`pnpm exec vitest run --project unit`(3.2.4, 빌드 포함)로 관련 15파일만 실행: **227 passed / 1 skipped**
(skip은 기존 macOS sandbox 실환경 테스트). 신규 테스트 46건: daemon 발급·trust 21, host bootstrap·wiring 16,
control route 3, ApiSession RPC 5, ownedSpawnRuntime fallback 1. 기존 contact/local/broker/controlServer/
startHappyServer/agentIdentity 테스트를 함께 실행했다. `NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit` 통과.

- Happy 세션 안에서 실행하면 셸의 `SAYCODE_MCP_BEARER`·`SAYCODE_AGENT_*`·`HAPPY_*`가 startHappyServer 테스트
  11건을 HEAD에서도 실패시킨다. 위 결과는 그 변수를 제거한 env로 실행했다(코드 변경과 무관).
- 역검증 6건: 첫 보고 우선, host live 검사, 스위치 off, broker entry 정책, agent-caller-binding fallback,
  daemon depth 고정을 각각 되돌리면 해당 테스트가 실패하고 복원 후 통과했다.

이전 부분 구현(63195d7b, 27e5490d)의 내부 port·broker private IPC·local transport는 그대로 재사용했다.
그 커밋의 local transport 15건은 지휘 세션 셸에서 실소켓으로 통과했다.
