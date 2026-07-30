# 원격 터미널 종료 시 PTY 프로세스 누수 수정 Context

> 최종 갱신: 2026-07-30 / 상태: 구현 완료 (릴리스 미승인)
> 관련 문서: [spec.md](./spec.md) / [plan.md](./plan.md) / [tasks.md](./tasks.md)

## 지금 상태

Phase 1~3 완료. 브랜치 `fix/remote-terminal-pty-leak`.

- `pnpm -C packages/happy-cli typecheck` 통과
- 유닛 스위트 전체 통과: 149 파일 / 1363 테스트
- 릴리스(태그 푸시 / npm publish)는 수행하지 않았다 — `AGENTS.md`의 "Happy CLI Release
  Publisher" 정책상 사용자의 릴리스 직전 명시 승인이 필요.

## 다음 세션 시작점

이 수정이 실제 사용자 환경에 닿으려면 happy-cli 릴리스 + 데스크톱의 런타임 pin 갱신이
필요하다. 둘 다 별도 승인 사항이므로 사용자 확인부터 할 것.

## 왜 이 버그가 존재했는가 (핵심 판단)

`bash(1)`: *"When Bash is interactive, in the absence of any traps, it ignores SIGTERM
(so that `kill 0` does not kill an interactive shell)."*

원격 터미널은 PTY 위에 `/bin/bash -l`(대화형)을 띄우는데, 모든 종료 경로가 SIGTERM만
보냈다. 즉 **닫기 요청이 아무 일도 하지 않았다.**

실측 재현 로그 (node-pty 1.1.0, macOS 25.5.0, 이 수정의 근거):

```
spawned /bin/bash pid 27447
-> process.kill(-pid, SIGTERM)   after: exitEventFired=false processAlive=true   ← 생존
-> process.kill(-pid, SIGHUP)    after: exitEventFired=true  processAlive=false  ← 즉사
```

그리고 누수가 **영구적**이었던 이유가 따로 있다. `terminal-close-fwd`와
`killAllDaemonTerminalSessions`는 신호를 쏜 직후 `removeDaemonTerminalSession`으로 엔트리를
지웠고, 그 함수는 `clearIdleTimer`를 호출한다. 즉:

1. SIGTERM → 대화형 bash가 무시하고 생존
2. 엔트리 삭제 → **유일하게 효과가 있던 15분 idle SIGHUP 워치독이 해제됨**
3. `PtySession` 핸들 참조도 사라짐 → 다시 죽일 수단이 영구히 없음
4. `pty.onExit`이 영원히 발화하지 않으므로 감사 로그에 close 기록조차 안 남음

**교훈: "신호를 보낸다"는 "종료했다"가 아니다.** 확인과 승급이 없으면 종료 API가 아니다.
그래서 승급 로직을 `PtySession.terminate()` 내부(= `pid`/`child`를 클로저로 들고 있는 곳)에
두었다. 호출자가 어떤 bookkeeping을 지워도 보장이 취소되지 않는다 — 원래 버그의 정확한
반대 구조다.

## 왜 테스트가 못 잡았는가 (구조적 교훈)

기존 `daemonTerminalSessions.test.ts` / `remoteTerminal.test.ts`의 픽스처는
`node -e 'setInterval(...)'` 와 `bash -c '...'` 였다. 둘 다 **비대화형**이라 SIGTERM에
얌전히 죽는다. 프로덕션이 터미널 하나 닫을 때마다 셸을 누수하는 동안 스위트는 계속 초록불.

> 앞으로 셸/시그널 관련 테스트는 **실제 대화형 셸**(`/bin/bash -l`, `-c` 없이)로 할 것.
> 비대화형 자식은 시그널 성향이 근본적으로 다르므로 대리 검증이 불가능하다.

추가한 회귀 테스트는 SIGTERM이 무시된다는 사실 자체를 단정으로 고정해 둔다
(`an interactive login shell survives SIGTERM`). 누군가 `terminate()`를 다시 SIGTERM으로
"단순화"하면 즉시 빨간불이 된다.

## 기각한 대안

- **`kill()` 기본 신호만 SIGTERM → SIGHUP으로 바꾸는 1줄 수정** — 기각. 보고된 증상은
  사라지지만 "쏘고 확인 안 함" 구조가 남는다. SIGHUP을 트랩하는 포그라운드 잡에서 같은
  누수가 재현되고 그때는 원인 파악이 더 어렵다. (그 케이스를 테스트로 명시:
  `terminate() escalates to SIGKILL when SIGHUP is trapped`)
- **레지스트리에 `closing` 상태 추가 + 엔트리를 exit까지 유지 + 주기 스윕** — 기각.
  승급이 `PtySession` 내부에서 완결되면 엔트리 유지가 불필요하다. 상태 머신과 스윕
  타이머는 코드만 늘리고, **나이 기반 판정으로 활성 세션을 죽인 과거 사고**(데몬 idle
  reaper zombie hatch)의 재현 위험을 키운다.
- **PTY 마스터 fd를 닫아 EOF로 셸을 종료시키기** — 기각. node-pty 1.1.0 공개 API에 fd만
  닫는 수단이 없고(`kill(signal)`뿐), 플랫폼 의존적이며 손자 프로세스 회수 보장이 없다.
