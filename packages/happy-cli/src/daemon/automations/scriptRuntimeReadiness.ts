import { ScriptRequestError } from './scriptAutomationWorker';

/**
 * Why a machine does or does not advertise script automation protocol 5.
 * Enums only: the value is published in machine metadata, so it must never carry
 * paths, URLs, image names or error text.
 */
export const SCRIPT_RUNTIME_CODES = [
  'IMAGE_MISSING', 'IMAGE_INVALID', 'STUDIO_CONFIG_MISSING', 'STUDIO_CONFIG_INVALID',
  'DOCKER_UNAVAILABLE', 'ENGINE_UNSUPPORTED', 'PROBE_FAILED',
  'SERVER_DISABLED', 'SERVER_UNAVAILABLE', 'MANAGED_RUNTIME', 'DISABLED', 'UNKNOWN',
] as const;
export type ScriptRuntimeCode = (typeof SCRIPT_RUNTIME_CODES)[number];

export type ScriptRuntimeImageSource = 'env' | 'release';
export type ScriptRuntimeReadiness = {
  state: 'ready' | 'unavailable' | 'disabled';
  code?: ScriptRuntimeCode;
  checkedAt: number;
  imageSource?: ScriptRuntimeImageSource;
  /** First 12 hex characters of the image digest: enough to compare expected and actual, not a pullable reference. */
  imageFingerprint?: string;
};

/**
 * Node 24.19.0 on Alpine, pinned by its multi-arch index digest (linux/amd64 and linux/arm64),
 * so a daemon started by Desktop needs no shell environment. Changing it is a release decision:
 * the runner's isolation probe (Node >= 24.5, uid 65534) must pass against the new image.
 */
export const SCRIPT_RUNTIME_RELEASE_IMAGE = 'node@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43';

const IMMUTABLE_IMAGE = /^(?:sha256:|[\w./:-]+@sha256:)([a-f0-9]{64})$/;

export function isImmutableScriptImage(image: string): boolean {
  return IMMUTABLE_IMAGE.test(image);
}

export type ResolvedScriptRuntimeImage =
  | { ok: true; image: string; source: ScriptRuntimeImageSource }
  | { ok: false; code: 'IMAGE_INVALID' };

/** An operator override wins, but a bad override is an error, never a silent fallback to the release image. */
export function resolveScriptRuntimeImage(env: NodeJS.ProcessEnv): ResolvedScriptRuntimeImage {
  const override = env.HAPPY_SCRIPT_RUNTIME_IMAGE?.trim();
  if (!override) return { ok: true, image: SCRIPT_RUNTIME_RELEASE_IMAGE, source: 'release' };
  return isImmutableScriptImage(override) ? { ok: true, image: override, source: 'env' } : { ok: false, code: 'IMAGE_INVALID' };
}

// Docker CLI wording differs by version and platform; all of these mean "no usable engine", not "bad probe".
const DOCKER_ENGINE_UNREACHABLE = /connect to the docker (?:api|daemon)|error during connect|docker\.sock/i;

const SETUP_FAILURES: Record<string, ScriptRuntimeCode> = {
  SCRIPT_RUNTIME_IMAGE_REQUIRED: 'IMAGE_MISSING',
  IMMUTABLE_IMAGE_REQUIRED: 'IMAGE_INVALID',
  SCRIPT_STUDIO_AUTHORIZATION_REQUIRED: 'STUDIO_CONFIG_MISSING',
  SCRIPT_STUDIO_HTTPS_REQUIRED: 'STUDIO_CONFIG_INVALID',
  SCRIPT_LINUX_RUNTIME_REQUIRED: 'ENGINE_UNSUPPORTED',
  SCRIPT_RUNTIME_PREFLIGHT_FAILED: 'PROBE_FAILED',
};

export function classifyScriptRuntimeFailure(error: unknown): ScriptRuntimeCode {
  if (error instanceof ScriptRequestError) {
    return error.status === 404 && error.code === 'SCRIPT_AUTOMATIONS_DISABLED' ? 'SERVER_DISABLED' : 'SERVER_UNAVAILABLE';
  }
  if (!(error instanceof Error)) return 'UNKNOWN';
  const known = SETUP_FAILURES[error.message];
  if (known) return known;
  const { code, stderr } = error as Error & { code?: unknown; stderr?: unknown };
  if (code === 'ENOENT' || (typeof stderr === 'string' && DOCKER_ENGINE_UNREACHABLE.test(stderr))) {
    return 'DOCKER_UNAVAILABLE';
  }
  return 'UNKNOWN';
}

export function scriptRuntimeReadiness(input: {
  state: ScriptRuntimeReadiness['state'];
  code?: ScriptRuntimeCode;
  now: number;
  image?: { image: string; source: ScriptRuntimeImageSource };
}): ScriptRuntimeReadiness {
  const digest = input.image ? IMMUTABLE_IMAGE.exec(input.image.image)?.[1] : undefined;
  return {
    state: input.state,
    ...(input.code ? { code: input.code } : {}),
    checkedAt: input.now,
    ...(digest && input.image ? { imageSource: input.image.source, imageFingerprint: digest.slice(0, 12) } : {}),
  };
}

/** Identity of what a client would observe, so a periodic re-check republishes only on a real change. */
export function scriptRuntimeReadinessKey(readiness: ScriptRuntimeReadiness): string {
  return [readiness.state, readiness.code ?? '', readiness.imageSource ?? '', readiness.imageFingerprint ?? ''].join('|');
}
