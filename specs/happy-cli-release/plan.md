# 계획

1. [완료] .419 후보와 공개 Saycode CLI 0.9.18 exact dependency·registry integrity 고정 → frozen install·관련 테스트·build/typecheck·동일 tarball guard/install-smoke.
2. [진행 중] release 준비 PR·CI 확인 후 버전 변경 main 통합 → exact 후보와 외부 tag/Actions 발행의 직전 확인.
3. [대기] 공식 tag workflow 관찰 → registry 전파·latest·fresh install/daemon status 확인.
4. [대기] 발행된 identity로 Desktop runtime pin PR → 관련 테스트·staging/smoke·커밋 후 preflight·CI/리뷰 확인.

변경은 기존 Core runtime release identity와 기존 Saycode CLI의 exact 버전 갱신만 다룬다. 새 API/스키마/패키지·기능 gate는 추가하지 않는다. preflight 검증은 자식 30초 제한을 유지하고 테스트 외부 제한만 35초로 맞춘다. 기존 사용자 checkout과 전역 설치는 보존한다. 미발행 pin과 로컬 npm publish는 금지한다. 태그는 PR head가 아니라 검증 후 실제 main merge commit을 대상으로 한다.
