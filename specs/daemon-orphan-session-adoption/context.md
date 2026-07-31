# 데몬 고아 세션 입양 Context

> 마지막 갱신: 2026-07-31 / 상태: 구현 완료, 검증 일부 미실시

## 지금 상태

Phase 1~4 구현 완료. 유닛 스위트 1404개 전부 통과, typecheck clean.

커밋: 브랜치 `feat/daemon-orphan-adoption-clean` (워크트리 `/tmp/happy-orphan-adoption`)의
`684260ec` 하나. main에서 갈라져 나왔고 다른 작업이 섞여 있지 않아 단독 머지 가능하다.
(중간에 `feat/daemon-orphan-adoption` 브랜치가 있으나 다른 세션의 브라우저 브릿지 작업을
조상으로 물고 있어 폐기 대상이다 — 아래 "사고" 참조.)

## 다음 세션 시작점

1. `feat/daemon-orphan-adoption`을 main에 머지 (또는 PR)
2. **미실시 검증**: 데몬 재시작 후 실제 입양이 일어나는지 확인
   - `daemon.integration.test.ts`에 시나리오 추가 → `integration-authenticated` 프로젝트는
     로컬 서버 + 시드 계정을 부팅하는 환경 매니저를 요구한다. 무거워서 이번에 돌리지 않았다
   - 대안(더 빠름): 세션 하나를 띄운 채 데몬을 SIGKILL → 재기동 → 30초 안에
     `Adopted orphan session` 로그와 `happy doctor` / `/list`에 그 세션이 나타나는지 확인
3. Phase 0 확증이 아직 안 왔다면 사고 호스트에서:
   `grep -c "Ignoring runtime report for untracked session" ~/.happy/logs/*daemon.log`
   — 이 줄이 있으면 리포트 기반 입양(Phase 1)이 그 사고를 직접 해결했음을 확증한다

## 결정과 이유

| 결정 | 이유 | 재검토 조건 |
|---|---|---|
| 입양 트리거 = 런타임 리포트 | 살아있는 세션은 `daemonPost`가 매번 상태파일을 다시 읽는 덕에 30초마다 현재 데몬을 찾아온다. sessionId가 권위 있고 플랫폼 독립적이며 생존 증거를 겸한다 | 리포트 주기나 상태파일 재읽기 방식이 바뀌면 |
| `ps` 스캔 입양 기각 | PID만 입양해도 세 리퍼가 `!happySessionId`로 건너뛴다. 필요한 건 sessionId↔pid 매핑이고 그건 `sessions.json`에 이미 있다 | 리퍼가 sessionId 없이도 동작하게 바뀌면 |
| `hostPid`를 세션이 자기 신고 | persisted 조회는 최대 14일 된 기록이라 PID 재사용 위험. 보고하는 프로세스의 pid는 정의상 그 프로세스 것 | — |
| `startedBy`를 원본에서 복원 | `'adopted'` 같은 새 값을 넣으면 `local-session` 가드가 daemon-spawn 세션을 사용자 터미널로 오분류해 영구 보호 | 가드가 `startedBy` 대신 다른 축을 쓰게 되면 |
| 나이는 실제값 유지 + 2분 유예 | 나이를 리셋하면 데몬 재시작마다 정책이 초기화돼 장수 고아가 불멸이 된다. 대신 유예로 복구 첫 틱의 무더기 SIGTERM을 막는다 | 유예 중 리핑 지연이 문제되면 `HAPPY_DAEMON_ADOPTION_GRACE_MS`로 조정 |
| 유예를 리퍼 3곳이 아니라 가드 1곳에 | 세 리퍼가 전부 `if-idle` → `evaluateIdleStopGuard`를 통과한다. 한 곳이면 누락이 없다 | 리퍼가 가드를 우회하는 경로가 생기면 |

## 함정 / 시도했으나 실패한 접근

- **가드 유예를 하드캡 뒤에 두면 무력화된다.** 하드캡은 `return {allow:true}`인 allow-분기라,
  유예 검사가 그 뒤에 있으면 오래 침묵한 고아는 입양 직후 바로 정지된다. 유예는 반드시
  하드캡 앞에 와야 한다 (테스트로 고정: "denies a stop inside the grace window even past
  the zombie hard cap")
- **구 데몬의 `unlink`는 고칠 수 없다.** `clearDaemonState()`는 정지당하는 프로세스 안에서
  실행되므로 신 CLI의 코드가 아니다. 신 CLI가 정지 **전에** 스냅샷을 떠 두는 것만이 통로다

## 발견된 문제 (이 기능 범위 밖)

- `run.ts:176`의 TODO — 데몬 자체 재시작 로직이 launchd/systemd로 가야 한다는 기존 지적.
  그렇게 되면 Phase 3(스냅샷 복원)은 불필요해진다
- `readDaemonState()`는 파일 손상 시 `console.error` 후 `null`을 반환한다. 로거가 아니라
  `console`이라 데몬 로그에 남지 않는다

## 사고: 다른 세션과 작업 트리 충돌 (2026-07-31)

작업 도중 같은 저장소(`vendor/happy`, main 체크아웃)에서 **다른 Claude 세션이 브라우저
브릿지 작업을 동시에 진행**했고, 그쪽이 `git commit -a`를 두 번 실행하면서 이 기능의
T1·T2·spec 문서를 자기 커밋에 함께 담았다. 코드 손실은 없고 동작도 정상이지만 커밋 메시지가
어긋나 있다. 사용자 판단으로 그대로 두기로 했다.

**교훈**: 하나의 체크아웃을 여러 에이전트가 공유하면 `commit -a`가 남의 작업을 쓸어담는다.
이후 작업은 `git worktree`로 격리했다 (`/tmp/happy-orphan-adoption`, node_modules와
`tools/unpacked`는 메인 체크아웃에서 심볼릭 링크).
