import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { CHEMSMART_COMMIT } from '@chemsmart/studio-protocol'
import { BaseService } from '@main/core/lifecycle'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  appGetPath: vi.fn(),
  agentInspect: vi.fn(),
  broadcast: vi.fn(),
  lstat: vi.fn(),
  realpath: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  spawn: vi.fn(),
  terminate: vi.fn(),
  workspaceImport: vi.fn()
}))

vi.mock('@application', () => ({
  application: {
    get: (name: string) => {
      if (name === 'IpcApiService') return { broadcast: mocks.broadcast }
      if (name === 'ChemSmartAgentService') return { inspectCommand: mocks.agentInspect }
      if (name === 'MoleculeWorkspaceService') return { importMoleculeFromConsole: mocks.workspaceImport }
      throw new Error(`Unexpected application.get(${name})`)
    },
    getPath: mocks.appGetPath
  }
}))
vi.mock('node:fs/promises', () => ({
  lstat: mocks.lstat,
  readFile: mocks.readFile,
  readdir: mocks.readdir,
  realpath: mocks.realpath
}))
vi.mock('@main/utils/processRunner', () => ({ crossPlatformSpawn: mocks.spawn }))
vi.mock('../OwnedProcessTree', () => ({
  OwnedProcessTree: class {
    terminate = mocks.terminate
  }
}))

import { StudioConsoleService } from '../StudioConsoleService'

