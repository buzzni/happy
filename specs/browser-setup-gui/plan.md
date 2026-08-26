# 계획

## Phase 1 — 순수 로직 + 테스트 (CLI)

새 모듈 `packages/happy-cli/src/daemon/browserSetup.ts`.

TDD 대상(비즈니스 로직):

- `buildChromeLaunchArgs({ userDataDir, cdpPort, headless })` — AC3
- `resolveProfilePaths(profile)` — 프로필별 user-data-dir — AC4
- `planChromeInstall({ chromePath, sudo })` — 설치 가능/불가 판정과 명령 — AC2

검증: `npx vitest run --project unit src/daemon/browserSetup.test.ts`

## Phase 2 — 부수효과 있는 얇은 층 (CLI)

- `detectChrome()` — PATH에서 google-chrome/chromium 탐색
- `launchChrome()` — spawn, detached
- `readBrowserSetupStatus()` — 위를 합쳐 상태 보고

## Phase 3 — RPC 노출

`apiMachine.ts`에 핸들러 4개. 기존 `stop-daemon` 패턴을 따른다.

- `browser-setup:status`
- `browser-setup:install-chrome`
- `browser-setup:launch`
- `browser-setup:pair` → 기존 `handlePairCommand` 재사용 (AC6)

## Phase 4 — 앱 클라이언트

`packages/happy-app/sources/sync/ops.ts`에 `machineBrowser*` 헬퍼.
기존 `machineStopDaemon` 패턴 그대로.

## Phase 5 — UI

`machine/[id].tsx`에 "브라우저" 섹션. UI-only이므로 새 테스트 없음
(CLAUDE.md 프론트엔드 분류 규칙). 기존 테스트 회귀만 확인.

## Phase 6 — PR #248 최신 main 통합

- 최신 `main`의 launch-time CDP pipe 소유권과 요청 채널을 유지한다.
- viewer pairing은 이미 로드된 bridge를 먼저 재사용하고, marker pairing이
  실패한 경우에만 같은 CDP pipe로 extension reload를 시도한다.
- PR #248의 Claude transfer 및 세션 capability 보강은 동작을 바꾸지 않고
  최신 `main` 위에 재적용한다.

검증: browser viewer/pairing, Claude transfer, persisted hydration focused unit,
happy-cli 전체 unit/typecheck/build, PR Linux/Windows smoke CI.

## 상태

- [x] Phase 1
- [x] Phase 2
- [x] Phase 3
- [x] Phase 4
- [x] Phase 5
- [ ] Phase 6
