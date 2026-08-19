# 데몬이 spawn한 세션의 A+ 프로젝트 연결 Spec

> 작성일: 2026-08-19 / 상태: 초안
> ⚠️ 승인 후에는 사용자 지시 없이 수정 금지
> 선행(서버측, 이미 구현됨): aplus-dev-studio `specs/cli-agent-spawn-project-visibility-server`
> (PR #2203), buzzni/happy `machineSessionOwnerRoutes.ts` (PR #217)

## 목표

데몬이 `spawn-happy-session` RPC로 **세션 생성에 성공한 직후**, A+ 서버에 그 세션을 알려
프로젝트 대화 목록에 나타나게 한다.

## 배경

`saycode agent spawn`으로 만든 세션은 CLI에서는 완전히 쓸 수 있지만 A+ 앱의 프로젝트별 대화
목록에는 뜨지 않는다. 원인은 A+가 세션↔프로젝트 매핑을 별도로 저장하고, 그 매핑을 만드는
엔드포인트가 `/api/*`이기 때문이다 — spawn된 세션의 CLI는 sync-only `access.key`로 인증해서
`/api/*`에 접근할 수단이 아예 없다(실측 401).

**서버 양쪽은 이미 완성됐고, 호출자만 없다.**

- A+ `POST /api/agent-spawn/session-link` — `{machineId, sessionId, directory}`를 받아
  Happy에 소유권을 확인시키고, machine/project 접근을 재검증한 뒤 매핑을 만든다.
- Happy `POST /v1/machine-sessions/:sessionId/owner` — `AccessKey` 행으로 소유권을 답한다.

이 spec은 그 **호출자를 데몬에 배선**하는 마지막 조각이다.

### 배선 지점은 이미 정해져 있다

`packages/happy-cli/src/api/apiMachine.ts`의 `spawn-happy-session` 핸들러 성공 분기가 유일한
후보다. 이 지점에서 필요한 세 값이 **모두 이미 손에 있다**:

```ts
case 'success':
    logger.debug(`[API MACHINE] Spawned session ${result.sessionId}`);
    return { type: 'success', sessionId: result.sessionId };   // ← 여기
```

- `result.sessionId` — 생성된 세션 (성공 분기에서만 존재)
- `directory` — RPC params에서 이미 검증됨(`if (!directory) throw`)
- `machineId` — RPC params

호출에 필요한 자격증명·URL도 이미 데몬이 갖고 있고, 같은 목적의 선례가 있다.
`packages/happy-cli/src/daemon/run.ts`의 `linkSession`이 automation run에 대해 정확히 같은 일을
하며 `credentials.token`(machine token)과 `process.env.HAPPY_APLUS_MCP_CONFIG_URL`을 쓴다.
새로 만들 것은 **fetch 헬퍼 하나와 DI 배선 하나**뿐이다.

## 요구사항

- **R1.** Given `spawn-happy-session`이 세션 생성에 성공하면, When 데몬에 A+ config URL과
  machine token이 있으면, Then `POST {configUrl}/api/agent-spawn/session-link`에
  `{machineId, sessionId, directory}`를 보낸다.
- **R2.** Given 연결 호출이 어떤 이유로든 실패(네트워크·타임아웃·4xx·5xx)하면, Then
  **spawn RPC 응답은 성공 그대로 유지**한다. 세션은 이미 만들어졌고 쓸 수 있다 — 목록에 안
  보이는 것이 세션을 못 쓰게 만드는 것보다 낫다.
- **R3.** Given 연결 호출이 느리면, Then spawn RPC 응답을 지연시키지 않는다. 사용자가 기다리는
  것은 세션이지 목록 반영이 아니다.
- **R4.** Given `HAPPY_APLUS_MCP_CONFIG_URL`이 없으면(A+와 무관한 순수 Happy 데몬), Then
  호출을 시도하지 않고 조용히 건너뛴다 — 새 에러나 경고를 만들지 않는다.
  `linkAutomationProjectSession`의 기존 skip 동작과 동일하다.
- **R5.** Given 연결 결과가 무엇이든, Then 실패는 `logger.debug`로만 남긴다. 사용자가 조치할
  수 없는 실패를 상위 로그 레벨로 올리면 로그만 오염된다.
- **R6.** `spawn-happy-session`의 요청 파라미터·응답 계약(`{type:'success', sessionId}` 등)은
  변경하지 않는다.

## 비목표 (Non-Goals)

- **디렉터리→프로젝트 매칭** — A+ 서버가 소유한다. 데몬은 `directory`를 그대로 보내기만 하고
  어느 프로젝트인지 판단하지 않는다(데몬은 A+ 프로젝트 개념을 몰라야 한다).
- **재시도 큐·영속화** — 한 번 시도하고 실패하면 버린다. 재시도가 필요할 만큼 중요한 기능이
  아니고(세션은 이미 정상 동작), 재시도 상태를 데몬에 들이면 수명주기가 복잡해진다.
- **`resume-session`/`recover-session` 경로** — 그 세션들은 이미 매핑이 있거나 A+가 만든 것이다.
  spawn 경로만 다룬다.
- **A+/Happy 서버 변경** — 둘 다 이미 구현·검증됨(선행 문서 참고).

## 제약

- **선행 배포 순서**: Happy Server PR #217이 merge·릴리스되고 A+가 그 버전을 바라보기 전에는
  이 호출이 항상 503을 받는다(A+가 구버전 Happy의 404를 unavailable로 읽도록 설계됨).
  기능이 실제로 동작하려면 #217 → A+ #2203 → 이 배선 순서가 필요하지만, **R2/R5 때문에 순서가
  틀려도 아무것도 깨지지 않는다**(조용한 debug 로그만 남는다).
- **중복 등록 안전**: Desktop이 만든 세션에도 이 호출이 나갈 수 있다. A+ 쪽이 안전하다 —
  `ensureSessionToProject`는 이미 매핑이 있으면 early-return하고, Desktop의
  `assignSessionToProject`는 caller의 기존 매핑을 지우고 다시 쓴다. 즉 **어느 순서로 도착해도
  Desktop의 명시적 선택이 이긴다.**
- **`linkAutomationProjectSession`을 재사용하지 않는다** — 엔드포인트·본문·검증 방식이 다르다
  (automation은 `runId`/`claimToken`을 보낸다). 같은 파일에 형제 함수로 두되 본문은 공유하지
  않는다.

## 완료 기준 (Definition of Done)

- [ ] R1~R6에 대응하는 단위 테스트 통과 (성공 호출 / 실패해도 spawn 성공 유지 / config URL
  없으면 skip / spawn 응답 지연 없음)
- [ ] `spawn-happy-session` 기존 테스트(`apiMachine.spawnCreatedBy.test.ts` 등) 회귀 없음
- [ ] `tsc --noEmit` 오류 0건, happy-cli 테스트 통과
- [ ] 선행 배포(#217, #2203) 완료 후 실제 `saycode agent spawn` → A+ 프로젝트 목록에 세션이
  나타나는 것 확인 — **선행 3개 저장소의 마지막 조각이므로 여기서 처음으로 E2E가 가능해진다**
