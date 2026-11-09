import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DAEMON_ROTATION_PATHS } from '@slopus/happy-wire'
import { STUDIO_CAPACITY_OPERATIONS, STUDIO_MACHINE_ROUTE_PREFIX, STUDIO_MACHINE_ROUTES, studioMachineRoutePath } from './studioMachineRoutes'

const SRC = join(__dirname, '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path)
    return /\.(ts|tsx|mts|cts)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe('studio machine routes', () => {
  it('is the only source file that spells a setup-token route, so a new route cannot skip the list Saycode checks', () => {
    const offenders = sourceFiles(SRC)
      .filter(path => !path.endsWith(join('daemon', 'studioMachineRoutes.ts')))
      .filter(path => readFileSync(path, 'utf8').includes(STUDIO_MACHINE_ROUTE_PREFIX))
      .map(path => relative(SRC, path))
    expect(offenders).toEqual([])
  })

  it('lists every signed machine-v2 request path', () => {
    const listed = Object.keys(STUDIO_MACHINE_ROUTES).map(route => studioMachineRoutePath(route as keyof typeof STUDIO_MACHINE_ROUTES))
    expect(listed).toEqual(expect.arrayContaining(Object.values(DAEMON_ROTATION_PATHS)))
  })

  it('lists exactly the capacity operations the control server accepts', () => {
    const capacity = Object.keys(STUDIO_MACHINE_ROUTES).filter(route => route.startsWith('capacity/')).map(route => route.slice('capacity/'.length))
    expect(capacity).toEqual([...STUDIO_CAPACITY_OPERATIONS])
  })
})
