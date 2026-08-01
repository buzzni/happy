# 데몬 고아 세션 입양(orphan adoption) Spec

> 작성일: 2026-07-31 / 상태: 초안
> ⚠️ 승인 후에는 사용자 지시 없이 수정 금지

## 목표

데몬 교체(버전 업그레이드, 크래시, 상태파일 유실) 이후에도 **살아있는 happy 세션이 반드시
어느 데몬의 추적 목록에 들어가도록** 만든다. 추적되지 않는 세션은 세 리퍼(zombie / empty /
idle)가 전부 건너뛰므로 24시간 절대 컷조차 적용되지 않고 영구히 남는다.

## 배경 — 2026-07-31 사고

구 데몬 pid 1094(`happy-coder@1.1.9`)가 자식 4개(30566, 117331, 117375, 117596)를 띄운 상태에서
신 CLI(`@buzzni/happy-cli@1.1.10-aplus.79`)가 버전 불일치를 감지하고 재시작을 요청했다.

1. 구 데몬이 `/stop`을 받고 **자기 버전의** `clearDaemonState()`를 실행 — 1.1.9는 상태파일을
   `unlink`한다 (포크에서는 이미 `state:'stopped'` 보존으로 고쳐졌지만, 실행된 건 구 버전 코드)
2. 자식 4개는 SIGTERM 대상이 아니므로 그대로 살아남아 고아가 됨
3. 신 데몬 123060이 기동 → `readDaemonState()`가 `null` → `run.ts:219` 복구 블록이 통째로
   건너뛰어짐 (`[DAEMON RUN] Found N sessions from previous daemon` 로그 부재로 확인)
4. 세 리퍼는 모두 `getCurrentChildren()`(= `pidToTrackedSession`)만 순회하므로 고아 4개는
   **평가 자체가 호출되지 않음**. 가드가 막은 게 아니라 대상이 아니었던 것

### 핵심 발견 — 고아는 이미 30초마다 새 데몬에게 자기를 알리고 있다

`daemonPost()`는 **매 호출마다 `daemon.state.json`을 다시 읽어** 포트를 찾는다
(`controlClient.ts:12`). 세션은 2초마다 `keepAlive()`(`claude/session.ts:85`)를 돌리고,
상태 변화가 없어도 최대 30초마다 `/session-runtime`을 강제 전송한다(`apiSession.ts:1254`).

즉 고아 세션은 데몬이 바뀌어도 **새 데몬에게 자기 sessionId를 30초마다 보고**하며, 새 데몬은
이렇게 버린다:

```ts
// run.ts:389
const trackedSession = getCurrentChildren().find(s => s.happySessionId === sessionId);
if (!trackedSession) {
  logger.debug(`[DAEMON RUN] Ignoring runtime report for untracked session ${sessionId}`);
  return;   // ← 매 30초 도착하는 입양 신청서를 버리는 지점
}
```

입양 경로가 없는 게 아니라, **이미 도착해 있는 증거를 버리고 있었다.**

## 요구사항

- R1. Given 데몬이 추적하지 않는 sessionId의 `/session-runtime` 리포트가 도착하고, 그 리포트가
      살아있는 `hostPid`를 동반할 때, When 데몬이 리포트를 처리하면, Then 그 세션을 추적 목록에
      입양하고 리포트 내용을 반영한다.
- R2. Given 입양 대상의 원 세션 metadata가 persisted 저장소에 있을 때, When 입양하면, Then
      `startedBy`를 원본에서 복원한다 (`metadata.startedBy === 'daemon'` → `'daemon'`, 그 외 →
      기존 외부 세션 문자열). **`'adopted'` 같은 새 값을 쓰면 안 된다** — `evaluateIdleStopGuard`의
      `local-session` 가드가 `startedBy !== 'daemon'`으로 판정하므로, daemon-spawn 세션을
      영구 보호 대상으로 오분류하게 된다.
