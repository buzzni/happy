# T1c-b2 H1: owner-relay-v1 wire와 codec

2026-10-30. Desktop `specs/reason-network-adoption/p0a-contract.md`
§3.4·§4.4–4.6·§7.1 및 지휘 계획 `t1cb2-plan.md` §3·§4의 H1이다.
Core의 기존 소유·세션 제어 계약을 구체화한다. **wire만 구현했으며 실행은 미연결이다.**
contact 광고, RPC 등록, 네트워크 호출, daemon/broker 연결, rollout 변경은 없다.
기존 `sessionOwnership.ts`의 contact/method/서명 계약은 변경하지 않는다.

## 요청과 응답

`OwnerContactRequestSchema`는 local port의 `{v,entry,operation,targetSessionId?,localId?,payload}`만
받는다. source·scope·depth 주입을 거부한다. `OwnerRelayRequestSchema`는 고정 host가
추가한 source binding, nonce, intentDigest, callerSignature를 받는다. 두 요청은
operation별 strict union이다. 새로운 verb·RPC method·실행 파일·bearer 필드는 없다.

| operation | payload | allowed 응답의 유일한 결과 필드 |
|---|---|---|
| lookup-readable-sessions | sessionIds (0–100개) | owners (최대 100개) |
| read-session | cursor, limit (1–50), waitMs (0–15000) | sessionView |
| prompt-own-session | text, settings, delegatedAttendance?, hubPrompt | storage |
| resume-own-session | sessionId, expectedMachineId, runtimeId (null 가능) | control |
| reply-own-permission | sessionId, runtimeId, permissionId, approved, updatedInput?, mode? | control (permissionId 필수) |
| abort-own-turn | sessionId, runtimeId | control |
| spawn-owned-child | operationId, spawnId, childAgentId, spawnDigest, spawnOptions | childSpawn |
| owned-child-status | operationId, spawnId, spawnDigest | childSpawn |

read/prompt/control의 targetSessionId, prompt의 localId는 필수다. 중복 sessionId와
hubPrompt target은 외부 target과 일치해야 한다. 다른 operation의 payload/결과 필드,
미지 필드, 복수 결과 필드는 거부한다. `not_owned/unavailable/unknown` 응답에는
결과 payload가 없다. child started는 sessionId/ownershipBindingId/providerRuntimeId 및
provider-started stage가 필요하다. pending/parked는 성공이나 후손 권한으로 해석하지 않는다.
자식 생성/복구 요청은 confirmed-owner source가 필요하다. personal-account는 나머지
연산에 쓸 수 있지만 인가 성공을 뜻하지 않는다.

read snapshot은 기존 Session의 active/thinking/runtime·machine 관측과
PendingPermissionRequest, AgentActivity의 wire 투영이다. 관측할 수 없는 active/thinking은
null이며 false로 꾸미지 않는다. events는 기존 SessionMessage 행의 id/seq/localId/시간과
복호화한 MessageContentSchema를 사용한다. 메시지 내부의 기존 확장 필드는 보존한다.
잘린 응답은 실행부가 truncated로 표시해야 하며 codec이 내용을 자동 삭제하지 않는다.

## 재사용 및 동적 데이터

- 기존 `OwnershipSourceAuthoritySchema`, `OwnershipSubjectSchema`, `ownershipId/hash`,
  `OwnershipRelayContactSchema`, base64url/Ed25519/SHA-256 구현을 재사용한다.
- hubPromptGuardSchema와 MessageMetaSchema의 model/effort/permissionMode를 재사용한다.
  settings는 §3.4 text producer의 modelSource/autoRoute를 포함한다. 기본값을 채우지 않는다.
- read events는 happy-wire MessageContentSchema로 검증하되 기존 legacy/provider 확장
  필드를 제거하지 않는다. typed wrapper 외에 새로운 임의 payload 슬롯은 만들지 않는다.
- Desktop PendingPermissionRequest/PermissionPolicyMeta/AgentActivity 및
  SessionPermissionReplyInput의 필드를 wire에 투영했다. 별도 저장소의 Desktop 타입을
  역방향 import하지 않는다. `updatedInput/arguments`의 Record<string, unknown>은
  지휘 세션의 명시적 해석에 따라 보존한다. 중첩 배열·객체·음수·소수도 서명 대상이다.
- spawnOptions는 happy-cli `daemon/ownedSpawnRuntime.ts`의 현행 Claude/Codex 선택을
  따른다. aiAuthSelection은 `daemon/sessionEnv.ts`의 닫힌 선택을 구체화했다.
  environmentVariables는 기존 문자열 map이며 **daemon의 기존 env admission을 대체하지
  않는다**. H2 이후에는 그 sanitizer/allowlist와 실제 capability를 반드시 적용한다.

## 바이트와 암호화 규약

`canonicalOwnerRelayJson`은 UTF-16 코드 단위 기준 key 정렬, 공백 없는 JSON, 배열 순서
유지, ECMAScript JSON 숫자 표기를 사용한다. -0은 JSON의 0으로 표현하며 유한 음수/소수를
허용한다. invalid Unicode, undefined/function/bigint/nonfinite 값, sparse array, accessor,
비 JSON 객체, 64단계를 넘는 중첩은 거부한다. property getter를 실행하지 않는다.

크기는 **서명 필드를 포함한 canonical 요청 전체 65536 bytes, 응답 전체 131072 bytes**다.
UTF-8로 세며 permission 데이터도 포함한다. local 요청도 65536 bytes로 제한하고 host가
붙인 원격 envelope는 다시 검증한다. 기존 ownership canonicalizer는 64KiB/비음수 정수
전용이므로 그대로 두었다. relay 전용 canonicalizer가 그 서명 domain을 바꾸지 않는다.

