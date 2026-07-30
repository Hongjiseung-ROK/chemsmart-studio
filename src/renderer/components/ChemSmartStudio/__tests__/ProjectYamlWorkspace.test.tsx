import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipcMocks = vi.hoisted(() => ({ request: vi.fn() }))
const loggerMocks = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn() }))

vi.mock('@cherrystudio/ui', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()) }))
vi.mock('@logger', () => ({ loggerService: { withContext: () => loggerMocks } }))
vi.mock('@renderer/ipc', () => ({
  ipcApi: { request: (...args: unknown[]) => ipcMocks.request(...args) },
  useIpcOn: vi.fn()
}))
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.defaultValue ?? (key === 'chemsmart_studio.project.renderer.digest' ? `Digest ${options?.digest}` : key)
  })
}))

import { ProjectYamlPanel } from '../ProjectYamlPanel'
import { type ProjectYamlDocumentPresentation, ProjectYamlWorkspace } from '../ProjectYamlWorkspace'

const RAW_YAML = `gas:
  functional: b3lyp
  basis: def2-svp
solv:
  solvent_model: smd
  solvent_id: water
future_block:
  enabled: true
`

const document: ProjectYamlDocumentPresentation = {
  digest: 'a'.repeat(64),
  program: 'gaussian',
  projectName: 'b3lyp-water',
  rawText: RAW_YAML,
  sections: [
    {
      fields: [
        { id: 'gas-functional', label: 'Functional', source: 'explicit', value: 'b3lyp' },
        { id: 'gas-basis', label: 'Basis', source: 'inherited', value: 'def2-svp' }
      ],
      id: 'gas',
      label: 'Gas phase',
      source: 'explicit'
    },
    {
      fields: [
        { id: 'solvent-model', label: 'Solvent model', source: 'explicit', value: 'smd' },
        { id: 'solvent-id', label: 'Solvent', source: 'explicit', value: 'water' }
      ],
      id: 'solv',
      label: 'Solvation',
      source: 'explicit'
    }
  ],
  unknownNodes: [
    {
      children: [
        {
          id: 'future-enabled',
          kind: 'scalar',
          path: ['future_block', 'enabled'],
          source: 'explicit',
          value: 'true'
        }
      ],
      id: 'future-block',
      kind: 'mapping',
      path: ['future_block'],
      source: 'explicit'
    }
  ],
  validation: {
    issues: [
      {
        message: 'This key is preserved for a newer ChemSmart version.',
        ruleId: 'yaml.future.unrecognized',
        severity: 'warn'
      }
    ],
    verdict: 'warn'
  }
}

describe('ProjectYamlWorkspace', () => {
  it('renders semantic sections, source provenance, validation, and every unknown node', () => {
    render(<ProjectYamlWorkspace document={document} />)

    expect(screen.getByRole('heading', { name: 'b3lyp-water' })).toBeInTheDocument()
    expect(screen.getByText('gaussian')).toBeInTheDocument()
    expect(screen.getByText('Digest aaaaaaaaaaaa')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Gas phase' })).toBeInTheDocument()
    expect(screen.getByText('Functional')).toBeInTheDocument()
    expect(screen.getByText('b3lyp')).toBeInTheDocument()
    expect(screen.getByText('Basis')).toBeInTheDocument()
    expect(screen.getByText('def2-svp')).toBeInTheDocument()
    expect(screen.getByText('yaml.future.unrecognized')).toBeInTheDocument()
    expect(screen.getByText('future_block')).toBeInTheDocument()
    expect(screen.getByText('enabled')).toBeInTheDocument()
    expect(screen.getAllByText('chemsmart_studio.project.renderer.source.explicit').length).toBeGreaterThan(1)
    expect(screen.getByText('chemsmart_studio.project.renderer.source.inherited')).toBeInTheDocument()
  })

  it('keeps raw YAML behind a read-only disclosure', async () => {
    const user = userEvent.setup()
    render(<ProjectYamlWorkspace document={document} />)

    expect(screen.queryByTestId('project-yaml-raw')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'chemsmart_studio.project.renderer.raw_yaml' }))

    expect(screen.getByTestId('project-yaml-raw')).toHaveTextContent('future_block:')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /write|save|apply/i })).not.toBeInTheDocument()
  })
})

describe('ProjectYamlPanel', () => {
  beforeEach(() => {
    ipcMocks.request.mockReset()
    loggerMocks.error.mockReset()
  })

  it('loads a selected project into the read-only workspace without mounting the authoring textarea', async () => {
    ipcMocks.request
      .mockResolvedValueOnce({
        extensions: {},
        programs: [
          { extensions: {}, program: 'gaussian', projectNames: ['b3lyp-water'], projectRequired: true },
          { extensions: {}, program: 'orca', projectNames: [], projectRequired: true },
          { extensions: {}, program: 'xtb', projectNames: [], projectRequired: false }
        ],
        schemaVersion: '1'
      })
      .mockResolvedValueOnce({
        digest: 'a'.repeat(64),
        extensions: {},
        program: 'gaussian',
        projectName: 'b3lyp-water',
        schemaVersion: '2',
        sections: [
          {
            extensions: {},
            fields: [
              {
                extensions: {},
                id: 'gas-functional',
                kind: 'string',
                label: 'Functional',
                path: ['gas', 'functional'],
                recognized: true,
                source: 'explicit',
                value: 'b3lyp'
              }
            ],
            id: 'gas',
            label: 'Gas phase',
            source: 'explicit'
          }
        ],
        unknownNodes: [],
        validation: { extensions: {}, issues: [], message: 'Valid.', verdict: 'ok' },
        yamlText: RAW_YAML
      })
    const user = userEvent.setup()
    render(<ProjectYamlPanel autoLoad={false} />)

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'common.refresh' }))
    await user.click(await screen.findByRole('button', { name: /b3lyp-water/ }))

    expect(ipcMocks.request).toHaveBeenLastCalledWith('chemsmart_studio.project.document', {
      extensions: {},
      program: 'gaussian',
      projectName: 'b3lyp-water'
    })
    expect(await screen.findByTestId('project-yaml-workspace')).toBeInTheDocument()
    expect(screen.queryByTestId('project-yaml-editor')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})
