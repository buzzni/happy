# Agent 명령 direct-entry provider 격리 Context

> 마지막 갱신: 2026-08-24 / 상태: 구현·검증 완료, PR 생성 대기

## 현재 상태

사고 원인은 provider-native sub-agent가 아니라 개발 smoke가 wrapper를 우회해 direct entrypoint에
`agent whoami --json`을 전달한 것이었다. source entrypoint가 이를 기본 Claude 인자로 처리해 기존
Codex session에 Claude를 재연결했고 session flavor가 오염됐다. Red 테스트 후 bundled Saycode CLI로
조기 위임하는 handler와 `index.ts` dispatch를 구현했다. 최신 `origin/main` 기준 관련 테스트 2개,
typecheck, build, 전체 unit 214파일/2,236테스트가 통과했고 build 산출물의 success/failure smoke도
각각 exit 0/2로 끝났다. 구현·검증은 완료됐으며 commit·push·PR 생성만 남았다.

## 핵심 결정 로그

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

## 다음 세션 시작점

1. diff가 spec 범위에만 해당하는지 최종 확인한다.
2. 단일 behavioral commit을 push하고 PR을 생성한다.
3. PR URL을 context에 기록하고 완료 처리한다.

## 파일 맵

- `packages/happy-cli/src/index.ts` — provider 기본 분기보다 앞선 command dispatch
- `packages/happy-cli/src/commands/agentCommand.ts` — bundled Saycode CLI 위임
- `packages/happy-cli/src/commands/agentCommand.test.ts` — 인자·env·exit status 회귀 테스트
- `packages/happy-cli/bin/happy.mjs` — 기존 설치형 wrapper 계약 참고
