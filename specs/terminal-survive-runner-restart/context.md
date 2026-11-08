---
기능: terminal-survive-runner-restart
상태: 블록됨 (아키텍처 변경 승인 대기)
마지막 갱신: 2026-11-08
---

# 데몬 재시작·업데이트에도 터미널 유지 — Context (happy-cli)

## 현재 상태

aplus 오케스트레이션 T10. spec·plan·tasks를 썼고 구현은 승인 대기다. Desktop 짝 문서는 aplus 저장소 `specs/terminal-survive-runner-restart/`.

## 핵심 결정

- [2026-11-08] 릴레이 경로 제외: happy-server `terminalRelayHandler.ts`가 데몬 disconnect에 세션을 닫고, `apiMachine.ts`가 소켓 drop에 `killAllDaemonTerminalSessions('relay')`. 서버 세션 보류 없이는 재연결할 곳이 없다.
- [2026-11-08] 런처 없음: 데몬을 ppid 체인으로 죽이는 경로가 없고 세션 프로세스가 같은 detached 방식으로 이미 살아남는다. tree-kill 경로가 생기면 재검토.
- [2026-11-08] 런타임 사본 대신 "이전 버전 워커는 새 PTY를 열지 않음"(HR8).
- [2026-11-08] seq는 워커가 정하고 데몬은 미러 — 기존 resume 코드를 그대로 쓰기 위해.
- [2026-11-08] 프로세스 정체성은 기존 `utils/bootIdentity.ts`·`utils/processStartTime.ts` 재사용(Desktop ADR-041과 같은 규칙).

## 열린 질문

- 사용자 승인: plan §7 ①~④.

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
