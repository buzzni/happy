# Happy CLI 릴리스 및 Desktop 소비

## 목표
사용자가 요청한 머지된 Happy 변경을 새 버전으로 공식 발행하고, 발행 검증 후 Desktop exact runtime pin PR을 만든다.

## 요구사항
- 병행 작업에서 .419가 CLI0.9.17을 포함한 ce30029b에 먼저 태그되어 공식 발행 중임을 확인했다. 미사용 1.1.10-aplus.420 후속 후보를 main1b0f3ca9에서 준비하며, 개인 LLM·장치 중계 지원과 기존 main 조직 subagent 변경을 포함한다. 이미 머지된 기능 코드는 수정하지 않는다.
- 공식 발행된 Saycode CLI 0.9.18을 exact dependency와 실제 registry integrity로 고정한다. 준비 tarball에도 같은 버전과 orgEndpointSubagentVersion=1이 있어야 한다. .418의 구 번들 0.9.17에는 해당 옵션·지원 표시가 없으므로 재사용하지 않는다.
- frozen dependency install, CLI build/typecheck, 관련 기존 회귀와 준비된 동일 tarball guard/install-smoke를 검증한다. 실제 공급자·운영 수락으로 확대 해석하지 않는다.
- daemon preflight 테스트의 외부 시간 제한은 기존 자식 프로세스의 30초 제한보다 길게 둔다. 제품 제한·성공 단언·자식 제한을 바꾸지 않는다.
- 버전 변경을 main에 통합한 뒤 exact version/tag/commit과 외부 발행 행위를 제시하고 직전 사용자 확인 후 matching tag를 push한다. 공식 Publish @buzzni/happy-cli Actions만 npm publisher다.
- registry latest/exact version, tarball, fresh lifecycle-enabled install과 daemon status 검증 후 Desktop pin/tag/commit을 갱신한다. Desktop PR은 생성·검증하며 base merge는 하지 않는다.
- Studio 개인 LLM PR #6157과 조직 subagent의 서버 선행 배포 상태는 패키지 검증과 별도다. 기능 gate·운영 설정·전역 daemon은 변경하지 않는다.
