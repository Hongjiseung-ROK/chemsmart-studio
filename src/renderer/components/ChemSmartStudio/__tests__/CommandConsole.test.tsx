import type * as CherryStudioUi from '@cherrystudio/ui'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipcMocks = vi.hoisted(() => ({
  listeners: new Map<string, (payload: never) => void>(),
  request: vi.fn()
}))
const cacheMocks = vi.hoisted(() => ({ history: [] as string[], setHistory: vi.fn() }))

vi.mock('@cherrystudio/ui', async (importOriginal) => importOriginal<typeof CherryStudioUi>())
vi.mock('@logger', () => ({ loggerService: { withContext: () => ({ error: vi.fn(), warn: vi.fn() }) } }))
vi.mock('@renderer/ipc', () => ({
  ipcApi: { request: (route: string, ...args: unknown[]) => ipcMocks.request(route, ...args) },
  useIpcOn: (event: string, handler: (payload: never) => void) => {
    ipcMocks.listeners.set(event, handler)
  }
}))
vi.mock('@renderer/data/hooks/useCache', () => ({
  usePersistCache: () => [cacheMocks.history, cacheMocks.setHistory]
}))
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key })
}))

import { CommandConsole } from '../CommandConsole'

function emit(event: 'chemsmart_studio.console.output' | 'chemsmart_studio.console.exited', payload: unknown) {
  act(() => {
    ipcMocks.listeners.get(event)?.(payload as never)
  })
}

const RUN_ID = '11111111-1111-4111-8111-111111111111'
const COMMAND_DIGEST = '0'.repeat(64)
const EMPTY_SEMANTIC = {
  breadcrumb: ['chemsmart'],
  slots: [],
  ghostSuffix: '',
  complete: false
}
const GREEN_PREFLIGHT = {
  commandDigest: COMMAND_DIGEST,
  verdict: 'green',
  summary: {
    kind: 'chemsmart',
    program: 'xtb',
    job: 'sp',
    inputName: 'water.xyz',
    charge: '0',
    multiplicity: '1'
  },
  failedRuleIds: [],
  issues: [],
  processStarted: false
}

