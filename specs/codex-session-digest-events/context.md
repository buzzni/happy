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

2026-11-12 PR #1250 자동 리뷰 approve(69aa93a), Windows20/24·macOS·Linux20 smoke 성공.
Linux24는 최초/세 번째 시도에서 모두 azure.archive.ubuntu.com DNS 실패로 bubblewrap을
설치하지 못했다. 두 번째는 의존성 postinstall에서 15분 이상 정체되어, 유일한 실행 중 lane만
취소하고 새 runner에서 다시 실행했다. 무변경 재시도는 더 하지 않고 해당 Linux24 준비 단계의
/etc/apt/apt-mirrors.txt를 공개 Ubuntu HTTPS archive/security 목록으로 지정한다.
APT의 mirror+file 형식은 Ubuntu apt-transport-mirror 공식 문서와 GitHub runner-images의
configure-apt.sh/ configure-apt-sources.sh를 확인했다. signed source/배포판/키링 설정을
건드리지 않고 같은 bubblewrap 설치·실제 SDK 검사로 검증한다. 이것은 PR CI 복구용 변경이며
제품 인증/권한·CLI 버전·외부 dependency·설치본은 바꾸지 않는다.
근거: https://manpages.ubuntu.com/manpages/tenacious/man1/apt-transport-mirror.1.html
https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/configure-apt.sh
로그: 원래 A+ worktree .aplus/verification/pr-prep/session-search/happy-linux24-{ci,third-ci}.log.

검증 중 archive.ubuntu.com도 로컬 DNS timeout을 보인 반면 security.ubuntu.com의 signed
Release는 HTTP200이었다. security mirror를 먼저 두고 APT acquire timeout10s/retries0으로
장애 미러에서 수분씩 재시도하지 않고 다음 공식 미러로 전환한다. GitHub runner-images의
configure-apt.sh도 동일한 이유로 acquire 재시도/timeout을 제한한다. 실 SDK step의5분 상한은 유지한다.

CI 보완 로컬 확인: js-yaml 파싱·전체 run 블록 bash -n·prefix를 임시 파일에 실행해 정확한
HTTPS mirror2줄 생성 확인. bubblewrap 설치와 integration-claude-auth-pin 명령이 유지됨을
검사했다. security.ubuntu.com의 noble InRelease와 필요한 bubblewrap .deb HTTP200 확인.
제품 소스 diff는 없으며 해당 워크플로와 spec plan/context만 수정했다. 새 CI에서 검증한다.

## 2026-11-12 재실행 attempt2의 실제 Chrome 실패

사용자가 job130860751958 실패 해결을 요청했다. Happy 전용 체크아웃의 origin이
buzzni/happy이며 원격 branch head c6829f1과 같고 clean인 것을 확인했다.
새 job은 apt/bubblewrap와 실제 Claude SDK 검사를 통과했고 localClients.poc.test.ts의
launchChrome에서 DevToolsActivePort 미생성으로 실패했다. 기존 helper의 stdio:ignore가
시작 오류와 조기 종료를 숨겨 20초 timeout만 남긴다. 환경 원인은 아직 확정하지 않는다.

테스트 전용 helper가 stderr tail8192자와 spawn/exit 원인을 보존하고 조기 종료 시
즉시 실패하며 실패 프로필도 정리하도록 보완했다. 실제 자식 프로세스가 exit23과
synthetic 오류를 남기는 회귀는 기존 코드에서20초 후 실패(Red), 수정 뒤 통과했다.
생산 build/typecheck를 포함하는 단위 회귀1건 및 실제 Chrome/broker 수집·철회
왕복1건(macOS, 합성 데이터) 통과. Chrome sandbox/검사 조건은 유지한다.
의존성이 원래 체크아웃의 삭제된 경로를 가리켜 이 작업 폴더에 frozen-lockfile
CLI+wire 설치를 복구했다(ignore-scripts, lockfile 변경 없음). CLI 버전/설치본은 안 바꿨다.
다음은 진단이 보강된 같은 Linux CI에서 실제 시작 실패 원인을 확인하고 해결하는 단계다.
