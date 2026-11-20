# Read-only environment and compatibility check for the toolkit.
#
# Usage:
#   powershell -File .\doctor.ps1 -InstallDir "D:\Soft\DSH"
#   powershell -File .\doctor.ps1 -InstallDir "D:\Soft\DSH" -SourceAsar "...\app.asar.bak-..."
#
# Exit 0: ready (warnings are allowed), exit 1: a blocker was found.
param(
  [string]$InstallDir = "D:\Soft\DSH",
  [string]$SourceAsar = "",
  [switch]$Json
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$exe = Join-Path $InstallDir "DeepSeek Harness.exe"
$resources = Join-Path $InstallDir "resources"
$live = Join-Path $resources "app.asar"
$source = if ($SourceAsar -ne "") { $SourceAsar } else { $live }
$compatScript = Join-Path $root "desktop-shell\patch\check-compat.mjs"
$watchdog = Join-Path $resources "tray-restart-watchdog.cjs"

$errors = @()
$warnings = @()
$notes = @()
$result = [ordered]@{
  toolkitVersion = (Get-Content (Join-Path $root "VERSION") -Raw).Trim()
  os = $env:OS
  powershell = $PSVersionTable.PSVersion.ToString()
  installDir = $InstallDir
  admin = $false
  dshRunning = 0
  appAsar = $live
  appAsarExists = (Test-Path -LiteralPath $live -PathType Leaf)
  appAsarSize = $null
  appAsarSha256 = $null
  sourceAsar = $source
  backups = @()
  watchdogPresent = (Test-Path -LiteralPath $watchdog -PathType Leaf)
  node = $null
  freeBytes = $null
  compatibility = $null
  blockers = @()
  warnings = @()
}

if ($env:OS -ne "Windows_NT") {
  $errors += "This toolkit only supports Windows."
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$result.admin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

foreach ($path in @($exe, $live, $compatScript)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    $errors += "Missing required file: $path"
  }
}

try {
  $result.dshRunning = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue).Count
} catch {
  $warnings += "Could not enumerate DSH processes: $($_.Exception.Message)"
}

if (Test-Path -LiteralPath $live -PathType Leaf) {
  $item = Get-Item -LiteralPath $live
  $result.appAsarSize = $item.Length
  $result.appAsarSha256 = (Get-FileHash -LiteralPath $live -Algorithm SHA256).Hash.ToLowerInvariant()
  try {
    $result.freeBytes = (Get-Item -LiteralPath $InstallDir).PSDrive.Free
  } catch {}
  $result.backups = @(Get-ChildItem -LiteralPath $resources -Filter "app.asar.bak-*" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime |
    Select-Object Name, Length, LastWriteTime)
}

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node -eq $null) {
  $warnings += "Node.js was not found on PATH; build/verification scripts require Node.js 20+."
} else {
  try {
    $nodeVersion = (& node --version).Trim()
    $result.node = $nodeVersion
    $major = [int](($nodeVersion -replace '^v', '').Split('.')[0])
    if ($major -lt 20) {
      $errors += "Node.js 20+ is required; found $nodeVersion."
    }
  } catch {
    $warnings += "Could not run node --version: $($_.Exception.Message)"
  }
}

