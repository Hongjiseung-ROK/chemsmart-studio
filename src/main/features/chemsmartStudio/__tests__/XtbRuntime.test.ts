import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { discoverXtbRuntime, type XtbRuntimeInspector } from '../XtbRuntime'

describe('xTB runtime discovery', () => {
  const runtimeDirectories: string[] = []

  async function createRuntime() {
    const runtimeRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'chemsmart-xtb-runtime-')))
    runtimeDirectories.push(runtimeRoot)
    const binDirectory = path.join(runtimeRoot, 'bin')
    const libDirectory = path.join(runtimeRoot, 'lib')
    const parameterDirectory = path.join(runtimeRoot, 'share', 'xtb')
    await mkdir(binDirectory)
    await mkdir(libDirectory)
    await mkdir(parameterDirectory, { recursive: true })
    const executablePath = path.join(binDirectory, 'xtb')
    const xtbLibraryPath = path.join(libDirectory, 'libxtb.6.dylib')
    const supportLibraryPath = path.join(libDirectory, 'libsupport.1.dylib')
    const parameterPath = path.join(parameterDirectory, 'param_gfn2-xtb.txt')
    await writeFile(executablePath, 'fake arm64 xtb executable', { mode: 0o700 })
    await writeFile(xtbLibraryPath, 'fake xtb library')
    await writeFile(supportLibraryPath, 'fake support library')
    await writeFile(parameterPath, 'fake GFN2 parameters')
    const inspector: XtbRuntimeInspector = {
      async getArchitecture() {
        return 'arm64'
      },
      async getVersion() {
        return '6.7.1'
      },
      async inspectDynamicLibraries(filePath) {
        if (filePath === executablePath) {
          return {
            dependencies: ['@rpath/libxtb.6.dylib', '/usr/lib/libSystem.B.dylib'],
            runpaths: ['@loader_path/../lib']
          }
        }
        if (filePath === xtbLibraryPath) {
          return {
            dependencies: ['@loader_path/libsupport.1.dylib'],
            runpaths: []
          }
        }
        return { dependencies: ['/usr/lib/libSystem.B.dylib'], runpaths: [] }
      }
    }
    return { executablePath, inspector, parameterPath, runtimeRoot, supportLibraryPath }
  }

  afterEach(async () => {
    await Promise.all(runtimeDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  it('recursively fingerprints the executable and every non-system library without exposing paths', async () => {
    const { executablePath, inspector, runtimeRoot } = await createRuntime()

    const runtime = await discoverXtbRuntime(executablePath, inspector)

    expect(runtime.identity).toMatchObject({
      kind: 'local_executable',
      engine: 'xtb',
      version: '6.7.1',
      architecture: 'arm64'
    })
    expect(runtime.identity.executableDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(runtime.identity.runtimeFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(runtime.identity.libraries.map(({ name }) => name)).toEqual(['libsupport.1.dylib', 'libxtb.6.dylib'])
    expect(runtime.identity.resources?.map(({ name }) => name)).toEqual(['param_gfn2-xtb.txt'])
    expect(JSON.stringify(runtime.identity)).not.toContain(runtimeRoot)
    await expect(runtime.assertUnchanged()).resolves.toBeUndefined()
  })

  it('caps each runtime fingerprint read buffer at one MiB', async () => {
    const { executablePath, inspector, parameterPath } = await createRuntime()
    await writeFile(parameterPath, Buffer.alloc(2 * 1024 * 1024, 0x61))
    const allocate = vi.spyOn(Buffer, 'allocUnsafe')
    let requestedSizes: number[] = []

    try {
      await discoverXtbRuntime(executablePath, inspector)
      requestedSizes = allocate.mock.calls.map(([size]) => size)
    } finally {
      allocate.mockRestore()
    }

    expect(requestedSizes).toContain(1024 * 1024)
    expect(Math.max(...requestedSizes)).toBeLessThanOrEqual(1024 * 1024)
  })

  it('detects a runtime file changed after discovery', async () => {
    const { executablePath, inspector, supportLibraryPath } = await createRuntime()
    const runtime = await discoverXtbRuntime(executablePath, inspector)
    await writeFile(supportLibraryPath, 'mutated support library')

    await expect(runtime.assertUnchanged()).rejects.toThrow('xTB runtime identity changed')
  })

  it('detects GFN2 parameter data changed after discovery', async () => {
    const { executablePath, inspector, parameterPath } = await createRuntime()
    const runtime = await discoverXtbRuntime(executablePath, inspector)
    await writeFile(parameterPath, 'mutated GFN2 parameters')

    await expect(runtime.assertUnchanged()).rejects.toThrow('xTB runtime identity changed')
  })

  it('detects a dependency symlink retargeted after discovery', async () => {
    const { executablePath, inspector, runtimeRoot } = await createRuntime()
    const libraryPath = path.join(runtimeRoot, 'lib', 'libxtb.6.dylib')
    const originalPath = path.join(runtimeRoot, 'lib', 'libxtb-original.dylib')
    const replacementPath = path.join(runtimeRoot, 'lib', 'libxtb-replacement.dylib')
    await writeFile(originalPath, 'original library')
    await writeFile(replacementPath, 'replacement library')
    await rm(libraryPath)
    await symlink(originalPath, libraryPath)
    const runtime = await discoverXtbRuntime(executablePath, inspector)
    await rm(libraryPath)
    await symlink(replacementPath, libraryPath)

    await expect(runtime.assertUnchanged()).rejects.toThrow('xTB runtime identity changed')
  })

  it('rejects unresolved and runtime-root-escaping non-system dependencies', async () => {
    const { executablePath, inspector } = await createRuntime()
    const outsideRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'chemsmart-xtb-outside-')))
    runtimeDirectories.push(outsideRoot)
    const outsideLibrary = path.join(outsideRoot, 'libescape.dylib')
    await writeFile(outsideLibrary, 'outside library')
    inspector.inspectDynamicLibraries = async () => ({
      dependencies: [outsideLibrary],
      runpaths: []
    })

    await expect(discoverXtbRuntime(executablePath, inspector)).rejects.toThrow(
      'xTB dependency escaped the configured runtime root'
    )
  })
})
