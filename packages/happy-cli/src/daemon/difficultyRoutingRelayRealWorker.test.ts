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
  type DifficultyRoutingRelayRequest,
} from './difficultyRoutingClassifierHost'

const modelDir = process.env.HAPPY_DIFFICULTY_ROUTING_MODEL_DIR
const entry = resolve(process.cwd(), 'dist/index.mjs')
const enabled = process.env.HAPPY_DIFFICULTY_ROUTING_INTEGRATION === '1' && Boolean(modelDir) && existsSync(entry)

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

  const request = (text: string, overrides: Partial<DifficultyRoutingRelayRequest> = {}): DifficultyRoutingRelayRequest => ({
    version: 1,
    requestId: randomUUID(),
    signedGrant: `grant-${randomUUID()}`,
    policyRevision: 1,
    sourceMachineId: 'machine-source',
    hostMachineId: 'machine-host',
    hostProcessKeyId: hostKey.id,
    deadlineAt: Date.now() + 900,
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
    const replayed = { ...first, requestId: randomUUID(), sealedText: seal('같은 grant 를 두 번 쓰는 요청'), deadlineAt: Date.now() + 900 }
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

  it('stops answering once the organization policy is turned off', async () => {
    host.setEnabled(false)
    expect((await host.classify(request('OFF 이후 요청'))).status).toBe('revoked')
    expect(host.capability().ready).toBe(false)
  }, 30_000)
})
