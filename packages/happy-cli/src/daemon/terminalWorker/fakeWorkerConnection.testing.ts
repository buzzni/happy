/** A scripted `WorkerConnection` for host/session/route tests (no socket, no worker). */
import { vi } from 'vitest'
import type { WorkerEvent } from './protocol'
import type { WorkerConnection } from './workerClient'

export function fakeWorkerConnection(answer: (op: string, args: unknown) => unknown | Promise<unknown> = () => ({})) {
    const events = new Set<(event: WorkerEvent) => void>()
    const closes = new Set<() => void>()
    let open = true
    const connection = {
        record: { recordId: 'r', pid: 1, startedAt: 1, bootId: null, socketPath: '/x', secret: 's', protocolVersion: 1, cliVersion: '1', createdAt: 1 },
        ack: { type: 'helloAck', pid: 1, protocolVersion: 1, cliVersion: '1' },
        request: vi.fn(async (op: string, args?: unknown) => answer(op, args)),
        post: vi.fn(),
        onEvent: (listener: (event: WorkerEvent) => void) => { events.add(listener); return () => events.delete(listener) },
        onClose: (listener: () => void) => { closes.add(listener); return () => closes.delete(listener) },
        isOpen: () => open,
        close: vi.fn(() => { open = false; for (const listener of [...closes]) listener() }),
    }
    return {
        connection: connection as unknown as WorkerConnection & { request: typeof connection.request; post: typeof connection.post },
        emit: (event: WorkerEvent) => { for (const listener of [...events]) listener(event) },
        listenerCount: () => events.size + closes.size,
    }
}