- R3. Given 입양 시점, When 세션 시작시각(`sessionStartTimes`)을 정할 때, Then persisted 저장소의
      실제 값을 쓴다. `now`로 리셋하지 않는다 — 나이 기반 정책(최소 나이, 하드캡, empty 리퍼)이
      데몬이 재시작될 때마다 초기화되면 장수 고아가 영원히 리핑되지 않는다.
- R4. Given 세션이 입양된 직후, When `if-idle` 정지가 시도되면, Then 입양 후 유예시간
      (`HAPPY_DAEMON_ADOPTION_GRACE_MS`, 기본 120초) 동안은 `adoption-grace`로 거부한다.
      R3 때문에 15시간 된 미사용 세션이 입양 즉시 empty 리퍼(15분) 대상이 되는데, 유예 없이는
      복구 첫 틱에 무더기 SIGTERM이 나간다. `force` 정지(사용자 개시)는 영향받지 않는다.
- R5. Given 구버전 세션이 `hostPid` 없이 리포트할 때, When 입양을 시도하면, Then persisted
      저장소의 `metadata.hostPid`로 폴백하되 `isPidAlive` 검증을 통과할 때만 입양하고,
      실패하면 입양하지 않고 그 사실을 로그로 남긴다.
- R6. Given 데몬 기동 시 이전 상태가 없거나 비어 있을 때, When 복구 단계를 지나면, Then
      persisted 저장소에서 `metadata.hostPid`가 살아있는 세션을 입양한다. PID 재사용 방어로
      **프로세스 실제 시작시각 ≤ `savedAt`**을 검증하고, 시작시각을 확인할 수 없으면 입양하지 않는다.
      (R1은 살아서 보고하는 고아를, R6은 살아있지만 침묵하는 고아를 담당한다.)
- R7. Given 버전 불일치로 구 데몬을 정지시킬 때, When 정지 후 상태파일이 사라져 있으면, Then
      정지 **전에** 떠 둔 스냅샷을 `state:'stopped'`로 복원해 다음 복구 블록이 읽게 한다.
      구 데몬의 `unlink`는 그 프로세스 안에서 실행되므로 우리가 고칠 수 없다 — 신 CLI 쪽 방어가
      유일한 통로이며, 다운그레이드/롤백 시에도 재발을 막는다.
- R8. Given 기동 시 `readDaemonState()`가 `null`을 반환할 때, When 복구 블록을 지나면, Then
      "이전 데몬 세션이 있었다면 고아가 됐을 수 있음"이 로그에 남는다. 현재는 조용히 넘어가
      사고가 로그상 드러나지 않는다.
- R9. 회귀 없음: 이미 추적 중인 세션의 리포트 경로, 정상 복구 경로(상태파일 존재)는 기존과
      100% 동일하게 동작한다.

## 비목표 (Non-goals)

- **`ps` 스캔 기반 입양은 하지 않는다.** PID만 입양해도 세 리퍼가 전부
  `if (!session.happySessionId) continue`로 건너뛰고(`sessionIdleReaper.ts:480,542`),
  `stopSession`도 sessionId 키로 찾는다. 결국 sessionId↔pid 매핑이 필요한데 그건 이미
  `~/.happy/sessions.json`(`readPersistedSessions()`)에 있다. ps 스캔은 이 매핑의 열등한
  대체재이고 플랫폼 의존 휴리스틱만 늘린다. 한 번도 데몬에 등록된 적 없는 프로세스만 추가
  커버하는데, 그런 세션은 sessionId가 없어 어차피 리퍼가 손대지 못한다.
- 데몬 수명주기를 launchd/systemd로 옮기는 것 (`run.ts:176` TODO). 별개 과제.

## 재검토 조건

- 데몬이 OS 서비스 관리(launchd/systemd)로 이전되면 R7은 불필요해진다 — 그때 삭제 검토.
- `/session-runtime` 리포트 주기(30초)나 `daemonPost`의 상태파일 재읽기 방식이 바뀌면 R1의
  전제가 무너진다 — 그 변경 시 이 spec을 함께 재검토.
