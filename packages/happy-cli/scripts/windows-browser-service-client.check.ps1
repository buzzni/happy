$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this check as a non-administrator' }
$key = Join-Path $env:ProgramData 'SaycodeBrowserRuntimeVerification\state\agent.key'
$denied = $false
try { [void][IO.File]::ReadAllBytes($key) } catch [UnauthorizedAccessException] { $denied = $true }
if (!$denied) { throw 'Non-administrator could read service credentials' }
$name = 'SaycodeBrowserRuntimeVerification-status-v1'
# Abrupt clients must not stop the service or poison its next response.
for ($i=0; $i -lt 3; $i++) {
    $pipe = New-Object IO.Pipes.NamedPipeClientStream('.', $name, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
    try { $pipe.Connect(5000) } finally { $pipe.Dispose() }
    Start-Sleep -Milliseconds 100
}
$pipe = New-Object IO.Pipes.NamedPipeClientStream('.', $name, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
try {
    $pipe.Connect(5000)
    $bytes = New-Object byte[] 512
    $count = 0
    do {
        if ($count -eq $bytes.Length) { throw 'Oversized status' }
        $read = $pipe.ReadAsync($bytes,$count,1)
        if (!$read.Wait(5000) -or $read.Result -ne 1) { throw 'Incomplete status' }
        $count++
    } while ($bytes[$count-1] -ne 10)
    $pipe.WriteByte(1)
    $status = [Text.Encoding]::UTF8.GetString($bytes,0,$count) | ConvertFrom-Json
    if ($status.version -ne 1 -or $status.runtimeReady -ne $false -or $status.principal -notmatch '^S-1-5-80-') { throw 'Invalid service status' }
    if (@($status.PSObject.Properties.Name).Count -ne 4) { throw 'Unexpected status fields' }
    Write-Output 'PASS non-admin key access denied, public status, disconnected client recovery'
} finally { $pipe.Dispose() }
