import { afterEach, describe, expect, it, vi } from 'vitest'

import { createTerminalOutputBuffer } from './terminalOutputBuffer'
import { PAGED_RESUME_STALE_MS, pagedReplayInFlight, replyToTerminalResume, resetPagedResume, sendExitAfterReplay, type TerminalReplyEvent } from './terminalResumeReply'

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

    it('says the daemon restart ended it when the exit rides a resume answer (R23)', () => {
        const { sent } = reply({ output: bufferWith('a'), exit: { code: 0, signal: 1 }, closeReason: 'daemon-restart', afterSeq: 1 })

        expect(sent).toEqual([['terminal-closed', { sessionId: 's1', code: 0, signal: 1, reason: 'daemon-restart' }]])
    })

    it('reads a missing or nonsense afterSeq as "seen nothing"', () => {
        const { sent } = reply({ output: bufferWith('a'), afterSeq: 'x' })

        expect(sent).toEqual([['terminal-frame', { sessionId: 's1', seq: 1, data: 'sealed(a)' }]])
    })
})

/*
 * Cross review #2: the live close path must not end a terminal in the middle
 * of a replay the client is still reading. Paged replay (B-R3) supplies the
 * real in-flight check; here a stand-in plays that part.
 */
describe('sendExitAfterReplay', () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    it('sends the exit at once when no replay is in flight', () => {
        const sendClosed = vi.fn()

        expect(sendExitAfterReplay({ output: bufferWith('a'), sendClosed })).toBe('sent')
        expect(sendClosed).toHaveBeenCalledTimes(1)
    })

    it('holds the exit behind a replay in flight and lets the last answer carry it, once', () => {
        vi.useFakeTimers()
        const output = bufferWith('a', 'b')
        const sendClosed = vi.fn()

        expect(sendExitAfterReplay({ output, sendClosed, inFlight: () => true })).toBe('held')
        expect(sendClosed).not.toHaveBeenCalled()

        const { sent } = reply({ output, exit: { code: 3, signal: null }, afterSeq: 1 })
        expect(sent.map(([event]) => event)).toEqual(['terminal-frame', 'terminal-closed'])

        vi.advanceTimersByTime(PAGED_RESUME_STALE_MS)
        expect(sendClosed).not.toHaveBeenCalled()
    })

    it('sends a held exit once the client stops asking for pages', () => {
        vi.useFakeTimers()
        const sendClosed = vi.fn()

        sendExitAfterReplay({ output: bufferWith('a'), sendClosed, inFlight: () => true })
        vi.advanceTimersByTime(PAGED_RESUME_STALE_MS - 1)
        expect(sendClosed).not.toHaveBeenCalled()
        vi.advanceTimersByTime(1)
        expect(sendClosed).toHaveBeenCalledTimes(1)
        vi.advanceTimersByTime(PAGED_RESUME_STALE_MS)
        expect(sendClosed).toHaveBeenCalledTimes(1)
    })
})

type Sent = { event: string; payload: Record<string, any> }

function harness(frames: number, size = 4_000, exit: { code: number; signal: number | null } | null = null) {
    const output = createTerminalOutputBuffer()
    for (let i = 0; i < frames; i++) output.push(String(i % 10).repeat(size))
    const sent: Sent[] = []
    let clock = 1_000
    const reply = (afterSeq: unknown, maxChars?: unknown, requester?: string) => replyToTerminalResume({
        sessionId: 's1',
        output,
        exit,
        afterSeq,
        maxChars,
        requester,
        seal: (plain) => `sealed:${plain}`,
        emit: (event, payload) => sent.push({ event, payload }),
        now: () => clock,
    })
    return { output, sent, reply, tick: (ms: number) => { clock += ms } }
}

const frameSeqs = (sent: Sent[]) => sent.filter((s) => s.event === 'terminal-frame').map((s) => s.payload.seq)

