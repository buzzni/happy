# 원격 터미널 종료 시 PTY 프로세스 누수 수정 Spec

> 작성일: 2026-07-30 / 상태: 초안
> ⚠️ 승인 후에는 사용자 지시 없이 수정 금지

## 목표

데스크톱(Saycode) 원격 터미널을 닫거나 앱을 종료했을 때, 데몬이 띄운 PTY 셸 프로세스가
**반드시 종료되도록** 보장한다. 현재는 종료 요청이 아무 효과 없이 무시되어 `/bin/bash -l`
프로세스와 pts 디스크립터가 영구히 누적된다.

## 배경

사용자 보고: 세이코드에서 터미널을 열고 닫기 버튼을 누르거나 앱을 완전히 종료해도
`ps -e -o pid,ppid,tty,stat,cmd | grep pts` 에 `/bin/bash -l` 이 계속 쌓인다.
(tmux가 이미 닫은 창의 크기를 기억하고 있어서 발견 — 좀비 셸이 pts를 계속 점유하고 있었음.)

조사 결과 근본 원인은 **대화형 bash가 SIGTERM을 무시한다**는 점이다.
bash(1): *"When Bash is interactive, in the absence of any traps, it ignores SIGTERM
(so that `kill 0` does not kill an interactive shell)."*

`createPtySession`은 PTY 위에 `/bin/bash -l`(대화형)을 띄우는데, 모든 종료 경로가
SIGTERM만 보낸다. 실측 재현(node-pty 1.1.0, macOS):

```
spawned /bin/bash pid 27447
-> process.kill(-pid, SIGTERM)   after: exitEventFired=false processAlive=true   ← 생존
-> process.kill(-pid, SIGHUP)    after: exitEventFired=true  processAlive=false  ← 즉사
```

영향받는 경로 (수정 전 코드 기준):

| 경로 | 위치 | 보내는 신호 | 결과 |
|------|------|------------|------|
| 닫기 버튼 (명시적 close) | `api/apiMachine.ts:1009` | SIGTERM | 무시됨 → 영구 누수 |
| 앱 완전 종료 (클라이언트 소켓 disconnect → 서버가 close-fwd 대행, `happy-server/.../terminalRelayHandler.ts:176`) | 동일 | SIGTERM | 무시됨 → 영구 누수 |
| 데몬 소켓 disconnect | `api/apiMachine.ts:798` `killAllDaemonTerminalSessions('SIGTERM')` | SIGTERM | 무시됨 → 영구 누수 |
| 15분 idle 워치독 | `daemon/daemonTerminalSessions.ts:57` | SIGHUP | 실제로 죽음 (유일하게 동작) |

누수가 **영구적**인 이유: 위 세 경로는 신호를 쏜 직후 `removeDaemonTerminalSession`으로
엔트리를 지우는데, 그 함수가 `clearIdleTimer`를 호출한다. 즉 SIGTERM으로 죽지 않은
프로세스에서 하필 유일하게 효과가 있는 SIGHUP 워치독을 해제한다. 동시에 `PtySession`
핸들 참조도 사라져 다시 죽일 방법이 없어진다. `pty.onExit`이 영원히 발화하지 않으므로
감사 로그에 close 기록조차 남지 않는다.

부수 효과(2차): 자식이 죽지 않으면 node-pty가 마스터 fd를 닫지 않는다. 장기 실행 데몬
프로세스에 터미널을 닫을 때마다 fd가 +1 누적된다 → 사용자가 우려한 디스크립터 상한은
사용자 세션보다 **데몬 프로세스에서 먼저** 도달한다.

기존 테스트가 이 버그를 못 잡은 이유: `daemonTerminalSessions.test.ts`의 픽스처가
`node -e 'setInterval(...)'` — SIGTERM에 얌전히 죽는 프로세스다. 실제 셸의 시그널 성향을
재현하지 않아 SIGTERM 경로가 계속 초록불이었다.

## 요구사항

- R1. Given PTY 위의 대화형 로그인 셸(`/bin/bash -l`)이 실행 중일 때, When `PtySession`의
  종료 API를 호출하면, Then 유한한 시간 안에 그 프로세스가 **실제로 사라진다**
  (SIGTERM 무시 여부와 무관). 종료 API는 SIGHUP → grace 대기 → 생존 시 SIGKILL 로
  승급한다.
- R2. Given 종료가 요청되면, When SIGHUP을 무시하거나 트랩하는 포그라운드 잡이 있어도,
  Then SIGKILL 승급으로 프로세스 그룹이 회수된다. 승급 판정은 실제 프로세스 생존 확인
  (`process.kill(pid, 0)` + node-pty exit 이벤트)에 근거하며, 시간만으로 추정하지 않는다.
- R3. Given 종료 신호가 프로세스 그룹(`-pid`)으로 전달되어야 한다는 기존 설계 의도
  (`gh auth login`이 띄우는 브라우저 런처 등 손자 프로세스 회수), When 종료 API가
  동작하면, Then 프로세스 그룹 kill을 유지하고 실패 시에만 단일 프로세스 kill로
  폴백한다(기존 `kill()` 동작 보존).
