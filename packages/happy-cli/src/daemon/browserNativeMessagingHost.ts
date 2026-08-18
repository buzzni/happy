import {
    createNativePairingResponse,
    decodeNativeMessage,
    encodeNativeMessage,
    nativeHostFailureResponse,
} from './browserNativeMessaging'

const NATIVE_MESSAGE_HEADER_BYTES = 4
const MAX_NATIVE_EXTENSION_MESSAGE_BYTES = 64 * 1024 * 1024

export async function runBrowserNativeMessagingHost({
    input,
    write,
    writeError,
    readToken,
    port,
    host,
}: {
    input: AsyncIterable<Uint8Array>
    write: (chunk: Buffer) => void
    writeError: (message: string) => void
    readToken: () => Promise<string>
    port: number
    host: string
}): Promise<void> {
    try {
        const request = decodeNativeMessage(await readNativeMessageFrame(input))
        const token = await readToken()
        const response = createNativePairingResponse({ request, token, port, host })
        write(encodeNativeMessage(response))
    } catch (error) {
        writeError('Happy Browser Native Messaging host failed.\n')
        write(encodeNativeMessage(nativeHostFailureResponse(error)))
    }
}

async function readNativeMessageFrame(input: AsyncIterable<Uint8Array>): Promise<Buffer> {
    const iterator = input[Symbol.asyncIterator]()
    let buffered = Buffer.alloc(0)
    let frameLength: number | null = null

    try {
        while (frameLength === null || buffered.byteLength < frameLength) {
            const next = await iterator.next()
            if (next.done) throw new Error('Native message ended before its declared length')
            buffered = Buffer.concat([buffered, Buffer.from(next.value)])

            if (frameLength === null && buffered.byteLength >= NATIVE_MESSAGE_HEADER_BYTES) {
                const payloadLength = buffered.readUInt32LE(0)
                if (payloadLength > MAX_NATIVE_EXTENSION_MESSAGE_BYTES) {
                    throw new Error('Native message exceeds the 64 MiB extension request limit')
                }
                frameLength = NATIVE_MESSAGE_HEADER_BYTES + payloadLength
            }
        }
        return buffered.subarray(0, frameLength)
    } finally {
        await iterator.return?.()
    }
}
