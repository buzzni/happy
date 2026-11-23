import { takeStandaloneLaunchBootstrap } from '@/daemon/standaloneLaunchProtocol'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { configuration } from '@/configuration'
import { readManagedStartup } from '@/managed/managedStartup'
import { extractCodexResumeFlag } from '@/codex/cliArgs'
import { extractNoSandboxFlag } from '@/utils/sandboxFlags'
import { ensureDaemonRunning } from '@/daemon/ensureDaemonRunning'
import type { PermissionMode } from '@/api/types'
import type { PreparedCodexAppServer } from '@/codex/preparedCodexAppServer'

export async function handleCodexCommand(args: string[], preparedAppServer?: PreparedCodexAppServer): Promise<void> {
  const disposePreparation = async () => {
    const prepared = preparedAppServer
    preparedAppServer = undefined
    await prepared?.dispose()
  }
  try {
    const standaloneLaunch = takeStandaloneLaunchBootstrap(process.env)
    let startedBy: 'daemon' | 'terminal' | undefined = undefined
    let permissionMode: PermissionMode | undefined = undefined
    let initialModel: string | undefined = undefined
    const sandboxArgs = extractNoSandboxFlag(args)
    const codexArgs = extractCodexResumeFlag(sandboxArgs.args)

    for (let i = 0; i < codexArgs.args.length; i++) {
      if (codexArgs.args[i] === '--started-by') {
        startedBy = codexArgs.args[++i] as 'daemon' | 'terminal'
      } else if (codexArgs.args[i] === '--permission-mode') {
        permissionMode = codexArgs.args[++i] as PermissionMode
      } else if (codexArgs.args[i] === '--yolo') {
        permissionMode = 'yolo'
      } else if (codexArgs.args[i] === '--model') {
        const value = codexArgs.args[++i]?.trim()
        if (!value || value.startsWith('-')) throw new Error('Codex model requires a model ID: happy codex --model <model-id>')
        initialModel = value
      }
    }

    if (standaloneLaunch && startedBy !== 'daemon') throw new Error('Standalone launch requires daemon startup')

    // See main.ts: a managed Cloud spawn skips account auth, machine
    // registration and the daemon entirely.
    const managed = await readManagedStartup(process.env, Date.now(), configuration.serverUrl)
    if (managed && standaloneLaunch) throw new Error('Managed runtime cannot adopt a standalone launch')
    if (preparedAppServer && (managed || startedBy !== 'daemon' || codexArgs.resumeThreadId)) await disposePreparation()
    // Parsing and custody bootstrap have consumed the launch secrets. Loading the
    // runner can overlap the account and daemon checks without starting a session.
    const [principal, { runCodex }] = await Promise.all([
      managed ? { kind: 'managed' as const, startup: managed } : prepareAccountPrincipal(),
      import('@/codex/runCodex'),
    ])

    await runCodex({
      principal,
      ...(standaloneLaunch ? { standaloneLaunch } : {}),
      ...(preparedAppServer ? { preparedAppServer } : {}),
      startedBy,
      noSandbox: sandboxArgs.noSandbox,
      resumeThreadId: codexArgs.resumeThreadId ?? undefined,
      permissionMode,
      ...(initialModel ? { initialModel } : {}),
    })
  } finally {
    if (preparedAppServer) await disposePreparation()
  }
}

async function prepareAccountPrincipal() {
  const { credentials } = await authAndSetupMachineIfNeeded()
  await ensureDaemonRunning()
  return { kind: 'account' as const, credentials }
}
