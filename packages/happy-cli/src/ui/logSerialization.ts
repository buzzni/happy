/**
 * Pure formatting boundary for file logs. Keeping serialization independent
 * from filesystem writes makes content policy and rotation testable without
 * constructing a live CLI logger.
 */

import { inspect } from 'node:util'

export function formatLogLine(prefix: string, message: string, args: readonly unknown[]): string {
  return `${prefix} ${message} ${args.map(arg =>
    typeof arg === 'string' ? arg : inspect(arg, { depth: 5, breakLength: 120 })
  ).join(' ')}\n`
}
