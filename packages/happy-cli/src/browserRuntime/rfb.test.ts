import { describe, expect, it } from 'vitest'
import { ENCODING, RFB_VERSION, RfbProtocolError, StreamFramer, clientParser, keyEvent, pointerEvent, serverMessages, setEncodingsMessage,
    upstreamParser, vncAuthResponse, type ClientMessage, type RfbSession } from './rfb'

/** Deterministic PRNG so a failing split is reproducible from its seed. */
function prng(seed: number): () => number {
    let state = seed >>> 0
    return () => {
        state = (state + 0x6d2b79f5) >>> 0
        let t = state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}
/** Splits bytes at random points, including empty and single-byte pieces. */
function randomSplit(bytes: Buffer, random: () => number): Buffer[] {
    const pieces: Buffer[] = []
    for (let offset = 0; offset < bytes.length;) {
        const size = random() < 0.1 ? 0 : 1 + Math.floor(random() * Math.min(97, bytes.length - offset))
        pieces.push(bytes.subarray(offset, offset + size))
        offset += size
    }
    return pieces
}
const u16 = (value: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b }
const u32 = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b }
const s32 = (value: number) => { const b = Buffer.alloc(4); b.writeInt32BE(value); return b }
const rect = (x: number, y: number, w: number, h: number, encoding: number) => Buffer.concat([u16(x), u16(y), u16(w), u16(h), s32(encoding)])
const PIXEL_FORMAT_32 = Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0])

function session(overrides: Partial<RfbSession> = {}): RfbSession {
    return { width: 64, height: 48, bytesPerPixel: 4, encodings: new Set([ENCODING.copyRect, ENCODING.hextile, ENCODING.zrle, ENCODING.desktopSize, ENCODING.cursor]), ...overrides }
}

/** A server stream using every framed message kind. */
function serverStream(): Buffer {
    const hextileTiles = Buffer.concat([
        Buffer.from([1]), Buffer.alloc(16 * 16 * 4, 7), // raw tile
        Buffer.from([2 | 8]), Buffer.alloc(4, 1), Buffer.from([2]), Buffer.alloc(2 * 2, 3), // background + 2 plain subrects
        Buffer.from([4 | 8 | 16]), Buffer.alloc(4, 2), Buffer.from([1]), Buffer.alloc(4 + 2, 5), // foreground + 1 coloured subrect
        Buffer.from([0]), // same background
    ])
    return Buffer.concat([
        Buffer.from([0, 0]), u16(6),
        rect(0, 0, 4, 2, ENCODING.raw), Buffer.alloc(4 * 2 * 4, 9),
        rect(8, 8, 10, 10, ENCODING.copyRect), u16(0), u16(0),
        rect(0, 0, 32, 32, ENCODING.hextile), hextileTiles,
        rect(0, 0, 8, 8, ENCODING.zrle), u32(5), Buffer.from('zzzzz'),
        rect(1, 1, 3, 2, ENCODING.cursor), Buffer.alloc(3 * 2 * 4 + 1 * 2, 4),
        rect(0, 0, 80, 60, ENCODING.desktopSize),
        Buffer.from([2]), // Bell
        Buffer.from([3, 0, 0, 0]), u32(5), Buffer.from('clip!'),
        Buffer.from([1, 0]), u16(0), u16(2), Buffer.alloc(12, 1), // SetColourMapEntries
        Buffer.from([0, 0]), u16(1), rect(70, 50, 10, 10, ENCODING.raw), Buffer.alloc(10 * 10 * 4), // inside the resized desktop
    ])
}

