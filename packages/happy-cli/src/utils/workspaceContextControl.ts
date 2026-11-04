import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { z } from 'zod'
import { launchCommandSchema, launchReplySchema } from '@/daemon/standaloneLaunchProtocol'
import { SessionDrain, type DrainReceipt } from '@/sessionDrain/sessionDrain'
import type { RuntimeProducerGate } from '@/sessionDrain/runtimeProducerGate'
import type { AutomationContextExitEvidence } from './automationContextExit'
import { logger } from '@/ui/logger'

const identity = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/)
const commandSchema = z.strictObject({ type: z.literal('workspace-context-command'), version: z.literal(1), launchId: identity, command: launchCommandSchema })
const replySchema = z.strictObject({ type: z.literal('workspace-context-reply'), version: z.literal(1), launchId: identity, reply: launchReplySchema })
const exitSchema = z.strictObject({ type: z.literal('workspace-context-exit'), version: z.literal(1), launchId: identity,
  evidence: z.strictObject({ foregroundDrained: z.boolean(), backgroundDrained: z.boolean(), providerExitedCleanly: z.boolean(), writeProducersDrained: z.boolean() }) })
type Command = z.infer<typeof launchCommandSchema>
type Reply = z.infer<typeof launchReplySchema>
type Transport = {
  connected: boolean
  send?: (value: any, done: (error: Error | null) => void) => unknown
  on(event: 'message' | 'disconnect', listener: (...args: any[]) => void): unknown
  off(event: 'message' | 'disconnect', listener: (...args: any[]) => void): unknown
  unref?(): void
}
export const WORKSPACE_CONTEXT_CONTROL_ENV = 'HAPPY_WORKSPACE_CONTEXT_CONTROL_V1'

/** Consume before creating native/tool children. An env value without the owned IPC channel grants nothing. */
export function takeWorkspaceContextControl(env: NodeJS.ProcessEnv = process.env, transport: Transport = {
  get connected() { return process.connected === true },
  send: process.send ? (value, done) => process.send!(value, done) : undefined,
  on: (event, listener) => process.on(event, listener), off: (event, listener) => process.off(event, listener),
  unref: () => process.channel?.unref(),
}) {
  const raw = env[WORKSPACE_CONTEXT_CONTROL_ENV]; delete env[WORKSPACE_CONTEXT_CONTROL_ENV]
  if (raw === undefined) return undefined
  const parsed = identity.safeParse(raw)
  if (!parsed.success || !transport.connected || !transport.send) throw new Error('WORKSPACE_CONTROL_UNAVAILABLE')
  return createWorkspaceContextControl({ launchId: parsed.data, transport })
}

const ownedType = (value: unknown, type: string) => (value as { type?: unknown } | null)?.type === type
const isPositive = (value: AutomationContextExitEvidence) => Object.values(value).every(flag => flag === true)

async function deliver(transport: Pick<Transport, 'connected' | 'send'>, value: unknown): Promise<boolean> {
  if (!transport.connected || !transport.send) return false
  return new Promise(resolve => {
    let ended = false
    const finish = (ok: boolean) => { if (!ended) { ended = true; clearTimeout(timer); resolve(ok) } }
    const timer = setTimeout(() => finish(false), 2000)
    try { transport.send!(value, error => finish(!error)) } catch { finish(false) }
  })
}

/** A manual root's owned IPC only. The existing SessionDrain retains provider/storage ownership until ACK.
 * prepareWorkspaceDrain must be read-only and check native/background activity; it never authorizes release. */