/** A child process good enough to drive the service: two streams and the two events it listens for. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  return child
}

describe('StudioConsoleService', () => {
  let child: ReturnType<typeof fakeChild>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    BaseService.resetInstances()
    child = fakeChild()
    mocks.spawn.mockReturnValue(child)
    mocks.terminate.mockResolvedValue(undefined)
    mocks.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    mocks.readdir.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    mocks.realpath.mockImplementation(async (value: string) => value)
    mocks.lstat.mockResolvedValue({
      dev: 1,
      ino: 1,
      size: 24,
      isFile: () => true,
      isSymbolicLink: () => false
    })
    mocks.agentInspect.mockImplementation(async ({ command }: { command: string }) => ({
      schemaVersion: '1',
      inspectionId: 'inspection-1',
      sessionId: 'console-session',
      status: 'ready_for_dry_run',
      commandDigest: createHash('sha256').update(command.trim()).digest('hex'),
      parse: {
        accepted: true,
        action: 'run',
        program: 'xtb',
        job: 'sp',
        project: null,
        inputName: 'water.xyz',
        charge: '0',
        multiplicity: '1',
        method: {
          functional: null,
          abInitio: null,
          basis: null,
          auxBasis: null,
          solventModel: null,
          solventId: null
        }
      },
      intent: { verdict: 'ok', failedRuleIds: [], assertions: [{ id: 'intent.program', status: 'pass' }] },
      semantic: { verdict: 'ok', complete: false, failedRuleIds: [], missingInfo: [], issues: [] },
      dryRun: { state: 'required', processStarted: false },
      executionPerformed: false,
      approvalRequiredForExecution: true,
      missingInfo: [],
      extensions: {}
    }))
    mocks.workspaceImport.mockResolvedValue({ canceled: false, molecule: null, documentName: 'water' })
    mocks.appGetPath.mockImplementation((key: string, file?: string) => (file ? `/runtime/${file}` : `/paths/${key}`))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs the command through a login shell so the researcher’s own environment applies', async () => {
    const service = new StudioConsoleService()
    const line = 'chemsmart run gaussian opt -f water.xyz'
    const receipt = await service.preflight(line)

    service.run(line, receipt.commandDigest)

    const [command, args, options] = mocks.spawn.mock.calls[0]
    expect(args).toEqual([
      '-l',
      '-c',
      'export PATH="$CHEMSMART_STUDIO_BRIDGE_BIN:$PATH"\nchemsmart run gaussian opt -f water.xyz'
    ])
    expect(command).toBe(process.env.SHELL ?? '/bin/sh')
    expect(options.env.CHEMSMART_STUDIO_BRIDGE_BIN).toBe('/paths')
    // Its own process group, so cancelling reaches a Gaussian child and not just the shell.
    expect(options.detached).toBe(process.platform !== 'win32')
  })

  it('does not hand main’s environment to a typed command', async () => {
    const service = new StudioConsoleService()

    service.run('env')

    const passed = Object.keys(mocks.spawn.mock.calls[0][2].env)
    // The login shell rebuilds PATH and the chemistry variables from the researcher's own profile;
    // main's environment may carry provider credentials and must not be readable from the console.
    expect(passed).not.toContain('PATH')
    expect(passed.every((key) => ['HOME', 'USER', 'LANG', 'TERM', 'CHEMSMART_STUDIO_BRIDGE_BIN'].includes(key))).toBe(
      true
    )
  })

  it('coalesces output into one event per stream per tick', async () => {
    const service = new StudioConsoleService()
    const line = 'chemsmart --help'
    const receipt = await service.preflight(line)
    const { runId } = service.run(line, receipt.commandDigest)

    child.stdout.emit('data', Buffer.from('Usage: '))
    child.stdout.emit('data', Buffer.from('chemsmart'))
    child.stdout.emit('data', Buffer.from(' [OPTIONS]\n'))
    expect(mocks.broadcast).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60)

    expect(mocks.broadcast).toHaveBeenCalledExactlyOnceWith('chemsmart_studio.console.output', {
      runId,
      stream: 'stdout',
      chunk: 'Usage: chemsmart [OPTIONS]\n'
    })
  })

  it('keeps stdout and stderr apart within a tick', async () => {
    const service = new StudioConsoleService()
    const line = 'chemsmart run gaussian'
    const receipt = await service.preflight(line)
    service.run(line, receipt.commandDigest)

    child.stdout.emit('data', Buffer.from('working\n'))
    child.stderr.emit('data', Buffer.from('warning\n'))
    await vi.advanceTimersByTimeAsync(60)

    const streams = mocks.broadcast.mock.calls
      .filter(([event]) => event === 'chemsmart_studio.console.output')
      .map(([, payload]) => payload.stream)
    expect(streams).toEqual(['stdout', 'stderr'])
  })

  it('reports the exit code once the command closes', async () => {
    const service = new StudioConsoleService()
    const { runId } = service.run('false')

    child.emit('close', 1, null)
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.broadcast).toHaveBeenCalledWith('chemsmart_studio.console.exited', {
      runId,
      code: 1,
      signal: null
    })
  })

  it('refuses a second command instead of queueing one the researcher cannot see', async () => {
    const service = new StudioConsoleService()
    const line = 'chemsmart run gaussian opt'
    const receipt = await service.preflight(line)
    service.run(line, receipt.commandDigest)

    expect(() => service.run('chemsmart run orca opt')).toThrow('A command is already running')
  })

  it('accepts a new command once the previous one exited', async () => {
    const service = new StudioConsoleService()
    service.run('true')
    child.emit('close', 0, null)
    await vi.advanceTimersByTimeAsync(0)

    mocks.spawn.mockReturnValue(fakeChild())
    expect(() => service.run('true')).not.toThrow()
  })

  it('refuses an empty command', async () => {
    const service = new StudioConsoleService()
    expect(() => service.run('   ')).toThrow('A command is required')
  })

  it('terminates the process tree on cancel', async () => {
    const service = new StudioConsoleService()
    const line = 'chemsmart run gaussian opt'
    const receipt = await service.preflight(line)
    const { runId } = service.run(line, receipt.commandDigest)

    await service.cancel(runId)

    expect(mocks.terminate).toHaveBeenCalledWith(5_000, 5_000)
  })

  it('ignores a cancel for a run that already finished', async () => {
    const service = new StudioConsoleService()
    const { runId } = service.run('true')
    child.emit('close', 0, null)
    await vi.advanceTimersByTimeAsync(0)

    await expect(service.cancel(runId)).resolves.toBeUndefined()
    expect(mocks.terminate).not.toHaveBeenCalled()
  })

  it('stops appending once the output cap is reached and says so', async () => {
    const service = new StudioConsoleService()
    service.run('yes')

    // Two 8 MiB writes: the first fills the cap exactly, the second is refused.
    child.stdout.emit('data', Buffer.alloc(8 * 1024 * 1024, 0x61))
    child.stdout.emit('data', Buffer.alloc(1024, 0x61))
    await vi.advanceTimersByTimeAsync(60)

    const chunks = mocks.broadcast.mock.calls
      .filter(([event]) => event === 'chemsmart_studio.console.output')
      .map(([, payload]) => payload.chunk)
    expect(chunks.join('')).toContain('[output truncated]')
    expect(chunks.join('').length).toBeLessThan(9 * 1024 * 1024)
  })

  it('offers no completions when chemsmart has not been dumped yet', async () => {
    const service = new StudioConsoleService()

    await expect(service.complete('chemsmart run ', 14)).resolves.toEqual({
      commandPath: [],
      stage: 'root',
      disclosure: 'primary',
      hasMore: false,
      replaceRange: { start: 14, end: 14 },
      items: [],
      semantic: { breadcrumb: [], slots: [], ghostSuffix: '', complete: false }
    })
  })

  it('resolves completions from the dumped schema', async () => {
    const body = {
      description: 'ChemSmart command line.',
      name: 'chemsmart',
      options: [],
      subcommands: {
        run: { description: 'Run a job locally.', name: 'run', options: [], subcommands: {} }
      }
    }
    const schemaHash = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    mocks.readFile.mockResolvedValue(
      JSON.stringify({
        ...body,
        _meta: {
          chemsmart_commit: CHEMSMART_COMMIT,
          schema_hash: schemaHash
        }
      })
    )
    const service = new StudioConsoleService()

    const result = await service.complete('chemsmart r', 11)

    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(result.items).toEqual([
      expect.objectContaining({
        label: 'run',
        insertText: 'run',
        kind: 'command',
        group: 'commands',
        detail: 'Run a job locally.',
        appendSpace: true
      })
    ])
    expect(mocks.agentInspect).not.toHaveBeenCalled()
  })

  it('revalidates a main-issued molecule completion before returning a path-free open action', async () => {
    const body = {
      description: 'ChemSmart command line.',
      name: 'chemsmart',
      options: [
        {
          choices: null,
          help: 'Input molecule.',
          is_flag: false,
          multiple: false,
          name: 'filename',
          nargs: 1,
          opts: ['-f'],
          required: true,
          type: 'path'
        }
      ],
      subcommands: {}
    }
    mocks.readFile.mockResolvedValue(
      JSON.stringify({
        ...body,
        _meta: {
          chemsmart_commit: CHEMSMART_COMMIT,
          schema_hash: createHash('sha256').update(JSON.stringify(body)).digest('hex')
        }
      })
    )
    mocks.readdir.mockImplementation(async (directory: string) => {
      if (directory !== '/paths/feature.chemsmart_studio.projects') {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      }
      return [
        {
          name: 'water.xyz',
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false
        }
      ]
    })
    const service = new StudioConsoleService()

    const result = await service.complete('chemsmart -f ', 14)
    const candidate = result.items.find((item) => item.label === 'water.xyz')
    await service.complete('chemsmart -f ', 14)

    expect(candidate).toMatchObject({ kind: 'file', openAction: 'molecule' })
    await expect(service.acceptCompletionContext(candidate!.contextRef!)).resolves.toEqual({
      contextRef: candidate!.contextRef,
      action: 'molecule',
      displayName: 'water.xyz'
    })
    expect(mocks.workspaceImport).toHaveBeenCalledWith(
      '/paths/feature.chemsmart_studio.projects/water.xyz',
      'water.xyz'
    )

    const secondResult = await service.complete('chemsmart -f ', 14)
    const changedCandidate = secondResult.items.find((item) => item.label === 'water.xyz')
    mocks.lstat.mockResolvedValueOnce({
      dev: 2,
      ino: 1,
      size: 24,
      isFile: () => true,
      isSymbolicLink: () => false
    })
    await expect(service.acceptCompletionContext(changedCandidate!.contextRef!)).rejects.toThrow(/changed/)
  })

  it('prepares a regular molecule drop only in a filename slot without starting a process', async () => {
    const body = {
      description: 'ChemSmart command line.',
      name: 'chemsmart',
      options: [],
      subcommands: {
        run: {
          description: 'Run a job locally.',
          name: 'run',
          options: [],
          subcommands: {
            xtb: {
              description: 'Run xTB.',
              name: 'xtb',
              options: [
                {
                  choices: null,
                  help: 'Input molecule.',
                  is_flag: false,
                  multiple: false,
                  name: 'filename',
                  nargs: 1,
                  opts: ['-f', '--filename'],
                  required: false,
                  type: 'path'
                },
                {
                  choices: ['gfn1', 'gfn2'],
                  help: 'Method.',
                  is_flag: false,
                  multiple: false,
                  name: 'method',
                  nargs: 1,
                  opts: ['--method'],
                  required: false,
                  type: 'str'
                }
              ],
              subcommands: {}
            }
          }
        }
      }
    }
    mocks.readFile.mockResolvedValue(
      JSON.stringify({
        ...body,
        _meta: {
          chemsmart_commit: CHEMSMART_COMMIT,
          schema_hash: createHash('sha256').update(JSON.stringify(body)).digest('hex')
        }
      })
    )
    const service = new StudioConsoleService()
    const line = 'chemsmart run xtb -f old.xyz'

    const result = await service.prepareFileDrop(line, line.length, '/external/My molecule.xyz')

    expect(result).toMatchObject({
      replaceRange: { start: line.indexOf('old.xyz'), end: line.length },
      item: {
        label: 'My molecule.xyz',
        insertText: "'/external/My molecule.xyz'",
        kind: 'file',
        group: 'files',
        openAction: 'molecule'
      }
    })
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(mocks.agentInspect).not.toHaveBeenCalled()

    const methodLine = 'chemsmart run xtb --method '
    await expect(service.prepareFileDrop(methodLine, methodLine.length, '/external/water.xyz')).rejects.toThrow(
      /filename/
    )
    const filenameLine = 'chemsmart run xtb -f '
    await expect(service.prepareFileDrop(filenameLine, filenameLine.length, '/external/water.txt')).rejects.toThrow(
      /XYZ/
    )
  })

  it('rejects a symlinked or oversized molecule drop', async () => {
    const body = {
      description: 'ChemSmart command line.',
      name: 'chemsmart',
      options: [
        {
          choices: null,
          help: 'Input molecule.',
          is_flag: false,
          multiple: false,
          name: 'filename',
          nargs: 1,
          opts: ['-f'],
          required: false,
          type: 'path'
        }
      ],
      subcommands: {}
    }
    mocks.readFile.mockResolvedValue(
      JSON.stringify({
        ...body,
        _meta: {
          chemsmart_commit: CHEMSMART_COMMIT,
          schema_hash: createHash('sha256').update(JSON.stringify(body)).digest('hex')
        }
      })
    )
    const service = new StudioConsoleService()
    mocks.lstat.mockResolvedValueOnce({
      dev: 1,
      ino: 1,
      size: 24,
      isFile: () => true,
      isSymbolicLink: () => true
    })
    await expect(service.prepareFileDrop('chemsmart -f ', 13, '/external/water.xyz')).rejects.toThrow(/regular/)

    mocks.lstat.mockResolvedValueOnce({
      dev: 1,
      ino: 1,
      size: 128 * 1024 * 1024 + 1,
      isFile: () => true,
      isSymbolicLink: () => false
    })
    await expect(service.prepareFileDrop('chemsmart -f ', 13, '/external/water.xyz')).rejects.toThrow(/size/)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('requires a digest-bound preflight before a ChemSmart command can start', async () => {
    const service = new StudioConsoleService()

    expect(() => service.run('chemsmart run xtb -f water.xyz sp')).toThrow(/preflight/)
    expect(mocks.spawn).not.toHaveBeenCalled()

    const receipt = await service.preflight('chemsmart run xtb -f water.xyz sp')
    expect(receipt).toMatchObject({ verdict: 'green', processStarted: false })
    service.run('chemsmart run xtb -f water.xyz sp', receipt.commandDigest)
    expect(mocks.spawn).toHaveBeenCalledOnce()
  })

  it('projects warnings and rejections without starting a command process', async () => {
    const service = new StudioConsoleService()
    mocks.agentInspect.mockResolvedValueOnce({
      ...(await mocks.agentInspect({ command: 'chemsmart run xtb sp' })),
      status: 'rejected',
      semantic: {
        verdict: 'reject',
        complete: false,
        failedRuleIds: ['cmd.runtime.input_not_found'],
        missingInfo: ['input file'],
        issues: [
          {
            ruleId: 'cmd.runtime.input_not_found',
            severity: 'reject',
            message: 'The input molecule is missing.'
          }
        ]
      }
    })

    await expect(service.preflight('chemsmart run xtb sp')).resolves.toMatchObject({
      verdict: 'rejected',
      processStarted: false
    })
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('treats an unreadable schema dump as no completions rather than failing the console', async () => {
    mocks.readFile.mockResolvedValue('{"not":"a command tree"}')
    const service = new StudioConsoleService()

    await expect(service.complete('chemsmart ', 10)).resolves.toMatchObject({ items: [] })
  })
})
