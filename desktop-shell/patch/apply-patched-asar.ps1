# Apply a verified app.asar.patched to the installed DSH desktop shell.
#
# The script NEVER runs by accident: without -Apply it only prints the plan.
# DSH must be fully closed before -Apply; the script aborts if it finds a
# DeepSeek Harness process. It always keeps a timestamped app.asar backup.
#
# Examples:
#   # 1. build a patched copy (does not modify the install)
#   node desktop-shell/patch/repack-asar.mjs "$InstallDir\resources\app.asar" `
#        "$env:TEMP\app.patched.asar" --report "$env:TEMP\report.json"
#
#   # 2. preview
#   powershell -File desktop-shell/patch/apply-patched-asar.ps1 `
#        -InstallDir "D:\Soft\DSH" `
#        -PatchedAsar "$env:TEMP\app.patched.asar" `
#        -Report "$env:TEMP\report.json"
#
#   # 3. apply after closing DSH
#   powershell -File desktop-shell/patch/apply-patched-asar.ps1 ... -Apply
#
#   # 4. roll back
#   powershell -File desktop-shell/patch/apply-patched-asar.ps1 `
#        -InstallDir "D:\Soft\DSH" -Rollback -Backup "...\app.asar.bak-..."
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [string]$PatchedAsar = "",
  [string]$Report = "",
  [string]$SourceAsar = "",
  [string]$Watchdog = "",
  [switch]$Apply,
  [switch]$Rollback,
  [string]$Backup = ""
)

$ErrorActionPreference = "Stop"

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-File([string]$Path, [string]$What) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$What not found: $Path"
  }
}

$resources = Join-Path $InstallDir "resources"
$liveAsar = Join-Path $resources "app.asar"
Assert-File -Path (Join-Path $InstallDir "DeepSeek Harness.exe") -What "DeepSeek Harness.exe"
Assert-File -Path $liveAsar -What "app.asar"

if ($Rollback) {
  if ([string]::IsNullOrWhiteSpace($Backup)) { throw "-Rollback requires -Backup <app.asar.bak-...>" }
  Assert-File -Path $Backup -What "backup archive"
  if (Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue) {
    throw "DeepSeek Harness is running; close it completely before rollback."
  }
  $staged = "$liveAsar.restore"
  Copy-Item -LiteralPath $Backup -Destination $staged -Force
  $backupHash = Get-Sha256 $Backup
  if ((Get-Sha256 $staged) -ne $backupHash) {
    Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
    throw "restore copy hash mismatch; live app.asar was not touched"
  }
  Move-Item -LiteralPath $staged -Destination $liveAsar -Force
  Write-Host "Rolled back app.asar from: $Backup" -ForegroundColor Green
  Write-Host "Watchdog file was left in place: $(Join-Path $resources 'tray-restart-watchdog.cjs')"
  return
}

Assert-File -Path $PatchedAsar -What "patched archive"
if (-not $PatchedAsar.EndsWith(".asar", [StringComparison]::OrdinalIgnoreCase)) {
  throw "patched archive must end in .asar: $PatchedAsar"
}
if ($Watchdog -eq "") {
  $Watchdog = Join-Path $PSScriptRoot "..\runtime\tray-restart-watchdog.cjs"
}
Assert-File -Path $Watchdog -What "watchdog script"

$running = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue)
$liveHash = Get-Sha256 $liveAsar
$patchedHash = Get-Sha256 $PatchedAsar

if ($Report -ne "") {
  Assert-File -Path $Report -What "repack report"
  $r = Get-Content -LiteralPath $Report -Raw | ConvertFrom-Json
  $sourceHash = $liveHash
  $sourceLabel = $liveAsar
  if ($SourceAsar -ne "") {
    Assert-File -Path $SourceAsar -What "source archive"
    $sourceHash = Get-Sha256 $SourceAsar
    $sourceLabel = $SourceAsar
  }
  if ($r.inputSha256 -ne $sourceHash) {
    throw "repack report does not match the source archive (source $sourceLabel hash $sourceHash, report $($r.inputSha256)). Rebuild the patch from this source."
  }
  if ($r.outputSha256 -ne $patchedHash) {
    throw "patched archive does not match the repack report (patched $patchedHash, report $($r.outputSha256))."
  }
  Write-Host "Report verified: patched archive was built from $sourceLabel." -ForegroundColor Green
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupPath = Join-Path $resources "app.asar.bak-$stamp"
$watchdogTarget = Join-Path $resources "tray-restart-watchdog.cjs"

Write-Host ""
Write-Host "Install dir : $InstallDir"
Write-Host "Live asar   : $liveAsar"
Write-Host "  sha256    : $liveHash"
Write-Host "Patched     : $PatchedAsar"
Write-Host "  sha256    : $patchedHash"
if ($SourceAsar -ne "") {
  Write-Host "Source      : $SourceAsar"
  Write-Host "  sha256    : $(Get-Sha256 $SourceAsar)"
}
Write-Host "Watchdog    : $Watchdog"
Write-Host "Backup      : $backupPath"
Write-Host "Running DSH : $(if ($running.Count -eq 0) { 'no' } else { "yes ($($running.Count) process(es))" })"
Write-Host ""

if (-not $Apply) {
  Write-Host "DRY RUN. No file was changed. Re-run with -Apply after closing DSH." -ForegroundColor Yellow
  return
}

if ($running.Count -gt 0) {
  throw "DeepSeek Harness is running; close it completely (including the tray icon) before applying."
}

Copy-Item -LiteralPath $liveAsar -Destination $backupPath -Force
$stagedAsar = "$liveAsar.new"
try {
  # Stage next to the target, verify it, then replace in one move. If the copy
  # is interrupted, the live archive is still the untouched original.
  Copy-Item -LiteralPath $PatchedAsar -Destination $stagedAsar -Force
  $stagedHash = Get-Sha256 $stagedAsar
  if ($stagedHash -ne $patchedHash) {
    throw "staged copy hash mismatch ($stagedHash != $patchedHash)"
  }
  Move-Item -LiteralPath $stagedAsar -Destination $liveAsar -Force

  if (Test-Path -LiteralPath $watchdogTarget) {
    Copy-Item -LiteralPath $watchdogTarget -Destination "$watchdogTarget.bak-$stamp" -Force
  }
  Copy-Item -LiteralPath $Watchdog -Destination $watchdogTarget -Force

  $afterHash = Get-Sha256 $liveAsar
  if ($afterHash -ne $patchedHash) {
    throw "post-copy hash mismatch ($afterHash != $patchedHash)"
  }
} catch {
  Remove-Item -LiteralPath $stagedAsar -Force -ErrorAction SilentlyContinue
  Copy-Item -LiteralPath $backupPath -Destination $liveAsar -Force
  throw "apply failed and app.asar was restored from $backupPath : $_"
}

Write-Host "Applied." -ForegroundColor Green
Write-Host "  app.asar backup: $backupPath"
Write-Host "  watchdog       : $watchdogTarget"
Write-Host ""
Write-Host "Start DeepSeek Harness and right-click the tray icon to verify 'Restart DSH'."
Write-Host "Rollback:"
Write-Host "  powershell -File `"$PSCommandPath`" -InstallDir `"$InstallDir`" -Rollback -Backup `"$backupPath`""
