---
기능: cli-usage-limits-snapshot
상태: 진행중(T1)
마지막 갱신: 2026-11-07
---

# context

## 현재 상태
origin/main 5b53b48a4(H4 포함)에서 분기. spec 세트 작성.

## 결정 로그
- 2026-11-07 창 `resetsAt`은 ISO 문자열 — 정본 R8 "unix초→ISO". upstream(epoch ms)과 다르다. 포크에 `usageLimits`를 읽는 코드가 없어(`git grep`) 호환 부담 없음. `capturedAt`은 다른 agentState 시각 필드처럼 epoch ms.
- 2026-11-07 같은 내용 재게시 없음 — 정본 R8 "변화 없으면 생략". upstream은 `capturedAt` 신선도 때문에 5분마다 재게시하지만 따르지 않는다. `capturedAt`은 "마지막으로 값이 바뀌어 게시된 시각"이다.
- 2026-11-07 seed는 SDK 실험 메서드 `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })`(0.3.308에 있음, typeof로 확인). 곁질문 채널을 거치지 않는다(R8-d).
- 2026-11-07 `rate_limit_info.unifiedWindows`는 SDK 타입에 없고 포크 tracker만 방어적으로 읽는다 — 스냅샷은 수집하지 않음(spec 범위 밖).

## 열린 문제
- 없음

## 다음 시작점
T1 — `claude/utils/usageLimits.test.ts` 실패 테스트부터.
