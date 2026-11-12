import { createRequire } from 'node:module'
// Keep DOM globals out of the Node CLI's type universe (notably fetch/BodyInit).
const { JSDOM } = createRequire(import.meta.url)('jsdom')
import { describe, expect, it, vi } from 'vitest'
import { renderConsolePage } from './consolePage'

const host = 'https://studio.example'
function consoleDocument() {
    const parent = { postMessage: vi.fn() }
    const dom = new JSDOM(renderConsolePage({ hostOrigins: [host] }), {
        url: 'https://runtime.preview.example/console', runScripts: 'dangerously',
        beforeParse(w: any) {
            Object.defineProperty(w, 'parent', { value: parent })
            w.matchMedia = (() => ({ matches: false, addEventListener() {} })) as never
            w.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { tasks: [] } })))
        },
    })
    const send = (data: unknown, origin = host, source: unknown = parent) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data, origin, source: source as never }))
    return { dom, parent, send }
}

describe('web console scope handshake', () => {
    it('addresses readiness only to configured parent origins and acknowledges scope before authentication', async () => {
        const { dom, parent, send } = consoleDocument()
        try {
            const ready = parent.postMessage.mock.calls.find(([d]) => d.type === 'abp-console-ready')
            expect(ready?.[1]).toBe(host)
            expect(parent.postMessage.mock.calls.filter(([d]) => d.type === 'abp-console-ready').every(([, origin]) => origin === host)).toBe(true)
            const connectionId = ready?.[0].connectionId
            expect(connectionId).toEqual(expect.any(String))
            expect(dom.window.fetch).not.toHaveBeenCalled()
            send({ type: 'abp-console-scope', protocolVersion: 1, connectionId, agentSessionId: 'session-a' }, 'https://evil.example')
            expect(parent.postMessage.mock.calls.some(([d]) => d.type === 'abp-console-scoped')).toBe(false)
            send({ type: 'abp-console-scope', protocolVersion: 1, connectionId, agentSessionId: 'session-a' }, host, {})
            expect(parent.postMessage.mock.calls.some(([d]) => d.type === 'abp-console-scoped')).toBe(false)
            send({ type: 'abp-console-scope', protocolVersion: 1, connectionId, agentSessionId: 'session-a' })
            expect(parent.postMessage).toHaveBeenCalledWith({ type: 'abp-console-scoped', protocolVersion: 1, connectionId, agentSessionId: 'session-a' }, host)
            const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
            const token = `abp2.${part({ alg: 'EdDSA' })}.${part({ profileId: 'profile', principalId: 'user', viewerSessionId: 'viewer', expiresAtMs: Date.now() + 300000 })}.sig`
            const cap = { type: 'abp-capability', protocolVersion: 1, connectionId, agentSessionId: 'session-a', token, expiresAtMs: Date.now() + 300000 }
            send({ ...cap, agentSessionId: 'other' })
            expect(dom.window.fetch).not.toHaveBeenCalled()
            const calls: string[] = []
            dom.window.fetch = vi.fn(async (url: string) => {
                calls.push(String(url))
                if (String(url).includes('subscribe')) return new Promise<Response>(() => {})
                const result = String(url).includes('listTasks') ? { tasks: [
                    { taskId: 'wanted', agentSessionId: 'session-a', status: 'running', tabs: [], updatedAtMs: 1 },
                    { taskId: 'unrelated', agentSessionId: 'session-b', status: 'running', tabs: [], updatedAtMs: 1 },
                ] } : { taskId: 'wanted', agentSessionId: 'session-a', status: 'running', tabs: [], updatedAtMs: 1 }
                return new Response(JSON.stringify({ ok: true, result }))
            })
            send(cap)
            await vi.waitFor(() => expect(calls.some(url => url.includes('listTasks'))).toBe(true))
            await vi.waitFor(() => expect((dom.window.document.getElementById('taskId') as { value: string }).value).toBe('wanted'))
            expect(dom.window.document.getElementById('tasks')?.textContent).not.toContain('unrelated')

        } finally { dom.window.close() }
    })
})