if ($node -ne $null -and (Test-Path -LiteralPath $compatScript -PathType Leaf) -and (Test-Path -LiteralPath $source -PathType Leaf)) {
  $jsonText = & node $compatScript --asar $source --exe $exe --json 2>&1 | Out-String
  $exit = $LASTEXITCODE
  try {
    $start = $jsonText.IndexOf("{")
    $end = $jsonText.LastIndexOf("}")
    if ($start -lt 0 -or $end -lt $start) { throw "no JSON in output" }
    $compat = $jsonText.Substring($start, $end - $start + 1) | ConvertFrom-Json
    $result.compatibility = $compat
    if ($compat.compatible -eq $false) {
      $errors += "Patch anchors do not match this app.asar; do not apply."
    }
    if ($compat.alreadyPatched -eq $true) {
      $notes += "This app.asar is already patched. Use -SourceAsar with the original app.asar backup to check a rebuild; do not rebuild from the patched live archive."
    }
    foreach ($warning in @($compat.warnings)) {
      if ($warning -ne $null -and $warning -ne "") { $warnings += $warning }
    }
    if ($compat.fuses -ne $null -and $compat.fuses.EnableEmbeddedAsarIntegrityValidation -eq "enabled") {
      $errors += "EnableEmbeddedAsarIntegrityValidation is enabled; a patched app.asar may be rejected. Stop here and use a source build/official merge."
    }
    if ($compat.fuses -ne $null -and $compat.fuses.RunAsNode -ne $null -and $compat.fuses.RunAsNode -ne "enabled") {
      $warnings += "RunAsNode is not enabled; the watchdog cannot run and start-failure detection is degraded."
    }
  } catch {
    $warnings += "Compatibility check failed to produce parseable output (exit $exit): $($_.Exception.Message)"
    if ($exit -ne 0) { $errors += "Compatibility check failed (exit $exit)." }
  }
} elseif ($node -ne $null) {
  $warnings += "Source app.asar not found or check-compat missing; compatibility was not checked."
}

$result.blockers = $errors
$result.warnings = $warnings
$result.notes = $notes

if ($Json) {
  $result | ConvertTo-Json -Depth 8
} else {
  Write-Host "DSH restart toolkit doctor" -ForegroundColor Cyan
  Write-Host "  toolkit      : $($result.toolkitVersion)"
  Write-Host "  OS           : $($result.os) / PowerShell $($result.powershell)"
  Write-Host "  install      : $InstallDir"
  Write-Host "  admin        : $($result.admin)"
  Write-Host "  DSH running  : $($result.dshRunning) process(es)"
  Write-Host "  app.asar     : $live"
  Write-Host "    exists     : $($result.appAsarExists)"
  if ($result.appAsarSize -ne $null) {
    Write-Host "    size       : $($result.appAsarSize)"
    Write-Host "    sha256     : $($result.appAsarSha256)"
  }
  Write-Host "  source       : $source"
  Write-Host "  watchdog     : $watchdog ($($result.watchdogPresent))"
  Write-Host "  node         : $($result.node)"
  if ($result.freeBytes -ne $null) { Write-Host "  free space   : $([math]::Round($result.freeBytes / 1GB, 1)) GB" }
  if ($result.backups.Count -gt 0) {
    Write-Host "  backups      :"
    foreach ($b in $result.backups) { Write-Host "    $($b.Name) ($($b.Length) bytes)" }
  } else {
    Write-Host "  backups      : (none)"
  }

  if ($result.compatibility -ne $null) {
    Write-Host "  compatibility:"
    Write-Host "    version    : $($result.compatibility.version)"
    Write-Host "    patched    : $($result.compatibility.alreadyPatched)"
    Write-Host "    anchors    : $(if ($result.compatibility.alreadyPatched) { 'n/a' } elseif ($result.compatibility.compatible) { 'match' } else { 'MISMATCH' })"
    if ($result.compatibility.fuses -ne $null) {
      Write-Host "    fuses      : ASAR-integrity=$($result.compatibility.fuses.EnableEmbeddedAsarIntegrityValidation), RunAsNode=$($result.compatibility.fuses.RunAsNode)"
    }
  }

  foreach ($note in $notes) { Write-Host "NOTE: $note" -ForegroundColor Yellow }
  foreach ($warning in $warnings) { Write-Host "WARNING: $warning" -ForegroundColor Yellow }
  foreach ($errorItem in $errors) { Write-Host "BLOCKER: $errorItem" -ForegroundColor Red }

  if ($errors.Count -eq 0) {
    Write-Host "`nREADY: no blockers. For a stock install, build from the live app.asar; for an already-patched install, build from the original backup." -ForegroundColor Green
  } else {
    Write-Host "`nNOT READY: resolve the blockers above before applying." -ForegroundColor Red
  }
}

if ($errors.Count -gt 0) { exit 1 } else { exit 0 }
