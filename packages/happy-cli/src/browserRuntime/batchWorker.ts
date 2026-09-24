import {
    BrowserRuntimeError,
    type AgentGrant,
    type BatchStep,
    type BrowserDriver,
    type ElementRef,
    type Observation,
    type SnapshotId,
} from './contracts'
import { assertAllowedOrigin } from './policy'

/** One validated driver dispatch; the runtime owns fencing and durable intents. */
export async function dispatchStep(
    driver: BrowserDriver,
    step: BatchStep,
    observed: Observation | undefined,
    grant: AgentGrant,
    signal: AbortSignal,
): Promise<void> {
    const options = { signal, timeoutMs: step.timeoutMs }
    switch (step.kind) {
        case 'navigate': {
            if (!step.url) throw new BrowserRuntimeError('INVALID_REQUEST', 'navigate requires url')
            assertAllowedOrigin(step.url, grant)
            const result = await driver.navigate(step.tabId, step.url, grant.allowedOrigins, options)
            assertAllowedOrigin(result.url, grant)
            return
        }
        case 'click':
            if (!step.ref || typeof step.ref === 'string' && step.ref.startsWith('$')) {
                throw new BrowserRuntimeError('INVALID_REQUEST', 'click needs a resolved ref')
            }
            return driver.click(step.tabId, step.ref as ElementRef, step.snapshotId ?? observed?.snapshotId as SnapshotId, options)
        case 'fill':
            if (!step.ref || step.value === undefined) {
                throw new BrowserRuntimeError('INVALID_REQUEST', 'fill needs ref and value')
            }
            return driver.fill(step.tabId, step.ref as ElementRef, step.snapshotId ?? observed?.snapshotId as SnapshotId, step.value, options)
        case 'observe':
            await driver.observe(step.tabId, grant.allowedOrigins, options)
            return
        case 'screenshot':
            await driver.screenshot(step.tabId, grant.allowedOrigins, options)
            return
        case 'waitFor':
            if (!step.until) throw new BrowserRuntimeError('INVALID_REQUEST', 'waitFor needs a predicate')
            return driver.waitFor(step.tabId, step.until, grant.allowedOrigins, options)
    }
}
