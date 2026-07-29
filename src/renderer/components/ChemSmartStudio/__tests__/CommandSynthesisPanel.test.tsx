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

import { CommandSynthesisPanel } from '../CommandSynthesisPanel'

const readyResult = {
  schemaVersion: '1',
  synthesisId: 'synthesis-1',
  sessionId: 'session-1',
  status: 'ready',
  command: 'chemsmart run xtb -f ethanol.xyz -c 0 -m 1 opt',
  commandDigest: '0'.repeat(64),
  explanation: 'GFN2-xTB optimisation of the registered neutral singlet.',
  projectName: null,
  missingInfo: [],
  semantic: { verdict: 'ok', failedRuleIds: [], message: 'Semantic gate passed.', extensions: {} },
  intent: { verdict: 'ok', failedRuleIds: [], message: 'Intent gate passed.', extensions: {} },
  publicEvidence: [
    {
      evidenceId: 'evidence-intent-1',
      kind: 'intentGate',
      verdict: 'ok',
      summary: 'Intent gate passed.',
      ruleIds: [],
      extensions: {}
    }
  ],
  executionPerformed: false,
  approvalRequiredForExecution: true,
  extensions: {}
}

async function synthesize(request: string, modelId: `${string}::${string}` | null = 'provider::model') {
  const user = userEvent.setup()
  render(<CommandSynthesisPanel modelId={modelId} sessionId="session-1" stacked={false} />)
  await user.type(screen.getByRole('textbox'), request)
  const submit = screen.getByRole('button', { name: /synthesis.submit/ })
  if (modelId) {
    await act(async () => {
      await user.click(submit)
    })
  }
  return submit
}

describe('CommandSynthesisPanel', () => {
  beforeEach(() => {
    ipcMocks.request.mockReset()
    loggerMocks.error.mockReset()
  })

  it('binds synthesis to the visible session and selected host model', async () => {
    ipcMocks.request.mockResolvedValue(readyResult)

    await synthesize('Optimise ethanol with GFN2-xTB')

    expect(ipcMocks.request).toHaveBeenCalledWith('chemsmart_studio.command.synthesize', {
      extensions: {},
      modelId: 'provider::model',
      request: 'Optimise ethanol with GFN2-xTB',
      sessionId: 'session-1'
    })
    expect(screen.getByText('chemsmart_studio.synthesis.semantic_question')).toBeInTheDocument()
    expect(screen.getByText('chemsmart_studio.synthesis.intent_question')).toBeInTheDocument()
    expect(screen.getByTestId('synthesis-result')).toHaveAttribute('data-runnable', 'true')
  })

  it('refuses to present a drifted command as runnable', async () => {
    ipcMocks.request.mockResolvedValue({
      ...readyResult,
      status: 'intentRejected',
      commandDigest: null,
      intent: {
        verdict: 'reject',
        failedRuleIds: ['intent.charge'],
        message: 'Intent gate rejected charge.',
        extensions: {}
      }
    })

    await synthesize('Optimise the ethanol anion, charge -1')

    const result = screen.getByTestId('synthesis-result')
    expect(result).toHaveAttribute('data-runnable', 'false')
    expect(result).toHaveAttribute('data-status', 'intentRejected')
    expect(screen.getByRole('alert')).toHaveTextContent('chemsmart_studio.synthesis.intent_reject')
    expect(screen.getByText('intent.charge')).toBeInTheDocument()
  })

  it('lists required information instead of inventing it', async () => {
    ipcMocks.request.mockResolvedValue({
      ...readyResult,
      status: 'needsClarification',
      command: '',
      commandDigest: null,
      missingInfo: ['project', 'charge'],
      intent: { verdict: 'unavailable', failedRuleIds: [], message: 'More intent is required.', extensions: {} }
    })

    await synthesize('Optimise ethanol with B3LYP')

    expect(screen.queryByTestId('synthesized-command')).toBeNull()
    expect(screen.getByText('project')).toBeInTheDocument()
    expect(screen.getByText('charge')).toBeInTheDocument()
  })

  it('disables synthesis when no host model is selected', async () => {
    const submit = await synthesize('Optimise ethanol', null)

    expect(submit).toBeDisabled()
    expect(ipcMocks.request).not.toHaveBeenCalled()
  })

  it('reports a failed request without leaving a stale result on screen', async () => {
    ipcMocks.request.mockRejectedValue(new Error('sidecar down'))

    await synthesize('Optimise ethanol')

    expect(screen.getByRole('alert')).toHaveTextContent('chemsmart_studio.synthesis.failed')
    expect(screen.queryByTestId('synthesis-result')).toBeNull()
    expect(loggerMocks.error).toHaveBeenCalled()
  })
})
