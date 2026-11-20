import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../index.js'

function install(ctx) {
  apply(ctx)
  return ctx.registered[0]
}

function makeContext() {
  const registered = []
  return {
    registered,
    commands: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    effect(callback) {
      const dispose = callback()
      return () => dispose?.()
    },
  }
}

function snapshotEnv() {
  return {
    profile: process.env.DSH_PROFILE,
    ipc: process.env.DSH_DESKTOP_RESTART_IPC,
    send: process.send,
  }
}

function restoreEnv(saved) {
  if (saved.profile === undefined) delete process.env.DSH_PROFILE
  else process.env.DSH_PROFILE = saved.profile
  if (saved.ipc === undefined) delete process.env.DSH_DESKTOP_RESTART_IPC
  else process.env.DSH_DESKTOP_RESTART_IPC = saved.ipc
  if (saved.send === undefined) delete process.send
  else process.send = saved.send
}

test('/restart-dsh sends the shell restart request', async () => {
  const saved = snapshotEnv()
  try {
    process.env.DSH_PROFILE = 'desktop'
    process.env.DSH_DESKTOP_RESTART_IPC = '1'
    const sent = []
    process.send = (message, callback) => {
      sent.push(message)
      setImmediate(() => callback(null))
      return true
    }
    const definition = install(makeContext())
    assert.equal(definition.name, 'restart-dsh')
    const result = await definition.handler({ rawInput: '' })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /正在重启/u)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'restart-app')
    assert.equal(Number.isSafeInteger(sent[0].requestId), true)
  } finally {
    restoreEnv(saved)
  }
})

test('/restart-dsh --help does not send a request', async () => {
  const saved = snapshotEnv()
  try {
    process.env.DSH_PROFILE = 'desktop'
    process.env.DSH_DESKTOP_RESTART_IPC = '1'
    let sent = 0
    process.send = () => {
      sent++
      return true
    }
    const definition = install(makeContext())
    const result = await definition.handler({ rawInput: ' --help ' })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /用法/u)
    assert.equal(sent, 0)
  } finally {
    restoreEnv(saved)
  }
})

test('/restart-dsh reports a missing shell patch', async () => {
  const saved = snapshotEnv()
  try {
    process.env.DSH_PROFILE = 'desktop'
    delete process.env.DSH_DESKTOP_RESTART_IPC
    const definition = install(makeContext())
    const result = await definition.handler({ rawInput: '' })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /未安装/u)
    assert.match(result.text, /DSH_DESKTOP_RESTART_IPC/u)
  } finally {
    restoreEnv(saved)
  }
})

test('/restart-dsh reports an IPC send failure', async () => {
  const saved = snapshotEnv()
  try {
    process.env.DSH_PROFILE = 'desktop'
    process.env.DSH_DESKTOP_RESTART_IPC = '1'
    process.send = (_message, callback) => {
      setImmediate(() => callback(new Error('channel closed')))
      return true
    }
    const definition = install(makeContext())
    const result = await definition.handler({ rawInput: '' })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /重启请求发送失败/u)
    assert.match(result.text, /channel closed/u)
  } finally {
    restoreEnv(saved)
  }
})
