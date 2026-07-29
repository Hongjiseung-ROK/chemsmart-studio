import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { BoundedProcessError, runBoundedProcess } from '../BoundedProcess'

const fixturePath = fileURLToPath(new URL('./fixtures/boundedProcessChild.cjs', import.meta.url))

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function waitForPid(filePath: string): Promise<number> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      return Number(await readFile(filePath, 'utf8'))
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  throw new Error('Timed out waiting for bounded-process fixture PID')
}

describe('runBoundedProcess', () => {
  const runtimeDirectories: string[] = []
  const fallbackPids: number[] = []

  async function createOptions(mode: string) {
    const cwd = await mkdtemp(path.join(tmpdir(), 'chemsmart-bounded-process-'))
    runtimeDirectories.push(cwd)
    const pidFile = path.join(cwd, 'child.pid')
    const descendantPidFile = path.join(cwd, 'descendant.pid')
    return {
      options: {
        name: 'non-chemistry-fixture',
        command: process.execPath,
        args: [fixturePath, mode],
        cwd,
        environment: {
          CHEMSMART_TEST_ALLOWED: 'explicit',
          CHEMSMART_TEST_DESCENDANT_PID_FILE: descendantPidFile,
          CHEMSMART_TEST_PID_FILE: pidFile
        },
        timeoutMs: 2_000,
        maxStdoutBytes: 4_096,
        maxStderrBytes: 4_096,
        gracefulShutdownMs: 100,
        forcedShutdownMs: 2_000
      },
      pidFile,
      descendantPidFile
    }
  }

  afterEach(async () => {
    vi.unstubAllEnvs()
    for (const pid of fallbackPids.splice(0)) {
      if (isPidAlive(pid)) process.kill(pid, 'SIGKILL')
    }
    await Promise.all(runtimeDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  it('returns bounded output and passes only allowlisted plus explicit environment values', async () => {
    vi.stubEnv('CHEMSMART_TEST_BLOCKED', 'must-not-cross')
    const { options } = await createOptions('normal')

    const result = await runBoundedProcess(options)

    expect(result.exitCode).toBe(0)
    expect(result.signal).toBeNull()
    expect(JSON.parse(result.stdout)).toEqual({ allowed: 'explicit', blocked: null })
    expect(result.stderr).toBe('')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('returns a bounded nonzero result without losing stderr evidence', async () => {
    const { options } = await createOptions('nonzero')

    await expect(runBoundedProcess(options)).resolves.toMatchObject({
      exitCode: 7,
      signal: null,
      stdout: '',
      stderr: 'bounded fixture failure'
    })
  })

  it('terminates a process group and its descendant at the hard timeout', async () => {
    const { descendantPidFile, options, pidFile } = await createOptions('descendant-timeout')
    const run = runBoundedProcess({ ...options, timeoutMs: 150 })
    const rejection = expect(run).rejects.toMatchObject({
      name: 'BoundedProcessError',
      reason: 'timeout'
    })
    const childPid = await waitForPid(pidFile)
    const descendantPid = await waitForPid(descendantPidFile)
    fallbackPids.push(childPid, descendantPid)

    await rejection
    expect(isPidAlive(childPid)).toBe(false)
    expect(isPidAlive(descendantPid)).toBe(false)
  })

  it('fails closed and reaps the process when stdout exceeds its byte budget', async () => {
    const { options, pidFile } = await createOptions('oversize')
    const run = runBoundedProcess({ ...options, maxStdoutBytes: 1_024 })
    const rejection = expect(run).rejects.toMatchObject({
      name: 'BoundedProcessError',
      reason: 'stdout_limit'
    })
    const childPid = await waitForPid(pidFile)
    fallbackPids.push(childPid)

    await rejection
    expect(isPidAlive(childPid)).toBe(false)
  })

  it('honors cancellation and leaves no owned child process', async () => {
    const { options, pidFile } = await createOptions('sleep')
    const controller = new AbortController()
    const run = runBoundedProcess({ ...options, signal: controller.signal })
    const rejection = expect(run).rejects.toMatchObject({
      name: 'BoundedProcessError',
      reason: 'aborted'
    })
    const childPid = await waitForPid(pidFile)
    fallbackPids.push(childPid)
    controller.abort()

    await rejection
    expect(isPidAlive(childPid)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'detects and reaps a descendant left behind after the process-group leader exits',
    async () => {
      const { descendantPidFile, options } = await createOptions('leader-exit')
      const run = runBoundedProcess(options)
      const rejection = expect(run).rejects.toMatchObject({
        name: 'BoundedProcessError',
        reason: 'descendant_leak'
      })
      const descendantPid = await waitForPid(descendantPidFile)
      fallbackPids.push(descendantPid)

      await rejection
      expect(isPidAlive(descendantPid)).toBe(false)
    }
  )

  it('rejects invalid bounds before spawning', async () => {
    const { options } = await createOptions('normal')

    await expect(runBoundedProcess({ ...options, timeoutMs: 180_001 })).rejects.toEqual(
      new BoundedProcessError('invalid_options', 'non-chemistry-fixture process options are invalid')
    )
  })
})
