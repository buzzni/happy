# Agent 명령 direct-entry provider 격리 Plan

> 작성일: 2026-08-24 / 상태: 승인됨
> 근거 문서: [spec.md](./spec.md)

## 아키텍처 영향

| 항목 | 내용 |
|------|------|
| Core / Extension | **Core** — CLI entrypoint dispatch와 session/provider 격리는 모든 provider 실행보다 앞선 부팅 경계이며 extension으로 분리할 수 없다. |
| 관련 모듈 | `packages/happy-cli/src/index.ts`, 신규 `src/commands/agentCommand.ts` |
| 새 외부 의존성 | 없음 — 기존 exact bundled `@buzzni/saycode-cli` 재사용 |
| 공개 API / schema | 변경 없음 |
| 권한 | 변경 없음 — 현재 session environment를 기존 CLI 프로세스에 그대로 전달 |
| ADR | 불필요 — 새 경계나 프로토콜 선택이 아니라 설치형 wrapper에 이미 존재하는 라우팅 계약의 누락 복구 |

`docs/ARCHITECTURE.md`, `docs/CONVENTIONS.md`, `specs/_templates`는 이 저장소에 존재하지 않는다.
따라서 `packages/happy-cli/CLAUDE.md`의 CLI entrypoint 구조와 기존 4문서 spec 형식을 따른다.

## 접근 방식

`src/index.ts`가 provider 기본 분기로 들어가기 전에 `agent`를 인식하고, 작은 command handler가
bundled Saycode manifest의 `bin.saycode`를 해석해 동일 Node 실행 파일로 동기 실행한다. handler는
인자·environment·exit status만 전달하며 Happy session이나 provider 객체를 만들지 않는다.

검토했으나 기각한 대안:

- `bin/happy.mjs`만 신뢰 — 개발 script와 daemon 내부 도구는 `src/index.ts`/`dist/index.mjs`를 직접
  실행할 수 있어 이번 사고를 막지 못한다.
- `agent`를 unknown Claude argument에서 제거만 하기 — 명령이 조용히 사라지고 durable child 제어
  기능이 동작하지 않는다.
- Desktop에서 incompatible model을 무시 — 이미 잘못된 provider가 같은 session에 붙는 원인을
  남기며 Claude 쪽에서도 반대 방향 모델 오류가 생긴다.

## 단계

- [x] Phase 1: 사고 경로와 두 entrypoint 차이를 로그·소스로 확정한다.
- [x] Phase 2: direct-entry 위임 실패 테스트를 먼저 작성하고 최소 handler·dispatch를 구현한다.
- [x] Phase 3: 관련/전체 테스트, build 산출물 success/failure smoke, diff 검토를 완료한다.
- [ ] Phase 4: context와 체크리스트를 완료 처리하고 단일 behavioral commit으로 PR을 생성한다.

## 리스크와 대응

- bundled manifest가 잘못된 경우 → 명확한 error를 throw하고 provider fallback을 금지한다.
- child가 signal로 종료되어 status가 없는 경우 → 성공으로 오판하지 않고 1을 반환한다.
- 인자 재해석으로 계약이 달라질 위험 → handler 테스트가 `agent` prefix와 원래 인자 순서를 고정한다.
