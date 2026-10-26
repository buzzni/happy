# T4rt 생성 증명 운반·daemon 조정 (통합 대기)

2026-10-26. Desktop `specs/reason-network-adoption/p0a-contract.md` §4.2/4.4/4.6/7.1/7.2를 따른다.

## 구현

- ApiClient는 최종 암호화 snapshot을 준비하고 ownershipProof와 executionProof를 같은 생성 body에만
  운반한다. unsigned body·세션 이벤트는 유지한다. 증명/HTTP credential을 로그·오류에 담지 않는다.
- `ownedSpawn.ts`와 private `owned-spawns` journal이 creationRequestId/intent/정책/준비 snapshot을
  고정한다. commit/start 의도를 fsync 후 side effect를 보내며 응답 유실은 조회만으로 회수한다.
  unsigned 전환은 아직 POST하지 않은 prefer-owned 작업에만 허용하고 late seal/변경 payload는 거부한다.
- `ownedSpawnRuntime.ts`는 runtime-home 등록과 credential로 실제 Happy profile을 확인하고 동일
  암호문으로 POST한다. executionProof가 필요한 준비는 기존 machine runtime을 사용하며 그 journal에
  ownershipManaged를 먼저 기록해 실행 증명만으로 복구 POST하는 경로를 차단한다.
  provider 시작 전 session snapshot과 필요한 실행 binding을 durable하게 보존한다.
- 새 machine RPC: `owned-spawn-capabilities({spawn})`, `prepare-owned-spawn`, `commit-owned-spawn`,
  `start-created-session`/`start-owned-spawn`, `create-session-status`/`owned-spawn-status`,
  `agent-caller-binding({sessionId,nonce})`. 기존 encrypted machine binding을 사용한다.
- caller는 실제 owned launch의 session/scope/depth와 daemon machine/account에서 만들고 private key를
  host 메모리에만 둔다. 조회는 nonce/source에 결속되며 새 host·재개 시 새 binding을 만든다.
  immutable 생성 receipt의 caller는 당시 기록이고 현재 relay 등록은 반드시 agent-caller-binding으로 검증한다.
- pending 세션은 prefer-owned일 때 같은 세션만 시작한다. 늦은 signed confirm도 같은 후보만 갱신하고
  provider를 다시 실행하지 않는다. require-owned는 검증된 confirm 없이 시작하지 않는다.

## descriptor fence 정정

로컬 정본은 runtime-home의 machineId와 Happy credential로 확인한 account다. revision의 로컬 사본은
필요하지 않다. p0a §3.6대로 결속 당시 descriptor와 새 descriptor의 subject/account/machine/revision을
비교한다. 바뀌면 identity-changed로 결속을 영구 무효화하며 새 신원으로 재결속하지 않는다.
60초 snapshot은 사용 시 새로 조회하고 서명을 확인한다. descriptor를 로컬 정본으로 복사하거나 marker
누락을 personal로 취급하지 않는다. 기존 local epoch fence는 유지하며 signed schema에 epoch를 추가하지 않는다.
이전의 ‘설계 변경 필요’ 판단은 철회한다. 실제 broker/direct host source port 연결은 T1c와 통합한다.

## capability·통합 조건

소유 전용 서명 신뢰는 서버 계약과 같은 운영 설정 `HAPPY_SESSION_OWNERSHIP_ENABLED=1`,
`HAPPY_SESSION_OWNERSHIP_ISSUER`, `HAPPY_SESSION_OWNERSHIP_AUDIENCE`,
`HAPPY_SESSION_OWNERSHIP_PUBLIC_KEYS`의 pinned key 목록을 사용한다. 요청 문서의 URL/key를 신뢰하지 않는다.
미설정이면 owned capability는 false다. 개인 bearer는 받거나 provider env/argv로 전달하지 않는다.

현재 실제 precreated reconnect adapter는 Claude/Codex와 daemon 등록 Happy 계정 범위를 지원한다.
다른 provider/다른 Happy session 계정은 capability/호출자에서 owned를 켜지 않아야 한다. 다른 provider의
host bootstrap은 §7.1 T1c 파일 책임과 통합하며, 새 owned source 밖의 기존 무증명 source caller는
이 journal에서 만들어 내지 않는다. 회사 계정의 고의적 daemon RPC 위조까지 보호하는 별도 보장은 아니다.

Desktop의 `SessionOwnershipCreationTransport`는 실제 개인 auth custody/epoch, canonical signature 검증,
A+ personal intent/seal/confirm/lookup과 Happy machine RPC를 T1c가 구현해야 한다. renderer 대체는 없다.
Main 조정기·journal·typed IPC는 Desktop 동명 branch에 준비했지만 main assembly/생성 호출부는
T1c 기반 통합 전 비활성이다. 배지=T2, 공식 pin=T2r. 실제 서버·provider·앱 수락은 별도다.

