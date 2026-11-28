# Windows deployment helpers. Invoked by the repository's .bat entry points.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Deploy', 'Dev', 'Stop')]
    [string]$Mode,
    [ValidateRange(1, 65535)]
    [int]$Port = 3000,
    [ValidateRange(1, 65535)]
    [int]$ClientPort = 5173,
    [switch]$BackendOnly,
    [switch]$SkipInstall
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$AppRoot = Split-Path -Parent $PSScriptRoot
$ServerDir = Join-Path $AppRoot 'server'
$ClientDir = Join-Path $AppRoot 'client'
$BackendEntry = Join-Path $ServerDir 'index.js'
$FrontendEntry = Join-Path $ClientDir 'node_modules\vite\bin\vite.js'

function Get-Listeners([int]$ListenPort) {
    # Read the local port field exactly, never a substring or the remote peer port.
    @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $ListenPort })
}
function Assert-FreePort([int]$ListenPort) {
    if (@(Get-Listeners $ListenPort).Count -gt 0) {
        throw "Port $ListenPort is already in use. Stop its owner explicitly or choose another port."
    }
}
function Assert-DependenciesAreIdle {
    # The requested ports may be free while another instance is using this checkout's DLLs.
    $roots = @(
        (Join-Path $ServerDir 'node_modules') + '\'
        (Join-Path $ClientDir 'node_modules') + '\'
    )
    foreach ($nodeProcess in @(Get-Process -Name node -ErrorAction SilentlyContinue)) {
        try { $modules = $nodeProcess.Modules } catch { continue }
        foreach ($module in $modules) {
            foreach ($root in $roots) {
                if ($module.FileName -and $module.FileName.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
                    $ports = @(Get-NetTCPConnection -OwningProcess $nodeProcess.Id -State Listen -ErrorAction SilentlyContinue |
                        Select-Object -ExpandProperty LocalPort -Unique)
                    $binding = if ($ports.Count -gt 0) { ' (listening on port ' + ($ports -join ', ') + ')' } else { '' }
                    throw "Cannot run npm ci: Node PID $($nodeProcess.Id)$binding is using this checkout's native dependencies. Close it in its original terminal (Ctrl+C), then retry."
                }
            }
        }
    }
}
function Get-OwnedNodeProcess([int]$ProcessId, [string]$Entry) {
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    if ($null -eq $candidate -or $candidate.Name -ine 'node.exe') { return $null }
    # Match the main script immediately after the Node executable, not an arbitrary argument.
    $entryToken = '"' + [regex]::Escape($Entry) + '"'
    if ($Entry -notmatch '\s') { $entryToken += '|' + [regex]::Escape($Entry) }
    $entryPattern = '^\s*(?:"[^"]+"|[^\s"]+)\s+(?:' + $entryToken + ')(?=\s|$)'
    if ($candidate.CommandLine -notmatch $entryPattern) { return $null }
    return $candidate
}
function Invoke-Npm([string]$Directory, [string[]]$NpmArguments) {
    Push-Location -LiteralPath $Directory
    try {
        & $script:NpmPath @NpmArguments
        if ($LASTEXITCODE -ne 0) { throw "npm $NpmArguments failed in $Directory (exit $LASTEXITCODE)" }
    } finally { Pop-Location }
}
function Assert-NativeRuntime {
    & $script:NodePath (Join-Path $PSScriptRoot 'check-runtime.cjs') --server --sharp
    if ($LASTEXITCODE -ne 0) { throw 'sharp native encode/decode failed; deployment stopped.' }
}
function Wait-ForBackend([System.Diagnostics.Process]$BackendProcess, [int]$ListenPort) {
    $healthUrl = 'http://127.0.0.1:' + $ListenPort + '/api/health'
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $BackendProcess.Refresh()
        if ($BackendProcess.HasExited) { throw 'Backend exited. Check the server window for errors.' }
        $ownedListener = @(Get-Listeners $ListenPort | Where-Object { $_.OwningProcess -eq $BackendProcess.Id })
        if ($ownedListener.Count -gt 0) {
            try {
                $response = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
                if ($response.ok -eq $true) { return }
            } catch { }
        }
        Start-Sleep -Milliseconds 500
    }
    throw "Backend did not become healthy at $healthUrl. Check the server window; no successful startup is reported."
}
function Wait-ForFrontend([System.Diagnostics.Process]$FrontendProcess, [int]$ListenPort) {
    $frontendUrl = 'http://127.0.0.1:' + $ListenPort + '/'
    $healthUrl = $frontendUrl + 'api/health'
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $FrontendProcess.Refresh()
        if ($FrontendProcess.HasExited) { throw 'Frontend exited. Check its window for errors.' }
        $ownedListener = @(Get-Listeners $ListenPort | Where-Object { $_.OwningProcess -eq $FrontendProcess.Id })
        if ($ownedListener.Count -gt 0) {
            try {
                $page = Invoke-WebRequest -Uri $frontendUrl -UseBasicParsing -TimeoutSec 2
                $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
                if ($page.StatusCode -eq 200 -and $health.ok -eq $true) { return }
            } catch { }
        }
        Start-Sleep -Milliseconds 500
    }
    throw "Frontend or its API proxy did not become healthy at $frontendUrl. Check the frontend window and backend port $Port."
}
function Stop-StartedProcess([System.Diagnostics.Process]$StartedProcess) {
    if ($null -eq $StartedProcess) { return }
    try {
        $StartedProcess.Refresh()
        if (-not $StartedProcess.HasExited) {
            # The process handle comes only from this invocation's Start-Process.
            Stop-Process -InputObject $StartedProcess -ErrorAction Stop
        }
    } catch { Write-Warning "Could not clean up started process $($StartedProcess.Id): $($_.Exception.Message)" }
}

