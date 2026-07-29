import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import path from 'node:path'

import type { ControlledCalculationExecutableIdentity } from '@chemsmart/studio-protocol'

import { runBoundedProcess } from './BoundedProcess'

const MAX_RUNTIME_FILE_BYTES = 512 * 1024 * 1024
const FINGERPRINT_READ_BUFFER_BYTES = 1024 * 1024
const MAX_DYNAMIC_LIBRARIES = 128
const SYSTEM_LIBRARY_ROOTS = ['/System/Library/', '/usr/lib/'] as const
const GFN2_PARAMETER_FILE = 'param_gfn2-xtb.txt'

interface DynamicLibraryInfo {
  dependencies: string[]
  runpaths: string[]
}

export interface XtbRuntimeInspector {
  getArchitecture(executablePath: string): Promise<string>
  getVersion(executablePath: string): Promise<string>
  inspectDynamicLibraries(filePath: string): Promise<DynamicLibraryInfo>
}

interface RuntimeFile {
  filePath: string
  lookupPaths: string[]
  digest: string
  device: number
  inode: number
  size: number
  mtimeMs: number
}

interface PendingLibrary {
  filePath: string
  lookupPath: string
  name: string
}

function sha256(data: Buffer | string): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function isSystemLibrary(dependency: string): boolean {
  return SYSTEM_LIBRARY_ROOTS.some((root) => dependency.startsWith(root))
}

async function fingerprintFile(
  filePath: string,
  requireExecutable = false,
  lookupPaths: string[] = [filePath]
): Promise<RuntimeFile> {
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    if (
      !before.isFile() ||
      before.size > MAX_RUNTIME_FILE_BYTES ||
      (requireExecutable && (before.mode & 0o111) === 0)
    ) {
      throw new Error('xTB runtime file is invalid')
    }
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(Math.min(FINGERPRINT_READ_BUFFER_BYTES, before.size + 1))
    let bytesRead = 0
    while (true) {
      const result = await file.read(buffer, 0, buffer.length, bytesRead)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
      if (bytesRead > before.size) throw new Error('xTB runtime file changed while it was inspected')
      hash.update(buffer.subarray(0, result.bytesRead))
    }
    const after = await file.stat()
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      bytesRead !== before.size
    ) {
      throw new Error('xTB runtime file changed while it was inspected')
    }
    return {
      filePath,
      lookupPaths,
      digest: `sha256:${hash.digest('hex')}`,
      device: before.dev,
      inode: before.ino,
      size: before.size,
      mtimeMs: before.mtimeMs
    }
  } finally {
    await file.close()
  }
}

async function runInspectorCommand(command: string, args: string[], name: string, cwd: string): Promise<string> {
  const result = await runBoundedProcess({
    name,
    command,
    args,
    cwd,
    timeoutMs: 5_000,
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 1024 * 1024
  })
  if (result.exitCode !== 0 || result.signal !== null) {
    throw new Error(`${name} failed while inspecting the configured xTB runtime`)
  }
  return `${result.stdout}\n${result.stderr}`
}

const systemInspector: XtbRuntimeInspector = {
  async getArchitecture(executablePath) {
    const output = await runInspectorCommand(
      '/usr/bin/lipo',
      ['-archs', executablePath],
      'xtb-architecture',
      path.dirname(executablePath)
    )
    const architectures = output.trim().split(/\s+/).filter(Boolean)
    if (architectures.length === 0 || architectures.some((value) => !/^[A-Za-z0-9_.-]+$/.test(value))) {
      throw new Error('xTB executable architecture could not be verified')
    }
    return architectures.sort().join('+')
  },

  async getVersion(executablePath) {
    const output = await runInspectorCommand(executablePath, ['--version'], 'xtb-version', path.dirname(executablePath))
    const match = output.match(/\bxtb version\s+([0-9]+(?:\.[0-9A-Za-z-]+)+)/i)
    if (!match) throw new Error('xTB version could not be verified')
    return match[1]
  },

  async inspectDynamicLibraries(filePath) {
    const cwd = path.dirname(filePath)
    const dependenciesOutput = await runInspectorCommand('/usr/bin/otool', ['-L', filePath], 'xtb-library-list', cwd)
    const loadCommandsOutput = await runInspectorCommand('/usr/bin/otool', ['-l', filePath], 'xtb-load-commands', cwd)
    const dependencies = dependenciesOutput
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+\(/, 1)[0])
      .filter(Boolean)
    const runpaths: string[] = []
    const lines = loadCommandsOutput.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].trim() !== 'cmd LC_RPATH') continue
      for (let cursor = index + 1; cursor < Math.min(index + 5, lines.length); cursor += 1) {
        const match = lines[cursor].trim().match(/^path\s+(.+?)\s+\(offset\s+\d+\)$/)
        if (match) {
          runpaths.push(match[1])
          break
        }
      }
    }
    return { dependencies, runpaths }
  }
}

