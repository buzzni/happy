import { describe, expect, it } from 'vitest'

import { createTerminalOutputBuffer } from './terminalOutputBuffer'
import { replyToTerminalResume, type TerminalReplyEvent } from './terminalResumeReply'

function reply(input: Omit<Parameters<typeof replyToTerminalResume>[0], 'sessionId' | 'seal' | 'emit'>) {
    const sent: Array<[TerminalReplyEvent, Record<string, unknown>]> = []
    const outcome = replyToTerminalResume({
        sessionId: 's1',
        seal: (plain) => `sealed(${plain})`,
        emit: (event, payload) => sent.push([event, payload]),
        ...input,
    })
    return { outcome, sent }
}

function bufferWith(...chunks: string[]) {
    const output = createTerminalOutputBuffer()
    for (const chunk of chunks) output.push(chunk)
    return output
}

describe('replyToTerminalResume', () => {
    it('replays the frames after afterSeq, sealed, in order', () => {
        const { outcome, sent } = reply({ output: bufferWith('a', 'b', 'c'), afterSeq: 1 })

        expect(outcome).toBe('replay')
        expect(sent).toEqual([
            ['terminal-frame', { sessionId: 's1', seq: 2, data: 'sealed(b)' }],
            ['terminal-frame', { sessionId: 's1', seq: 3, data: 'sealed(c)' }],
        ])
    })

    it('says nothing to a current client of a live terminal', () => {
        const { outcome, sent } = reply({ output: bufferWith('a'), afterSeq: 1 })

        expect(outcome).toBe('none')
        expect(sent).toEqual([])
    })

    it('answers a terminal it does not have with one unknown-session close', () => {
        const { outcome, sent } = reply({ output: null, afterSeq: 4 })

        expect(outcome).toBe('unknown-session')
        expect(sent).toEqual([['terminal-closed', { sessionId: 's1', reason: 'unknown-session' }]])
    })

    it('sends an ended terminal\'s exit once, after the output that is left', () => {
        const { sent } = reply({ output: bufferWith('a', 'b'), exit: { code: 3, signal: null }, afterSeq: 1 })

        expect(sent.map(([event]) => event)).toEqual(['terminal-frame', 'terminal-closed'])
        expect(sent[1]).toEqual(['terminal-closed', { sessionId: 's1', code: 3, signal: null }])
    })

    it('still tells a current client how the terminal ended', () => {
        const { outcome, sent } = reply({ output: bufferWith('a'), exit: { code: 0, signal: 15 }, afterSeq: 1 })

        expect(outcome).toBe('none')
        expect(sent).toEqual([['terminal-closed', { sessionId: 's1', code: 0, signal: 15 }]])
    })

    it('reads a missing or nonsense afterSeq as "seen nothing"', () => {
        const { sent } = reply({ output: bufferWith('a'), afterSeq: 'x' })

        expect(sent).toEqual([['terminal-frame', { sessionId: 's1', seq: 1, data: 'sealed(a)' }]])
    })
})
