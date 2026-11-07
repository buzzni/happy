---
기능: cli-offline-handler-transfer
상태: 진행중(T1)
마지막 갱신: 2026-11-07
---

# context

## 현재 상태
origin/main 3fbd89815(.395)에서 분기. spec 세트 작성.

## 결정 로그
- 2026-11-07 Claude 경로는 해당 없음(spec R4-c 근거). 오프라인 분기가 stub 없이 claudeLocal만 돌리고 종료.
- 2026-11-07 `onFileEvent`도 같은 결함이라 함께 이전(R4-a2). Codex가 stub에 등록.
- 2026-11-07 RPC `policy` 인자(`customerBound`)도 기억해 옮김 — 포크 `RpcHandlerManager.registerHandler`가 세 번째 인자를 받음(upstream엔 없음).
- 2026-11-07 ACP 러너도 같은 경로라 테스트 범위에 포함.

## 열린 문제
- 없음

## 다음 시작점
T1.
