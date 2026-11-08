---
기능: terminal-survive-runner-restart
상태: 진행중 (승인됨 2026-11-08 — Phase 1 구현)
마지막 갱신: 2026-11-08
---

# 데몬 재시작·업데이트에도 터미널 유지 — Context (happy-cli)

## 현재 상태

aplus 오케스트레이션 T10. 2026-11-08 사용자가 조건 3개를 붙여 승인했다(원장 등록·옵트인 단계적 켜기·릴레이 후속 spec 예약 → spec HR10~HR12, plan §2.8~2.10). Phase 1부터 구현한다. Desktop 짝 문서는 aplus 저장소 `specs/terminal-survive-runner-restart/`.

## 핵심 결정

- [2026-11-08] 릴레이 경로 제외: happy-server `terminalRelayHandler.ts`가 데몬 disconnect에 세션을 닫고, `apiMachine.ts`가 소켓 drop에 `killAllDaemonTerminalSessions('relay')`. 서버 세션 보류 없이는 재연결할 곳이 없다.
- [2026-11-08] 런처 없음: 데몬을 ppid 체인으로 죽이는 경로가 없고 세션 프로세스가 같은 detached 방식으로 이미 살아남는다. tree-kill 경로가 생기면 재검토.
- [2026-11-08] 런타임 사본 대신 "이전 버전 워커는 새 PTY를 열지 않음"(HR8).
- [2026-11-08] seq는 워커가 정하고 데몬은 미러 — 기존 resume 코드를 그대로 쓰기 위해.
- [2026-11-08] 프로세스 정체성은 기존 `utils/bootIdentity.ts`·`utils/processStartTime.ts` 재사용(Desktop ADR-041과 같은 규칙).

- [2026-11-08] 플래그 3값: `1` 켜짐·`0` 킬 스위치·그 밖 = 기본 상수(이번 릴리스 false). 꺼진 데몬도 남은 워커는 시작 리퍼로 닫아 "꺼짐 = 워커 0개"로 수렴.
- [2026-11-08] 처리되지 않은 예외로 인한 종료(`exception`)는 크래시와 같게 유지(워커에서 분리만).

## 열린 문제

- 후속 spec 예약: `terminal-survive-relay-restart` — 릴레이 경로 터미널 유지. 범위: 서버 세션 보류·데몬 재등록·클라이언트 재부착. 선행: 다중 레플리카 세션 보류 계약, happy-server 배포, 기본 켜짐 전환(tasks F1).
- 범위 밖: 에이전트가 실행하는 `pkill -f terminal-worker`는 broad kill guard(`utils/broadKillShims.ts`)가 막지 않는다.

## 다음 세션 시작점

승인 뒤 tasks T1(`src/daemon/terminalWorker/frames.ts`)부터. 테스트는 `packages/happy-cli`에서 `pnpm test`(매번 build), 통합 테스트는 `vitest.config.ts`에 project 추가 필요(기존 `restartDrain.integration` 패턴).

## 파일 맵

- `packages/happy-cli/src/daemon/remoteTerminal.ts` — PtySession 인터페이스·생성
- `packages/happy-cli/src/daemon/daemonTerminalSessions.ts` — 레지스트리
- `packages/happy-cli/src/daemon/controlServerTerminalWs.ts` — 직결 경로·detach grace·attach
- `packages/happy-cli/src/daemon/restartDrainRuntime.ts` — `finalizeReady`에서 터미널 닫기
- `packages/happy-cli/src/daemon/terminalBindingSession.ts` — v2 바인딩 상태

## 검증 상태

문서만 작성. 코드·테스트 없음.
