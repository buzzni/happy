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
