# 데몬 spawn 세션 프로젝트 연결 Plan

> 작성일: 2026-08-19 / 상태: Phase 1·2 완료, Phase 3은 회귀검증만 완료(E2E는 선행 배포 대기)
> 근거 문서: [spec.md](./spec.md)

## 아키텍처 영향

| 항목 | 내용 |
|------|------|
| 관련 모듈 | `daemon/automations/automationMcpCallerGrant.ts`(형제 함수 추가), `api/apiMachine.ts`(성공 분기 훅), `daemon/run.ts`(DI 배선) |
| 새 외부 의존성 | 없음 |
| 공개 API 변경 | 없음 — `spawn-happy-session`의 요청/응답 계약 불변. `MachineRpcHandlers`에 **선택적** 필드 하나 추가 |
| 데이터 스키마 변경 | 없음 |

**ADR 불필요**: 새 신뢰 경계나 위협 모델이 없다. 이미 있는 machine token을 이미 있는 A+
엔드포인트에 쓰는 것이고, 소유권 검증은 서버가 한다.

## 접근 방식

`linkAutomationProjectSession`과 같은 모양의 형제 함수를 만들고, spawn 성공 분기에서
**await 하지 않고** 부른다.

1. `linkSpawnedProjectSession({configUrl, machineToken, machineId, sessionId, directory})` —
   기존 automation 링크 함수 바로 옆에 추가. config URL 없으면 `{ok:true, skipped:true}`,
   실패는 `{ok:false, error}`로만 돌려주고 절대 throw하지 않는다.
2. `MachineRpcHandlers`에 `linkSpawnedSession?: (input:{sessionId, directory}) => void` 추가.
   **반환이 `void`인 것이 의도적** — 호출부가 await할 수 없게 만들어 R3(지연 금지)를 타입으로
   강제한다.
3. `apiMachine.ts`의 `case 'success'`에서 `this.linkSpawnedSession?.({...})` 호출 후 즉시 기존
   응답 반환.
4. `run.ts`에서 `credentials.token` / `HAPPY_APLUS_MCP_CONFIG_URL`로 주입 —
   기존 `linkSession` 배선 바로 옆.

### 기각한 대안

- **spawn 성공 응답 전에 await** — R3 위반. 링크는 사용자가 기다리는 대상이 아니고, A+가 느리면
  세션 생성 전체가 느려 보인다.
- **`linkAutomationProjectSession` 시그니처 확장(runId optional)** — 한 함수가 서로 다른 두
  엔드포인트를 분기하게 되고, automation 쪽 필수 검증이 optional로 느슨해진다. 실수로
  claimToken 없이 automation 링크를 부를 수 있게 되는 쪽이 더 위험하다.
- **실패 재시도 큐** — 비목표. 세션은 이미 정상 동작하므로 복잡도에 값하지 않는다.

## 단계 (Phases)

- [x] **Phase 1: 링크 함수** → `linkSpawnedProjectSession` 추가.
  검증: config URL 없음(skip) / 성공 / 비2xx / 타임아웃 네 케이스가 **throw 없이** 결과 객체로
  구분되는지 단위 테스트
- [x] **Phase 2: spawn 훅 + DI** → `MachineRpcHandlers` 선택 필드, `apiMachine.ts` 성공 분기,
  `run.ts` 배선.
  검증: 훅이 `{sessionId, directory}`로 호출되는지 / 훅이 throw해도 spawn 응답이 success인지 /
  훅 미주입(undefined)이어도 동작하는지 / `case 'error'`·`requestToApproveDirectoryCreation`
  분기에서는 호출되지 않는지
- [~] **Phase 3: 회귀·E2E** → happy-cli 테스트 전체 + typecheck. 선행 배포(#217, #2203) 이후
  실제 `saycode agent spawn`으로 A+ 목록 확인

## 리스크와 대응

- **spawn을 깨뜨리는 것이 최악** — 훅 반환을 `void`로 두고 호출부를 `try/catch`로 감싼다.
  Phase 2에 "훅이 throw해도 spawn 성공" 테스트를 반드시 넣는다.
- **떠도는 Promise(unhandled rejection)** — `void` 반환이라도 내부 async가 reject하면 프로세스
  경고가 뜬다. 링크 함수가 절대 throw하지 않도록 만들고(Phase 1), 호출부에서도 `.catch()`로
  한 번 더 막는다.
- **선행 배포 전 소음** — 그 기간 동안 매 spawn마다 503 debug 로그가 남는다. R5대로 debug
  레벨이라 무해하지만, 배포 순서(#217 → #2203 → 이 배선)를 지키면 짧게 끝난다.
