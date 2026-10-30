/**
 * HTTP client helpers for daemon communication
 * Used by CLI commands to interact with running daemon
 */

import type { AutomationTurnResult } from '@/api/automationTurnTracker';
import { logger } from '@/ui/logger';
import { clearDaemonState, readDaemonLockHolderPid, readDaemonState, readDaemonStateSnapshot, writeDaemonStateIfUnchanged } from '@/persistence';
import { Metadata } from '@/api/types';
import type { SetupTokenUsageObservation } from './setupTokenAccountSwitch';
import { configuration } from '@/configuration';
import { randomUUID } from 'node:crypto';
import { verifyDaemonIdentity } from './daemonIdentity';
import {
    DaemonStopRefusedError,
    stopDaemonWithDrain,
    type StopDaemonOptions,
    type StopDaemonOutcome,
} from './restartDrainClient';
import { initializeScopeReportSigner, SCOPE_REPORT_HEADER } from './sessionWriteScopeReports';
import {
    MANAGED_REPORT_CAPABILITY_HEADER,
    type ManagedReportKind,
} from './launch/managedReportCapability';
import {
    createManagedReportSigner,
    MANAGED_REPORT_FD_ENV,
    type ManagedReportSigner,
} from './launch/managedReportCredential';

/** How long one report's capability is good for. Minted per report. */
const MANAGED_REPORT_CAPABILITY_TTL_MS = 60_000;

/**
 * This launch's report signer, resolved once.
 *
 * The control server refuses a managed lifecycle report that no launch vouched
 * for: the loopback bearer is readable by the agent's own tools, so it proves
 * "something on this host" and nothing about *which* launch is reporting.
 * The launcher hands this child a per-launch secret on its own inherited
 * descriptor, and this is where the report is signed with it.
 *
 * Resolved lazily and cached, because the descriptor is consumed by the first
 * read. `null` is the ordinary spawn: no descriptor, nothing to sign, and the
 * control server is not asking.
 */
let reportSigner: Promise<ManagedReportSigner | null> | null = null;
/**
 * Whether this process was launched as a managed child at all.
 *
 * Read before the signer consumes the variable, because "no credential" and
 * "not managed" are different answers: the first must refuse to report, the
 * second is an ordinary spawn that never had one.
 */
let managedChild: boolean | null = null;
const isManagedChild = () => managedChild === true;
/** Monotonic per-process. The registry refuses a repeated or lower value. */
let reportSeq = 0;

function managedReportSigner() {
    // Captured before the signer consumes the variable, and lazily rather than
    // at import: what matters is whether this process was launched managed,
    // asked at the first moment anything needs to know.
    managedChild ??= process.env[MANAGED_REPORT_FD_ENV] !== undefined;
    reportSigner ??= createManagedReportSigner(process.env).catch((error) => {
        // A launch that cannot sign will be refused by the control server, and
        // that refusal is the honest outcome — reports do not fall back to
        // unsigned. Only the shape of the failure is kept.
        logger.debug(`[CONTROL CLIENT] managed report signer unavailable: ${(error as Error)?.name ?? 'unknown'}`);
        return null;
    });
    return reportSigner;
}

/**
 * A managed lifecycle report: the launch's own address, the launch's own
 * capability, and nothing of the daemon's.
 *
 * The ordinary path cannot be used here. It finds the daemon by reading the
 * daemon's state file — `0600`, owned by the daemon's uid — and then proves it
 * is alive with `kill(pid, 0)`. A managed child runs as a **different uid**, so
 * the read fails and the signal is `EPERM`: a provider that had to go that way
 * could not report at all.
 *
 * It also must not: that file carries the daemon-wide bearer, and handing it to
 * a process the agent influences would let the agent's own tools forge another
 * Run's session. On a managed runtime the control server does not ask for that
 * bearer on these two paths — the per-launch capability is the whole
 * credential, so the child never needs the secret it must not have.
 *
 * **A report that cannot be signed is not sent.** Sending it unsigned would be
 * refused anyway, but it would put the session's own metadata on the wire for a
 * launch that could not prove it owns it.
 */
