# T1c-b2 H3 owned child contact — child host 자기 binding·중복 start 방지·재시작 복구

2026-10-31. H2(`docs/rn-t1cb2-h2-owner-contact.md`)의 launch binding과 T4rt owned spawn
(`docs/rn-t4rt-creation-proof.md`)을 잇는다. Desktop `specs/reason-network-adoption/p0a-contract.md`
§4.5 끝·§4.6을 따른다. happy-wire H1 schema/fixture와 기존 machine RPC 이름은 바꾸지 않았다. Desktop의
spawn/status relay 실행(D4)은 범위 밖이다.

## 문제

H2까지는 owned child에 binding이 두 개 생길 수 있었다. owned start가 daemon 메모리에 key를 가진 binding을
만들어 `agent-caller-binding`으로 답하고, 같은 child host는 provider 시작 전에 H2 launch binding(자기 key)을
따로 받았다. main이 조회하는 binding과 contact에 서명하는 key가 달랐다. 또 launch binding은 depth 0이거나
(요청에 agent grant가 있으면) `caller-lineage-unknown`이라서 owned child가 자기 depth를 가질 수 없었고,
depth 0 H2 host를 부모로 둔 owned child는 부모 조회(daemon registry만 봄)에서 실패했다.

## 스위치 — 기본 OFF, OFF는 기존과 같다

host custody는 `HAPPY_OWNER_CONTACT_V1=1`이고 daemon trust(H2 `readOwnerContactTrust`)가 있으며 Windows
trial launch가 아닐 때(`agentCallerLaunches.available()` + run.ts의 `!standaloneWindows`)만 켜진다.
꺼져 있으면:

- owned start는 기존처럼 daemon key binding을 만들고 `agent-caller-binding`도 기존과 같다.
- `owned-spawn-capabilities` 응답은 정확히 `{ ownedSpawnPrepareV1 }`이다(새 필드 없음).
- run.ts는 launch마다 owned lineage를 조회하지 않는다(`ownedLaunchLineage`가 null).

스위치는 켜졌지만 trust가 없으면 기존 daemon key binding으로 돌아간다(H2 issue가 어차피 거부한다).

## custody는 start 때 journal에 고정한다 (교차 리뷰 R1-01)

host/daemon 중 누가 caller key를 갖는지는 start를 제출할 때 정해 journal `callerCustody`에 `starting`과 함께
쓴다. 그 뒤 status·start·commit·`agent-caller-binding`·resume lineage는 모두 **저장된 custody**를 따르며 그
시점의 trust·스위치를 보지 않는다. 처음 구현은 `record.caller` 유무와 현재 trust로 경로를 골라, 재시작하며
trust가 바뀌면 host custody 작업에 daemon key가 생기거나 receipt의 caller와 runtimeId가 어긋났다.

- **host custody**: 재시작·trust 제거 뒤에도 daemon key를 만들지 않는다. child binding이 없으면 `starting`이
  유지되고 `agent-caller-binding`은 `caller-unavailable`이다(launch binding 조회만 한다).
- **daemon custody**: 나중에 trust가 생겨도 daemon custody로 다룬다. 재시작 뒤 status는 기존 T4rt처럼 daemon
  binding을 다시 만들어 `started`로 회수하고, receipt의 `caller`도 그 binding으로 함께 갱신한다. 이 세션의
  launch에는 `'unknown'` lineage를 줘서 host가 같은 세션에 두 번째(host 보유) binding을 받지 못하게 한다.
- **`adopt`**: started는 시작된 runtime의 caller가 있고 그 runtimeId·세션·intent machine/account가 모두 맞을
  때만 기록한다. caller 없는 결과는 started가 될 수 없다(daemon custody도 binding을 함께 돌려준다).
- `callerCustody`가 없는 H3 이전 기록은 daemon custody다. 새 필드가 있는 기록은 이 필드를 모르는 이전
  daemon의 strict schema가 읽지 못한다(스위치 기본 OFF라 rollout 전에는 생기지 않는다).
- definite pre-dispatch 거절(`OwnedStartRefused`)은 custody도 지워 다음 start가 다시 정한다.

## host custody launch는 tmux를 쓰지 않는다 (교차 리뷰 R1-02)

tmux launch에는 launch capability pipe가 없어 child host가 binding을 받을 수 없었다. host custody로 제출한
start의 launch 옵션은 daemon 내부 `pipeOnlyLaunch`로 표시되고, run.ts는 `TMUX_SESSION_NAME`이 있어도 이
launch를 일반 spawn(pipe 있음)으로 띄운다. tmux에 같은 handoff를 만드는 것은 이 범위가 아니다.

