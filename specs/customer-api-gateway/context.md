# 현재 상태

2026-09-14. dev-studio gitlink f1dfe9fc 기준으로 `codex/saycode-api-url-prompt` 브랜치를 생성했다.

## 완료한 구현

- `saycodeApiGatewayPrompt.ts` 한 곳의 공통 규칙을 Claude 로컬·리모트, Codex developer instructions, Gemini 최초 세션 문맥에 연결했다.
- `{NAME}_SAYCODE_API_URL`로 플랫폼 API를 발견하고, 호출 명세·인증·사용자 귀속·기본 및 허용 모델 정보를 참조하도록 안내한다. URL/키 실제 값은 프롬프트에 삽입하지 않는다.
- 후속 사용자 메시지에 API 지침을 추가하지 않는다. Saycode master OFF를 존중하고 Gemini는 유효 정책 변경 시 세션을 갱신한다.
- 새 Saycode-owned 블록을 provenance의 master 제어 목록에 등록했다.

## 검증

- 먼저 7개 실패 테스트로 네 실행 경로의 지침 누락과 Gemini 정책 갱신 누락을 확인했다.
- 프롬프트/로컬 실행/정책 테스트 75개, 리모트 실행/초기 세션 회귀 54개가 통과했다.
- 기존 루트 node_modules의 happy-wire 빌드가 소스보다 오래되어 첫 CLI 타입 검사에 실패했다. 다른 작업 폴더를 변경하지 않고 이 worktree의 happy-wire를 빌드하고 CLI 의존성 링크를 연결해 해결했다.
- happy-wire와 happy-cli의 타입 검사·빌드가 성공했다. 기존 pkgroll bin 경로 및 empty chunk 경고는 남아 있다. 이 변경은 패키지 배치/엔트리 구조를 수정하지 않는다.
- 테스트 의존성은 루트 저장소 node_modules를 symlink로 재사용하며, 이번 worktree에서 빌드한 happy-wire만 로컬 링크를 사용한다. node_modules와 dist는 커밋 대상이 아니다.

## 다른 작업 세션 인계

사용자는 게이트 API URL 규칙만 브랜치로 올려 다른 작업 세션에서 합치기로 했다. npm publish, 릴리스 태그, 버전 변경, dev-studio vendor 소비 포인터 승격은 수행하지 않는다. office 프롬프트/화면은 수정하지 않았다.

이 커밋은 명명 규칙을 사용하는 공통 AI 지침이다. API 등록과 조직 적용을 분리하는 시스템 UI, 환경변수 자동 연결, 등록 명세 전달 경로는 후속 구현이 필요하다. dev-studio의 앞선 게이트웨이 구현은 별도 미커밋 작업이며 이 happy-cli 브랜치에 포함되지 않는다.
