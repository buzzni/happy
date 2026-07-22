# 세션 생성자(createdBy) metadata 기록 Context

> 마지막 갱신: 2026-07-22 / 상태: 계획 수립 완료, 구현 착수 전(승인 대기)
> 목적: 다음 세션의 Claude가 이 파일 하나만 읽고 즉시 이어서 작업할 수 있게 한다.

## 현재 상태 (3~5문장)

데스크톱(aplus-dev-studio-desktop) 저장소의 대화 검색 기능(`specs/desktop-conversation-search`)
T14가 필요로 하는 `createdBy` metadata를 데스크톱 단독으로는 심을 통로가 없다는 게 확인되어
(REST에 metadata 갱신 엔드포인트 없음, spawn RPC 파라미터 닫힌 스키마, `update-session` 소켓
이벤트는 서버→클라이언트 단방향), 이 vendor/happy 저장소 쪽에 별도 spec으로 분리했다.
spec.md/plan.md/tasks.md까지 작성 완료, 아직 코드 작업은 시작 안 함(Phase 1 승인 대기).

## 핵심 결정 로그 (누적, 최신이 위)

- [2026-07-22] 결정: 기존 `parentSessionId`/`forkedFromMessageId` lineage 파이프(RPC 파라미터
  → `extraEnv`의 `HAPPY_*` env → 러너가 읽어 metadata에 조건부 스프레드)를 그대로 재사용 /
  이유: 새 소켓 이벤트·REST 엔드포인트 없이 기존 패턴만으로 충분함이 코드 실측으로 확인됨
  (`run.ts:484-503`, `createSessionMetadata.ts:97-98`) / 기각한 대안: 데스크톱의
  `environmentVariables`(프로젝트 env-group 마운트) 맵 재사용 — 실제 에이전트 child process
  셸 env에 그대로 노출돼 제어값과 사용자값이 섞임; happy-server에 새 PATCH 엔드포인트 — 서버가
  이미 metadata를 opaque 문자열로만 다뤄 불필요.
- [2026-07-22] 결정: `SESSION_LINEAGE_ENV_PREFIXES`에 `HAPPY_CREATED_BY` 추가 / 이유: 매
  spawn마다 그 시점의 실제 요청자로 다시 채워야지, daemon의 잔여 `process.env`를 통해 이전
  프로세스의 값이 새 세션으로 새어 들어가면 안 됨(기존 `HAPPY_FORK*`/`HAPPY_RECONNECT_*`와
  동일 이유).
- [2026-07-22] 결정: `runClaude.ts`를 공용 팩토리(`createSessionMetadata.ts`)로 통합하는 걸
  구조적 변경(T5)으로 `createdBy` 추가(T6~T7, 동작 변경) 전에 배치 / 이유: Tidy First —
  지금 `runClaude.ts`만 inline 중복이라 `createdBy`를 얹으면 5곳 중 1곳만 다른 패턴이 됨.
- [2026-07-22] 실제 npm 릴리스는 이 spec의 완료 기준에서 제외 / 이유: `AGENTS.md`의 "Happy CLI
  Release Publisher" 정책상 외부 릴리스 뮤테이션은 항상 직전 별도 승인이 필요함. 구현·테스트
  통과까지만 이 spec 책임, 릴리스는 승인 대기 작업으로 tasks.md에 분리해 둠.

## 시도했으나 실패한 접근 ⚠️

(아직 없음 — 구현 미착수)

## 발견된 문제 / 열린 질문

- fork된 세션이 "원래 생성자"를 승계해야 하는지, 아니면 "fork를 트리거한 사람"으로 다시
  채워야 하는지는 이번 스코프에서 후자로 결정했지만(R4/비목표), 실제 사용 패턴을 보고
  재논의될 수 있음.
- happy-cli 버전이 데스크톱과 독립 배포(`1.1.10-aplus.66` 같은 prerelease suffix)라, 이 spec
  구현이 끝나도 실제로 데스크톱이 쓰려면 릴리스 + 데스크톱의 버전 pin 갱신까지 필요.
  `specs/happy-runtime-pin-aplus-56`/`-60` 전례를 참고.

## 다음 세션 시작점

1. 사용자 승인 확인 후 `tasks.md`의 T1부터 순서대로 진행 (Phase 1: RPC 파라미터 → env 스레딩)
2. T1은 `packages/happy-cli/src/modules/common/registerCommonHandlers.ts:140`의
   `SpawnSessionOptions` interface에 두 optional 필드를 추가하는 것부터

## 파일 맵

**읽어야 할 기존 파일**
- `packages/happy-cli/src/modules/common/registerCommonHandlers.ts:140` —
  `SpawnSessionOptions` (T1이 확장할 지점)
- `packages/happy-cli/src/api/apiMachine.ts:241-271` — `spawn-happy-session` RPC 핸들러 (T2)
- `packages/happy-cli/src/daemon/run.ts:400-503` — `spawnSession()`, `extraEnv` 구성 (T3)
- `packages/happy-cli/src/daemon/sessionEnv.ts` — `SESSION_LINEAGE_ENV_PREFIXES`,
  `scrubSessionLineageEnv` (T4)
- `packages/happy-cli/src/utils/createSessionMetadata.ts` — 공용 metadata 팩토리 (T6)
- `packages/happy-cli/src/claude/runClaude.ts:130-192` — inline metadata 구성, T5가 팩토리로
  교체할 지점, T7이 `createdBy` 배선할 지점
- `packages/happy-cli/src/codex/runCodex.ts`, `src/gemini/runGemini.ts`,
  `src/openclaw/runOpenClaw.ts`, `src/agent/acp/runAcp.ts` — T8~T10
- `packages/happy-server/sources/app/api/routes/sessionRoutes.ts:269-276` — 서버가 metadata를
  왜 안 건드려도 되는지 확인용 (R5 근거, 이미 실측 완료·변경 불필요)
- (cross-repo) 데스크톱 `src/sync/sessionCreation.ts`, `sessionCreationModel.ts`,
  `src/App.tsx:8718`(`createSessionForProject`) — T11
- (cross-repo) 데스크톱 `specs/desktop-conversation-search/tasks.md` T14, `context.md` — 이
  spec 완료 후 갱신 대상
