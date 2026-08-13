# Context — Session Skill Governance

## 2026-08-13 완료

- `src/orchestrator/skillGovernance.ts` 신규 — `readSkillGovernanceConfigFromEnv`(env → `{settingSources, skillAllowlist}` 원시 문자열), `buildSkillGovernanceOptions`(파싱 + 검증, no-op 시 `{}`). `HAPPY_WORKER_MODEL`과 동일한 순수 함수 패턴.
- `src/orchestrator/skillGovernance.test.ts` 신규 — 9 테스트 (TDD Red→Green).
- `src/claude/sdk/types.ts` `QueryOptions`에 `settingSources?: SettingSource[]`, `skills?: string[] | 'all'` 추가 (SDK 타입 재export 포함).
- `src/claude/sdk/query.ts` — `sdkOptions.settingSources`/`sdkOptions.skills`로 매핑.
- `src/claude/claudeRemote.ts` — `workerAgents`와 나란히 `skillGovernance` 조립, `sdkOptions`에 배선.
- 검증: `skillGovernance.test.ts`(9) + 인접 `orchestrator/`, `claude/sdk/`, `claudeRemote.test.ts` 전부(105 tests, 13 files) 통과. `tsc --noEmit`에 변경 파일 오류 없음.

## 아키텍처 노트 (spec.md "알려진 한계"에 정리)

SDK 조사 결과 "user-scope 스킬 디렉터리만 제외"하는 단일 플래그는 없다:
- `settingSources`: settings.json 파일(권한/훅/플러그인 활성화)만 제어, 스킬 디렉터리 스캔과 무관.
- `skills`: 이름 허용목록. 소스(user/project/plugin) 구분 없이 전부 동일 취급.
- `strictPluginOnlyCustomization`(managed): user와 project 스킬 디렉터리를 함께 막아 이 저장소의 `packages/*/.claude/skills` 관례를 깬다 — 채택 안 함.

따라서 이번 변경은 "완전 자동 차단"이 아니라 **소비자(Saycode 등)가 세션/머신 단위로 켤 수 있는 스위치**를 노출하는 것까지가 SDK 계약 안에서 가능한 근본 해결의 한계다. Saycode 쪽에서 이 스위치를 실제로 켜는 배포 설정은 별도 작업(happy-cli 릴리스 필요, `[[happy-cli-release-process]]`).
