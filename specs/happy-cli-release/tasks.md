# 체크리스트

- [x] main/현재 registry .418·Desktop .418 및 관련 머지 상태 확인
- [x] 격리 source checkout 및 frozen dependency install
- [x] .419/공개 CLI0.9.18 exact dependency·실제 integrity lock 변경·build/typecheck
- [x] CI에서 관측한 preflight 외부 5초/자식 30초 불일치를 외부 35초로 정렬하고 기존 단언·자식 제한 유지
- [x] 최신 관련11 suites/95 tests, 공개 CLI 실제 sandbox 실행 포함 (이전1270개와 합산하지 않음; 이전 차단7개와 전체 회귀는 공식 CI 확인 필요)
- [x] native3종 포함 준비 tarball guard/install-smoke 및 번들 index의 공개 CLI 바이트 일치
- [ ] release PR·CI 및 main 통합
- [ ] exact tag/외부 발행 직전 확인
- [ ] 공식 workflow·registry·독립 설치 검증
- [ ] Desktop exact pin PR·검증·CI/리뷰
