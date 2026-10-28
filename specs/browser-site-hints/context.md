---
기능: browser-site-hints
상태: 구현 완료(로컬 커밋 — push·PR·발행 전)
마지막 갱신: 2026-10-28
---

# 에이전트 브라우저 사이트 노트 Context

## 현재 상태

Phase 1~3(스킬 frontmatter `sites:` 탐색·매칭·작업별 1회, `browser_task_open_page`·`submit_batch` 결과의 `siteHint`, startHappyServer 배선, 사용 안내 `packages/happy-cli/docs/browser-site-hints.md`)을 마쳤다. 남은 것은 PR(사용자 요청 시), happy-cli 발행·태그와 Desktop pin 올리기(각각 사용자 승인), 실제 세션 실측이다. 노트 출처는 사용자 선택에 따라 스킬 frontmatter `sites:`다. Desktop은 바꾸지 않고, happy-cli 배포 후 pin만 올린다. 배경은 Aside 벤치마킹 추천 #6(Desktop 저장소 `specs/` 아님 — 이 기능의 코드는 전부 happy-cli에 있다).

## 핵심 결정 로그

- [2026-10-28] 결정: 노트 출처 = 스킬 frontmatter(사용자 선택) / 기각: Desktop Extension 기여(새 Desktop↔데몬 계약 필요)
- [2026-10-28] 결정(PR #980 리뷰 medium·low 2): 사이트 노트 객체는 startHappyServer에서 세션당 한 번 만들어 handlers로 넘긴다(MCP 서버는 요청마다 새로 만들어져, 등록 안에서 만들면 작업당 1회·세션당 1회 읽기가 깨졌다). 상한은 읽는 SKILL.md 파일 수에 건다. `description: |`·`>` 블록은 이어지는 줄을 한 줄로 읽는다
- [2026-10-28] 결정: 세션 폴더(metadata.path)를 모르면 프로젝트 스킬 폴더를 보지 않는다 / 이유: daemon의 cwd로 추측하면 다른 프로젝트 스킬을 읽을 수 있다. 처음 `process.cwd()` 폴백을 넣었더니 전역 process를 일부만 복사해 두는 mandatoryMcp 테스트에서 예외가 나 워커가 죽었다
- [2026-10-28] 결정: 결과에는 스킬 이름·설명·경로만, 본문은 에이전트가 필요할 때 읽음

## 다음 세션 시작점

1. PR 요청 시 `browser-site-hints` 브랜치(worktree `~/workspace/happy/.worktrees/browser-site-hints`)를 PR로.
2. 발행(사용자 승인) 후 Desktop pin을 올리고, 실제 세션에서 `sites:` 스킬이 있는 사이트로 이동해 `siteHint`를 확인한다.

## 검증·승인 상태

- 실행한 검증: `pnpm run typecheck` 통과(종료 코드). siteHints 16건·agentTools 20건·mandatoryMcp 2건 통과(새 테스트는 구현 전 실패 확인). browserRuntime 전체 599건 중 시간 초과 3건 — 바뀌지 않았고 바뀐 모듈을 import하지 않는 파일(runtimeAutoApproval·localClientApps·localClients)이며 단독 재실행에서 localClients 1건만 5.1초로 남음(부하성). startHappyServer.test의 소켓 3건은 origin/main에서도 같은 실패
- 승인: 구현까지. 발행·태그·pin은 별도 승인.
