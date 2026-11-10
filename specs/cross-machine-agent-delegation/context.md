---
기능: cross-machine-agent-delegation
상태: 진행중 — 위임 lane #1183 머지됨. Phase 5 제한 relay(A7·A8, 2026-11-10 승인) 구현, PR 단계(H13)
마지막 갱신: 2026-11-10
---

# 다른 작업PC로 위임 — 데몬 위임 lane Context

## 현재 상태 (3~5문장)

사용자가 2026-11-08 Desktop 승인 항목 A1~A6과 결정 D-1~D-7 권장안을 승인했다. H1~H8(저장소·연결 RPC·위임 lane·spawn/session-key/stop·
metadata `delegatedFrom`·능력 광고·안내 한 줄)을 구현했다. 남은 일은 H9(교차 리뷰·PR·리뷰봇·rebase)와, 지휘 세션 몫인 happy-cli 릴리스·Desktop pin이다.
사용자 시나리오·CLI 계약의 정본은 Desktop `specs/cross-machine-agent-delegation/`다.

## 승인 요청 (구현 중 새로 생김)

- **A7. dataKey 대상 PC의 원격 자식 읽기·프롬프트·조향을 위한 제한 relay** — 승인된 R9는 `agent-delegation:session-key`가
  세션 데이터 키를 돌려주게 했으나, 교차 리뷰(codex gpt-6.1-sol, 2026-11-08)가 그 키가 세션 RPC의 고객 키이기도 해
  `bash`·파일·`machine-run`·`permission` 세션 RPC를 연다는 것을 짚었다(`api/apiSession.ts` RpcHandlerManager +
  `registerCommonHandlers`). 키를 넘기면 위임 lane 허용 목록과 B의 사람 승인(R12)을 우회한다. 그래서 **키를 넘기지 않게 막았다**
  (응답은 `variant`만). 결과: legacy 대상은 R6 그대로, dataKey 대상은 spawn·stop·Desktop 표시·권한 카드는 되지만
  출발 PC CLI의 `read`/`wait`/`prompt`/`steer`는 `remote_session_sealed`로 거절된다.
  제안: 위임 lane에 읽기(복호화한 메시지)·프롬프트 쓰기·조향·상태 프록시 4개를 추가하는 제한 relay. 대안: 세션 RPC 키를 메시지 키와 분리(프로토콜 변경, 범위 큼).

## 핵심 결정 로그 (누적, 최신이 위)

- [2026-11-08] 교차 리뷰 반영: session-key는 데이터 키를 돌려주지 않는다(위 A7). 동시 spawn은 `starting` 예약으로 슬롯을 나눈다.
  자식 기록 실패 시 그 세션을 멈추고 `spawn_failed`. 연결 철회는 자식 기록을 지우지 않는다(실행 중 자식이 상한에서 빠지지 않게),
  256 상한은 끝난 자식부터 지운다. 재시작 뒤 재전송 방지로 spawn `requestId`를 15분 디스크에 기억한다(`request_replayed`).
  Windows UNC 경로 허용.

- [2026-11-08] 구현: spec R8의 요청 필드 `agent: { depth, maxSpawn, agentId }`는 같은 요청의 `agent`(문자열, 에이전트 종류)와 이름이 겹쳐 JSON으로 둘 다 담을 수 없다.
  wire에서는 `agentGrant`로 구현했다(의미 동일). Desktop CLI도 같은 이름을 쓴다.
- [2026-11-08] 구현: R9·R10의 "그 세션 metadata `delegatedFrom.machineId == peer`" 판정은 데몬이 위임 spawn 성공 때 저장소 `children`에 기록한
  `{sessionId, peer}`로 한다 / 이유: 데몬은 세션 metadata를 복호화해 들고 있지 않고, B가 직접 쓴 기록이라 같은 증거다.
