# Session Skill Governance

## 배경

원격(SDK) 세션은 `query.ts`에서 official `@anthropic-ai/claude-agent-sdk` `Options`로 매핑되는데, `settingSources`와 `skills` 옵션이 매핑되지 않아 항상 SDK 기본값(전체 로드)이 적용됐다. 이 때문에 관리형 세션(예: Saycode)에서도 `~/.claude/settings.json`(플러그인 활성화·훅·권한 오버라이드 포함)과 사용자 홈의 스킬이 전부 로드되며, 이를 세션/머신 단위로 제한할 방법이 없었다.

계획·TDD·리뷰 워크플로우를 재정의하는 사용자 설치 스킬(예: superpowers류)이 관리형 세션에 로드되면, 그 세션을 감싼 애플리케이션(Saycode 등)이 이미 강제하는 워크플로우와 충돌해 계획 문서 이중화, 리뷰 반려-재작성 루프, 서브에이전트 중복 스폰으로 이어질 수 있다.

## 목표

기존 `HAPPY_WORKER_MODEL` 패턴과 동일하게, env var로 세션의 `settingSources`/`skills`를 제어할 수 있게 한다. 값이 없으면 완전히 기존 동작과 동일(no-op)해야 한다.

## 요구사항 (BDD)

### Scenario 1: 기본값은 변경 없음
- Given: `HAPPY_SETTING_SOURCES`, `HAPPY_SKILL_ALLOWLIST`가 설정되지 않음
- When: 원격 세션을 시작하면
- Then: `sdkOptions.settingSources`/`sdkOptions.skills`는 `undefined`이고 SDK 기본 동작(전체 로드)이 그대로 적용된다.

### Scenario 2: settingSources 제한
- Given: `HAPPY_SETTING_SOURCES=project,local`
- When: 원격 세션을 시작하면
- Then: `~/.claude/settings.json`(user)은 로드되지 않고 project/local settings만 로드된다.

### Scenario 3: skills 허용목록
- Given: `HAPPY_SKILL_ALLOWLIST=pdf,docx` 또는 `HAPPY_SKILL_ALLOWLIST=all`
- When: 원격 세션을 시작하면
- Then: 나열된 스킬만(또는 전부) 모델에 노출된다. 나열되지 않은 스킬은 목록에서 숨겨지고 Skill 도구가 거부한다 (SDK 계약 — 파일 자체는 디스크에 남아 Read/Bash로는 여전히 접근 가능).

### Scenario 4: 잘못된 값은 무시
- Given: `HAPPY_SETTING_SOURCES`에 알 수 없는 토큰만 있음 (예: `bogus`)
- When: 파싱하면
- Then: 유효한 항목이 하나도 없으면 필드를 생략한다(undefined) — SDK 기본값으로 폴백.

## 알려진 한계 (범위 제외)

- `settingSources`는 파일시스템 settings.json 소스만 제어한다. `~/.claude/skills/`에 raw 파일로 설치된 스킬 디렉터리 자체의 스캔은 이 옵션으로 막히지 않는다 (SDK 계약).
- `skills` 허용목록은 이름 기반 필터라 사전에 허용할 이름을 아는 소비자(운영자)가 있어야 동작한다. 자동으로 "user-scope만 제외"하는 소스 기반 필터는 SDK에 존재하지 않는다.
- `strictPluginOnlyCustomization`(managed settings)은 project 자체 스킬 디렉터리까지 함께 막아 이 저장소의 프로젝트 스코프 스킬 관례(`packages/*/.claude/skills`)를 깨뜨리므로 채택하지 않았다.
- 이 옵션을 실제로 세팅해 세션/머신 단위로 켜는 것은 소비자(예: Saycode)의 배포 설정 몫이다. 이 변경은 그 소비자가 켤 수 있는 스위치만 노출한다.
