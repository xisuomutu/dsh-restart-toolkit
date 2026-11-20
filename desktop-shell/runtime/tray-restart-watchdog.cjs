/*
 * DSH desktop tray restart watchdog.
 *
 * This file is copied to <DSH install>\resources\tray-restart-watchdog.cjs.
 * The Electron main process starts it (detached, ELECTRON_RUN_AS_NODE=1)
 * immediately before scheduling app.relaunch() and quitting.
 *
 * Why a separate process:
 *   - The old main process cannot observe its own process exit, and Electron's
 *     app.relaunch() gives no completion/failure callback.
 *   - If the new instance never starts (missing exe, permissions, single
 *     instance failure) somebody must still tell the user. The watchdog does.
 *
 * The watchdog never modifies app.asar. It only reads the launch snapshot and
 * writes logs/receipts next to the shell log.
 *
 * Exit codes: 0 = new instance observed healthy; 1 = failed (receipt written).
 */
'use strict'

const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const configPath = process.argv[2]

function nowIso() {
  return new Date().toISOString()
}

function readConfig() {
  if (!configPath) throw new Error('missing watchdog config path')
  const text = fs.readFileSync(configPath, 'utf8')
  const value = JSON.parse(text)
  if (value === null || typeof value !== 'object') throw new Error('invalid watchdog config')
  return value
}

let cfg
let logPath

function log(message) {
  const line = `${nowIso()} [watchdog ${process.pid}] ${message}\n`
  try {
    if (logPath === undefined) return
    fs.appendFileSync(logPath, line)
  } catch {
    // Logging must never take down the watchdog.
  }
  try {
    process.stderr.write(line)
  } catch {
    // ignore
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error !== null && typeof error === 'object' && error.code === 'EPERM'
  }
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function runPowerShell(script, timeout = 20000) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return execFileSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encoded,
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim()
}

function parsePids(stdout) {
  if (stdout === '') return []
  const pids = []
  for (const line of stdout.split(/\r?\n/u)) {
    const value = Number(line.trim())
    if (Number.isSafeInteger(value) && value > 0 && value !== process.pid) pids.push(value)
  }
  return [...new Set(pids)]
}

/**
 * List processes of the same executable created after `cutoffMs`.
 * The exe path check avoids matching another Electron application that happens
 * to share the process name (electron.exe in a development launch).
 */
function listNewerPids(cutoffMs, exclude) {
  const name = path.basename(cfg.executablePath)
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$name = ${quotePowerShell(name)}`,
    `$exe = ${quotePowerShell(cfg.executablePath)}`,
    `$cutoff = [DateTimeOffset]::FromUnixTimeMilliseconds(${String(cutoffMs)}).LocalDateTime`,
    `$self = ${String(process.pid)}`,
    `Get-CimInstance Win32_Process -Filter "Name='$name'" |`,
    '  Where-Object { $_.ExecutablePath -eq $exe -and $_.CreationDate -ne $null -and $_.CreationDate -gt $cutoff -and $_.ProcessId -ne $self } |',
    '  Select-Object -ExpandProperty ProcessId',
  ].join('\n')
  let stdout
  try {
    stdout = runPowerShell(script)
  } catch (error) {
    log(`process enumeration failed: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
  const excluded = new Set(Array.isArray(exclude) ? exclude : [])
  return parsePids(stdout).filter((pid) => !excluded.has(pid))
}

/**
 * List the live descendants of the old main process, excluding the watchdog's
 * own subtree. The watchdog is normally a child of the old main; a tree kill
 * (`taskkill /T`) would kill the watcher itself, so the forced path kills these
 * PIDs individually, leaves first.
 */
function listOldTreePids() {
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$rootPid = ${String(cfg.oldPid)}`,
    `$self = ${String(process.pid)}`,
    '$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name)',
    '$children = @{}',
    '$names = @{}',
    'foreach ($p in $all) {',
    '  $parent = [int]$p.ParentProcessId',
    '  if (-not $children.ContainsKey($parent)) { $children[$parent] = New-Object System.Collections.Generic.List[int] }',
    '  $children[$parent].Add([int]$p.ProcessId)',
    '  $names[[int]$p.ProcessId] = $p.Name',
    '}',
    '$seen = New-Object System.Collections.Generic.HashSet[int]',
    '$order = New-Object System.Collections.Generic.List[int]',
    '$queue = New-Object System.Collections.Generic.Queue[int]',
    '$queue.Enqueue($rootPid)',
    'while ($queue.Count -gt 0) {',
    '  $id = $queue.Dequeue()',
    '  if (-not $seen.Add($id)) { continue }',
    '  if ($id -eq $self) { continue }',
    '  $name = $names[$id]',
    '  if ($name -eq "conhost.exe" -or $name -eq "OpenConsole.exe" -or $name -eq "WindowsTerminal.exe") { continue }',
    '  $order.Add($id)',
    '  if ($children.ContainsKey($id)) { foreach ($c in $children[$id]) { $queue.Enqueue($c) } }',
    '}',
    '$order | ForEach-Object { $_ }',
  ].join('\n')
  try {
    return parsePids(runPowerShell(script))
  } catch (error) {
    log(`old-process tree enumeration failed: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

function waitForOldExit(timeoutMs) {
  return (async () => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!isAlive(cfg.oldPid)) return true
      await sleep(200)
    }
    return !isAlive(cfg.oldPid)
  })()
}