## 검증

- 앞선 API/descriptor/broker/sessionEnv 5개 파일: 175 passed / 1 macOS-only skipped.
- snapshot 구조 분리 API/descriptor 관련: 64 passed.
- daemon/RPC/실행 journal·복구 관련 7개 파일: 155 passed (global setup typecheck/pkgroll 포함).
- 마지막 journal/adapter 수정 후 ownedSpawn·ownedSpawnRuntime + OFF parity: 13 passed / 1 의도적 미선택.
  `9ee84191`과 현재 각각 82개 시나리오의 OFF wire·metadata·전이·기존 소비자가 동일하다.
- descriptor revision refresh·계정/머신/subject 전환 및 permanent invalidation 24개 테스트도 통과했다.
- 전체 테스트·실제 A+/Happy 배포 서버·provider 실행·UI 실앱 검증은 실행하지 않았다.

## 교차 리뷰 보완 (T4RT-01·02, 2026-10-26)

- 증명 없는 생성은 서버가 agentState를 저장하지 않으므로 복구 시 metadata와 dataEncryptionKey의
  정확한 암호문으로 후보를 찾는다. ownershipProof 또는 executionProof가 있으면 agentState 결속도
  유지한다. 서버 API·생성 저장 의미는 변경하지 않는다. 실제 저장 형태(null state·0 versions)를 쓰는
  회귀에서 응답 유실·daemon 재시작 뒤 같은 세션을 회수하고 POST/start 중복이 없음을 확인한다.
- Codex가 daemon의 consume-once fresh-launch 표식을 초기 프롬프트 준비에 전달한다. 실제 runCodex →
  initialPrompt → 큐 → provider client 호출 경계를 구동해 신규 precreated 세션만 1회 전달하고 일반
  reconnect는 재전달하지 않음을 확인한다. 초기 프롬프트/표식은 소비 후 환경에서 제거된다.
- Claude는 같은 처리가 이미 있으며 기존 runClaude 회귀로 확인한다. Gemini는 초기 프롬프트를 직접
  consume-once 처리하고 reconnect ID로 폐기하지 않는다. ACP/OpenClaw는 이 reconnect bootstrap을
  소비하지 않는다. 세 runner 모두 현재 owned-spawn schema의 Claude/Codex 허용 목록 밖이므로
  지원 범위를 넓히지 않는다.
- 서버·세션 이벤트 wire 변경 없음. Desktop 작업 트리는 이 리뷰 보완에서 수정하지 않는다.
- 검증: 두 결함을 실패 테스트로 확인한 뒤 최소 수정으로 통과시켰다. 최종 저장소 기본 Vitest
  명령(global setup의 tsc/pkgroll 포함)에서 ownedSpawn/runtime, reconnect/sessionEnv, Codex
  initialPrompt/runCodex, Claude initialPrompt/runClaude, OFF parity 9개 파일 272 passed / 1 의도적
  미선택(ON parity). OFF는 9ee84191과 각각 82개 시나리오를 재생해 동일성을 확인했다.
  git diff --check 통과. 전체 suite·실제 배포 서버·실제 provider 실행은 수행하지 않았다.

## PR #966 daemon 배선 가드 보완 (2026-10-26)

- 판정 (b): `aiAuthSelectionWiring.test.ts`는 `machineRotationFor(options)`를 무조건 호출하는 이전
  문장을 기대했다. `run.ts`는 이제 private `ownedMachineLaunches`에 이미 준비된 실행 launch가
  있을 때만 재선택·재생성을 생략한다. ordinary/channel 경로의 selector·dataKey 경로는 유지된다.
- owned precreate는 `ownedSpawnRuntime.ts`의 `rotation.prepareLaunch` → `input.executionProof` →
  생성 POST → `complete`(실행 claim/commit 완료 대기)에서 수행된다. 재시작은 같은 company runtime의
  `resume(tracked, binding)`으로 실행 결속을 재검증하고 reconnect 환경·launch를 공통 admitted spawn에
  넘긴다. `run.ts`의 pendingMachineStarts, credential environment, reconnect 주입, webhook session ID
  비교와 authority 검사에는 빠지는 분기가 없다.
- 기존 가드의 나머지 기대값을 유지하고, 준비된 launch가 있을 때만 재선택을 생략하는 조건 및 두
  경로의 공통 시작 처리를 검사한다. owned helper의 proof 운반·claim 완료·resume binding·공통 spawn
  전달도 추가 검사한다. production 코드·공개 API·wire 변경은 없다.
