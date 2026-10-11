import { describe, expect, it } from 'vitest'
import { rootDaemonWarning } from './rootDaemonWarning'

// Desktop specs/headless-standalone-server R20 (T31): warn, do not refuse, and do not change the
// permission mode behind the user's back.
describe('rootDaemonWarning', () => {
  it('warns a root daemon that would skip permission prompts', () => {
    const warning = rootDaemonWarning(0)
    expect(warning).toMatch(/root/)
    expect(warning).toMatch(/regular user/)
  })

  it('stays quiet for regular users and platforms without uids', () => {
    expect(rootDaemonWarning(1000)).toBeNull()
    expect(rootDaemonWarning(undefined)).toBeNull()
  })
})
