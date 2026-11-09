/**
 * Studio setup-token routes the daemon calls with its machine credential (a shared PC sends its company's
 * token, not a member's). Studio's global auth gate (packages/web-ui/server/httpAuthGate.ts) admits only
 * member tokens unless a route is exempted there, so Saycode's tests read this list and fail when one is
 * missing (Saycode specs/daemon-studio-route-contract). Build these URLs only through this module: a route
 * that is not listed cannot be called, and a test rejects the prefix anywhere else in src.
 *
 * Self-contained on purpose: Saycode copies this file into its image for a production probe.
 */
export const STUDIO_MACHINE_ROUTE_PREFIX = '/api/claude-setup-token/'

/** The capacity lifecycle a member's turn runs through (its actor proof is issued under the member gate). */
export const STUDIO_CAPACITY_OPERATIONS = ['reserve', 'observe', 'claim', 'heartbeat', 'finish', 'cancel', 'recover', 'lost', 'delivery'] as const
export type StudioCapacityOperation = typeof STUDIO_CAPACITY_OPERATIONS[number]

export const STUDIO_MACHINE_ROUTES = {
  'daemon/start': 'POST',
  'daemon/usage': 'POST',
  'daemon/rebind': 'POST',
  'daemon/availability': 'POST',
  'daemon/return': 'POST',
  'daemon/measure/reserve': 'POST',
  'daemon/measure/publish': 'POST',
  'daemon/shared/select': 'POST',
  'daemon/shared/start': 'POST',
  'daemon/shared/measure/reserve': 'POST',
  'daemon/shared/measure/publish': 'POST',
  'daemon/collect/due': 'POST',
  'daemon/collect/reserve': 'POST',
  'daemon/collect/publish': 'POST',
  // Machine-v2: the signed request paths themselves are fixed by happy-wire's sharedMachineRotation.
  'daemon/v2/public-key': 'GET',
  'daemon/v2/acceptance': 'GET',
  'daemon/v2/issue': 'POST',
  'daemon/v2/claim': 'POST',
  'daemon/v2/commit': 'POST',
  'daemon/v2/start': 'POST',
  'daemon/v2/usage': 'POST',
  'daemon/v2/rebind': 'POST',
  'daemon/v2/operation': 'POST',
  'capacity/reserve': 'POST',
  'capacity/observe': 'POST',
  'capacity/claim': 'POST',
  'capacity/heartbeat': 'POST',
  'capacity/finish': 'POST',
  'capacity/cancel': 'POST',
  'capacity/recover': 'POST',
  'capacity/lost': 'POST',
  'capacity/delivery': 'POST',
} as const satisfies Record<string, 'GET' | 'POST'>

export type StudioMachineRoute = keyof typeof STUDIO_MACHINE_ROUTES
/** The part after `daemon/`, for callers that only talk to the daemon routes. */
export type StudioDaemonRoute = StudioMachineRoute extends infer R ? R extends `daemon/${infer Rest}` ? Rest : never : never

export function studioMachineRoutePath(route: StudioMachineRoute): string {
  return STUDIO_MACHINE_ROUTE_PREFIX + route
}

export function studioMachineRouteUrl(origin: string, route: StudioMachineRoute): string {
  return origin + studioMachineRoutePath(route)
}
