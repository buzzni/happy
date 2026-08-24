# Agent 명령 direct-entry provider 격리 Context

> 마지막 갱신: 2026-08-24 / 상태: 셀프 리뷰 2/3 수정·검증 완료 — PR #241 리뷰 대기

## 현재 상태

사고 원인은 provider-native sub-agent가 아니라 개발 smoke가 wrapper를 우회해 direct entrypoint에
`agent whoami --json`을 전달한 것이었다. source entrypoint가 이를 기본 Claude 인자로 처리해 기존
Codex session에 Claude를 재연결했고 session flavor가 오염됐다. Red 테스트 후 bundled Saycode CLI로
조기 위임하는 handler와 `index.ts` dispatch를 구현했다. 최신 `origin/main` 기준 관련 테스트 2개,
typecheck, build, 전체 unit 214파일/2,238테스트가 통과했고 build 산출물의 success/failure smoke도
각각 exit 0/2로 끝났다. 구현 commit `42924835`를 push했고 `origin/main` 대상 PR #241을 생성했다.
셀프 리뷰 1/4에서 실제 `dist/index.mjs` dispatch 회귀 테스트 누락(medium), spawnSync 오류 은폐(low),
지원하지 않는 `--json` 성공 fixture(nit), provider 부재 assertion의 대소문자 민감성(nit)을 발견해
모두 수정했다. 이어진 셀프 리뷰 1/3에서는 direct dispatch 전에 정적 import가 Happy log를 만들고
Claude settings를 읽는 provider side effect(medium)와 wrapper/bootstrap의 dispatch 중복(low)을
발견했다. 경량 bootstrap과 runtime main을 분리하고 dispatch를 한 곳으로 합친 뒤 전체 unit
214파일/2,239테스트를 통과시켰다. 셀프 리뷰 2/3에서는 공식 CommonJS export의 agent 경로가
회귀 행렬에서 빠진 저위험 누락을 발견해 wrapper/ESM/CJS 세 경로를 같은 isolated HOME 계약으로
고정했고, source 및 Bun 실행도 확인한 뒤 전체 unit 214파일/2,240테스트를 통과시켰다.

## 핵심 결정 로그

- [2026-08-24] `src/index.ts`는 `agent` 조기 dispatch만 가진 경량 bootstrap으로 유지하고 나머지
  command implementation은 `src/main.ts`에서 동적으로 load / 이유: JavaScript 정적 import는 분기
  실행 전에 provider module graph를 평가하므로 handler 호출 순서만 앞당겨서는 격리가 완성되지 않는다.
- [2026-08-24] 설치형 wrapper의 별도 agent dispatch는 제거하고 wrapper와 direct entrypoint가 같은
  bootstrap을 통과 / 이유: 두 구현의 manifest 해석·오류·status 계약이 다시 어긋나는 것을 막고 실제
  배포 경로와 개발 경로를 같은 테스트로 고정한다.
- [2026-08-24] 셀프 리뷰 1/4에서 handler unit만으로 완료로 보지 않고 build된 direct entrypoint를
  isolated HOME에서 subprocess로 실행하는 테스트를 추가 / 이유: 이번 사고의 실제 결함은 handler
  내부가 아니라 `index.ts`와 handler 사이의 누락이므로 둘을 함께 실행해야 같은 회귀를 탐지한다.
- [2026-08-24] spawnSync의 `error`는 status-null fallback과 구분해 throw하고 `index.ts`가 catch해
  한 줄 오류로 출력 / 이유: missing/corrupt runtime을 단순 exit 1로 숨기면 provider fallback은
  막아도 운영 진단이 불가능하다.
- [2026-08-24] 더 넓은 `natural-language-subagent-reliability` 브랜치의 2개 기존 커밋을 이번 PR에
  포함하지 않는다 / 이유: 이번 provider 격리는 독립적으로 재현·검증되며 PR review 범위를 정확히
  유지해야 한다 / 최신 `origin/main`에서 `fix-agent-entrypoint-provider` 브랜치를 새로 생성했다.
- [2026-08-24] direct entrypoint도 설치형 wrapper와 같은 bundled CLI를 사용한다 / 이유: 별도 command
  구현이나 global `saycode` 탐색은 버전·권한 경계를 갈라놓는다.
- [2026-08-24] incompatible model을 Codex에서 무시하는 방어는 추가하지 않는다 / 이유: 잘못된
  provider가 session identity를 덮는 근본 원인을 숨기고 반대 방향 Claude 오류를 막지 못한다.

## 시도했으나 실패한 접근

- `agent whoami --json`을 direct entrypoint에서 실행 → 수정 전에는 Claude 런타임이 시작돼 기존
  Codex session metadata를 덮었다. 수정 후에는 bundled CLI가 unsupported option으로 exit 2한다.
- 기존 오염 session을 단순 재시도 → Desktop이 Claude flavor에 맞춰 같은 모델을 다시 보내므로
  반복 실패했다. 서버 metadata를 Codex로 복구하고 accidental Claude id를 제거해 운영 상태를 복원했다.

## 발견된 문제 / 열린 질문

- `--json`은 Saycode CLI에 없는 옵션이다. prompt와 smoke는 `agent whoami`만 사용해야 한다.
- 자동 과거 session 복구는 이 spec 비목표다. 재발은 entrypoint 격리로 차단한다.
- 일반(non-agent) CommonJS entrypoint의 `ERR_REQUIRE_ASYNC_MODULE`은 `origin/main` 산출물에서도
  동일하게 재현되는 기존 문제다. 이번 agent provider 격리의 회귀가 아니므로 별도 spec 대상으로 남긴다.

## 다음 세션 시작점

1. PR #241의 CI와 review 결과를 확인한다.
2. 수정 요청이 있으면 이 spec 범위 안에서 반영하고 같은 검증을 반복한다.
3. merge/release는 별도 요청과 Happy CLI release 정책에 따른다.

## 파일 맵

- `packages/happy-cli/src/index.ts` — runtime graph보다 먼저 실행되는 경량 command bootstrap
- `packages/happy-cli/src/main.ts` — agent 외 기존 Happy runtime command implementation
- `packages/happy-cli/src/commands/agentCommand.ts` — bundled Saycode CLI 위임
- `packages/happy-cli/src/commands/agentCommand.test.ts` — 인자·env·exit status 회귀 테스트
- `packages/happy-cli/bin/happy.mjs` — 모든 비-version 명령을 공통 bootstrap으로 전달하는 설치형 wrapper
- `packages/happy-cli/scripts/__tests__/cli-version.test.ts` — wrapper/direct entrypoint의 runtime-state 격리 smoke