async function managedReportPost(
  signer: ManagedReportSigner,
  path: string,
  body: unknown,
  reportKind: ManagedReportKind,
): Promise<{ error?: string } | any> {
  reportSeq += 1;
  const capability = signer.sign({
    kind: reportKind,
    seq: reportSeq,
    // The window the registry already bounds this launch by; a capability that
    // outlives the launch is one that outlives its reason to exist.
    expiresAt: Date.now() + MANAGED_REPORT_CAPABILITY_TTL_MS,
    // The whole body: the signature says this launch made *this* report, not
    // merely that it made one.
    body: body ?? {},
  });
  try {
    const timeout = process.env.HAPPY_DAEMON_HTTP_TIMEOUT ? parseInt(process.env.HAPPY_DAEMON_HTTP_TIMEOUT) : 10_000;
    const response = await fetch(`${signer.reportBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [MANAGED_REPORT_CAPABILITY_HEADER]: capability,
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) {
      const errorMessage = `Request failed: ${path}, HTTP ${response.status}`;
      logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
      return { error: errorMessage };
    }
    return await response.json();
  } catch (error) {
    // The launch's address and capability are not echoed into the message.
    const errorMessage = `Request failed: ${path}, ${error instanceof Error ? error.name : 'Unknown error'}`;
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return { error: errorMessage };
  }
}

async function daemonPost(
  path: string,
  body?: any,
  /** Set for the two managed lifecycle reports, which must be signed. */
  reportKind?: ManagedReportKind,
  /** A call the daemon answers only after its own outbound work; defaults to the usual HTTP timeout. */
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<{ error?: string } | any> {
  if (reportKind) {
    const signer = await managedReportSigner();
    if (signer) return managedReportPost(signer, path, body, reportKind);
    if (isManagedChild()) {
      /*
       * A managed child whose credential could not be read. There is no
       * unsigned fallback: the report would be refused, and sending it anyway
       * puts this session's metadata on the wire without the launch that owns
       * it being able to say so.
       */
      const errorMessage = `Request failed: ${path}, managed report credential unavailable`;
      logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
      return { error: errorMessage };
    }
  }
  const state = await readDaemonState();
  if (!state?.httpPort) {
    const errorMessage = 'No daemon running, no state file found';
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    };
  }

  try {
    process.kill(state.pid, 0);
  } catch (error) {
    const errorMessage = 'Daemon is not running, file is stale';
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    };
  }

  try {
    const timeout = timeoutMs ?? (process.env.HAPPY_DAEMON_HTTP_TIMEOUT ? parseInt(process.env.HAPPY_DAEMON_HTTP_TIMEOUT) : 10_000);
    const response = await fetch(`http://127.0.0.1:${state.httpPort}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // ADR-061: the control server rejects every request without this —
        // absent on a state file from before the auth rollout, in which case
        // the server's 401 surfaces through the existing `!response.ok` path.
        ...(state.controlSecret ? { Authorization: `Bearer ${state.controlSecret}` } : {}),
        ...(reportKind ? await scopeReportHeaders(reportKind, body || {}) : {}),
      },
      body: JSON.stringify(body || {}),
      // Mostly increased for stress test
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)
    });
    
    if (!response.ok) {
      const errorMessage = `Request failed: ${path}, HTTP ${response.status}`;
      logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
      // The daemon's own refusal code, when it sent one; never other body fields.
      let code: unknown;
      try { code = ((await response.json()) as { code?: unknown } | null)?.code; } catch { code = undefined; }
      return {
        error: errorMessage, status: response.status,
        ...(typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? { code } : {}),
      };
    }
    
    return await response.json();
  } catch (error) {
    const errorMessage = `Request failed: ${path}, ${error instanceof Error ? error.message : 'Unknown error'}`;
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    }
  }
}

const SESSION_STARTED_RETRY_TIMEOUT_MS = 3000;
async function scopeReportHeaders(kind: ManagedReportKind, body: unknown): Promise<Record<string, string>> {
  const signer = await initializeScopeReportSigner();
  return signer ? { [SCOPE_REPORT_HEADER]: signer(kind, body) } : {};
}
const SESSION_STARTED_RETRY_INTERVAL_MS = 100;

