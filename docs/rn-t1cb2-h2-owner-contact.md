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
- **broker IPC 표시(D2-R4-01)**: broker는 시작 시 env를 복사하고 socket 주소는 broker 시작 뒤에 정해지므로,
  broker가 띄운 CLI에는 `SAYCODE_OWNER_CONTACT_SOCKET`이 없다. 그래서 broker executor는 이 host가 owner
  contact를 넘겼을 때만 CLI 자식 env에 `SAYCODE_OWNER_CONTACT_BROKER_IPC=1`을 넣고, 상속된 같은 이름은 먼저
  지운다(스위치 off·capability 없음·managed면 넣지 않음). session-scope라 새 세션 경계에서 지워진다.
  Desktop CLI는 socket env가 없을 때 이 값이 `'1'`이고 broker 진입(`__agent-broker-v1`)의 IPC 채널이 연결된
  경우에만 broker IPC로 owner 요청을 보낸다. 표시가 없으면 IPC를 보내지 않아 구 broker에서 기다리지 않는다.
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
- **broker 옆 chat 진입(D2 사전 보완)**: broker가 있어도 같은 owner-only socket을 열지만 chat verb만 받는다.
  아래 "D2 사전 보완 — broker 모드의 chat 진입" 절 참조.
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

## wire 정렬: 기존 session-DEK RPC binding (2026-10-30, D1 착수 중 발견)

p0a §4.5는 owner relay wire에 기존 RPC의 암호화·method/scope/nonce 규칙을 재사용하라고 정한다. 그런데 처음 구현한
`ApiSessionClient.callOwnerRelay`는 요청 본문을 그대로 암호화했고, legacy 키 세션에서도 보냈다. D1(Desktop main 수신)을
시작하면서 이 어긋남을 확인해 바로잡았다.

- 요청은 happy-wire `bindRpcRequest`로 `{rpcBinding:1, method, scope: source 세션 id, issuedAt, nonce(16바이트), params}`를 만들어
  source 세션 DEK로 암호화한다.
- 응답은 `readBoundRpcResponse`로 같은 nonce의 `{rpcBinding:1, nonce, result}`만 받는다.
- DEK가 없는(legacy) 세션은 owner relay를 쓸 수 없다(`owner-relay-unavailable`, 송신 0회). account legacy 키를 대안으로 쓰지 않는다.
- 수신 측(Desktop main D1)은 contact의 hubId로 source 세션 DEK를 정하고, 같은 envelope의 method·scope·issuedAt 창·nonce 일회성을 검사한다.

## D2 사전 보완 — broker 모드의 chat 진입 (2026-10-30)

