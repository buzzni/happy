import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_TASK_CLIENT_PATH } from './agentTaskClient'

// 2026-10-17 프로덕션 — 리뷰·테스트를 끝낸 워커 4건이 /complete 를 손으로 짜며
// 봉투(version·token·agentRunId·idempotencyKey) 없이 결과 JSON 만 보내 400
// UNSUPPORTED_VERSION 으로 거절됐다. 봉투는 이 클라이언트가 채우고 워커는 결과
// 파일만 만든다 — 모델 출력과 무관하게 봉투가 항상 들어가는지를 여기서 고정한다.

type Received = { method: string; url: string; body: Record<string, unknown> }

let server: Server
let received: Received[]
let respond: (count: number) => { status: number; body: unknown }
let controlUrl: string
let workDirectory: string

beforeEach(async () => {
  received = []
  respond = () => ({ status: 200, body: { ok: true } })
  server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => { raw += chunk })
    request.on('end', () => {
      received.push({ method: request.method ?? '', url: request.url ?? '', body: JSON.parse(raw) })
      const reply = respond(received.length)
      response.writeHead(reply.status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(reply.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  controlUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent-tasks`
  workDirectory = mkdtempSync(join(tmpdir(), 'agent-task-client-'))
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(workDirectory, { recursive: true, force: true })
})

function runClient(args: string[], env: Record<string, string | undefined> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [AGENT_TASK_CLIENT_PATH, ...args], {
      cwd: workDirectory,
      env: {
        PATH: process.env.PATH,
        APLUS_AGENT_TASK_URL: controlUrl,
        APLUS_AGENT_TASK_ID: 'task/1',
        APLUS_AGENT_TASK_RUN_ID: 'run-1',
        APLUS_AGENT_TASK_CLAIM_TOKEN: 'claim-secret',
        APLUS_AGENT_TASK_COMPLETE_TOKEN: 'complete-secret',
        ...env,
      },
      timeout: 30_000,
    }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr })
    })
  })
}

describe('happy-agent-task client', () => {
  it('wraps the result file in the version 1 envelope with the complete token', async () => {
    const result = { reviewedHeadSha: 'a'.repeat(40), verdict: 'approve', findings: [{ evidence: 'uses `$HOME` and "quotes"' }], checks: [] }
    writeFileSync(join(workDirectory, 'result.json'), JSON.stringify(result))

    const run = await runClient(['complete', 'result.json'])

    expect(run.code).toBe(0)
    expect(received).toEqual([{
      method: 'POST',
      url: '/api/agent-tasks/task%2F1/complete',
      body: { version: 1, token: 'complete-secret', agentRunId: 'run-1', idempotencyKey: 'run-1:complete', result },
    }])
    expect(run.stdout).toContain('HTTP 200')
    expect(run.stdout + run.stderr).not.toContain('complete-secret')
  })

  it('starts with the claim token', async () => {
    const run = await runClient(['start'])

    expect(run.code).toBe(0)
    expect(received).toEqual([{
      method: 'POST',
      url: '/api/agent-tasks/task%2F1/start',
      body: { version: 1, token: 'claim-secret', agentRunId: 'run-1', idempotencyKey: 'run-1:start' },
    }])
  })

  it('heartbeats with the claim token and no idempotency key', async () => {
    const run = await runClient(['heartbeat'])

    expect(run.code).toBe(0)
    expect(received[0]!.url).toBe('/api/agent-tasks/task%2F1/heartbeat')
    expect(received[0]!.body).toEqual({ version: 1, token: 'claim-secret', agentRunId: 'run-1' })
  })

  it('fails with the complete token and the given reason', async () => {
    const run = await runClient(['fail', 'install', 'failed'])

    expect(run.code).toBe(0)
    expect(received[0]!.url).toBe('/api/agent-tasks/task%2F1/fail')
    expect(received[0]!.body).toEqual({
      version: 1, token: 'complete-secret', agentRunId: 'run-1', idempotencyKey: 'run-1:fail', reason: 'install failed',
    })
  })

  it('retries 5xx with the same idempotency key', async () => {
    writeFileSync(join(workDirectory, 'result.json'), '{"verdict":"passed"}')
    respond = (count) => count === 1 ? { status: 503, body: { code: 'UNAVAILABLE' } } : { status: 200, body: { ok: true } }

    const run = await runClient(['complete', 'result.json'])

    expect(run.code).toBe(0)
    expect(received).toHaveLength(2)
    expect(received[1]!.body).toEqual(received[0]!.body)
  })

  it('does not retry 4xx and reports the status and response body', async () => {
    writeFileSync(join(workDirectory, 'result.json'), '{"verdict":"passed"}')
    respond = () => ({ status: 409, body: { code: 'TASK_NOT_RUNNING' } })

    const run = await runClient(['complete', 'result.json'])

    expect(run.code).not.toBe(0)
    expect(received).toHaveLength(1)
    expect(run.stdout + run.stderr).toContain('HTTP 409')
    expect(run.stdout + run.stderr).toContain('TASK_NOT_RUNNING')
  })

  it('refuses a result file that is not a JSON object without sending anything', async () => {
    writeFileSync(join(workDirectory, 'result.json'), '{"verdict":')

    const run = await runClient(['complete', 'result.json'])

    expect(run.code).not.toBe(0)
    expect(received).toHaveLength(0)
    expect(run.stderr).toMatch(/result\.json/)
  })

  it('names the missing capability variables without sending anything', async () => {
    const run = await runClient(['start'], { APLUS_AGENT_TASK_CLAIM_TOKEN: undefined })

    expect(run.code).not.toBe(0)
    expect(received).toHaveLength(0)
    expect(run.stderr).toContain('APLUS_AGENT_TASK_CLAIM_TOKEN')
  })
})
