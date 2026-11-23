import type { PreparedCodexAppServer } from '@/codex/preparedCodexAppServer'
import { captureLaunchMcpServersSeed } from '@/aplus/launchMcpSeed'
import { captureStandaloneLaunchBootstrap } from '@/daemon/standaloneLaunchProtocol'

export {
  codexAppServerArgs,
  prepareCodexAppServerFromSessionEnvironment as prepareCodexAppServer,
} from '@/codex/preparedCodexAppServer'

/** Enter the ordinary Codex command after the owning loader has installed the final launch environment. */
export async function activatePreparedCodex(prepared: PreparedCodexAppServer): Promise<void> {
  const args = process.argv.slice(2)
  let handleCodexCommand: typeof import('./codexCommand').handleCodexCommand
  try {
    if (args[0] !== 'codex') throw new Error('Preparation requires a Codex command')
    captureLaunchMcpServersSeed(process.env)
    captureStandaloneLaunchBootstrap(process.env, args)
    const command = await import('./codexCommand')
    handleCodexCommand = command.handleCodexCommand
  } catch (error) {
    await prepared.dispose()
    throw error
  }
  await handleCodexCommand(args.slice(1), prepared)
}