Desktop D2 사전 연결 검토 2항: broker가 있으면 socket을 만들지 않아, provider가 따로 실행한 credential 없는
`saycode chat -s`가 owner relay에 닿을 수 없었다. p0a §2.3 "agent 환경 일반 chat, 모든 경로" 행과 §5.1("credential을
읽을 수 없는 broker 환경도 §4.4 local port로 접속")을 따라 broker가 있을 때도 owner-only socket을 연다.

- **socket은 chat verb만 받는다.** `entry:'agent'`는 503으로 거부한다(agent 명령은 기존처럼 broker IPC와 그 depth
  정책만 쓴다). `spawn-owned-child`·`owned-child-status`도 거부한다. owned child는 broker가 예약에서 ID를 고정하는
  연산이고(§4.5·§4.6), §5.1의 chat verb(조회·입력·resume·permission·abort)에 생성은 없다. steer/stop은 wire에 없으므로
  넓어지지 않는다. 자기 대상 거부(self-target)는 main이 판정한다.
- **depth≥1 broker 모드의 chat lookup은 거부한다.** 판단: §2.3 chat 행은 "모든 경로"에서 read ACL 안 own 조회를
  허용하고 §4.5는 "agent 환경 chat의 own 허용은 모든 depth"라고 한다. 반면 §2.3 A3 문단은 "broker depth ≥1의 형제
  비노출 등 원래 read 제한은 유지한다"고 하고, §4.5 lookup 문단은 "broker 하위 agent 명령의 형제 비노출 같은 경로
  제한은 유지한다"고 한다. 같은 provider가 `chat`으로 lookup하면 agent 명령에 막힌 형제 열거를 다시 열 수 있는데,
  계약은 이 경우를 명시하지 않는다. 그래서 지휘 결정대로 더 좁은 쪽을 구현했다: depth≥1 broker host의
  `entry:'chat'` `lookup-readable-sessions`는 lookup 전에 거부한다. 우회 경로가 없도록 **broker IPC의 chat entry에도
  같은 규칙을 적용**했다(기존 H2 테스트의 "depth≥1 broker IPC chat lookup 허용" 기대를 바꿨다). 명시한 target의
  read/prompt/resume/permission/abort는 main 판정으로 보낸다(own은 모든 depth). depth 0과 직접 경로는 바뀌지 않는다.
- **수명주기**: socket에 넘기는 contact는 binding을 폐기하지 않는다. socket이 시작에 실패하거나 먼저 닫혀도 broker가
  쓰는 binding은 남고, binding 폐기는 host 종료(`close`)가 한 번 한다. 종료 시 env의 주소를 지우고 socket을 닫는다.
  상속 주소 삭제(H2-R-05), 스위치 off·managed·capability 없음에서 socket·env 변경 없음은 기존과 같다.
- 기존 broker protocol `{version:1,argv}`와 broker ownership IPC는 바꾸지 않았다.

남은 것: provider sandbox(mandatory/wrapped)가 socket에 접근할 수 있는지는 기존 직접 경로와 같은 미확인이다.
실제 broker host를 띄운 별도 CLI 프로세스의 왕복은 D2(Desktop CLI 소비자)에서 검증한다.

검증: `sessionOwnerContactHost.test.ts`의 `[D2pre-C]` 4건 추가, 기존 1건(broker에 socket 없음 → chat socket)과
depth≥1 broker 테스트의 chat lookup 기대를 갱신했다. 구현 전 2건 실패(socket 없음, depth≥1 chat lookup 허용).
역검증 3건: depth≥1 chat lookup 규칙, socket contact의 binding 비폐기, socket의 chat-only 검사를 각각 되돌리면 해당
테스트 1건씩만 실패했다. 관련 7파일(`sessionOwnerContactHost/Local/Contact`, `sessionAgentBroker`, `startHappyServer`,
`childEnv`, `agentCallerLaunches`의 `.test.ts`) 159건 통과·1건 기존 skip, `tsc --noEmit` 통과. 실소켓 테스트는 이 세션
셸에서 listen이 가능해 직접 실행했다.

## operation별 Desktop 고정 (2026-10-31, D4 교차 리뷰 R3-02)

p0a §4.5 다중 Desktop 단락: "유효 contact 하나를 operation 시작 시 선택·고정하고, timeout에 다른 instance로
재송신하지 않고 기존 operation/localId를 조회한다". 이전 `call()`은 호출마다 lookup 후 desktopInstanceId 정렬 첫
contact를 골라, spawn은 desktop-z로, 뒤에 후보로 추가된 desktop-a가 앞서면 같은 operation의 status는 desktop-a로
갔다. Desktop main의 생성 journal·localId 중복 판정은 instance별이라 원래 Desktop의 결과를 회수할 수 없었다.

- **키는 wire에 이미 있는 값이다.** `spawn-owned-child`·`owned-child-status`는 `payload.operationId`,
  `prompt-own-session`은 `(targetSessionId, localId)`. wire(schema·fixture)는 바꾸지 않았다.
- **고정 시점은 실제 송신 직전이다.** 처음 고른 instance를 기록하고, exchange를 시작하면 그 기록이 확정된다.
  timeout·응답 검증 실패 뒤에도 확정 기록은 남는다. lookup·`currentContact`·서명 단계에서 실패해 어느 Desktop에도
  보내지 않았으면 기록을 지워, 다음 시도는 기존 규칙으로 고른다. 같은 operation의 동시 호출은 진행 중 기록을 공유한다.
- **고정 Desktop이 유효 contact가 아니면 `owner-contact-unavailable`이다.** 철회·만료·서명 불일치·`currentContact`
  거짓이면 다른 후보가 있어도 보내지 않는다. 호출자는 같은 operation으로 나중에 다시 조회한다. 같은 instance의
  갱신된 contact(새 epoch)는 그대로 쓴다. 새 Desktop으로 재결속하지 않는다.
- **기록은 contact(binding) 수명 동안 host 메모리에만 있다.** broker IPC와 chat socket은 같은 contact를 쓰므로
  기록을 공유한다.
- **송신했지만 끝나지 않은 operation은 지우지 않는다(PIN-R1-01).** RPC 하나가 끝났다고 Desktop의 operation이 끝난
  것은 아니다. 지운 키를 다시 보면 과거 operation인지 알 수 없어 새 후보에 재결속하게 되므로, 기록은 검증된 응답에서
  종결을 관측했을 때만 정리 대상이 된다. 종결은 `allowed` 응답의 prompt 저장 receipt뿐이다.
  `pending`·`parked`, `unknown`·`unavailable`·`not_owned`, timeout, 응답 검증 실패는 종결이 아니다. `localid_conflict`는
  wire에 별도 결과가 없어(불일치는 `unknown`) 종결로 보지 않는다.
- **owned child의 기록은 host 수명 동안 남긴다(PIN-R2-01).** host가 `started`·`failed`를 검증했어도 그 receipt가 CLI에
  닿았는지, CLI가 lineage를 기록했는지는 모른다(local socket이 먼저 닫히면 receipt는 버려진다). 이를 회수하는 status·
  `--resume-op`에 답할 수 있는 것은 원래 Desktop의 생성 journal뿐이므로, `spawn-owned-child`·`owned-child-status` 기록은
  종결 응답 뒤에도, 24시간이 지나도 정리하지 않는다.
- **prompt 저장 receipt는 종결로 본다.** Desktop main은 같은 localId 재시도에서 먼저 target 세션의 서버 메시지를 localId로
  찾아(`existing()`) 본문을 비교한 뒤 저장 receipt나 `localid_conflict`를 돌려준다. 저장 행은 서버에 있으므로 receipt를
  잃은 뒤의 재시도가 다른 유효 Desktop으로 가도 같은 receipt를 받고 다시 저장하지 않는다. 그래서 저장 receipt 뒤의
  prompt 기록은 정리해도 된다. receipt가 없는 prompt(unknown·timeout 등)는 원래 Desktop의 시도 기록이 판단에 쓰이므로
  남긴다.
- **정리와 상한(PIN-R1-02).** 상한은 512건이다. 근거: Desktop CLI의 spawn 예산은 host(세션)당 6시간 창에 최대
  32건(`cli/domain/spawnBudget.ts`의 `AGENT_SPAWN_BUDGET_MAX`·`SPAWN_BUDGET_WINDOW_MS`)이라, 정리되지 않는 child 기록만으로
  상한을 채우려면 최대 예산으로 쉬지 않고 4일(하루 128건)이 걸린다. 종결된 prompt는 정리되므로 상한을 차지하는 것은
  child와 receipt 없는 prompt다. 항목 하나는 수백 바이트라 메모리는 문제가 아니다. 새 키를 넣을 때 진행 중이 아닌 종결 항목만, 마지막 사용 뒤 24시간이
  지났거나 상한에 닿은 경우 오래된 것부터 지운다. 미송신 항목은 마지막 호출이 끝날 때 지워진다. 정리한 뒤에도 상한이면
  새 operation은 송신 없이 `owner-contact-unavailable`이고, 이미 기록된 operation의 호출은 계속 받는다. 호출의 정리는
  작업이 끝날 때와 20초 기한이 끝날 때 중 먼저 오는 쪽에서 한 번 한다. adapter가 abort를 무시해 작업이 끝나지 않아도
  진행 중 수가 남지 않는다. 기한이 지난 뒤의 작업은 송신 전 abort 검사에 걸려 보내지 않는다.
- **한계: host 재시작·재개 뒤에는 기록이 없다.** 새 binding의 첫 호출은 기존 정렬 규칙으로 고르므로, 그 사이 정렬상
  앞선 Desktop이 생겼으면 이전 operation의 status가 그 operation의 journal이 없는 Desktop으로 갈 수
  있다. 정리는 저장 receipt를 받은 prompt만 지우므로 host 수명 안에서는 이 재결속이 생기지 않는다. 그 대가로 child와
  receipt 없는 prompt가 512건 쌓이면 그 host의 새 spawn·prompt는 host 재시작 전까지 unavailable이다. 4일 넘게 최대
  예산으로 spawn하는 host가 실제로 있으면 상한을 다시 본다. 영속 기록이나 Desktop 정보를
  wire·CLI journal에 싣는 일은 wire 변경이라 하지 않았다.
- **고정하지 않는 operation**: `lookup-readable-sessions`·`read-session`은 instance별 journal 없이 현재 상태를 읽는
  조회라 어느 유효 Desktop이 답해도 같다. `resume-own-session`·`reply-own-permission`·`abort-own-turn`은 wire에
  operation 식별자가 없어 호출 하나가 operation 하나이고, 결과 unknown 뒤에는 같은 요청을 다른 Desktop에 재송신하는
  대신 호출자가 read로 상태를 확인한다. target만으로 묶으면 무관한 operation까지 한 Desktop에 묶이므로 키로 쓰지 않는다.

검증: `sessionOwnerContact.test.ts`에 5건(spawn→status 고정, 고정 Desktop 철회 시 다른 Desktop 0회·복구 후 같은
Desktop, prompt 같은 localId 재시도 고정·다른 localId는 새 선택, 다른 operation·다른 operationId 영향 없음, 미송신
선택은 고정하지 않음). 구현 전 앞의 3건 실패. 역검증 3건: 송신 확정 표시를 지우면 고정 3건, 고정 instance 대신
첫 후보로 failover하면 철회 테스트, 미송신 기록 삭제를 지우면 미송신 테스트가 각각 실패했다. `sessionOwnerContact`·
`sessionOwnerContactHost`·`sessionOwnerContactLocal` 테스트 68건 통과, `tsc --noEmit` 통과.

PIN-R1 반영 검증: 6건 추가. 상한을 채운 다른 operation 뒤에도 pending operation 고정 유지, 24시간 뒤 timeout operation
고정 유지, 종결 child·prompt receipt만 정리 대상, 모든 칸이 미종결이면 새 operation 거부·기존 operation 허용, abort를 무시한
adapter에서 기한 뒤 미송신 선택 해제. 상한 테스트는 `pinLimit` 주입(8)으로 같은 경계를 빠르게 검증한다(기본 512). 기한을
fake timer로 검증하려고 `AbortSignal.timeout`을 해제되는 일반 timer로 바꿨다(별도 구조 커밋). 구현 전 4건 실패.
역검증 6건: 정리의 종결 조건 제거, 상한 거부 제거, 기한 경로의 해제 제거, child 종결 판정을 항상 거짓·항상 참으로,
prompt 종결 판정을 거짓으로 바꾸면 해당 테스트가 각각 실패했다. 관련 3파일 74건 통과, `tsc --noEmit` 통과.

PIN-R2 반영 검증: fixture를 Desktop별 생성 journal로 나눴다. journal이 없는 Desktop의 status는 `unknown`
(`operation-not-found`)이고, 저장 prompt는 서버 공유다. 이전 "종결 뒤 정리되면 다른 Desktop으로 간다" 테스트는 "started 검증
뒤 receipt 유실 → 25시간 경과·다른 키(상한의 두 배)로 압박 → 같은 operation status가 원래 Desktop에서 `started`"로 바꿨다.
prompt receipt 테스트는 정리 뒤 다른 Desktop에서 같은 receipt를 받는지까지 확인한다. 공유 상태로 상한을 채우던 테스트는
압박 키를 종결 prompt로 바꿨다. 구현 전 새 테스트 1건 실패. 역검증 3건: child 종결을 다시 정리 대상으로, prompt 종결을
거짓으로, 정리의 종결 조건 제거를 각각 넣으면 해당 테스트가 실패했다. 관련 3파일 74건 통과, `tsc --noEmit` 통과.

PIN-R3 반영(#1031 리뷰 `pin-table-filled-by-receipt-less-prompts`): Desktop에 아무것도 남기지 않는 응답도 종결로 본다.
검증된 `not_owned` prompt는 저장 전에 거부된 것이고(p0a §5.1), 이 host가 spawn을 보낸 적 없는 operation의
`owned-child-status`가 `allowed`가 아니면 회수할 journal이 없다. 이전에는 둘 다 기록을 남겨, 다른 소유자의 형제에게
새 localId로 prompt가 512번 거부되면(prompt에는 예산이 없고 `--local-id` 생략 시 매번 새 UUID) 그 host의 새 spawn·prompt가
재시작 전까지 unavailable이었다. 같은 operationId로 spawn을 보내면 그 기록은 다시 미종결이 되어 host 수명 동안 남는다.
`unknown`·`unavailable` prompt와 timeout은 원래 Desktop의 시도 기록이 판단에 쓰이므로 그대로 남긴다. 검증: 3건 추가
(거부 prompt로 상한의 두 배를 채운 뒤 prompt·spawn 허용, spawn 없는 status로 채운 뒤 spawn 허용, unknown status 뒤 spawn한
child의 고정 유지). 구현 전 앞의 2건 실패. 역검증 2건: `not_owned` 종결 제거, spawn 송신 시 미종결 복원 제거가 각각 해당 테스트를
실패시켰다.
