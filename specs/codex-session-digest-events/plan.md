# Plan

1. [x] 실제 raw notification 처리기 → 생산 mapper에서 두 Common MCP 이벤트 누락을 실패 테스트로 재현한다.
2. [x] server/tool 허용 범위를 공유 판정하고 live start/end를 구조화된 McpTool로 보존한다.
3. [x] 기존 browser quota·mapper 회귀, 타입 검사와 Desktop의 생산 envelope 소비 왕복을 검증한다.

Core의 기존 session event만 사용한다. 외부 의존·DB·공개 wire schema 변경 없음.
롤백은 새 predicate와 digest MCP 전달 조건을 되돌린다. CLI 발행·tag push·배포는 실행하지 않는다.
기반: origin/main 9fe3fd5d8d97197f27ed85d2c11f775e7641e3c3의 별도 체크아웃.

## Fable 리뷰

- [x] digest 결과가 browser quota 오류 모양이어도 quota로 해석되지 않는 Red → Green.
- [x] browser 기존 receipts 유지 및 생산 build/typecheck·관련 4파일 275건 통과.

## 다음 단계: PR 준비와 실사용 수락 전제 확인

1. [x] 변경을 현재 origin/main 기준의 저장소별 브랜치로 분리하고 다른 작업을 제외한다.
2. [x] 새 base에서 영향받는 회귀·타입·격리 왕복을 확인하고 로컬 커밋·PR 설명을 준비한다.
3. [ ] 사용자 승인: 추가 실패 경로와 PR preflight 검증 후 일반 PR을 생성하고 CI·자동 리뷰를 처리한다.
4. [ ] Happy 병합 → GitHub Actions CLI 발행 → Desktop pin/앱 업데이트 및 MCP 반영 후 실제 계정 수락.

기존 spec의 배포·발행 제한은 유지한다. 설치 앱의 인증정보를 복제하거나 실제 앱을 교체하지 않는다.

## PR #1250의 CI 미러 복구

- [x] Ubuntu mirror+file 목록에서 반복 DNS 실패한 Azure mirror를 공개 Ubuntu HTTPS mirror 두 곳으로 대체한다.
- [x] YAML·셸 구문과 mirror 파일 생성을 확인했다. 동일한 실제 SDK/bubblewrap 검증을 새 CI에서 실행한다.
- [ ] 최종 head의 모든 OS·Node 검사 성공과 PR 상태를 확인한다. CLI 버전·릴리스·실사용 설치본은 변경하지 않는다.

## PR #1250 재실행의 Chrome 시작 실패 (2026-11-12 사용자 수정 요청)

1. [x] Chrome 즉시 종료를 실제 자식 프로세스로 재현하고 오류 원인·종료 코드·프로필 정리 회귀를 추가한다.
2. [x] 테스트 도우미가 시작 실패를 즉시 알리고 stderr를 제한된 길이로 보존하도록 최소 수정한다.
3. [ ] 같은 실제 Chrome/broker 검증을 유지하고 새 원격 CI로 시작 원인과 최종 통과 여부를 확인한다.

재실행 attempt2는 DNS·bubblewrap·실 Claude SDK 검사를 통과했다. 새 실패는
localClients.poc.test.ts의 Chrome DevToolsActivePort 생성 전 timeout이다.
기능 검사 생략·Chrome sandbox 비활성화·CLI 릴리스·main 병합은 하지 않는다.
