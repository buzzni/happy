import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({
    spawnMock: vi.fn(),
}))

vi.mock('cross-spawn', () => ({
    spawn: spawnMock,
}))

import { run } from './index'

function fakeChild() {
    const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough
        stderr: PassThrough
        kill: ReturnType<typeof vi.fn>
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn(() => true)
    return child
}

describe('ripgrep process lifecycle', () => {
    afterEach(() => {
        vi.useRealTimers()
        spawnMock.mockReset()
    })

    it('does not leave ripgrep waiting on an unused stdin pipe', async () => {
        const child = fakeChild()
        spawnMock.mockReturnValue(child)

        const resultPromise = run(['needle', '.'])

        expect(spawnMock).toHaveBeenCalledWith(
            'node',
            expect.any(Array),
            expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
        )

        child.emit('close', 1, null)
        await expect(resultPromise).resolves.toMatchObject({ exitCode: 1 })
    })

    it('kills and rejects a ripgrep request that exceeds its deadline', async () => {
        vi.useFakeTimers()
        const child = fakeChild()
        spawnMock.mockReturnValue(child)

        const resultPromise = run(['needle', '.'], { timeoutMs: 25 })
        const rejection = resultPromise.catch((error: unknown) => error)

        await vi.advanceTimersByTimeAsync(25)
        expect(child.kill).toHaveBeenCalledWith('SIGKILL')

        child.emit('close', null, 'SIGKILL')
        await expect(rejection).resolves.toEqual(
            expect.objectContaining({ message: 'Ripgrep timed out after 25ms' }),
        )
    })
})