describe('replyToTerminalResume paging (B-R3)', () => {
    it('answers a legacy resume (no maxChars) with every frame and no paging fields', () => {
        const h = harness(3, 10)
        expect(h.reply(0)).toBe('replay')
        expect(frameSeqs(h.sent)).toEqual([1, 2, 3])
        expect(h.sent.every((s) => !('more' in s.payload) && !('nextSeq' in s.payload))).toBe(true)
        expect(h.sent[0].payload).toEqual({ sessionId: 's1', seq: 1, data: 'sealed:' + '0'.repeat(10) })
    })

    it('marks only the last frame of a page with more/nextSeq', () => {
        const h = harness(250)
        h.reply(0, 262_144)
        const frames = h.sent.filter((s) => s.event === 'terminal-frame')
        const last = frames[frames.length - 1].payload
        expect(last.more).toBe(true)
        expect(last.nextSeq).toBe(last.seq)
        expect(frames.slice(0, -1).every((s) => !('more' in s.payload))).toBe(true)
    })

    // B3.1c [리뷰 #4] — several resumes for the same position while a paged
    // replay is under way must not each start their own replay.
    it('merges overlapping resumes into one copy of the replay', () => {
        const h = harness(250) // 1M chars → 4 pages
        h.reply(0, 262_144)
        for (let i = 0; i < 5; i++) expect(h.reply(0, 262_144)).toBe('merged')
        // The client keeps asking for the next page from where the last one ended.
        for (let guard = 0; guard < 10; guard++) {
            const frames = h.sent.filter((s) => s.event === 'terminal-frame')
            const last = frames[frames.length - 1].payload
            if (!last.more) break
            expect(h.reply(0, 262_144)).toBe('merged') // a duplicate between pages is merged too
            h.reply(last.nextSeq, 262_144)
        }
        expect(frameSeqs(h.sent)).toEqual(Array.from({ length: 250 }, (_, i) => i + 1))
    })

    it('starts a fresh replay once the paged one finished', () => {
        const h = harness(2, 10)
        h.reply(0, 262_144) // single page, more:false
        expect(h.reply(0, 262_144)).toBe('replay')
        expect(frameSeqs(h.sent)).toEqual([1, 2, 1, 2])
    })

    it('stops merging once a paged replay went quiet for the stale window', () => {
        const h = harness(250)
        h.reply(0, 262_144)
        h.tick(PAGED_RESUME_STALE_MS)
        expect(h.reply(0, 262_144)).toBe('replay')
    })

    it('forgets the cursor when the binding is reset (a new connection attached)', () => {
        const h = harness(250)
        h.reply(0, 262_144)
        resetPagedResume(h.output)
        expect(h.reply(0, 262_144)).toBe('replay')
    })

    // The relay path has no attach: a client that reconnected is only told
    // apart by the socket its resume came from.
    it('answers a paged resume from another client socket afresh instead of merging it', () => {
        const h = harness(250)
        h.reply(0, 262_144, 'socket-a')
        const firstPage = frameSeqs(h.sent).length
        expect(h.reply(0, 262_144, 'socket-a')).toBe('merged')
        expect(h.reply(0, 262_144, 'socket-b')).toBe('replay')
        expect(frameSeqs(h.sent).slice(firstPage)).toEqual(Array.from({ length: firstPage }, (_, i) => i + 1))
    })

    it('sends a paged snapshot with the reset page and the lost character count', () => {
        const output = createTerminalOutputBuffer(9)
        for (const chunk of ['aaa', 'bbb', 'ccc', 'ddd']) output.push(chunk)
        const sent: Sent[] = []
        replyToTerminalResume({ sessionId: 's1', output, afterSeq: 0, maxChars: 4, seal: (p) => p, emit: (event, payload) => sent.push({ event, payload }) })
        expect(sent).toEqual([{ event: 'terminal-snapshot', payload: { sessionId: 's1', seq: 2, data: 'bbb', more: true, nextSeq: 2, droppedChars: 3 } }])
    })

    it('reports a gap, with the lost count only when paged', () => {
        const output = createTerminalOutputBuffer(1)
        output.push('aaaa')
        output.push('bbbb')
        const sent: Sent[] = []
        const emit = (event: string, payload: Record<string, unknown>) => sent.push({ event, payload })
        replyToTerminalResume({ sessionId: 's1', output, afterSeq: 1, seal: (p) => p, emit })
        replyToTerminalResume({ sessionId: 's1', output, afterSeq: 1, maxChars: 100, seal: (p) => p, emit })
        expect(sent).toEqual([
            { event: 'terminal-frame-gap', payload: { sessionId: 's1', fromSeq: 2 } },
            { event: 'terminal-frame-gap', payload: { sessionId: 's1', fromSeq: 2, droppedChars: 4 } },
        ])
    })

    it('treats a missing or negative afterSeq as "seen nothing"', () => {
        const h = harness(1, 3)
        h.reply(undefined)
        h.reply(-5)
        expect(frameSeqs(h.sent)).toEqual([1, 1])
    })
})

/*
 * D4 I3·I4 merge: an ended terminal's exit must come after the last page, or
 * the client — which stops listening at the close — drops the pages still to come.
 */
