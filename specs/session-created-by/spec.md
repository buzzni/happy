# 세션 생성자(createdBy) metadata 기록 Spec

> 작성일: 2026-07-22 / 상태: 초안
> ⚠️ 승인 후에는 사용자 지시 없이 수정 금지

## 목표

데스크톱 앱(aplus-dev-studio-desktop)의 대화 검색 기능이 "내 대화"를 정확히 판정할 수 있도록,
happy-cli가 세션을 생성하는 시점에 요청 계정(accountId/displayName)을 세션의 암호화 metadata에
additive로 기록한다.

## 배경

- 이 조직은 계정을 공유해서 데스크톱 앱을 쓴다. 세션 레코드에는 원래 "누가 만들었는지"를
  구분할 필드가 없다(작성자 필드 부재).
- 데스크톱 저장소의 `specs/desktop-conversation-search/spec.md` R9(a)가 이 필드(`createdBy`)를
  전제로 "내 대화" 판정을 설계했으나, 조사 결과 데스크톱 앱 단독으로는 세션 생성 시
  임의 metadata를 심을 통로가 없다는 게 확인됨(REST에 metadata 갱신 엔드포인트 없음,
  spawn RPC 파라미터가 닫힌 스키마, `update-session` 소켓 이벤트는 서버→클라이언트 단방향).
- 이 spec은 그 통로를 happy-cli 쪽에 추가하는 작업만 다룬다. 데스크톱 쪽 소비(파서·검색 스코프
  연결)는 `specs/desktop-conversation-search/tasks.md`의 T14가 이어서 담당한다.

## 요구사항

- R1. Given 데스크톱이 `spawn-happy-session` RPC를 호출할 때 `createdByAccountId`/
  `createdByDisplayName`을 함께 보내면, When daemon이 세션 프로세스를 spawn하면, Then
  그 값이 `HAPPY_CREATED_BY_ACCOUNT_ID`/`HAPPY_CREATED_BY_DISPLAY_NAME` 환경변수로
  스폰된 프로세스에 전달된다(`SpawnSessionOptions`에 optional 필드로 추가, 기존
  `parentSessionId`/`forkedFromMessageId` 패턴과 동일).
- R2. Given 위 환경변수가 존재할 때, When claude/codex/gemini/openclaw/acp 5개 백엔드
  러너 중 하나가 세션 metadata를 생성하면, Then `metadata.createdBy = { accountId, displayName }`가
  additive로 추가된다(스프레드 조건부 — 기존 `parentSessionId` 패턴과 동일).
- R3. Given 위 환경변수가 없을 때(구버전 데스크톱, 터미널 직접 실행 등), When metadata가
  생성되면, Then `createdBy` 필드는 아예 없다 — 기존 동작과 100% 동일(회귀 없음).
- R4. Given 세션이 fork/reconnect로 자식 프로세스를 다시 spawn할 때, When daemon이 자신의
  `process.env`를 다음 spawn의 base env로 사용하면, Then `HAPPY_CREATED_BY_*`는 그대로
  물려받지 않는다 — 매 spawn마다 그 시점의 실제 요청자 값으로 다시 채워지거나 없어야 한다
  (`SESSION_LINEAGE_ENV_PREFIXES`에 `HAPPY_CREATED_BY` 추가, 기존 `HAPPY_FORK*`/
  `HAPPY_RECONNECT_*`와 동일한 이유: 이전 프로세스의 잔여 env가 다음 spawn에 새어 들어가면
  안 됨).
- R5. Given happy-server가 세션 `metadata`를 opaque encrypted 문자열로만 다루면(zod 스키마가
  `z.string()`), Then 이 작업은 happy-server 변경이 **필요 없다**(실측 확인:
  `packages/happy-server/sources/app/api/routes/sessionRoutes.ts:269-276`).
- R6. Given `runClaude.ts`가 아직 공용 팩토리(`createSessionMetadata.ts`)를 쓰지 않고 metadata를
  인라인으로 중복 구성하면, Then 이번 작업 전에 **구조적 변경**으로 `runClaude.ts`를 공용
  팩토리 사용으로 통합한다(Tidy First — 동작 변경 없이 먼저 정리한 뒤 `createdBy`를 추가).

## 비목표 (Non-Goals)

- **과거 세션에 대한 소급 작성자 복원** — 원리적으로 불가능. 데스크톱 쪽 `R9(b)` machineId
  근사로만 처리.
- **데스크톱 쪽 파서/검색 스코프 연결** — `specs/desktop-conversation-search`의 T14가 담당.
  이 spec은 metadata에 필드가 "생기게" 하는 것까지만.
- **실제 npm 릴리스(태그 푸시/`npm publish`)** — `AGENTS.md`의 "Happy CLI Release Publisher"
  정책상 외부 릴리스는 사용자의 명시적 승인이 릴리스 직전에 별도로 필요하다. 이 spec의
  완료 기준은 "브랜치에 구현·테스트 통과"까지이며, 배포는 별도 승인 절차.
- **fork된 세션이 원래 생성자를 승계하는 문제** — 이번 스코프에서는 매 spawn 시점의 실제
  요청자를 다시 채우는 것으로 충분하다고 판단(R4). "누가 fork를 트리거했는가"를 원 생성자와
  구분해서 기록하는 건 이번 스코프 밖.
- **에이전트 세션 안에서 `HAPPY_CREATED_BY_*` env가 영구히 안 보이게 하는 것** — 기존
  `HAPPY_FORK*` 패턴과 동일 수준의 보안(다음 자식 spawn으로의 전파만 차단, 현재 프로세스
  자신의 env에는 여전히 존재)으로 충분하다고 판단. 더 강한 격리가 필요해지면 별도 안건.

## 제약

- 호환성: additive-only. 신버전 CLI + 구버전 데스크톱(필드 미전송) = 오늘과 동일 동작.
  구버전 CLI + 신버전 데스크톱(CLI가 새 RPC 파라미터를 무시) = 오늘과 동일 동작(파라미터가
  `params: any`로 느슨하게 destructure되므로 CLI가 몰라도 에러 없음).
- 보안: `accountId`/`displayName`은 이미 같은 경로로 흐르는 `happyToken`/`happySecret`보다
  민감도가 낮다. 새 서버 API·새 저장소·새 암호화 방식 없음.
- 릴리스: 이 spec 범위에서 `npm publish`/태그 푸시를 직접 수행하지 않는다.

## 완료 기준 (Definition of Done)

- [ ] R1~R6에 대응하는 테스트 존재 및 통과(`apiMachine`, `run.ts` spawn 경로, 5개 백엔드
      러너 각각의 metadata 생성 테스트)
- [ ] `pnpm -C packages/happy-cli typecheck` / lint 통과
- [ ] `docs/user-identity.md` 또는 `docs/session-protocol.md`에 `createdBy` 필드 반영
      (어디에 적을지는 plan.md에서 결정)
- [ ] `specs/desktop-conversation-search/tasks.md`의 T14가 이 spec 완료를 전제로 재개 가능한
      상태(데스크톱 쪽 `SpawnSessionOptions`/RPC 콜에 필드가 추가되어 있어야 함 — 이 부분은
      데스크톱 저장소 쪽 작업이므로 이 spec의 tasks.md에도 "cross-repo" 표시로 포함)