export async function notifyDaemonSessionStarted(
  sessionId: string,
  metadata: Metadata,
  encryption?: {
    encryptionKey: string;
    encryptionVariant: 'legacy' | 'dataKey';
    seq: number;
    metadataVersion: number;
    agentStateVersion: number;
  }
): Promise<{ error?: string } | any> {
  // Retry briefly — ensureDaemonRunning already waits for readiness, but we may
  // race a daemon that is mid-restart (version upgrade, crash recovery). Without
  // this, the session's encryption data never reaches the daemon and the mobile
  // app's resume-happy-session RPC fails with "not tracked by this daemon".
  const payload = { sessionId, metadata, encryption };
  const deadline = Date.now() + SESSION_STARTED_RETRY_TIMEOUT_MS;
  let result: { error?: string } | any;

  while (true) {
    result = await daemonPost('/session-started', payload, 'session-started');
    if (!result?.error) {
      return result;
    }
    if (Date.now() >= deadline) {
      return result;
    }
    await new Promise(resolve => setTimeout(resolve, SESSION_STARTED_RETRY_INTERVAL_MS));
  }
}

export async function notifyDaemonSessionRuntime(
  sessionId: string,
  runtime: {
    reportSeq?: number;
    thinking?: boolean;
    hasOpenToolCall?: boolean;
    pendingUserInput?: boolean;
    lastUserInteractionAt?: number;
    lastTurnEndAt?: number;
    assistantTurns?: number;
    providerTokens?: number;
    launchedBackgroundJob?: boolean;
    lastProcessedSeq?: number;
    mode?: 'local' | 'remote';
  }
): Promise<{ error?: string } | any> {
  // Announce our own PID on every report. `daemonPost` re-reads daemon.state.json
  // each call, so this report reaches whichever daemon is current — including one
  // that replaced the daemon that spawned us and therefore has no record of this
  // session. hostPid is what lets that daemon adopt us instead of dropping the
  // report; taking the PID from a persisted record instead would risk acting on a
  // recycled PID.
  return daemonPost('/session-runtime', { sessionId, ...runtime, hostPid: process.pid }, 'session-runtime');
}

/**
 * The turn that answered a scheduled prompt (Saycode specs/_archive/automation-result-delivery D1). Only the
 * cut answer goes, and only for a turn the daemon's own prompt opened.
 */
export async function notifyDaemonAutomationTurnResult(
  sessionId: string,
  result: AutomationTurnResult,
): Promise<{ error?: string } | any> {
  return daemonPost('/session-automation-turn', { sessionId, ...result });
}

export async function listDaemonSessions(): Promise<any[]> {
  const result = await daemonPost('/list');
  return result.children || [];
}

export async function stopDaemonSession(sessionId: string): Promise<boolean> {
  const result = await daemonPost('/stop-session', { sessionId });
  return result.success || false;
}

export async function spawnDaemonSession(directory: string, sessionId?: string): Promise<any> {
  const result = await daemonPost('/spawn-session', { directory, sessionId });
  return result;
}

/** A responding daemon refused to stop — never converted into a force kill. */
export const DaemonStopRefused = DaemonStopRefusedError;
export type DaemonStopRefused = DaemonStopRefusedError;

export async function stopDaemonHttp(): Promise<void> {
  const result = await daemonPost('/stop');
  // A responding server refused shutdown: never convert this into a force kill.
  if (result?.error) {
    if (result.status >= 400) throw new DaemonStopRefused(result.error);
    throw new Error(result.error);
  }
}

/**
 * The version check is still quite naive.
 * For instance we are not handling the case where we upgraded happy,
 * the daemon is still running, and it recieves a new message to spawn a new session.
 * This is a tough case - we need to somehow figure out to restart ourselves,
 * yet still handle the original request.
 * 
 * Options:
 * 1. Periodically check during the health checks whether our version is the same as CLIs version. If not - restart.
 * 2. Wait for a command from the machine session, or any other signal to
 * check for version & restart.
 *   a. Handle the request first
 *   b. Let the request fail, restart and rely on the client retrying the request
 * 
 * I like option 1 a little better.
 * Maybe we can ... wait for it ... have another daemon to make sure 
 * our daemon is always alive and running the latest version.
 * 
 * That seems like an overkill and yet another process to manage - lets not do this :D
 * 
 * TODO: This function should return a state object with
 * clear state - if it is running / or errored out or something else.
 * Not just a boolean.
 * 
 * We can destructure the response on the caller for richer output.
 * For instance when running `happy daemon status` we can show more information.
 */