$backend = $null
$frontend = $null
try {
    if ((($Mode -eq 'Dev' -and -not $BackendOnly) -or ($Mode -eq 'Stop' -and $PSBoundParameters.ContainsKey('ClientPort'))) -and $Port -eq $ClientPort) {
        throw 'Backend and frontend must use different ports. Choose --port and --client-port explicitly.'
    }
    if ($Mode -eq 'Stop') {
        $targets = @(@{ Port = $Port; Entry = $BackendEntry; Name = 'backend' })
        if ($PSBoundParameters.ContainsKey('ClientPort')) {
            $targets += @{ Port = $ClientPort; Entry = $FrontendEntry; Name = 'frontend' }
        }
        # Validate all requested listeners before stopping any process.
        $owned = @(foreach ($target in $targets) {
            $owners = @(Get-Listeners $target.Port | Select-Object -ExpandProperty OwningProcess -Unique)
            if ($owners.Count -eq 0) { Write-Host "No listener on port $($target.Port)." }
            foreach ($ownerId in $owners) {
                $process = Get-OwnedNodeProcess $ownerId $target.Entry
                if ($null -eq $process) { throw "Port $($target.Port) belongs to another project or cannot be verified (PID $ownerId). Refusing to stop it." }
                @{ Process = $process; Name = $target.Name }
            }
        })
        foreach ($item in $owned) {
            # Stop only a PID whose Node entry belongs to this checkout.
            Write-Warning 'Windows process stop may interrupt pending writes. Back up data before maintenance.'
            Stop-Process -Id $item.Process.ProcessId -ErrorAction Stop
            Write-Host "Stopped this project's $($item.Name) (PID $($item.Process.ProcessId))."
        }
        exit 0
    }

    $script:NodePath = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    if (-not $SkipInstall -or ($Mode -eq 'Deploy' -and -not $BackendOnly)) { $script:NpmPath = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
    & $script:NodePath (Join-Path $PSScriptRoot 'check-runtime.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Node.js >=22.13.0 is required.' }
    $directories = @($ServerDir)
    if (-not $BackendOnly) { $directories += $ClientDir }
    foreach ($directory in $directories) {
        if (-not (Test-Path -LiteralPath (Join-Path $directory 'package-lock.json') -PathType Leaf)) {
            throw "Missing package-lock.json in $directory"
        }
    }
    Assert-FreePort $Port
    if ($Mode -eq 'Dev' -and -not $BackendOnly) { Assert-FreePort $ClientPort }
    if (-not $SkipInstall) {
        Assert-DependenciesAreIdle
        Invoke-Npm $ServerDir @('ci', '--omit=dev', '--include=optional')
        if (-not $BackendOnly) { Invoke-Npm $ClientDir @('ci', '--include=dev', '--include=optional') }
    }
    Assert-NativeRuntime
    if (-not $BackendOnly) {
        & $script:NodePath (Join-Path $PSScriptRoot 'check-runtime.cjs') --client
        if ($LASTEXITCODE -ne 0) { throw 'Client dependencies are missing. Retry without --skip-install.' }
    }
    if ($Mode -eq 'Deploy' -and -not $BackendOnly) {
        Invoke-Npm $ClientDir @('run', 'build')
        if (-not (Test-Path -LiteralPath (Join-Path $ClientDir 'dist\index.html') -PathType Leaf)) {
            throw 'Frontend build output is missing.'
        }
    }

    # Installation/build can take time; check again before spawning any child.
    Assert-FreePort $Port
    if ($Mode -eq 'Dev' -and -not $BackendOnly) { Assert-FreePort $ClientPort }

    # Child processes inherit these settings. Never trigger KEEP_DB=0's rebuild.
    $env:PORT = [string]$Port
    $env:KEEP_DB = '1'
    $env:SERVE_CLIENT = if ($BackendOnly -or $Mode -eq 'Dev') { '0' } else { '1' }
    if (-not $env:HOST) { $env:HOST = '127.0.0.1' }
    if ($Mode -eq 'Dev') {
        $env:HOST = '127.0.0.1'
        $env:NODE_ENV = 'development'
        $env:VITE_BACKEND_PORT = [string]$Port
        $env:BACKEND_ORIGIN = 'http://127.0.0.1:' + $Port
        $env:VITE_PORT = [string]$ClientPort
    }
    else { $env:NODE_ENV = 'production' }
    $backend = Start-Process -FilePath $script:NodePath -ArgumentList ('"' + $BackendEntry + '"') -WorkingDirectory $ServerDir -PassThru
    Wait-ForBackend $backend $Port
    if ($Mode -eq 'Dev' -and -not $BackendOnly) {
        $frontend = Start-Process -FilePath $script:NodePath -ArgumentList @(('"' + $FrontendEntry + '"'), '--host', '127.0.0.1', '--port', [string]$ClientPort, '--strictPort') -WorkingDirectory $ClientDir -PassThru
        Wait-ForFrontend $frontend $ClientPort
        Write-Host "Development frontend: http://127.0.0.1:$ClientPort"
        Write-Host "Use stop.bat --port $Port --client-port $ClientPort to stop both processes."
    } else {
        if ($BackendOnly) { Write-Host "API: http://127.0.0.1:$Port/api/health" }
        else { Write-Host "Frontend: http://127.0.0.1:$Port" }
        Write-Host "Use stop.bat --port $Port to stop this backend."
    }
    Write-Host "Dashboard: http://127.0.0.1:$Port/dashboard"
    Write-Host 'No default account. Complete first-time setup locally before exposing the site.'
    Write-Host "Backend listen address: $($env:HOST):$Port"
    exit 0
} catch {
    Stop-StartedProcess $frontend
    Stop-StartedProcess $backend
    Write-Error $_ -ErrorAction Continue
    exit 1
}
