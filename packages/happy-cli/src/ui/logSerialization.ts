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
  if (value instanceof Date || value instanceof Error || value instanceof Uint8Array) return value

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

export function sanitizeLogArgs(args: readonly unknown[]): unknown[] {
  const seen = new WeakMap<object, unknown>()
  return args.map(arg => sanitizeLogValue(arg, seen))
}

export function formatLogLine(prefix: string, message: string, args: readonly unknown[]): string {
  return `${prefix} ${message} ${sanitizeLogArgs(args).map(arg =>
    typeof arg === 'string' ? arg : inspect(arg, { depth: 5, breakLength: 120 })
  ).join(' ')}\n`
}
