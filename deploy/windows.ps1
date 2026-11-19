# Windows deployment helpers. Invoked by the repository's .bat entry points.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Deploy', 'Dev', 'Stop')]
    [string]$Mode,
    [ValidateRange(1, 65535)]
    [int]$Port = 3000
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
function Get-OwnedBackend([int]$ProcessId) {
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    if ($null -eq $candidate -or $candidate.Name -ine 'node.exe') { return $null }
    $entryPattern = '(?:^|\s)"?' + [regex]::Escape($BackendEntry) + '"?(?:\s|$)'
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
    & $script:NodePath (Join-Path $PSScriptRoot 'check-runtime.cjs') --sharp
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
    throw 'Backend did not become healthy. Check the server window; no successful startup is reported.'
}

try {
    if ($Mode -eq 'Stop') {
        $owners = @(Get-Listeners $Port | Select-Object -ExpandProperty OwningProcess -Unique)
        if ($owners.Count -eq 0) { Write-Host "No listener on port $Port."; exit 0 }
        # Validate every owner before stopping any process. No global node.exe kill.
        $owned = @($owners | ForEach-Object {
            $process = Get-OwnedBackend $_
            if ($null -eq $process) { throw "Port $Port belongs to another project or cannot be verified (PID $_). Refusing to stop it." }
            $process
        })
        foreach ($process in $owned) {
            # Closing the console can force termination on Windows. Stop only the verified PID.
            Write-Warning 'Windows process stop may interrupt pending writes. Back up data before maintenance.'
            Stop-Process -Id $process.ProcessId -ErrorAction Stop
            Write-Host "Stopped this project's backend (PID $($process.ProcessId))."
        }
        exit 0
    }

    $script:NodePath = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
    $script:NpmPath = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop).Source
    & $script:NodePath (Join-Path $PSScriptRoot 'check-runtime.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Node.js >=22.12.0 is required.' }
    foreach ($directory in @($ServerDir, $ClientDir)) {
        if (-not (Test-Path -LiteralPath (Join-Path $directory 'package-lock.json') -PathType Leaf)) {
            throw "Missing package-lock.json in $directory"
        }
    }
    if ($Mode -eq 'Dev' -and $Port -ne 3000) { throw 'The development proxy requires backend port 3000.' }
    Assert-FreePort $Port
    if ($Mode -eq 'Dev') { Assert-FreePort 5173 }
    # Reinstall from both locks on every invocation, including existing node_modules.
    Invoke-Npm $ServerDir @('ci', '--omit=dev', '--include=optional')
    Assert-NativeRuntime
    Invoke-Npm $ClientDir @('ci', '--include=dev', '--include=optional')
    if ($Mode -eq 'Deploy') {
        Invoke-Npm $ClientDir @('run', 'build')
        if (-not (Test-Path -LiteralPath (Join-Path $ClientDir 'dist\index.html') -PathType Leaf)) {
            throw 'Frontend build output is missing.'
        }
    }

    # Child processes inherit these settings. Never trigger KEEP_DB=0's rebuild.
    $env:PORT = [string]$Port
    $env:KEEP_DB = '1'
    if (-not $env:HOST) { $env:HOST = '127.0.0.1' }
    if ($Mode -eq 'Dev') { $env:HOST = '127.0.0.1'; $env:NODE_ENV = 'development' }
    else { $env:NODE_ENV = 'production' }
    $backend = Start-Process -FilePath $script:NodePath -ArgumentList ('"' + $BackendEntry + '"') -WorkingDirectory $ServerDir -PassThru
    Wait-ForBackend $backend $Port
    if ($Mode -eq 'Dev') {
        $frontend = Start-Process -FilePath $script:NodePath -ArgumentList @(('"' + $FrontendEntry + '"'), '--host', '127.0.0.1', '--port', '5173', '--strictPort') -WorkingDirectory $ClientDir -PassThru
        Start-Sleep -Milliseconds 500
        $frontend.Refresh()
        if ($frontend.HasExited) { throw 'Frontend exited. Check its window for errors.' }
        Write-Host 'Development frontend: http://localhost:5173'
        Write-Host 'Stop the frontend with Ctrl+C in its window; stop.bat manages the backend only.'
    } else { Write-Host "Frontend: http://localhost:$Port" }
    Write-Host "Dashboard: http://localhost:$Port/dashboard"
    Write-Host 'No default account. Complete first-time setup locally before exposing the site.'
    Write-Host "Backend listen address: $($env:HOST):$Port"
    Write-Host "Use stop.bat --port $Port to stop this backend."
    exit 0
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
