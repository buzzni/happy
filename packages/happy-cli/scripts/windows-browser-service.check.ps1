param([Parameter(Mandatory=$true)][string]$Source, [ValidateRange(0,60)][int]$ClientProbeSeconds = 0)
$ErrorActionPreference = 'Stop'
$name = 'SaycodeBrowserRuntimeVerification'
$root = Join-Path $env:ProgramData $name
$exe = Join-Path $root 'host.exe'
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
function Assert($condition, $message) { if (!$condition) { throw $message } }
function InvokeServiceControl {
    & "$env:SystemRoot\System32\sc.exe" @args | Out-Host
    Assert ($LASTEXITCODE -eq 0) ('SCM failed: ' + $args[0])
}
Assert ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) 'Administrator required'
Assert (!(Test-Path -LiteralPath $root)) 'Verification directory already exists; refusing to overwrite'
Assert (!(Get-Service -Name $name -ErrorAction SilentlyContinue)) 'Verification service already exists'
# Create with a protected ACL atomically, before placing executable content.
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
$admin = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$acl.SetOwner($admin)
foreach ($id in @('S-1-5-18','S-1-5-32-544')) {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($id)),'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
}
$directory = New-Object IO.DirectoryInfo($root)
$directory.Create($acl)
$created = $false
try {
    & $compiler /nologo /warnaserror+ /target:exe /reference:System.ServiceProcess.dll /out:$exe $Source
    Assert ($LASTEXITCODE -eq 0) 'Service compilation failed'
    InvokeServiceControl @('create',$name,'binPath=',('"' + $exe + '" --verification'),'start=','demand','obj=',('NT SERVICE\' + $name))
    $created = $true
    InvokeServiceControl @('sidtype',$name,'unrestricted')
    $sid = (New-Object Security.Principal.NTAccount('NT SERVICE',$name)).Translate([Security.Principal.SecurityIdentifier])
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')))
    $directory.SetAccessControl($acl)
    $state = New-Object IO.DirectoryInfo((Join-Path $root 'state'))
    $private = New-Object Security.AccessControl.DirectorySecurity
    $private.SetOwner($admin); $private.SetAccessRuleProtection($true,$false)
    foreach ($id in @($sid.Value,'S-1-5-18','S-1-5-32-544')) {
        $private.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($id)),'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
    }
    $state.Create($private)
    try { Start-Service $name } catch { & "$env:SystemRoot\System32\sc.exe" query $name | Out-Host; throw }
    (Get-Service $name).WaitForStatus('Running',[TimeSpan]::FromSeconds(15))
    $first = (& $exe --probe-verification | ConvertFrom-Json)
    Assert ($LASTEXITCODE -eq 0 -and $first.principal -eq $sid.Value -and $first.runtimeReady -eq $false) 'Dedicated service identity/status failed'
    $key = Join-Path $state.FullName 'agent.key'
    $hash = (Get-FileHash -LiteralPath $key -Algorithm SHA256).Hash
    Restart-Service $name
    (Get-Service $name).WaitForStatus('Running',[TimeSpan]::FromSeconds(15))
    $second = (& $exe --probe-verification | ConvertFrom-Json)
    Assert ($LASTEXITCODE -eq 0 -and $first.generation -ne $second.generation) 'Restart generation did not change'
    Assert ((Get-FileHash -LiteralPath $key -Algorithm SHA256).Hash -eq $hash) 'Credential changed across restart'
    $serviceProcessId = (Get-CimInstance Win32_Service -Filter "Name='$name'").ProcessId
    $process = [Diagnostics.Process]::GetProcessById($serviceProcessId)
    try {
        [void]$process.Handle
        Assert ($process.MainModule.FileName -eq $exe) 'Unexpected service process'
        $process.Kill()
        Assert ($process.WaitForExit(5000)) 'Service process did not exit'
    } finally { $process.Dispose() }
    (Get-Service $name).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(15))
    Start-Service $name
    (Get-Service $name).WaitForStatus('Running',[TimeSpan]::FromSeconds(15))
    $recovered = (& $exe --probe-verification | ConvertFrom-Json)
    Assert ($LASTEXITCODE -eq 0 -and $recovered.generation -ne $second.generation) 'Crash generation did not change'
    Assert ((Get-FileHash -LiteralPath $key -Algorithm SHA256).Hash -eq $hash) 'Credential changed after crash'
    Stop-Service $name
    $squatter = New-Object IO.Pipes.NamedPipeServerStream(($name + '-status-v1'))
    try {
        $refused = $false
        try { Start-Service $name } catch { $refused = $true }
        Assert $refused 'Service accepted an occupied status pipe'
    } finally { $squatter.Dispose() }
    Start-Service $name
    (Get-Service $name).WaitForStatus('Running',[TimeSpan]::FromSeconds(15))
    if ($ClientProbeSeconds -gt 0) {
        Write-Output 'READY for non-administrator client check'
        Start-Sleep -Seconds $ClientProbeSeconds
    }
    # Broaden only the synthetic test key. The service must refuse to start.
    Stop-Service $name
    $fileAcl = [IO.File]::GetAccessControl($key)
    $fileAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-1-0')),'Read','Allow')))
    [IO.File]::SetAccessControl($key,$fileAcl)
    $refused = $false
    try { Start-Service $name } catch { $refused = $true }
    Assert $refused 'Service accepted public credential access'
    Write-Output 'PASS dedicated SID, service IPC, restart/crash custody, pipe squatting refusal, unsafe ACL refusal'
} finally {
    if ($created) {
        Stop-Service $name -ErrorAction SilentlyContinue
        InvokeServiceControl @('delete',$name)
    }
    # This path was exclusively created above; no user profile is touched.
    Remove-Item -LiteralPath $root -Recurse -Force
}
