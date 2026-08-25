import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createBrowserCdpPipe } from './browserCdpPipe'

describe('createBrowserCdpPipe', () => {
    it('writes NUL-delimited commands and resolves a fragmented matching response', async () => {
        const chromeInput = new PassThrough()
        const chromeOutput = new PassThrough()
        const written: Buffer[] = []
        chromeInput.on('data', (chunk) => written.push(Buffer.from(chunk)))
        const pipe = createBrowserCdpPipe(chromeInput, chromeOutput)

        const response = pipe.request<{ id: string }>('Extensions.loadUnpacked', { path: '/extension' })

        expect(Buffer.concat(written).toString()).toBe(
            `${JSON.stringify({ id: 1, method: 'Extensions.loadUnpacked', params: { path: '/extension' } })}\0`,
        )
        chromeOutput.write('{"id":1,"res')
        chromeOutput.write('ult":{"id":"extension-id"}}\0')
        await expect(response).resolves.toEqual({ id: 'extension-id' })

        pipe.close()
    })

    it('preserves a UTF-8 error message split between stream chunks', async () => {
        const chromeInput = new PassThrough()
        const chromeOutput = new PassThrough()
        const pipe = createBrowserCdpPipe(chromeInput, chromeOutput)
        const response = pipe.request('Extensions.loadUnpacked')
        const frame = Buffer.from(`${JSON.stringify({ id: 1, error: { message: '확장 실패' } })}\0`)
        const splitAt = frame.indexOf(Buffer.from('확')) + 1

        chromeOutput.write(frame.subarray(0, splitAt))
        chromeOutput.write(frame.subarray(splitAt))

        await expect(response).rejects.toThrow('확장 실패')
        pipe.close()
    })

    it('rejects a pending request as soon as Chrome ends the output pipe', async () => {
        const chromeInput = new PassThrough()
        const chromeOutput = new PassThrough()
        const pipe = createBrowserCdpPipe(chromeInput, chromeOutput)
        const result = pipe.request('Extensions.loadUnpacked').then(
            () => 'resolved',
            (error: Error) => error.message,
        )

        chromeOutput.emit('end')

        await expect(Promise.race([
            result,
            new Promise((resolve) => setImmediate(() => resolve('still pending'))),
        ])).resolves.toBe('Chrome CDP pipe closed')
        expect(chromeInput.destroyed).toBe(true)
        pipe.close()
    })
})
