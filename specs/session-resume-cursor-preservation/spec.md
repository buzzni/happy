# 입양된 세션의 resume 커서 보존

## 배경 — 2026-08-15 22:08 무응답 사고

모바일 앱에서 보낸 메시지에 아무 응답도 오지 않았다. 로그 추적 결과:

| 시각 | 사건 |
|---|---|
| 08-14 18:15:43 | 세션 `cmssqf5t...` spawn. `sessions.json` 에 최초 1회 기록 |
| 08-15 20:19:37 | **daemon 재시작.** PID 9179 를 살아있는 세션으로 입양 |
| 08-15 22:03:37 | idle reaper `absolute-idle-cut` 이 SIGTERM |
| 08-15 22:08 | 모바일에서 메시지 전송 → 서버에만 남고 아무도 소비하지 않음 |
| 08-15 22:08:47 | 앱의 `resume-happy-session` 이 1ms 만에 에러 반환, spawn 없음 |

resume 실패 코드는 `SESSION_CURSOR_MISSING` 이었다. 디스크 레코드에
`lastProcessedSeq` 가 없었기 때문이다.

## 근본 원인

1. daemon 재시작 시 `run.ts` 의 상태파일 복구는 `TrackedSession` 을
   `{startedBy, pid, happySessionId, tmuxSessionId, userHomeDir}` 로만 만든다.
   같은 데이터가 `sessions.json` 에 있는데도 `encryption` 과
   `persistedLastProcessedSeq` 를 채우지 않는다.
2. `resolveOrphanAdoption` 도 `metadata` 와 `userHomeDir` 만 복원하고
   `encryption` / `persistedLastProcessedSeq` 는 빠뜨린다.
3. 그래서 reaper 가 죽이기 직전 호출하는 `preserveSessionForResume` 이
   `if (!session.happySessionId || !session.encryption) return false` 에서
   **아무 로그 없이** 빠져나간다. 세션이 살아있는 동안 쌓인
   `runtime.lastProcessedSeq` 가 디스크에 한 번도 내려가지 않는다.
4. 이후 resume 은 spawn 시점의 stale 레코드만 보고 커서가 없다는 이유로 거부한다.
   이 세션은 영구적으로 resume 불가가 된다.

`preserveSessionForResume` 실패가 무음이라 로그만으로는 "resume 못 하는 상태로
죽였다"는 사실을 알 수 없었다. 이것이 진단을 어렵게 만든 2차 결함이다.

## 요구사항

### AC1 — 입양된 세션도 resume 가능해야 한다
daemon 이 이전 daemon 의 상태파일에서 세션을 복구하거나 orphan 런타임 리포트로
입양할 때, `sessions.json` 의 해당 레코드에서 `encryption`,
`happySessionMetadataFromLocalWebhook`, `userHomeDir`,
`persistedLastProcessedSeq` 를 복원한다.

### AC2 — reaper 가 커서를 디스크에 내린다
AC1 결과로 `preserveSessionForResume` 이 입양 세션에서도 성공하여,
reaper 가 세션을 종료하기 전에 최신 `lastProcessedSeq` 가 디스크에 기록된다.

### AC3 — 보존 실패는 로그에 남는다
`preserveSessionForResume` 이 false 를 반환할 때 세션 id 와 이유
(`no-session-id` / `no-encryption`)를 로깅한다.

### AC4 — 하이드레이션은 기존 데이터를 덮어쓰지 않는다
이미 값이 있는 필드(webhook 으로 받은 최신 encryption 등)는 디스크의 오래된
값으로 덮어쓰지 않는다.

### AC5 — 모바일 앱이 무응답을 방치하지 않는다
모바일 앱에서 연결이 끊긴 세션에 메시지를 보낼 때, **복구를 시도할 수 있는
조건이면**(실험 플래그 on + 머신 온라인 + resumable backend id 존재):
- resume 을 시도하고, 실패 코드가 복구 가능(`SESSION_NOT_TRACKED`,
  `SESSION_METADATA_MISSING`, `SESSION_ENCRYPTION_MISSING`,
  `SESSION_CURSOR_MISSING`)이면 `recover-happy-session` 으로 이어간다.
- recover 가 새 세션을 만들었으면 그 세션으로 이동한다. 메시지는 이미
  initialPrompt 로 전달되었으므로 다시 보내지 않는다.
- 시도한 복구가 실패하면 사용자에게 명시적으로 알리고 composer 의 텍스트를
  보존한다. **조용히 삼키지 않는다.**

복구를 시도할 수 없는 조건(실험 플래그 off, 머신 오프라인, backend id 없음)
에서는 **기존처럼 그대로 전송해 서버에 큐잉한다.** presence offline 은
"프로세스 죽음"뿐 아니라 "살아있는 CLI 의 일시적 연결 끊김"(노트북 lid 닫힘)
도 포함하며, 후자에서 큐잉→재접속 시 수신은 정상 동작하는 기존 플로우다.
세션 헤더가 이미 연결 상태를 표시하고, AC1~AC2 덕에 죽은 세션으로 큐잉된
메시지도 다음 성공적인 resume 에서 replay 된다.

## 범위 밖

- idle reaper 의 종료 정책 자체(2시간 hard cap)는 그대로 둔다. 의도된 동작이다.
- 이미 커서 없이 저장된 기존 레코드의 소급 복구는 하지 않는다. 커서 없는
  resume 거부는 안전 장치이며 그대로 유지한다.
