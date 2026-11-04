import { randomUUID } from 'node:crypto'
import { automationExecutionSessionId } from '@slopus/happy-wire'
import { createWorkspaceTurnAdmission } from '@/utils/workspaceTurnAdmission'

type ExitEvidence = { providerExitedCleanly: boolean; foregroundDrained: boolean; backgroundDrained: boolean; writeProducersDrained: boolean }
const drained = (evidence: ExitEvidence) => evidence.providerExitedCleanly && evidence.foregroundDrained
  && evidence.backgroundDrained && evidence.writeProducersDrained

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
    async acquireAutomation(request: { runId: string; roots: readonly string[]; ownerToken?: string }) {
      const busy = { acquired: false as const, reason: 'tracked-session-busy' as const }
      if (await input.isTracked(request.roots) !== false) return busy
      const owner = createWorkspaceTurnAdmission({ home: input.home, sessionId: automationExecutionSessionId(request.runId), kind: 'automation', roots: request.roots, ownerToken: request.ownerToken })
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
        ownerToken: owner.ownerToken,
        async releaseAfterObservedExit(evidence: ExitEvidence) {
          return owner.release(drained(evidence))
        } }
    },
    /** Only the immutable launch journal plus its owned native/root exit receipt supplies these fields. */
    async recoverAutomationExit(request: { runId: string; roots: readonly string[]; ownerToken: string; evidence: ExitEvidence }) {
      const owner = createWorkspaceTurnAdmission({ home: input.home, sessionId: automationExecutionSessionId(request.runId),
        kind: 'automation', roots: request.roots, ownerToken: request.ownerToken })
      return owner.release(drained(request.evidence))
    },
    /** The launch journal must still be prepared/registered, or dispatch must have explicitly refused before submission. */
    async releaseUnsubmitted(request: { runId: string; roots: readonly string[]; ownerToken: string }) {
      return createWorkspaceTurnAdmission({ home: input.home, sessionId: automationExecutionSessionId(request.runId),
        kind: 'automation', roots: request.roots, ownerToken: request.ownerToken }).release(true)
    },
  }
}
