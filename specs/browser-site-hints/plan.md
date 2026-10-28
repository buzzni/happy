# 에이전트 브라우저 사이트 노트 Plan

> 작성일: 2026-10-28 / 상태: 진행중
> 근거 문서: [spec.md](./spec.md)

## 아키텍처 영향

| 항목 | 내용 |
|------|------|
| 관련 모듈 | `packages/happy-cli/src/browserRuntime/agentTools.ts`(결과에 siteHint), 새 `browserRuntime/siteHints.ts`(스킬 탐색·frontmatter·패턴·작업별 1회), `claude/utils/startHappyServer.ts`(세션 경로·flavor로 배선) |
| 새 외부 의존성 | 없음(frontmatter는 세 필드만 읽는 작은 파서) |
| 공개 API/스키마 | MCP 도구 결과에 선택 필드 `siteHint` 추가(추가형). 도구 이름·입력 무변경 |
| Core vs Extension | 메커니즘(연결·표시 구분)은 런타임 Core, 노트 내용은 사용자·조직 스킬. Desktop 변경 없음(배포 후 pin만) |

## 접근 방식

`registerBrowserTaskTools`에 선택 옵션 `siteHints: { hintFor(taskId, urls) }`를 받는다. 없으면 지금과 같다. 구현체는 세션 시작 때 스킬 위치를 정하고 첫 호출 때 한 번 읽어 캐시하며, 작업별로 알린 스킬을 기억한다. open_page는 입력 URL, submit_batch는 navigate 단계 URL과 결과 관찰 URL을 넘긴다.

기각한 대안: 스킬 본문 주입(토큰), Desktop Extension 기여(사용자 선택에서 기각), 관찰(observe)마다 붙이기(반복 노출).

## 단계

- [x] Phase 1: siteHints 모듈(frontmatter·패턴·탐색·1회) → 단위 테스트
- [x] Phase 2: agentTools 결과 연결 + startHappyServer 배선 → 계약 테스트, typecheck
- [x] Phase 3: 문서(스킬 작성법)·context → PR은 사용자 요청 시, 배포는 릴리스 절차(사용자 승인)

## 실행 근거

- 사용자 요청 2026-10-28 "Tier 2 6번 spec 만들고 구현 시작해줘", 출처 선택 "스킬 frontmatter".
- happy-cli 발행·태그·Desktop pin 올리기는 별도 승인(AGENTS.md Release Publisher).
