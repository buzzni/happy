import { describe, expect, it } from 'vitest'
import { encodeFrame, FrameDecoder, MAX_TERMINAL_WORKER_FRAME_BYTES, TerminalWorkerFrameError } from './frames'

describe('terminal worker frames', () => {
    it('reassembles frames split across and merged within chunks', () => {
        const bytes = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: 'é\u0000' }), encodeFrame([3])])
        const decoder = new FrameDecoder()
        const out: unknown[] = []
        for (let i = 0; i < bytes.length; i += 3) out.push(...decoder.push(bytes.subarray(i, i + 3)))
        expect(out).toEqual([{ a: 1 }, { b: 'é\u0000' }, [3]])
    })

    it('rejects a declared length over the limit before buffering it', () => {
        const header = Buffer.alloc(4)
        header.writeUInt32BE(MAX_TERMINAL_WORKER_FRAME_BYTES + 1, 0)
        expect(() => new FrameDecoder().push(header)).toThrow(TerminalWorkerFrameError)
    })

    it('rejects a frame that is not JSON', () => {
        const payload = Buffer.from('{not json', 'utf8')
        const header = Buffer.alloc(4)
        header.writeUInt32BE(payload.length, 0)
        expect(() => new FrameDecoder().push(Buffer.concat([header, payload]))).toThrow('not JSON')
    })

    it('refuses to encode a frame over the limit', () => {
        expect(() => encodeFrame('x'.repeat(MAX_TERMINAL_WORKER_FRAME_BYTES))).toThrow(TerminalWorkerFrameError)
    })
})
