# plan — cli-plugin-dir-and-env-scrub

## 아키텍처 영향

- Core/Extension 분류: Core(happy-cli Claude 실행 옵션·자식 프로세스 env 경계). 공개 API·와이어·스키마 변경 없음. `QueryOptions`(내부 SDK 어댑터 타입)에 선택 필드 하나 추가.
- 바뀌는 모듈: 신규 `claude/utils/pluginsFromArgs.ts`(인자 → SDK plugins 변환, 순수 함수 — 테스트 가능성 때문에 분리), `claude/claudeRemote.ts`(query 옵션에 한 줄), `claude/sdk/{types,query}.ts`(옵션 통과), `utils/childEnv.ts`(항목 두 개).

## 설계

- 계산 위치는 `runClaudeRemote`의 query 옵션 조립(`assembledOptions`). start와 resume가 같은 조립을 지나므로 한 곳이면 된다(upstream과 같음).
- 절대화 기준은 `opts.path`(세션 경로). spec R5-a 근거.
- env: 정확한 이름 두 개를 prefix 항목으로 추가. 분류 근거는 spec R5-b.

## 대안

- launcher에서 한 번만 검증: 잘못된 인자를 세션 시작 때 거절할 수 있지만 upstream 계약과 갈리고 launcher 변경 면적이 커진다. 기각 — 실행 실패가 그 턴의 launch 오류로 보이는 기존 경로로 충분하다.
- `CODEX_THREAD_ID`를 session-scope로: 세션 안 자식에 남겨도 Codex가 덮어쓰지만, happy 프로세스에서 이 값은 언제나 남의 것이라 lineage가 뜻에 맞다. 기각.

## 검증

- `claude/utils/pluginsFromArgs.test.ts`: 두 형식·반복, `--` 뒤 무시, 상대경로 절대화, 빈 값·NUL·누락 오류, 없으면 undefined, 입력 불변.
- `claude/claudeRemote.test.ts`: start·resume(세션 id, 인자 `--resume`)에서 `options.plugins`, 인자 없으면 undefined, 잘못된 인자면 query 미호출.
- `claude/sdk/query.test.ts`: `plugins`가 SDK `query` 옵션에 그대로 닿음.
- `utils/childEnv.test.ts`: 세 키 비상속(두 경계)·분류, `clearInheritedSessionLineage`, 명시 값(`buildSpawnRequestEnvironment` 등) 회귀.
- `pnpm typecheck`, 관련 vitest, `pnpm build`, happy CI.

## 복구

- revert하면 이전 동작(remote에서 플러그인 빠짐, 두 env 상속)으로 돌아간다. 데이터 영향 없음.
