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
    // Every project switch asks for capabilities; on Windows each worker was a visible node.exe console.
    it('answers unsupported off macOS without starting a worker', async () => {
        expect(await fileDiscovery('/allowed', { version: 1, operation: 'capabilities' }, 'win32')).toEqual({ version: 1, success: false, error: 'unsupported' });
        expect(forkMock).not.toHaveBeenCalled();
    });
    it('kills on deadline and resolves partial results only after the child exits', async () => {
        vi.useFakeTimers(); const process = child(); forkMock.mockReturnValue(process);
        const result = fileDiscovery('/allowed', { version: 1, operation: 'search', root: '/allowed', query: 'q' }, 'darwin');
        process.emit('message', { progress: true, matches: [{ path: 'a', line: 1, text: 'q' }] });
        const resolved = vi.fn(); void result.then(resolved);
        await vi.advanceTimersByTimeAsync(5000);
        expect(process.kill).toHaveBeenCalledWith('SIGKILL'); expect(resolved).not.toHaveBeenCalled();
        process.emit('exit', 0);
        expect(await result).toMatchObject({ success: true, partial: true, matches: [{ path: 'a', line: 1, text: 'q' }], reason: 'time-limit' });
    });
    it('never turns a read timeout into a successful file and refuses a third concurrent operation', async () => {
        vi.useFakeTimers(); const first = child(), second = child(); forkMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
        const a = fileDiscovery('/allowed', { version: 1, operation: 'read' }, 'darwin');
        const b = fileDiscovery('/allowed', { version: 1, operation: 'stat' }, 'darwin');
        expect(await fileDiscovery('/allowed', {}, 'darwin')).toMatchObject({ success: false, error: 'busy' });
        await vi.advanceTimersByTimeAsync(5000); first.emit('exit'); second.emit('exit');
        expect(await a).toMatchObject({ success: false, error: 'time-limit' });
        expect(await b).toMatchObject({ success: false, error: 'time-limit' });
    });
});
