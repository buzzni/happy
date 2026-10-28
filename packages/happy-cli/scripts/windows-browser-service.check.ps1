param([Parameter(Mandatory=$true)][string]$Source, [ValidateRange(0,60)][int]$ClientProbeSeconds = 0,
    [string]$Fence, [string]$NetworkProbeSource)
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
$fenced = $false
$listeners = @()
$udp = $null
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
    Assert ([IO.File]::ReadAllText($key) -cmatch '^[0-9a-f]{64}$') 'Credential does not match the runtime hex format'
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
    if ($Fence) {
        Stop-Service $name
        $probeExe = Join-Path $root 'probe.exe'
        & $compiler /nologo /warnaserror+ /target:exe /reference:System.ServiceProcess.dll /out:$probeExe $NetworkProbeSource
        Assert ($LASTEXITCODE -eq 0) 'Network probe compilation failed'
        $proxy = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Parse('127.0.0.1'),0)
        $proxy.Start(); $listeners += $proxy
        $port = $proxy.LocalEndpoint.Port
        $udp = New-Object Net.Sockets.UdpClient
        $udp.Client.Bind((New-Object Net.IPEndPoint([Net.IPAddress]::Loopback,$port)))
        $udp.Client.ReceiveTimeout = 1500
        function ReceivedDatagram {
            $sender = New-Object Net.IPEndPoint([Net.IPAddress]::Any,0)
            try { [void]$udp.Receive([ref]$sender); return $true }
            catch [Net.Sockets.SocketException] {
                if ($_.Exception.SocketErrorCode -eq [Net.Sockets.SocketError]::TimedOut) { return $false }
                throw
            }
        }
        $other = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Parse('127.0.0.1'),0)
        $other.Start(); $listeners += $other
        $address = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Parse('127.0.0.2'),$port)
        $address.Start(); $listeners += $address
        $ipv6 = New-Object Net.Sockets.TcpListener([Net.IPAddress]::IPv6Loopback,$port)
        $ipv6.Start(); $listeners += $ipv6
        [IO.File]::WriteAllLines((Join-Path $root 'probe-ports.txt'),[string[]]@($port,$other.LocalEndpoint.Port))
        InvokeServiceControl @('config',$name,'binPath=',$probeExe)
        $resultPath = Join-Path $state.FullName 'probe-result.txt'
        function ProbeNetwork {
            if (Test-Path $resultPath) { Remove-Item -LiteralPath $resultPath }
            Start-Service $name
            $deadline = (Get-Date).AddSeconds(15)
            while (!(Test-Path $resultPath) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
            Assert (Test-Path $resultPath) 'Network probe did not report'
            $result = [IO.File]::ReadAllText($resultPath)
            Stop-Service $name
            return $result
        }
        Assert ((ProbeNetwork) -eq 'True,True,True,True,True') 'Unfenced network baseline failed'
        Assert (ReceivedDatagram) 'Unfenced UDP packet did not arrive'
        & $Fence install $sid.Value $port
        Assert ($LASTEXITCODE -eq 0) 'Fence install failed'
        $fenced = $true
        & $Fence verify $sid.Value $port
        Assert ($LASTEXITCODE -eq 0) 'Fence did not persist after installer exit'
        Write-Output 'EXPECT refusal: duplicate policy installation'
        & $Fence install $sid.Value $port
        Assert ($LASTEXITCODE -ne 0) 'Fence replaced an existing policy'
        & $Fence verify $sid.Value $port
        Assert ($LASTEXITCODE -eq 0) 'Duplicate installation altered policy'
        $blocked = ProbeNetwork
        Assert ($blocked -match '^True,False,False,False,(True|False)$') ('Unexpected fenced connections: ' + $blocked)
        # UDP Send may succeed even when WFP drops the packet; observe the receiver.
        Assert (!(ReceivedDatagram)) 'Fenced UDP packet arrived'
        Write-Output 'EXPECT refusal: removal for a different port'
        & $Fence remove $sid.Value ($port + 1)
        Assert ($LASTEXITCODE -ne 0) 'Fence accepted a mismatched removal'
        & $Fence remove $sid.Value $port
        Assert ($LASTEXITCODE -eq 0) 'Fence removal failed'
        $fenced = $false
        Assert ((ProbeNetwork) -eq 'True,True,True,True,True') 'Network did not recover after removal'
        Assert (ReceivedDatagram) 'UDP did not recover after removal'
        InvokeServiceControl @('config',$name,'binPath=',('"' + $exe + '" --verification'))
        Start-Service $name
        Write-Output 'PASS WFP persistent policy, exact local proxy, other port/address/IPv6/UDP refusal, scope-checked removal, network restoration'
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
    if ($fenced) { & $Fence remove $sid.Value $port; Assert ($LASTEXITCODE -eq 0) 'Fence cleanup failed' }
    foreach ($listener in $listeners) { $listener.Stop() }
    if ($udp) { $udp.Dispose() }
    if ($created) {
        Stop-Service $name -ErrorAction SilentlyContinue
        InvokeServiceControl @('delete',$name)
    }
    # This path was exclusively created above; no user profile is touched.
    Remove-Item -LiteralPath $root -Recurse -Force
}
