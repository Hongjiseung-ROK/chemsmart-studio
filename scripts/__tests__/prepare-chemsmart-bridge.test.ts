import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  findAbsoluteSymlinks,
  readPinnedPythonVersion,
  removeLocalInstallMetadata
}: {
  findAbsoluteSymlinks: (directory: string) => Array<{ path: string; target: string }>
  readPinnedPythonVersion: () => string
  removeLocalInstallMetadata: (directory: string) => void
} = require('../prepare-chemsmart-bridge.js')

const temporaryDirectories: string[] = []

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chemsmart-bridge-package-test-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true })
  }
})

describe('portable ChemSmart bridge packaging', () => {
  it('uses the repository-pinned Python 3.11 patch release', () => {
    expect(readPinnedPythonVersion()).toMatch(/^3\.11\.\d+$/)
  })

  it('rejects only symlinks that escape through an absolute target', () => {
    const directory = makeTemporaryDirectory()
    fs.writeFileSync(path.join(directory, 'python3.11'), '')
    fs.symlinkSync('python3.11', path.join(directory, 'python'))
    fs.symlinkSync('/usr/bin/python3', path.join(directory, 'external-python'))

    expect(findAbsoluteSymlinks(directory)).toEqual([
      {
        path: path.join(directory, 'external-python'),
        target: '/usr/bin/python3'
      }
    ])
  })

  it('removes local source metadata and bytecode from the packaged runtime', () => {
    const directory = makeTemporaryDirectory()
    const distInfo = path.join(directory, 'chemsmart.dist-info')
    const cache = path.join(directory, '__pycache__')
    fs.mkdirSync(distInfo)
    fs.mkdirSync(cache)
    fs.writeFileSync(path.join(distInfo, 'direct_url.json'), '{"url":"file:///private/source"}')
    fs.writeFileSync(path.join(cache, 'module.pyc'), '')
    fs.writeFileSync(path.join(directory, 'module.py'), '')

    removeLocalInstallMetadata(directory)

    expect(fs.existsSync(path.join(distInfo, 'direct_url.json'))).toBe(false)
    expect(fs.existsSync(cache)).toBe(false)
    expect(fs.existsSync(path.join(directory, 'module.py'))).toBe(true)
  })
})
