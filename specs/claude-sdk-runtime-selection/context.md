---
기능: claude-sdk-runtime-selection
상태: 구현·로컬 검증 완료, 1.1.10-aplus.249 릴리스 준비
마지막 갱신: 2026-10-22
---

## 구현과 결정
Happy CLI의 SDK pin을 0.3.276에서 0.3.283으로 갱신했다. 내장 Claude의 실제 버전은 2.1.283이다. 기본 bundled 선택을 유지하며 기존 HAPPY_CLAUDE_PATH를 SDK pathToClaudeCodeExecutable에 연결했다. 실경로·파일·접근 권한을 확인하고 잘못된 명시 선택은 실행 전에 거절한다. 검사에서 외부 프로세스를 실행하지 않고 spawnClaudeCodeProcess와 SDK sandbox 연결을 유지한다.

## 검증
- query 경계: 구현 전 추가 9개 실패와 기존 16개 통과를 확인했다.
- 구현 후 query 25, claudeRemote 55, claudeSdkSandbox 15, claudeProcessSandbox 5: 총 100개 통과.
- 위 Vitest global setup의 CLI build(타입 검사 포함) 통과. 기존 pkgroll bin/empty chunk 경고는 유지되며 이 변경으로 추가된 경고는 없다.
- 실제 SDK 어댑터를 통해 임시 작업 디렉터리, 도구 없음, model=claude-opus-5-5, effort=low로 실행했다. 기본 bundled와 HAPPY_CLAUDE_PATH=/Users/justin/.hermes/node/bin/claude 각각 success 및 CLAUDE_RUNTIME_OK 응답 확인.
- SDK 0.3.283 내장 실행 파일에 --version을 실행해 2.1.283 확인.
- git diff --check 통과. 전체 테스트는 실행하지 않았다.

## SDK pin 0.3.285 (2026-10-01)
Sonnet 5.5 routine 라우팅(feat/sonnet-5-5-gpt-6-1-sol)에 맞춰 pin을 0.3.283 → 0.3.285(내장 Claude Code 2.1.283 → 2.1.285)로 올렸다.
- 이유: 2.1.283은 claude-sonnet-5-5를 모르는 모델로 취급해 "isn't described by this version's model catalog … auto-compact keeps this session within 200k tokens"(`[claude-code:unrecognized_model]`)를 출력한다. 2.1.285는 경고 없이 실행된다. 내장 바이너리 문자열 검사로도 `claude-sonnet-5-5`가 2.1.283에는 0회, 2.1.285에는 12회 나온다. 이 브랜치가 claude-sonnet-5-5/medium을 조직 공유 routine 경로로 만들므로 내장 런타임이 이 모델을 알아야 한다.
- 드레인 동작 재확인: 0.3.285 실 SDK로 스트리밍 턴 중 `interrupt()` → `error_during_execution` → 입력 종료 시 프로세스가 code 1, signal 없음, killed=false로 끝나는 것을 재현했다(claudeDrainProvider의 "exit 1은 clean" 규칙 유지).
- 오진 기록: `runClaudeOfflineAck.test.ts` 첫 테스트가 0.3.285에서 5초 타임아웃을 넘긴 것은 SDK 비용이 아니다. 두 버전을 번갈아 측정한 결과 runClaude 모듈 그래프 로드 CPU가 1.1–1.3초로 같고 SDK 단독 import도 55–70ms로 같았다. 벽시계 시간만 호스트 부하(load avg 225–312, 14코어)에 따라 2–11초로 흔들렸다. 테스트 본문 안에서 동적 import하던 것을 정적 import로 옮겨 수집 단계로 뺐다.
- 재검토 조건: routine/기본 라우팅 표에 새 Claude 모델이 들어갈 때(내장 카탈로그에 있는지 `[claude-code:unrecognized_model]`로 확인), SDK를 다시 올릴 때 드레인 exit code 규칙이 바뀌었을 때, 또는 HAPPY_CLAUDE_PATH 외부 바이너리 기본 사용으로 전환할 때.

