import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { BaseService } from '@main/core/lifecycle'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  appGetPath: vi.fn(),
  broadcast: vi.fn(),
  readFile: vi.fn(),
  spawn: vi.fn(),
  terminate: vi.fn()
}))

vi.mock('@application', () => ({
  application: {
    get: (name: string) => {
      if (name === 'IpcApiService') return { broadcast: mocks.broadcast }
      throw new Error(`Unexpected application.get(${name})`)
    },
    getPath: mocks.appGetPath
  }
}))
vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile }))
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
    mocks.appGetPath.mockImplementation((key: string, file?: string) => (file ? `/runtime/${file}` : `/paths/${key}`))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs the command through a login shell so the researcher’s own environment applies', async () => {
    const service = new StudioConsoleService()

    service.run('chemsmart run gaussian opt -f water.xyz')

    const [command, args, options] = mocks.spawn.mock.calls[0]
    expect(args).toEqual(['-l', '-c', 'chemsmart run gaussian opt -f water.xyz'])
    expect(command).toBe(process.env.SHELL ?? '/bin/sh')
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
    expect(passed.every((key) => ['HOME', 'USER', 'LANG', 'TERM'].includes(key))).toBe(true)
  })

  it('coalesces output into one event per stream per tick', async () => {
    const service = new StudioConsoleService()
    const { runId } = service.run('chemsmart --help')

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
    service.run('chemsmart run gaussian')

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
    service.run('chemsmart run gaussian opt')

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
    const { runId } = service.run('chemsmart run gaussian opt')

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
      replaceFrom: 14,
      completions: []
    })
  })

  it('resolves completions from the dumped schema', async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify({
        name: 'chemsmart',
        description: 'ChemSmart command line.',
        options: [],
        subcommands: {
          run: { name: 'run', description: 'Run a job locally.', options: [], subcommands: {} }
        }
      })
    )
    const service = new StudioConsoleService()

    const result = await service.complete('chemsmart r', 11)

    expect(result.completions).toEqual([{ value: 'run', kind: 'subcommand', detail: 'Run a job locally.' }])
  })

  it('treats an unreadable schema dump as no completions rather than failing the console', async () => {
    mocks.readFile.mockResolvedValue('{"not":"a command tree"}')
    const service = new StudioConsoleService()

    await expect(service.complete('chemsmart ', 10)).resolves.toMatchObject({ completions: [] })
  })
})