export function createWorkspaceContextControl(input: { launchId: string; transport: Transport }) {
  const launchId = identity.parse(input.launchId), transport = input.transport
  let binding: { drain: SessionDrain; runtime: RuntimeProducerGate; prepareWorkspaceDrain(signal: AbortSignal): Promise<boolean> } | null = null
  let current: { nonce: string; controller: AbortController; receipt?: DrainReceipt; intent: boolean } | null = null
  let closed = false
  const send = (reply: Reply) => deliver(transport, replySchema.parse({ type: 'workspace-context-reply', version: 1, launchId, reply }))
  const lost = () => {
    current?.controller.abort()
    if (binding?.runtime.isFrozen()) { try { binding.runtime.blockShutdownStorage() } catch { /* A received ACK may already have confirmed. */ } }
  }
  const begin = async (operation: NonNullable<typeof current>, command: Extract<Command, { type: 'drain' }>) => {
    const bound = binding!, started = performance.now()
    let ready = false
    try { ready = bound.runtime.isWorkspaceIdle() && await bound.prepareWorkspaceDrain(operation.controller.signal) }
    catch { logger.warn('[workspace-context] Manual preflight unconfirmed') }
    const remaining = command.sessionBudgetMs - (performance.now() - started)
    if (closed || operation.controller.signal.aborted || current !== operation) return
    if (!ready || !bound.runtime.isWorkspaceIdle() || remaining <= 0) {
      await send({ type: 'receipt', nonce: operation.nonce, launchId, stored: false, ownership: 'none', reason: 'workspace-busy' })
      if (current === operation) current = null
      return
    }
    try {
      const receipt = await bound.drain.drain(remaining, operation.controller.signal, command.releaseBudgetMs)
      operation.receipt = receipt
      if (!await send({ type: 'receipt', nonce: operation.nonce, launchId, stored: receipt.stored, ownership: receipt.ownership, reason: receipt.reason })) lost()
      const decision = await bound.drain.outcome(receipt)
      await send({ type: 'outcome', nonce: operation.nonce, launchId, decision })
      if (receipt.ownership === 'none' && current === operation) current = null
    } catch { lost(); logger.warn('[workspace-context] Manual drain unconfirmed') }
  }
  const onMessage = (raw: unknown) => {
    if (!ownedType(raw, 'workspace-context-command')) return
    const parsed = commandSchema.safeParse(raw)
    if (!parsed.success || parsed.data.launchId !== launchId) { lost(); return }
    const command = parsed.data.command
    if (command.type === 'drain') {
      if (closed || !binding || current) return
      const operation = { nonce: command.nonce, controller: new AbortController(), intent: false }
      current = operation; void begin(operation, command)
      return
    }
    const operation = current
    if (!operation || command.nonce !== operation.nonce) return
    if (command.type === 'abandon') { lost(); return }
    if (!operation.receipt || !binding) { lost(); return }
    try {
      if (command.type === 'release') {
        if (!binding.drain.isCurrent(operation.receipt)) { lost(); return }
        operation.intent = true
        void send({ type: 'intent', nonce: command.nonce, launchId }).then(ok => { if (!ok) lost() })
      } else {
        if (!operation.intent) { lost(); return }
        binding.drain.releaseRuntime(operation.receipt)
      }
    } catch { lost() }
  }
  transport.on('message', onMessage); transport.on('disconnect', lost)
  return {
    bind(ports: { provider: ConstructorParameters<typeof SessionDrain>[1]; storage: ConstructorParameters<typeof SessionDrain>[2];
      runtime: RuntimeProducerGate; prepareWorkspaceDrain(signal: AbortSignal): Promise<boolean> }) {
      if (closed || binding || !transport.connected) throw new Error('WORKSPACE_CONTROL_UNAVAILABLE')
      binding = { drain: new SessionDrain(launchId, ports.provider, ports.storage, async () => {}, ports.runtime),
        runtime: ports.runtime, prepareWorkspaceDrain: ports.prepareWorkspaceDrain }
      void send({ type: 'ready', launchId, instanceId: launchId }).then(ok => { if (!ok) lost() })
    },
    async reportExit(evidence: AutomationContextExitEvidence) {
      const message = exitSchema.parse({ type: 'workspace-context-exit', version: 1, launchId, evidence })
      return deliver(transport, message)
    },
    close() {
      if (closed) return
      closed = true; lost(); transport.off('message', onMessage); transport.off('disconnect', lost); transport.unref?.()
    },
  }
}

/** Attach synchronously at the owned spawn. A positive IPC packet, clean kernel close, and durable
 * custody update are all required. Channel loss and killed/absent PIDs cannot substitute for them. */