function taskkill(pid) {
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/F'], {
      windowsHide: true,
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return true
  } catch (error) {
    log(`taskkill ${pid} failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

function cleanEnvironment(source) {
  const env = { ...source }
  // The watchdog inherits the shell environment; the snapshot deliberately does
  // not persist it. Never let the relaunched GUI inherit Node mode.
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  delete env.ELECTRON_ENABLE_LOGGING
  return env
}

/**
 * Forced path. Kill the old tree leaf-first with per-PID taskkill (never /T)
 * because the watchdog itself is a child of the old main. The list excludes the
 * watchdog subtree.
 */
async function forceKillOldTree(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  do {
    const tree = listOldTreePids()
    if (tree.length === 0) break
    log(`force-killing old tree: ${tree.join(',')}`)
    // BFS order is root first, descendants after; kill in reverse so a dying
    // parent cannot orphan a child before its turn.
    for (const pid of [...tree].reverse()) {
      if (pid === process.pid) continue
      if (isAlive(pid)) taskkill(pid)
    }
    await sleep(250)
  } while (Date.now() < deadline && isAlive(cfg.oldPid))
  return waitForOldExit(Math.min(2000, timeoutMs))
}

function startApplication() {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    let child
    try {
      child = spawn(cfg.executablePath, cfg.args ?? [], {
        cwd: cfg.cwd,
        env: cleanEnvironment(process.env),
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      })
    } catch (error) {
      finish({ ok: false, code: 'spawn-error', detail: error instanceof Error ? error.message : String(error) })
      return
    }
    child.once('error', (error) => {
      finish({ ok: false, code: 'spawn-error', detail: error instanceof Error ? error.message : String(error) })
    })
    child.once('exit', (code, signal) => {
      finish({ ok: false, code: 'start-exited', detail: `new process exited immediately (code=${String(code)}, signal=${String(signal)})` })
    })
    child.unref()
    setTimeout(() => finish({ ok: true, pid: child.pid }), 3000)
  })
}

function waitForNewPids(timeoutMs) {
  return (async () => {
    const deadline = Date.now() + timeoutMs
    let last = []
    while (Date.now() < deadline) {
      last = listNewerPids(cfg.cutoff, [process.pid])
      if (last.length > 0) return last
      await sleep(250)
    }
    return last
  })()
}

function showFailureDialog(title, message) {
  if (cfg.testMode === true || cfg.noDialogs === true) {
    log(`dialog suppressed (testMode): ${title}: ${message}`)
    return
  }
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    'Add-Type -AssemblyName System.Windows.Forms',
    `$title = ${quotePowerShell(title)}`,
    `$message = ${quotePowerShell(message)}`,
    '[void][System.Windows.Forms.MessageBox]::Show($message, $title, [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error)',
  ].join('\n')
  try {
    runPowerShell(script, 30000)
  } catch (error) {
    log(`failure dialog could not be shown: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function writeReceipt(result) {
  const dir = path.dirname(cfg.logPath)
  const receiptPath = cfg.receiptPath ?? path.join(dir, 'last-result.json')
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      receiptPath,
      `${JSON.stringify({ ...result, at: nowIso(), oldPid: cfg.oldPid, executablePath: cfg.executablePath, args: cfg.args, logPath: cfg.logPath }, null, 2)}\n`,
      'utf8',
    )
  } catch (error) {
    log(`receipt write failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function fail(code, detail, newPids) {
  log(`FAILED ${code}: ${detail}`)
  writeReceipt({ status: 'failed', code, detail, newPids: newPids ?? [] })
  showFailureDialog(
    'DSH restart failed / DSH 重启失败',
    [
      'DeepSeek Harness could not be restarted.',
      `Reason: ${detail}`,
      '',
      `Executable: ${cfg.executablePath}`,
      `Log: ${cfg.logPath}`,
      '',
      'Try starting DeepSeek Harness manually. If this repeats, run it as administrator or reinstall.',
    ].join('\n'),
  )
  process.exitCode = 1
}

async function main() {
  cfg = readConfig()
  logPath = cfg.logPath
  const timeouts = {
    exitMs: 30000,
    forceMs: 8000,
    startMs: 25000,
    settleMs: 2500,
    ...(cfg.timeouts ?? {}),
  }
  if (!Number.isSafeInteger(cfg.oldPid) || cfg.oldPid <= 0) {
    throw new Error('invalid oldPid')
  }
  if (typeof cfg.executablePath !== 'string' || !path.isAbsolute(cfg.executablePath)) {
    throw new Error('invalid executablePath')
  }
  if (!fs.existsSync(cfg.executablePath)) {
    throw new Error(`executable not found: ${cfg.executablePath}`)
  }
  fs.mkdirSync(path.dirname(cfg.logPath), { recursive: true })
  log(`armed: oldPid=${cfg.oldPid}, cutoff=${cfg.cutoff}, exe=${cfg.executablePath}, args=${JSON.stringify(cfg.args ?? [])}`)

  // Capture the old tree while the main process is still alive. The list scopes
  // residual cleanup and excludes the watchdog subtree.
  const oldTreePids = listOldTreePids()
  log(`captured old process tree: ${oldTreePids.length} pid(s)${oldTreePids.length === 0 ? '' : ` (${oldTreePids.join(',')})`}`)

  // 1. Wait for the graceful quit path (Electron before-quit -> backend close).
  let oldExited = await waitForOldExit(timeouts.exitMs)
  if (!oldExited) {
    log(`old process still alive after ${timeouts.exitMs}ms; force-killing its tree`)
    await forceKillOldTree(timeouts.forceMs)
    oldExited = !isAlive(cfg.oldPid)
    if (!oldExited) {
      fail('exit-timeout', `process ${cfg.oldPid} did not exit after forced termination`)
      return
    }
  }
  log('old process exited')

  // 2. Electron's app.relaunch() normally starts the new instance now. Poll for
  //    a new process of the same executable; fall back to starting it ourselves
  //    when the shell never got to schedule the relaunch (forced kill) or when
  //    no new process appears.
  let newPids = await waitForNewPids(timeouts.startMs)
  if (newPids.length === 0) {
    log('no relaunched instance observed; starting the application from the snapshot')
    const started = await startApplication()
    if (!started.ok) {
      const hint = started.code === 'spawn-error' && /EACCES|EPERM|access is denied/iu.test(started.detail)
        ? 'Permission denied. Run DeepSeek Harness as administrator or check the executable path.'
        : started.detail
      fail(started.code, hint)
      return
    }
    log(`fallback start pid=${String(started.pid)}; waiting for readiness`)
    newPids = await waitForNewPids(timeouts.startMs)
    if (newPids.length === 0) {
      // The fallback process may be the one we spawned but process enumeration
      // can lag; verify the direct PID as a last resort.
      if (started.pid !== undefined && isAlive(started.pid)) newPids = [started.pid]
    }
  }

  if (newPids.length === 0) {
    fail('start-failed', 'no new DeepSeek Harness process was observed after the old process exited')
    return
  }
  log(`new instance observed: pids=${newPids.join(',')}`)

  // 3. Give the new instance a short settling window. A process that exits
  //    immediately (single-instance rejection, missing resource, crash) is a
  //    start failure even though it existed briefly.
  await sleep(timeouts.settleMs)
  const aliveAfterSettle = newPids.filter((pid) => isAlive(pid))
  if (aliveAfterSettle.length === 0) {
    fail('start-unstable', 'the new process exited during the startup settling window', newPids)
    return
  }
  log(`new instance healthy: pids=${aliveAfterSettle.join(',')}`)

  // 4. Best-effort residual cleanup, limited to descendants captured before the
  //    old process exited. The new generation is excluded.
  const residual = oldTreePids.filter((pid) => !aliveAfterSettle.includes(pid) && isAlive(pid))
  if (residual.length > 0) {
    log(`cleaning residual old-tree processes: ${residual.join(',')}`)
    for (const pid of residual) {
      if (!isAlive(pid)) continue
      taskkill(pid)
    }
  } else {
    log('no residual old-tree processes')
  }

  writeReceipt({ status: 'ok', newPids: aliveAfterSettle, residualKilled: residual })
  log('restart completed successfully')
}

const hardTimeoutMs = 180000
let finished = false
const hardTimer = setTimeout(() => {
  if (finished) return
  finished = true
  log('hard timeout reached; watchdog exiting')
  try {
    writeReceipt({ status: 'failed', code: 'watchdog-timeout', detail: 'watchdog exceeded its hard deadline' })
  } catch {
    // ignore
  }
  process.exit(1)
}, hardTimeoutMs)
hardTimer.unref?.()

main()
  .then(() => {
    finished = true
    clearTimeout(hardTimer)
    process.exit(process.exitCode ?? 0)
  })
  .catch((error) => {
    finished = true
    clearTimeout(hardTimer)
    try {
      if (cfg === undefined) {
        // Config parsing failed before logging was available: write to stderr.
        process.stderr.write(`${nowIso()} [watchdog] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      } else {
        fail('watchdog-error', error instanceof Error ? error.message : String(error))
      }
    } finally {
      process.exit(1)
    }
  })
