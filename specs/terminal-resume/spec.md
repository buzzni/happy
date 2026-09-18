# 터미널 resume (서버·데몬 측)

## 배경

데스크톱 클라이언트는 2026년 초 `specs/desktop-terminal-reliability/` Phase 3 에서
resume 프로토콜을 **전부 구현해 두었다** — `seq` dedup, gap 감지,
`resume(afterSeq)`, `terminal-snapshot` 처리, `terminal-frame-gap` 처리. 그리고
`caps` 협상 뒤에 숨겨 두어, 데몬이 지원을 알리지 않으면 조용히 legacy 로 떨어지게
만들었다. 그 Phase 의 plan.md 는 마지막 항목을 이렇게 남겼다.

> ### Remaining (daemon-side, out of this repo)
> - [ ] Implement the daemon contract in the Happy server … Until then the
>   client runs in legacy/degraded mode.

그 항목이 열린 채로 있었고, 아무도 `caps` 를 내려주지 않았으므로 클라이언트는
**줄곧 legacy 로 돌았다.** 그리고 legacy 는 생각보다 나쁜 상태였다.

Phase 3 은 같은 작업에서 터미널 소켓의 `reconnection` 을 **켰다**(blip 에 패널이
죽지 않도록). socket.io 재연결은 새 socket id 를 뜻하는데, happy 서버의 릴레이는
세션을 열 때 socket id 를 박제하고 있었다. 그래서 재연결 순간 양방향이 함께
죽었다. `specs/machine-socket-duplicate-registration/` 에서 릴레이가 socket id 대신
**소켓의 신원**으로 방향을 판정하도록 고쳐 재연결한 클라이언트가 세션을 되찾게
됐지만, 되찾는 것과 **잃은 출력을 돌려받는 것**은 다른 문제다. 후자가 이 스펙이다.

## 불변식

> 클라이언트가 보지 못한 출력은, 데몬이 아직 들고 있는 한 돌려받을 수 있어야 한다.
> 돌려줄 수 없다면 **구멍이 있다고 말해야 한다** — 조용히 최신인 척하면 안 된다.

## 설계 판단: 버퍼는 데몬이 갖는다

릴레이에 두는 편이 코드는 적지만 틀린다. happy-server 는 sticky session 없는
multi-replica 라, 버퍼는 데몬이 붙은 replica 에만 쌓이고 클라이언트가 peer replica
로 재연결하면 아무것도 없다. 데몬은 세션이 명백히 하나인 유일한 지점이다 —
PTY 가 거기서 돈다.

프레임은 **평문으로** 버퍼링한다. 보안을 낮추는 선택이 아니다: 같은 프로세스가
PTY 를 소유하고 이미 모든 바이트를 메모리에 들고 있다. 그리고 이것이 snapshot 을
가능하게 하는 유일한 방법이다 — 프레임은 각각 따로 secretbox 로 봉인되므로,
이 층 위의 어느 계층도 그것들을 이어붙여 "지금 화면이 어떤지"를 만들 수 없다.

## 인수 조건

- **AC1** 출력 프레임은 세션마다 1부터 단조 증가하는 `seq` 를 갖는다. 0 은
  "아무것도 못 봤다"는 뜻으로 남긴다.
- **AC2** `seq` 는 트림된 프레임을 건너뛰지 않는다 — 인덱스가 아니라 위치다.
- **AC3** 버퍼에 남아 있는 범위의 resume 은 그 프레임들을 순서대로 재전송한다.
- **AC4** 버퍼보다 더 뒤처진 클라이언트에게는 버퍼 전체를 한 덩어리 snapshot 으로
  준다. 버퍼 자체가 일관된 화면이기 때문이다.
- **AC5** 정직하게 답할 수 없으면(버퍼가 통째로 비었거나 트림돼 없어졌으면)
  `terminal-frame-gap` 으로 구멍의 시작을 알린다. **빈 snapshot 으로 화면을
  지우지 않는다.**
