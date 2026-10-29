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
- daemon은 launch에 capability pipe를 붙이지 않고(stdio·env 그대로), `/caller-binding`은 403,
  `/caller-binding/current`는 `{current:false}`, `agent-caller-binding`은 owned journal 밖에서 기존과 같은
  `caller-unavailable`이다.
- daemon만 켜지고 host 스위치가 꺼져 있으면 host는 받은 capability를 읽어 닫기만 하고 버린다.

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
| `daemon/controlServer.ts` `/caller-binding`·`/caller-binding/current`, `controlClient` | 발급(launch capability 필수)과 현재 binding 확인. managed runtime은 거부 |
| `daemon/run.ts` spawn 경로 | launch마다 capability를 추가 stdio pipe로 넘긴다 |
| `claude/utils/startHappyServer.ts` | Claude/Codex/ACP/Gemini가 공유하는 provider 시작 전 지점에서 연결 |

- **키 custody**: host가 provider 시작 전에 Ed25519 키를 만들고 공개키와 실제
  `ApiSessionClient.runtimeId`·sessionId·`process.pid`만 daemon에 보낸다. 비밀키는 host closure에만 있다.
  daemon이 machineId·happyAccountId(account profile)·scope·depth·callerBindingId·hostEpoch를 채운다.
  보고에 scope/depth 등 추가 필드가 있으면 거부한다.
- **launch 인증(H2-R-01)**: daemon은 spawn마다 32바이트 capability를 만들어 추가 stdio pipe 하나에 한 번
  쓰고 닫는다. env에는 descriptor 번호(`HAPPY_OWNER_CONTACT_FD`)만 있다. host는 startHappyServer에서
  provider보다 먼저 이를 읽고 닫으며 변수도 지운다. `/caller-binding`은 그 pid에 발급한 capability와
  상수 시간 비교로 일치할 때만, 한 번만 받는다. control secret만 가진 프로세스나 다른 launch의 capability는
  거부된다. capability 기록은 daemon 메모리에만 있어 daemon 재시작 뒤 복구된 host는 binding을 받지 못한다
  (fail-closed). tmux·Windows trial 경로에는 pipe를 붙이지 않아 같은 이유로 unavailable이다.
- **scope·depth(H2-R-02)**: spawn 요청 env의 `SAYCODE_AGENT_*`는 형식만 검사된 요청 값이므로 근거로 쓰지
  않는다. 요청에 agent grant(`SAYCODE_AGENT_ENV=1`)가 없는 launch만 daemon이 정한 값으로 발급한다:
  depth 0, scope는 daemon이 실제로 띄운 cwd의 realpath. agent grant가 있는 launch는 lineage를 daemon이
  확인할 수 없으므로 `caller-lineage-unknown`으로 소유 확장만 unavailable이다. 기존 provider env 전달은
  그대로다. depth≥1 binding은 daemon이 기록한 owned lineage(H3)에서만 생긴다.
- **현재 binding 확인(H2-R-03·R-06)**: host는 서명 전·전송 후·응답 채택 전 각 단계에서 daemon
  `/caller-binding/current`로 자기 callerBindingId가 아직 현재인지 확인한다. 재개로 교체되었거나 launch가
  끝났으면 만료 전 contact가 남아 있어도 서명·전송·응답 채택을 하지 않는다. 확인 실패는 "현재 아님"이다.
  current와 `agent-caller-binding` 조회는 같은 울타리를 쓴다: 발급 당시 machine/account/등록 epoch와 현재
  identity가 다르거나 identity 조회가 실패하면 binding을 폐기하며, identity가 돌아와도 되살리지 않는다.
  daemon은 token별 account id 확인값만 기억하고 등록 상태는 매번 다시 읽는다.
- **세션 경계의 env(H2-R-05)**: `SAYCODE_OWNER_CONTACT_*`는 session-scope(같은 세션의 agent CLI까지만),
  `HAPPY_OWNER_CONTACT_FD`는 spawn-seed로 분류해 새 세션 경계에서 지운다. host bootstrap은 capability 없음·
  managed·스위치 off를 포함한 모든 경로에서 broker 시작 전에 상속 주소를 지운다. 스위치
  `HAPPY_OWNER_CONTACT_V1`은 daemon 설정이므로 그대로 전달된다. 요청 env는 기존 sanitizer가
  `HAPPY_`/`SAYCODE_` 접두어를 이미 막는다.
- **webhook 순서**: Claude는 session-started 보고가 이 지점보다 늦을 수 있다. 발급은 launch pid로 하되
  launch가 다른 sessionId를 이미 갖고 있으면 거부한다. 조회는 webhook이 같은 sessionId를 확정한 뒤에만
  답하며, 확정 전은 `caller-pending`(binding 유지), 다른 세션·종료·계정 변경은 폐기다.
