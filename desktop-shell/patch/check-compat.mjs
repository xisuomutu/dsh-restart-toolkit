/*
 * Check whether this toolkit's patch anchors match an installed DSH app.asar,
 * without creating a patched copy.
 *
 * Usage:
 *   node check-compat.mjs --asar "<DSH_INSTALL>\resources\app.asar" [--exe "<DSH_INSTALL>\DeepSeek Harness.exe"] [--json]
 *
 * Exit 0: compatible, or the archive is already patched.
 * Exit 1: incompatible anchors / malformed archive / read failure.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
function arg(name) {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}
const asarPath = arg('asar')
const exePath = arg('exe')
const asJson = args.includes('--json')
if (!asarPath) {
  console.error('usage: node check-compat.mjs --asar <app.asar> [--exe <DeepSeek Harness.exe>] [--json]')
  process.exit(2)
}

const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii')
const FUSE_NAMES = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
]

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function hashFile(path) {
  const fd = openSync(path, 'r')
  const hash = createHash('sha256')
  const chunk = Buffer.alloc(4 * 1024 * 1024)
  try {
    let position = 0
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, position)
      if (read <= 0) break
      hash.update(chunk.subarray(0, read))
      position += read
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

function readExact(fd, length, position) {
  const buffer = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const chunk = readSync(fd, buffer, read, length - read, position + read)
    if (chunk <= 0) throw new Error(`unexpected EOF at ${position + read}`)
    read += chunk
  }
  return buffer
}

/** Parse the ASAR pickle header and expose a packed-file reader. */
function openArchive(path) {
  const fd = openSync(path, 'r')
  try {
    const fileSize = statSync(path).size
    const head = readExact(fd, 8, 0)
    const headerSize = head.readUInt32LE(4)
    const headerBuf = readExact(fd, headerSize, 8)
    const stringLength = headerBuf.readUInt32LE(4)
    const header = JSON.parse(headerBuf.subarray(8, 8 + stringLength).toString('utf8'))
    const dataStart = 8 + headerSize
    return {
      fileSize,
      header,
      dataStart,
      close() {
        closeSync(fd)
      },
      read(node) {
        if (node.unpacked === true) throw new Error('entry is unpacked')
        if (typeof node.size !== 'number' || node.offset === undefined) throw new Error('invalid entry')
        return readExact(fd, node.size, dataStart + Number(node.offset))
      },
    }
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

function readFuses(path) {
  if (!path) return undefined
  let buffer
  try {
    buffer = readFileSync(path)
  } catch (error) {
    return { error: `cannot read executable: ${error.message}` }
  }
  const at = buffer.indexOf(FUSE_SENTINEL)
  if (at < 0) return { error: 'fuse sentinel not found' }
  const version = buffer[at + FUSE_SENTINEL.length]
  const length = buffer[at + FUSE_SENTINEL.length + 1]
  const statuses = buffer.subarray(at + FUSE_SENTINEL.length + 2, at + FUSE_SENTINEL.length + 2 + length)
  const fuses = {}
  for (let i = 0; i < length; i += 1) {
    const value = statuses[i]
    const label = value === 0x31 ? 'enabled' : value === 0x30 ? 'disabled' : value === 0x72 ? 'removed' : `unknown(0x${value.toString(16)})`
    fuses[FUSE_NAMES[i] ?? `Fuse${i + 1}`] = label
  }
  return { version, fuses }
}

function main() {
  if (!asarPath.toLowerCase().endsWith('.asar')) {
    // The backup name app.asar.bak-<stamp> still contains a valid archive; allow it.
  }
  let archive
  try {
    archive = openArchive(asarPath)
  } catch (error) {
    const result = { asar: asarPath, error: `cannot parse ASAR: ${error.message}` }
    if (asJson) console.log(JSON.stringify(result, null, 2))
    else console.error(result.error)
    process.exit(1)
  }

  const pkgNode = archive.header.files?.['package.json']
  const mainNode = archive.header.files?.lib?.files?.['main.js']
  if (mainNode === undefined || mainNode.unpacked === true) {
    const result = { asar: asarPath, error: 'lib/main.js not found as a packed file' }
    if (asJson) console.log(JSON.stringify(result, null, 2))
    else console.error(result.error)
    process.exit(1)
  }

  const mainBytes = archive.read(mainNode)
  const mainText = mainBytes.toString('utf8')
  let version = 'unknown'
  if (pkgNode !== undefined && pkgNode.unpacked !== true) {
    try {
      version = JSON.parse(archive.read(pkgNode).toString('utf8')).version ?? 'unknown'
    } catch {
      version = 'unreadable'
    }
  }
  archive.close()

  const alreadyPatched =
    mainText.includes('function trayMenuTemplate') &&
    mainText.includes('DSH_DESKTOP_RESTART_IPC')
  const patchMarkers = {
    trayMenuTemplate: mainText.includes('function trayMenuTemplate'),
    restartFromTray: mainText.includes('const restartFromTray = () =>'),
    welcomeRetry: mainText.includes('readWelcomeStateWithRetry'),
    hostStderrLog: mainText.includes('host-stderr.log'),
  }

  let compatible = false
  let anchorsError
  if (!alreadyPatched) {
    const work = mkdtempSync(join(tmpdir(), 'dsh-compat-'))
    const input = join(work, 'main.js')
    const output = join(work, 'main.patched.js')
    writeFileSync(input, mainBytes)
    const build = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./build-patch.mjs', import.meta.url)), '--input', input, '--output', output],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    compatible = build.status === 0
    if (!compatible) {
      anchorsError = `${build.stderr || ''}\n${build.stdout || ''}`.trim().slice(-4000)
    }
  }

  const fuseInfo = readFuses(exePath)
  const warnings = []
  if (alreadyPatched) {
    warnings.push('app.asar is already patched; build from the original app.asar backup (or restore it) before regenerating.')
  }
  if (fuseInfo?.fuses?.EnableEmbeddedAsarIntegrityValidation === 'enabled') {
    warnings.push('EnableEmbeddedAsarIntegrityValidation is enabled; the patched app.asar may be rejected at launch.')
  }
  if (fuseInfo?.fuses?.RunAsNode !== undefined && fuseInfo.fuses.RunAsNode !== 'enabled') {
    warnings.push(`RunAsNode fuse is ${fuseInfo.fuses.RunAsNode}; the watchdog cannot run in Node mode and start-failure detection is degraded.`)
  }
  if (fuseInfo?.error) warnings.push(`fuse check: ${fuseInfo.error}`)

  const result = {
    asar: asarPath,
    size: archive.fileSize,
    asarSha256: hashFile(asarPath),
    version,
    mainSize: mainBytes.length,
    mainSha256: sha256(mainBytes),
    alreadyPatched,
    patchMarkers,
    compatible: alreadyPatched ? null : compatible,
    anchorsError,
    exe: exePath ?? null,
    fuses: fuseInfo?.fuses,
    warnings,
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`ASAR       : ${result.asar}`)
    console.log(`  size     : ${result.size}`)
    console.log(`  sha256   : ${result.asarSha256}`)
    console.log(`  version  : ${result.version}`)
    console.log(`  main.js  : ${result.mainSize} bytes, ${result.mainSha256}`)
    console.log(`  patched  : ${result.alreadyPatched ? 'yes' : 'no'}`)
    if (result.alreadyPatched) {
      console.log('  markers  :', JSON.stringify(result.patchMarkers))
    } else {
      console.log(`  anchors  : ${result.compatible ? 'match' : 'MISMATCH'}`)
      if (result.anchorsError) console.log(result.anchorsError)
    }
    if (result.fuses) {
      console.log('  fuses    :')
      for (const [name, value] of Object.entries(result.fuses)) console.log(`    ${name}: ${value}`)
    }
    for (const warning of result.warnings) console.log(`WARNING: ${warning}`)
  }

  process.exit(result.alreadyPatched || result.compatible ? 0 : 1)
}

main()
