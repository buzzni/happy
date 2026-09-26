/**
 * 실제 worker 프로세스 + 실제 ONNX 모델로 sealed relay 왕복 (specs/org-shared-difficulty-routing T12).
 *
 * `difficultyRoutingClassifierHost.test.ts` 는 worker 를 가짜로 바꿔 큐·타임아웃·권한 같은
 * host 자체 로직만 본다. 그래서 "봉인된 원문이 실제로 열리고, 실제 모델이 난이도를 돌려주며,
 * 그 결과가 계약대로 응답에 실린다"는 **접합부**는 어떤 테스트도 건너지 않는다. 이 파일이 그 구간이다.
 *
 * 실행 조건(둘 다 필요, 아니면 skip):
 *   HAPPY_DIFFICULTY_ROUTING_INTEGRATION=1
 *   HAPPY_DIFFICULTY_ROUTING_MODEL_DIR=<고정 해시가 검증되는 아티팩트 디렉터리>
 * 모델은 1.1GB 라 기본 스위트에서 돌리지 않는다. 다운로드하지 않으며, 디렉터리가 해시와
 * 다르면 worker 가 `artifact-integrity` 로 죽는다.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import tweetnacl from 'tweetnacl'
import { afterAll, describe, expect, it } from 'vitest'

import {
  DifficultyRoutingClassifierHost,
  createDifficultyRoutingHostKey,
  type DifficultyRoutingRelayRequestV2,
} from './difficultyRoutingClassifierHost'

const modelDir = process.env.HAPPY_DIFFICULTY_ROUTING_MODEL_DIR
const entry = resolve(process.cwd(), 'dist/index.mjs')
const requested = process.env.HAPPY_DIFFICULTY_ROUTING_INTEGRATION === '1'
// 켜 달라고 명시했는데 준비물이 없으면 **조용히 건너뛰지 않는다.** 모델 경로 오타나
// `pnpm run build` 누락, 혹은 cwd 가 packages/happy-cli 가 아닌 경우가 여기 걸린다.
// skip 으로 흘려보내면 "실제 worker 로 검증했다"는 초록을 받고도 아무것도 돌지 않는다.
if (requested && !modelDir) {
  throw new Error('HAPPY_DIFFICULTY_ROUTING_INTEGRATION=1 requires HAPPY_DIFFICULTY_ROUTING_MODEL_DIR')
}
if (requested && !existsSync(entry)) {
  throw new Error(`worker entry not found at ${entry} — run pnpm --filter @buzzni/happy-cli build from packages/happy-cli`)
}
const enabled = requested

// 이 suite 는 하나의 host 수명주기를 공유한다 — 첫 테스트가 켜서 모델을 올리고(1.1GB 라
// 테스트마다 다시 올릴 수 없다) 마지막 테스트가 끈다. 따라서 **선언 순서대로** 돌아야 한다.
// vitest 는 파일 안에서 순차 실행이고 이 저장소는 shuffle 을 쓰지 않는다.
describe.skipIf(!enabled)('difficulty routing sealed relay with the real worker', () => {
  const hostKey = createDifficultyRoutingHostKey()
  const host = new DifficultyRoutingClassifierHost(hostKey, {
    authorize: async () => true,
    // 실제 worker 엔트리를 그대로 띄운다. 기본 spawn 은 `process.argv[1]` 을 happy 엔트리로
    // 보는데 vitest 안에서는 그게 vitest 바이너리라 여기서만 경로를 준다. 프로세스·모델·
    // 아티팩트 검증은 전부 실제 코드다.
    spawnWorker: () => spawn(process.execPath, [entry, 'difficulty-routing-worker'], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: '/nonexistent', NODE_ENV: 'production', HAPPY_DIFFICULTY_ROUTING_MODEL_DIR: modelDir },
    }),
  })

  afterAll(() => { host.setEnabled(false) })

  const seal = (text: string) => {
    const nonce = tweetnacl.randomBytes(tweetnacl.box.nonceLength)
    const ephemeral = tweetnacl.box.keyPair()
    const ciphertext = tweetnacl.box(new TextEncoder().encode(text), nonce, hostKey.publicKey, ephemeral.secretKey)
    return {
      alg: 'x25519-xsalsa20-poly1305' as const,
      nonce: Buffer.from(nonce).toString('base64'),
      ephemeralPublicKey: Buffer.from(ephemeral.publicKey).toString('base64'),
      ciphertext: Buffer.from(ciphertext).toString('base64'),
    }
  }

  const request = (text: string, overrides: Partial<DifficultyRoutingRelayRequestV2> = {}): DifficultyRoutingRelayRequestV2 => ({
    version: 1,
    requestId: randomUUID(),
    signedGrant: `grant-${randomUUID()}`,
    policyRevision: 1,
    sourceMachineId: 'machine-source',
    hostMachineId: 'machine-host',
    hostProcessKeyId: hostKey.id,
    timingVersion: 2, remainingMs: 3000,
    sealedText: seal(text),
    ...overrides,
  })

  it('loads the pinned artifacts and reports the host capability as ready', async () => {
    expect(host.capability()).toMatchObject({ hostProcessKeyId: hostKey.id, ready: false })
    host.setEnabled(true)
    const deadline = Date.now() + 180_000
    while (!host.capability().ready && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250))
    expect(host.capability().ready).toBe(true)
  }, 200_000)

  it('opens the sealed text in the worker and answers with a real classification', async () => {
    const response = await host.classify(request('이 저장소의 인증 모듈을 리팩터링하고 세션 만료 정책을 다시 설계해줘'))
    expect(response.status).toBe('ok')
    expect(['trivial', 'routine', 'hard']).toContain(response.difficulty)
    // 계약: 응답은 난이도와 비내용 메타데이터만 싣는다 (R7/R14).
    expect(response.classifierRevision).toMatch(/^artifact-sha256:444c99b6f4d417e50859f73e1557db11943a2ad073ce4050a65f1b7d39403038:/)
    expect(JSON.stringify(response)).not.toContain('리팩터링')
    expect(response.elapsedMs).toBeGreaterThanOrEqual(0)
  }, 30_000)

  it('separates an easy request from a hard one through the real model', async () => {
    const easy = await host.classify(request('오타 하나만 고쳐줘'))
    const hard = await host.classify(request('분산 트랜잭션 정합성이 깨지는 원인을 찾아 아키텍처를 다시 설계하고 마이그레이션 계획까지 세워줘'))
    expect(easy.status).toBe('ok')
    expect(hard.status).toBe('ok')
    // 이 모델은 이진 분류라 hard/routine 으로만 매핑된다(R7). 어려운 쪽이 쉬운 쪽보다
    // 낮은 난이도로 나오면 안 된다.
    const rank = { trivial: 0, routine: 1, hard: 2 } as const
    expect(rank[hard.difficulty as keyof typeof rank]).toBeGreaterThanOrEqual(rank[easy.difficulty as keyof typeof rank])
  }, 30_000)

  it('refuses a grant that is replayed with the same signature', async () => {
    const first = request('같은 grant 를 두 번 쓰는 요청')
    expect((await host.classify(first)).status).toBe('ok')
    const replayed = { ...first, requestId: randomUUID(), sealedText: seal('같은 grant 를 두 번 쓰는 요청'), remainingMs: 3000 }
    expect((await host.classify(replayed)).status).toBe('revoked')
  }, 30_000)

  it('rejects text sealed to a different host key without reaching the model', async () => {
    const other = tweetnacl.box.keyPair()
    const nonce = tweetnacl.randomBytes(tweetnacl.box.nonceLength)
    const ephemeral = tweetnacl.box.keyPair()
    const ciphertext = tweetnacl.box(new TextEncoder().encode('다른 호스트 키로 봉인'), nonce, other.publicKey, ephemeral.secretKey)
    const response = await host.classify(request('unused', {
      sealedText: {
        alg: 'x25519-xsalsa20-poly1305',
        nonce: Buffer.from(nonce).toString('base64'),
        ephemeralPublicKey: Buffer.from(ephemeral.publicKey).toString('base64'),
        ciphertext: Buffer.from(ciphertext).toString('base64'),
      },
    }))
    expect(response.status).toBe('error')
    expect(response.difficulty).toBeUndefined()
  }, 30_000)

  // R7 은 8,000자 초과 거부를 요구한다. 상한은 **복호화한 뒤** 평문 길이로 적용되므로
  // (암호문 길이 검사와 별개다) 실제 복호화를 타는 이 스위트에서만 확인된다.
  //
  // 주의: 거절이 host 와 worker 양쪽에 있어 응답만으로는 어느 쪽이 막았는지 구분할 수 없다.
  // 그래서 "모델에 닿지 않는다" 같은 확인 불가능한 주장은 하지 않는다. 경계 양쪽을 고정하는
  // 것으로 충분하며, teeth 는 두 겹을 모두 푸는 변이로 확인했다.
  it('accepts a prompt of exactly the 8,000 character limit (R7)', async () => {
    const response = await host.classify(request('a'.repeat(8000)))
    expect(response.status).toBe('ok')
    expect(['trivial', 'routine', 'hard']).toContain(response.difficulty)
  }, 30_000)

  it('refuses one character past the limit (R7)', async () => {
    const response = await host.classify(request('a'.repeat(8001)))
    expect(response.status).toBe('error')
    expect(response.difficulty).toBeUndefined()
  }, 30_000)

  // 거절 경로가 큐 회계(admittedBytes)를 되돌리지 않으면 거절만 반복해도 호스트가 누적
  // 입력 상한(256KiB)에 걸려 영구 'busy' 로 굳는다. 8,001자 요청의 암호문이 약 10.7KiB 라
  // 25회쯤에서 상한을 넘으므로, **상한을 확실히 넘기는 30회**를 돌려야 누수가 드러난다.
  // 몇 번만 돌리면 누수가 있어도 초록이다 — 실제로 3회로 썼다가 변이 검사에서 잡혔다.
  it('keeps serving normal requests after repeated oversize rejections', async () => {
    for (let i = 0; i < 30; i += 1) {
      const rejected = await host.classify(request('a'.repeat(8001)))
      expect(rejected.status).toBe('error')
    }
    expect((await host.classify(request('간단한 오타 수정'))).status).toBe('ok')
  }, 120_000)

  it('stops answering once the organization policy is turned off', async () => {
    host.setEnabled(false)
    expect((await host.classify(request('OFF 이후 요청'))).status).toBe('revoked')
    expect(host.capability().ready).toBe(false)
  }, 30_000)
})
