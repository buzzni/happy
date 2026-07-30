# 원격 터미널 종료 시 PTY 프로세스 누수 수정 Plan

> 작성일: 2026-07-30 / 상태: 초안
> 근거 문서: [spec.md](./spec.md)

## 아키텍처 영향

| 항목 | 내용 |
|------|------|
| 관련 모듈/레이어 | `packages/happy-cli/src/daemon/remoteTerminal.ts`(PTY 프리미티브), `packages/happy-cli/src/daemon/daemonTerminalSessions.ts`(세션 레지스트리 + idle 워치독), `packages/happy-cli/src/api/apiMachine.ts`(소켓 핸들러) |
| 새 외부 의존성 | 없음 (`node:timers/promises`만 추가 import) |
| 모듈 경계/공개 API 변경 | **데몬 내부 API만** — `PtySession`에 `isAlive()`/`terminate()` 추가, `kill()` 기본 신호 변경, `killAllDaemonTerminalSessions`의 `signal` 파라미터 제거. 소켓 프로토콜·RPC·스키마 변경 없음 → cross-repo 영향 없음 |
| 데이터 스키마 변경 | 없음 |

## 접근 방식

**종료 보장을 `PtySession` 내부로 내린다.** 지금은 "신호를 쏜다"와 "죽었는지 확인한다"가
분리되어 있고 후자가 아무 데도 없다. `terminate()`가 SIGHUP → 생존 확인 → SIGKILL 승급을
한 함수 안에서 self-contained하게 수행하고, 그 승급 타이머가 `pid`/`child`를 클로저로 들고
있게 한다. 그러면 호출자가 레지스트리 엔트리를 즉시 지워도 종료 보장이 취소되지 않는다
(R4) — 이것이 현재 버그의 정확한 반대 구조다.

생존 판정은 두 신호의 AND로 한다: node-pty가 알려준 exit 이벤트(도착했다면 확실히 죽음)와
`process.kill(pid, 0)`. 좀비(exit했지만 아직 reap 전) 구간에서는 잠깐 alive로 보이는데,
그 경우 최악은 좀비에게 SIGKILL을 한 번 더 쏘는 것(무해한 no-op)이므로 허용한다.

검토했으나 기각한 대안:

- **`kill()` 기본 신호만 SIGTERM → SIGHUP으로 바꾸는 1줄 수정** — 기각. 실측상 bash는
  SIGHUP에 죽으므로 보고된 증상은 사라지지만, "신호를 쏘고 확인하지 않는" 구조가 그대로
  남는다. SIGHUP을 트랩하는 포그라운드 잡(R2) 앞에서 같은 누수가 재현되고, 그때는 원인
  파악이 더 어렵다. 확인·승급이 이 수정의 본질이다.
- **레지스트리에 `closing` 상태를 추가하고 엔트리를 exit까지 유지 + 주기 스윕** — 기각.
  승급이 `PtySession` 내부에서 자기 참조로 완결되면 엔트리 유지가 불필요하다. 상태 머신과
  스윕 타이머를 추가하면 코드가 늘고, 나이 기반 판정으로 활성 세션을 죽인 과거 사고의
  재현 위험만 키운다(spec 비목표).
- **명시적 close 시 `child.kill()` 대신 PTY 마스터 fd를 닫아 EOF로 셸을 종료시키기** —
  기각. node-pty 1.1.0의 공개 API에 fd만 닫는 수단이 없고(`kill(signal)`뿐),
  플랫폼 의존적이며 손자 프로세스 회수(R3) 보장이 없다.
- **idle 워치독을 close 경로의 안전망으로 계속 쓰기(엔트리를 지우지 않기)** — 기각.
  최대 15분 좀비를 허용하는 설계이고, 워치독은 "사용자가 잊은 세션 정리"라는 다른 목적을
  가진 장치다. 종료 요청의 보장을 다른 기능의 부작용에 의존시키면 안 된다.

## 단계 (Phases)

각 단계는 독립적으로 테스트·커밋 가능하다.

### Phase 1 — 🔴🟢 `PtySession.terminate()` / `isAlive()` 도입 (동작 변경)

- 실패 테스트 먼저: 실제 `/bin/bash -l` PTY 픽스처로 (a) `kill('SIGTERM')` 후에도
  `isAlive()`가 true (버그의 근원을 코드로 고정), (b) `terminate()` 후 `isAlive()`가 false.
- `remoteTerminal.ts`에 `isAlive()`, `terminate({graceMs, killGraceMs})` 구현.
  `kill()` 기본 신호를 `SIGHUP`으로 변경(잘못된 기본값 제거) — 프로세스 그룹 kill +
  단일 kill 폴백은 그대로 재사용.
- 검증: `vitest run --project unit src/daemon/remoteTerminal.test.ts`

### Phase 2 — 🔴🟢 레지스트리/소켓 종료 경로를 `terminate()`로 전환 (동작 변경)

- 실패 테스트 먼저: `daemonTerminalSessions.test.ts`에 bash 픽스처로
  `killAllDaemonTerminalSessions()`가 대화형 셸을 실제로 회수하는지.
- `killAllDaemonTerminalSessions()`: `signal` 파라미터 제거 + `terminate()` 사용(R5).
- idle 워치독: `kill('SIGHUP')` → `terminate()`(R6).
- `apiMachine.ts` `terminal-close-fwd`: `kill('SIGTERM')` → `terminate()`(R4).
  disconnect 경로는 호출 시그니처만 정정.
- 검증: 유닛 스위트 전체 + typecheck

### Phase 3 — 📄 문서화 및 회귀 방지 메모

- `context.md` 작성: 재현 방법, 실측 로그, 기각한 대안, 이미 쌓인 좀비 수동 회수 명령,
  기존 테스트 픽스처가 버그를 숨긴 구조적 이유(= 앞으로 셸 관련 테스트는 실제 셸로 할 것).
- 검증: 문서만 — 코드 변경 없음

## 리스크

| 리스크 | 완화 |
|--------|------|
| SIGHUP이 프로세스 그룹 전체에 가서 사용자가 의도치 않게 잡을 잃음 | 기존 프로세스 그룹 kill 설계의 의도된 동작이며 "닫기"의 의미와 일치. 명시적 close·disconnect·idle 3경로에만 적용되고 새로 확대되는 경로 없음 |
| 실제 셸 픽스처 테스트가 CI에서 느리거나 flaky | grace를 테스트에서 짧게 주입, win32 skip, 타임아웃은 넉넉히(3s) 두고 판정은 `isAlive()` 폴링으로 |
| `terminate()`가 async라 sync 소켓 핸들러에서 unhandled rejection | `terminate()`는 내부에서 모든 kill을 try/catch하고 절대 reject하지 않는다. 호출부는 `void` |
