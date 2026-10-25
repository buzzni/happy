/** Trusted session-side issuance: parent credentials never enter agent subprocesses. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { PolicyApprover } from '../toolPolicy/policyGate'
import { browserClientBrokerCall, handleBrowserClientCommand } from '../commands/browserClientCommand'

export const LOCAL_CLIENT_TOOL_NAMES = ['browser_task_create_client', 'browser_task_list_clients', 'browser_task_revoke_client'] as const
export function createLocalClientSession(options: {
    socketPath: string; sessionSecret: string; runtimeUrl: string; cwd: string
    profileId(): Promise<string>; approver(): PolicyApprover | null
}, dependencies = { broker: browserClientBrokerCall, command: handleBrowserClientCommand }) {
    const approve = async (toolName: string, args: Record<string, unknown>, signal?: AbortSignal) => {
        const approver = options.approver()
        if (!approver) throw new Error('Human approval is unavailable in this session')
        const timeout = AbortSignal.timeout(120_000)
        const approvalSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
        approvalSignal.throwIfAborted()
        const answer = await approver.requestPolicyApproval({ id: randomUUID(), toolName, args,
            policy: { reasonCode: 'browser_client_delegation', ruleId: 'browser-local-client', humanOnly: true, grantOffer: 'once' },
            signal: approvalSignal })
        approvalSignal.throwIfAborted()
        if (!answer.approved) throw new Error('User did not approve this connection')
    }
    return {
        async create(args: { taskSpaceId: string; origins: string[]; leaseMinutes: number; outFile: string }, signal?: AbortSignal) {
            const root = await realpath(options.cwd)
            const output = resolve(root, args.outFile)
            const parent = await realpath(dirname(output))
            const rel = relative(root, parent)
            if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('Connection file must be inside the project')
            const file = resolve(parent, basename(output))
            const git = promisify(execFile)
            const inRepository = await git('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'])
                .then(result => result.stdout.trim() === 'true', error => {
                    if (error.code === 128) return false
                    throw new Error('Cannot verify connection file exclusion')
                })
            if (inRepository) await git('git', ['-C', root, 'check-ignore', '--no-index', '-q', '--', file])
                .catch(() => { throw new Error('Connection file must be ignored by Git') })
            // Pin the directory before consent so later symlink replacement cannot redirect the write.
            if (process.platform !== 'linux') throw new Error('Connection issuance currently requires Linux')
            const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
            try {
                const pinned = await directory.stat()
                const profileId = await options.profileId()
                await approve(LOCAL_CLIENT_TOOL_NAMES[0], { ...args, outFile: file, profileId,
                    access: 'Read pages and run site-policy-approved actions in client-owned browser tabs' }, signal)
                signal?.throwIfAborted()
                const current = await stat(parent)
                if (current.dev !== pinned.dev || current.ino !== pinned.ino || await realpath(parent) !== parent)
                    throw new Error('Destination directory changed during approval')
                const responses: unknown[] = []
                const pinnedFile = `/proc/self/fd/${directory.fd}/${basename(output)}`
                const code = await dependencies.command(['create', '--space', args.taskSpaceId, '--profile', profileId,
                    ...args.origins.flatMap(origin => ['--origin', origin]), '--lease-minutes', String(args.leaseMinutes), '--out', pinnedFile], {
                    allowCreate: true, signal, env: { HAPPY_BROWSER_TASK_SESSION_SECRET: options.sessionSecret,
                        HAPPY_BROWSER_TASK_BROKER_SOCKET: options.socketPath, HAPPY_BROWSER_TASK_RUNTIME_URL: options.runtimeUrl },
                    output: value => responses.push(value), broker: dependencies.broker,
                })
                if (code !== 0) throw new Error('Connection could not be created')
                return { ...(responses[0] as Record<string, unknown>), file }
            } finally { await directory.close() }
        },
        async list() { return dependencies.broker(options.socketPath, 'list', options.sessionSecret,
            { schemaVersion: 1, profileId: await options.profileId() }) },
        async revoke(clientSessionId: string, signal?: AbortSignal) {
            const profileId = await options.profileId()
            await approve(LOCAL_CLIENT_TOOL_NAMES[2], { clientSessionId, profileId }, signal)
            return dependencies.broker(options.socketPath, 'revoke-owned', options.sessionSecret,
                { schemaVersion: 1, profileId, clientSessionId })
        },
    }
}
export type LocalClientSession = ReturnType<typeof createLocalClientSession>
export function registerLocalClientTools(mcp: McpServer, client: LocalClientSession,
    admit: (work: () => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>) {
    const run = (fn: () => Promise<unknown>) => admit(async () => {
        try { return { content: [{ type: 'text' as const, text: JSON.stringify(await fn()) }] } }
        catch { return { isError: true, content: [{ type: 'text' as const, text: 'Browser connection request failed or was not approved. No credentials are returned.' }] } }
    })
    mcp.registerTool(LOCAL_CLIENT_TOOL_NAMES[0], { description: 'Request human approval to give a local server bounded access to one browser task space. Creates a private Linux connection file (must be Git-ignored in repositories); never returns credentials. This is a scoped bearer guardrail, not isolation from malicious processes running as the same OS user.',
        inputSchema: { taskSpaceId: z.string().min(1), origins: z.array(z.string().url()).min(1), leaseMinutes: z.number().int().min(1).max(60), outFile: z.string().min(1) } },
    (args, extra) => run(() => client.create(args, extra.signal)))
    mcp.registerTool(LOCAL_CLIENT_TOOL_NAMES[1], { description: 'List your local browser connections, including those whose connection file was lost.', inputSchema: {} }, () => run(() => client.list()))
    mcp.registerTool(LOCAL_CLIENT_TOOL_NAMES[2], { description: 'Request human approval to revoke one of your browser connections, even without its connection file.', inputSchema: { clientSessionId: z.string().min(1) } },
    (args, extra) => run(() => client.revoke(args.clientSessionId, extra.signal)))
}
