/**
 * The tools the managed runtime advertises, and which of them can write.
 *
 * Kept apart from `toolWorkload`, which *executes* a call, because the two are
 * needed by two different bundles: the image's runtime entry needs the
 * execution code, and the daemon's graph needs the catalogue. A module needed
 * by both is emitted by the bundler as a sibling chunk, and the image installs
 * a single file — so the file it installs fails to load. That is not a
 * hypothetical: it failed the image build's own layout check, twice, before
 * this split.
 *
 * Nothing here imports anything with a runtime cost — `BrokerTool` is a type,
 * and types are erased — so this module joins no graph it is not wanted in.
 */
import type { BrokerTool } from './toolBroker';

/**
 * The tools that can change the workspace.
 *
 * `run_command` is here because it *can* write, not because it always does.
 * A checkpoint's consistency argument is that no write is in flight while the
 * archive is taken, and "this command probably only reads" is not something
 * that can be known from the outside.
 */
export const MANAGED_WRITE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'run_command']);

export const MANAGED_CODING_TOOLS: BrokerTool[] = [
    {
        name: 'read_file',
        description: 'Read a UTF-8 file from the run workspace. Paths are relative to the workspace root.',
        inputSchema: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Workspace-relative path' } },
            required: ['path'],
        },
    },
    {
        name: 'write_file',
        description: 'Create or replace a UTF-8 file in the run workspace.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Workspace-relative path' },
                contents: { type: 'string', description: 'Full file contents' },
            },
            required: ['path', 'contents'],
        },
    },
    {
        name: 'list_files',
        description: 'List the entries of a directory in the run workspace.',
        inputSchema: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Workspace-relative directory, defaults to the root' } },
        },
    },
    {
        name: 'run_command',
        description: 'Run a program in the run workspace and return its exit code and output.',
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Program name, without a path or shell syntax' },
                args: { type: 'array', items: { type: 'string' }, description: 'Arguments passed as-is' },
                timeoutMs: { type: 'number', description: 'Optional limit for this command' },
            },
            required: ['command'],
        },
    },
];
