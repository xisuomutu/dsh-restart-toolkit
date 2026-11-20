# Build a distributable toolkit ZIP.
#
# The ZIP intentionally contains no app.asar, no app.asar.bak-*, no logs and no
# node_modules. It contains the scripts, watchdog, docs, optional Cordis bundle,
# tests, licenses and this packaging script.
param(
  [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$version = (Get-Content (Join-Path $root "VERSION") -Raw).Trim()
$dist = if ($OutputDir -ne "") { $OutputDir } else { Join-Path $root "dist" }
$stageName = "dsh-restart-toolkit-$version"
$stage = Join-Path $dist $stageName
$zip = Join-Path $dist "$stageName.zip"

if (-not (Test-Path -LiteralPath (Join-Path $root "README.md"))) { throw "run this script from the toolkit root" }
if (-not (Get-Command robocopy.exe -ErrorAction SilentlyContinue)) { throw "robocopy.exe not found (Windows is required)" }

New-Item -ItemType Directory -Force -Path $dist | Out-Null
Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue

$excludeDirs = @("dist", ".git", "node_modules", ".plugin-manager", ".dsh")
$excludeFiles = @("app.asar", "app.asar.*", "*.log", "*.zip", "*.dmp")
$robocopyArgs = @($root, $stage, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/XD") +
  $excludeDirs + @("/XF") + $excludeFiles

& robocopy.exe @robocopyArgs | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }

$forbidden = @(Get-ChildItem -LiteralPath $stage -Recurse -File | Where-Object {
  $_.Name -match '^app\.asar' -or $_.Name -like '*.log' -or $_.Name -like '*.zip' -or $_.Name -like '*.dmp'
})
if ($forbidden.Count -gt 0) {
  throw "package contains forbidden files: $($forbidden.FullName -join ', ')"
}
if (Test-Path -LiteralPath (Join-Path $stage "desktop-shell\patch\main.js.patch")) {
  Write-Host "patch file included." -ForegroundColor Green
} else {
  throw "main.js.patch missing from package"
}

Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal -Force
$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
$hashFile = "$zip.sha256.txt"
Set-Content -LiteralPath $hashFile -Value "$hash  $([IO.Path]::GetFileName($zip))" -Encoding ASCII

$files = @(Get-ChildItem -LiteralPath $stage -Recurse -File)
Write-Host ""
Write-Host "Toolkit package: $zip" -ForegroundColor Green
Write-Host "  version : $version"
Write-Host "  files   : $($files.Count)"
Write-Host "  size    : $([math]::Round((Get-Item -LiteralPath $zip).Length / 1MB, 2)) MB"
Write-Host "  sha256  : $hash"
Write-Host "  sums    : $hashFile"
Write-Host ""
Write-Host "Top-level contents:"
Get-ChildItem -LiteralPath $stage -Force | Select-Object Name | Format-Table -AutoSize
Write-Host "The ZIP contains no app.asar, backups, logs or node_modules."