**사용자에게 보이는 차이**: tmux 프로필(`TMUX_SESSION_NAME`)을 쓰는 머신에서 스위치 ON·trust 있음일 때,
owned child는 tmux 창에 뜨지 않고 일반 백그라운드 프로세스로 실행된다. 앱의 세션 표시·제어는 같다.
daemon custody(스위치 OFF 포함)와 owned가 아닌 spawn의 tmux 동작은 바뀌지 않는다.

## 구성과 결정

| 구성 | 책임 |
|---|---|
| `ownedSpawnRuntime.ts` `lineageOf`·`caller` | owned start 시점에 journal과 부모의 **현재** binding에서 depth/scope를 정해 메모리에 예약. daemon key를 만들지 않는다 |
| `ownedSpawnRuntime.ts` `launchLineage` | daemon 내부 전용(RPC 아님). 예약 또는 journal의 기록된 `caller`로 그 세션 launch의 lineage를 준다 |
| `run.ts` `spawnTrackedHappyProcess` | resume target/reconnect session id로 lineage를 조회해 `prepareLaunch({ owned })`에 넘긴다 |
| `agentCallerLaunches.ts` `prepareLaunch`·`issue` | owned launch는 daemon이 정한 depth/scope로 발급. 다른 세션 보고, key 재사용, 같은 세션의 두 번째 live host를 거부 |
| `agentCallerLaunches.ts` `available`·`currentCaller` | host custody 가능 여부, owned start가 기다리는 child binding(기존 query와 같은 울타리) |
| `ownedSpawn.ts` `adopt` | started는 이 세션·intent machine/account에 결속되고 runtimeId가 일치하는 caller가 있을 때만 기록 |
| `ownedSpawn.ts` `callerCustody` | start 제출 때 custody를 journal에 고정 |
| `ownedSpawnRuntime.ts` `pipeOnlyLaunch`, `run.ts` tmux 분기 | host custody launch는 tmux 대신 pipe 있는 spawn |

- **provider 시작 경계에서 자기 binding**: host custody에서 owned start는 `caller`를 null로 두고(daemon key
  없음) provider를 띄운다. child host는 H2와 같은 launch capability pipe로 provider 시작 전에 자기 key의
  공개키와 실제 runtimeId를 보고하고, daemon은 예약된 owned lineage(depth = 부모 depth + 1, scope = 부모
  scope)로 발급한다. 요청 env의 agent grant는 owned lineage가 있으면 근거로 쓰이지 않는다.
- **started의 의미**: provider가 시작되고(webhook) 그 child host가 자기 binding을 받았을 때만 `started`이며,
  `providerRuntimeId`는 child host의 실제 `ApiSessionClient.runtimeId`, journal `caller`는 child host의 binding이다.
  start는 binding을 최대 5초 기다린다(main의 start RPC deadline 20초 중 webhook 대기가 이미 쓴 시간을 고려).
  그 안에 없으면 `starting`으로 답하고 status가 나중에 회수한다. provider를 다시 띄우지 않는다.
- **부모 contact 재사용 거부**: (1) owned launch의 보고가 예약된 child 세션이 아니면(부모 세션 포함) 거부,
  (2) 부모 binding의 공개키나 이미 발급된 다른 launch의 공개키를 다시 보고하면 `caller-key-reused`,
  (3) owned runtime은 lineage(depth·scope·부모 key 아님)와 맞지 않는 binding을 started 근거로 쓰지 않고,
  (4) `adopt`는 다른 세션·다른 machine/account·runtimeId 불일치 binding을 거부한다. 상속된
  `SAYCODE_OWNER_CONTACT_SOCKET`은 H2대로 새 host에서 지운다.
- **부모 binding 조회**: 부모가 H2 launch(depth 0 host 포함)든 host custody owned child든 daemon이 지금도
  보증하는 binding(`currentCaller`)만 쓴다. 없거나 scope가 child directory와 다르면 launch 전에 거부한다.
- **중복 start 방지**: start는 기존처럼 operation별 직렬·journal 상태로 멱등이다. 추가로 같은 세션에 이미
  live인 daemon host가 binding을 가지고 있으면 두 번째 host의 보고를 `caller-duplicate-launch`로 거부한다.
  이전 host가 끝난 resume은 새 binding으로 교체된다(H2와 같다).