- [2026-11-08] 구현: 위임 lane 요청은 항상 바인딩(R18 형식)·시간창·nonce 필수(strict). 서버는 연결 키가 없으므로 재전송 방지가 실제 보호가 된다. nonce 가드는 고객 lane과 분리.
- [2026-11-08] 구현: `stop-session`의 피어 한정은 핸들러 밖 lane `admit` 훅(RpcHandlerManager, 핸들러 호출 전)에 둔다 — 기존 핸들러·서버 lane 동작은 그대로.
- [2026-11-08] 구현: 위임 동시 상한(D-5)은 Desktop `machineSpawnBudget` 공식(메모리 2GiB당 1·코어당 2, 4~32)을 `delegationConcurrencyLimit`로 옮겼다.
  "살아 있음"은 `hasLiveDaemonChild`(추적 중인 프로세스)로 센다.
- [2026-11-08] 구현: 자식 `delegatedFrom`은 `HAPPY_CREATED_BY_DELEGATED_FROM_*` env(스크럽되는 요청자 접두사)로 넘기고 `createSessionMetadata`가 읽는다 — 다섯 러너를 고치지 않는다.
  머신 회전(prepared launch) metadata에도 같은 필드를 넣었다.
- [2026-11-08] 결정: 위임 spawn은 새 메서드 `agent-delegation:spawn` / 이유: `spawn-happy-session`은 입력면이 넓다 / 기각: 기존 메서드를 위임 lane에 허용.
- [2026-11-08] 결정: 키는 Desktop이 만들고 서버는 모른다 / 재검토 조건: owner relay 출시 또는 서버 계정 간 라우팅 도입.
- [2026-11-08] 결정: CLI는 연결 키를 RPC `agent-delegation:targets`로 받는다 / 기각: CLI가 `agent-delegation.json` 직접 읽기.

## 시도했으나 실패한 접근 ⚠️

해당 없음.

## 발견된 문제 / 열린 질문

- (범위 밖) 메인 체크아웃 `/Users/justin/workspace/happy`는 `feat/resumable-agent-observation`, origin/main보다 크게 뒤.

## 다음 세션 시작점

1. H9: PR(#1183 Ready) → 리뷰봇 → rebase·CI. A7 승인 시 제한 relay를 후속 PR로.
2. 릴리스 후 Desktop pin(지휘 세션). 실기 확인은 Desktop context의 사용자 수동 확인 목록.

## 파일 맵

- `packages/happy-cli/src/daemon/agentDelegationStore.ts` — `agent-delegation.json`(0600, 원자적 쓰기, 상한 16, children 256)
- `packages/happy-cli/src/daemon/agentDelegationMethods.ts` — `agent-delegation:*` RPC, lane `admit`, 동시 상한
- `packages/happy-cli/src/api/rpc/delegationLane.ts` — 허용 목록 5개
- `packages/happy-cli/src/api/rpc/RpcHandlerManager.ts` — 세 번째 lane(`openParams`), strict 바인딩, 핸들러 context
- `packages/happy-cli/src/api/apiMachine.ts` — 등록·lane 설치·`agentDelegation` 능력 광고
- `packages/happy-cli/src/daemon/run.ts` — 호스트 배선(managed·Windows 트라이얼 제외), `delegatedFrom` env
- `packages/happy-cli/src/utils/delegatedFrom.ts`·`createSessionMetadata.ts` — metadata `delegatedFrom`
- `packages/happy-cli/src/prompt/agentOrchestrationPrompt.ts` — 안내 한 줄(R12)

## 검증·승인 상태

- 실행한 검증과 결과: `tsc --noEmit` 통과. vitest unit — rpc·daemon delegation·sessionEnv·createSessionMetadata·prompt·apiMachine 관련 파일 통과.
- 미실행 검증과 이유: 실제 두 PC 실기(사용자 수동 확인), 통합 테스트(로컬 자원 규칙).
- 승인된 범위·근거: 2026-11-08 사용자 — A1~A6, D-1~D-7 권장안.
- 남은 승인 대상·재개 조건: 없음. 릴리스·pin은 지휘 세션.
