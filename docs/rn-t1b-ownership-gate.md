# T1b 개인 소유 판정과 broker private 전달

Desktop의 `specs/reason-network-adoption/p0a-contract.md` §4.4·§5가 설계 정본이다.
회사 소유자 Desktop relay(T1c), 서버 소유 기록(T4o), 런타임 증인(T2rt)은 이 변경에 포함하지 않는다.

## 구현 경계

`daemon/agentIdentityDescriptor.ts`는 daemon 자체 머신·Happy 계정·등록 revision·epoch와 서버 descriptor를
대조한다. 개인 등록·개인 계정, 검증된 서명, 최대 60초 유효기간, 서버가 확인한 대상 계정 일치가 모두 필요하다.
조회 중 계정/등록/epoch 변경·만료·잘못된 서명·조회 실패는 unknown이다. 회사·누락·미등록을 personal로 추정하지
않고 createdBy·등록자·요청 env를 읽지 않는다.

`commands/sessionAgentBroker.ts`의 host executor는 명시적인 내부 `identityAuthority`를 받는다.
`agentHostProcess.ts`는 고정된 내장 CLI 자식과 private Node IPC로 소유 판정을 주고받는다. 요청에는 target만 있고
source는 host session으로 고정한다. Desktop이 관계와 verb를 구별하며 self/형제 steer·stop을 계속 거부한다.
IPC가 없는 구 Desktop/Happy 조합도 기존 stdout envelope는 유지하고, 새 Desktop은 소유 신호가 없으면 거부한다.
IPC를 provider env나 argv 소유 주장으로 대체하지 않는다. spawn 요청 env allowlist도 소유 필드를 받지 않는다.

## 미연결 선행 계약 — 완료로 취급하지 않을 것

현재 main에는 T4o machine agent-identity 발급·서명 검증 adapter가 없다. 기본 authority는
`identity-unavailable`이며 실제 개인 형제 입력을 열지 않는다. `AgentIdentityDependencies`에는 다음을
**daemon/host의 자체 신뢰 상태로** 연결해야 한다.

- runtime-home의 machine/account/등록 revision/epoch 읽기
- 등록된 machine credential로 descriptor 조회
- 발급자의 key 선택·서명 canonicalization·issuer/audience 검증
- Happy의 인증된 대상 owner 계정 조회

P0a는 endpoint와 필드 이름을 정했지만 서명 wire·키 조회/rotation의 실행 계약은 아직 이 checkout에 없다.
이를 임의로 만들어 발급/인가 schema 의미를 바꾸지 않았다. T4o 계약이 merge된 뒤 위 adapter를 daemon launch/재개
소유 state에서 구성하고 `startSessionAgentBroker`에 연결해야 한다. 이 연결 전에는 live same-account 양성 수락이
미완료다. 회사/직접 host caller binding과 credential-free typed chat는 T1c, official pin/release 수락은 T2r이다.

## 검증과 복구

2026-10-25 검증: `pnpm -C packages/happy-cli exec vitest run --project unit`에 descriptor·sessionAgentBroker·
agentBroker·sessionEnv 4개 파일을 지정해 126 passed / 1 skipped였다. 표준 global setup의 CLI build(tsc와 pkgroll)
및 별도 happy-cli typecheck도 통과했다. macOS deny-read fixture는 Linux에서 skipped이며 실제 제품 수락을
대신하지 않는다. 패키지 version/lockfile·태그·릴리스는 바꾸지 않는다.

문제가 생기면 identity adapter를 제거해 새 소유 확장만 닫는다. Desktop의 자기 입력/후손 전용 steer·stop 게이트를
풀지 않는다. 신뢰 경계 (ii) 변경, 회사 protocol 격리, 새 descriptor wire가 결정되면 이 경계를 재검토한다.
