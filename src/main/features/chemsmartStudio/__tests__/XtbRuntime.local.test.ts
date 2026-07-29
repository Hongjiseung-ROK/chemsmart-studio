import path from 'node:path'

import { BaseService } from '@main/core/lifecycle'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BoundedLocalProcessAdapter } from '../BoundedProcess'
import { CalculationRuntimeService } from '../CalculationRuntimeService'
import { discoverXtbRuntime } from '../XtbRuntime'

const configuredExecutable = process.env.CHEMSMART_STUDIO_TEST_XTB_EXECUTABLE

describe('configured local xTB runtime', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    BaseService.resetInstances()
  })

  it.runIf(Boolean(configuredExecutable))(
    'discovers the real executable and dynamic-library closure without running chemistry',
    async () => {
      const runtime = await discoverXtbRuntime(configuredExecutable!)

      expect(runtime.identity).toMatchObject({
        kind: 'local_executable',
        engine: 'xtb',
        architecture: process.arch
      })
      expect(runtime.identity.version).toMatch(/^\d+\.\d+\.\d+/)
      expect(runtime.identity.libraries.length).toBeGreaterThan(0)
      expect(runtime.identity.resources?.map(({ name }) => name)).toEqual(['param_gfn2-xtb.txt'])
      expect(JSON.stringify(runtime.identity)).not.toContain(configuredExecutable)
      await expect(runtime.assertUnchanged()).resolves.toBeUndefined()

      const adapter = new BoundedLocalProcessAdapter(runtime, 'xtb-version-probe', 64 * 1024, 64 * 1024)
      const result = await adapter.run({
        args: ['--version'],
        cwd: path.dirname(runtime.executablePath),
        timeoutMs: 5_000
      })
      expect(result.exitCode).toBe(0)
      expect(`${result.stdout}\n${result.stderr}`).toContain(`xtb version ${runtime.identity.version}`)
    }
  )

  it.runIf(Boolean(configuredExecutable))(
    'loads the configured runtime into the lifecycle calculation owner without exposing its path',
    async () => {
      vi.stubEnv('CHEMSMART_STUDIO_XTB_EXECUTABLE', configuredExecutable)
      BaseService.resetInstances()
      const service = new CalculationRuntimeService()

      await service._doInit()

      const identity = service.getLocalXtbRuntimeIdentity()
      expect(identity).toMatchObject({ engine: 'xtb', kind: 'local_executable', version: '6.7.1' })
      expect(JSON.stringify(identity)).not.toContain(configuredExecutable)
      await service._doStop()
    }
  )
})
