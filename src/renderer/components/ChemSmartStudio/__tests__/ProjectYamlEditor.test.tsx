import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipcMocks = vi.hoisted(() => ({ request: vi.fn() }))
const loggerMocks = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn() }))

vi.mock('@logger', () => ({ loggerService: { withContext: () => loggerMocks } }))
vi.mock('@renderer/ipc', () => ({
  ipcApi: { request: (...args: unknown[]) => ipcMocks.request(...args) },
  useIpcOn: vi.fn()
}))
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => options?.defaultValue ?? key })
}))

import { ProjectYamlEditor } from '../ProjectYamlEditor'
import { ProjectYamlPanel } from '../ProjectYamlPanel'

const PROJECT_YAML = 'gas:\n  functional: b3lyp\n  basis: def2-svp\n'
const accepted = {
  schemaVersion: '1',
  projectName: 'b3lyp-water',
  program: 'gaussian',
  verdict: 'ok',
  issues: [],
  message: 'Project YAML passed ChemSmart validation.',
  extensions: {}
}
const rejected = {
  ...accepted,
  verdict: 'reject',
  issues: [
    {
      ruleId: 'yaml.basis.unrecognized',
      severity: 'reject',
      message: 'basis is not in the catalog',
      extensions: {}
    }
  ]
}

async function fillIn(project: string, yaml: string) {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('chemsmart_studio.project.name'), project)
  await user.type(screen.getByLabelText('chemsmart_studio.project.yaml_label'), yaml)
  return user
}

describe('ProjectYamlEditor', () => {
  beforeEach(() => {
    ipcMocks.request.mockReset()
    loggerMocks.error.mockReset()
  })

  it('offers only project-backed engines and no direct file-write action', () => {
    render(<ProjectYamlEditor />)

    expect(screen.getByText('gaussian')).toBeInTheDocument()
    expect(screen.getByText('orca')).toBeInTheDocument()
    expect(screen.queryByText('xtb')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /project\.write/ })).not.toBeInTheDocument()
  })

  it('validates through the closed project contract and renders trusted issues', async () => {
    ipcMocks.request.mockResolvedValue(rejected)
    render(<ProjectYamlEditor />)
    const user = await fillIn('b3lyp-water', PROJECT_YAML)

    await act(async () => {
      await user.click(screen.getByRole('button', { name: /project\.validate/ }))
    })

    expect(ipcMocks.request).toHaveBeenCalledWith('chemsmart_studio.project.validate', {
      extensions: {},
      program: 'gaussian',
      projectName: 'b3lyp-water',
      yamlText: PROJECT_YAML
    })
    expect(screen.getByText('yaml.basis.unrecognized')).toBeInTheDocument()
    expect(screen.getByText('basis is not in the catalog')).toBeInTheDocument()
  })

  it('critiques without persisting the draft', async () => {
    ipcMocks.request.mockResolvedValue({
      ...accepted,
      summary: 'The method is internally consistent.',
      unsupportedFeatures: []
    })
    render(<ProjectYamlEditor />)
    const user = await fillIn('b3lyp-water', PROJECT_YAML)

    await act(async () => {
      await user.click(screen.getByRole('button', { name: /project\.critique/ }))
    })

    expect(ipcMocks.request).toHaveBeenCalledWith('chemsmart_studio.project.critic', {
      extensions: {},
      program: 'gaussian',
      projectName: 'b3lyp-water',
      yamlText: PROJECT_YAML
    })
    expect(ipcMocks.request.mock.calls.map(([route]) => route)).not.toContain('chemsmart_studio.project.write')
  })

  it('clears a stale report after the YAML changes', async () => {
    ipcMocks.request.mockResolvedValue(accepted)
    render(<ProjectYamlEditor />)
    const user = await fillIn('b3lyp-water', PROJECT_YAML)
    await act(async () => {
      await user.click(screen.getByRole('button', { name: /project\.validate/ }))
    })
    expect(screen.getByTestId('project-check')).toBeInTheDocument()

    await user.type(screen.getByLabelText('chemsmart_studio.project.yaml_label'), 'x')

    expect(screen.queryByTestId('project-check')).not.toBeInTheDocument()
  })
})

describe('ProjectYamlPanel', () => {
  beforeEach(() => {
    ipcMocks.request.mockReset()
    loggerMocks.error.mockReset()
  })

  it('keeps direct ChemSmart project actions available before the Agent bridge is running', async () => {
    ipcMocks.request.mockResolvedValue({
      schemaVersion: '1',
      programs: [
        { program: 'gaussian', projectRequired: true, projectNames: [], extensions: {} },
        { program: 'orca', projectRequired: true, projectNames: [], extensions: {} },
        { program: 'xtb', projectRequired: false, projectNames: [], extensions: {} }
      ],
      extensions: {}
    })
    const user = userEvent.setup()
    render(<ProjectYamlPanel autoLoad={false} />)

    expect(ipcMocks.request).not.toHaveBeenCalled()
    expect(screen.getByTestId('project-yaml-editor')).toBeInTheDocument()
    const refresh = screen.getByRole('button', { name: 'common.refresh' })
    expect(refresh).toBeEnabled()

    await act(async () => {
      await user.click(refresh)
    })

    expect(ipcMocks.request).toHaveBeenCalledWith('chemsmart_studio.project.list', { extensions: {} })
  })
})
