/**
 * /restart-dsh — ask the Desktop shell to restart the whole application.
 *
 * The native tray belongs to the Electron shell, not to a Cordis bundle; the
 * shell patch in desktop-shell/patch installs the tray item and the
 * `restart-app` Host IPC message handled here. This bundle deliberately does
 * not kill processes on its own: a plugin must not guess the shell's launch
 * path or tear down a process tree that it does not own.
 */

export const inject = ['commands']

const COMMAND_NAME = 'restart-dsh'
let requestCounter = 0

function support(options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  if (platform !== 'win32') {
    return { ok: false, reason: 'only Windows has the desktop tray integration' }
  }
  if (env.DSH_DESKTOP_RESTART_IPC !== '1') {
    return {
      ok: false,
      reason: 'the desktop shell restart patch is not installed (DSH_DESKTOP_RESTART_IPC is not set)',
    }
  }
  if (typeof process.send !== 'function' || process.connected === false) {
    return { ok: false, reason: 'the Host is not connected to the desktop shell IPC channel' }
  }
  return { ok: true }
}

function unsupportedText() {
  return [
    '无法重启：当前桌面壳未安装“重启 DeepSeek Harness”托盘补丁。',
    '托盘菜单本身属于 Electron 桌面壳，Cordis 插件无法直接修改；',
    '请先按 desktop-shell/README.md 应用补丁，然后重试 /restart-dsh。',
  ].join('')
}

/**
 * Send one fire-and-forget restart request to the shell.
 * The shell is expected to exit immediately, so the command result is cosmetic.
 */
function requestRestart() {
  return new Promise((resolve) => {
    let settled = false
    let timer
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(result)
    }
    timer = setTimeout(() => {
      finish({
        kind: 'error',
        text: '桌面壳在 5 秒内没有接受重启请求；请检查托盘补丁是否已应用，或查看 restart.log。',
      })
    }, 5000)
    timer.unref?.()

    const requestId = (Date.now() % 1_000_000_000) * 1000 + (requestCounter++ % 1000)
    try {
      process.send({ type: 'restart-app', requestId }, (error) => {
        if (error !== null && error !== undefined) {
          finish({ kind: 'error', text: `重启请求发送失败：${error.message}` })
          return
        }
        finish({ kind: 'success', text: '正在重启 DeepSeek Harness… 窗口将在几秒内重新打开。' })
      })
    } catch (error) {
      finish({
        kind: 'error',
        text: `重启请求发送失败：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  })
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.commands.register({
        name: COMMAND_NAME,
        description:
          '重启 DeepSeek Harness：通过桌面壳完整退出并以相同路径/参数重启（Windows Desktop + 托盘补丁）',
        handler: async ({ rawInput }) => {
          if (String(rawInput).trim() === '--help') {
            return {
              kind: 'success',
              text: '用法：/restart-dsh —— 通过桌面壳完整退出并重启 DeepSeek Harness；运行中的任务会被中断。',
            }
          }
          const status = support()
          if (!status.ok) {
            return { kind: 'error', text: `${unsupportedText()}（原因：${status.reason}）` }
          }
          return requestRestart()
        },
      }),
    'dsh-restart-command: /restart-dsh',
  )
}