describe('StreamFramer + server message framing', () => {
    it('forwards a valid server stream byte-exact under 200 random fragmentations', () => {
        const stream = serverStream()
        for (let seed = 1; seed <= 200; seed++) {
            const out: Buffer[] = []
            const framer = new StreamFramer(serverMessages(session()), (bytes) => out.push(Buffer.from(bytes)), 1 << 20)
            for (const piece of randomSplit(stream, prng(seed))) framer.push(piece)
            expect(Buffer.concat(out).equals(stream), `seed ${seed}`).toBe(true)
        }
    })

    it('refuses rectangles outside the framebuffer, unrequested encodings and unknown messages without forwarding them', () => {
        const refuse = (bytes: Buffer, s = session()) => {
            const out: Buffer[] = []
            const framer = new StreamFramer(serverMessages(s), (b) => out.push(Buffer.from(b)), 1 << 20)
            expect(() => framer.push(bytes)).toThrowError(RfbProtocolError)
            return Buffer.concat(out)
        }
        const header = Buffer.concat([Buffer.from([0, 0]), u16(1)])
        expect(refuse(Buffer.concat([header, rect(60, 0, 8, 1, ENCODING.raw)]))).toEqual(header)
        expect(refuse(Buffer.concat([header, rect(0, 0, 1, 1, 7 /* tight */)]))).toEqual(header)
        expect(refuse(Buffer.concat([header, rect(0, 0, 1, 1, ENCODING.hextile)]), session({ encodings: new Set() }))).toEqual(header)
        expect(refuse(Buffer.concat([header, rect(0, 0, 8, 8, ENCODING.zrle), u32(1 << 20)]))).toEqual(Buffer.concat([header, rect(0, 0, 8, 8, ENCODING.zrle)]))
        expect(refuse(Buffer.concat([header, rect(0, 0, 32, 32, ENCODING.hextile), Buffer.from([64])]))).toHaveLength(16)
        expect(refuse(Buffer.from([3, 0, 0, 0, 0x7f, 0, 0, 0]))).toEqual(Buffer.from([3]))
        expect(refuse(Buffer.from([150]))).toHaveLength(0)
    })
})

describe('client message parsing', () => {
    const handshake = () => Buffer.concat([Buffer.from(RFB_VERSION, 'latin1'), Buffer.from([1]), Buffer.from([0])])
    function run(bytes: Buffer, split?: () => number) {
        const sent: Buffer[] = []
        const messages: ClientMessage[] = []
        const framer = new StreamFramer(clientParser({ send: (b) => sent.push(Buffer.from(b)), serverInit: () => Buffer.from('INIT'), onMessage: (m) => messages.push(m) }),
            () => undefined, 128 * 1024)
        for (const piece of split ? randomSplit(bytes, split) : [bytes]) framer.push(piece)
        return { sent: Buffer.concat(sent), messages }
    }

    it('answers the RFB 3.8 handshake with security type None and sends the ServerInit it is given', () => {
        const { sent } = run(handshake())
        expect(sent).toEqual(Buffer.concat([Buffer.from(RFB_VERSION, 'latin1'), Buffer.from([1, 1]), u32(0), Buffer.from('INIT')]))
        expect(() => run(Buffer.from('RFB 003.003\n'))).toThrowError(RfbProtocolError)
        expect(() => run(Buffer.concat([Buffer.from(RFB_VERSION, 'latin1'), Buffer.from([2])]))).toThrowError(RfbProtocolError)
    })

    it('parses every allowed message identically under random fragmentation and coalescing', () => {
        const stream = Buffer.concat([
            handshake(),
            Buffer.from([0, 0, 0, 0]), PIXEL_FORMAT_32,
            Buffer.from([2, 0]), u16(3), s32(7), s32(ENCODING.hextile), s32(ENCODING.raw),
            Buffer.from([3, 1]), u16(0), u16(0), u16(64), u16(48),
            keyEvent(true, 0x61), pointerEvent(1, 10, 20),
            Buffer.from([6, 0, 0, 0]), u32(3), Buffer.from('abc'),
        ])
        const expected = run(stream).messages
        expect(expected.map((m) => m.kind)).toEqual(['setPixelFormat', 'setEncodings', 'framebufferUpdateRequest', 'key', 'pointer', 'cutText'])
        expect(expected[1]).toMatchObject({ encodings: [7, ENCODING.hextile, ENCODING.raw] })
        expect(expected[3]).toMatchObject({ down: true, keysym: 0x61 })
        expect(expected[4]).toMatchObject({ buttonMask: 1, x: 10, y: 20 })
        for (let seed = 1; seed <= 100; seed++) expect(run(stream, prng(seed)).messages, `seed ${seed}`).toEqual(expected)
    })

    it('closes on more than 64 encodings, oversized cut text, a bad pixel format and unknown message types', () => {
        expect(() => run(Buffer.concat([handshake(), Buffer.from([2, 0]), u16(65)]))).toThrowError(RfbProtocolError)
        expect(() => run(Buffer.concat([handshake(), Buffer.from([6, 0, 0, 0]), u32(64 * 1024 + 1)]))).toThrowError(RfbProtocolError)
        expect(() => run(Buffer.concat([handshake(), Buffer.from([0, 0, 0, 0]), Buffer.from([24]), Buffer.alloc(15)]))).toThrowError(RfbProtocolError)
        for (const type of [1, 7, 150, 248, 250, 251, 255]) expect(() => run(Buffer.concat([handshake(), Buffer.from([type])])), `type ${type}`).toThrowError(RfbProtocolError)
    })

    it('refuses a peer that runs too far ahead of a bounded read', () => {
        const sent: Buffer[] = []
        const framer = new StreamFramer(clientParser({ send: (b) => sent.push(b), serverInit: () => Buffer.alloc(0), onMessage: () => undefined }), () => undefined, 1024)
        framer.push(handshake())
        expect(() => framer.push(Buffer.concat([Buffer.from([6, 0, 0, 0]), u32(2000), Buffer.alloc(1500)]))).toThrowError(RfbProtocolError)
    })
})