async function resolveRunpath(runpath: string, loaderPath: string, executablePath: string): Promise<string> {
  const expanded = runpath
    .replace(/^@loader_path(?=\/|$)/, path.dirname(loaderPath))
    .replace(/^@executable_path(?=\/|$)/, path.dirname(executablePath))
  if (expanded.startsWith('@')) throw new Error('xTB runtime contains an unsupported nested runpath')
  return path.resolve(expanded)
}

async function resolveDependency(
  dependency: string,
  loaderPath: string,
  executablePath: string,
  runpaths: string[]
): Promise<{ filePath: string; lookupPath: string }> {
  let lookupPath: string
  if (dependency.startsWith('@loader_path')) {
    lookupPath = path.resolve(dependency.replace(/^@loader_path(?=\/|$)/, path.dirname(loaderPath)))
  } else if (dependency.startsWith('@executable_path')) {
    lookupPath = path.resolve(dependency.replace(/^@executable_path(?=\/|$)/, path.dirname(executablePath)))
  } else if (dependency.startsWith('@rpath/')) {
    const suffix = dependency.slice('@rpath/'.length)
    for (const runpath of runpaths) {
      const root = await resolveRunpath(runpath, loaderPath, executablePath)
      const candidate = path.join(root, suffix)
      try {
        return { filePath: await realpath(candidate), lookupPath: candidate }
      } catch {
        continue
      }
    }
    throw new Error('xTB dynamic library dependency could not be resolved')
  } else if (path.isAbsolute(dependency)) {
    lookupPath = dependency
  } else {
    throw new Error('xTB runtime contains an unsupported dynamic library reference')
  }
  return { filePath: await realpath(lookupPath), lookupPath }
}

export class XtbRuntime {
  readonly identity: ControlledCalculationExecutableIdentity

  constructor(
    readonly executablePath: string,
    readonly parameterDirectory: string,
    identity: ControlledCalculationExecutableIdentity,
    private readonly files: RuntimeFile[]
  ) {
    this.identity = structuredClone(identity)
  }

  async assertUnchanged(): Promise<void> {
    for (const expected of this.files) {
      for (const lookupPath of expected.lookupPaths) {
        if ((await realpath(lookupPath)) !== expected.filePath) {
          throw new Error('xTB runtime identity changed after verification')
        }
      }
      const actual = await fingerprintFile(expected.filePath, expected.filePath === this.executablePath)
      if (
        actual.digest !== expected.digest ||
        actual.device !== expected.device ||
        actual.inode !== expected.inode ||
        actual.size !== expected.size ||
        actual.mtimeMs !== expected.mtimeMs
      ) {
        throw new Error('xTB runtime identity changed after verification')
      }
    }
  }
}

