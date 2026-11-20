# DSH Restart Toolkit 1.0.0

**Unofficial Windows patch toolkit for DeepSeek Harness Desktop 0.2.2-rc.5.**

Adds a tray item **Restart DeepSeek Harness** and performs a complete, verified
desktop restart. It is not a DSH plugin-market package: the tray belongs to the
Electron desktop shell, so the toolkit patches the local `app.asar` and provides
backup, verification and rollback.

## Highlights

- Tray item `重启 DeepSeek Harness` / `Restart DeepSeek Harness`, beside the
  existing Open/Quit entries.
- Graceful desktop restart via the shell's existing
  `app.relaunch()` + `quitWithoutConfirmation()` path
  (`backend.close` → `DesktopHostProcess.stop`, 10s/5s/5s escalation).
- Detached watchdog: waits for the old process, verifies the new instance,
  force-kills only a timed-out old tree (leaf-first, no `/T`), writes
  `restart.log` / `last-result.json`.
- Startup hardening: retries the welcome-state RPC on transient
  `ECONNRESET`/`fetch failed`, and writes `startup.log`, `host-stderr.log`,
  `host-events.log`.
- Append-only ASAR patcher: no external asar tool, no full repack; the other
  21,721 archive entries keep their offsets and bytes.
- `doctor.ps1` / `check-compat.mjs`: version, ASAR hash, Electron fuses and
  patch-anchor compatibility checks before touching anything.
- `apply-patched-asar.ps1`: report/source verification, staged replace,
  automatic backup and rollback.
- `apply-after-exit.ps1`: wait for DSH to exit, apply, relaunch.

## Requirements

- Windows 10/11
- DeepSeek Harness **Desktop 0.2.2-rc.5**
- Node.js **20+** on `PATH` (build/verification only)
- PowerShell 5.1 (Windows built-in)
- An external PowerShell/Windows Terminal for the apply step

## Download

- `dsh-restart-toolkit-1.0.0.zip`
- `dsh-restart-toolkit-1.0.0.zip.sha256.txt`

The ZIP contains **no** `app.asar`, `app.asar.bak-*`, logs, `node_modules` or
DeepSeek binaries. Build the patch locally from your own DSH installation.

## Quick start

```powershell
# 1. Extract the ZIP to a fixed directory, then:
powershell -File .\doctor.ps1 -InstallDir "<DSH_INSTALL>"

# 2. Build a patched copy from your own app.asar (read-only)
New-Item -ItemType Directory -Force -Path "$env:TEMP\dsh-local" | Out-Null
node .\desktop-shell\patch\repack-asar.mjs `
  "<DSH_INSTALL>\resources\app.asar" `
  "$env:TEMP\dsh-local\app.patched.asar" `
  --report "$env:TEMP\dsh-local\report.json"

# 3. Dry-run
powershell -File .\desktop-shell\patch\apply-patched-asar.ps1 `
  -InstallDir "<DSH_INSTALL>" `
  -PatchedAsar "$env:TEMP\dsh-local\app.patched.asar" `
  -Report "$env:TEMP\dsh-local\report.json"

# 4. Apply and restart (external PowerShell; quit DSH when prompted)
powershell -File .\desktop-shell\patch\apply-after-exit.ps1 `
  -InstallDir "<DSH_INSTALL>" `
  -PatchedAsar "$env:TEMP\dsh-local\app.patched.asar" `
  -Report "$env:TEMP\dsh-local\report.json"
```

If the target is already patched, build from its original
`resources\app.asar.bak-<stamp>` and add `-SourceAsar` to the apply steps. See
`INSTALL.md` for details.

## Verification in this release

- 17/17 automated tests pass (tray menu, restart orchestration, watchdog,
  `/restart-dsh` command).
- `doctor.ps1` passes against a stock 0.2.2-rc.5 archive; anchors match,
  ASAR integrity disabled, RunAsNode enabled.
- The packaged `repack-asar.mjs` reproduces the v3 archive byte-for-byte from
  the original backup (`592987ef…dce568`).
- Field validation: the v2 startup retry was observed at 18:12, recovered
  from `ECONNRESET`, no new crash report, Host `close code=0`.

## Important limitations

- Unofficial, not affiliated with DeepSeek. Use at your own risk.
- Only Windows Desktop 0.2.2-rc.5; other versions/builds may fail the anchor
  check. Do not force.
- ASAR integrity, code signing, enterprise policy, antivirus or an update may
  block or overwrite the patch. Keep the automatic `app.asar.bak-<timestamp>`
  and roll back if the app does not start.
- Restart interrupts running turns, tools, terminals and jobs. Session logs are
  durable; in-flight work is not.
- Do not redistribute `app.asar`, backups or DeepSeek binaries.

## License

The toolkit is MIT-licensed. DeepSeek Harness is MIT-licensed, Copyright (c)
2026 DeepSeek; Electron/Chromium components carry their own licenses. See
`LICENSE`, `NOTICE.md` and `DISCLAIMER.md`.
