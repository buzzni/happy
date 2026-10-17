#!/usr/bin/env node

// AgentTask 프로토콜 클라이언트. 데몬이 AgentTask 워커 세션에 이 파일 경로를
// APLUS_AGENT_TASK_CLIENT 로, 실행할 node 를 APLUS_AGENT_TASK_NODE 로 넘긴다.
//
// 2026-10-17 프로덕션 — 리뷰·테스트를 끝낸 워커 4건이 curl 을 손으로 짜며 봉투 없이
// 결과 JSON 만 보내 /complete 가 400 UNSUPPORTED_VERSION 으로 거절됐고, 완성된 결과가
// 버려졌다. 토큰을 넣은 방식도 실행마다 달랐다. 봉투를 모델의 즉흥 구현에 맡기지 않고
// 여기서 채운다 — 워커는 결과 파일만 만든다.
//
// 이 파일은 의존성 없이 단독으로 돈다. 워커 세션은 샌드박스 안에서 happy 패키지의
// 다른 모듈을 import 할 수 있다는 보장이 없다.

import { readFileSync } from 'node:fs'

const USAGE = 'usage: happy-agent-task start | heartbeat | complete <result.json> | fail <reason>'
// 2026-09-12 프로덕션 — timeout 없는 제출이 stalled 연결에서 영원히 블록돼 세션이
// 24시간 끝나지 않았다. 매 요청에 상한을 둔다.
const REQUEST_TIMEOUT_MS = 30_000
const RETRY_DELAYS_MS = [1_000, 3_000, 10_000]
// 서버는 2,048 자를 넘는 reason 을 400 으로 거절한다.
const MAX_REASON_LENGTH = 2_000

function exitWith(message, code = 2) {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

function requireEnv(names) {
  const missing = names.filter((name) => !process.env[name])
  if (missing.length) exitWith(`happy-agent-task: missing environment variables: ${missing.join(', ')}`)
  return names.map((name) => process.env[name])
}

function readResult(path) {
  if (!path) exitWith(USAGE)
  let result
  try {
    result = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    exitWith(`happy-agent-task: cannot read result file ${path} as JSON: ${error.message}`)
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    exitWith(`happy-agent-task: result file ${path} must contain a JSON object`)
  }
  return result
}

function buildRequest(operation, args) {
  if (!['start', 'heartbeat', 'complete', 'fail'].includes(operation)) exitWith(USAGE)
  const [agentRunId] = requireEnv(['APLUS_AGENT_TASK_RUN_ID'])
  const envelope = { version: 1, agentRunId }
  if (operation === 'start' || operation === 'heartbeat') {
    const [token] = requireEnv(['APLUS_AGENT_TASK_CLAIM_TOKEN'])
    return operation === 'start'
      ? { ...envelope, token, idempotencyKey: `${agentRunId}:start` }
      : { ...envelope, token }
  }
  if (operation === 'complete') {
    const result = readResult(args[0])
    const [token] = requireEnv(['APLUS_AGENT_TASK_COMPLETE_TOKEN'])
    return { ...envelope, token, idempotencyKey: `${agentRunId}:complete`, result }
  }
  const reason = args.join(' ').trim().slice(0, MAX_REASON_LENGTH)
  if (!reason) exitWith(USAGE)
  const [token] = requireEnv(['APLUS_AGENT_TASK_COMPLETE_TOKEN'])
  return { ...envelope, token, idempotencyKey: `${agentRunId}:fail`, reason }
}

async function send(url, body) {
  // 네트워크 실패와 5xx 만 같은 idempotencyKey 로 다시 보낸다. 4xx 는 다시 보내도
  // 같은 이유로 거절되므로 상태와 응답 본문을 남기고 멈춘다.
  for (let attempt = 0; ; attempt += 1) {
    let outcome
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      outcome = { status: response.status, text: await response.text() }
    } catch (error) {
      outcome = { error: error?.name === 'TimeoutError' ? `timed out after ${REQUEST_TIMEOUT_MS}ms` : String(error?.message ?? error) }
    }
    const retryable = outcome.error !== undefined || outcome.status >= 500
    if (!retryable || attempt >= RETRY_DELAYS_MS.length) return outcome
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]))
  }
}

const [operation, ...args] = process.argv.slice(2)
const body = buildRequest(operation, args)
const [baseUrl, taskId] = requireEnv(['APLUS_AGENT_TASK_URL', 'APLUS_AGENT_TASK_ID'])
const outcome = await send(`${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(taskId)}/${operation}`, body)
if (outcome.error !== undefined) exitWith(`happy-agent-task: ${operation} request failed: ${outcome.error}`, 1)
const line = `HTTP ${outcome.status} ${outcome.text}`
if (outcome.status >= 200 && outcome.status < 300) {
  process.stdout.write(`${line}\n`)
} else {
  exitWith(line, 1)
}
