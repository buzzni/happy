---
feature: rn-t4o-session-ownership
status: server-implemented
last_updated: 2026-10-25
---

Happy 독립 clone `/home/walter/workspace/aplus-dev-studio-desktop/.aplus/worktrees/rn-ext/happy-t4o`에서 origin/main `9ee84191cf6e6b2739987be3f5488ef511c6474f` 기반 `feat/rn-t4o-session-ownership`으로 작업했다. 지휘 worktree와 원래 저장소는 수정하지 않는다.

## 구현·검증

신규 세션과 owner 후보를 원자적으로 저장하며 exact replay만 같은 세션으로 수렴한다. 선점된 legacy 행·재등록·사후 부착은 거부하고 proof 없음은 owner 없음, 개인 confirm 전 effective owner는 null이다. 서명·account·machine·body/tag·기한 검사, 삭제 tombstone, owner 불변 trigger, 두 proof 합성과 commit 직전 기한 재검사를 구현했다.

최초 실패 테스트는 잘못된 ownershipProof를 기존 /v1/sessions가 200으로 받아들이던 경계를 재현했다. 최종 관련 테스트는 **34 passed / 1 skipped**다. skip은 기존 execution 테스트의 선택적 ROTATION_PRODUCER_FIXTURE 미제공이다. ownership fixture는 실제 A+ service 산출물로 실행했다.

Node 22.23.1에서 injected ESBUILD_BINARY_PATH를 제거하고 검증했다.
- Happy server에서 `pnpm exec vitest run sources/app/session/sessionOwnershipBinding.spec.ts sources/app/session/sessionExecutionBinding.spec.ts sources/app/api/routes/executionBindingRoutes.spec.ts`: 3 files / 34 passed / 1 skipped.
- `pnpm -C packages/happy-wire typecheck`, `pnpm -C packages/happy-server typecheck`: 통과.
- `pnpm -C packages/happy-server build:runtime`: 통과, 222 modules standalone bundle.
- 실제 additive migration을 격리 PGlite의 기존 계정/머신/세션 위에 적용해 불변 trigger·삭제·rollback 경계를 검사했다.
- 두 서버 `prisma validate`는 dummy localhost URL로 연결 없이 통과했다. Happy 기존 metrics/driverAdapters deprecation 경고가 남는다. server/wire만 의존성을 설치해서 Vitest의 무관한 app/codium tsconfig 탐색 경고도 있었으나 대상 테스트는 통과했다.
- A+ 관련 5 files / 244 tests 통과. 두 sessionOwnership.ts 사본 동일성 확인. 전체 테스트는 실행하지 않았다.

교차 검증은 A+ service 테스트의 OWNERSHIP_PRODUCER_OUTPUT에 절대 경로를 지정하고 Happy 테스트의 OWNERSHIP_PRODUCER_FIXTURE로 읽는다. synthetic 공개키/body/proof만 내보내며 Happy에서 다시 서명하지 않는다. private key/bearer는 출력하지 않는다.

## 연동 계약

서명 DTO 정본은 Happy `packages/happy-wire/src/sessionOwnership.ts`, A+의 동일 사본은 `packages/web-ui/server/rotationWire/sessionOwnership.ts`다. strict JSON, 중복 key 거부, Ed25519 flat signature, canonical JSON 및 `saycode-session-ownership/v1\0<type>\0` domain을 사용한다. issuer는 A+ canonical origin, audience는 Happy canonical origin, keyId는 raw 32-byte 공개키의 SHA-256 hex다. intent는 120초, proof/assertion/confirmed receipt/descriptor/contact는 최대 60초다.

