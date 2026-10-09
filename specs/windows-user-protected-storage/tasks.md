# Windows 사용자 암호화 저장 Tasks

- [x] T1. Desktop #1572 및 Happy 기준 코드의 모든 키 사본/직접 reader 조사.
- [x] T2. CurrentUser DPAPI·고정 pipe 계약·변조/타 사용자/목적 불일치·native 파일 게시 검증.
- [x] T3. Happy private 소비자·개발 설치 guard 연결, 152개 관련 테스트·표준 build·package guard/install smoke 통과.
- [x] T4. Desktop auth/account key·seed/connection·bootstrap/standalone 연결. 실제 Windows 소스+새 Happy ABI에서 동일 머신/키·등록 실패 rollback·손상 거부 통과.
- [x] T5. Windows paired capability 확인 후 자동 저장·로그인 저장 우선 처리. reduced 모드/동의 제거, 실패 시 임시 창 로그인 복구, 오류·재시도 제공.
- [x] T6a. Windows native 제한 토큰·회사형 ancestor fixture 및 실제 GUI 로그인/재시작/손상 거부·재시도 3개 통과. Mac Electron E2E 4개 통과. 녹화 장면 검수 완료.
- [ ] T6b. **새 서명 설치판·실제 기존 머신/대화·공용 AI** 수락.
- [ ] T7. 최신 main 통합·PR runbook·최종 문서 동기화. 소스 타입/build·max-lines(통합 대상 기준)는 통과했고 최신 통합 결과는 재확인한다.
- [ ] T8. 새 Happy 공개 버전/태그 승인·배포 후 Desktop pin/Windows lock 갱신 및 실제 package staging 검증.

공개 publish/tag/release/merge는 구현 검증과 구분한다. 새 Happy 배포 없이는 Desktop 공식 빌드 성공으로 기록하지 않는다. T6b/T8이 남아 기능 전체 완료가 아니다.
