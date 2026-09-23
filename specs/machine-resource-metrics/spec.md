# machine-resource-metrics

## 배경

Desktop 은 머신의 CPU·메모리·load average 를 보여주려 할 때마다 그 머신에 원격
`bash` 를 걸어 인라인 node 스크립트를 실행해 왔다 (`aplus-dev-studio` 의
`packages/web-ui/server/machineUnion.ts` → `buildMachineQuickStatusCommand`).
그 방식에는 대화·창·Desktop 수만큼 측정이 늘어난다는 한계가 있다.

- 측정 주체가 클라이언트라서, 같은 머신을 보는 Desktop 이 N 대면 OS 측정도 N 번이다.
- 그 스크립트는 CPU 사용률을 만들려고 `Atomics.wait` 로 150ms 를 **블로킹**한다.
  동시에 두 개가 돌면 서로의 측정값을 교란한다.
- 구독 개념이 없어서, 아무도 보고 있지 않아도 목록을 여는 것만으로 측정이 일어난다.

머신에서 daemon 은 이미 single owner 다. 측정을 daemon 으로 옮기면 "몇 명이 보고
있는가" 와 "몇 번 측정하는가" 가 분리된다.

## 결정

daemon 이 **하나의 sampler** 를 소유하고, 클라이언트는 **lease 로 구독**한다.
요청은 측정하지 않는다 — lease 를 갱신하고 캐시를 읽을 뿐이다.

기존의 인증·암호화된 machine RPC 경계를 그대로 쓴다. happy-server 코드와 DB 는
바뀌지 않는다: `rpc-register` 는 메서드 이름을 검증하지 않고 방 이름으로만
라우팅하며, params/result 는 `RpcHandlerManager` 가 머신 키로 암복호화한다.

### 왜 push 가 아니라 poll 인가

daemon 이 클라이언트에 자발적으로 보내는 경로는 happy-server 의 ephemeral 이벤트
union 에 닫혀 있고(`machine-alive` → `machine-activity` 하나뿐), 새 타입을 넣는 것은
서버 변경이다. lease + read poll 은 서버를 건드리지 않고도 **측정 중복 제거라는
목적을 온전히 달성한다** — 요청은 늘어나도 측정은 늘지 않기 때문이다.

## wire v1

method: `machine-resource-metrics` (machine-scoped, 기존 RPC 와 같은 암호화 경계)

### request

```ts
{ version: 1, action: 'read' | 'release', subscriptionId: string }
```

- `read` — 35초 lease 를 갱신하고 캐시된 스냅샷을 돌려준다. **첫 활성 구독일 때만**
  baseline 을 즉시 측정하고 10초 주기 timer 를 시작한다.
- `release` — 그 구독을 끝낸다. 마지막 구독이면 timer 를 즉시 멈춘다.
- `subscriptionId` — 불투명 문자열, 1~128자. 클라이언트는 retain 주기마다 새로 만든다.

### response

```ts
{ version: 1, status: MachineResourceStatus, snapshot: MachineResourceSnapshot | null }

type MachineResourceSnapshot = {
    sampledAt: number                                 // daemon wall clock (ms)
    cpuPercent: number | null                         // 0~100, 첫 샘플·이상값은 null
    cpuCount: number
    memoryUsedBytes: number                           // totalmem() - freemem()
    memoryTotalBytes: number
    loadAverage: [number, number, number] | null      // 1/5/15분, Windows 는 null
}
```

### status — 닫힌 집합

클라이언트가 분기하는 값이므로 확장 시 양쪽을 같이 고친다.

| status | 뜻 | 클라이언트 처리 |
|---|---|---|
| `ok` | 읽기 성공, 또는 `release` 처리 완료 | `snapshot` 사용 (release 는 `null`) |
| `unsupported-version` | 이 daemon 이 모르는 wire version | 재시도 금지, 미지원 표시 |
| `invalid-request` | 형식·action·subscriptionId 가 잘못됨 | 버그. 재시도 금지 |
| `subscription-ended` | 자기 `release` 를 추월한 `read` | 새 subscriptionId 로 재구독 |
| `capacity-exceeded` | 구독 상한(64) 도달 | 백오프 후 재시도. 기존 구독은 무영향 |
| `sample-unavailable` | 구독은 살아 있으나 **최신 측정 시도가 실패함** (첫 측정 실패 또는 기존 cache 이후 실패 포함) | `snapshot: null`로 "미측정/지연" 표시. Desktop store가 보유한 마지막 정상값은 별도로 보존 |

