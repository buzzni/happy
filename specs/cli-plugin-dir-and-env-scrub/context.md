---
기능: cli-plugin-dir-and-env-scrub
상태: 진행중(T6 — PR #1160 CI 초록·리뷰봇 approve, 머지 대기)
마지막 갱신: 2026-11-07
---

# context

## 현재 상태
origin/main 9bba63e7b(H1·H2 포함)에서 분기. T1~T4 완료.
검증: `pnpm typecheck` 통과. 실제 unit 프로젝트(전역 `pnpm build` 포함)로 `src/claude` 전체 + `childEnv`·`daemon/sessionEnv`·`managedCodexStartup` 80개 파일 1571건 통과 — 이 에이전트 셸이 물려받은 세션 env(`HAPPY_AI_AUTH_*`·`SAYCODE_MCP_*` 등)를 지우고 실행.

## 결정 로그
- 2026-11-07 `HAPPY_FORK_CODEX_THREAD_ID`는 `HAPPY_FORK` prefix로 이미 덮임. `HAPPY_SIDE_CHAT`(spawn-seed)·`CODEX_THREAD_ID`(session-lineage) 추가 — 근거 spec R5-b.
- 2026-11-07 포크에서 `HAPPY_SIDE_CHAT`·`CODEX_THREAD_ID`를 설정·읽는 코드 없음(R5-c), 상속이 필요한 경로 없음.
- 2026-11-07 플러그인 경로 절대화는 `providerPath`가 아니라 세션 경로(`opts.path`).
- 2026-11-07 인자 해석은 `runClaudeRemote` 앞쪽(`--resume` 추출 옆)에서 한 번. 잘못된 값이 체크포인트·샌드박스 준비 전에 launch를 실패시킨다. `claudeArgs`의 `--plugin-dir`는 `consumeOneTimeFlags`가 지우지 않아 이후 launch·모드 전환에도 계속 실린다.
- 2026-11-07 R5 표기 `happy claude -- --plugin-dir`는 실제로 `--`가 claudeArgs에 남고 터미널 Claude도 `--` 뒤를 피연산자로 읽는다(spec "사실 확인"). 요구사항은 바꾸지 않고 R5-a 계약(`--`에서 멈춤)을 따른다 — 터미널과 같은 동작. 실제로 쓰는 형식은 `happy claude --plugin-dir <dir>`.

- 2026-11-07 교차 리뷰(codex gpt-6.1-sol, high) 3건(모두 major):
  - 반영: 잘못된 `--plugin-dir`가 첫 메시지 전에 예외 → launcher가 입력 없이 무한 재시작. 파싱을 첫 메시지 뒤·`beforeTurn` 전으로 옮기고 `PluginDirArgumentError` 전용 안내문(launcher 테스트는 변경 전 코드에서 마이크로태스크 루프로 멈춤을 확인).
  - 반영: spawn RPC `resumeClaudeSessionId`에 `--plugin-dir=…`를 넣으면 argv에서 별도 옵션이 되어 플러그인으로 실림 → RPC에서 `-`로 시작·NUL·비문자열 거절(빈 값은 기존대로 없음 취급). 복구 경로는 전사 파일 존재 확인이 막아 손대지 않음.
  - 미반영: R5 표기 `happy claude -- --plugin-dir`이 여전히 안 실림. 사유는 위 결정(터미널 Claude도 `--` 뒤를 피연산자로 읽어 같은 동작, R5-a가 `--`에서 멈춤을 명시). 요구사항 문구 조정은 사용자 몫 — PR·보고에 확인 항목으로 올림.

- 2026-11-07 리뷰봇(cicd-buzzni, 532cbc7) approve·발견 없음. 미실행 검사: 실계정 Claude로 `--plugin-dir` 로드 실측(사용자 수동 확인 항목).

## 열린 문제
- (범위 밖) `src/claude` 런처 테스트 4개 파일(setupTokenSwitch·structuredOutput·ContextUsage·startHappyServer) 42건은 Saycode 세션 안의 셸에서 돌리면 그 세션 env 때문에 실패한다(origin/main 소스로도 같은 42건, env를 지우면 108건 모두 통과). CI는 해당 없음.

## 다음 시작점
PR https://github.com/buzzni/happy/pull/1160 — 리뷰봇 반영·CI 확인 뒤 머지는 지휘 세션.
