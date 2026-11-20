import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const watchdog = fileURLToPath(new URL('../runtime/tray-restart-watchdog.cjs', import.meta.url))

function dir() {
  return mkdtempSync(join(tmpdir(), 'dsh-watchdog-test-'))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function kill(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return
  spawnSync('taskkill.exe', ['/PID', String(pid), '/F'], { windowsHide: true })
}

function waitExit(child, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('child did not exit in time'))
    }, timeoutMs)
    timer.unref?.()
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function startOldApp() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
    stdio: 'ignore',
    windowsHide: true,
  })
}

function writeConfig(path, config) {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

function baseConfig(root, overrides) {
  return {
    version: 1,
    createdAt: Date.now(),
    oldPid: 1,
    cutoff: Date.now(),
    executablePath: process.execPath,
    args: [],
    cwd: root,
    logPath: join(root, 'watchdog.log'),
    receiptPath: join(root, 'result.json'),
    testMode: true,
    timeouts: { exitMs: 2000, forceMs: 2000, startMs: 1500, settleMs: 800 },
    ...overrides,
  }
}

function readReceipt(root) {
  return JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'))
}

test('watchdog starts a replacement when no relaunched process appears', { timeout: 40000 }, async () => {
  const root = dir()
  const pidFile = join(root, 'new.pid')
  const appScript = join(root, 'new-app.cjs')
  writeFileSync(
    appScript,
    `const fs = require('node:fs')\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\nsetInterval(() => {}, 1000)\n`,
  )
  const old = startOldApp()
  await sleep(400)
  const configPath = join(root, 'config.json')
  writeConfig(
    configPath,
    baseConfig(root, {
      oldPid: old.pid,
      cutoff: Date.now(),
      args: [appScript],
    }),
  )
  const child = spawn(process.execPath, [watchdog, configPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  // Let the watchdog begin waiting, then close the old instance so it can move on.
  setTimeout(() => old.kill(), 700)
  const result = await waitExit(child)
  assert.equal(result.code, 0, `stderr:\n${stderr}`)
  const receipt = readReceipt(root)
  assert.equal(receipt.status, 'ok')
  assert.ok(Array.isArray(receipt.newPids) && receipt.newPids.length > 0)
  const newPid = Number(readFileSync(pidFile, 'utf8'))
  assert.ok(isAlive(newPid), 'the fallback app must be alive')
  kill(newPid)
})

test('watchdog force-kills an old process that exceeds the graceful exit deadline', { timeout: 40000 }, async () => {
  const root = dir()
  const pidFile = join(root, 'new.pid')
  const appScript = join(root, 'new-app.cjs')
  writeFileSync(
    appScript,
    `const fs = require('node:fs')\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\nsetInterval(() => {}, 1000)\n`,
  )
  const old = startOldApp()
  await sleep(400)
  const configPath = join(root, 'config.json')
  writeConfig(
    configPath,
    baseConfig(root, {
      oldPid: old.pid,
      cutoff: Date.now(),
      args: [appScript],
      timeouts: { exitMs: 400, forceMs: 3000, startMs: 1500, settleMs: 800 },
    }),
  )
  const child = spawn(process.execPath, [watchdog, configPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const result = await waitExit(child)
  assert.equal(result.code, 0, `stderr:\n${stderr}`)
  const log = readFileSync(join(root, 'watchdog.log'), 'utf8')
  assert.match(log, /force-killing/u)
  assert.equal(readReceipt(root).status, 'ok')
  const newPid = Number(readFileSync(pidFile, 'utf8'))
  kill(newPid)
})

test('watchdog records a failed start and exits non-zero', { timeout: 30000 }, async () => {
  const root = dir()
  const old = startOldApp()
  await sleep(300)
  const bad = join(root, 'not-an-executable.txt')
  writeFileSync(bad, 'not a program\n')
  const configPath = join(root, 'config.json')
  writeConfig(
    configPath,
    baseConfig(root, {
      oldPid: old.pid,
      cutoff: Date.now(),
      executablePath: bad,
      timeouts: { exitMs: 1500, forceMs: 1000, startMs: 300, settleMs: 100 },
    }),
  )
  const child = spawn(process.execPath, [watchdog, configPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  setTimeout(() => old.kill(), 400)
  const result = await waitExit(child)
  assert.equal(result.code, 1, `stderr:\n${stderr}`)
  const receipt = readReceipt(root)
  assert.equal(receipt.status, 'failed')
  assert.match(String(receipt.code), /spawn-error|start-exited|start-failed|start-unstable/u)
  const log = readFileSync(join(root, 'watchdog.log'), 'utf8')
  assert.match(log, /FAILED/u)
})

test('watchdog survives force-killing the old tree that contains it', { timeout: 60000 }, async () => {
  const root = dir()
  const pidFile = join(root, 'new.pid')
  const appScript = join(root, 'new-app.cjs')
  writeFileSync(
    appScript,
    `const fs = require('node:fs')\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\nsetInterval(() => {}, 1000)\n`,
  )
  const readyFile = join(root, 'old.pid')
  const configPath = join(root, 'config.json')
  const oldMainScript = join(root, 'fake-old-main.cjs')
  writeFileSync(
    oldMainScript,
    [
      "const fs = require('node:fs')",
      "const { spawn } = require('node:child_process')",
      `const watchdog = ${JSON.stringify(watchdog)}`,
      `const config = ${JSON.stringify(configPath)}`,
      `const ready = ${JSON.stringify(readyFile)}`,
      'fs.writeFileSync(ready, String(process.pid))',
      'const start = () => {',
      '  if (!fs.existsSync(config)) { setTimeout(start, 50); return }',
      '  const child = spawn(process.execPath, [watchdog, config], { stdio: "ignore", detached: true })',
      '  child.unref()',
      '}',
      'start()',
      'setInterval(() => {}, 1000)',
    ].join('\n'),
  )
  const oldMain = spawn(process.execPath, [oldMainScript], {
    stdio: 'ignore',
    windowsHide: true,
  })
  // Wait for the fake old main to publish its PID, then write the watchdog
  // config so it spawns the watchdog as its own child.
  const deadline = Date.now() + 10000
  while (!existsSync(readyFile) && Date.now() < deadline) await sleep(50)
  assert.ok(existsSync(readyFile), 'fake old main did not become ready')
  const oldPid = Number(readFileSync(readyFile, 'utf8'))
  writeConfig(
    configPath,
    baseConfig(root, {
      oldPid,
      cutoff: Date.now(),
      args: [appScript],
      timeouts: { exitMs: 500, forceMs: 5000, startMs: 2000, settleMs: 800 },
    }),
  )

  // The watchdog (child of oldPid) must not be killed by taskkill /T; it should
  // force-kill the fake old main, start the replacement, and write the receipt.
  const receiptDeadline = Date.now() + 40000
  while (!existsSync(join(root, 'result.json')) && Date.now() < receiptDeadline) await sleep(100)
  assert.ok(existsSync(join(root, 'result.json')), 'watchdog did not produce a receipt')
  const receipt = readReceipt(root)
  assert.equal(receipt.status, 'ok')
  assert.equal(isAlive(oldPid), false, 'the old main must be dead')
  const newPid = Number(readFileSync(pidFile, 'utf8'))
  assert.ok(isAlive(newPid), 'the replacement app must be alive')
  kill(newPid)
  kill(oldPid)
  try {
    oldMain.kill()
  } catch {
    // ignore
  }
})
