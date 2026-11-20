/*
 * Build a patched copy of DSH's app.asar without repacking 209 MB of files.
 *
 * The original archive is copied verbatim. Only the JSON header is rewritten
 * (same byte length, padded) and the patched lib/main.js is appended at the end;
 * its header entry is repointed there. Every other file keeps its original
 * offset, size and bytes.
 *
 * Usage:
 *   node repack-asar.mjs <app.asar> <app.patched.asar>
 *
 * The output is a NEW file. This script never modifies the input archive and
 * never touches app.asar.unpacked.
 *
 * Verification is done by the companion check, or with Electron's ASAR-aware
 * fs (see docs/03-test-plan.md).
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const input = process.argv[2]
const output = process.argv[3]
const reportIndex = process.argv.indexOf('--report')
const reportPath = reportIndex === -1 ? undefined : process.argv[reportIndex + 1]
if (!input || !output) {
  console.error('usage: node repack-asar.mjs <app.asar> <app.patched.asar> [--report report.json]')
  process.exit(2)
}
if (input === output) {
  console.error('refusing to overwrite the input archive')
  process.exit(2)
}
if (reportIndex !== -1 && (!reportPath || reportPath === output || reportPath === input)) {
  console.error('--report needs a path different from the input and output')
  process.exit(2)
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

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
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

/** Parse the ASAR header (Electron's pickle layout). */
function parseArchive(path) {
  const fd = openSync(path, 'r')
  try {
    const fileSize = statSync(path).size
    const head = readExact(fd, 8, 0)
    const headerSize = head.readUInt32LE(4)
    const headerStart = 8
    const headerBuf = readExact(fd, headerSize, headerStart)
    const stringLength = headerBuf.readUInt32LE(4)
    const headerJson = headerBuf.subarray(8, 8 + stringLength)
    const header = JSON.parse(headerJson.toString('utf8'))
    return {
      fd,
      close() {
        closeSync(fd)
      },
      fileSize,
      headerSize,
      headerStart,
      headerStringLength: stringLength,
      headerBuf,
      header,
      dataStart: headerStart + headerSize,
      dataLength: fileSize - headerStart - headerSize,
      readFile(node) {
        if (node.unpacked === true) throw new Error('cannot read an unpacked entry from the archive')
        return readExact(fd, node.size, this.dataStart + Number(node.offset))
      },
    }
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

const archive = parseArchive(input)
try {
  if (output !== input && !output.endsWith('.asar')) {
    // Electron's path splitter looks for a ".asar" segment; keep the suffix.
    console.warn('warning: output does not end in .asar; Electron may not recognize it as an archive')
  }

  const mainNode = archive.header.files?.lib?.files?.['main.js']
  if (mainNode === undefined || mainNode.unpacked === true) fail('lib/main.js not found as a packed file')
  const originalMain = archive.readFile(mainNode)
  if (originalMain.length !== mainNode.size) fail('main.js size does not match the header')
  if (mainNode.integrity?.hash) {
    const actual = createHash('sha256').update(originalMain).digest('hex')
    if (actual !== mainNode.integrity.hash) fail('original main.js does not match its ASAR integrity hash')
  }

  // Generate the patched main.js with the strict anchor builder.
  const work = mkdtempSync(join(tmpdir(), 'dsh-asar-patch-'))
  const originalPath = join(work, 'main.orig.js')
  const patchedPath = join(work, 'main.patched.js')
  writeFileSync(originalPath, originalMain)
  const build = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./build-patch.mjs', import.meta.url)), '--input', originalPath, '--output', patchedPath],
    { encoding: 'utf8', windowsHide: true },
  )
  if (build.status !== 0) {
    fail(`build-patch.mjs failed:\n${build.stderr || build.stdout}`)
  }
  const patched = readFileSync(patchedPath)
  if (patched.length < 1024) fail('patched main.js looks implausible')

  // Rewrite only the main.js entry in the header. Removing its integrity record
  // shortens the JSON enough to fit the original header slot; Electron's ASAR
  // integrity fuse is disabled on this build, and stale hashes must not remain.
  const newNode = {
    ...mainNode,
    size: patched.length,
    offset: String(archive.dataLength),
  }
  delete newNode.integrity
  archive.header.files.lib.files['main.js'] = newNode

  const newJson = Buffer.from(JSON.stringify(archive.header), 'utf8')
  if (newJson.length > archive.headerStringLength) {
    fail(
      `new header is ${newJson.length} bytes but the original slot is ${archive.headerStringLength}; ` +
        'refusing to shift every file offset. Remove more optional header fields or use a full repack.',
    )
  }
  const padded = Buffer.alloc(archive.headerStringLength, 0x20)
  newJson.copy(padded)

  // Copy the archive, patch the header JSON in place, append the new main.js.
  copyFileSync(input, output)
  const out = openSync(output, 'r+')
  try {
    writeSync(out, padded, 0, padded.length, archive.headerStart + 8)
    const appendAt = archive.dataStart + archive.dataLength
    writeSync(out, patched, 0, patched.length, appendAt)
    const finalSize = statSync(output).size
    const expected = appendAt + patched.length
    if (finalSize !== expected) fail(`output size ${finalSize} != expected ${expected}`)
  } finally {
    closeSync(out)
  }

  // Verify the new archive by parsing it again and reading a few untouched files.
  const check = parseArchive(output)
  try {
    const checkedMain = check.header.files.lib.files['main.js']
    if (checkedMain.size !== patched.length) fail('patched archive reports the wrong main.js size')
    if (checkedMain.offset !== String(archive.dataLength)) fail('patched archive reports the wrong main.js offset')
    if (checkedMain.integrity !== undefined) fail('patched archive still carries a stale main.js integrity record')
    const readBack = check.readFile(checkedMain)
    const wanted = createHash('sha256').update(patched).digest('hex')
    const got = createHash('sha256').update(readBack).digest('hex')
    if (wanted !== got) fail('patched main.js read-back hash mismatch')

    const sample = archive.header.files?.['lib']?.files?.['preload-app.cjs']
    if (sample !== undefined && sample.unpacked !== true) {
      const original = archive.readFile(sample)
      const copy = check.readFile(check.header.files.lib.files['preload-app.cjs'])
      if (!original.equals(copy)) fail('untouched file changed during the patch')
    }
  } finally {
    check.close()
  }

  console.log('patched archive written:', output)
  console.log(`  main.js: ${mainNode.size} -> ${patched.length} bytes`)
  console.log(`  main.js offset: ${mainNode.offset} -> ${newNode.offset}`)
  console.log(`  header JSON: ${newJson.length}/${archive.headerStringLength} bytes (padded in place)`)
  console.log(`  data start unchanged: ${archive.dataStart}`)
  console.log(`  archive size: ${archive.fileSize} -> ${statSync(output).size}`)
  console.log('  read-back: main.js hash OK, sample untouched file OK')

  if (reportPath !== undefined) {
    const report = {
      format: 1,
      builtAt: new Date().toISOString(),
      input,
      output,
      inputSize: archive.fileSize,
      outputSize: statSync(output).size,
      inputSha256: hashFile(input),
      outputSha256: hashFile(output),
      mainOriginalSize: mainNode.size,
      mainPatchedSize: patched.length,
      mainOriginalSha256: createHash('sha256').update(originalMain).digest('hex'),
      mainPatchedSha256: createHash('sha256').update(patched).digest('hex'),
      mainOriginalOffset: String(mainNode.offset),
      mainPatchedOffset: newNode.offset,
      headerJsonBytes: newJson.length,
      headerSlotBytes: archive.headerStringLength,
      dataStart: archive.dataStart,
    }
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.log('report written:', reportPath)
  }
} finally {
  archive.close()
}
