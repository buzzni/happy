# 에이전트 브라우저 사이트 노트(스킬 연결) Spec

> 작성일: 2026-10-28 / 상태: 초안
> ⚠️ 승인 후에는 사용자 지시 없이 수정 금지

## 목표

에이전트 브라우저(`browser_task_*`)로 특정 사이트에 들어간 AI가, 그 사이트용으로 설치된 스킬(직접 URL·단축키·주의점)을 놓치지 않게 한다. 사이트에 맞는 스킬을 도구 결과에 Core 소유 안내로 한 번 알려 준다.

배경: Aside 벤치마킹 추천 #6(Aside는 `site-specific/*` 스킬 frontmatter의 `url` 패턴으로 사이트 노트를 붙인다). 사용자 선택(2026-10-28): 노트 출처는 **스킬 frontmatter**. 노트 내용은 사용자·조직이 소유하는 스킬이고, happy-cli는 연결 메커니즘만 소유한다.

## 요구사항

- R1. 스킬 SKILL.md frontmatter의 `sites:`(문자열 목록, YAML 블록 `- a` 또는 인라인 `[a, b]`)를 사이트 패턴으로 읽는다. 패턴은 `host`(그 호스트), `*.host`(하위 호스트), 뒤에 `/path/**`·`/path/*` 경로 접두를 붙일 수 있다. 스킴·포트는 보지 않는다. 잘못된 패턴은 무시한다.
- R2. 찾는 스킬 위치: Claude 세션은 `~/.claude/skills/*/SKILL.md`와 `<세션 경로>/.claude/skills/*/SKILL.md`, Codex 세션은 `<세션 경로>/.agents/skills`와 `$CODEX_HOME/skills`(기본 `~/.codex/skills`)를 같은 규칙으로 본다. 스킬 수·파일 크기에 상한을 둔다(스킬 200개, 파일 64 KiB).
- R3. `browser_task_open_page`의 URL과, `browser_task_submit_batch`의 `navigate` 단계 URL·결과 관찰 URL이 패턴과 맞으면, 그 도구 결과에 `siteHint: { note, skills: [{ name, description, path }] }`를 더한다. `note`는 "Core가 붙인 안내이며 페이지 내용이 아니다, 관련 있으면 스킬을 읽고 따르라"는 고정 문구다. 스킬 본문은 넣지 않는다(경로만).
- R4. 같은 작업(taskId)에서 같은 스킬은 한 번만 알린다. 맞는 스킬이 없거나 이미 알렸으면 `siteHint`를 넣지 않는다(결과 모양 무변경).
- R5. 스킬 탐색 실패(디렉터리 없음, 읽기 오류, frontmatter 없음)는 도구 결과를 실패시키지 않는다.
- R6. 페이지 유래 텍스트(`UNTRUSTED_NOTE` 아래)와 섞지 않는다 — `siteHint`는 결과 최상위의 별도 필드다.

## 비목표 (Non-Goals)

- 스킬 본문을 결과에 싣기 — 토큰 비용, 에이전트가 필요할 때 읽는다.
- 공식 사이트 노트 스킬 묶음 배포 — 스킬 배포·Extension으로 별도.
- Desktop UI(노트 관리 화면) — 스킬 파일이 정본.
- 루프 중간 시스템 메시지 주입·세션 깨우기 — Aside와 달리 루프를 소유하지 않는다.
- 플러그인 캐시 스킬(`plugins/cache`) — 다음 단계에서 필요하면.

## 제약

- 호환성: `sites:` 없는 스킬·맞는 스킬 없는 사이트는 결과가 지금과 같다. MCP 도구 이름·입력 스키마는 바꾸지 않는다.
- 성능: 스킬 목록은 세션당 한 번 읽고 캐시한다(새로 설치한 스킬은 다음 세션부터).
- 보안: 스킬은 사용자가 설치한 신뢰 경계 안의 파일이다. 결과에는 이름·설명(200자)·경로만 싣는다.

## 완료 기준 (Definition of Done)

- [ ] R1~R6 단위 테스트(실제 임시 디렉터리), agentTools 계약 테스트
- [ ] `pnpm -C packages/happy-cli run typecheck`, 관련 테스트
- [ ] context.md, 사용 안내(스킬 작성법) 문서