export async function checkIfDaemonRunningAndCleanupStaleState(): Promise<boolean> {
  const { state, raw } = await readDaemonStateSnapshot();
  if (!state) {
    return false;
  }
  // The owner writes `stopped` after closing its control server; the bundle handoff also drops the lock
  // (`clearDaemonState`) and then stays alive until its replacement confirms, so probing it here failed
  // every replacement (aplus codexcli-daemon-restart-drain F2). A `stopped` owner that still holds the
  // lock is mid-shutdown and keeps the checks below. The record is left as written: its tracked
  // sessions are what the replacement recovers.
  if (state.state === 'stopped' && readDaemonLockHolderPid() !== state.pid) {
    return false;
  }

  // Check if the PID is alive
  try {
    process.kill(state.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    logger.debug('[DAEMON RUN] Daemon PID not running, marking state as crashed');
    // Guarded write: `ensureDaemonRunning()` calls us every 100ms while a daemon is
    // coming up, so the daemon may have claimed the file between our read and here.
    // An unguarded write would resurrect the dead pid over its state, and its next
    // heartbeat would read a foreign pid and shut it down.
    const marked = writeDaemonStateIfUnchanged(raw, { ...state, state: 'crashed', stateReason: 'Daemon PID not running' });
    if (!marked) {
      logger.debug('[DAEMON RUN] Daemon state file changed while we were checking it, leaving it to its owner');
    }
    return false;
  }

  // A live PID is not proof of health, but an HTTP timeout is not proof of death.
  // Preserve its ownership until it exits; otherwise a slow daemon and its replacement
  // can both publish different process keys for the same machine.
  if (state.httpPort) {
    try {
      const response = await fetch(`http://127.0.0.1:${state.httpPort}/list`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(state.controlSecret ? { Authorization: `Bearer ${state.controlSecret}` } : {}),
        },
        body: '{}',
        signal: AbortSignal.timeout(2000)
      });
      if (response.ok) {
        return true;
      }
    } catch {
      // Recheck after the await: a daemon that actually exited may use the existing
      // compare-and-swap cleanup, never an unguarded clear of a newer owner's lock.
      try { process.kill(state.pid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          writeDaemonStateIfUnchanged(raw, { ...state, state: 'crashed', stateReason: 'Daemon PID not running' });
          return false;
        }
      }
      // R19: a live pid that no longer is the recorded daemon (reused after a crash or reboot)
      // is not a daemon to wait on, stop or signal.
      if (state.identity && await verifyDaemonIdentity(state.identity) === 'mismatch') {
        writeDaemonStateIfUnchanged(raw, { ...state, state: 'crashed', stateReason: 'Daemon PID reused by another process' });
        return false;
      }
    }
    throw new Error(`DAEMON_HEALTH_UNCONFIRMED: PID ${state.pid} is alive but its control server could not be verified; state and lock were preserved`);
  }

  return true;
}

/**
 * Check if the running daemon version matches the current CLI version.
 * This should work from both the daemon itself & a new CLI process.
 * Works via the daemon.state.json file.
 * 
 * @returns true if versions match, false if versions differ or no daemon running
 */
export async function isDaemonRunningCurrentlyInstalledHappyVersion(): Promise<boolean> {
  logger.debug('[DAEMON CONTROL] Checking if daemon is running same version');
  const runningDaemon = await checkIfDaemonRunningAndCleanupStaleState();
  if (!runningDaemon) {
    logger.debug('[DAEMON CONTROL] No daemon running, returning false');
    return false;
  }

  const state = await readDaemonState();
  if (!state) {
    logger.debug('[DAEMON CONTROL] No daemon state found, returning false');
    return false;
  }
  
  // Compare the running daemon's recorded version against THIS CLI invocation's
  // bundled version. Both are read from the same source of truth: the `version`
  // field baked into `dist/` at build time via `import packageJson from '../package.json'`.
  //
  // Previously we read `package.json` fresh from disk on every check, but that
  // produced infinite restart loops (#1107) when `package.json.version` diverged
  // from the bundled version — e.g. when `happy-coder@0.13.1` was published as
  // a deprecation stub that bumped the manifest without rebuilding `dist/`.
  // The daemon would write its bundled version (0.13.0), read 0.13.1 from disk,
  // detect a mismatch, self-restart, and the new daemon would repeat the cycle.
  //
  // Using `configuration.currentCliVersion` instead guarantees the writer and
  // reader agree whenever they're executing the same `dist/` bundle, and still
  // correctly detects real npm upgrades (the new bundle has a new baked version).
  const currentCliVersion = configuration.currentCliVersion;
  logger.debug(`[DAEMON CONTROL] Current CLI version: ${currentCliVersion}, Daemon started with version: ${state.startedWithCliVersion}`);
  return currentCliVersion === state.startedWithCliVersion;
}

