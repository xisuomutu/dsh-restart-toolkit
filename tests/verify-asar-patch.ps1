# Reproducible verification of the append-only ASAR patch.
#
# It builds app.patched.asar from the installed app.asar, checks the report
# hashes, then uses the installation's own Electron ASAR reader to read
# lib/main.js back and compare hashes. It NEVER modifies the installation.
#
# Usage:
#   powershell -File tests/verify-asar-patch.ps1
#   powershell -File tests/verify-asar-patch.ps1 -InstallDir "D:\Soft\DSH"
param(
  [string]$AsarPath = "D:\Soft\DSH\resources\app.asar",
  [string]$SourceAsar = "",
  [string]$OutDir = (Join-Path $env:TEMP "dsh-asar-verify"),
  [string]$InstallDir = "",
  [string]$Electron = "D:\Soft\DSH\DeepSeek Harness.exe"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$repack = Join-Path $root "desktop-shell\patch\repack-asar.mjs"
$apply = Join-Path $root "desktop-shell\patch\apply-patched-asar.ps1"

$source = if ($SourceAsar -ne "") { $SourceAsar } else { $AsarPath }
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "source app.asar not found: $source" }
if (-not (Test-Path -LiteralPath $Electron -PathType Leaf)) { throw "Electron not found: $Electron" }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$patched = Join-Path $OutDir "app.patched.asar"
$report = Join-Path $OutDir "report.json"
Remove-Item -LiteralPath $patched, $report -Force -ErrorAction SilentlyContinue

Write-Host "=== build patched ASAR ===" -ForegroundColor Cyan
& node $repack $source $patched --report $report
if ($LASTEXITCODE -ne 0) { throw "repack-asar failed (exit $LASTEXITCODE)" }

Write-Host "`n=== verify report ===" -ForegroundColor Cyan
$r = Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
$patchedHash = (Get-FileHash -LiteralPath $patched -Algorithm SHA256).Hash.ToLowerInvariant()
if ($r.inputSha256 -ne $sourceHash) { throw "report input hash does not match $source" }
if ($r.outputSha256 -ne $patchedHash) { throw "report output hash does not match $patched" }
Write-Host "report OK: source/output SHA-256 match, mainPatchedSha256=$($r.mainPatchedSha256)"

Write-Host "`n=== read back with Electron ASAR reader ===" -ForegroundColor Cyan
$reader = Join-Path $OutDir "read-main.cjs"
$code = @'
const fs = require('node:fs')
const crypto = require('node:crypto')
const file = process.argv[2]
const main = fs.readFileSync(file + '/lib/main.js')
const pkg = JSON.parse(fs.readFileSync(file + '/package.json', 'utf8'))
console.log(JSON.stringify({
  size: main.length,
  sha256: crypto.createHash('sha256').update(main).digest('hex'),
  packageName: pkg.name,
  libEntries: fs.readdirSync(file + '/lib').length,
}))
'@
[IO.File]::WriteAllText($reader, $code, [Text.UTF8Encoding]::new($false))

$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $Electron
$start.Arguments = '"' + $reader + '" "' + $patched + '"'
$start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1"
$start.UseShellExecute = $false
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.StandardOutputEncoding = [Text.Encoding]::UTF8
$start.StandardErrorEncoding = [Text.Encoding]::UTF8
$process = [System.Diagnostics.Process]::Start($start)
$stderr = $process.StandardError.ReadToEndAsync()
$stdout = $process.StandardOutput.ReadToEnd()
$process.WaitForExit()
if ($process.ExitCode -ne 0) {
  throw "Electron ASAR reader failed (exit $($process.ExitCode)): $($stderr.Result)"
}
$read = $stdout.Trim() | ConvertFrom-Json
if ($read.sha256 -ne $r.mainPatchedSha256) {
  throw "read-back hash mismatch: $($read.sha256) != $($r.mainPatchedSha256)"
}
if ($read.size -ne $r.mainPatchedSize) {
  throw "read-back size mismatch: $($read.size) != $($r.mainPatchedSize)"
}
Write-Host "read-back OK: $($read.size) bytes, sha256=$($read.sha256), package=$($read.packageName), lib entries=$($read.libEntries)"

if ($InstallDir -ne "") {
  Write-Host "`n=== deploy dry-run ===" -ForegroundColor Cyan
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $apply `
    -InstallDir $InstallDir -PatchedAsar $patched -Report $report -SourceAsar $source
  if ($LASTEXITCODE -ne 0) { throw "apply-patched-asar dry-run failed (exit $LASTEXITCODE)" }
}

Write-Host "`nPASS: append-only ASAR patch is valid and matches the source archive." -ForegroundColor Green
Write-Host "Artifacts: $OutDir"
