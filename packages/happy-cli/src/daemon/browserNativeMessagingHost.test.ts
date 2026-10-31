import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { decodeNativeMessage, encodeNativeMessage } from './browserNativeMessaging'
import { runBrowserNativeMessagingHost } from './browserNativeMessagingHost'

describe('runBrowserNativeMessagingHost', () => {
    it('delivers scoped setup through native framing without reading or printing the base token', async () => {
        const output: Buffer[] = []
        const operationId = 'a'.repeat(32)
        await runBrowserNativeMessagingHost({
            input: Readable.from([encodeNativeMessage({ type: 'setup-pair', operationId })]),
            write: chunk => output.push(chunk), writeError: () => {},
            readToken: async () => { throw new Error('must not read legacy token') },
            port: 41777, host: '127.0.0.1', consumeSetup: async id => ({ ok: true, config: { pairingId: id, token: 'scoped' } }),
        })
        expect(decodeNativeMessage(output[0])).toEqual({ ok: true, config: { pairingId: operationId, token: 'scoped' } })
    })
    it.each([
        ['an offer', { type: 'connect-offer' }, { ok: true, account: 'a@example.com' }, { ok: true, account: 'a@example.com' }],
        ['a refusal code', { type: 'connect-offer' }, { ok: false, error: 'MACHINE_NOT_ELIGIBLE' }, { ok: false, error: 'MACHINE_NOT_ELIGIBLE' }],
        ['an unknown daemon error as unavailable', { type: 'connect-offer' }, { ok: false, error: 'stack trace with secrets' }, { ok: false, error: 'SCOPE_UNAVAILABLE' }],
        ['a connection', { type: 'connect', profile: 'default-1f8b' }, { ok: true, config: { token: 'scoped' } }, { ok: true, config: { token: 'scoped' } }],
    ])('relays %s from the local daemon without reading the base token', async (_name, request, daemon, expected) => {
        const output: Buffer[] = []
        const calls: unknown[] = []
        await runBrowserNativeMessagingHost({
            input: Readable.from([encodeNativeMessage(request)]),
            write: chunk => output.push(chunk), writeError: () => {},
            readToken: async () => { throw new Error('must not read legacy token') }, port: 41777, host: '127.0.0.1',
            offerConnect: async () => { calls.push('offer'); return daemon },
            connect: async profile => { calls.push(profile); return daemon },
        })
        expect(decodeNativeMessage(output[0])).toEqual(expected)
        expect(calls).toEqual(['type' in request && request.type === 'connect' ? 'default-1f8b' : 'offer'])
    })
    it.each([
        ['no local daemon', { type: 'connect-offer' }, 'DAEMON_OFFLINE'],
        ['an invalid profile', { type: 'connect', profile: 'bad\u0000name' }, 'INVALID_PROFILE'],
        ['a missing profile', { type: 'connect' }, 'INVALID_PROFILE'],
    ])('answers %s with a code', async (_name, request, error) => {
        const output: Buffer[] = []
        let called = false
        await runBrowserNativeMessagingHost({
            input: Readable.from([encodeNativeMessage(request)]),
            write: chunk => output.push(chunk), writeError: () => {},
            readToken: async () => 'unused', port: 41777, host: '127.0.0.1',
            offerConnect: async () => { throw new Error('SETUP_UNAVAILABLE') },
            connect: async () => { called = true; return { ok: true } },
        })
        expect(decodeNativeMessage(output[0])).toEqual({ ok: false, error })
        expect(called).toBe(false)
    })
    it('keeps the executable stdout protocol-clean in dev mode', async () => {
        const testHome = await mkdtemp(join(tmpdir(), 'happy-native-host-'))

        try {
            const result = spawnSync(process.execPath, [
                join(process.cwd(), 'bin', 'happy-browser-native-host.mjs'),
            ], {
                input: encodeNativeMessage({ type: 'pair' }),
                env: {
                    ...process.env,
                    HOME: testHome,
                    HAPPY_HOME_DIR: join(testHome, 'custom-happy-home'),
                    HAPPY_VARIANT: 'dev',
                },
            })

            expect(result.status).toBe(0)
            expect(result.stderr.toString()).toBe('')
            expect(decodeNativeMessage(result.stdout)).toMatchObject({ ok: true })
            expect(result.stdout).toHaveLength(result.stdout.readUInt32LE(0) + 4)
        } finally {
            await rm(testHome, { recursive: true, force: true })
        }
    })

    it('answers after one complete frame without waiting for Chrome to close stdin', async () => {
        const input = new PassThrough()
        const output: Buffer[] = []
        input.write(encodeNativeMessage({ type: 'pair' }))

        await Promise.race([
            runBrowserNativeMessagingHost({
                input,
                write: (chunk) => output.push(chunk),
                writeError: () => {},
                readToken: async () => 'secret-token',
                port: 41777,
                host: '127.0.0.1',
            }),
            new Promise((_, reject) => setTimeout(
                () => reject(new Error('host waited for stdin EOF')),
                1_000,
            )),
        ])

        expect(decodeNativeMessage(output[0])).toMatchObject({ ok: true })
        input.destroy()
    })

    it('reads one native message and writes the local pairing response', async () => {
        const output: Buffer[] = []

        await runBrowserNativeMessagingHost({
            input: Readable.from([encodeNativeMessage({ type: 'pair' })]),
            write: (chunk) => output.push(chunk),
            writeError: () => {},
            readToken: async () => 'secret-token',
            port: 41777,
            host: '127.0.0.1',
        })

        expect(output).toHaveLength(1)
        expect(decodeNativeMessage(output[0])).toEqual({
            ok: true,
            config: { token: 'secret-token', port: 41777, host: '127.0.0.1' },
        })
    })

    it('writes only fixed diagnostics when reading the token fails', async () => {
        const output: Buffer[] = []
        const errors: string[] = []

        await runBrowserNativeMessagingHost({
            input: Readable.from([encodeNativeMessage({ type: 'pair' })]),
            write: (chunk) => output.push(chunk),
            writeError: (message) => errors.push(message),
            readToken: async () => { throw new Error('could not read must-not-leak') },
            port: 41777,
            host: '127.0.0.1',
        })

        expect(decodeNativeMessage(output[0])).toEqual({
            ok: false,
            error: '로컬 Happy 연결 정보를 읽지 못했습니다.',
        })
        expect(errors).toEqual(['Happy Browser Native Messaging host failed.\n'])
        expect(JSON.stringify({ output: output[0].toString('hex'), errors })).not.toContain('must-not-leak')
    })
})
