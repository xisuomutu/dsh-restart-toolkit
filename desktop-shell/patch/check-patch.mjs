/*
 * Verify that the shell patch anchors still match a main.js from the running
 * DSH installation. Read-only: it writes only to a temp directory.
 *
 *   node check-patch.mjs path/to/extracted/lib/main.js
 *
 * Exit 0: every anchor matched exactly once and the patched file parses.
 * Exit 1: a DSH update changed the shell; regenerate the patch.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const input = process.argv[2]
if (!input) {
  console.error('usage: node check-patch.mjs <lib/main.js>')
  process.exit(2)
}
const buildScript = fileURLToPath(new URL('./build-patch.mjs', import.meta.url))
const output = join(mkdtempSync(join(tmpdir(), 'dsh-patch-check-')), 'main.patched.js')

const build = spawnSync(process.execPath, [buildScript, '--input', input, '--output', output], {
  encoding: 'utf8',
  windowsHide: true,
})
if (build.status !== 0) {
  console.error('patch anchors do not match this main.js:')
  console.error((build.stderr || build.stdout || '').trim())
  process.exit(1)
}

const patched = readFileSync(output, 'utf8')
const markers = [
  'function trayMenuTemplate(messages, actions)',
  'const restartFromTray = () =>',
  'DSH_DESKTOP_RESTART_IPC: "1"',
  'case "restart-app"',
  'onRestartRequest',
  'restart: () => {',
  'readWelcomeStateWithRetry',
  'host-stderr.log',
  'startup.log',
]
const missing = markers.filter((marker) => !patched.includes(marker))
if (missing.length > 0) {
  console.error(`patched output is missing markers: ${missing.join(', ')}`)
  process.exit(1)
}

const syntax = spawnSync(process.execPath, ['--check', output], {
  encoding: 'utf8',
  windowsHide: true,
})
if (syntax.status !== 0) {
  console.error('patched main.js does not parse:')
  console.error((syntax.stderr || '').trim())
  process.exit(1)
}

console.log(`OK: ${input}`)
console.log('  all anchors matched once')
console.log(`  patched output parses (${patched.length} chars)`)
console.log(`  temp output: ${output}`)
