import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
const forkMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ fork: forkMock }));
import { fileDiscovery } from './fileDiscovery';
function child() {
    return Object.assign(new EventEmitter(), { pid: 10, exitCode: null, signalCode: null, send: vi.fn(), kill: vi.fn() });
}
afterEach(() => { vi.useRealTimers(); forkMock.mockReset(); });
describe('bounded file discovery process ownership', () => {
    it('kills on deadline and resolves partial results only after the child exits', async () => {
        vi.useFakeTimers(); const process = child(); forkMock.mockReturnValue(process);
        const result = fileDiscovery('/allowed', { version: 1, operation: 'search', root: '/allowed', query: 'q' });
        process.emit('message', { progress: true, matches: [{ path: 'a', line: 1, text: 'q' }] });
        const resolved = vi.fn(); void result.then(resolved);
        await vi.advanceTimersByTimeAsync(5000);
        expect(process.kill).toHaveBeenCalledWith('SIGKILL'); expect(resolved).not.toHaveBeenCalled();
        process.emit('exit', 0);
        expect(await result).toMatchObject({ success: true, partial: true, matches: [{ path: 'a', line: 1, text: 'q' }], reason: 'time-limit' });
    });
    it('never turns a read timeout into a successful file and refuses a third concurrent operation', async () => {
        vi.useFakeTimers(); const first = child(), second = child(); forkMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
        const a = fileDiscovery('/allowed', { version: 1, operation: 'read' });
        const b = fileDiscovery('/allowed', { version: 1, operation: 'stat' });
        expect(await fileDiscovery('/allowed', {})).toMatchObject({ success: false, error: 'busy' });
        await vi.advanceTimersByTimeAsync(5000); first.emit('exit'); second.emit('exit');
        expect(await a).toMatchObject({ success: false, error: 'time-limit' });
        expect(await b).toMatchObject({ success: false, error: 'time-limit' });
    });
});
