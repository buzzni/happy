# 조직 계정 확인이 막은 요청의 자동 복구

> 관련: `specs/claude-init-timeout-split` (계정 확인의 단계·이유 구분). 이 문서는 확인 실패 뒤 런처가 하는 일만 적는다.

## 문제

며칠 쓰던 기존 대화에 다시 보내면 `CLAUDE_ORGANIZATION_AUTH_NOT_VERIFIED`("Organization Claude stopped because the
assigned account or policy could not be verified")로 막히고, 새 대화는 정상 동작한다는 보고(2026-11-10).

이 거절은 계정 인증 실패(`isClaudeAuthenticationFailure`)로 분류되지 않아 계정 전환·재시도가 하나도 돌지 않았다.
문구만 보여 주고 같은 프로세스·같은 조건으로 기다리므로 다음 메시지도 같은 이유로 막혔다. 새 대화가 되는 이유는
새 프로세스(설치된 CLI, 그때 배정된 계정)로 뜨기 때문이다.

## 요구사항

- R1. 계정 확인 거절은 그 요청이 Claude에 전달되지 않았는지(`requestHeld`)를 함께 알린다. 입력을 내보내기 전의
  거절(초기화·설정·적용·메시지별 재검사)만 전달 전이다. 곁질문 검사·정책 변경 훅·`streamInput` 거절은 전달 여부를 모른다.
- R2. 전달 전 거절이면 런처가 새 provider로 **같은 요청을 그대로** 한 번 다시 보낸다. 기존 대화라도 "이어서 하라"
  안내문으로 바꾸지 않는다(요청이 transcript에 없으므로 안내문은 요청을 잃는다). 재시도 중에는 실패를 알리지 않는다.
- R3. 다시 보낸 요청도 막히면 실패를 알리고, 기다리는 입력이 없으면 세션 프로세스를 끝낸다. 다음 메시지는 대화를
  새 프로세스로 다시 띄운다(대화 기록 유지). 기다리는 입력이 있으면 프로세스를 유지한다.
- R4. 재시도 기회는 provider가 정상 시작(`system/init`)하면 다시 생긴다.
- R5. 관리자 정책(`reason=policy`) 거절과 전달 여부를 모르는 거절은 기존대로 실패만 알린다.

## 비목표

- 끝난 프로세스의 요청을 데몬·서버가 자동 재전송 — 사용자가 한 번 다시 보내야 한다.
- 이미 떠 있는 구버전 프로세스 — 이 코드가 없으므로 이 수정으로 복구되지 않는다. 한 번 수동으로 중지해야 한다.

## 검증

- `npx vitest run --project unit src/claude/claudeRemoteLauncher.credentialRefusal.test.ts src/claude/sdk/credentialPin.test.ts`
- 뮤테이션 확인(2026-11-10): 재시도 제거, 안내문 대체, 종료 제거, 재검사·초기화의 `requestHeld` 제거, 정책 재시도
  각각에서 해당 테스트가 실패함을 확인.
