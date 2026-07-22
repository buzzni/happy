# 세션 생성자(createdBy) metadata 기록 Plan

> 작성일: 2026-07-22 / 상태: 초안
> 근거 문서: [spec.md](./spec.md)

## 아키텍처 영향

| 항목 | 내용 |
|------|------|
| 관련 모듈/레이어 | `packages/happy-cli/src/daemon`(spawn RPC), `packages/happy-cli/src/utils/createSessionMetadata.ts`(공용 metadata 팩토리), `packages/happy-cli/src/{claude,codex,gemini,openclaw,agent/acp}`(5개 백엔드 러너), 데스크톱 `src/sync/sessionCreation*.ts`(cross-repo) |
| 새 외부 의존성 | 없음 |
| 모듈 경계/공개 API 변경 | **있음** — `spawn-happy-session` RPC 파라미터 additive 확장(`SpawnSessionOptions`), `Metadata` 타입에 optional `createdBy` 필드 추가. 둘 다 additive라 하위 호환 깨지지 않지만, RPC 계약 변경이라 이 문서가 사실상 ADR 역할을 겸함(별도 ADR 번호는 부여하지 않음 — 이 repo는 `docs/adr/` 컨벤션이 없고 `specs/[feature]/`가 결정 기록의 단일 지점) |
| 데이터 스키마 변경 | 없음(서버 DB 스키마 불변, metadata는 여전히 opaque encrypted string) |

## 접근 방식

기존 `parentSessionId`/`forkedFromMessageId` lineage 필드가 이미 "daemon RPC 파라미터 →
`extraEnv`의 `HAPPY_*` 환경변수 → 러너가 `process.env`에서 읽어 metadata에 조건부 스프레드"
경로로 구현돼 있다. `createdBy`도 정확히 같은 파이프를 재사용한다 — 새 소켓 이벤트나 REST
엔드포인트를 만들지 않는다.

검토했으나 기각한 대안:
- **데스크톱의 기존 `environmentVariables`(프로젝트 env-group 마운트) 맵에 얹기** — 기각.
  그 맵은 실제 에이전트 child process의 셸 환경변수로 그대로 들어가 사용자가 `printenv`로
  볼 수 있다. accountId를 거기 섞으면 제어 평면 값과 사용자 데이터가 뒤섞인다.
- **happy-server에 새 metadata PATCH 엔드포인트 추가** — 기각. 서버는 이미 metadata를
  opaque 문자열로만 다뤄서(R5) 서버 변경이 아예 불필요한데, 새 엔드포인트를 만들면 공격면과
  배포 리스크만 늘어난다.

## 단계 (Phases)

- [ ] **Phase 1: RPC 파라미터 → 환경변수 스레딩** → 검증: `apiMachine.test.ts`(또는 신규)로
      `spawn-happy-session` 핸들러가 `createdByAccountId`/`createdByDisplayName`을
      `spawnSession()` 옵션으로 넘기는지, `run.ts`의 `spawnSession`이 `extraEnv.HAPPY_CREATED_BY_*`를
      채우는지 단위 테스트. `SESSION_LINEAGE_ENV_PREFIXES`에 `HAPPY_CREATED_BY` 추가 후
      `sessionEnv.test.ts`(있다면) 통과.
- [ ] **Phase 2: (structural) `runClaude.ts` → 공용 팩토리 통합** → 검증: 리팩토링 전후로
      기존 `runClaude` 관련 테스트 스위트가 그대로 통과(동작 변경 없음을 증명). 별도 커밋.
- [ ] **Phase 3: (behavioral) `createdBy`를 metadata 팩토리에 추가 + 5개 러너 배선** →
      검증: `createSessionMetadata.test.ts`에 "env 있으면 `createdBy` 포함 / 없으면 생략"
      케이스 추가, 5개 러너(claude/codex/gemini/openclaw/acp) 각각 최소 1개 스모크 테스트로
      env→metadata 전달 확인.
- [ ] **Phase 4: 데스크톱 쪽 배선(cross-repo)** → 검증: 데스크톱 저장소의
      `SpawnHappySessionInput`에 필드 추가 + `createSessionForProject`가 `auth.userId`/
      `auth.username`을 채워 보내는지 테스트. 이 Phase는 데스크톱 저장소의 커밋으로 완료되며,
      완료되면 `specs/desktop-conversation-search`의 T14가 파서 쪽을 마저 구현.
- [ ] **Phase 5: 문서화** → 검증: `docs/user-identity.md`에 `createdBy` 흐름 한 단락 추가,
      `context.md` 완료 요약.

## 리스크와 대응

- **`params: any`로 느슨하게 destructure되는 RPC 핸들러라 오타/누락이 컴파일 타임에 안 잡힘**
  → Phase 1에서 명시적 단위 테스트로 방어(런타임 검증 대체).
- **5개 백엔드 러너 중 하나를 빠뜨릴 위험** → Phase 3에서 5개 전부 체크리스트 항목으로 분리해
  개별 완료 표시.
- **happy-cli 릴리스·버전 pin 없이는 데스크톱이 실제로 이 필드를 쓸 수 없음** → 이 spec은
  구현·테스트까지만 책임진다. 릴리스는 `AGENTS.md` 정책대로 별도 승인 후 진행(spec 비목표
  참조). 데스크톱 쪽 `specs/happy-runtime-pin-*` 전례를 따라 별도 pin 작업으로 이어질 예정.
