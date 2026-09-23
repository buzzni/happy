import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { standaloneControl } from './standaloneControl';

describe('standaloneControl', () => {
    it('retains a fragmented request received before server startup completes', async () => {
        const input = new PassThrough();
        const control = standaloneControl(input);
        input.write('{"v":1,');
        input.write('"command":"shutdown"}\n');
        input.write('{"v":1,"command":"shutdown"}\n');
        await expect(control.requested).resolves.toBeUndefined();
        control.dispose();
        expect(input.listenerCount('data')).toBe(0);
    });
    it('ignores malformed, unsupported and oversized lines before a valid request', async () => {
        const input = new PassThrough();
        const control = standaloneControl(input);
        let requested = false;
        control.requested.then(() => { requested = true; });
        input.write('invalid\n{"v":2,"command":"shutdown"}\n');
        input.write('x'.repeat(4096));
        input.write('{"v":1,"command":"shutdown"}\n');
        await Promise.resolve();
        expect(requested).toBe(false);
        input.write('{"v":1,"command":"shutdown"}\r\n');
        await control.requested;
        control.dispose();
    });
    it('retains parent loss before control is attached', async () => {
        const input = new PassThrough();
        input.destroy();
        const control = standaloneControl(input);
        await expect(control.requested).resolves.toBeUndefined();
        control.dispose();
    });
    it.each(['end', 'close', 'error'] as const)('requests shutdown when the parent pipe emits %s', async (event) => {
        const input = new PassThrough();
        const control = standaloneControl(input);
        if (event === 'end') input.end();
        else if (event === 'close') input.destroy();
        else input.emit('error', new Error('pipe closed'));
        await control.requested;
        control.dispose();
    });
});
