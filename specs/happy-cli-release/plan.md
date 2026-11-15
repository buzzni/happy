# 계획

1. [완료] .420 후속 후보와 공개 Saycode CLI 0.9.18 exact dependency·registry integrity 고정 → frozen install·관련 테스트·build/typecheck·동일 tarball guard/install-smoke.
2. [대기] .420 exact 버전·외부 PR/main/tag/Actions 발행 사용자 승인 → Ready PR·새 head CI → 실제 main merge commit 확인.
3. [대기] 공식 tag workflow 관찰 → registry 전파·latest·fresh install/daemon status 확인.
4. [대기] 발행된 identity로 Desktop runtime pin PR → 관련 테스트·staging/smoke·커밋 후 preflight·CI/리뷰 확인.

변경은 기존 Core runtime release identity와 기존 Saycode CLI의 exact 버전 갱신만 다룬다. 새 API/스키마/패키지·기능 gate는 추가하지 않는다. preflight 검증은 자식 30초 제한을 유지하고 테스트 외부 제한만 35초로 맞춘다. 기존 사용자 checkout과 전역 설치는 보존한다. 미발행 pin과 로컬 npm publish는 금지한다. 태그는 PR head가 아니라 검증 후 실제 main merge commit을 대상으로 한다.

.419 태그 ce30029b는 #1268 merge1b0f3ca9보다 먼저 생성돼 CLI0.9.17이다. 기존 태그 이동·삭제·재발행 없이 .420으로 진행한다. 사용자 승인은 .419까지였으므로 .420 외부 변경 전 별도 확인한다.
