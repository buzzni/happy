import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AGENT_TASK_CLIENT_SCRIPT } from './agentTaskClientScript'

type Received = { path: string; body: Record<string, unknown> }

let server: Server
let received: Received[]
let replies: Array<{ status: number; body: string }>
let workDir: string

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (error) { reject(error) }
    })
  })
}

beforeEach(async () => {
  received = []
  replies = []
  workDir = await mkdtemp(join(tmpdir(), 'agent-task-client-'))
  server = createServer((request, response) => {
    void readJson(request).then((body) => {
      received.push({ path: request.url ?? '', body })
      const reply = replies.shift() ?? { status: 200, body: '{"ok":true}' }
      response.writeHead(reply.status, { 'Content-Type': 'application/json' })
      response.end(reply.body)
    }, () => {
      received.push({ path: request.url ?? '', body: { unparseable: true } })
      response.writeHead(400)
      response.end('{"code":"AGENT_TASK_INVALID","reason":"body-not-json"}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(workDir, { recursive: true, force: true })
})

function runClient(args: string[], overrides: Record<string, string> = {}) {
  const { port } = server.address() as AddressInfo
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    // 워커가 실제로 돌리는 형태 그대로 — 스크립트 본문은 환경변수에서 온다.
    execFile('sh', ['-c', 'sh -c "$APLUS_AGENT_TASK_CLIENT" agent-task "$@"', 'outer', ...args], {
      env: {
        PATH: process.env.PATH ?? '',
        // 호스트 프록시가 127.0.0.1 요청을 가로채지 않게 한다.
        NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1',
        APLUS_AGENT_TASK_CLIENT: AGENT_TASK_CLIENT_SCRIPT,
        APLUS_AGENT_TASK_URL: `http://127.0.0.1:${port}/api/agent-tasks`,
        APLUS_AGENT_TASK_ID: 'task-1',
        APLUS_AGENT_TASK_RUN_ID: 'automation:run-1',
        APLUS_AGENT_TASK_CLAIM_TOKEN: 'claim-Secret_1',
        APLUS_AGENT_TASK_COMPLETE_TOKEN: 'complete-Secret_2',
        ...overrides,
      },
    }, (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr })
    })
  })
}

describe('AgentTask client script', () => {
  // 2026-10-17 프로덕션 — 워커 4건이 결과 JSON 만 본문으로 보내 /complete 가
  // 400 UNSUPPORTED_VERSION 으로 거절됐고, 끝낸 리뷰가 버려졌다. 봉투는 모델이
  // 아니라 이 클라이언트가 채운다.
  it('wraps the result file in the version 1 envelope with the complete token', async () => {
    const resultPath = join(workDir, 'result.json')
    const result = { reviewedHeadSha: 'a'.repeat(40), verdict: 'approve', findings: [], checks: [{ name: 'quote "$HOME" `x`', status: 'passed', details: 'a\\b' }] }
    await writeFile(resultPath, JSON.stringify(result, null, 2))

    const run = await runClient(['complete', resultPath])

    expect(run.code).toBe(0)
    expect(received).toEqual([{
      path: '/api/agent-tasks/task-1/complete',
      body: {
        version: 1,
        token: 'complete-Secret_2',
        agentRunId: 'automation:run-1',
        idempotencyKey: 'automation:run-1:complete',
        result,
      },
    }])
    expect(run.stdout).toContain('HTTP 200')
    expect(run.stdout + run.stderr).not.toContain('Secret')
  })

  it('starts and heartbeats with the claim token', async () => {
    expect((await runClient(['start'])).code).toBe(0)
    expect((await runClient(['heartbeat'])).code).toBe(0)

    expect(received.map(({ path, body }) => [path, body.version, body.token, body.idempotencyKey])).toEqual([
      ['/api/agent-tasks/task-1/start', 1, 'claim-Secret_1', 'automation:run-1:start'],
      ['/api/agent-tasks/task-1/heartbeat', 1, 'claim-Secret_1', 'automation:run-1:heartbeat'],
    ])
  })

  it('sends a fail reason as a JSON string even when it holds quotes, backslashes, and newlines', async () => {
    const run = await runClient(['fail', '설치 실패: "pnpm" \\ exit 1\n두 번째 줄\t탭'])

    expect(run.code).toBe(0)
    expect(received[0]!.path).toBe('/api/agent-tasks/task-1/fail')
    expect(received[0]!.body).toMatchObject({
      version: 1,
      token: 'complete-Secret_2',
      idempotencyKey: 'automation:run-1:fail',
      reason: '설치 실패: "pnpm" \\ exit 1 두 번째 줄 탭',
    })
  })

  // 샌드박스에 쓰기 가능한 TMPDIR 이 없어도 제출은 돼야 한다 — 임시 파일에 기대면 결과가 또 버려진다.
  it('submits without a writable temporary directory', async () => {
    const resultPath = join(workDir, 'result.json')
    await writeFile(resultPath, '{"verdict":"passed"}')

    const run = await runClient(['complete', resultPath], { TMPDIR: join(workDir, 'does-not-exist') })

    expect(run.code).toBe(0)
    expect(received[0]!.body).toMatchObject({ version: 1, result: { verdict: 'passed' } })
  })

  it('refuses to send when the result file is missing or empty', async () => {
    const emptyPath = join(workDir, 'empty.json')
    await writeFile(emptyPath, '')

    const missing = await runClient(['complete', join(workDir, 'nope.json')])
    const empty = await runClient(['complete', emptyPath])
    const noArgument = await runClient(['complete'])

    expect([missing.code, empty.code, noArgument.code]).toEqual([2, 2, 2])
    expect(received).toEqual([])
  })

  it('retries 5xx with the same idempotency key, then succeeds', async () => {
    const resultPath = join(workDir, 'result.json')
    await writeFile(resultPath, '{"verdict":"passed"}')
    replies.push({ status: 503, body: '{"code":"UNAVAILABLE"}' })

    const run = await runClient(['complete', resultPath])

    expect(run.code).toBe(0)
    expect(received).toHaveLength(2)
    expect(received[1]!.body).toEqual(received[0]!.body)
  }, 20_000)

  it('does not retry 4xx and reports the status and response body', async () => {
    const resultPath = join(workDir, 'result.json')
    await writeFile(resultPath, '{"verdict":"passed"}')
    replies.push({ status: 409, body: '{"code":"INVALID_TRANSITION"}' })

    const run = await runClient(['complete', resultPath])

    expect(run.code).toBe(1)
    expect(received).toHaveLength(1)
    expect(run.stdout).toContain('HTTP 409')
    expect(run.stdout).toContain('INVALID_TRANSITION')
  })

  it('refuses identifiers it cannot place in JSON verbatim', async () => {
    const run = await runClient(['start'], { APLUS_AGENT_TASK_CLAIM_TOKEN: 'bad"token' })

    expect(run.code).toBe(2)
    expect(run.stderr).toContain('APLUS_AGENT_TASK_CLAIM_TOKEN')
    expect(run.stderr).not.toContain('bad"token')
    expect(received).toEqual([])
  })

  it('reports a missing capability instead of sending an incomplete envelope', async () => {
    const run = await runClient(['complete', join(workDir, 'r.json')], { APLUS_AGENT_TASK_COMPLETE_TOKEN: '' })

    expect(run.code).toBe(2)
    expect(run.stderr).toContain('APLUS_AGENT_TASK_COMPLETE_TOKEN')
    expect(received).toEqual([])
  })

  // run.ts 의 spawnSession 은 env 값의 ${VAR} 를 데몬 환경으로 확장하고, 남은 ${ 가
  // 있으면 spawn 을 죽인다. 스크립트가 그 문법을 쓰면 워커가 뜨지 못한다.
  // 2026-09-12 프로덕션 — timeout 없는 제출이 stalled 연결에서 24시간 세션을 붙들었다.
  it('bounds every request with a timeout', () => {
    expect(AGENT_TASK_CLIENT_SCRIPT).toMatch(/curl [^\n]*--max-time 30/)
  })

  it('contains no ${...} expansion that the spawn environment pass would rewrite', () => {
    expect(AGENT_TASK_CLIENT_SCRIPT).not.toContain('${')
  })
})
