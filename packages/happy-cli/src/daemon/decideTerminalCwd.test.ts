import { describe, it, expect, vi } from 'vitest';
import { decideTerminalCwd, formatCwdFallbackBanner } from './decideTerminalCwd';

describe('decideTerminalCwd', () => {
    const allowedRoot = '/home/u';
    const homedir = '/home/u';

    function passingValidate(path: string, _root: string) {
        return { valid: true as const, resolvedPath: path };
    }

    it('falls back to homedir when no cwd is requested (no banner)', () => {
        const fsExists = vi.fn(() => true);
        const fsMkdir = vi.fn();
        const validate = vi.fn(passingValidate);

        const result = decideTerminalCwd({
            requested: undefined,
            allowedRoot,
            homedir,
            fsExists,
            fsMkdir,
            validate,
        });

        expect(result).toEqual({ cwd: homedir });
        expect(validate).not.toHaveBeenCalled();
        expect(fsExists).not.toHaveBeenCalled();
        expect(fsMkdir).not.toHaveBeenCalled();
    });

    it('uses the requested cwd verbatim when it already exists', () => {
        const requested = '/home/u/proj/p1';
        const fsExists = vi.fn(() => true);
        const fsMkdir = vi.fn();

        const result = decideTerminalCwd({
            requested,
            allowedRoot,
            homedir,
            fsExists,
            fsMkdir,
            validate: passingValidate,
        });

        expect(result).toEqual({ cwd: requested });
        expect(fsExists).toHaveBeenCalledWith(requested);
        expect(fsMkdir).not.toHaveBeenCalled();
    });

    it('mkdir-creates the requested cwd when missing and uses it', () => {
        const requested = '/home/u/proj/p1';
        const fsExists = vi.fn(() => false);
        const fsMkdir = vi.fn();

        const result = decideTerminalCwd({
            requested,
            allowedRoot,
            homedir,
            fsExists,
            fsMkdir,
            validate: passingValidate,
        });

        expect(result).toEqual({ cwd: requested });
        expect(fsMkdir).toHaveBeenCalledWith(requested);
    });

    it('falls back to homedir when validate rejects (outside-root, no mkdir)', () => {
        const requested = '/etc/passwd';
        const fsExists = vi.fn();
        const fsMkdir = vi.fn();
        const validate = vi.fn(() => ({
            valid: false as const,
            error: "Access denied: Path '/etc/passwd' is outside the working directory",
        }));

        const result = decideTerminalCwd({
            requested,
            allowedRoot,
            homedir,
            fsExists,
            fsMkdir,
            validate,
        });

        expect(result.cwd).toBe(homedir);
        expect(result.fallback).toEqual({
            requested,
            reason: 'outside-root',
            error: expect.stringContaining('outside'),
        });
        // Traversal defense: never touch the filesystem when validate refuses.
        expect(fsExists).not.toHaveBeenCalled();
        expect(fsMkdir).not.toHaveBeenCalled();
    });

    it('falls back to homedir when mkdir throws (permission, EROFS, ...)', () => {
        const requested = '/home/u/proj/p1';
        const fsExists = vi.fn(() => false);
        const fsMkdir = vi.fn(() => {
            const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
            err.code = 'EACCES';
            throw err;
        });

        const result = decideTerminalCwd({
            requested,
            allowedRoot,
            homedir,
            fsExists,
            fsMkdir,
            validate: passingValidate,
        });

        expect(result.cwd).toBe(homedir);
        expect(result.fallback).toEqual({
            requested,
            reason: 'mkdir-failed',
            error: 'EACCES: permission denied',
        });
    });

    it('handles non-Error throws from fsMkdir defensively', () => {
        const requested = '/home/u/proj/p1';
        const fsMkdir = vi.fn(() => {
            // eslint-disable-next-line no-throw-literal
            throw 'kaboom';
        });

        const result = decideTerminalCwd({
            requested,
            allowedRoot,
            homedir,
            fsExists: () => false,
            fsMkdir,
            validate: passingValidate,
        });

        expect(result.cwd).toBe(homedir);
        expect(result.fallback?.error).toBe('kaboom');
    });

    describe('formatCwdFallbackBanner', () => {
        it('returns undefined when there is no fallback (no banner needed)', () => {
            expect(formatCwdFallbackBanner({ cwd: '/home/u' })).toBeUndefined();
        });

        it('renders a dim-ANSI line that ends with \\r\\n for a clean prompt', () => {
            const banner = formatCwdFallbackBanner({
                cwd: '/home/u',
                fallback: { requested: '/tmp/missing', reason: 'mkdir-failed' },
            });
            expect(banner).toBeDefined();
            expect(banner!.startsWith('\x1b[2m')).toBe(true);
            expect(banner!.endsWith('\x1b[0m\r\n')).toBe(true);
            expect(banner).toContain('/tmp/missing');
            expect(banner).toContain('/home/u');
        });

        it('includes the requested path verbatim even when validation rejected it', () => {
            const banner = formatCwdFallbackBanner({
                cwd: '/home/u',
                fallback: { requested: '/etc/passwd', reason: 'outside-root' },
            });
            expect(banner).toContain('/etc/passwd');
        });
    });

    it('uses validate.resolvedPath when present (normalizes ./ etc.)', () => {
        // validatePath may resolve `./p1` against the root, returning an
        // absolute path that differs from the verbatim `requested`. The
        // helper must hand the *resolved* path to fs/mkdir/spawn.
        const requested = './proj/p1';
        const resolved = '/home/u/proj/p1';
        const fsExists = vi.fn(() => true);

        const result = decideTerminalCwd({
            requested,
            allowedRoot,
            homedir,
            fsExists,
            fsMkdir: () => {},
            validate: () => ({ valid: true, resolvedPath: resolved }),
        });

        expect(result.cwd).toBe(resolved);
        expect(fsExists).toHaveBeenCalledWith(resolved);
    });
});