export async function discoverXtbRuntime(
  configuredExecutablePath: string,
  inspector: XtbRuntimeInspector = systemInspector,
  configuredParameterDirectory?: string
): Promise<XtbRuntime> {
  if (!path.isAbsolute(configuredExecutablePath)) {
    throw new Error('Configured xTB executable path must be absolute')
  }
  const executableLookupPath = path.resolve(configuredExecutablePath)
  const executablePath = await realpath(executableLookupPath)
  const runtimeRoot = path.dirname(path.dirname(executablePath))
  const executableFile = await fingerprintFile(executablePath, true, [executableLookupPath])
  const parameterDirectoryLookup = configuredParameterDirectory
    ? path.resolve(configuredParameterDirectory)
    : path.join(runtimeRoot, 'share', 'xtb')
  const parameterDirectory = await realpath(parameterDirectoryLookup)
  if (!isWithinRoot(runtimeRoot, parameterDirectory)) {
    throw new Error('xTB parameter directory escaped the configured runtime root')
  }
  const parameterLookupPath = path.join(parameterDirectory, GFN2_PARAMETER_FILE)
  const parameterPath = await realpath(parameterLookupPath)
  if (!isWithinRoot(parameterDirectory, parameterPath)) {
    throw new Error('xTB parameter resource escaped its configured directory')
  }
  const parameterFile = await fingerprintFile(parameterPath, false, [parameterLookupPath])
  const architecture = await inspector.getArchitecture(executablePath)
  const version = await inspector.getVersion(executablePath)
  const executableDynamicInfo = await inspector.inspectDynamicLibraries(executablePath)
  const executableRunpaths = executableDynamicInfo.runpaths
  const pending: PendingLibrary[] = []

  const enqueueDependencies = async (loaderPath: string, dynamicInfo: DynamicLibraryInfo) => {
    const runpaths = [...dynamicInfo.runpaths, ...executableRunpaths]
    for (const dependency of dynamicInfo.dependencies) {
      if (isSystemLibrary(dependency)) continue
      const resolved = await resolveDependency(dependency, loaderPath, executablePath, runpaths)
      if (!isWithinRoot(runtimeRoot, resolved.filePath)) {
        throw new Error('xTB dependency escaped the configured runtime root')
      }
      pending.push({ ...resolved, name: path.basename(dependency) })
    }
  }

  await enqueueDependencies(executablePath, executableDynamicInfo)
  const libraryFiles = new Map<string, RuntimeFile>()
  const libraryNames = new Map<string, string>()
  while (pending.length > 0) {
    const next = pending.shift()!
    const existingFile = libraryFiles.get(next.filePath)
    if (existingFile) {
      if (!existingFile.lookupPaths.includes(next.lookupPath)) existingFile.lookupPaths.push(next.lookupPath)
      continue
    }
    if (libraryFiles.size >= MAX_DYNAMIC_LIBRARIES) {
      throw new Error('xTB dynamic library closure exceeds its bound')
    }
    const existingPath = libraryNames.get(next.name)
    if (existingPath && existingPath !== next.filePath) {
      throw new Error('xTB runtime contains conflicting dynamic library names')
    }
    libraryNames.set(next.name, next.filePath)
    libraryFiles.set(next.filePath, await fingerprintFile(next.filePath, false, [next.lookupPath]))
    await enqueueDependencies(next.filePath, await inspector.inspectDynamicLibraries(next.filePath))
  }

  const libraries = [...libraryNames.entries()]
    .map(([name, filePath]) => ({ name, digest: libraryFiles.get(filePath)!.digest }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  const resources = [{ name: GFN2_PARAMETER_FILE, digest: parameterFile.digest }]
  const fingerprintPayload = {
    engine: 'xtb',
    version,
    architecture,
    executableDigest: executableFile.digest,
    libraries,
    resources
  }
  const identity: ControlledCalculationExecutableIdentity = {
    kind: 'local_executable',
    engine: 'xtb',
    version,
    architecture,
    executableDigest: executableFile.digest,
    runtimeFingerprint: sha256(JSON.stringify(fingerprintPayload)),
    libraries,
    resources,
    verifiedAt: new Date().toISOString()
  }
  const runtime = new XtbRuntime(executablePath, parameterDirectory, identity, [
    executableFile,
    ...libraryFiles.values(),
    parameterFile
  ])
  await runtime.assertUnchanged()
  return runtime
}