- **AC6** 이미 최신인 클라이언트에게는 아무것도 보내지 않는다.
- **AC7** 프레임은 절대 부분적으로 버려지지 않는다. 잘린 이스케이프 시퀀스는
  구멍보다 나쁘다.
- **AC8** resume 은 **활동으로 친다.** 이것이 없으면 idle 워치독이 마지막으로
  실제 바이트가 움직인 시점부터 계속 세고, 14분에 복구된 터미널이 15분에 죽는다.
- **AC9** 릴레이는 `caps` 를 **운반만** 한다. 무엇이 지원되는지 스스로 정하지
  않는다. `caps` 가 없는 구형 데몬이면 클라이언트는 설계대로 legacy 로 떨어진다.
- **AC10** 릴레이는 클라이언트가 snapshot/gap 을 위조하거나 데몬이 resume 을
  보내는 것을 허용하지 않는다 — 방향이 뒤집힌 이벤트는 버린다.

## 프로토콜

클라이언트가 이미 말하는 계약 그대로다(desktop `spec.md` 의 표).

| 방향 | 이벤트 | 페이로드 |
|---|---|---|
| ack | `terminal-open` | `{ ok, sessionId, caps?: { resume, snapshot } }` |
| 데몬→클라 | `terminal-frame` | `{ sessionId, seq?, data }` |
| 클라→데몬 | `terminal-resume` → `terminal-resume-fwd` | `{ sessionId, afterSeq }` |
| 데몬→클라 | `terminal-snapshot` | `{ sessionId, seq, data }` |
| 데몬→클라 | `terminal-frame-gap` | `{ sessionId, fromSeq }` |

## 구현

| 위치 | 역할 |
|---|---|
| `happy-cli/src/daemon/terminalOutputBuffer.ts` | 링버퍼, seq 부여, replay/snapshot/gap 판정 |
| `happy-cli/src/daemon/daemonTerminalSessions.ts` | 세션마다 버퍼 보유, `recordTerminalActivity()` |
| `happy-cli/src/api/apiMachine.ts` | 프레임에 seq, ack 에 caps, `terminal-resume-fwd` 핸들러 |
| `happy-server/.../terminalRelayHandler.ts` | caps·seq 운반, resume 포워드, snapshot/gap 중계 |

버퍼 상한은 문자 1,000,000 (~2MB UTF-16, 터미널당). 데스크톱 클라이언트의 자체
링버퍼(`maxBufferChars`)와 같은 값이라 양 끝이 "얼마나 되돌릴 수 있는지"에
대해 같은 감각을 갖는다.

문자 상한과 **함께** 프레임 20,000 상한도 건다. 프레임 하나는 자기 문자 수
말고도 `{seq, chunk}` 객체·배열 슬롯·문자열 헤더로 ~47바이트를 더 쓰기 때문에,
문자 상한만으로는 메모리가 묶이지 않는다 (1문자 프레임으로 상한을 채우면
~2MB 가 아니라 ~47MB). 코얼레서가 8ms 창으로 flush 하므로 느리게 꾸준히
찍는 출력(진행률 한 줄, 스피너, 조용한 로그의 `tail -f`)만으로도 초당 125개의
작은 프레임이 나온다 — 공격자가 필요 없다.

## 이 스펙이 다루지 **않는** 것

- **데몬 재시작을 건너뛴 복구.** 버퍼는 메모리에만 있고 PTY 도 데몬과 함께
  죽는다. 디스크로 내리는 것은 이 스펙의 값에 비해 과하다.
- **`bufferBytes` 광고.** desktop `spec.md` 의 caps 표에 있지만 클라이언트가 읽지
  않는다. 읽게 되면 그때 채운다.
- **입력(stdin) 의 재전송.** 클라이언트가 보낸 키가 유실됐는지는 이 프로토콜이
  다루지 않는다. 사용자가 다시 치는 것이 정상 동작이고, 명령을 조용히 두 번
  실행하는 것보다 안전하다.