- **lookup 제한**: 목적지는 daemon trust의 Studio origin뿐이고 요청 body는
  `{machineId, callerBindingId, hostEpoch}`로 고정이다(A+ `relays/lookup`). bearer는 host 프로세스의
  Happy credential이며 CLI/provider/로그로 나가지 않는다. `currentContact`는 같은 lookup이 서명된 동일
  contact를 계속 돌려주는지로 등록·철회를 재확인한다.
- **broker entry 정책(H2-R-04)**: main은 broker와 직접 경로를 구분할 수 없으므로 §2.3의 "broker agent
  형제 확장은 depth 0"을 host가 집행한다. depth≥1 binding의 broker IPC에서 `entry:'agent'`의 형제·부모
  조회·변경(lookup/read/prompt/resume/permission/abort)은 lookup 전에 거부한다. 자기 자식 연산
  `spawn-owned-child`·`owned-child-status`는 형제 확장이 아니므로(§4.6) main 판정으로 보낸다. 직접 경로와
  `entry:'chat'`은 모든 depth를 main 판정에 맡긴다.
- **직접 경로**: broker가 없으면 owner-only Unix socket(`sessionOwnerContactLocal`)을 열고 주소만
  `SAYCODE_OWNER_CONTACT_SOCKET`으로 provider env에 둔다. 상속된 주소는 먼저 지운다. 종료 시 binding 폐기,
  소켓·env 제거.
- 기존 broker protocol `{version:1,argv}`, broker ownership IPC, 기존 read/후손 분기는 변경하지 않았다.

## 남은 것 — H2 밖이거나 이 변경으로 완료되지 않은 것

- D1 main receiver·contact 등록, A+ 실서버와의 실제 왕복은 검증하지 않았다(fake port). source-DEK RPC
  params/result 형식은 기존 session RPC 규약(base64 암호문)을 따랐으며 D1이 같은 형식으로 받아야 한다.
- 터미널에서 직접 띄운 host, daemon 재시작 뒤 복구된 host, agent grant로 띄운 비소유 자식은 binding을
  받지 못한다(fail-closed). 비소유 자식의 own 확장은 daemon이 lineage를 직접 기록하는 별도 작업이 필요하다.
- capability pipe는 host가 읽기 전 짧은 구간에 같은 OS 사용자의 다른 프로세스가 `/proc/<pid>/fd`로 읽을
  수 있다. 기존 scope-report pipe와 같은 잔여 위험이며 신뢰 경계 (ii) 밖이다. 이때 host는 capability를 못
  받아 binding이 없다. 실제 OS pipe로 daemon→host를 잇는 통합 테스트는 하지 않았다(양쪽 단위 테스트).
- mandatory/wrapped sandbox provider가 local socket에 접근할 수 있는지(AF_UNIX seccomp 등)와 Windows pipe는
  미구현이다. 해당 직접 경로 provider에서는 own 확장이 unavailable이다.
- owned child의 daemon 보유 binding을 child host에 넘기는 일은 H3다. 이 변경은 journal 세션의 기존
  `agent-caller-binding` 응답을 바꾸지 않는다.
- rollout(스위치 ON)은 T2r 활성화 체크리스트에서 다룬다.

## 검증

`pnpm exec vitest run --project unit`(3.2.4, 빌드 포함), Happy 세션의 `SAYCODE_*`·`HAPPY_*`·`APLUS_*` 변수를
제거한 env에서 관련 19파일만 실행했다. 결과 숫자는 커밋 메시지와 보고에 둔다.
`NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit` 통과.

- 그 변수를 제거하지 않으면 startHappyServer 테스트 11건이 HEAD에서도 실패한다(코드 변경과 무관).
- 1차 역검증 6건: 첫 보고 우선, host live 검사, 스위치 off, broker entry 정책, agent-caller-binding fallback,
  daemon depth 고정.
- 교차 리뷰(H2-R-01~04) 역검증 6건: capability 비교, capability 일회성, lineage 거부, daemon 현재 binding
  확인, 자식 연산 통과, 스위치 off에서도 capability 소비. 각각 되돌리면 해당 테스트가 실패하고 복원 후 통과했다.
- 확인 재리뷰(H2-R-05·06) 역검증 6건: 조기 반환 전 주소 삭제, 두 env 분류, current의 identity 비교와 폐기,
  query의 identity 조회 실패 폐기.

이전 부분 구현(63195d7b, 27e5490d)의 내부 port·broker private IPC·local transport는 그대로 재사용했다.
그 커밋의 local transport 15건은 지휘 세션 셸에서 실소켓으로 통과했다.
