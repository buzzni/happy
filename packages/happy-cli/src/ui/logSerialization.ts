/**
 * Pure formatting boundary for file logs. Keeping serialization independent
 * from filesystem writes makes content policy and rotation testable without
 * constructing a live CLI logger.
 */

import { inspect } from 'node:util'

const SENSITIVE_LOG_KEY = /(^|_)(authorization|token|secret|password|passphrase|api_key|private_key|encryption_key|access_key)($|_)/i

function normalizeLogKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^a-zA-Z0-9]+/g, '_')
}

function sanitizeLogValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (!value || typeof value !== 'object') return value
  const existing = seen.get(value)
  if (existing) return existing
  if (value instanceof Date || value instanceof Uint8Array) return value
  if (value instanceof Error) return sanitizeLogError(value, seen)

  if (Array.isArray(value)) {
    const sanitized: unknown[] = []
    seen.set(value, sanitized)
    for (const item of value) sanitized.push(sanitizeLogValue(item, seen))
    return sanitized
  }

  const sanitized: Record<string, unknown> = {}
  seen.set(value, sanitized)
  for (const [key, item] of Object.entries(value)) {
    sanitized[key] = SENSITIVE_LOG_KEY.test(normalizeLogKey(key))
      ? '[REDACTED]'
      : sanitizeLogValue(item, seen)
  }
  return sanitized
}

/**
 * An error is kept as an error — message, name and stack are what a log line
 * is for — but its **enumerable own properties** go through the same rule as
 * any object. An HTTP client error carries the request it was made with,
 * headers included, and dumped raw on a 401 the log held the bearer that had
 * just been refused.
 */
function sanitizeLogError(error: Error, seen: WeakMap<object, unknown>): Error {
  const keys = Object.keys(error)
  if (keys.length === 0) return error
  // A real Error, so `inspect` prints it as one: the stack first, then the
  // enumerable properties, exactly as the unsanitized error would print.
  const sanitized = new Error(error.message)
  seen.set(error, sanitized)
  sanitized.name = error.name
  if (typeof error.stack === 'string') sanitized.stack = error.stack
  for (const key of keys) {
    if (key === 'name' || key === 'message' || key === 'stack') continue
    Object.defineProperty(sanitized, key, {
      value: SENSITIVE_LOG_KEY.test(normalizeLogKey(key))
        ? '[REDACTED]'
        : sanitizeLogValue((error as unknown as Record<string, unknown>)[key], seen),
      enumerable: true, configurable: true, writable: true,
    })
  }
  return sanitized
}

export function sanitizeLogArgs(args: readonly unknown[]): unknown[] {
  const seen = new WeakMap<object, unknown>()
  return args.map(arg => sanitizeLogValue(arg, seen))
}

export function formatLogLine(prefix: string, message: string, args: readonly unknown[]): string {
  return `${prefix} ${message} ${sanitizeLogArgs(args).map(arg =>
    typeof arg === 'string' ? arg : inspect(arg, { depth: 5, breakLength: 120 })
  ).join(' ')}\n`
}