서명/해시 입력은 UTF-8(prefix + canonical JSON)이다. `\0`는 실제 NUL byte다.

- request: `saycode-owner-relay/v1\0request\0` + callerSignature만 제외한 요청 전체.
- reply: `saycode-owner-relay/v1\0reply\0` + signature만 제외한 응답 전체.
- intentDigest: SHA-256, lowercase hex. `saycode-owner-relay/v1\0intent\0` +
  요청에서 requestId/nonce/relayEpoch/intentDigest/callerSignature를 제외한 객체.
  즉 v/entry/operation, 고정 source binding 전체, target/localId 및 payload가 결속된다.
  nonce/requestId/relayEpoch는 재시도 transport 값으로 intent에서는 빠지지만 서명이 보호한다.

sign 함수는 digest/signature를 다시 계산하며 입력을 JSON snapshot으로 고정한다.
verify 함수는 구조·digest·서명·contact 결속과 응답의 요청/결과 결속을 확인한다.
`encode/decodeOwnerRelay*`는 canonical 문자열을 주고받는다. decode는 비정규 표현과
중복 key/escaped alias를 거부한다. 이미 파싱된 object transport는 schema와 signing codec을
쓰되 원래 중복 key를 JSON.parse가 지웠는지 알아낼 수 없으므로 raw 문자열에는 decode를 쓴다.

**호출자의 필수 책임:** verify 함수의 `verifiedContact`는 이미 신뢰한 서버 key로
issuer/audience/signature 및 현재 등록 상태를 검증한 contact여야 한다. codec은 전달된
contact의 구조/기한/결속을 검사하지만 서버 trust root를 선택하지 않는다. 반환값은 새
owner 권한·read ACL·현재 source/target 재조회·세대 fence·nonce replay 저장소를 대신하지
않는다. 특히 control의 null runtime/unknown 상태는 실행 성공이 아니다.

## Golden fixture와 검증

`packages/happy-wire/src/fixtures/sessionOwnerRelay.v1.json`은 Node crypto의 독립
Ed25519/SHA-256 구현으로 만든 public 테스트 seed, 서명된 confirmed/personal contact,
8개 요청·응답, intent/signing 입력 문자열, canonical wire를 포함한다. 실제 키가 아니다.
A+/Desktop은 같은 fixture를 소비해 byte 단위로 대조할 수 있다. 다른 저장소에는 쓰지 않았다.

TDD에서 strict 거부 12건, 서명/결속 23건, 크기/JSON 10건, async snapshot/accessor 3건,
동적 JSON key 보존 1건, null runtime 관측 2건의 실패를 먼저 확인한 뒤 수정했다.
최종 관련 테스트/타입 검사 결과는 아래에 기록한다. 전체 저장소 테스트와 실앱 검증은
대상이 아니다. 새 사용자 기능이나 release artifact를 켜지 않아 버전·릴리스 조각은 없으며
이 문서가 wire 변경/미연결 범위를 기록한다.

H2 이후: 신뢰할 caller/contact 연결, 실제 nonce 재사용 방지, owner/ACL/세대 재검증,
8개 operation 실행, env admission, read 잘림 표시, 실제 child/status 복구, 공식 artifact 수락.
문제가 생기면 새 wire export/모듈을 함께 되돌린다. 기존 contact는 영향받지 않는다.
새 payload나 서명 규칙 변경은 소비자 golden fixture와 함께 재검토한다.

최종 검증 (2026-10-30):

- 신규 `sessionOwnerRelay.test.ts` 47건 + `sessionOwnerRelayCodec.test.ts` 45건 = **92건 통과**.
- 관련 기존 회귀 82건 포함, **7개 파일 / 174건 통과**:
  `sessionOwnerRelay`, `sessionOwnerRelayCodec`, `sessionProtocol`, `messages`,
  `messageMeta`, `sharedMachineRotation`, `orgSetupTokenApproval`의 `.test.ts`.
  명령: `pnpm -C packages/happy-wire exec vitest run src/sessionOwnerRelay.test.ts
  src/sessionOwnerRelayCodec.test.ts src/sessionProtocol.test.ts src/messages.test.ts
  src/messageMeta.test.ts src/sharedMachineRotation.test.ts src/orgSetupTokenApproval.test.ts`.
- `pnpm -C packages/happy-wire run typecheck` 및 `git diff --check` 통과.
- lockfile·manifest·기존 contact 파일 변경 없음. 전체 테스트/네트워크 실행/실앱 수락은 하지 않았다.
- 설치는 지정 작업트리에서 frozen lockfile로 수행했다. 전역 store가 읽기 전용이어서
  최종적으로 `pnpm --filter @slopus/happy-wire install --frozen-lockfile
  --store-dir node_modules/.pnpm-store --ignore-scripts`를 사용했다. 모든 설치 산출물은 Git 제외다.

커밋 차단 (2026-10-30): 구현과 검증은 완료했으나 `git add`/`git commit`은
`/home/walter/workspace/happy/.git/worktrees/happy-wt-rn-t1cb2-h1/index.lock` 생성 시
`Read-only file system`으로 실패했다. 새 작업트리의 `.git` 포인터가 여전히 그 경로를
사용한다. 변경은 이 작업트리에 unstaged/untracked로 보존돼 있으며 신규 커밋은 없다.
Git metadata의 쓰기 가능한 연결이 준비되면 위 9개 변경 파일만 stage하고
`[behavioral] owner-relay-v1 strict wire와 서명 codec 추가`로 커밋한다.
코드가 바뀌지 않았다면 통과한 테스트를 반복할 필요는 없다. Git 구조 재작성·다른 저장소
수정·push/PR/merge/태그/릴리스·자식 세션 생성은 하지 않았다.