- **resume**: owned 세션의 resume launch도 journal에 기록된 depth/scope로 발급한다. depth≥1 세션이 resume으로
  depth 0이 되지 않는다. lineage를 읽을 수 없으면 `'unknown'`으로 binding을 주지 않는다(depth 0 대체 없음).
- **`agent-caller-binding`**: host custody의 owned 세션은 child host가 key를 가진 launch binding만 답한다.
  daemon이 대체 binding을 새로 만들지 않는다.
- **capability**: `ownedChildOwnerContactV1`을 `ownedSpawnPrepareV1`과 따로 광고한다(host custody일 때만 키가
  있음). 값은 같은 spawn 검사(Claude/Codex만)와 ownership trust를 따르므로 미지원 provider는 둘 다 false다.
  Happy 계정이 daemon 계정과 다르면 기존대로 prepare의 scope 검사와 `adopt`의 account 검사가 거부한다.
  Desktop은 지금 `ownedSpawnPrepareV1 === true`만 읽으므로 추가 필드는 호환된다.

## 재시작 복구

- **daemon 재시작**: launch capability와 launch binding은 daemon 메모리에만 있으므로(H2) 재시작 전에 시작된
  child host는 새 binding을 받지 못한다. 그래서 `starting`에서 재시작한 operation은 status·start·commit 모두
  기존 기록만 조회하고 `starting`으로 남는다. 새 POST·새 provider 시작·daemon key 생성은 없고,
  `agent-caller-binding`은 `caller-unavailable`이다(fail-closed). 이 세션을 다시 resume하면 journal lineage로
  새 binding을 받는다. 재시작 전에 `started`로 기록된 operation은 기록된 receipt를 그대로 돌려준다.
- **같은 daemon 안의 늦은 binding**: start가 `starting`으로 답한 뒤 child host가 binding을 받으면 다음 status가
  `started`와 그 runtimeId를 기록한다.
- **child host 재시작(resume)**: 같은 lineage로 새 binding을 받고 이전 binding은 교체된다. journal의 started
  receipt는 당시 기록이고, 현재 binding은 `agent-caller-binding`으로 확인한다(T4rt와 같은 규칙).

## 남은 것

- Desktop main의 contact 등록·relay start/status(D4)와 실제 A+/Happy 왕복은 검증하지 않았다(fake port).
- daemon 재시작 사이에 시작된 child는 resume 전까지 own 연락이 unavailable이다. 이를 복구하려면 launch
  capability를 재시작 너머로 이어야 하며 이 변경 범위가 아니다.
- 스위치를 켠 채 trust가 빠진 daemon에서 기존 daemon key binding으로 시작한 owned 세션은, 이후 trust를 넣고
  daemon을 재시작하면 `agent-caller-binding`이 `caller-unavailable`이 된다(fail-closed).
- run.ts의 lineage 전달은 타입 검사로만 확인했다. 실제 daemon→host pipe 통합 테스트는 H2와 같이 없다.
- rollout(스위치 ON)은 T2r 활성화 체크리스트에서 다룬다.

## 검증

`pnpm exec vitest run --project unit`(빌드 포함)로 관련 파일만 실행했다. 결과 숫자는 커밋 메시지와 보고에 둔다.
`NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit` 통과.

- 새 테스트: `agentCallerLaunches.test.ts` H3 7건, `ownedSpawnRuntime.test.ts` H3 10건.
- 교차 리뷰 R1 반영: `ownedSpawn.test.ts` 4건(caller 없음·runtime 불일치·세션 불일치·custody 기록),
  `ownedSpawnRuntime.test.ts` 5건(trust 제거 후 재시작, trust 추가 후 재시작 각각 status/start/commit,
  `TMUX_SESSION_NAME` owned start의 started, daemon custody의 기존 launch 선택, run.ts tmux 분기 고정).
  역검증 8건: caller 없는 adopt, custody 미기록, trust 기준 fallback, `agent-caller-binding` host 분기,
  daemon custody lineage, 낡은 receipt caller, pipe 표시, run.ts tmux 조건. 각각 되돌리면 테스트가 실패했다.
- 역검증 11건: owned depth 적용, owned 세션 검사, key 재사용, 중복 live host, unknown lineage, lineage 대조,
  host custody 선택, `agent-caller-binding`의 daemon key 차단, capability 모양, 부모 binding 조회,
  `adopt`의 세션 검사. 각각 되돌리면 해당 테스트가 실패하고 복원하면 통과했다.