`snapshot` 은 `ok` 이면서 최신 측정 시도가 성공했을 때만 실린다. 측정이 실패하면
이전 daemon cache가 있더라도 `sample-unavailable`/`null`을 반환한다. Desktop store는
이미 표시 중인 마지막 정상값을 자체적으로 보존할 수 있지만, 새 read가 오래된 cache를
현재값으로 오인해서는 안 된다. **실패가 0% 또는 fresh 값으로 보이지 않게 하는 것이
이 규칙의 목적이다.**

## 측정 규칙

- **CPU**: `os.cpus()` 누적 시간의 **인접 두 샘플 차이**. `os.loadavg()` 로
  대체하지 않는다(그것은 사용률이 아니라 실행 대기열이다). 이벤트 루프를 막아
  두 번째 샘플을 만들지도 않는다 — daemon 은 그 사이에 RPC 를 처리한다.
  유효한 쌍이 없으면 `0` 이 아니라 `null` 이다.
- **코어 수가 바뀌면** 그 쌍을 버리고 baseline 을 다시 잡는다. 짧은 쪽에 맞춰
  자르면 다른 기계의 카운터를 섞어 아무도 근거로 쓸 수 없는 숫자가 나온다.
- **카운터가 전진하지 않으면**(suspend/resume, 컨테이너 재시작) `null`.
- CPU time의 필수 필드가 누락되거나 finite non-negative 숫자가 아니면, CPU
  baseline을 버리고 전체 snapshot을 `null`로 만든다. 빈 CPU 목록도 unavailable이다.
- memory의 `total`은 finite positive, `free`는 finite non-negative이며 `free <= total`이어야
  한다. 이를 어기면 잘못된 값을 0으로 clamp하지 않고 전체 snapshot을 `null`로 만든다.
- **memory**: `totalmem() - freemem()`. OS 전체이고 캐시를 포함하며, 프로세스별
  RSS 가 아니다. 화면의 상세 설명이 이 의미를 밝힌다.
- **load average**: Windows 는 항상 `[0,0,0]` 이라 유휴 머신과 구분되지 않는다.
  `0` 이 아니라 `null` 로 보고한다. 음수·non-finite 값도 `null`로 정규화한다.
- delta 가 필요 없는 값(메모리·load·코어 수)은 **첫 샘플부터 실린다.** CPU delta 가
  없다는 이유로 이미 아는 값까지 비우지 않는다.

## 수명 규칙

정지 조건이 둘인 것은 의도된 것이다.

1. **정상 `release`** — 즉시 멈춘다. 흔한 경우이고, 읽는 사람이 없는데 TTL 을
   기다리며 노트북을 계속 측정하게 둘 이유가 없다.
2. **lease 만료(35초)** — 창이 죽거나 네트워크가 끊기면 release 는 오지 않는다.
   클라이언트가 사라졌을 때 유효한 규칙은 이것뿐이므로 안전망이다.

- timer 는 **언제나 하나다.** 시작 조건은 "구독 표가 비어 있었는가" 가 아니라
  "timer 가 없는가" 다. 마지막 lease 가 만료된 직후·tick 이전에 도착한 `read` 가
  스스로를 첫 구독으로 오인해 두 번째 interval 을 만들고 첫 번째 handle 을 잃는
  경로를 막는다(그렇게 유실된 interval 은 영원히 측정한다).
- lease·tombstone 의 만료는 **monotonic clock** 으로 판정하고, `sampledAt` 만
  wall clock 이다. NTP 보정이 시계를 되돌리면 wall clock 기준 만료 시각이 미래로
  밀려 버려진 sampler 가 계속 돈다.
- `release` 는 lease 를 들고 있지 않았어도 tombstone 을 남긴다. `release` 가 자기
  `read` 를 추월하는 경우, 남길 것이 없으면 그 `read` 가 아무도 기다리지 않는
  구독을 새로 연다. tombstone 은 같은 TTL 뒤에 잊혀지므로 id 재사용을 막지 않는다.
- 구독 수는 64 로 제한한다. id 는 클라이언트가 만들므로 상한이 없으면 표가 무한히
  자란다. 상한 초과는 **기존 구독을 건드리지 않고** 새 구독만 거절한다.
- `stop()`(daemon shutdown)은 terminal 이다. 이후 요청은 sampler 를 되살리지 못한다.
- interval 은 `unref()` 한다. 측정이 daemon 프로세스를 살려 두는 이유가 되어선 안 된다.

## 범위 밖

- managed runtime 의 dispatch allowlist 는 넓히지 않는다. 핸들러는 등록되지만
  managed 머신에서는 기존 계약대로 거절된다 — 그것이 그 머신에서의 올바른 답이다.
- capability metadata 는 추가하지 않는다. 구 daemon 판별은 클라이언트가 첫
  method-unavailable 을 캐시하는 방식으로 처리한다.
- 디스크 사용량, 세션별 프로세스 자원, 히스토리, 새 ephemeral 이벤트 타입.