export function observeWorkspaceContextChild(input: { child: ChildProcess; launchId: string; persist(): Promise<void> }) {
  const launchId = identity.parse(input.launchId), child = input.child
  let ready = false, received = false, conflicted = false, exited = false
  let replyObserver: ((reply: Reply) => void) | null = null, lostObserver: (() => void) | null = null
  const onMessage = (raw: unknown) => {
    if (ownedType(raw, 'workspace-context-exit')) {
      const parsed = exitSchema.safeParse(raw)
      if (!parsed.success || parsed.data.launchId !== launchId || !isPositive(parsed.data.evidence)) conflicted = true
      else received = true
    } else if (ownedType(raw, 'workspace-context-reply')) {
      const parsed = replySchema.safeParse(raw)
      if (!parsed.success || parsed.data.launchId !== launchId || parsed.data.reply.launchId !== launchId) { conflicted = true; lostObserver?.(); return }
      if (parsed.data.reply.type === 'outcome' && parsed.data.reply.decision === 'blocked') conflicted = true
      if (parsed.data.reply.type === 'ready') {
        if (parsed.data.reply.instanceId === launchId) ready = true
        else { conflicted = true; lostObserver?.() }
      } else replyObserver?.(parsed.data.reply)
    }
  }
  const onLost = () => { ready = false; lostObserver?.() }
  const onError = () => { conflicted = true; onLost() }
  const closed = child.exitCode !== null || child.signalCode !== null ? Promise.resolve(false) : new Promise<boolean>(resolve => {
    child.on('message', onMessage); child.on('disconnect', onLost); child.on('error', onError)
    child.once('close', (code, signal) => {
      exited = true; ready = false
      child.off('message', onMessage); child.off('disconnect', onLost); child.off('error', onError)
      if (!received || conflicted || code !== 0 || signal !== null || child.killed) { resolve(false); return }
      void Promise.resolve().then(() => input.persist()).then(() => resolve(true), () => {
        logger.warn('[workspace-context] Owned custody persistence unconfirmed'); resolve(false)
      })
    })
  })
  let closedProof: boolean | null = null, closedObserver: ((ok: boolean) => void) | null = null
  // One observer per owned root; refused preflights must not accumulate pending promise callbacks.
  void closed.then(ok => { closedProof = ok; closedObserver?.(ok) })
  let operation: Promise<boolean> | null = null
  return { closed,
    drain(signal: AbortSignal, budgetMs = 30000): Promise<boolean> {
      if (operation) return operation
      if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 30000) throw new Error('Invalid workspace drain budget')
      if (!ready || conflicted || exited || !child.connected || signal.aborted) return Promise.resolve(false)
      let retryable = false
      const pending = new Promise<boolean>(resolve => {
        const nonce = randomUUID()
        let finished = false, stored = false, intent = false, confirmed = false
        const send = (command: Command) => deliver(child, commandSchema.parse({ type: 'workspace-context-command', version: 1, launchId, command }))
        const done = (ok: boolean) => {
          if (finished) return
          finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
          replyObserver = null; lostObserver = null; closedObserver = null; resolve(ok)
        }
        const abort = () => { void send({ type: 'abandon', nonce }); done(false) }
        const timer = setTimeout(abort, budgetMs)
        signal.addEventListener('abort', abort, { once: true }); lostObserver = () => { if (!received) done(false) }
        replyObserver = reply => {
          if (reply.type === 'ready' || reply.nonce !== nonce) return
          if (reply.type === 'receipt') {
            if (!reply.stored || reply.ownership !== 'held' || stored) {
              retryable = reply.ownership === 'none'; if (!retryable) void send({ type: 'abandon', nonce }); done(false); return
            }
            stored = true; void send({ type: 'release', nonce }).then(ok => { if (!ok) done(false) })
          } else if (reply.type === 'intent') {
            if (!stored || intent) { abort(); return }
            intent = true; void send({ type: 'ack', nonce }).then(ok => { if (!ok) done(false) })
          } else if (reply.decision === 'confirmed' && stored && intent) {
            confirmed = true; if (closedProof !== null) done(closedProof)
          } else { done(false) }
        }
        // Natural root exit may race the final outcome packet; it remains owned until both proofs arrive.
        closedObserver = ok => { if (!ok || confirmed) done(ok && confirmed) }
        void send({ type: 'drain', nonce, sessionBudgetMs: Math.min(20000, budgetMs * 0.7), releaseBudgetMs: Math.min(5000, budgetMs * 0.2) })
          .then(ok => { if (!ok) done(false) })
      }).then(value => { if (retryable && operation === pending) operation = null; return value })
      operation = pending
      return pending
    },
  }
}
