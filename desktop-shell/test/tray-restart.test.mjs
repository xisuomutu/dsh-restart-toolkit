import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  TRAY_RESTART_ITEM_ID,
  TRAY_RESTART_WATCHDOG_FILE,
  createTrayRestart,
  trayMenuTemplate,
} from '../src/tray-restart.js'

function workspace() {
  return mkdtempSync(join(tmpdir(), 'dsh-tray-restart-test-'))
}

function fakeChild() {
  const listeners = new Map()
  return {
    pid: 4321,
    unrefCalled: false,
    killCalled: false,
    once(event, listener) {
      listeners.set(event, listener)
      return this
    },
    unref() {
      this.unrefCalled = true
    },
    kill() {
      this.killCalled = true
    },
    emit(event, ...args) {
      listeners.get(event)?.(...args)
    },
  }
}

function fakeProcess(overrides = {}) {
  return {
    pid: 1234,
    execPath: 'C:\\Fake\\DeepSeek Harness.exe',
    argv: ['C:\\Fake\\DeepSeek Harness.exe', '--flag', 'value'],
    cwd: () => 'C:\\Fake',
    env: { PATH: 'C:\\Windows', SECRET_TOKEN: 'do-not-persist' },
    ...overrides,
  }
}

function harness(options = {}) {
  const dir = workspace()
  const calls = []
  const dialogs = []
  const spawnCalls = []
  const child = fakeChild()
  const resourcesPath = join(dir, 'resources')
  mkdirSync(resourcesPath, { recursive: true })
  if (options.watchdog !== false) {
    writeFileSync(join(resourcesPath, TRAY_RESTART_WATCHDOG_FILE), '// stub')
  }
  const deps = {
    app: {
      relaunch() {
        calls.push('relaunch')
        options.relaunchError?.()
      },
    },
    dialog: {
      showErrorBox(title, content) {
        dialogs.push({ title, content })
      },
    },
    isQuitting: () => options.quitting ?? false,
    quit() {
      calls.push('quit')
      options.quitError?.()
    },
    userDataPath: join(dir, 'userData'),
    resourcesPath,
    process: fakeProcess(options.process),
    spawn(...args) {
      spawnCalls.push(args)
      if (options.spawnError !== undefined) throw options.spawnError
      return child
    },
    now: () => 1_700_000_000_000,
  }
  const restart = createTrayRestart(deps)
  return { dir, calls, dialogs, spawnCalls, child, restart, deps }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

test('tray menu keeps the existing entries and adds restart before the separator', () => {
  const actions = { open: 0, restart: 0, quit: 0 }
  const template = trayMenuTemplate(
    {
      openApplication: 'Open DeepSeek Harness',
      restartApplication: 'Restart',
      quitApplication: 'Quit DeepSeek Harness',
    },
    {
      open: () => actions.open++,
      restart: () => actions.restart++,
      quit: () => actions.quit++,
    },
  )

  assert.equal(template.length, 4)
  assert.deepEqual(
    template.map((item) => (item.type === 'separator' ? 'separator' : item.label)),
    [
      'Open DeepSeek Harness',
      'Restart DeepSeek Harness',
      'separator',
      'Quit DeepSeek Harness',
    ],
  )
  assert.equal(template[1].id, TRAY_RESTART_ITEM_ID)

  template[0].click()
  template[1].click()
  template[3].click()
  assert.deepEqual(actions, { open: 1, restart: 1, quit: 1 })
})

test('restart snapshots launch data, starts the watchdog, then relaunches and quits', () => {
  const h = harness()
  const result = h.restart.restart()
  assert.equal(result.ok, true)
  assert.equal(h.calls[0], 'relaunch')
  assert.equal(h.calls[1], 'quit')
  assert.equal(h.spawnCalls.length, 1)

  const [executable, argv, options] = h.spawnCalls[0]
  assert.equal(executable, 'C:\\Fake\\DeepSeek Harness.exe')
  assert.deepEqual(argv, [h.restart.watchdogPath, result.configPath])
  assert.equal(options.detached, true)
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(h.child.unrefCalled, true)

  const config = readJson(result.configPath)
  assert.deepEqual(config.args, ['--flag', 'value'])
  assert.equal(config.oldPid, 1234)
  assert.equal(config.executablePath, 'C:\\Fake\\DeepSeek Harness.exe')
  assert.equal(config.cwd, 'C:\\Fake')
  assert.equal('env' in config, false, 'the snapshot must not persist the process environment')
  assert.equal(JSON.stringify(config).includes('do-not-persist'), false)

  const log = readFileSync(result.logPath, 'utf8')
  assert.match(log, /restart requested/u)
  assert.match(log, /watchdog started pid=4321/u)
  assert.match(log, /app\.relaunch\(\) scheduled/u)
  assert.match(log, /graceful quit requested/u)
})

test('a second request while in flight is rejected without a second relaunch', () => {
  const h = harness()
  const first = h.restart.restart()
  assert.equal(first.ok, true)
  const second = h.restart.restart()
  assert.deepEqual(second, {
    ok: false,
    code: 'in-flight',
    detail: 'a restart is already in progress',
  })
  assert.equal(h.calls.filter((call) => call === 'relaunch').length, 1)
  assert.equal(h.calls.filter((call) => call === 'quit').length, 1)
})

test('a request while the shell is quitting is rejected', () => {
  const h = harness({ quitting: true })
  const result = h.restart.restart()
  assert.deepEqual(result, {
    ok: false,
    code: 'quitting',
    detail: 'application is already quitting',
  })
  assert.deepEqual(h.calls, [])
})

test('a relaunch failure aborts the quit, reports, and clears the in-flight guard', () => {
  const h = harness({
    relaunchError: () => {
      throw new Error('relaunch unavailable')
    },
  })
  const result = h.restart.restart()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'error')
  assert.deepEqual(h.calls, ['relaunch'])
  assert.equal(h.dialogs.length, 1)
  assert.match(h.dialogs[0].content, /relaunch unavailable/u)
  assert.equal(h.restart.inFlight, false)
  assert.equal(h.spawnCalls.length, 0, 'a failed relaunch must not leave a watchdog behind')
})

test('a missing watchdog still relaunches and quits, and records the degradation', () => {
  const h = harness({ watchdog: false })
  const result = h.restart.restart()
  assert.equal(result.ok, true)
  assert.deepEqual(h.calls, ['relaunch', 'quit'])
  assert.equal(h.spawnCalls.length, 0)
  assert.match(readFileSync(result.logPath, 'utf8'), /watchdog not found/u)
})

test('a spawning failure still relaunches and quits', () => {
  const h = harness({ spawnError: new Error('spawn EPERM') })
  const result = h.restart.restart()
  assert.equal(result.ok, true)
  assert.deepEqual(h.calls, ['relaunch', 'quit'])
  assert.match(readFileSync(result.logPath, 'utf8'), /watchdog could not be started: spawn EPERM/u)
})

test('a quit failure is reported and leaves a usable log', () => {
  const h = harness({
    quitError: () => {
      throw new Error('quit failed')
    },
  })
  const result = h.restart.restart()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'error')
  assert.equal(h.dialogs.length, 1)
  assert.match(h.dialogs[0].content, /quit failed/u)
  assert.equal(existsSync(h.restart.logPath), true)
  assert.equal(h.child.killCalled, true, 'a failed quit must stop the watchdog it started')
})

test('concurrent restart is idempotent even after a missing watchdog', () => {
  const h = harness({ watchdog: false })
  const first = h.restart.restart()
  const second = h.restart.restart()
  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.equal(second.code, 'in-flight')
})
