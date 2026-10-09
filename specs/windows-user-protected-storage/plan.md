# Windows 사용자 암호화 저장 Plan

> 작성일: 2026-10-09 / 상태: 진행중

## 아키텍처 영향
Core. 로그인·비밀정보 custody·머신 authoritative state이며 Extension 대상이 아니다. Desktop 저장소 선택과 Happy persistence가 협력한다. 서버/API 권한·키 내용은 바꾸지 않으며 디스크 표현만 Windows 사용자 암호문으로 전환한다.

사용자 승인: 동의창을 자동 클릭하는 방식 대신 로그인과 PC 연결 키를 Windows 사용자 보호로 저장하고, 기존 머신/대화를 유지하는 Desktop+Happy 변경 제안에 “응 진행해”(2026-10-09). 아래 구현·격리 검증은 그 범위다. 공개 publish/tag/release는 실행하지 않는다.

## 접근과 대안
- Windows CurrentUser DPAPI를 사용한다. Machine scope는 다른 로컬 사용자도 복호화할 수 있으므로 금지한다.
- 우선 기존 Windows .NET helper 빌드 방식을 재사용하는 작은 전용 실행 파일로 암복호/기존 파일 검증을 구현·실측한다. 추가 npm native 의존성은 도입하지 않는다. 제품은 소스 컴파일이 아니라 빌드에서 준비·해시/서명 검증된 helper만 사용해야 한다.
- 비밀은 private stdin/stdout pipe, 고정·제한된 프레임으로만 주고받는다. 오류는 고정 코드이며 입력/출력 원문을 포함하지 않는다. helper 차단/timeout은 저장 실패이지 평문 쓰기 허가가 아니다.
- 암호문을 저장 파일의 목적/범위에 묶고, 임시 파일과 backup/restore에서 같은 논리 파일 binding을 유지한다. 기존 코드의 직접 JSON read와 catch→null은 암호문을 누락/신규로 오판하므로 모두 연결한다.
- 기존 안전 저장소는 유지한다. 자동 경로는 별도 암호화 저장 정책이며 windowsSecretAcl 전역 스위치로 모든 파일을 풀지 않는다.
- 기각: #1572 동의 자동 수락(평문 Happy 키 노출), 기존 평문 단순 복사(출처 불명), 새 machineKey와 기존 ID 조합(기존 데이터 복호 불가), Credential Manager(크기·다중 상태·기존 Happy 파일 계약 영향).
- DPAPI는 관리자·동일 사용자 악성 프로세스/파일 삭제·과거 암호문 replay까지 막는 기능이 아니다. 파일 무결성/링크/경쟁 검사와 기존 신원 소유권 계약을 별도로 유지한다.

## 순서·검증
1. 모든 비밀 사본과 직접 reader 목록 작성, 현행 실패 재현을 기준으로 native 암호화 계약 검증.
2. Happy 암호문 읽기 지원 → 모든 key writer/backup/rotation/staged-session/daemon 제어 경로 연결. unreadable identity는 throw하여 재등록 금지.
3. Desktop seed/connection/auth와 bootstrap/standalone/direct daemon reader 연결. 원본 보존·전환 중 crash·재실행 검증.
4. 두 소비자의 capability 확인 후 자동 저장소 준비를 활성화하고 동의 모달/낮은 보호 모드 연결 제거. 실패는 기존 상세 진단과 수동 재시도 제공.
5. 관련 테스트·타입·빌드·PR 검증북·native Windows/실제 UI 녹화 검수. 기존 머신과 공용 AI 응답은 별도 실제 수락.
현재 1~4단계 저장 연결과 5단계의 소스·패키지·Windows native/실제 GUI 검증을 완료했다. 최신 main 통합과 관련 검증도 완료했다. 새 서명 설치판/기존 실제 대화·AI 수락과 paired package pin은 남아 있다. 상세 증거는 context.md, 미완료 범위는 tasks.md를 따른다.

## 복구·호환성
읽기 지원을 먼저 제공하고 새 형식 활성화는 양쪽 지원 확인 뒤 수행한다. migration은 검증된 원본을 덮기 전에 암호문 왕복·atomic 게시를 확인한다. 데이터/키 삭제·재발급은 하지 않는다. 구버전은 새 암호문을 읽지 못하므로 rollback은 새 쓰기만 중지하고 암호문 reader를 유지하는 패치다. 기존 실행 daemon과 혼용해 파일을 바꾸지 않는다.

## 근거
[CryptProtectData](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata), [ProtectedData](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata).