- **idle 워치독을 close 경로의 안전망으로 계속 쓰기(엔트리를 지우지 않기)** — 기각.
  최대 15분 좀비를 허용하는 설계다. 종료 요청의 보장을 다른 기능(잊은 세션 정리)의
  부작용에 의존시키면 안 된다.

## 자체 리뷰에서 잡은 것 (구현 후)

- **`process.kill(-0)` = 자기 프로세스 그룹**: `signalGroup`은 `-pid`로 신호를 보내는데
  `-0 === 0`이고 `process.kill(0, sig)`는 **호출자 자신의 프로세스 그룹**을 대상으로 한다.
  기존에는 최악이 SIGTERM이라 데몬이 무시했지만, 이 수정으로 SIGKILL을 보내게 되면서
  잘못된 pid 하나가 데몬 전체를 죽일 수 있게 됐다. node-pty는 pid 0을 돌려주지 않고
  throw하므로 실제 발생 가능성은 낮지만, blast radius가 커졌으므로
  `Number.isInteger(pid) && pid > 0` 가드를 넣었다.
- **`terminate(): Promise<void>`는 정직하지 않은 계약이었다**: "종료를 보장한다"면서 보장이
  깨진 경우를 호출자가 알 방법이 없었다. 이 버그가 몇 달간 안 보인 이유가 정확히 그
  침묵이었는데, 같은 구조를 새 API에 재생산한 셈. `TerminateOutcome`
  (`already-gone`/`exited`/`killed`/`escaped`)을 반환하도록 바꾸고, 사용자가 직접 누른
  close 경로에서 비정상 outcome(`killed`/`escaped`)만 데몬 로그에 남긴다. 정상 종료는
  기존 `pty.onExit` 감사 라인이 이미 커버하므로 중복 로깅하지 않는다.
- **일관성 판단**: idle/disconnect 경로는 outcome을 로깅하지 않는다.
  `daemonTerminalSessions.ts`는 logger-free 모듈이라는 기존 계약을 유지하는 편이,
  세 경로 로깅을 위해 콜백을 배선하는 것보다 낫다고 판단. 성공 종료는 모든 경로에서
  `pty.onExit` 감사 라인으로 보인다.
- node-pty가 **다중 `onExit` 리스너를 등록 순서대로** 호출하는지 실측 확인
  (`order: internal,consumer`). 내부 `reaped` 플래그가 소비자 핸들러보다 먼저 세팅되므로,
  `apiMachine`의 onExit 안에서 `isAlive()`를 호출해도 올바르게 false다.

## 함정 / 비자명한 사실

- **좀비 구간**: 자식이 exit했지만 아직 reap 전이면 `process.kill(pid, 0)`이 성공한다.
  그래서 `isAlive()`는 `node-pty`의 exit 이벤트(= reap 완료 후 발화하므로 확실한 신호)와
  `kill(pid, 0)`의 AND로 판정한다. 좀비를 잠깐 alive로 오판하는 최악의 결과는 좀비에게
  SIGKILL을 한 번 더 쏘는 것(무해한 no-op)이라 허용했다.
- **테스트에 `settle()` 300ms가 필요한 이유**: `pty.spawn()`이 리턴한 직후에는 bash가 아직
  대화형 시그널 처리를 설치하지 않아서, 너무 빨리 SIGTERM을 쏘면 **죽어버린다**. 즉
  이 대기 없이는 "SIGTERM이 무시된다" 테스트가 역설적으로 실패한다.
- **fd 누수는 파생 증상**: node-pty는 자식이 exit할 때 마스터 fd를 닫는다. 자식이 안 죽으니
  장기 실행 데몬 프로세스에 fd가 계속 쌓였다(사용자가 우려한 디스크립터 상한은 사용자
  세션보다 데몬에서 먼저 도달). 자식 종료가 보장되면 자동으로 해결되므로 별도 코드 없음.
- **프로세스 그룹 kill 유지**: `process.kill(-pid, sig)`는 기존 설계 의도
  (`gh auth login`이 띄우는 브라우저 런처 등 손자 회수)이므로 그대로 뒀다. 부작용으로
  명시적 close 시 포그라운드 잡(`vim`, `npm run dev`)도 함께 죽는데, "닫기"의 의미와
  일치하므로 의도된 동작으로 판단.
- **disconnect 시엔 grace 500ms**: 릴레이 경로가 이미 죽어서 셸이 출력해도 아무에게도
  닿지 않는다. 전체 grace(2s)를 기다릴 이유가 없다.

## 이미 쌓인 좀비 수동 회수

이 수정은 신규 누수만 막는다. 기존 좀비는 SIGHUP으로 보내야 죽는다:

```bash
ps -eo pid,ppid,tty,command | awk '/bash -l$/ && $3 ~ /pts|ttys/ {print $1}' | xargs -r kill -HUP
```

## 발견된 문제 (이번 스코프에서 건드리지 않음)

- `daemon/run.ts:988`의 `session.childProcess.kill('SIGTERM')`은 happy-cli 자신(node
  프로세스)을 대상으로 하므로 SIGTERM을 정상 처리한다 — 같은 함정 아님. 확인만 하고 둠.
- 주기적 고아 리퍼와 데몬 재시작 시 이전 세대 PTY 회수는 `tasks.md`의 "이월" 항목으로
  남겼다. 리퍼를 넣는다면 판정 기준을 프로세스 나이가 아니라 명시적 close 상태로 둘 것.
