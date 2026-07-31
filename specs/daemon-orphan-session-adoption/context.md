# 데몬 고아 세션 입양 Context

> 마지막 갱신: 2026-08-01 / 상태: 구현 완료, 실측 검증 완료 (머지 대기)

## 지금 상태

Phase 1~4 구현 완료. 유닛 스위트 1404개 전부 통과, typecheck clean.
**로컬 격리 환경(pglite + 자체 서버, 프로덕션 미접촉)에서 실측 검증도 완료** — 아래
"실측 검증 결과" 참조.

커밋: 브랜치 `feat/daemon-orphan-adoption-clean`의 `684260ec`, `d9eae617`. main에서
갈라져 나왔고 다른 작업이 섞여 있지 않아 단독 머지 가능하다.
(중간에 `feat/daemon-orphan-adoption` 브랜치가 있으나 다른 세션의 브라우저 브릿지 작업을
조상으로 물고 있어 폐기 대상이다 — 아래 "사고" 참조.)

## 다음 세션 시작점

1. `feat/daemon-orphan-adoption-clean`을 main에 머지 (또는 PR)
2. Phase 0 확증이 아직 안 왔다면 사고 호스트에서:
   `grep -c "Ignoring runtime report for untracked session" ~/.happy/logs/*daemon.log`
   — 이 줄이 있으면 리포트 기반 입양(Phase 1)이 그 사고를 직접 해결했음을 확증한다
3. (선택) `daemon.integration.test.ts`에 이번에 수동으로 확인한 시나리오를 자동화된
   테스트로 추가 — 아래 "실측 검증 방법"이 그대로 스크립트화 가능하다

## 실측 검증 결과 (2026-08-01)

로컬 전용 격리 환경(`environments/environments.ts`의 `createEnvironment` +
`startEnvironmentServices` + `seedEnvironment` — pglite 내장 DB, 랜덤 포트, 프로덕션 서버
미접촉)에서 워크트리(`feat/daemon-orphan-adoption-clean` 체크아웃) 빌드로 데몬을 직접 띄워
세 가지 시나리오를 확인했다.

**Phase 2 (기동 시 침묵 고아 입양)** — 세션을 daemon control server에 등록(`/session-started`,
externally-started로) → 데몬 SIGKILL → 상태파일까지 삭제(완전 유실 시나리오, SIGKILL 단독보다
가혹한 조건) → 신 데몬 기동. 로그:
```
[DAEMON RUN] No previous daemon state found; any sessions left by a previous daemon must be adopted
[DAEMON RUN] Adopted orphan session verify-orphan-startup at startup (pid 34095, startedBy happy directly - likely by user from terminal)
[DAEMON RUN] Adopted 1 orphan session(s) left by a previous daemon
```
`daemon.state.json`의 `trackedSessions`에도 즉시 반영됨.

**Phase 4 (T8 상태 유실 경고)** — 위 로그의 첫 줄이 정확히 이것. 이전에는 이 상황이
완전히 침묵했다.

**Phase 1 (리포트 기반 입양)** — 신 데몬에게 **persisted 기록이 전혀 없는** 새 세션ID로
`/session-runtime`을 한 번 POST (살아있는 더미 PID를 `hostPid`로 자기신고). 로그:
```
[DAEMON RUN] Adopted orphan session verify-orphan-report (pid 35477, startedBy happy directly - likely by user from terminal, age 0m)
```
`trackedSessions`에도 즉시 반영. 리포트 하나만으로 persisted 기록 없이도 입양됨을 확인 —
R2의 "persisted 없으면 보수적으로 external로 분류" 경로가 실동작함을 실측으로 확정.

**검증하지 않은 것**: adoption-grace 유예(가드가 입양 후 2분간 정지를 막는지)는 실제
heartbeat tick(기본 60초)을 기다려야 해서 이번엔 건너뛰었다 — 유닛 테스트
(`sessionIdleReaper.test.ts`)로만 커버됨. Phase 3(버전 전환 스냅샷 복원)도 구 버전 데몬
바이너리가 필요해 이번 실측에서 제외 — `handoff.test.ts`의 유닛 테스트로만 커버됨.

### 실측 검증 방법 (재현 절차)

```bash
git worktree add /tmp/happy-verify feat/daemon-orphan-adoption-clean
cd /tmp/happy-verify
ln -s <메인체크아웃>/node_modules node_modules
ln -s <메인체크아웃>/packages/happy-cli/node_modules packages/happy-cli/node_modules
ln -s <메인체크아웃>/packages/happy-server/node_modules packages/happy-server/node_modules
ln -s <메인체크아웃>/packages/happy-app/node_modules packages/happy-app/node_modules
ln -s <메인체크아웃>/packages/happy-cli/tools/unpacked packages/happy-cli/tools/unpacked
cd packages/happy-cli && npm run build   # dist/index.mjs 생성, bin/happy.mjs가 이걸 씀

# 로컬 격리 환경 생성 (pglite, 랜덤 포트, 프로덕션 미접촉)
cd /tmp/happy-verify
export PATH="$PWD/packages/happy-server/node_modules/.bin:$PATH"   # tsx
./packages/happy-cli/node_modules/.bin/tsx <<'TS' 스크립트로 createEnvironment/startEnvironmentServices/seedEnvironment 호출
# seedEnvironment가 이 워크트리의 bin/happy.mjs로 데몬을 이미 하나 띄워준다

# 세션 등록 (더미 프로세스를 PID로 사용)
sleep 3600 & DUMMY_PID=$!
curl -X POST http://127.0.0.1:<daemon httpPort>/session-started \
  -d '{"sessionId":"x","metadata":{"path":"/tmp","host":"h","hostPid":'$DUMMY_PID'},"encryption":{...더미...}}'

kill -9 <daemon pid>; rm daemon.state.json   # 완전 유실 시나리오
source environments/data/envs/<name>/env.sh
node packages/happy-cli/bin/happy.mjs daemon start-sync &   # 재기동 → 로그 확인
```
정리: 더미 프로세스 kill, `stopEnvironment`+`removeEnvironment` 호출, `git worktree remove`.

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
