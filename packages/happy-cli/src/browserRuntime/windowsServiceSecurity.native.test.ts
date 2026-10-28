import { spawnSync } from 'node:child_process'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { expect, it } from 'vitest'
import { nativeHostBindingPath, readNativeProcessPrincipal } from './nativeHostPrimitives'

// Real Windows token/DACL test. Only this disposable directory is modified.
it.skipIf(process.platform !== 'win32')('checks actual process SID and refuses credentials readable by another principal', async () => {
    const principal = readNativeProcessPrincipal(process.pid)!
    expect(principal).toMatch(/^S-1-5-/)
    const dir = await mkdtemp(join(tmpdir(), 'abp-service-acl-')), path = join(dir, 'credential')
    const native = createRequire(import.meta.url)(nativeHostBindingPath()) as { verifyServiceFile(fd: number, sid: string, privateFile: boolean): void }
    try {
        await writeFile(path, 'synthetic-credential', { flag: 'wx' })
        const set = (broaden: boolean) => {
            const script = `
                $ErrorActionPreference = 'Stop'
                $path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(path).toString('base64')}'))
                $sid = New-Object Security.Principal.SecurityIdentifier('${principal}')
                $acl = New-Object Security.AccessControl.FileSecurity
                $acl.SetOwner($sid)
                $acl.SetAccessRuleProtection($true, $false)
                foreach ($identity in @($sid.Value, 'S-1-5-18')) {
                    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($identity)), 'FullControl', 'Allow')))
                }
                ${broaden ? "$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-1-0')), 'Read', 'Allow')))" : ''}
                Set-Acl -LiteralPath $path -AclObject $acl
            `
            const result = spawnSync(join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
                ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 15000 })
            expect(result.error).toBeUndefined()
            expect(result.status, result.stderr).toBe(0)
        }
        set(false)
        let file = await open(path, 'r')
        try { expect(() => native.verifyServiceFile(file.fd, principal, true)).not.toThrow() } finally { await file.close() }
        set(true)
        file = await open(path, 'r')
        try {
            expect(() => native.verifyServiceFile(file.fd, principal, true)).toThrow()
            // Public read is allowed for executable content, never public modification.
            expect(() => native.verifyServiceFile(file.fd, principal, false)).not.toThrow()
        } finally { await file.close() }
    } finally { await rm(dir, { recursive: true, force: true }) }
})
