import {
  classifyScriptRuntimeFailure, scriptRuntimeReadiness,
  type ScriptRuntimeCode, type ScriptRuntimeImageSource, type ScriptRuntimeReadiness,
} from './scriptRuntimeReadiness';

/** Delay before retry n (0-based); the last value repeats. Docker Desktop usually answers within a minute of login. */
const RETRY_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
const READY_PROBE_MS = 120_000;
/** One failed probe is a blip; two in a row withdraw protocol 5. */
const PROBE_FAILURES_BEFORE_LOSS = 2;
/** Only a restart with different configuration can fix these, so retrying just burns docker calls. */
const TERMINAL_CODES: ReadonlySet<ScriptRuntimeCode> = new Set([
  'IMAGE_MISSING', 'IMAGE_INVALID', 'STUDIO_CONFIG_MISSING', 'STUDIO_CONFIG_INVALID',
]);

type Worker = { tick(): Promise<void>; stop(): Promise<void> };

/**
 * Owns whether this machine advertises script automation protocol 5.
 *
 * `worker.tick()` runs a script inside the tick and `recover()` removes every labelled container,
 * so a probe or a repeated preflight must never overlap a tick: that would kill a run in flight.
 * The supervisor therefore only checks docker between ticks, and withdraws protocol 5 by no longer
 * calling `tick()` rather than by stopping the worker.
 */
export function createScriptRuntimeSupervisor(deps: {
  /** Resolves the image, checks configuration, docker and the isolation probe. Throws on any failure. */
  preflight(): Promise<{ image: string; source: ScriptRuntimeImageSource }>;
  /** Called once, after the first successful preflight. */
  createWorker(): Promise<Worker>;
  /** Cheap liveness check of the engine while ready. */
  probe(): Promise<void>;
  publish(readiness: ScriptRuntimeReadiness, protocolVersion: 4 | 5): void;
  now(): number;
  log(message: string): void;
}) {
  let worker: Worker | null = null;
  let ready = false;
  let busy = false;
  let stopped = false;
  let attempting: Promise<void> | null = null;
  let retries = 0;
  let probeFailures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastImage: { image: string; source: ScriptRuntimeImageSource } | undefined;

  const clearTimer = () => { if (timer) clearTimeout(timer); timer = null; };
  const schedule = (delay: number, run: () => void) => {
    clearTimer();
    if (stopped) return;
    timer = setTimeout(run, delay);
    timer.unref?.();
  };
  const markUnavailable = (code: ScriptRuntimeCode) => {
    ready = false;
    deps.publish(scriptRuntimeReadiness({ state: 'unavailable', code, now: deps.now(), image: lastImage }), 4);
  };
  const scheduleRetry = (code: ScriptRuntimeCode) => {
    if (TERMINAL_CODES.has(code)) return;
    schedule(RETRY_BACKOFF_MS[Math.min(retries, RETRY_BACKOFF_MS.length - 1)]!, () => { void attempt(); });
    retries += 1;
  };
  const scheduleProbe = () => schedule(READY_PROBE_MS, () => { void check(); });

  async function check() {
    if (stopped || !ready) return;
    if (busy) { scheduleProbe(); return; }
    try {
      await deps.probe();
      probeFailures = 0;
      scheduleProbe();
    } catch (error) {
      probeFailures += 1;
      if (probeFailures < PROBE_FAILURES_BEFORE_LOSS) { scheduleProbe(); return; }
      const code = classifyScriptRuntimeFailure(error);
      deps.log(`Script runtime lost (${code}); new runs are paused`);
      probeFailures = 0;
      retries = 0;
      markUnavailable(code);
      scheduleRetry(code);
    }
  }

  function attempt(): Promise<void> {
    if (attempting) return attempting;
    attempting = (async () => {
      try {
        lastImage = await deps.preflight();
        worker ??= await deps.createWorker();
        if (stopped) return;
        ready = true;
        retries = 0;
        probeFailures = 0;
        deps.publish(scriptRuntimeReadiness({ state: 'ready', now: deps.now(), image: lastImage }), 5);
        scheduleProbe();
      } catch (error) {
        if (stopped) return;
        const code = classifyScriptRuntimeFailure(error);
        deps.log(`Script runtime unavailable (${code}): ${error instanceof Error ? error.message : 'unknown error'}`);
        markUnavailable(code);
        scheduleRetry(code);
      } finally {
        attempting = null;
      }
    })();
    return attempting;
  }

  return {
    start: attempt,
    /** Claims new runs only while ready; a tick already running is never interrupted. */
    async tick() {
      if (!ready || !worker || busy) return;
      busy = true;
      try { await worker.tick(); } finally { busy = false; }
    },
    async stop() {
      stopped = true;
      clearTimer();
      if (attempting) await attempting.catch(() => undefined);
      await worker?.stop();
    },
  };
}
