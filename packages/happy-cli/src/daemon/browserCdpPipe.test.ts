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
})
