# relay-cross-replica-routing 현재 상태

## 2026-08-10 — spawn RPC 스모크 안전 논거 정정

- reviewer finding을 원본 worktree의 `vendor/happy` `af385702`에서 확인했다.
- 빈 `params`는 legacy encryption variant에서 decrypt throw로 핸들러 전에
  차단되지만, dataKey variant에서는 decrypt가 null을 반환해
  `spawn-happy-session` 핸들러에 진입한다.
- 핸들러 첫 줄에 null/비객체/배열 parameter guard를 추가해 로깅,
  destructuring, `spawnSession()` 전에 명시적으로 거부한다.
- 스모크와 plan의 READ-ONLY 논거를 두 variant의 실제 실행 경로에 맞게 고쳤다.
- `testing.md`에 로컬 회귀 테스트와 선택적 dev 크로스 배치 스모크 절차를 기록했다.
- 검증: Happy CLI typecheck, 관련 unit test 12개, 스모크 스크립트 `node --check`,
  `git diff --check`가 모두 통과했다.