describe('upstream (x11vnc) handshake', () => {
    it('authenticates with VNC authentication, asks for a shared session and then frames server messages', () => {
        const sent: Buffer[] = []
        const inits: unknown[] = []
        const s = session({ width: 0, height: 0, bytesPerPixel: 0 })
        const forwarded: Buffer[] = []
        const framer = new StreamFramer(upstreamParser(s, { password: 'synthpw1', send: (b) => sent.push(Buffer.from(b)), onServerInit: (init) => inits.push(init) }),
            (b) => forwarded.push(Buffer.from(b)), 1 << 20)
        const challenge = Buffer.alloc(16, 0x5a)
        const name = Buffer.from('browser-a:99')
        framer.push(Buffer.concat([Buffer.from(RFB_VERSION, 'latin1'), Buffer.from([2, 1, 2]), challenge, u32(0),
            u16(1280), u16(900), PIXEL_FORMAT_32, u32(name.length), name, Buffer.from([2])]))
        expect(sent).toEqual([Buffer.from(RFB_VERSION, 'latin1'), Buffer.from([2]), vncAuthResponse('synthpw1', challenge), Buffer.from([1])])
        expect(inits).toEqual([{ width: 1280, height: 900, pixelFormat: PIXEL_FORMAT_32 }])
        expect([s.width, s.height, s.bytesPerPixel]).toEqual([1280, 900, 4])
        // The handshake never reaches the viewer; the Bell after it does.
        expect(Buffer.concat(forwarded)).toEqual(Buffer.from([2]))
    })

    it('refuses an upstream without VNC authentication or that rejects the password', () => {
        const start = (bytes: Buffer) => new StreamFramer(upstreamParser(session(), { password: 'x', send: () => undefined, onServerInit: () => undefined }), () => undefined, 1 << 20).push(bytes)
        expect(() => start(Buffer.concat([Buffer.from(RFB_VERSION, 'latin1'), Buffer.from([1, 1])]))).toThrowError(RfbProtocolError)
        expect(() => start(Buffer.concat([Buffer.from(RFB_VERSION, 'latin1'), Buffer.from([1, 2]), Buffer.alloc(16), u32(1)]))).toThrowError(RfbProtocolError)
        expect(() => start(Buffer.from('RFB 003.003\n'))).toThrowError(RfbProtocolError)
    })

    it('derives the VNC DES key from the bit-reversed password', () => {
        expect(vncAuthResponse('password', Buffer.alloc(16)).toString('hex')).toBe(REFERENCE_PASSWORD_ZERO_CHALLENGE)
    })

    it('encodes SetEncodings for the upstream', () => {
        expect(setEncodingsMessage([ENCODING.hextile, ENCODING.desktopSize])).toEqual(Buffer.concat([Buffer.from([2, 0]), u16(2), s32(5), s32(-223)]))
    })
})

// Computed independently: single DES (LibreSSL des-ecb) with key 0e86ceceeef64e26 = bit-reversed "password".
const REFERENCE_PASSWORD_ZERO_CHALLENGE = 'ff97502e9422f089ff97502e9422f089'
