import { describe, expect, it } from 'vitest'

import { describeHttpFailure } from './describeHttpFailure'

// 자동화의 서버 왕복은 전부 같은 실수를 반복했다 — status 만 남기고 응답 본문의
// error 를 버려서, 서버가 여러 이유로 내는 같은 상태 코드를 운영자가 구분할 수
// 없었다. 성공 응답은 토큰을 담으므로 거절 응답에만 쓴다.
describe('describeHttpFailure', () => {
  function json(body: unknown, status = 403): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  it('names the server reason so a rejection says which check failed', async () => {
    await expect(describeHttpFailure(json({ error: 'Invalid automation claim' })))
      .resolves.toBe(': Invalid automation claim')
  })

  it('says nothing when the body carries no usable reason', async () => {
    await expect(describeHttpFailure(json({ ok: false }))).resolves.toBe('')
  })

  it('says nothing for a non-JSON body instead of dumping it', async () => {
    const html = new Response('<html>Gateway blocked</html>', {
      status: 403,
      headers: { 'Content-Type': 'text/html' },
    })

    await expect(describeHttpFailure(html)).resolves.toBe('')
  })

  it('never leaks a token a rejection response happens to carry', async () => {
    const reason = await describeHttpFailure(
      json({ error: 'nope', token: 'ghs_supersecret', repository: 'acme/app' }),
    )

    expect(reason).toBe(': nope')
    expect(reason).not.toContain('ghs_supersecret')
  })

  it('truncates an oversized reason instead of flooding the daemon log', async () => {
    await expect(describeHttpFailure(json({ error: 'x'.repeat(500) })))
      .resolves.toBe(`: ${'x'.repeat(200)}…`)
  })

  it('collapses whitespace so one rejection stays one log line', async () => {
    await expect(describeHttpFailure(json({ error: 'first line\n\n  second line' })))
      .resolves.toBe(': first line second line')
  })
})
