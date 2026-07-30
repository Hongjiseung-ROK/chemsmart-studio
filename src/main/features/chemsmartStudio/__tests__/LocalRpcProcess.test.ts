import { mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { CHEMSMART_COMMIT, PROTOCOL_VERSION, SCHEMA_SHA256, type StudioProtocolHello } from '@chemsmart/studio-protocol'

import { LocalRpcProcess } from '../LocalRpcProcess'

const fixturePath = fileURLToPath(new URL('./fixtures/localRpcChild.cjs', import.meta.url))

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for child-process state')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

describe('LocalRpcProcess supervision', () => {
  const processes: LocalRpcProcess[] = []
  const runtimeDirectories: string[] = []

  const createProcess = async (initialMode: string, protocolHello?: StudioProtocolHello) => {
    const runtimeDirectory = await mkdtemp('/tmp/chemsmart-local-rpc-')
    runtimeDirectories.push(runtimeDirectory)
    const pidFile = path.join(runtimeDirectory, 'child.pid')
    const descendantPidFile = path.join(runtimeDirectory, 'descendant.pid')
    let mode = initialMode
    const statuses: Array<ReturnType<LocalRpcProcess['getStatus']>> = []
    const supervisedProcess = new LocalRpcProcess({
      name: 'test-rpc',
      command: 'node',
      args: (socketPath) => [fixturePath, mode, socketPath],
      cwd: path.dirname(fixturePath),
      runtimeDirectory,
      environment: {
        CHEMSMART_TEST_DESCENDANT_PID_FILE: descendantPidFile,
        CHEMSMART_TEST_PID_FILE: pidFile,
        ...(protocolHello ? { CHEMSMART_TEST_PROTOCOL_HELLO: JSON.stringify(protocolHello) } : {})
      },
      protocolHello,
      incomingHandler: async () => ({ accepted: true }),
      onStateChanged: (status) => statuses.push({ ...status })
    })
    processes.push(supervisedProcess)
    return {
      pidFile,
      descendantPidFile,
      runtimeDirectory,
      setMode: (nextMode: string) => {
        mode = nextMode
      },
      statuses,
      supervisedProcess
    }
  }

  afterEach(async () => {
    await Promise.allSettled(processes.splice(0).map((supervisedProcess) => supervisedProcess.stop()))
    await Promise.all(runtimeDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  it('authenticates, serves requests, reaps a cooperative child, and removes its socket', async () => {
    const { runtimeDirectory, statuses, supervisedProcess } = await createProcess('normal')

    const started = await supervisedProcess.start()
    expect(started.state).toBe('running')
    expect(started.pid).toEqual(expect.any(Number))
    const pid = started.pid!
    await expect(supervisedProcess.request('system.ping', {})).resolves.toEqual({ ok: true, pid })

    await expect(supervisedProcess.stop()).resolves.toEqual({ state: 'stopped', pid: null, lastError: null })
    expect(isPidAlive(pid)).toBe(false)
    expect((await readdir(runtimeDirectory)).filter((entry) => entry.endsWith('.sock'))).toEqual([])
    expect(statuses.map((status) => status.state)).toEqual(['starting', 'running', 'stopping', 'stopped'])
  })

  it('publishes running state only after the authenticated protocol identity matches', async () => {
    const expected = {
      protocolVersion: PROTOCOL_VERSION,
      schemaSha256: SCHEMA_SHA256,
      chemSmartCommit: CHEMSMART_COMMIT
    } as const
    const { statuses, supervisedProcess } = await createProcess('normal', expected)

    await expect(supervisedProcess.start()).resolves.toMatchObject({ state: 'running' })
    expect(statuses.map((status) => status.state)).toEqual(['starting', 'running'])
  })

  it('terminates the sidecar before ready when its protocol identity mismatches', async () => {
    const expected = {
      protocolVersion: PROTOCOL_VERSION,
      schemaSha256: SCHEMA_SHA256,
      chemSmartCommit: CHEMSMART_COMMIT
    } as const
    const { pidFile, statuses, supervisedProcess } = await createProcess('protocol-mismatch', expected)

    await expect(supervisedProcess.start()).rejects.toThrow('protocol identity mismatch')
    const pid = Number(await readFile(pidFile, 'utf8'))
    expect(isPidAlive(pid)).toBe(false)
    expect(statuses.at(-1)).toMatchObject({ state: 'failed', pid: null })
  })

  it('discloses a prepared bootstrap only after authentication and disposes it on stop', async () => {
    const runtimeDirectory = await mkdtemp('/tmp/chemsmart-local-rpc-bootstrap-')
    runtimeDirectories.push(runtimeDirectory)
    const events: string[] = []
    let bootstrapPid: number | null = null
    const supervisedProcess = new LocalRpcProcess({
      name: 'bootstrap-rpc',
      command: 'node',
      args: (socketPath) => [fixturePath, 'normal', socketPath],
      cwd: path.dirname(fixturePath),
      runtimeDirectory,
      incomingHandler: async () => ({ accepted: true }),
      onStateChanged: (status) => events.push(`state:${status.state}`),
      prepareBootstrap: async () => {
        events.push('prepare')
        return {
          onSpawned: async (pid) => {
            bootstrapPid = pid
            events.push('spawned')
          },
          onAuthenticated: async ({ pid, request }) => {
            expect(pid).toBe(bootstrapPid)
            expect(await request('system.ping', {})).toEqual({ ok: true, pid })
            events.push('authenticated-bootstrap')
          },
          dispose: async () => {
            events.push('dispose')
          }
        }
      }
    })
    processes.push(supervisedProcess)

    const started = await supervisedProcess.start()
    expect(started.pid).toBe(bootstrapPid)
    expect(events).toEqual(['state:starting', 'prepare', 'spawned', 'authenticated-bootstrap', 'state:running'])

    await supervisedProcess.stop()
    expect(events).toEqual([
      'state:starting',
      'prepare',
      'spawned',
      'authenticated-bootstrap',
      'state:running',
      'state:stopping',
      'dispose',
      'state:stopped'
    ])
  })

  it('reaps the child and disposes the bootstrap when post-authentication bootstrap fails', async () => {
    const runtimeDirectory = await mkdtemp('/tmp/chemsmart-local-rpc-bootstrap-failure-')
    runtimeDirectories.push(runtimeDirectory)
    const pidFile = path.join(runtimeDirectory, 'child.pid')
    let disposeCount = 0
    const supervisedProcess = new LocalRpcProcess({
      name: 'bootstrap-failure-rpc',
      command: 'node',
      args: (socketPath) => [fixturePath, 'normal', socketPath],
      cwd: path.dirname(fixturePath),
      runtimeDirectory,
      environment: { CHEMSMART_TEST_PID_FILE: pidFile },
      incomingHandler: async () => ({ accepted: true }),
      onStateChanged: () => {},
      prepareBootstrap: async () => ({
        onSpawned: async () => {},
        onAuthenticated: async () => {
          throw new Error('authenticated bootstrap rejected')
        },
        dispose: async () => {
          disposeCount += 1
        }
      })
    })
    processes.push(supervisedProcess)

    await expect(supervisedProcess.start()).rejects.toThrow('authenticated bootstrap rejected')
    const pid = Number(await readFile(pidFile, 'utf8'))
    expect(isPidAlive(pid)).toBe(false)
    expect(disposeCount).toBe(1)
    expect(supervisedProcess.getStatus()).toMatchObject({
      state: 'failed',
      pid: null,
      lastError: 'authenticated bootstrap rejected'
    })
  })

  it('reports bootstrap disposal failure only after the owned child and socket are gone', async () => {
    const runtimeDirectory = await mkdtemp('/tmp/chemsmart-local-rpc-bootstrap-dispose-')
    runtimeDirectories.push(runtimeDirectory)
    let disposeCount = 0
    const supervisedProcess = new LocalRpcProcess({
      name: 'bootstrap-dispose-rpc',
      command: 'node',
      args: (socketPath) => [fixturePath, 'normal', socketPath],
      cwd: path.dirname(fixturePath),
      runtimeDirectory,
      incomingHandler: async () => ({ accepted: true }),
      onStateChanged: () => {},
      prepareBootstrap: async () => ({
        onSpawned: async () => {},
        onAuthenticated: async () => {},
        dispose: async () => {
          disposeCount += 1
          throw new Error('bootstrap disposal failed')
        }
      })
    })
    processes.push(supervisedProcess)

    const started = await supervisedProcess.start()
    await expect(supervisedProcess.stop()).rejects.toThrow('bootstrap disposal failed')
    expect(isPidAlive(started.pid!)).toBe(false)
    expect((await readdir(runtimeDirectory)).filter((entry) => entry.endsWith('.sock'))).toEqual([])
    expect(supervisedProcess.getStatus()).toEqual({
      state: 'failed',
      pid: null,
      lastError: 'bootstrap disposal failed'
    })
    await expect(supervisedProcess.stop()).rejects.toThrow('bootstrap disposal failed')
    expect(disposeCount).toBe(2)
  })

  it('reaps an authentication failure before allowing a clean restart', async () => {
    const { pidFile, setMode, supervisedProcess } = await createProcess('reject-auth')

    await expect(supervisedProcess.start()).rejects.toThrow('Authentication failed')
    const rejectedPid = Number(await readFile(pidFile, 'utf8'))
    expect(isPidAlive(rejectedPid)).toBe(false)
    expect(supervisedProcess.getStatus()).toMatchObject({ state: 'failed', pid: null })

    setMode('normal')
    const restarted = await supervisedProcess.start()
    expect(restarted.state).toBe('running')
    expect(restarted.pid).not.toBe(rejectedPid)
    await supervisedProcess.stop()
    expect(isPidAlive(restarted.pid!)).toBe(false)
  })

  it('disposes an unexpectedly exited bootstrap and creates a fresh one only on explicit retry', async () => {
    const runtimeDirectory = await mkdtemp('/tmp/chemsmart-local-rpc-retry-')
    runtimeDirectories.push(runtimeDirectory)
    let preparedIncarnation = 0
    const disposedIncarnations: number[] = []
    const spawnedPids: number[] = []
    const supervisedProcess = new LocalRpcProcess({
      name: 'bootstrap-retry-rpc',
      command: 'node',
      args: (socketPath) => [fixturePath, 'normal', socketPath],
      cwd: path.dirname(fixturePath),
      runtimeDirectory,
      incomingHandler: async () => ({ accepted: true }),
      onStateChanged: () => {},
      prepareBootstrap: async () => {
        preparedIncarnation += 1
        const incarnation = preparedIncarnation
        return {
          onSpawned: async (pid) => {
            spawnedPids.push(pid)
          },
          onAuthenticated: async () => {},
          dispose: async () => {
            disposedIncarnations.push(incarnation)
          }
        }
      }
    })
    processes.push(supervisedProcess)

    const first = await supervisedProcess.start()
    void supervisedProcess.request('test.exit', {}).catch(() => undefined)
    await waitFor(
      () =>
        supervisedProcess.getStatus().state === 'failed' &&
        supervisedProcess.getStatus().pid === null &&
        disposedIncarnations.length === 1
    )
    expect(preparedIncarnation).toBe(1)
    expect(disposedIncarnations).toEqual([1])

    const second = await supervisedProcess.start()
    expect(second.pid).not.toBe(first.pid)
    expect(preparedIncarnation).toBe(2)
    expect(spawnedPids).toEqual([first.pid, second.pid])

    await supervisedProcess.stop()
    expect(disposedIncarnations).toEqual([1, 2])
  })

  it('fails promptly and leaves no process after spawn errors or early child exit', async () => {
    const missingRuntime = await mkdtemp('/tmp/chemsmart-local-rpc-missing-')
    runtimeDirectories.push(missingRuntime)
    const missing = new LocalRpcProcess({
      name: 'missing-rpc',
      command: path.join(missingRuntime, 'missing-command'),
      args: () => [],
      cwd: missingRuntime,
      runtimeDirectory: missingRuntime,
      incomingHandler: async () => null,
      onStateChanged: () => {}
    })
    processes.push(missing)
    await expect(missing.start()).rejects.toMatchObject({ code: 'ENOENT' })
    expect(missing.getStatus()).toMatchObject({ state: 'failed', pid: null })

    const { pidFile, supervisedProcess } = await createProcess('exit-early')
    await expect(supervisedProcess.start()).rejects.toThrow('exited before opening its socket')
    const exitedPid = Number(await readFile(pidFile, 'utf8'))
    expect(isPidAlive(exitedPid)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('rejects a symlinked runtime directory before spawning', async () => {
    const parent = await mkdtemp('/tmp/chemsmart-local-rpc-symlink-')
    const target = await mkdtemp('/tmp/chemsmart-local-rpc-target-')
    runtimeDirectories.push(parent, target)
    const runtimeDirectory = path.join(parent, 'runtime')
    await symlink(target, runtimeDirectory)
    const supervisedProcess = new LocalRpcProcess({
      name: 'symlink-rpc',
      command: 'node',
      args: () => [fixturePath, 'normal'],
      cwd: parent,
      runtimeDirectory,
      incomingHandler: async () => null,
      onStateChanged: () => {}
    })
    processes.push(supervisedProcess)

    await expect(supervisedProcess.start()).rejects.toThrow('runtime directory is not securely owned')
    expect(supervisedProcess.getStatus()).toMatchObject({ state: 'failed', pid: null })
  })

  it('isolates an unexpected child exit from a later restart', async () => {
    const { supervisedProcess } = await createProcess('normal')
    const first = await supervisedProcess.start()
    const firstPid = first.pid!

    await expect(supervisedProcess.request('test.exit', {}, 2_000)).rejects.toThrow(/RPC peer (?:closed|destroyed)/)
    await waitFor(() => supervisedProcess.getStatus().state === 'failed')
    expect(isPidAlive(firstPid)).toBe(false)

    const second = await supervisedProcess.start()
    expect(second.pid).not.toBe(firstPid)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(supervisedProcess.getStatus()).toMatchObject({ state: 'running', pid: second.pid })
    await supervisedProcess.stop()
    expect(isPidAlive(second.pid!)).toBe(false)
  })

  it('waits for forced termination before reporting a SIGTERM-resistant child stopped', async () => {
    const { supervisedProcess } = await createProcess('ignore-term')
    const started = await supervisedProcess.start()
    const pid = started.pid!
    const startedStoppingAt = Date.now()

    await supervisedProcess.stop()

    expect(Date.now() - startedStoppingAt).toBeGreaterThanOrEqual(4_500)
    expect(supervisedProcess.getStatus()).toEqual({ state: 'stopped', pid: null, lastError: null })
    expect(isPidAlive(pid)).toBe(false)
  }, 15_000)

  it.skipIf(process.platform === 'win32')(
    'reaps descendants in the supervised process group before reporting stopped',
    async () => {
      const { descendantPidFile, supervisedProcess } = await createProcess('descendant')
      const started = await supervisedProcess.start()
      const descendantPid = Number(await readFile(descendantPidFile, 'utf8'))

      try {
        expect(isPidAlive(descendantPid)).toBe(true)
        await supervisedProcess.stop()
        expect(isPidAlive(started.pid!)).toBe(false)
        expect(isPidAlive(descendantPid)).toBe(false)
      } finally {
        if (isPidAlive(descendantPid)) process.kill(descendantPid, 'SIGKILL')
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'reaps descendants after an unexpected process-group leader exit',
    async () => {
      const { descendantPidFile, supervisedProcess } = await createProcess('descendant')
      await supervisedProcess.start()
      const descendantPid = Number(await readFile(descendantPidFile, 'utf8'))

      try {
        await expect(supervisedProcess.request('test.exit', {}, 2_000)).rejects.toThrow(/RPC peer (?:closed|destroyed)/)
        await waitFor(() => supervisedProcess.getStatus().state === 'failed')
        await waitFor(() => !isPidAlive(descendantPid))
      } finally {
        if (isPidAlive(descendantPid)) process.kill(descendantPid, 'SIGKILL')
      }
    }
  )
})
