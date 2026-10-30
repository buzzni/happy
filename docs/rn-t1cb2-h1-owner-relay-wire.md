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

초기 커밋은 Git metadata가 읽기 전용이라 이 세션에서 만들지 못했다.
지휘 세션이 같은 작업트리의 H1 변경을 `e2b2dd3e`로 커밋했다.

## H1-R-01 교차 리뷰 반영 (2026-10-30)

read 이벤트의 localId에 prompt 전용 ASCII/1–128자 제한을 적용한 결함을 수정했다.
`OwnerRelayReadEventSchema`는 이제 `SessionMessageSchema.shape.localId`를 직접 재사용한다.
기존 메시지의 Unicode·공백·긴 localId를 보존하며 prompt 요청/저장 receipt의 제한은 유지한다.

회귀 테스트는 기존 SessionMessageSchema에서 허용한 행을 복호화 메시지 형태로 옮겨
read 응답 서명 → encode → decode → 서명 검증까지 통과하는지 확인한다. Unicode,
공백, 두 조건의 조합, 129자, null, 생략, 빈 문자열(기존 read schema가 허용), 일반 ID
8건을 포함하며 localId 변조 시 서명 검증 실패도 확인한다. 별도 3건으로 prompt/receipt의
기존 제한을 검증한다. 새 쓰기 API가 빈 문자열을 받도록 바꾼 것은 아니다.

- 수정 전: 추가 테스트 **5 실패 / 6 통과** (기존 45건은 `-t H1-R-01`로 미선택).
- 수정 후: 추가 테스트 **11건 통과**.
- 수정한 schema 한 줄을 원래대로 되돌렸을 때 **동일한 5건 실패**를 확인한 뒤 수정본 복원.
- 최종: `pnpm -C packages/happy-wire exec vitest run src/sessionOwnerRelay.test.ts
  src/sessionOwnerRelayCodec.test.ts src/messages.test.ts` — **3개 파일 / 115건 통과**.
- `pnpm -C packages/happy-wire run typecheck`, `git diff --check` 통과.
- 사용자 지시대로 파일만 수정했다. 이 후속 변경의 커밋은 지휘 세션이 맡는다.

## H1-R-02 교차 리뷰 반영 (2026-10-30)

같은 부류가 다른 식별자에도 남아 있었다. 기존 레코드에서 옮겨 오는 식별자(read 이벤트의 메시지 `id`,
pending permission `requestId`, activity `sourceMessageId`, snapshot `runtimeId`·`machineId`)와 그 permission을
가리키는 `reply-own-permission`의 `permissionId`(요청 payload·응답 control)는 `persistedId`(비어 있지 않은 문자열)로
생산자의 기존 계약을 따른다. `ownershipId`는 이 프로토콜이 발급하는 ID에만 쓴다. 공백·129자 식별자가 read 응답의
서명 → encode → decode → 검증과 permission 응답 요청 검증을 통과하는 회귀 4건을 추가했다(수정 전 4건 실패).

## H1-R-03·04·05 교차 리뷰 반영 (2026-10-30)

- H1-R-03: read에서 관측해 그대로 넘기는 값도 `persistedId`를 쓴다. 대상은 resume의 `expectedMachineId`·`runtimeId`,
  abort·permission 응답의 `runtimeId`, 응답 `control.runtimeId`다.
- H1-R-04: spawn 옵션의 `initialPromptLocalId`는 daemon `ownedSpawnRuntime.ts`의 기존 문자열 옵션이다. 그래서 relay가
  발급하는 prompt `localId` 제한(`relayLocalId`)을 적용하지 않는다.
- H1-R-05: `aiAuthSelection`(`claude-setup-token`)의 `managedAccountId`·`groupScope`는 daemon `sessionEnv.ts`와 같은
  형식(소문자 UUID, `[A-Za-z0-9_-]{1,128}`)만 받는다. daemon이 거부할 선택을 wire가 받지 않게 하기 위해서다.
- 회귀: 위 경우 7건을 추가했다(수정 전 7건 실패).

## H1-R-06·07 교차 리뷰 반영 (2026-10-30)

- H1-R-06: prompt 저장 receipt의 `storage.messageId`는 저장된 행 자신의 ID라서 `persistedId`를 쓴다. 그래서 read
  이벤트 ID와 같은 계약을 따른다. snapshot `machineId`는 기존 session list가 "관측 안 됨"을 `''`로 주므로
  일반 문자열을 받는다.
- H1-R-07: 성공 prompt 응답은 `bodyVerified: true`만 허용한다. 본문 불일치는 성공이 아니라 unknown 등의 실패
  응답으로 표현한다. 서명 바이트를 직접 만든 false receipt도 응답 검증에서 거부한다. 회귀 테스트는 true 대조를
  포함한다(수정을 되돌리면 실패하는 것도 확인).

## H1-R-08·09 교차 리뷰 반영 (2026-10-30)

- H1-R-08: 성공 prompt receipt의 `storage.seq`는 양의 정수만 받는다. 기존 receipt 생산자의 성공 조건과 같다.
- H1-R-09: read snapshot의 pending permission `requestId`는 관측값이다. 그래서 기존 Desktop 생산자가 줄 수 있는
  빈 map key(`''`)도 그대로 운반한다. 그 permission을 대상으로 하는 `reply-own-permission`의 `permissionId`는
  실행 입력이라 여전히 비어 있지 않아야 한다.

## H1-R-10 교차 리뷰 반영과 read projection 전수 대조 (2026-10-30)

- H1-R-10: pending permission `createdAt`·`expiresAt`, activity `observedAt`는 생산자(`pendingPermission.ts`
  `timestampValue`, `agentActivity.ts`)처럼 양의 유한 숫자(소수 허용)를 받는다.
- 같은 부류가 반복되어 지휘 세션이 read projection을 Desktop 생산자 타입과 직접 대조했다. read 이벤트는
  `SessionMessageSchema`의 `id`·`seq`·`localId`·`createdAt`·`updatedAt`을 그대로 쓴다. pending permission의 `kind` 열거,
  `policy`(`PermissionPolicyMeta`), activity의 나머지 필드(`sourceSeq`는 메시지 seq 정수)는 생산자 타입과 일치한다.

## H1-R-11 교차 리뷰 반영 (2026-10-30)

resume·permission·abort의 `control.state: 'accepted'`는 실행한 runtime(resume이면 새 runtime)을 `runtimeId`로 반드시 담는다.
runtime을 확인하지 못한 결과는 `unknown`으로 표현하며 `accepted`+`runtimeId: null`은 schema에서 거부한다.
permission·abort의 accepted는 기존 결속 검사로 요청 runtime과 일치해야 한다. 이번 리뷰의 식별자·문자열·성공 조건 전수
대조표에서 남은 불일치는 이 항목뿐이었다.
