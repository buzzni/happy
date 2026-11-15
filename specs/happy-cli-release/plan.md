# 계획

1. [완료] .419 후보 버전과 포함 범위 고정 → frozen install·관련 테스트·build/typecheck·동일 tarball guard/install-smoke.
2. [진행 중] release 준비 PR·CI 확인 후 버전 변경 main 통합 → exact 후보와 외부 tag/Actions 발행의 직전 확인.
3. [대기] 공식 tag workflow 관찰 → registry 전파·latest·fresh install/daemon status 확인.
4. [대기] 발행된 identity로 Desktop runtime pin PR → 관련 테스트·staging/smoke·커밋 후 preflight·CI/리뷰 확인.

변경은 기존 Core runtime release identity만 다룬다. 새 API/스키마/의존성·기능 gate는 추가하지 않는다. 기존 사용자 checkout과 전역 설치는 보존한다. 미발행 pin과 로컬 npm publish는 금지한다.