- R4. Given `terminal-close-fwd`(닫기 버튼 / 앱 종료), When 데몬이 이를 처리하면, Then
  R1의 종료 API를 사용한다. 엔트리를 맵에서 제거하더라도 종료 보장이 취소되지 않아야
  한다(승급 로직이 맵이 아니라 `PtySession` 내부에서 자기 참조를 들고 있어야 함).
- R5. Given 데몬 소켓 disconnect, When `killAllDaemonTerminalSessions`가 호출되면, Then
  모든 세션에 R1의 종료 API를 적용한다. SIGTERM을 호출자가 지정할 수 있는 여지를 없앤다
  (신호 파라미터 제거 — 잘못된 신호를 넘길 수 있는 API 자체가 이 버그의 원인이었다).
- R6. Given 15분 idle 워치독, When 발화하면, Then 역시 R1의 종료 API를 사용한다
  (SIGHUP만 쏘고 확인하지 않는 현재 동작에서 승급 보장으로 강화).
- R7. Given 이 저장소의 회귀 테스트, When 유닛 스위트가 실행되면, Then **실제
  `/bin/bash -l` PTY**를 픽스처로 쓰는 테스트가 존재해 (a) SIGTERM이 무시된다는 사실과
  (b) 종료 API가 그럼에도 프로세스를 회수한다는 것을 검증한다. win32에서는 skip.
- R8. Given 기존 동작, When 이 변경이 적용되면, Then 정상 종료되는 프로세스(non-shell,
  예: `node -e`)의 종료 경로·감사 로그·`bytesIn/Out` 집계·idle 타이머 리셋 동작은
  회귀 없이 동일하다.

## 비목표 (Non-Goals)

- **주기적 고아 리퍼(orphan reaper) 추가** — 이번 스코프 밖. R1의 승급이 `PtySession`
  내부에서 자기 완결적으로 동작하므로 맵 기반 스윕의 추가 이득이 marginal하다. 또한 이
  조직에는 나이 기반 리퍼가 활성 세션을 죽인 과거 사고가 있어(데몬 idle reaper zombie
  hatch), 리퍼를 넣는다면 별도 spec에서 판정 기준을 신중히 설계해야 한다.
- **데몬 재시작 시 이전 세대 고아 정리** — 이번 수정으로 신규 누수가 멈추므로 급하지 않다.
  이미 쌓인 것은 사용자가 수동 `kill -HUP`으로 회수(context.md에 명령 기록).
- **데스크톱(aplus-dev-studio-desktop) 변경** — 데스크톱 측 close 경로는 이미 올바르다
  (`TerminalWorkspacePanel.tsx:20` → `closeRemoteTerminal` → `controller.close()` →
  `session.close()` → `terminal-close` emit). 고칠 것이 없다.
- **happy-server 변경** — 서버 릴레이는 이미 클라이언트 disconnect 시 `terminal-close-fwd`를
  올바르게 대행한다. 고칠 것이 없다.
- **`startServer.ts`(프리뷰 서버) 계열의 종료 신호 점검** — 같은 계열 버그 가능성이 있으나
  이번 보고와 무관. 발견 시 context.md "발견된 문제"에만 기록.
- **npm 릴리스(태그 푸시 / publish)** — `AGENTS.md`의 "Happy CLI Release Publisher" 정책상
  릴리스는 직전에 사용자의 별도 명시 승인이 필요하다. 이 spec의 완료 기준은 "브랜치에
  구현·테스트 통과"까지다.

## 제약

- 호환성: `PtySession`은 데몬 내부 모듈이고 외부 계약(RPC/소켓 이벤트/스키마)이 아니다.
  소켓 프로토콜(`terminal-*`)과 데스크톱 클라이언트는 전혀 바뀌지 않으므로 구버전
  데스크톱 + 신버전 CLI 조합도 그대로 동작한다.
- 사용자 영향: 명시적 close 시 SIGHUP이 프로세스 그룹 전체에 전달되어 포그라운드 잡
  (`vim`, `npm run dev` 등)도 함께 종료된다. 이는 기존 프로세스 그룹 kill 설계의 의도된
  동작이며, "닫기"의 의미와 일치한다.
- 테스트 시간: 실제 셸을 띄우는 테스트가 추가되므로 유닛 스위트가 수백 ms 늘어난다.
  grace 값을 테스트에서 짧게(수백 ms) 주입할 수 있어야 한다.

## 완료 기준 (Definition of Done)

- [x] R1~R8에 대응하는 테스트 존재 및 통과
- [x] `pnpm -C packages/happy-cli typecheck` 통과
- [x] `pnpm -C packages/happy-cli test`(유닛) 통과 — 기존 테스트 회귀 없음
- [x] `specs/remote-terminal-close-leak/context.md`에 재현 방법·기각한 대안·수동 회수
      명령 기록
