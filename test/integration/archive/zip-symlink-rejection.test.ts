import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import extractZip from 'extract-zip'
import yauzl from 'yauzl'
import { makeZipExtractionGuard } from '../../../src/main/archive/zip-extraction-guard'
import { toSafeError } from '../../../src/main/errors'
import { buildZip } from '../../helpers/zip-fixture'

const SANDBOX_PREFIX = 'zip-symlink-rejection-'
const SYMLINK_MESSAGE = 'Символические ссылки внутри ZIP-архива запрещены.'
const SYMLINK_TARGET = '../outside/sentinel.txt'
const SENTINEL_CONTENT = Buffer.from('ORIGINAL_SENTINEL_CONTENT')
const REPLACEMENT_CONTENT = Buffer.from('REPLACEMENT_CONTENT')
const UNIX_VERSION_MADE_BY = (3 << 8) | 20
const SYMLINK_EXTERNAL_FILE_ATTRIBUTES = (0xa1ff << 16) >>> 0
const REGULAR_EXTERNAL_FILE_ATTRIBUTES = (0x81a4 << 16) >>> 0

interface InspectedEntry {
  fileName: string
  externalFileAttributes: number
  versionMadeBy: number
  data: Buffer
}

let sandboxDir = ''
let archivePath = ''
let extractDir = ''
let sentinelPath = ''

function assertTestOwnedSandbox(path: string): void {
  const resolvedPath = resolve(path)
  if (
    dirname(resolvedPath) !== resolve(tmpdir()) ||
    !basename(resolvedPath).startsWith(SANDBOX_PREFIX)
  ) {
    throw new Error('Refusing to clean a directory that is not the test-owned sandbox.')
  }
}

function assertSandboxChild(path: string): void {
  if (dirname(resolve(path)) !== resolve(sandboxDir)) {
    throw new Error('Refusing to clean a path outside the test-owned sandbox.')
  }
}

function hasFilesystemEntry(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function inspectZipEntries(path: string): Promise<InspectedEntry[]> {
  return new Promise((resolvePromise, rejectPromise) => {
    const entries: InspectedEntry[] = []
    let settled = false

    const rejectOnce = (error: unknown): void => {
      if (settled) return
      settled = true
      rejectPromise(error instanceof Error ? error : new Error(String(error)))
    }

    yauzl.open(path, { lazyEntries: true, autoClose: true }, (openError, zipfile) => {
      if (openError || !zipfile) {
        rejectOnce(openError ?? new Error('Failed to inspect ZIP fixture.'))
        return
      }

      zipfile.on('error', rejectOnce)
      zipfile.on('end', () => {
        if (settled) return
        settled = true
        resolvePromise(entries)
      })
      zipfile.on('entry', (entry) => {
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            rejectOnce(streamError ?? new Error('Failed to inspect ZIP entry data.'))
            return
          }

          const chunks: Buffer[] = []
          stream.on('error', rejectOnce)
          stream.on('data', (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          })
          stream.on('end', () => {
            if (settled) return
            entries.push({
              fileName: entry.fileName,
              externalFileAttributes: entry.externalFileAttributes,
              versionMadeBy: entry.versionMadeBy,
              data: Buffer.concat(chunks)
            })
            zipfile.readEntry()
          })
        })
      })

      zipfile.readEntry()
    })
  })
}

async function expectRejectedError(run: () => Promise<void>): Promise<Error> {
  try {
    await run()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(Error)
    return error as Error
  }

  throw new Error(`Expected extraction to reject: ${SYMLINK_MESSAGE}`)
}

beforeEach(() => {
  sandboxDir = mkdtempSync(join(tmpdir(), SANDBOX_PREFIX))
  assertTestOwnedSandbox(sandboxDir)

  archivePath = join(sandboxDir, 'archive.zip')
  extractDir = join(sandboxDir, 'extract')
  const outsideDir = join(sandboxDir, 'outside')
  sentinelPath = join(outsideDir, 'sentinel.txt')

  mkdirSync(extractDir)
  mkdirSync(outsideDir)
  writeFileSync(sentinelPath, SENTINEL_CONTENT)

  expect(isAbsolute(SYMLINK_TARGET)).toBe(false)
  expect(resolve(extractDir, SYMLINK_TARGET)).toBe(resolve(sentinelPath))

  writeFileSync(archivePath, buildZip([
    {
      name: 'alias',
      data: Buffer.from(SYMLINK_TARGET),
      versionMadeBy: UNIX_VERSION_MADE_BY,
      externalFileAttributes: SYMLINK_EXTERNAL_FILE_ATTRIBUTES
    },
    {
      name: 'alias',
      data: REPLACEMENT_CONTENT,
      versionMadeBy: UNIX_VERSION_MADE_BY,
      externalFileAttributes: REGULAR_EXTERNAL_FILE_ATTRIBUTES
    }
  ]))
})

afterEach(() => {
  if (!sandboxDir) return
  assertTestOwnedSandbox(sandboxDir)
  rmSync(sandboxDir, { recursive: true, force: true })
  sandboxDir = ''
})

describe('ZIP symlink rejection — real extract-zip callback', () => {
  it('rejects before materialization and preserves the sandbox sentinel', async () => {
    const inspectedEntries = await inspectZipEntries(archivePath)
    expect(inspectedEntries).toHaveLength(2)

    const symlinkEntry = inspectedEntries[0]
    const symlinkMode = (symlinkEntry.externalFileAttributes >> 16) & 0xffff
    expect(symlinkEntry.fileName).toBe('alias')
    expect(symlinkEntry.versionMadeBy).toBe(UNIX_VERSION_MADE_BY)
    expect(symlinkEntry.externalFileAttributes).toBe(SYMLINK_EXTERNAL_FILE_ATTRIBUTES)
    expect(symlinkMode & 0xf000).toBe(0xa000)
    expect(symlinkEntry.data.equals(Buffer.from(SYMLINK_TARGET))).toBe(true)

    const regularEntry = inspectedEntries[1]
    const regularMode = (regularEntry.externalFileAttributes >> 16) & 0xffff
    expect(regularEntry.fileName).toBe('alias')
    expect(regularMode & 0xf000).toBe(0x8000)
    expect(regularEntry.data.equals(REPLACEMENT_CONTENT)).toBe(true)

    const sentinelBefore = readFileSync(sentinelPath)
    const aliasPath = join(extractDir, 'alias')

    try {
      const error = await expectRejectedError(() => extractZip(archivePath, {
        dir: extractDir,
        onEntry: makeZipExtractionGuard()
      }))

      expect(error.message).toBe(SYMLINK_MESSAGE)
      expect(toSafeError(error, 'Unexpected extraction failure.')).toBe(SYMLINK_MESSAGE)
      expect(hasFilesystemEntry(sentinelPath)).toBe(true)
      expect(readFileSync(sentinelPath).equals(sentinelBefore)).toBe(true)
      expect(hasFilesystemEntry(aliasPath)).toBe(false)
    } finally {
      assertSandboxChild(extractDir)
      rmSync(extractDir, { recursive: true, force: true })
    }

    expect(hasFilesystemEntry(extractDir)).toBe(false)
    expect(hasFilesystemEntry(sentinelPath)).toBe(true)
    expect(readFileSync(sentinelPath).equals(SENTINEL_CONTENT)).toBe(true)
  })
})
