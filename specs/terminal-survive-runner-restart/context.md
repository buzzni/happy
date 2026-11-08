---
기능: terminal-survive-runner-restart
상태: 진행중 (Phase 1~3 구현·테스트 완료, Phase 4 교차 리뷰·PR)
마지막 갱신: 2026-11-08
---

# 데몬 재시작·업데이트에도 터미널 유지 — Context (happy-cli)

## 현재 상태

aplus 오케스트레이션 T10. 2026-11-08 사용자가 조건 3개를 붙여 승인했다(원장 등록·옵트인 단계적 켜기·릴레이 후속 spec 예약 → spec HR10~HR12, plan §2.8~2.10). Phase 1~3을 구현했고(프리미티브·워커 프로세스·데몬 배선) 실제 프로세스 통합 테스트(HR9)가 통과했다. 남은 일은 교차 리뷰·PR·리뷰봇·CI와 실기(사용자 수동 확인). Desktop 짝 문서는 aplus 저장소 `specs/terminal-survive-runner-restart/`.

## 핵심 결정

- [2026-11-08] 릴레이 경로 제외: happy-server `terminalRelayHandler.ts`가 데몬 disconnect에 세션을 닫고, `apiMachine.ts`가 소켓 drop에 `killAllDaemonTerminalSessions('relay')`. 서버 세션 보류 없이는 재연결할 곳이 없다.
- [2026-11-08] 런처 없음: 데몬을 ppid 체인으로 죽이는 경로가 없고 세션 프로세스가 같은 detached 방식으로 이미 살아남는다. tree-kill 경로가 생기면 재검토.
- [2026-11-08] 런타임 사본 대신 "이전 버전 워커는 새 PTY를 열지 않음"(HR8).
- [2026-11-08] seq는 워커가 정하고 데몬은 미러 — 기존 resume 코드를 그대로 쓰기 위해.
- [2026-11-08] 프로세스 정체성은 기존 `utils/bootIdentity.ts`·`utils/processStartTime.ts` 재사용(Desktop ADR-041과 같은 규칙).

- [2026-11-08] 플래그 3값: `1` 켜짐·`0` 킬 스위치·그 밖 = 기본 상수(이번 릴리스 false). 꺼진 데몬도 남은 워커는 시작 리퍼로 닫아 "꺼짐 = 워커 0개"로 수렴.
- [2026-11-08] 처리되지 않은 예외로 인한 종료(`exception`)는 크래시와 같게 유지(워커에서 분리만).

- [2026-11-08] `caps.survive`는 평문 open ack·attach 응답 caps에만 싣는다. v2 proof(봉인) caps는 Desktop `src/remoteTerminal/terminalBinding.ts`·happy-wire 양쪽이 `.strict()`라 키를 더하면 기존 앱이 proof를 거부한다. 평문 힌트는 재연결 동작만 바꾸고, attach 자체는 지금처럼 봉인 검증하므로 위조돼도 얻는 것이 없다.
- [2026-11-08] 릴레이 경로 터미널은 워커에서 열지 않는다(데몬 안 PTY 유지). 재시작에 어차피 닫히므로.
- [2026-11-08] `daemon stop --for-restart`(Desktop 재시작 경로)는 restart 의도의 드레인 뒤 `/stop`이라 `cleanupAndShutdown`에서도 드레인 결정(keep)을 따른다. 드레인 없는 SIGTERM·`stop`은 닫기.
- [2026-11-08] 터미널 열기 승인 재확인(`terminalOpenAdmission.submit`)은 비동기 작업을 받는다. 워커 `create` 요청은 재확인과 같은 동기 구간에서 나가고, 워커는 그 뒤 수 ms 안에 PTY를 연다. 워커는 submit 전에 미리 띄운다.
- [2026-11-08] cwd 대체 배너는 워커 `inject` 연산으로 보낸다(셸 출력과 같은 seq 열에 들어가야 재생이 맞음).
- [2026-11-08] 크래시 뒤 입양된 v2 터미널의 `lastInSeq`는 마지막 `setMeta`(열 때·정상 핸드오프 직전) 값이라 낡을 수 있다. 직결 경로는 새 데몬의 control secret이 있어야 붙을 수 있어 재생 공격 표면은 같은 PC의 앱뿐이다.

- [2026-11-08] 교차 리뷰(codex gpt-6.1-sol high) major 7·minor 2 전부 반영: 종료 중 워커는 create·새 컨트롤러를 거부하고 shutdown 응답은 터미널이 끝난 뒤, 세션은 create·dump 요청 전에 구독하고 첫 리더까지 출력을 보관, v2 터미널은 바인딩을 create에 함께 실어 원자적으로 보관(`contract: v2`인데 바인딩 없으면 입양 거부), SIGTERM/SIGINT는 ready restart 드레인 뒤에도 닫기(`keepsWorkerTerminalsOnExit`), 실패·무응답 create는 terminate+forget 보상, 종료한 세션은 연결 리스너 해제, 진행 중 열기도 사용자당 5개 상한에 포함, 시작 시각 미확인이면 연결도 신호도 없음(HR6 그대로), 시작 중 stop은 launch를 기다려 회수.

## 열린 문제

- 후속 spec 예약: `terminal-survive-relay-restart` — 릴레이 경로 터미널 유지. 범위: 서버 세션 보류·데몬 재등록·클라이언트 재부착. 선행: 다중 레플리카 세션 보류 계약, happy-server 배포, 기본 켜짐 전환(tasks F1).
- 범위 밖: 에이전트가 실행하는 `pkill -f terminal-worker`는 broad kill guard(`utils/broadKillShims.ts`)가 막지 않는다.

## 다음 세션 시작점

tasks T13~T14(교차 리뷰·PR). 테스트: `packages/happy-cli`에서 `npx vitest run --project unit src/daemon/terminalWorker` 와 `--project integration-terminal-worker`(global setup이 매번 build). CI는 `cli-smoke-test.yml` Linux 잡의 "Verify terminals survive a daemon restart" 단계.

## 파일 맵

- `packages/happy-cli/src/daemon/remoteTerminal.ts` — PtySession 인터페이스·생성
- `packages/happy-cli/src/daemon/daemonTerminalSessions.ts` — 레지스트리
- `packages/happy-cli/src/daemon/controlServerTerminalWs.ts` — 직결 경로·detach grace·attach
- `packages/happy-cli/src/daemon/restartDrainRuntime.ts` — `finalizeReady`에서 터미널 닫기
- `packages/happy-cli/src/daemon/terminalBindingSession.ts` — v2 바인딩 상태(`exportState`·`restoreBoundTerminal`)
- `packages/happy-cli/src/daemon/terminalWorker/` — 워커(프로세스·클라이언트·호스트·입양·기록·소켓 경로·유지 결정)
- `docs/terminal-worker.md` — 운영 문서

## 검증 상태

- 단위: terminalWorker 9파일·doctor 분류·restartDrainRuntime(유지 결정) 통과. 회귀: controlServer*·daemonTerminalSessions·apiMachine*·restartDrain* 505건 통과, `integration-daemon-restart` 통과.
- 통합(실제 프로세스, HR9): 크래시(SIGKILL) 뒤 셸 생존·다음 데몬 입양·출력 재생·seq 연속, keep 재시작·stop 닫기, 다른 프로토콜 워커 종료, 워커 꺼짐 수렴, 고아 기록 신호 없이 정리 — 통과(macOS).
- typecheck 통과.
- 미검증: 실기(실제 데몬 핸드오프·pin 갱신 중 Desktop 터미널 유지) — 사용자 수동 확인.
