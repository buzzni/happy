import { randomUUID } from 'node:crypto'
import { automationExecutionSessionId } from '@slopus/happy-wire'
import { createWorkspaceTurnAdmission } from '@/utils/workspaceTurnAdmission'

type ExitEvidence = { providerExitedCleanly: boolean; foregroundDrained: boolean; backgroundDrained: boolean; writeProducersDrained: boolean }

/** Private daemon host only. A live manual process remains busy even when its last answer looks idle.
 * Preparation reservations cover spawn->tracking. Runtime owners survive process/daemon loss until
 * positive provider evidence (or a different kernel boot); neither PID disappearance nor time is proof. */
export function createAutomationContextWorkspace(input: {
  home: string; isTracked(roots: readonly string[]): Promise<boolean | 'unconfirmed'>
}) {
  return {
    async beginManualLaunch(roots: readonly string[]) {
      const owner = createWorkspaceTurnAdmission({ home: input.home, sessionId: `manual-launch:${randomUUID()}`, kind: 'manual-launch', roots })
      const admitted = await owner.tryAcquire()
      if (!admitted.acquired) return admitted
      return { acquired: true as const,
        async finish(observed: { submitted: boolean; tracked: boolean }) {
          // A lost spawn ACK can leave a child alive. Keep that reservation until tracking is confirmed.
          return owner.release(!observed.submitted || observed.tracked)
        } }
    },
    async acquireAutomation(request: { runId: string; roots: readonly string[] }) {
      const busy = { acquired: false as const, reason: 'tracked-session-busy' as const }
      if (await input.isTracked(request.roots) !== false) return busy
      const owner = createWorkspaceTurnAdmission({ home: input.home, sessionId: automationExecutionSessionId(request.runId), kind: 'automation', roots: request.roots })
      const admitted = await owner.tryAcquire()
      if (!admitted.acquired) return admitted
      // A manual launch can finish transferring its reservation after the first check but before acquisition.
      try {
        if (await input.isTracked(request.roots) !== false) {
          await owner.release(true) // This automatic provider has not been submitted.
          return busy
        }
      } catch (error) {
        await owner.release(true)
        throw error
      }
      return { acquired: true as const,
        async releaseAfterObservedExit(evidence: ExitEvidence) {
          return owner.release(evidence.providerExitedCleanly && evidence.foregroundDrained
            && evidence.backgroundDrained && evidence.writeProducersDrained)
        } }
    },
  }
}
