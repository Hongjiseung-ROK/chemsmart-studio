import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { BoundedLocalProcessAdapter, type VerifiedLocalRuntime } from '../BoundedProcess'

const fixturePath = fileURLToPath(new URL('./fixtures/boundedProcessChild.cjs', import.meta.url))

describe('BoundedLocalProcessAdapter', () => {
  const runtimeDirectories: string[] = []

  async function createRunOptions() {
    const cwd = await mkdtemp(path.join(tmpdir(), 'chemsmart-local-process-adapter-'))
    runtimeDirectories.push(cwd)
    return {
      args: [fixturePath, 'normal'],
      cwd,
      environment: {
        CHEMSMART_TEST_ALLOWED: 'adapter',
        CHEMSMART_TEST_PID_FILE: path.join(cwd, 'child.pid')
      },
      timeoutMs: 2_000
    }
  }

  afterEach(async () => {
    await Promise.all(runtimeDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  it('binds execution to one verified executable and checks its identity before and after use', async () => {
    const runtime: VerifiedLocalRuntime = {
      executablePath: process.execPath,
      assertUnchanged: vi.fn().mockResolvedValue(undefined)
    }
    const adapter = new BoundedLocalProcessAdapter(runtime, 'non-chemistry-adapter', 4_096, 4_096)

    const result = await adapter.run(await createRunOptions())

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ allowed: 'adapter' })
    expect(runtime.assertUnchanged).toHaveBeenCalledTimes(2)
  })

  it('refuses a changed runtime before spawning it', async () => {
    const runtime: VerifiedLocalRuntime = {
      executablePath: process.execPath,
      assertUnchanged: vi.fn().mockRejectedValue(new Error('changed'))
    }
    const adapter = new BoundedLocalProcessAdapter(runtime, 'non-chemistry-adapter', 4_096, 4_096)
    const options = await createRunOptions()

    await expect(adapter.run(options)).rejects.toMatchObject({
      name: 'BoundedProcessError',
      reason: 'runtime_changed'
    })
    await expect(access(options.environment.CHEMSMART_TEST_PID_FILE)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed when the verified runtime changes during execution', async () => {
    const assertUnchanged = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('changed'))
    const runtime: VerifiedLocalRuntime = { executablePath: process.execPath, assertUnchanged }
    const adapter = new BoundedLocalProcessAdapter(runtime, 'non-chemistry-adapter', 4_096, 4_096)

    await expect(adapter.run(await createRunOptions())).rejects.toMatchObject({
      name: 'BoundedProcessError',
      reason: 'runtime_changed'
    })
    expect(assertUnchanged).toHaveBeenCalledTimes(2)
  })
})