| 경계 | 요청·응답 |
|---|---|
| A+ GET `/api/v2/session-ownership/capabilities` | signer와 Happy capability가 준비돼야 sessionOwnershipV1/ownerRelayV1=true |
| A+ POST `/api/v2/session-ownership/intents` | 개인 bearer, OwnershipIntentRequestSchema → {intent} |
| A+ POST `.../intents/:id/seal` | 원래 개인 bearer, OwnershipPrepareReceiptSchema → {ownershipProof} |
| A+ GET `.../intents/:id` | 원래 개인 bearer 및 현재 인가 → {intent,proof,state,confirmation}; 만료 뒤에도 기존 작업 조회 가능 |
| Happy POST `/v1/sessions` | 기존 Happy account bearer, optional ownershipProof/executionProof; 기존 session 응답에 ownership:{sessionId,ownershipBindingId,registrationState,createDigest} 추가 |
| A+ POST `.../:sessionId/confirm` | 원래 개인 bearer, {requestId,intentId,bindingId,createDigest}; confirmed=200+서명 receipt, pending=202, blocked=403 |
| A+ POST `.../lookup` | 개인 bearer, {sessionIds:[최대 100]} → {ownership:[OwnershipView]}; read ACL을 owner와 따로 검사 |
| A+ POST `/api/v2/machines/:id/agent-identity` | runtime의 Happy account credential, body {} → {descriptor}; Happy account+machine 및 A+ 유일 개인 대응/등록 revision 검사 |
| A+ POST `.../:hubId/relays` | 개인 bearer, OwnershipRelayRegistrationSchema → {contact}; main이 private daemon RPC에서 검증한 caller record를 전달 |
| A+ POST `.../:hubId/relays/lookup` | machine credential, {machineId,callerBindingId,hostEpoch} → {contacts}; 현재 source authority 재검증 |
| A+ DELETE `.../:hubId/relays/:desktopInstanceId` | 원래 개인 bearer, {epoch}; 늦은 철회가 새 epoch를 폐기하지 않음 |

Happy의 `/v1/session-ownership/{lookup,machine}`와 `/:id/confirm`은 A+ 서명 assertion만 받는다. internal lookup의 후보 binding은 개인 BFF 응답으로 노출하지 않는다. Happy `/machine-identity`는 account credential에 machine 행을 대조한다. machine credential만으로 개인 intent/seal/confirm/relay를 발급하지 않는다. 회사 descriptor의 ownerSubject는 null이며 개인성 증거로 사용할 수 없다.

## 설정·복구

- Happy: `HAPPY_SESSION_OWNERSHIP_ENABLED=1`, `HAPPY_SESSION_OWNERSHIP_ISSUER`, `HAPPY_SESSION_OWNERSHIP_AUDIENCE`, `HAPPY_SESSION_OWNERSHIP_PUBLIC_KEYS` (keyId → base64url raw 공개키 JSON).
- A+: `APLUS_SESSION_OWNERSHIP_ENABLED=1`, `APLUS_PUBLIC_BASE_URL`, `APLUS_HAPPY_PUBLIC_ORIGIN`, `APLUS_SESSION_OWNERSHIP_SIGNING_KEY` (Ed25519 PKCS8 DER의 base64), 기존 `HAPPY_SERVER_URL` (서버 간 전송 주소).
- 기본 OFF이며 설정 누락·알 수 없는 키·상위 서버 미지원은 unavailable이다. 임의 proof 오류를 unsigned 성공으로 낮추지 않는다.
- 두 DB migration은 additive이고 기존 행을 채우지 않는다. rollback은 producer/relay를 끄고 tables/journal을 보존한다. 운영 DB와 설정은 변경하지 않았다.

## 후속·미확인

- 지휘 세션의 고정 SHA 교차 리뷰, PR 생성과 통합. 이 작업은 branch push까지만 수행한다.
- T4rt의 daemon prepare/commit/start/status journal, main 개인 인증 세대와 caller launch/재개 RPC 검증, T1c main transport/relay 실제 호출, T2 미확인 표시와 통합 수락은 별도다.
- ownedSpawnPrepareV1/inputEvidenceV1는 runtime 담당이 구현·광고한다. 이 서버가 해당 capability를 광고하지 않는다.
- happy-wire 기존 export/manifest/pin을 수정하지 않았으므로 runtime package 소비를 위한 export는 통합 담당이 반영해야 한다. Happy server는 source alias로 bundling을 검증했다.
- 운영 데이터의 개인 계정 유일 대응, 실 daemon 지연/복구, 배포 artifact end-to-end는 미검증이다. shared credential의 고의적 protocol 우회와 같은 OS 악성 사용자는 승인된 신뢰 경계 (ii)의 잔여 위험이다.
- 설계의 공개 API·권한 의미 변경은 없다. 물리적 tombstone FK와 production authority adapter 분리 이유는 plan에 기록했다. reason-network 전체 기능이 진행 중이므로 이 하위 작업 기록은 아직 archive하지 않는다.
