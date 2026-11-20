# Wait for DSH to exit, apply the patched app.asar, then optionally relaunch DSH.
#
# Run this from an EXTERNAL PowerShell / Windows Terminal, NOT from a DSH
# terminal: quitting DSH would kill a DSH terminal and interrupt the script.
#
# The script preflights the report/patched archive (dry-run), waits for every
# DeepSeek Harness process to exit, applies with the existing apply script, and
# relaunches DSH unless -NoRelaunch is passed.
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$PatchedAsar,
  [string]$Report = "",
  [string]$SourceAsar = "",
  [string]$Watchdog = "",
  [int]$TimeoutSec = 300,
  [switch]$NoRelaunch
)

$ErrorActionPreference = "Stop"
$apply = Join-Path $PSScriptRoot "apply-patched-asar.ps1"
$exe = Join-Path $InstallDir "DeepSeek Harness.exe"

function Get-DshProcessCount {
  return @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue).Count
}

if (-not (Test-Path -LiteralPath $apply -PathType Leaf)) { throw "apply script not found: $apply" }
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "DeepSeek Harness.exe not found: $exe" }

$common = @(
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $apply,
  "-InstallDir", $InstallDir,
  "-PatchedAsar", $PatchedAsar
)
if ($Report -ne "") { $common += @("-Report", $Report) }
if ($SourceAsar -ne "") { $common += @("-SourceAsar", $SourceAsar) }
if ($Watchdog -ne "") { $common += @("-Watchdog", $Watchdog) }

Write-Host "=== preflight (dry-run) ===" -ForegroundColor Cyan
& powershell.exe @common
if ($LASTEXITCODE -ne 0) { throw "preflight failed; nothing was changed (exit $LASTEXITCODE)" }

$initial = Get-DshProcessCount
Write-Host ""
Write-Host "Waiting for DeepSeek Harness to exit ($initial process(es) now)..." -ForegroundColor Yellow
Write-Host "Quit DSH now (tray -> quit, or close all windows). Timeout: ${TimeoutSec}s."
Write-Host "Do not start DSH again until this script reports completion."

$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ($true) {
  $running = Get-DshProcessCount
  if ($running -eq 0) { break }
  if ((Get-Date) -gt $deadline) {
    throw "timed out waiting for DeepSeek Harness to exit; nothing was changed"
  }
  Start-Sleep -Milliseconds 1000
}

# Let file handles and the single-instance lock settle.
Start-Sleep -Milliseconds 1500
if ((Get-DshProcessCount) -gt 0) {
  throw "DeepSeek Harness restarted while waiting; nothing was changed"
}

Write-Host ""
Write-Host "=== applying ===" -ForegroundColor Cyan
$applyArgs = @($common) + @("-Apply")
& powershell.exe @applyArgs
if ($LASTEXITCODE -ne 0) {
  throw "apply failed (exit $LASTEXITCODE). DSH is closed; start it manually or roll back using the backup path above."
}

if (-not $NoRelaunch) {
  Write-Host ""
  Write-Host "=== relaunching DSH ===" -ForegroundColor Cyan
  Start-Process -FilePath $exe -WorkingDirectory $InstallDir
  Write-Host "Started: $exe" -ForegroundColor Green
}

Write-Host ""
Write-Host "Done. After DSH opens, right-click the tray icon; it should show '重启 DSH'." -ForegroundColor Green
Write-Host "Rollback backup path is printed above by the apply step (app.asar.bak-<timestamp>)."
