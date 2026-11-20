# Changelog

## 1.0.0 — 2026-11-20

Initial public toolkit release for **DSH Desktop 0.2.2-rc.5 on Windows**.

### Patch v3

- Tray item `重启 DeepSeek Harness` / `Restart DeepSeek Harness`.
- New tray command performs a full desktop restart:
  - `app.relaunch()` keeps the executable and argv;
  - `quitWithoutConfirmation()` runs the shell's graceful shutdown chain
    (`backend.close` → `DesktopHostProcess.stop`, 10s/5s/5s escalation);
  - detached watchdog observes the handoff, force-kills a timed-out old tree
    leaf-first without `/T`, verifies the new instance, and writes a receipt.
- Startup hardening from v2:
  - retries `readWelcomeState()` on transient `ECONNRESET`/`fetch failed`
    (3 attempts);
  - writes `startup.log`, `host-stderr.log`, `host-events.log`.
- Optional Cordis bundle registers `/restart-dsh` and uses the shell's
  `restart-app` IPC; it returns a clear error without the shell patch.

### Toolkit

- `doctor.ps1` and `check-compat.mjs` for version/ASAR/fuse checks.
- Append-only `repack-asar.mjs` (no external asar tool, no full repack).
- `apply-patched-asar.ps1` with report/source verification, staged replace,
  backup and rollback.
- `apply-after-exit.ps1` waits for DSH to exit, applies, and relaunches.
- `package-release.ps1` produces a ZIP without `app.asar` or backups.
- MIT license, NOTICE, DISCLAIMER, install guide.

### Field validation

- v2 retry was observed in the field on 2026-11-19 18:12: a
  `welcome-state read failed (attempt 1): fetch failed ECONNRESET` was retried
  and the app opened normally; no new crash report; Host `close code=0`.