describe('CommandConsole', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ipcMocks.listeners.clear()
    cacheMocks.history = []
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.console.complete') {
        return {
          commandPath: ['chemsmart'],
          replaceRange: { start: 0, end: 0 },
          items: [],
          semantic: EMPTY_SEMANTIC
        }
      }
      if (route === 'chemsmart_studio.console.preflight') return GREEN_PREFLIGHT
      if (route === 'chemsmart_studio.console.run') return { runId: RUN_ID }
      if (route === 'chemsmart_studio.console.cancel') return { cancelled: true }
      throw new Error(`Unexpected route: ${route}`)
    })
  })

  it('runs what the researcher typed, with no approval in the way', async () => {
    const user = userEvent.setup()
    render(<CommandConsole />)

    await user.type(screen.getByTestId('console-input'), 'chemsmart run gaussian opt')
    await user.click(screen.getByTestId('console-run'))

    await waitFor(() =>
      expect(ipcMocks.request).toHaveBeenCalledWith('chemsmart_studio.console.run', {
        command: 'chemsmart run gaussian opt',
        preflightDigest: COMMAND_DIGEST
      })
    )
    // No approval route is consulted: this is the researcher's own machine and their own command.
    expect(ipcMocks.request.mock.calls.map(([route]) => route)).not.toContain('chemsmart_studio.control.perform_action')
  })

  it('streams output and reports the exit code', async () => {
    const user = userEvent.setup()
    render(<CommandConsole />)
    await user.type(screen.getByTestId('console-input'), 'chemsmart --help')
    await user.click(screen.getByTestId('console-run'))
    await waitFor(() => expect(screen.getByTestId('console-cancel')).toBeInTheDocument())

    emit('chemsmart_studio.console.output', { runId: RUN_ID, stream: 'stdout', chunk: 'Usage: chemsmart\n' })
    expect(screen.getByText(/Usage: chemsmart/)).toBeInTheDocument()

    emit('chemsmart_studio.console.exited', { runId: RUN_ID, code: 0, signal: null })
    expect(screen.getByTestId('console-exit')).toHaveTextContent('chemsmart_studio.console.exit_code')
    expect(screen.getByTestId('console-run')).toBeInTheDocument()
  })

  it('drops output belonging to a run it is not showing', async () => {
    const user = userEvent.setup()
    render(<CommandConsole />)
    await user.type(screen.getByTestId('console-input'), 'true')
    await user.click(screen.getByTestId('console-run'))
    await waitFor(() => expect(screen.getByTestId('console-cancel')).toBeInTheDocument())

    // A late chunk from a cancelled run must not appear underneath the current one.
    emit('chemsmart_studio.console.output', { runId: 'other-run', stream: 'stdout', chunk: 'stale output\n' })

    expect(screen.queryByText(/stale output/)).toBeNull()
  })

  it('offers a stop control only while something is running', async () => {
    const user = userEvent.setup()
    render(<CommandConsole />)
    expect(screen.queryByTestId('console-cancel')).toBeNull()

    await user.type(screen.getByTestId('console-input'), 'chemsmart run gaussian opt')
    await user.click(screen.getByTestId('console-run'))
    await waitFor(() => expect(screen.getByTestId('console-cancel')).toBeInTheDocument())

    await user.click(screen.getByTestId('console-cancel'))
    expect(ipcMocks.request).toHaveBeenCalledWith('chemsmart_studio.console.cancel', { runId: RUN_ID })
  })

  it('explains a short flag by what it means at this command level', async () => {
    const user = userEvent.setup()
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.console.complete') {
        return {
          commandPath: ['chemsmart', 'run', 'gaussian'],
          replaceRange: { start: 23, end: 25 },
          items: [
            {
              id: 'multiplicity',
              label: '--multiplicity',
              insertText: '--multiplicity',
              kind: 'option',
              group: 'options',
              detail: 'Multiplicity of the molecule.',
              valueHint: 'int',
              appendSpace: true
            }
          ],
          semantic: {
            breadcrumb: ['chemsmart', 'run', 'gaussian'],
            slots: [],
            ghostSuffix: '[--multiplicity <int>]',
            complete: false
          }
        }
      }
      throw new Error(`Unexpected route: ${route}`)
    })
    render(<CommandConsole />)

    await user.type(screen.getByTestId('console-input'), 'chemsmart run gaussian -m')

    const popover = await screen.findByTestId('console-completions')
    expect(popover).toHaveTextContent('--multiplicity')
    expect(popover).toHaveTextContent('Multiplicity of the molecule.')
  })

  it('keeps a deleted completion request from restoring cached guidance', async () => {
    let resolveCompletion: ((value: unknown) => void) | undefined
    ipcMocks.request.mockImplementation((route: string) => {
      if (route !== 'chemsmart_studio.console.complete') throw new Error(`Unexpected route: ${route}`)
      return new Promise((resolve) => {
        resolveCompletion = resolve
      })
    })
    render(<CommandConsole />)

    const input = screen.getByTestId('console-input')
    fireEvent.change(input, { target: { value: 'chemsmart', selectionStart: 9 } })
    expect(ipcMocks.request).toHaveBeenCalledTimes(1)

    fireEvent.change(input, { target: { value: '', selectionStart: 0 } })
    expect(ipcMocks.request).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveCompletion?.({
        commandPath: ['chemsmart'],
        replaceRange: { start: 0, end: 9 },
        items: [
          {
            id: 'run',
            label: 'run',
            insertText: 'run',
            kind: 'command',
            group: 'commands',
            detail: 'Run a ChemSmart calculation.',
            appendSpace: true
          }
        ],
        semantic: EMPTY_SEMANTIC
      })
    })

    expect(input).toHaveValue('')
    expect(screen.queryByTestId('console-completions')).toBeNull()
    expect(screen.queryByTestId('console-semantic-guide')).toBeNull()
  })

  it('completes the line in place when a candidate is chosen', async () => {
    const user = userEvent.setup()
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.console.complete') {
        return {
          commandPath: ['chemsmart', 'run'],
          replaceRange: { start: 14, end: 15 },
          items: [
            {
              id: 'gaussian',
              label: 'gaussian',
              insertText: 'gaussian',
              kind: 'command',
              group: 'commands',
              detail: 'Run a Gaussian calculation.',
              appendSpace: true
            }
          ],
          semantic: {
            breadcrumb: ['chemsmart', 'run'],
            slots: [],
            ghostSuffix: '⟨gaussian | orca | xtb⟩',
            complete: false
          }
        }
      }
      throw new Error(`Unexpected route: ${route}`)
    })
    render(<CommandConsole />)

    const input = screen.getByTestId('console-input')
    await user.type(input, 'chemsmart run g')
    await user.click(await screen.findByRole('button', { name: /gaussian/ }))

    expect(input).toHaveValue('chemsmart run gaussian ')
  })

  it('navigates candidates with arrows and applies the selected item with Tab', async () => {
    const user = userEvent.setup()
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.console.complete') {
        return {
          commandPath: ['chemsmart', 'run', 'xtb'],
          replaceRange: { start: 18, end: 18 },
          items: ['sp', 'opt', 'hess'].map((label) => ({
            id: label,
            label,
            insertText: label,
            kind: 'command',
            group: 'commands',
            detail: `${label} command`,
            appendSpace: true
          })),
          semantic: {
            breadcrumb: ['chemsmart', 'run', 'xtb'],
            slots: [],
            ghostSuffix: '⟨sp | opt | hess⟩',
            complete: false
          }
        }
      }
      throw new Error(`Unexpected route: ${route}`)
    })
    render(<CommandConsole />)

    const input = screen.getByTestId('console-input')
    await user.type(input, 'chemsmart run xtb ')
    await screen.findByTestId('console-completions')
    await user.keyboard('{ArrowDown}{Tab}')

    expect(input).toHaveValue('chemsmart run xtb opt ')
  })

  it('recalls a previous command with the up arrow', async () => {
    const user = userEvent.setup()
    cacheMocks.history = ['chemsmart run gaussian opt', 'chemsmart --help']
    render(<CommandConsole />)

    const input = screen.getByTestId('console-input')
    await user.click(input)
    await user.keyboard('{ArrowUp}')

    expect(input).toHaveValue('chemsmart run gaussian opt')
  })

  it('will not submit an empty command', async () => {
    render(<CommandConsole />)

    expect(screen.getByTestId('console-run')).toBeDisabled()
  })

  it('requires a second Enter for the same warning digest and starts no approval flow', async () => {
    const user = userEvent.setup()
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.console.complete') {
        return {
          commandPath: ['chemsmart'],
          replaceRange: { start: 0, end: 0 },
          items: [],
          semantic: EMPTY_SEMANTIC
        }
      }
      if (route === 'chemsmart_studio.console.preflight') {
        return {
          ...GREEN_PREFLIGHT,
          verdict: 'warning',
          failedRuleIds: ['cmd.semantic.dry_run_required'],
          issues: [
            {
              ruleId: 'cmd.semantic.dry_run_required',
              severity: 'warn',
              message: 'Review the dry-run requirement.'
            }
          ]
        }
      }
      if (route === 'chemsmart_studio.console.run') return { runId: RUN_ID }
      throw new Error(`Unexpected route: ${route}`)
    })
    render(<CommandConsole />)

    await user.type(screen.getByTestId('console-input'), 'chemsmart run xtb -f water.xyz sp')
    await user.click(screen.getByTestId('console-run'))

    expect(await screen.findByTestId('console-preflight')).toHaveTextContent(
      'chemsmart_studio.console.preflight_warning'
    )
    expect(ipcMocks.request.mock.calls.map(([route]) => route)).not.toContain('chemsmart_studio.console.run')

    await user.click(screen.getByTestId('console-run'))
    await waitFor(() =>
      expect(ipcMocks.request).toHaveBeenCalledWith('chemsmart_studio.console.run', {
        command: 'chemsmart run xtb -f water.xyz sp',
        preflightDigest: COMMAND_DIGEST
      })
    )
    expect(ipcMocks.request.mock.calls.map(([route]) => route)).not.toContain('chemsmart_studio.control.perform_action')
  })

  it('blocks a rejected preflight without starting a process', async () => {
    const user = userEvent.setup()
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.console.complete') {
        return {
          commandPath: ['chemsmart'],
          replaceRange: { start: 0, end: 0 },
          items: [],
          semantic: EMPTY_SEMANTIC
        }
      }
      if (route === 'chemsmart_studio.console.preflight') {
        return {
          ...GREEN_PREFLIGHT,
          verdict: 'rejected',
          failedRuleIds: ['cmd.runtime.input_not_found'],
          issues: [
            {
              ruleId: 'cmd.runtime.input_not_found',
              severity: 'reject',
              message: 'The input molecule is missing.'
            }
          ]
        }
      }
      throw new Error(`Unexpected route: ${route}`)
    })
    render(<CommandConsole />)

    await user.type(screen.getByTestId('console-input'), 'chemsmart run xtb sp')
    await user.click(screen.getByTestId('console-run'))

    expect(await screen.findByRole('alert')).toHaveTextContent('chemsmart_studio.console.preflight_rejected')
    expect(ipcMocks.request.mock.calls.map(([route]) => route)).not.toContain('chemsmart_studio.console.run')
  })

  it('resolves an exact molecule candidate through its opaque context handle', async () => {
    const user = userEvent.setup()
    const onOpenCompletion = vi.fn()
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.console.complete') {
        return {
          commandPath: ['chemsmart', 'run', 'xtb'],
          replaceRange: { start: 22, end: 22 },
          items: [
            {
              id: 'water-file',
              label: 'water.xyz',
              insertText: 'water.xyz',
              kind: 'file',
              group: 'files',
              detail: 'Studio project artifact',
              valueHint: 'path',
              appendSpace: true,
              contextRef: 'completion-water',
              openAction: 'molecule'
            }
          ],
          semantic: {
            breadcrumb: ['chemsmart', 'run', 'xtb'],
            slots: [],
            ghostSuffix: '',
            complete: false
          }
        }
      }
      if (route === 'chemsmart_studio.console.accept_completion') {
        return { contextRef: 'completion-water', action: 'molecule', displayName: 'water.xyz' }
      }
      throw new Error(`Unexpected route: ${route}`)
    })
    render(<CommandConsole onOpenCompletion={onOpenCompletion} />)

    await user.type(screen.getByTestId('console-input'), 'chemsmart run xtb -f ')
    await user.click(await screen.findByRole('button', { name: /water\.xyz/ }))

    await waitFor(() =>
      expect(onOpenCompletion).toHaveBeenCalledWith({
        contextRef: 'completion-water',
        action: 'molecule',
        displayName: 'water.xyz'
      })
    )
  })
})