export async function cleanupDaemonState(): Promise<void> {
  try {
    await clearDaemonState();
    // clearDaemonState marks the file stopped and keeps it — the tracked
    // session records are what a replacement daemon recovers from. Saying
    // "removed" here sent a 2026-08-23 investigation looking for a phantom
    // writer that had put the file back.
    logger.debug('[DAEMON RUN] Daemon state marked stopped and lock released');
  } catch (error) {
    logger.debug('[DAEMON RUN] Error cleaning up daemon metadata', error);
  }
}

/**
 * Stop the running daemon (aplus specs/codexcli-daemon-restart-drain R5·R19·R22).
 *
 * Without options this is the plain `happy daemon stop`: a grace-0 drain on a
 * daemon that supports it, then `/stop`. `--for-restart` callers pass a reason
 * (and optionally a grace) so turns get time to finish. An old daemon gets the
 * 15-second `/stop` wait; a kill only ever reaches a process whose recorded
 * identity still matches.
 */
export async function stopDaemon(options: StopDaemonOptions = { intent: 'stop', reason: 'user-restart', graceSeconds: 0 }): Promise<StopDaemonOutcome> {
  try {
    return await stopDaemonWithDrain(options, {
      readState: readDaemonState,
      post: async (path, body) => {
        const result = await daemonPost(path, body);
        return result?.error
          ? {
            ok: false,
            ...(typeof result.status === 'number' ? { status: result.status } : {}),
            ...(typeof result.code === 'string' ? { code: result.code } : {}),
            error: result.error,
          }
          : { ok: true, body: result };
      },
      isPidAlive: (pid) => {
        try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
      },
      verifyIdentity: (identity) => verifyDaemonIdentity(identity),
      kill: (pid) => process.kill(pid, 'SIGKILL'),
      markStale: async (state, reason) => {
        // Guarded: a daemon that claimed the file meanwhile keeps it.
        const { state: current, raw } = await readDaemonStateSnapshot();
        if (current?.pid === state.pid) writeDaemonStateIfUnchanged(raw, { ...current, state: 'crashed', stateReason: reason });
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      randomId: () => randomUUID(),
      log: (message) => logger.debug(message),
    });
  } catch (error) {
    if (error instanceof DaemonStopRefused) throw error;
    logger.debug('Error stopping daemon', error);
    return 'left-running';
  }
}

/** Local-only organization approval controls. Never use machine RPC or return the control secret. */
export async function getDeviceApprovalStatus(companyId: string): Promise<Awaited<ReturnType<ReturnType<typeof import('./deviceEnrollment').createDeviceEnrollment>['getStatus']>>> {
  const result = await daemonPost('/device/status', { companyId });
  if (result.error || !result.machineId || result.companyId !== companyId) throw new Error('DEVICE_CONTROL_UNAVAILABLE');
  return result;
}
export async function confirmDeviceOrganization(input: { companyId: string; machineId: string; enrollmentDigest: string }): Promise<{ locallyConfirmed: true }> {
  const result = await daemonPost('/device/confirm-org-key', input);
  if (result.error || result.locallyConfirmed !== true) throw new Error('DEVICE_CONTROL_UNAVAILABLE');
  return { locallyConfirmed: true };
}
/** aplus specs/shared-machine-server-signing S6b — loopback only; a refusal (already marked, nothing waiting) is 409. */
export async function useDeviceAsShared(companyId: string): Promise<{ accepted: true; confirmed: boolean; declined: boolean }> {
  const result = await daemonPost('/device/use-as-shared', { companyId });
  if (result.status === 409) throw new Error(result.code ?? 'DEVICE_USE_AS_SHARED_REFUSED');
  if (result.error || result.accepted !== true) throw new Error('DEVICE_CONTROL_UNAVAILABLE');
  return { accepted: true, confirmed: result.confirmed === true, declined: result.declined === true };
}

/**
 * Saycode specs/claude-setup-token-account-selection — a setup-token-bound session's usage, and its request
 * to move off a used-up organization account. The daemon resolves the account from the session's own binding.
 */
export async function reportSetupTokenUsage(sessionId: string, binding: string, observation: SetupTokenUsageObservation, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await daemonPost('/setup-token/usage', { sessionId, binding, observation }, undefined, undefined, signal);
  return result?.ok === true ? { ok: true } : { ok: false, reason: typeof result?.reason === 'string' ? result.reason : 'REQUEST_FAILED' };
}
/** Longer than the daemon's whole switch (Studio call, grant verification, token slot reads). */
const SETUP_TOKEN_REBIND_TIMEOUT_MS = 90_000;
export async function requestSetupTokenRebind(sessionId: string, binding: string, observation?: SetupTokenUsageObservation, signal?: AbortSignal): Promise<{ ok: true; environment: Record<string, string> } | { ok: false; reason: string; retryAfterMs?: number }> {
  const result = await daemonPost('/setup-token/rebind', { sessionId, binding, ...(observation ? { observation } : {}) }, undefined, SETUP_TOKEN_REBIND_TIMEOUT_MS, signal);
  if (result?.ok === true && result.environment && typeof result.environment === 'object'
    && Object.values(result.environment).every((value) => typeof value === 'string')) return { ok: true, environment: result.environment };
  // A recovery later than the session's 30-minute background wait still holds the session off until that wait ends.
  return { ok: false, reason: typeof result?.reason === 'string' ? result.reason : 'REQUEST_FAILED', ...(Number.isSafeInteger(result?.retryAfterMs) && result.retryAfterMs > 0 ? { retryAfterMs: Math.min(result.retryAfterMs, 1800000) } : {}) };
}

/** Secret-free, authenticated quota evidence. An unanswered/old server never authorizes personal spending. */
export async function requestSetupTokenAvailability(sessionId: string, binding: string, personalConsent?: { proof: string; accountRef: string; nonce: string; purpose?: 'manual'; commit?: true }, organizationFailure?: { kind: 'authentication'; observedAt: number }): Promise<{ allLimited: boolean; availableAccountIds: string[]; consentApproved: boolean; fallbackReason?: 'quota-exhausted' | 'organization-authentication' | 'organization-lookup' }> {
    const result = await daemonPost('/setup-token/availability', { sessionId, binding, ...(personalConsent ? { personalConsent } : {}), ...(organizationFailure ? { organizationFailure } : {}) }, undefined, 30_000)
    if (result?.fallbackReason !== undefined && !['quota-exhausted', 'organization-authentication', 'organization-lookup'].includes(result.fallbackReason)) throw new Error('CLAUDE_ORGANIZATION_AVAILABILITY_UNCONFIRMED')
    if (result?.ok !== true || typeof result.allLimited !== 'boolean' || !Array.isArray(result.availableAccountIds)
        || !result.availableAccountIds.every((id: unknown) => typeof id === 'string')) throw new Error('CLAUDE_ORGANIZATION_AVAILABILITY_UNCONFIRMED')
    return { allLimited: result.allLimited, availableAccountIds: result.availableAccountIds, consentApproved: result.consentApproved === true, ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}) }
}
export async function returnFromPersonalClaude(sessionId: string, binding: string, organizationFailure?: { kind: 'authentication'; observedAt: number }): Promise<{ ok: true; environment: Record<string, string> } | { ok: false; reason: string }> {
    const result = await daemonPost('/setup-token/return', { sessionId, binding, ...(organizationFailure ? { organizationFailure } : {}) }, undefined, SETUP_TOKEN_REBIND_TIMEOUT_MS)
    if (result?.ok === true && result.environment && typeof result.environment === 'object' && Object.values(result.environment).every(value => typeof value === 'string'))
        return { ok: true, environment: result.environment }
    return { ok: false, reason: 'CLAUDE_ORGANIZATION_RETURN_UNCONFIRMED' }
}

/** Advisory organization turn load; never changes the binding. */
export async function reportSetupTokenActivity(sessionId: string, binding: string, activity: import('@slopus/happy-wire').SetupTokenActivity): Promise<{ ok: boolean; reason?: string }> {
  const result = await daemonPost('/setup-token/usage', { sessionId, binding, activity });
  return result?.ok === true ? { ok: true } : { ok: false, reason: result?.reason ?? 'REQUEST_FAILED' };
}