## SDK pin 0.3.308 (2026-10-22)
pin을 0.3.285 → 0.3.308(내장 Claude Code 2.1.285 → 2.1.308)로 올렸다. lockfile 변경은 SDK와 플랫폼 바이너리 8개뿐이다.
- 이유: 도구 정책(aplus-dev-studio `specs/agent-tool-policy`) 훅의 `onFailure: "block"`을 2.1.285는 무시했다. 2.1.295부터 지원되며, 2.1.308 실측에서
  훅 명령 시작 실패(실행 파일·스크립트 없음, 실행 권한 없음)·exit 1·시간 초과·SIGKILL/SIGTERM이 모두 차단됐다(2.1.285는 전부 실행). 실측 표는 Desktop
  `specs/agent-tool-policy/context.md` "S1 실측(2.1.308)". `claudeHook.integration.test.ts`가 "forwarder가 시작조차 못 하면 막힌다"를 실제 CLI로 고정한다
  (`HAPPY_CLAUDE_PATH`로 2.1.285를 지정하면 실패한다).
- 드레인 동작 재확인: 0.3.308로 스트리밍 턴 중 `interrupt()` → `error_during_execution` → 입력 종료 시 code 1·signal 없음·killed=false 그대로(가짜 API 서버, 2회).
- SDK 표면 점검(0.3.286~0.3.308 CHANGELOG): `permissionMode` 생략 시 Claude Code 기본값을 따르게 바뀌었다(0.3.286·0.3.302) — `claudeRemote`는 항상
  넘기고, 쓰기 범위 probe는 턴을 돌리지 않아 영향 없음. 옵션 값이 `--flag=value`로 바뀌었다(0.3.295) — `spawnClaudeCodeProcess` 래퍼들은 argv를 해석하지
  않고 그대로 넘겨 영향 없음. PreToolUse 훅의 `updatedInput` 검증 강화(0.3.300)는 Happy 훅이 `updatedInput`을 내지 않아 무관. fork 서브에이전트가 SDK
  세션에서 기본 켜짐(0.3.302, `CLAUDE_CODE_FORK_SUBAGENT=0`으로 끔). `setMcpServers` 뒤 같은 이름 사용자 서버로 바뀌던 결함 수정(0.3.305) — 실측상
  2.1.285·2.1.308 모두 SDK 항목이 이겼다.
- 라우팅 표의 trivial 모델 `claude-haiku-5-5`는 2.1.285 내장 바이너리에 0회, 2.1.308에 34회 나온다(이전 pin은 이 모델을 몰랐다).
- 로컬(터미널) 모드는 SDK 내장본이 아니라 전역 설치 Claude(`claude_version_utils.cjs`)를 띄우므로 이 pin과 무관하다. 전역 Claude가 2.1.295 미만이면
  훅 시작 실패 구멍이 그대로 남는다.
- 검증: `tsc --noEmit`, 관련 vitest 48파일(780건, 1건은 병렬 부하에서만 실패 — `claudeRemoteLauncherContextUsage` 단독 재실행 통과), 실제 CLI 통합
  (`claudeHook.integration` 4건), 실제 세션 스모크 1회(권한 요청 → Write → success), `pnpm run build`.
- 기존 문제(이번 범위 밖): `planMode.integration.test.ts`의 `MODEL = 'claude-sonnet-4-20250514'`는 2026-06-15 은퇴 모델이라 두 버전 모두에서 항상 건너뛴다.
- 재검토 조건: 다시 pin을 올릴 때 훅 실패 표(Desktop context)와 드레인 exit code를 재실측. Claude가 `onFailure` 의미를 바꾸면 forwarder 자체 fail-closed는 유지.

## 반영 범위와 재개
소스와 lockfile, spec을 vendor/happy에 수정했다. 설치된 전역 Happy/운영 daemon/Desktop runtime은 교체하지 않았다. Desktop 자식 생성·패널·재개 및 Linux mandatory sandbox와 Windows 실제 실행은 이번 변경으로 검증하지 않았다. 관련 단위 회귀가 실제 OS 검증을 대신하지 않는다.
배포하려면 변경된 Happy의 릴리스 artifact를 준비·검증하고 외부 release 직전에 사용자 승인을 받아 공식 CI publisher로 발행한 뒤 Desktop pin/설치본을 갱신한다. 기존 다른 사용자의 untracked memory 파일은 변경하지 않았다.

## 릴리스
사용자의 명시적 릴리스 요청(2026-09-27)에 따라 PR #563 merge b73fc749 기준 1.1.10-aplus.249를 준비한다. 버전 변경 main 반영 → matching tag push → 공식 Actions publish/registry smoke → 상위 vendor 포인터 반영 순서다. 실행 중인 사용자 daemon은 임의 종료하지 않는다.
