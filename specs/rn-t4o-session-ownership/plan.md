# T4o 서버 세션 소유

정본: Desktop origin/main `89a73f56844ee4c10a27dca3f69cdef9fb615561`의 specs/reason-network-adoption/p0a-contract.md §4, §7.1, §7.2 및 spec/plan/tasks/context, p0b-teammate-design. U4 승인과 2026-10-25 구현 요청 범위다.

## 아키텍처 영향

Core: 개인 신원·권한과 authoritative ownership을 소유한다. Happy는 생성 transaction에서 불변 후보를 고정하고 원래 개인의 confirm만 반영한다. A+는 개인 인증·intent/seal·outbox·현재 접근 검사·relay/머신 신원을 담당한다. 두 DB를 하나의 transaction으로 취급하지 않는다. ProjectSessionMap.userId·createdBy·머신 등록자는 소유 권위가 아니다.

실패 테스트 → Happy 원자 생성 → A+ 발급·확인·조회 → 머신/relay → 실제 A+ 산출물의 Happy 검증 순으로 서버 범위를 구현했다. runtime/Desktop 통합 수락은 후속이다.

## 구현 결정

- SessionOwnershipBinding은 owner/생성 scope/intent/operation/nonce/digest가 불변이고 confirmedAt만 최초 한 번 설정된다.
- 삭제 후 proof 재사용을 막기 위해 sessionId PK를 tombstone으로 남기고 별도 nullable sessionRowId FK를 ON DELETE SET NULL로 둔다. 기존 SessionExecutionBinding 패턴에 맞춘 물리적 구체화다. 삭제된 행의 조회·재생성은 거부하고 owner 의미는 바꾸지 않는다.
- 두 proof는 기존 createExecutionBoundSession의 같은 transaction에 저장한다. account seq 갱신 뒤 기한을 재검사하고 commit 뒤에만 이벤트를 보낸다.
- A+ Intent는 최초 policy/body/subject를 고정하고 한 번만 seal한다. Confirmation은 Happy 호출 전에 durable pending을 저장하고 같은 request/binding을 재시도한다.
- 신규 sessionOwnershipAuthority는 기존 findByToken·project/machine ACL·현재 등록/계정 상태와 Happy의 서버 행을 연결하는 생산 인가 adapter다. service의 발급 책임과 분리했으며 공개 권한 계약은 같다.
- relay 등록은 개인 caller와 confirmed source 또는 personal descriptor를 검증한다. 실제 daemon launch record를 검증해 전달하는 main RPC port는 T4rt/T1c 책임이다.

## 호환·복구

별도 additive table, optional proof, 기본 OFF 기능 표지를 사용한다. legacy backfill·사후 owner 부착·소유자 변경 API는 없다. rollback은 A+ producer/relay 및 Happy 소유 기능을 끄고 새 table/journal을 보존한 채 이전 서버로 되돌린다. 일반 무증명 생성은 계속 가능하다. 재사용 방지 기록을 없애는 table 삭제는 하지 않는다.

키 교체는 Happy에 새 공개키 추가 → A+ signer 교체 → 구 키 철회 순이다. binding을 바꾸지 않으며 descriptor/contact는 짧은 기한 안에 새 키로 갱신한다. 운영 DB migration 적용·배포는 실행하지 않았다.

happy-wire 기존 파일/manifest/export/lockfile은 통합 담당 예약이다. 새 sessionOwnership.ts를 Happy server tsconfig source alias로 소비하고 standalone bundle을 검증했다. 배포용 wire export/pin은 통합 담당이 순차 반영한다.
