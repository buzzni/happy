# 턴 중 소비된 task-notification 서버 동기화

> 작성일: 2026-08-22 / 상태: 승인됨 (사용자 지시 — "근본 수정 둘다 계획을 세워서 해줘",
> 데스크탑 specs/self-review-background-notification 의 Fix A)
> ⚠️ 승인 후에는 사용자 지시 없이 수정 금지

## 배경 (실측)

Claude Code의 `run_in_background` Bash/Task 완료 알림(`<task-notification>…`)은 도착
시점의 에이전트 상태에 따라 트랜스크립트에 다르게 기록된다:

- **idle에 도착**: 알림이 새 user 턴이 되어 `type:"user"` 행(문자열 content)으로 기록
  → 스캐너가 정상 동기화 (세션 cmt31ek… 실측).
- **턴 진행 중 도착**: `type:"queue-operation"`(enqueue) + `type:"attachment"`
  (`attachment.type:"queued_command"`, `commandMode:"task-notification"`, `prompt`=알림
  본문) 행으로만 기록되고 **user 행이 생기지 않음** (세션 d95f4aed… 실측: 알림 4건 전부).

스캐너는 `queue-operation`을 내부 이벤트로 건너뛰고, `attachment` 행은
`RawJSONLinesSchema` 불일치로 조용히 버린다. 결과: 서버에 알림 메시지가 0건 → 데스크탑의
launch↔알림 짝맞춤(`hasPendingBackgroundWork`)이 영구 true → 반복 셀프 리뷰·보드
오토파일럿이 그 세션에서 영구 보류 (2026-08-22 진단).

## 요구사항

- R1. `sessionScanner.readSessionEntries`: `type:"attachment"` +
  `attachment.type:"queued_command"` + `attachment.commandMode:"task-notification"` +
  비어 있지 않은 `prompt` 행을, `prompt`를 content로 갖는 **합성 user 메시지**
  (`type:"user"`, `uuid`=attachment 행 uuid, `isSidechain:false`,
  `happyTaskNotification:true`)로 승격해 엔트리로 내보낸다. 키는 uuid — 재스캔·
  `treatExistingAsProcessed` 사전 마킹에서 기존 방식대로 중복 제거된다.
- R2. `sessionProtocolMapper`: `happyTaskNotification:true`인 user 행은 **진행 중 턴을
  닫지 않고** user 텍스트 envelope만 낸다. (일반 user 행의 `closeTurn`은 "새 턴 시작"
  의미라 유지 — 턴 중 알림에 적용하면 살아 있는 턴이 중간에 끝난 것으로 기록되는 별개
  결함을 만든다.)
- R3. 기존 처리 불변: task-notification이 아닌 attachment(goal_status 포함),
  `queue-operation` 행의 처리는 그대로다.
- R4. idle 경로와 중복 없음: idle 소비는 attachment 행을 만들지 않으므로(실측) 승격
  대상이 아예 없다. 이 전제를 테스트 픽스처 주석에 기록한다.

## 비목표

- 알림의 turn 귀속 표시(어느 턴의 백그라운드 작업이었는지 UI 연결) — 데스크탑 몫.
- 릴리스·데스크탑 pin 갱신 — 별도 승인 필요한 외부 작업.

## 완료 기준

- [ ] R1~R3 단위 테스트 (`sessionScanner.test.ts`, `sessionProtocolMapper.test.ts`) 통과
- [ ] `pnpm typecheck`, `pnpm test`(unit) 통과
- [ ] PR 생성
