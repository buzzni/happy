import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { macGuardianChannel } from './macGuardianChannel'
const owner = { bootId: 'boot', pid: 1234, pidStartTime: '1000' }
async function fixture() {
    const input = new PassThrough(), output = new PassThrough()
    let exit!: () => void
    const exited = new Promise<void>(resolve => { exit = resolve })
    const channel = macGuardianChannel(input, output, exited, 471, 50)
    output.write('{"version":1,"pid":1234,"uid":471}\n')
    expect(await channel.launch).toBe(1234)
    return { input, output, channel, exit }
}
it('requires a fresh matching challenge for every root-owned process observation', async () => {
    const h = await fixture(), nonces: string[] = []
    h.input.on('data', chunk => {
        const nonce = chunk.toString().trim(); nonces.push(nonce)
        h.output.write(JSON.stringify({ version: 1, nonce, pid: owner.pid, uid: 471, startedAt: '1000' }) + '\n')
    })
    try {
        expect(await h.channel.probe(owner)).toEqual({ owner, identity: '471' })
        expect(await h.channel.probe(owner)).toEqual({ owner, identity: '471' })
        expect(new Set(nonces).size).toBe(2)
    } finally { h.exit() }
})
it.each(['nonce', 'pid', 'uid', 'extra', 'oversized', 'exit', 'timeout'])('rejects %s and never resumes a failed guardian channel', async kind => {
    const h = await fixture()
    h.input.on('data', chunk => {
        const row = { version: 1, nonce: chunk.toString().trim(), pid: owner.pid, uid: 471, startedAt: '1000' } as Record<string, unknown>
        if (kind === 'timeout') return
        if (kind === 'exit') { h.exit(); return }
        if (kind === 'oversized') { h.output.write('x'.repeat(1025)); return }
        if (kind === 'nonce') row.nonce = 'a'.repeat(64)
        if (kind === 'pid') row.pid = 1235
        if (kind === 'uid') row.uid = 472
        if (kind === 'extra') row.extra = true
        h.output.write(JSON.stringify(row) + '\n')
    })
    try {
        await expect(h.channel.probe(owner)).rejects.toThrow('NATIVE_GUARDIAN_UNAVAILABLE')
        await expect(h.channel.probe(owner)).rejects.toThrow('NATIVE_GUARDIAN_UNAVAILABLE')
    } finally { h.exit() }
})
