# 세션 생성자(createdBy) metadata 기록 Context

> 마지막 갱신: 2026-07-23 / 상태: **완료.** PR #99 머지 + `happy-cli-v1.1.10-aplus.67` 릴리스
> (npm 배포 확인) + 데스크톱 버전 pin 갱신 + 데스크톱 파서/검색 스코프 소비까지 전부 끝남.
> 목적: 다음 세션의 Claude가 이 파일 하나만 읽고 즉시 이어서 작업할 수 있게 한다.

## 현재 상태 (3~5문장)

데스크톱(aplus-dev-studio-desktop) 저장소의 대화 검색 기능(`specs/desktop-conversation-search`)
T14가 필요로 하는 `createdBy` metadata를 데스크톱 단독으로는 심을 통로가 없다는 게 확인되어
(REST에 metadata 갱신 엔드포인트 없음, spawn RPC 파라미터 닫힌 스키마, `update-session` 소켓
이벤트는 서버→클라이언트 단방향), 이 vendor/happy 저장소 쪽에 별도 spec으로 분리했다.
Phase 1(T1~T4)·Phase 2(T5)에 이어 Phase 3(T6~T10)까지 완료 — happy-cli 쪽 구현은 이제 끝났다.
`Metadata.createdBy`/`createSessionMetadata()`에 필드 추가(T6) → claude/codex/gemini/openclaw/acp
5개 백엔드 러너 전부가 `HAPPY_CREATED_BY_ACCOUNT_ID`/`_DISPLAY_NAME` env를 읽어 metadata에
반영(T7~T10). typecheck 통과, 전체 유닛 스위트 137파일/1240개 통과. 브랜치 `keen-panda-bjgb`에
7개 커밋(be89583c, 35685df1, 60a349e9, a94bdad7, fd039726, d27beb50, 4f59d90f). Phase 4(T11~T12,
cross-repo)도 완료: 데스크톱의 `createDesktopProjectSession`이 `createdByAccountId`/
`createdByDisplayName`을 spawn RPC에 실어 보내도록 배선(데스크톱 저장소 커밋 3a9c729, 전체
스위트 194파일/2183개 통과), `specs/desktop-conversation-search`의 T14 상태도 갱신. Phase 5(T13,
문서화)도 완료: `docs/user-identity.md`에 "Session `createdBy` (shared-account orgs)" 절 추가
(커밋 대상, 아래 참고). **이 spec의 구현·문서화는 전부 끝났다.** 남은 건 이 spec 범위 밖인
실제 happy-cli 릴리스(버전 bump·태그·`npm publish`) + 데스크톱의 happy-cli 버전 pin 갱신 —
둘 다 사용자의 별도 명시적 승인이 필요.

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
- [2026-07-22] 원래 작업하던 `keen-panda-bjgb` 브랜치가 아니라 `main` 기준 새 브랜치
  `session-created-by`에서 9개 커밋을 cherry-pick해 PR #99를 열었다 / 이유: `keen-panda-bjgb`에
  이미 무관한 PR #98("Fix Codex terminal and tool event ordering")이 열려 있어서, 그대로
  push하면 이 작업이 그 PR에 섞여 들어갔을 것. `keen-panda-bjgb`는 원래 상태(로컬에 커밋은
  남아있지만 push 안 함)로 되돌려 PR #98을 건드리지 않음.

## 시도했으나 실패한 접근 ⚠️

(아직 없음 — 구현 미착수)

## 발견된 문제 / 열린 질문

- T8~T10(codex/gemini/openclaw/acp)은 `runClaude.test.ts`급 전용 harness 테스트가 없다 —
  이 저장소에 원래 그 4개 러너의 세션-생성 진입점을 도는 단위 테스트 자체가 없었다(runClaude만
  예외적으로 있었음). 새로 harness를 만드는 대신 `createSessionMetadata()` 자체의 커버리지(T6,
  8케이스)와 동일 패턴이 실증된 T7로 대체 검증하고 전체 스위트 회귀로 확인했다. 더 강한 보증이
  필요해지면 각 러너에 `runClaude.test.ts`와 같은 harness를 만드는 걸 별도 작업으로 제안할 것.

- fork된 세션이 "원래 생성자"를 승계해야 하는지, 아니면 "fork를 트리거한 사람"으로 다시
  채워야 하는지는 이번 스코프에서 후자로 결정했지만(R4/비목표), 실제 사용 패턴을 보고
  재논의될 수 있음.
- happy-cli 버전이 데스크톱과 독립 배포(`1.1.10-aplus.66` 같은 prerelease suffix)라, 이 spec
  구현이 끝나도 실제로 데스크톱이 쓰려면 릴리스 + 데스크톱의 버전 pin 갱신까지 필요.
  `specs/happy-runtime-pin-aplus-56`/`-60` 전례를 참고.

## 다음 세션 시작점

**이 spec은 완전히 종료됐다 — 재개할 것 없음.** 진행 기록(추적용):

1. PR #99가 `main`에 머지됨(PR #98 Codex 순서 수정도 함께).
2. `packages/happy-cli/package.json`을 `1.1.10-aplus.67`로 bump → 로컬 빌드+테스트(137파일/
   1240개) 통과 확인 → `main`에 직접 커밋+push → `happy-cli-v1.1.10-aplus.67` 태그 push →
   GitHub Actions `Publish @buzzni/happy-cli`(run 29929973385) 성공 → `npm view
   @buzzni/happy-cli@1.1.10-aplus.67 version`으로 레지스트리 반영 실측 확인.
3. 데스크톱 `config/happy-runtime-pin.json`을 `.67`로 갱신, standalone runtime 재staging,
   전체 회귀(198파일/2238개) 통과 (`specs/happy-runtime-pin-aplus-67` 참고).
4. 데스크톱 `specs/desktop-conversation-search`의 T14 완료: `apiSessionToSession`
   (`src/sync/messageParser.ts`)이 `createdBy`를 additive로 파싱, `GlobalSearchPanel`이
   `filterSessionsToMine`에 실제 `createdBy?.accountId`를 전달하도록 배선(이전엔 하드코딩된
   `null`이었음). R9(a/b/c) 전부 구현 완료.

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
