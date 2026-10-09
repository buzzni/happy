---
기능: windows-user-protected-storage
상태: 진행중(소스·패키지·Windows UI 검증 완료, 최신 main 통합 및 배포 수락 전)
마지막 갱신: 2026-10-09
---

# 인수인계

## 승인과 범위
사용자는 보호 수준 동의창 없이 앱이 안전하게 처리하는 Desktop+Happy 방향을 승인했다. Windows CurrentUser DPAPI로 로그인과 PC 신원을 보호한다. 기존 reduced 모드를 자동 수락하지 않으며 회사 ACL/보안 정책을 바꾸지 않는다. 이번 단계의 새 Happy 공개 publish/tag/release는 실행하지 않았다.

## 작업 위치
- Desktop: `codex/windows-credential-storage-recovery`, Draft [#1568](https://github.com/buzzni/aplus-dev-studio-desktop/pull/1568). `13ad0742f` main 통합의 미완료 merge를 보존한 채 구현했다. 최신 확인 main `c4c90e5e0`은 별도 streaming scroll 수정이며 통합 전이다.
- Happy: `codex/windows-user-protected-storage`, 기준 `5c8f05862`. 최신 main `837928368`(1.1.10-aplus.304)은 확인했으나 통합 전이다. private 저장 구현과 직접 겹치는 기존 파일은 package 버전뿐이다. 공개 버전 번호는 아직 정하지 않았다.
- 테스트 의존성은 루트 저장소 node_modules의 심볼릭 링크를 사용한다. Happy CLI의 wire는 현재 worktree 빌드, ajv는 Desktop의 기존 의존성, saycode-cli는 package에 선언된 0.8.1을 격리 경로로 연결했다. 루트 사용자 변경과 기존 release-300 worktree는 수정하지 않는다.

## 구현과 보존 계약
- 새 Happy `windowsPrivateStorage` ABI와 해시 검증된 native helper가 CurrentUser DPAPI·파일 목적/경로 binding·고정 pipe 메시지를 소유한다. 비밀을 argv/env/오류로 출력하지 않는다.
- native reader/publisher는 부모 핸들을 유지하고 reparse·hardlink·열린 writer를 거부한다. 평문은 현재 사용자 소유와 제한 DACL을 검증한 것만 읽는다. 암호문은 DPAPI 무결성을 검증하며 파일 부재(ENOENT)만 신규 생성 사유다. 새 쓰기는 항상 암호문이다.
- Happy access.key/backup/rotation, machine identity, settings, session keys, staged credentials, automation key, daemon state/controlSecret을 연결했다. Desktop auth/account keys·seed/connections/registration lock·standalone·Happy bootstrap backup/rollback·direct daemon readers도 같은 ABI를 사용한다.
- Windows 로그인은 디스크 저장에 성공해야 완료된다. 실패 시 `finalizeCloudLogin`의 임시 창 계정도 이전 값 또는 null로 복구한다. 동의 저장/accept/revoke와 낮은 보호 모드를 제거했고 실패에는 진단·재시도를 제공한다. macOS/Linux 저장 계약은 유지한다.
- 기존 루트/신원을 재사용하고 검증된 평문은 호환 읽기 후 다음 쓰기부터 암호화한다. 귀속 미확인 평문은 보존·거부한다. 별도 auth 복구만 Local State DPAPI+AES-GCM 증명 후 후보로 이전한다. 키를 잃었다고 새 key를 발급해 같은 machineId처럼 쓰지 않는다.
- bootstrap은 기존 daemon 중지를 확인한 뒤 키를 바꾼다. daemon state 읽기 실패는 중지 성공/신규 설치로 처리하지 않는다. 개발용 global install guard도 같은 ABI로 확인한다. 별도 Windows home으로 암호문을 단순 복사할 수 없으므로 격리 설치 안내에서는 새 인증을 사용한다.
- helper 빌드/Windows CI native smoke/package ABI/export/배포 guard를 추가했다. Desktop staging은 ABI·PE x64·helper hash를 검증하고 서명 후 manifest hash를 갱신한다. **현재 Desktop pin에는 새 ABI가 없어 새 Happy 배포 후 pin/Windows lock 갱신이 필요하다. 이 상태로 main 병합·공식 앱 빌드 수락을 주장하지 않는다.**

## 검증 결과
- Happy: 17개 파일 152개 관련 테스트 통과. 표준 `npm run build`(tsc+pkgroll), prepare-publish-package 및 guard-publish-artifact `--install-smoke` 통과. 소스 기준 버전 .303의 로컬 검증 tarball이며 공개 배포하지 않았다. 초기 임시 타입 alias의 AJV 런타임 오류는 실제 의존성 링크와 표준 빌드로 수정했다.
- Desktop: 최종 저장소/UI/staging 11개 파일 96개, daemon/bootstrap/standalone 102개(1개 skip), 로그인 rollback/window 상태 19개, 간소화 온보딩 95개 통과. `npm run typecheck`, electron-vite build, entry-chunk, `git diff --check` 통과. max-lines는 현재 통합 기준 `MERGE_HEAD`로 통과했고 최신 main 통합 뒤 기본 명령으로 재확인한다.
- App 회귀: Guest 로그인 테스트의 페이지 전체 accessible query 때문에 1초 cooldown을 놓치던 1건은 로그인 dialog로 조회를 한정한 뒤 통과. 넓게 실행한 App.part04/08에서는 93개 통과·첨부/worktree 관련 5개 timeout이 남았다(`/tmp/saycode-protected-app-tests.log`). 이 5개를 통과했다고 기록하지 않으며 현재 저장 변경에 대한 실패라는 근거는 확인하지 못했다. 전체 테스트는 실행하지 않았다.
- Mac 실제 Electron E2E: windows-credential-login + onboarding-storage-retry 4개 통과, Windows 전용 2개 skip. 실제 흐름 녹화의 로그인/재시도와 Light/Dark·1280/1440/1920/360 폭 진단 모달을 직접 확인했다. 좁은 창의 내부 스크롤·진단 복사 버튼을 확인했다.
- Windows native: 전용 fixture의 limited interactive token(admin=false), elevated SSH 양쪽 CI smoke 통과. DPAPI 왕복/변조/목적 불일치·SYSTEM 복호 거부, private legacy 허용/foreign ACL·hardlink·junction·writer 거부 확인. 초기 FileRenameInfo NUL 버퍼 누락을 수정한 뒤 반복 게시 10회, Unicode/공백 경로 12개 및 8.3 TEMP 경로 통과.
- 실제 Happy ABI + Desktop 소스 harness: 동일 설치 식별자/머신키, 등록 실패 rollback, daemon control, standalone, binary account key, 로그인 왕복, 손상된 키 거부 통과. fixture 상위 폴더 Users FullControl을 추가한 뒤에도 통과했고 상위 ACL을 변경하지 않았다.
- Windows 실제 Electron GUI: 일반 로그인 후 재실행, 회사형 상위 ACL 조건에서 로그인 후 재실행, 저장 파일 손상 시 로그인 거부/원본 보존 후 재시도 성공 **3개 통과**, non-Windows 사례 2개 skip. native helper·auth IPC·UI는 실제 코드, 로그인 HTTP 응답은 fixture다. Windows에서 소스를 다시 빌드해 실행했고 녹화와 실패 장면을 직접 확인했다. 실패 안내에는 고정 코드만 있고 비밀/경로는 없다. 공식 서명 설치판이나 실제 고객 계정 성공으로 확대하지 않는다.

## 증거 위치와 정리
Desktop worktree `artifacts/windows-user-protection/native-ui-evidence/`에 Windows 로그·결과·스크린샷·녹화를 보관했다. `native-ui-review.png`, `ui-recording-review.png`는 검수 장면이다. Happy/package·Desktop 테스트 로그는 `/tmp/saycode-*-*.log`에 있다. 결과 요약만 문서에 남기고 인증/개인 경로·원문 로그는 커밋하지 않는다. 사용한 전용 Windows 예약 작업 3개는 제거했다. 설치된 실제 앱/프로필과 고객 ACL은 변경하지 않았다.

## 한계·다음 단계
1. 최신 Desktop/Happy main 통합 후 변경 영향 검증, PR 런북 및 문서 동기화.
2. 새 Happy 버전과 정확한 외부 release 절차를 준비한다. Happy 저장소 지침에 따라 publish/tag 실행 직전 명시 승인을 받는다. 승인 전에는 공개 배포하지 않는다.
3. 공개 Happy의 ABI/helper를 포함하도록 Desktop pin/Windows lock을 갱신하고 실제 패키지 staging·서명 설치판을 검증한다.
4. 기존 실제 머신의 재시작/재설치·기존 대화·공용 AI 응답을 확인한다. 새 설치판·온라인 daemon·실제 기존 대화/공용 AI는 아직 미수락이다.
5. test-only sessionWriteScopeFixture/browserRuntime realAgentHarness의 raw 파일 접근은 해당 Windows 실서버 fixture를 사용할 때 ABI reader로 전환해야 한다. 제품 reader와 구분해 남긴다.

DPAPI는 directory-wide snapshot/CAS, 동일 사용자 악성 프로세스·관리자·삭제·과거 암호문 replay를 해결하지 않는다. 회사형 ACL fixture 성공이 고객의 모든 보안 프로그램 환경을 증명하지 않는다.
