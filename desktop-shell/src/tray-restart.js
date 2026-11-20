/*
 * Source-build module for the "restart DeepSeek Harness from the tray" integration.
 *
 * The shipped desktop shell (app.asar/lib/main.js) is a single bundled file, so
 * the patch in ../patch/main.js.patch inlines an equivalent of this module.
 * This file is the canonical, testable version for a DSH desktop source build:
 *
 *   import { createTrayRestart, trayMenuTemplate } from './tray-restart.js'
 *
 * It deliberately has no import of `electron`: dependencies are injected so the
 * unit tests can run in a normal Node process.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const TRAY_RESTART_ITEM_ID = 'tray-restart'
export const TRAY_RESTART_WATCHDOG_FILE = 'tray-restart-watchdog.cjs'

/**
 * Build the tray context menu. The existing entries keep their exact labels,
 * order and actions; the restart item is inserted between Open and the
 * separator so Quit never moves.
 *
 * @param {{ openApplication: string, restartApplication: string, quitApplication: string }} messages
 * @param {{ open: () => void, restart: () => void, quit: () => void }} actions
 */
export function trayMenuTemplate(messages, actions) {
  return [
    {
      label: messages.openApplication,
      click: () => actions.open(),
    },
    {
      id: TRAY_RESTART_ITEM_ID,
      // The shell locale already ships "Restart"/"重启" for crash recovery.
      // Reusing it keeps every shipped language localized without adding keys.
      label: `${messages.restartApplication} DeepSeek Harness`,
      click: () => actions.restart(),
    },
    { type: 'separator' },
    {
      label: messages.quitApplication,
      click: () => actions.quit(),
    },
  ]
}

/**
 * @typedef {object} TrayRestartDependencies
 * @property {{ relaunch: () => void }} app
 * @property {{ showErrorBox: (title: string, content: string) => void }} dialog
 * @property {() => boolean} isQuitting
 * @property {() => void} quit  graceful quit, i.e. quitWithoutConfirmation()
 * @property {string} userDataPath
 * @property {string} resourcesPath
 * @property {NodeJS.Process} [process]
 * @property {typeof nodeSpawn} [spawn]
 * @property {() => number} [now]
 */

/**
 * Create the restart orchestrator used by the tray item and the optional
 * Host IPC bridge.
 *
 * Sequence:
 *   1. reject concurrent/quitting requests
 *   2. write the launch snapshot (no environment: the watchdog inherits it)
 *   3. start the detached watchdog from resources/
 *   4. app.relaunch()        (same executable and argv as this instance)
 *   5. quit()                (graceful shell quit -> backend close -> app.quit)
 *
 * @param {TrayRestartDependencies} deps
 */
export function createTrayRestart(deps) {
  const proc = deps.process ?? process
  const spawn = deps.spawn ?? nodeSpawn
  const now = deps.now ?? Date.now
  const directory = join(deps.userDataPath, 'tray-restart')
  const logPath = join(directory, 'restart.log')
  const watchdogPath = join(deps.resourcesPath, TRAY_RESTART_WATCHDOG_FILE)
  let inFlight = false

  function log(line) {
    const text = `${new Date(now()).toISOString()} [tray-restart ${proc.pid}] ${line}\n`
    try {
      mkdirSync(directory, { recursive: true })
      appendFileSync(logPath, text)
    } catch {
      // Logging is best effort; never block a restart on a full disk.
    }
    try {
      console.info(`[tray-restart] ${line}`)
    } catch {
      // ignore
    }
  }

  /**
   * @returns {{ ok: true, configPath: string, logPath: string } | { ok: false, code: string, detail: string }}
   */
  function restart() {
    if (deps.isQuitting()) {
      return { ok: false, code: 'quitting', detail: 'application is already quitting' }
    }
    if (inFlight) {
      return { ok: false, code: 'in-flight', detail: 'a restart is already in progress' }
    }
    inFlight = true
    const createdAt = now()
    let configPath
    let watchdogProcess
    try {
      mkdirSync(directory, { recursive: true })
      configPath = join(directory, `restart-${createdAt}.json`)
      const config = {
        version: 1,
        createdAt,
        oldPid: proc.pid,
        cutoff: createdAt,
        executablePath: proc.execPath,
        // Must match Electron's default app.relaunch() argv.
        args: proc.argv.slice(1),
        cwd: proc.cwd(),
        logPath,
        receiptPath: join(directory, 'last-result.json'),
        timeouts: {
          exitMs: 30000,
          forceMs: 8000,
          startMs: 25000,
          settleMs: 2500,
        },
      }
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
      log(`restart requested; snapshot=${configPath}`)

      // Schedule the relaunch BEFORE starting the watchdog: a throw here must
      // not leave a watchdog that would force-kill a still-running app.
      deps.app.relaunch()
      log('app.relaunch() scheduled')

      if (existsSync(watchdogPath)) {
        try {
          const child = spawn(proc.execPath, [watchdogPath, configPath], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            // The watchdog is the only process that needs Node mode. It keeps
            // the inherited environment for the fallback start and clears this
            // flag before spawning the GUI again.
            env: { ...proc.env, ELECTRON_RUN_AS_NODE: '1' },
          })
          watchdogProcess = child
          child.once?.('error', (error) => {
            log(`watchdog spawn error: ${error instanceof Error ? error.message : String(error)}`)
          })
          child.unref?.()
          log(`watchdog started pid=${String(child.pid)}`)
        } catch (error) {
          // A watchdog failure degrades start-failure detection, but Electron's
          // own relaunch can still restart the application.
          log(`watchdog could not be started: ${error instanceof Error ? error.message : String(error)}`)
        }
      } else {
        log(`watchdog not found at ${watchdogPath}; relying on Electron relaunch only`)
      }

      deps.quit()
      log('graceful quit requested')
      return { ok: true, configPath, logPath }
    } catch (error) {
      inFlight = false
      try {
        watchdogProcess?.kill?.()
      } catch {
        // ignore
      }
      const detail = error instanceof Error ? error.message : String(error)
      log(`restart failed: ${detail}`)
      try {
        deps.dialog.showErrorBox(
          'DeepSeek Harness',
          `Restart failed / 重启失败: ${detail}\nLog: ${logPath}`,
        )
      } catch {
        // ignore dialog failures
      }
      return { ok: false, code: 'error', detail }
    }
  }

  return {
    restart,
    logPath,
    watchdogPath,
    get inFlight() {
      return inFlight
    },
  }
}
