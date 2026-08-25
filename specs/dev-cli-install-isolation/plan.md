# plan — dev-cli-install-isolation

## Phase 1 — 가드 판정 (Done)
`decideGlobalInstall` 순수 함수를 TDD 로 작성. 살아 있는 daemon + 추적 세션이
있을 때만 차단. (R4, R5, R6)
- 검증: 7/7 통과

## Phase 2 — 가드 연결 (Done)
`install-local.cjs` 가 빌드 시작 전에 판정. 실제 환경에서 차단/우회 실측.
- 검증: `HAPPY_HOME_DIR=~/.happy_remote` 에서 "세션 11개" 로 차단, override 로 통과

## Phase 3 — 격리 설치 스크립트 (Done)
런북 §2.2~2.4 자동화. (R1, R2, R3)

## Phase 4 — 실측 (Done)
격리 설치 → 격리 daemon 기동 → 전역 무사 확인 → 정리.
- 검증: 격리 daemon pid 96496 기동, 전역 daemon pid 12725 그대로 생존

## Phase 5 — 런북 오류 수정 (Done)
`--ignore-scripts` + `build/` 복사를 postinstall 정상 실행으로 대체.
- 검증: `spawn-helper` 가 `-rwxr-xr-x`
