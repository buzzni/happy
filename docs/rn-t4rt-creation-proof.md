# T4rt 생성 증명 운반 경계 (진행중)

2026-10-26. Desktop의 `specs/reason-network-adoption/p0a-contract.md` §4.2/4.4/4.6/7.1/7.2를 따른다.
이 변경은 T4rt 전체 완료가 아니다. 운영 capability와 provider 시작 경로는 아직 연결하지 않는다.

## 구현 범위

- `ApiClient.getOrCreateSession`은 최종 암호화 body를 한 번 만들어 trusted ownership callback에
  넘기고, 반환된 T4o proof의 schema·body/tag hash를 확인해 생성 POST에만 붙인다.
- executionProof와 ownershipProof는 같은 ciphertext에 결속해 함께 전달한다. 원래 unsigned body는
  그대로이며 session 객체·metadata·이벤트에 소유 증명을 싣지 않는다.
- 서버의 candidate receipt를 sessionId/createDigest와 대조하고 trusted callback에 전달한다.
  pending은 effective owner 확인이 아니다. 실제 개인 confirm/provider start는 후속 조정 책임이다.
- 소유 생성 오류는 HTTP status와 commitIssued만 담는다. Axios request·bearer·proof·서버 오류 원문을
  로그/예외에 보존하지 않으며, 실패 뒤 offline/unsigned 생성으로 내려가지 않는다.
- personal descriptor 소비자는 T4o 공용 schema의 hash revision을 사용한다. 서버 문서에 없는 epoch를
  서명 문서에 붙이지 않는다. 기존 로컬 host epoch 비교와 machine/account/revision 비교를 fetch,
  signature verify, target lookup의 await 경계마다 수행한다. 검증은 원래 서명 문서를 대상으로 한다.
- `happy-wire`의 기존 ownership schema를 index에서 export한다. 세션 이벤트 wire schema는 바꾸지 않는다.

## 아직 연결하지 않은 범위와 재개 조건

Desktop 기준 `5cf612493`에는 p0a §7.1의 선행 `sessionOwnerTransport.ts`가 없다.
main transport branch/SHA를 통합한 뒤 개인 인증 세대·key custody·RPC/REST port로 생성 조정을 연결한다.
renderer 대체 경로나 개인 bearer env/argv 전달은 추가하지 않았다.

A+ #5447 T4O-V3-01은 현재 **로컬 등록 상태**와 descriptor의 세 필드 비교를 요구한다.
A+의 `sessionOwnershipAuthority.ts`는 MachineEntry 등록 필드와 Happy machine.createdAt에서 revision을
계산하지만, Happy의 현재 Settings/machine-type marker에는 독립적으로 대조할 그 revision이 없다.
등록 source adapter와 서명 trust 연결은 미완료이며 기본 `identity-unavailable`을 유지한다.
받은 descriptor의 revision을 자기 정본으로 복사하면 fence가 아니므로 그렇게 하지 않는다.
선행 등록 전달 계약이 없다면 **설계 변경 필요**로 보고하며 서버 공개 API/스키마를 임의로 바꾸지 않는다.

후속: daemon private prepare/commit/start/status journal, 동일 ciphertext/key snapshot 복구,
caller binding/launch/재개 연결, Desktop main intent/seal/confirm, A6 timeout·late callback·중복 생성 방지,
require-owned 상속과 최종 started receipt. 위 동작의 통합 테스트·실앱 수락은 미실행이다.
UI 배지는 T2, 공식 CLI pin·배포는 T2r이다. 이 branch는 release/tag/PR을 만들지 않는다.

## 검증

- 초기 HTTP transport 테스트: 7 failed / 1 passed (callback/receipt 미구현 재현).
- 실제 서버 descriptor fixture: 숫자 revision 타입 충돌로 build 단계 실패. 동작 테스트 미실행.
- Happy 관련 5개 파일: 175 passed / 1 macOS-only skipped (`api/sessionOwnershipCreation`, `api/api`,
  `daemon/agentIdentityDescriptor`, `commands/sessionAgentBroker`, `daemon/sessionEnv`, 모두 `.test.ts`).
  표준 global setup의 typecheck/pkgroll build, 공용 wire build 통과.
- `api/apiSession.inputEvidenceLifecycle.test.ts -t opt-in=false`: 1 passed / 1 의도적 미선택.
  9ee84191과 현재 소스를 82개 시나리오씩 실행해 OFF wire·metadata·전이 및 기존 소비자 동일성 확인.
- `git diff --check` 통과. 전체 테스트·실제 서버·provider 실행·실앱 수락은 실행하지 않았다.