- 로컬에서 기존 가드 1 failed / 10 passed로 CI 실패를 재현했고, 수정 후 12 passed를 확인했다.
- 요청 명령 `corepack pnpm -C packages/happy-cli exec vitest run --project unit src/daemon --maxWorkers 2`
  전체 실행: 249 files passed / 8 failed / 7 skipped; 4524 tests passed / 122 failed / 49 skipped,
  unhandled errors 3개. global setup tsc/pkgroll 통과. 배선 가드 12개와 T4rt 테스트는 통과했다.
  전체를 통과로 표시하지 않는다. 다른 실패는 다음 환경 제약에서 발생했으며 코드를 변경하지 않았다.
  - Git 2.25.1의 `git init --initial-branch=main` 미지원: worktreeOps(78), missingWorktreeRestore(16),
    worktreeDependencyReclaim(18), 총 112 failed.
  - Unix/abstract socket listen EPERM: launcherClient(1), browserAttentionDelivery(3),
    browserSessionBrokerServer(2), managedWriterLock(2), 총 8 failed. 세 unhandled error도 Unix socket
    listen EPERM이고 timeout은 listen 성공 callback을 기다리는 테스트에서 발생했다.
  - `/tmp`가 UID 65534 소유여서 generation manifest ancestor 검증 거부: managedLauncherBoot 2 failed.
  - 로그: `/tmp/rn-t4rt-daemon-full.log`. macOS 재실행은 CI에서 확인해야 한다.

## PR #966 bot 보완 — 시작 거절·실행 증명 만료 (2026-10-26)

- daemon 내부 dispatch guard는 프로세스 생성 경계에 들어가기 전 반환된 restart·directory approval·
  validation 거절만 `OwnedStartRefused`로 분류한다. owned journal은 `created`로 되돌리고 caller와
  providerRuntimeId를 지운다. 동일 세션 start를 다시 제출할 수 있으며 thrown exception, spawn 이후
  실패, 응답 유실은 `starting`에서 관찰만 한다. 표식은 WeakSet/내부 callback이고 RPC·env·argv로
  받거나 전송하지 않는다. 일반/tmux 모두 자격 검증 뒤 실제 생성 호출 직전에 표시하며, native Windows는
  suspended root 생성 전에 표시한다. owned tmux 생성 명령 이후 실패는 일반 spawn으로 재시도하지 않는다.
- 실행 증명 만료는 사용자 허용 대안인 **로컬 명시 거절**로 처리한다. ticket도 60초이므로 deviceProof만
  다시 서명해 만료 ticket을 살리지 않는다. commit에서 ticket과 deviceProof의 유효기간을 각각 확인해
  stale이면 Happy POST 없이 `failed / execution-proof-expired`를 반환한다. encrypted body·tag·ticket은
  교체하지 않는다. 기존 commitIssued는 durable 제출 의도이며 실제 HTTP 송신 횟수를 뜻하지 않는다.
- 확정 생성 거절과 preparation 실패는 owned failed 상태를 기록하고 sessionReady를 reject하여
  prepareLaunch의 대기/active lock을 해제한다. machine-rotation journal은 pending을 지우고 abandoned
  tombstone을 저장한다. recovery가 abandoned를 재조회하지 않으며 같은 launchId의 재준비도 거부한다.
  cleanup 저장 실패 후 daemon 재시작은 failed status에서 idempotent 정리를 재개한다. uncertain create는
  failed로 바꾸거나 abandon하지 않고 기존 조회 복구를 유지한다. claim/commit 응답 유실도 기존 복구를 유지한다.
- 회귀는 실제 machineSetupTokenRuntime과 owned adapter를 함께 구동해 ticket 만료, 별도 deviceProof
  만료, Happy 403, cleanup 실패 후 재시작을 검증한다. abandoned tombstone의 실제 파일 journal 재개도
  확인한다. Studio/Happy HTTP만 테스트 port이며 실제 배포 서비스·provider 검증으로 간주하지 않는다.
- dispatch 가드는 기존 env 검증·credential launch 경계를 계속 검사한다. appliedSource 가드는 문자 수
  400 제한 대신 두 실제 호출의 tmuxSelection/spawnSelection 전달을 정확히 검사하도록 보강했다.
- 검증: 거절 rollback·증명 만료·pending 정리를 먼저 실패로 재현했다. 관련 13개 파일 274 passed /
  1 의도적 미선택(ON parity), 추가 회귀 후 ownedSpawn + machineSetupTokenRuntime 48 passed.
  각 최종 실행의 global setup tsc/pkgroll 통과. OFF는 9ee84191과 82개 시나리오 동일하다.
  T4RT-01 unsigned 응답 유실 복구와 T4RT-02 실제 Codex 첫 프롬프트 소비 회귀도 통과했다.
  failed 상태 저장이 실패해도 cleanup을 finally에서 실행하는 2개 회귀를 포함한다.
  git diff --check 통과. 전체 daemon/CLI suite·실제 배포 서버·provider·Desktop 통합은 이번 보완에서
  재실행하지 않았다. 직전 전체 daemon 실행의 환경 제약은 위 기록을 따른다.
