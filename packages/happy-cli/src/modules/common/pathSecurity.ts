import { resolve, sep } from 'path';
import { isStrictlyGuardedPath } from './happyHomeGuard';

export interface PathValidationResult {
    valid: boolean;
    resolvedPath?: string;
    error?: string;
}

/**
 * Validates that a path is within the allowed working directory
 * @param targetPath - The path to validate (can be relative or absolute)
 * @param workingDirectory - The session's working directory (must be absolute)
 * @param approvedRoots - Absolute folders outside it that the machine owner approved on this machine
 * @returns Validation result
 */
export function validatePath(targetPath: string, workingDirectory: string, approvedRoots: readonly string[] = []): PathValidationResult {
    // Resolve both paths to absolute paths to handle path traversal attempts
    const resolvedTarget = resolve(workingDirectory, targetPath);
    const resolvedWorkingDir = resolve(workingDirectory);

    // Check if the resolved target path starts with the working directory (or an approved folder)
    // Uses path.sep to work correctly on both Windows (\) and Unix (/)
    if (![resolvedWorkingDir, ...approvedRoots.map((root) => resolve(root))].some((root) => isWithin(resolvedTarget, root))) {
        return {
            valid: false,
            resolvedPath: resolvedTarget,
            error: `Access denied: Path '${targetPath}' is outside the working directory`
        };
    }

    // aplus-dev-studio specs/e2ee-machine-control-boundary R11.
    if (isStrictlyGuardedPath(resolvedTarget)) {
        return {
            valid: false,
            resolvedPath: resolvedTarget,
            error: `Access denied: Path '${targetPath}' is in the happy home directory, which strict machine control keeps out of reach`
        };
    }

    return { valid: true, resolvedPath: resolvedTarget };
}

/** A drive or filesystem root (`C:\\`, `/`) already ends with the separator. */
export function isWithin(target: string, root: string): boolean {
    return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}
