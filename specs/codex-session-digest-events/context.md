# Context

2026-11-11 코드·로컬 검증 완료. 브랜치 fix/codex-digest-mcp-events.
기반 origin/main 9fe3fd5d8d97197f27ed85d2c11f775e7641e3c3.

두 Common MCP read/search의 raw live notification을 전달하며 mapper는 이력과 같은
McpTool + server/tool/arguments를 보존한다. browser_task_*의 기존 이름·quota는 유지한다.
원래 Happy 체크아웃·설치 CLI·버전·pin은 바꾸지 않았다.

raw 처리기→mapper 신규 6건 중 기존 3건 실패를 먼저 확인한 뒤 구현했다.
관련 4파일 274건, 선행 생산 CLI build·typecheck 통과. 최신 wire를 이 체크아웃에서
빌드해 소비했고 기존 의존성 캐시는 로컬 링크로 재사용했다. 새로운 dependency는 없다.
Desktop parser→processor 회귀 12건과 전체 관련 130건 통과, 생산 mapper 출력으로
직접/Codex live/Codex history 격리 Electron 검색→파일→선택 읽기 3건 통과.
출처 인증·프로젝트 API·파일 RPC 상대는 fixture이며 실제 provider·계정·daemon 수락은 아니다.

functions.exec 코드·출력을 파싱하지 않는다. provider가 구조화된 내부 MCP 이벤트를
주지 않는 경우까지 해결됐다고 주장하지 않는다. 실제 설치 CLI 발행·Desktop pin·서버
반영과 실제 계정 수락은 남아 있다. tag push·publish·배포는 하지 않았다.

## Fable 5.2/high 리뷰 보완

digest MCP의 tool-call-end에서 browserQuotaFailure를 호출하지 않는다. 같은 모양의 JSON을
받아도 browserQuotaKind 자체를 넣지 않으며 browser_task_*만 기존 분류를 수행한다.
새 회귀 Red → Green. 생산 CLI build/typecheck를 선행한 관련 4파일 275건 통과.
일반 build의 기존 bin/dist 및 empty chunk 경고는 존재한다. 버전·publish·pin은 변경하지 않았다.

## 다음 작업: 저장소별 PR 준비

사용자 “다음 작업 진행”에 따라 실사용 수락 전제를 점검했다. 설치 Desktop 0.1.88의
주 App 번들에는 search_project_sessions와 Common MCP wrapper 문자열이 없고, 현재
연결 도구 목록에도 search_project_sessions는 없다. 설치 CLI는 .410이다. 따라서 새 기능의
실제 계정 왕복을 성공으로 검증할 수 없어 PR 준비를 먼저 한다. 원본 provider 로그나
실사용 자격증명을 읽거나 복제하지 않았다. Saycode GitHub 연결의 read-only PR 목록은 정상이다.
Desktop 작업 폴더의 별도 커밋 18개와 HTML preview 작업을 제외해 새 main 기준으로 분리한다.
Happy 버전 충돌을 피하려 릴리스 .413 준비 PR #1249와 독립된 기능 변경만 준비한다.

PR 준비 검증 완료(2026-11-12): branch `fix/codex-digest-mcp-events`, base `9fe3fd5d8d97`.
이번 기능 8개 파일만 allowlist로 검사해 분리했다. 서버/Happy/이 Desktop의
관련 회귀는 각각 22/275/122건이다. 서버 변경 5파일 ESLint·검색 helper 타입,
새 main Desktop 전체 타입·max-lines·guide 통과. Happy는 이전 검증과 base·코드가 같아
추가 build/test를 반복하지 않았다. 릴리스 조각 게이트는 HEAD 기준이므로 로컬 커밋 후 다시 확인한다.
새 Desktop PR 브랜치의 격리 왕복 3건 및 캡처 6장 검토 완료. evidence는 root worktree의
`.aplus/verification/worktrees/pr-session-search-desktop/.aplus/verification/evidence/2026-11-11T15-04-34-648Z-e1867de8/`.
검증용 Electron 프로세스 모두 종료 확인. 공유 node_modules 링크 대신 origin/main과
manifest/lockfile이 정확히 일치하는 기존 설치본을 APFS clone으로 각각 격리했다.
다음 작업은 준비된 세 브랜치의 push·main 대상 Draft PR 생성 승인이다. 원격 쓰기·merge·
CLI 발행·pin·설치본 교체·운영 배포는 하지 않았다. 실제 계정 수락은 반영 후에 남는다.
준비 목록: 원래 A+ 작업 폴더 `.aplus/verification/pr-prep/session-search/manifest.json`.

2026-11-12 사용자 지시: Draft는 자동 리뷰가 실행되지 않으므로 추가 검증 후 일반 PR로 생성한다.
3개 저장소의 main 대상 PR·push 범위는 앞서 제시한 변경과 본문이다. 실제 배포/CLI 발행은
포함하지 않는다. 소유 조회 장애·조직 전환·다음 요청의 소유 철회·다른 프로젝트 조회 실패를
추가 검증하고 Desktop 필수 preflight를 커밋 후 실행한다. PR 생성 뒤 자동 리뷰와 CI를 처리하며,
최종 Desktop head에는 ci:macos 검증도 요청한다. base로의 병합은 사용자 몫이다.

추가 검증: 서버 26건·Desktop 126건 통과. 요청자/대상 소유 가드를 각각 제거한 두 변형을
assertion 실패로 검출하고 소스 byte 원복을 확인했다. 새 테스트는 현재 Vitest 2 matcher에
맞춰 호출 횟수와 인자를 각각 검사한다. 모든 origin/main과 merge-tree 충돌 없음.
Desktop main의 #3240 전진은 이 기능과 겹치지 않아 main 추종만을 위한 병합은 하지 않는다.
preflight 완료 후 일반 PR을 생성하고 자동 리뷰 및 최신 CI를 확인한다.
