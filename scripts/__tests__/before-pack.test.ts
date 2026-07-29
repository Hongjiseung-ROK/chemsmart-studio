import fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  buildElectronRebuildInvocation,
  prepareElectronNativeModules
}: {
  buildElectronRebuildInvocation: (context: BuildContext, arch: string) => ElectronRebuildInvocation
  prepareElectronNativeModules: (
    context: BuildContext,
    platform: NodeJS.Platform,
    arch: string,
    runner?: ElectronRebuildRunner
  ) => boolean
} = require('../before-pack.js')

interface BuildContext {
  packager: {
    config: {
      electronVersion: string
      npmRebuild?: boolean
    }
  }
}

interface ElectronRebuildInvocation {
  executable: string
  args: string[]
  options: { cwd: string; stdio: string }
}

type ElectronRebuildRunner = (
  executable: string,
  args: string[],
  options: ElectronRebuildInvocation['options']
) => unknown

function context(): BuildContext {
  return {
    packager: {
      config: {
        electronVersion: '41.8.0'
      }
    }
  }
}

describe('ChemSmart Studio package boundary', () => {
  it('does not package the retired Qt and Avogadro floor', () => {
    const packageConfig = fs.readFileSync(path.resolve('electron-builder.yml'), 'utf8')
    const beforePack = fs.readFileSync(path.resolve('scripts/before-pack.js'), 'utf8')
    const notices = fs.readFileSync(path.resolve('THIRD_PARTY_NOTICES.md'), 'utf8')
    const lock = fs.readFileSync(path.resolve('upstreams.lock.json'), 'utf8')
    const retiredTerms = [/chemsmart-editor/i, /chemsmart-iosurface/i, /vendor\/avogadrolibs/i, /avogadro/i, /qt6/i]

    for (const source of [packageConfig, beforePack, notices, lock]) {
      for (const term of retiredTerms) expect(source).not.toMatch(term)
    }
  })
})

describe('Electron native dependency packaging', () => {
  it('rebuilds the required native modules for the target Electron ABI serially', () => {
    const invocation = buildElectronRebuildInvocation(context(), 'arm64')

    expect(invocation.executable).toBe(process.execPath)
    expect(invocation.args).toEqual([
      expect.stringMatching(/@electron[+/]rebuild.*lib[\\/]cli\.js$/),
      '--version',
      '41.8.0',
      '--module-dir',
      path.resolve('.'),
      '--arch',
      'arm64',
      '--only',
      'better-sqlite3,@paymoapp/electron-shutdown-handler',
      '--sequential',
      '--force'
    ])
    expect(invocation.options).toEqual({ cwd: path.resolve('.'), stdio: 'inherit' })
  })

  it('disables only the duplicate package-builder rebuild after a same-platform rebuild', () => {
    const buildContext = context()
    const runner = vi.fn()

    expect(prepareElectronNativeModules(buildContext, process.platform, 'arm64', runner)).toBe(true)
    expect(runner).toHaveBeenCalledOnce()
    expect(buildContext.packager.config.npmRebuild).toBe(false)
  })

  it('retains the package-builder rebuild for cross-platform targets', () => {
    const buildContext = context()
    const runner = vi.fn()
    const otherPlatform: NodeJS.Platform = process.platform === 'win32' ? 'darwin' : 'win32'

    expect(prepareElectronNativeModules(buildContext, otherPlatform, 'x64', runner)).toBe(false)
    expect(runner).not.toHaveBeenCalled()
    expect(buildContext.packager.config.npmRebuild).toBeUndefined()
  })
})
