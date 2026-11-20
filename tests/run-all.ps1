# Run every automated test in this repository.
# Usage:
#   pwsh -File tests/run-all.ps1
#   pwsh -File tests/run-all.ps1 -MainJsPath "C:\tmp\dsh-asar\lib\main.js"
param(
  [string]$MainJsPath = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  $suites = @(
    "desktop-shell/test/tray-restart.test.mjs",
    "desktop-shell/test/watchdog.test.mjs",
    "plugin/dsh-restart-command/test/command.test.mjs"
  )
  foreach ($suite in $suites) {
    Write-Host "`n=== $suite ===" -ForegroundColor Cyan
    node --test $suite
    if ($LASTEXITCODE -ne 0) {
      throw "test suite failed: $suite (exit $LASTEXITCODE)"
    }
  }

  if ($MainJsPath -ne "") {
    Write-Host "`n=== patch check ===" -ForegroundColor Cyan
    node desktop-shell/patch/check-patch.mjs $MainJsPath
    if ($LASTEXITCODE -ne 0) {
      throw "patch check failed (exit $LASTEXITCODE)"
    }
  }

  Write-Host "`nAll tests passed." -ForegroundColor Green
}
finally {
  Pop-Location
}
