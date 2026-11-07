---
기능: cli-plugin-dir-and-env-scrub
상태: 진행중(T1)
마지막 갱신: 2026-11-07
---

# context

## 현재 상태
origin/main 9bba63e7b(H1·H2 포함)에서 분기. spec 세트 작성.

## 결정 로그
- 2026-11-07 `HAPPY_FORK_CODEX_THREAD_ID`는 `HAPPY_FORK` prefix로 이미 덮임. `HAPPY_SIDE_CHAT`(spawn-seed)·`CODEX_THREAD_ID`(session-lineage) 추가 — 근거 spec R5-b.
- 2026-11-07 포크에서 `HAPPY_SIDE_CHAT`·`CODEX_THREAD_ID`를 설정·읽는 코드 없음(R5-c), 상속이 필요한 경로 없음.
- 2026-11-07 플러그인 경로 절대화는 `providerPath`가 아니라 세션 경로(`opts.path`).

## 열린 문제
- 없음

## 다음 시작점
T1.