describe('an ended terminal behind a paged replay', () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    const closes = (sent: Sent[]) => sent.filter((s) => s.event === 'terminal-closed')

    it('sends the exit once, only after the page that says more:false', () => {
        vi.useFakeTimers()
        const h = harness(250, 4_000, { code: 3, signal: null }) // 1M chars → several pages
        h.reply(0, 262_144)
        let pages = 1
        for (let guard = 0; guard < 10; guard++) {
            const frames = h.sent.filter((s) => s.event === 'terminal-frame')
            const last = frames[frames.length - 1].payload
            if (!last.more) break
            expect(closes(h.sent)).toHaveLength(0)
            h.reply(last.nextSeq, 262_144)
            pages += 1
        }
        expect(pages).toBeGreaterThanOrEqual(3)
        expect(closes(h.sent)).toEqual([{ event: 'terminal-closed', payload: { sessionId: 's1', code: 3, signal: null } }])
        expect(h.sent[h.sent.length - 1].event).toBe('terminal-closed')
        expect(frameSeqs(h.sent)).toEqual(Array.from({ length: 250 }, (_, i) => i + 1))
        vi.advanceTimersByTime(PAGED_RESUME_STALE_MS * 2)
        expect(closes(h.sent)).toHaveLength(1)
    })

    it('stays silent on a merged duplicate, exit included', () => {
        const h = harness(250, 4_000, { code: 0, signal: null })
        h.reply(0, 262_144)
        const before = h.sent.length
        expect(h.reply(0, 262_144)).toBe('merged')
        expect(h.sent).toHaveLength(before)
    })

    it('sends the held exit once if the client stops asking for pages', () => {
        vi.useFakeTimers()
        const h = harness(250, 4_000, { code: 7, signal: null })
        h.reply(0, 262_144)
        vi.advanceTimersByTime(PAGED_RESUME_STALE_MS - 1)
        expect(closes(h.sent)).toHaveLength(0)
        vi.advanceTimersByTime(1)
        expect(closes(h.sent)).toHaveLength(1)
        // The replay is over: a later resume is answered afresh, not merged.
        expect(pagedReplayInFlight(h.output)).toBe(false)
    })

    // A relay client that drops mid-replay and comes back on a new socket must
    // still get every page of the ended terminal before it hears the close.
    it('replays an ended terminal in full to a client that reconnected mid-replay', () => {
        vi.useFakeTimers()
        const h = harness(250, 4_000, { code: 0, signal: null })
        h.reply(0, 262_144, 'socket-a') // this page is lost with the old socket
        h.sent.length = 0
        h.tick(1_000)
        expect(h.reply(0, 262_144, 'socket-b')).toBe('replay')
        for (let guard = 0; guard < 10; guard++) {
            const frames = h.sent.filter((s) => s.event === 'terminal-frame')
            const last = frames[frames.length - 1].payload
            if (!last.more) break
            expect(closes(h.sent)).toHaveLength(0)
            h.reply(last.nextSeq, 262_144, 'socket-b')
        }
        expect(frameSeqs(h.sent)).toEqual(Array.from({ length: 250 }, (_, i) => i + 1))
        expect(h.sent[h.sent.length - 1].event).toBe('terminal-closed')
        vi.advanceTimersByTime(PAGED_RESUME_STALE_MS * 2)
        expect(closes(h.sent)).toHaveLength(1)
    })

    it('reports a replay in flight only within the stale window', () => {
        const h = harness(250)
        h.reply(0, 262_144)
        expect(pagedReplayInFlight(h.output, 1_000)).toBe(true)
        expect(pagedReplayInFlight(h.output, 1_000 + PAGED_RESUME_STALE_MS)).toBe(false)
    })

    // The relay's pty.onExit (apiMachine.ts) calls sendExitAfterReplay with the
    // default in-flight check; this is that composition, with a real paged replay.
    it('holds a live exit that lands mid-replay until the last page carries it', () => {
        vi.useFakeTimers()
        vi.setSystemTime(1_000) // the harness clock
        const h = harness(250)
        h.reply(0, 262_144)
        const sendClosed = vi.fn()
        expect(sendExitAfterReplay({ output: h.output, sendClosed })).toBe('held')

        for (let guard = 0; guard < 10; guard++) {
            const frames = h.sent.filter((s) => s.event === 'terminal-frame')
            const last = frames[frames.length - 1].payload
            if (!last.more) break
            h.reply(last.nextSeq, 262_144)
        }
        // The last page is answered without the live exit having gone out on its own.
        expect(sendClosed).not.toHaveBeenCalled()
        expect(pagedReplayInFlight(h.output, 1_000)).toBe(false)
    })

    it('sends a live exit that lands mid-replay once the client stops asking for pages', () => {
        vi.useFakeTimers()
        vi.setSystemTime(1_000)
        const h = harness(250)
        h.reply(0, 262_144)
        const sendClosed = vi.fn()
        sendExitAfterReplay({ output: h.output, sendClosed })
        vi.advanceTimersByTime(PAGED_RESUME_STALE_MS)
        expect(sendClosed).toHaveBeenCalledTimes(1)
    })

    it('leaves a held exit to the new connection once the terminal is taken over', () => {
        vi.useFakeTimers()
        vi.setSystemTime(1_000)
        const h = harness(250)
        h.reply(0, 262_144)
        const sendClosed = vi.fn()
        sendExitAfterReplay({ output: h.output, sendClosed })
        resetPagedResume(h.output)
        vi.advanceTimersByTime(PAGED_RESUME_STALE_MS * 2)
        expect(sendClosed).not.toHaveBeenCalled()
    })
})
