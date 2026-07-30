import type * as CherryStudioUi from '@cherrystudio/ui'
import type { ChemSmartStudioConsoleCompletions } from '@shared/ipc/schemas/chemsmartStudio'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipcMocks = vi.hoisted(() => ({
  listeners: new Map<string, (payload: never) => void>(),
  request: vi.fn()
}))
const cacheMocks = vi.hoisted(() => ({ history: [] as string[], setHistory: vi.fn() }))
const fileMocks = vi.hoisted(() => ({ getPathForFile: vi.fn() }))

vi.mock('@cherrystudio/ui', async (importOriginal) => importOriginal<typeof CherryStudioUi>())
vi.mock('@logger', () => ({ loggerService: { withContext: () => ({ error: vi.fn(), warn: vi.fn() }) } }))
vi.mock('@renderer/ipc', () => ({
  ipcApi: {
    request: async (route: string, ...args: unknown[]) => {
      const result = await ipcMocks.request(route, ...args)
      if (route !== 'chemsmart_studio.console.complete') return result
      const request = args[0] as { disclosure: 'primary' | 'all' }
      return { stage: 'subcommand', disclosure: request.disclosure, hasMore: false, ...result }
    }
  },
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
interface TestSemantic {
  breadcrumb: string[]
  slots: Array<{
    consumed: boolean
    id: string
    insertAt: number
    insertText: string
    kind: 'leaf' | 'option'
    label: string
    required: boolean
    valueHint: string
  }>
  ghostSuffix: string
  complete: boolean
}

const EMPTY_SEMANTIC: TestSemantic = {
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

function candidate(label: string, index = 0) {
  return {
    id: `candidate-${index}`,
    label,
    insertText: label,
    kind: 'command' as const,
    group: 'commands' as const,
    detail: `${label} detail`,
    valueHint: 'value',
    appendSpace: true
  }
}

function completionResult(
  overrides: Partial<{
    commandPath: string[]
    disclosure: 'primary' | 'all'
    hasMore: boolean
    items: ChemSmartStudioConsoleCompletions['items']
    replaceRange: { start: number; end: number }
    semantic: TestSemantic
    stage: 'root' | 'subcommand' | 'required_value' | 'option' | 'complete'
  }> = {}
) {
  return {
    commandPath: ['chemsmart'],
    stage: 'root' as const,
    disclosure: 'primary' as const,
    hasMore: false,
    replaceRange: { start: 0, end: 0 },
    items: [],
    semantic: EMPTY_SEMANTIC,
    ...overrides
  }
}

describe('CommandConsole', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ipcMocks.listeners.clear()
    cacheMocks.history = []
    fileMocks.getPathForFile.mockImplementation((file: File) => `/tmp/${file.name}`)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { file: { getPathForFile: fileMocks.getPathForFile } }
    })
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
    await user.click(await screen.findByRole('option', { name: /gaussian/ }))

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
          replaceRange: { start: 21, end: 21 },
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
    await user.click(await screen.findByRole('option', { name: /water\.xyz/ }))

    await waitFor(() =>
      expect(onOpenCompletion).toHaveBeenCalledWith({
        contextRef: 'completion-water',
        action: 'molecule',
        displayName: 'water.xyz'
      })
    )
  })

  it('defers a molecule completion to the workspace draft review', async () => {
    const user = userEvent.setup()
    const onOpenCompletionRequest = vi.fn(() => true)
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.console.complete') {
        return completionResult({
          commandPath: ['chemsmart', 'run', 'xtb'],
          items: [
            {
              ...candidate('water.xyz'),
              contextRef: 'completion-water',
              group: 'files',
              kind: 'file',
              openAction: 'molecule'
            }
          ],
          replaceRange: { start: 21, end: 21 }
        })
      }
      throw new Error(`Unexpected route: ${route}`)
    })
    render(<CommandConsole onOpenCompletionRequest={onOpenCompletionRequest} />)

    await user.type(screen.getByTestId('console-input'), 'chemsmart run xtb -f ')
    await user.click(await screen.findByRole('option', { name: /water\.xyz/ }))

    expect(onOpenCompletionRequest).toHaveBeenCalledWith('completion-water')
    expect(ipcMocks.request.mock.calls.map(([route]) => route)).not.toContain(
      'chemsmart_studio.console.accept_completion'
    )
  })

  it('publishes only the latest matching line, cursor, and disclosure request', async () => {
    const pending: Array<{ resolve: (value: unknown) => void }> = []
    ipcMocks.request.mockImplementation((route: string) => {
      if (route !== 'chemsmart_studio.console.complete') throw new Error(`Unexpected route: ${route}`)
      return new Promise((resolve) => pending.push({ resolve }))
    })
    render(<CommandConsole />)

    const input = screen.getByTestId('console-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'chemsmart', selectionStart: 9 } })
    input.setSelectionRange(0, 0)
    fireEvent.select(input)
    expect(ipcMocks.request).toHaveBeenNthCalledWith(1, 'chemsmart_studio.console.complete', {
      line: 'chemsmart',
      cursor: 9,
      disclosure: 'primary'
    })
    expect(ipcMocks.request).toHaveBeenNthCalledWith(2, 'chemsmart_studio.console.complete', {
      line: 'chemsmart',
      cursor: 0,
      disclosure: 'primary'
    })

    await act(async () => {
      pending[0].resolve(completionResult({ items: [candidate('stale')], replaceRange: { start: 0, end: 9 } }))
    })
    expect(screen.queryByRole('option', { name: /stale/ })).toBeNull()
    expect(screen.queryByTestId('console-semantic-guide')).toBeNull()

    await act(async () => {
      pending[1].resolve(completionResult({ items: [candidate('fresh')], replaceRange: { start: 0, end: 0 } }))
    })
    expect(await screen.findByRole('option', { name: /fresh/ })).toBeInTheDocument()
  })

  it('does not restore stale guidance after history changes the whole command', async () => {
    const pending: Array<{ resolve: (value: unknown) => void }> = []
    cacheMocks.history = ['chemsmart run xtb sp']
    ipcMocks.request.mockImplementation((route: string) => {
      if (route !== 'chemsmart_studio.console.complete') throw new Error(`Unexpected route: ${route}`)
      return new Promise((resolve) => pending.push({ resolve }))
    })
    render(<CommandConsole />)

    const input = screen.getByTestId('console-input')
    fireEvent.change(input, { target: { value: 'old', selectionStart: 3 } })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input).toHaveValue('chemsmart run xtb sp')
    expect(pending).toHaveLength(2)

    await act(async () => {
      pending[0].resolve(completionResult({ items: [candidate('stale-history')] }))
    })
    expect(input).toHaveValue('chemsmart run xtb sp')
    expect(screen.queryByRole('option', { name: /stale-history/ })).toBeNull()
  })

  it('rejects a completion result whose returned disclosure does not match the request', async () => {
    ipcMocks.request.mockResolvedValue(
      completionResult({
        disclosure: 'all',
        items: [candidate('wrong-disclosure')],
        replaceRange: { start: 0, end: 1 }
      })
    )
    render(<CommandConsole />)

    fireEvent.change(screen.getByTestId('console-input'), { target: { value: 'c', selectionStart: 1 } })

    await waitFor(() => expect(ipcMocks.request).toHaveBeenCalled())
    expect(screen.queryByRole('option', { name: /wrong-disclosure/ })).toBeNull()
    expect(screen.queryByTestId('console-semantic-guide')).toBeNull()
  })

  it('renders every bounded candidate in an eight-to-ten-row scroll container', async () => {
    const items = Array.from({ length: 20 }, (_, index) => candidate(`choice-${index}`, index))
    ipcMocks.request.mockResolvedValue(completionResult({ items, replaceRange: { start: 0, end: 1 } }))
    render(<CommandConsole />)

    fireEvent.change(screen.getByTestId('console-input'), { target: { value: 'c', selectionStart: 1 } })

    expect(await screen.findAllByRole('option')).toHaveLength(20)
    expect(screen.getByTestId('console-completions')).toHaveClass('max-h-[20rem]', 'overflow-y-auto')
  })

  it('clamps navigation across twenty rows, scrolls the selected row, and keeps input focus', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView
    })
    const items = Array.from({ length: 20 }, (_, index) => candidate(`choice-${index}`, index))
    ipcMocks.request.mockResolvedValue(completionResult({ items, replaceRange: { start: 0, end: 1 } }))
    render(<CommandConsole />)

    const input = screen.getByTestId('console-input')
    fireEvent.change(input, { target: { value: 'c', selectionStart: 1 } })
    await screen.findAllByRole('option')
    input.focus()
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input).toHaveAttribute('aria-activedescendant', 'console-completion-candidate-0')
    fireEvent.keyDown(input, { key: 'End' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input).toHaveAttribute('aria-activedescendant', 'console-completion-candidate-19')
    fireEvent.keyDown(input, { key: 'Home' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input).toHaveAttribute('aria-activedescendant', 'console-completion-candidate-0')
    expect(input).toHaveFocus()
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('portals the responsive completion surface outside a clipped Console pane', async () => {
    ipcMocks.request.mockResolvedValue(
      completionResult({ items: [candidate('portal-choice')], replaceRange: { start: 0, end: 1 } })
    )
    render(
      <div data-testid="clipped-pane" style={{ overflow: 'hidden' }}>
        <CommandConsole />
      </div>
    )

    fireEvent.change(screen.getByTestId('console-input'), { target: { value: 'c', selectionStart: 1 } })
    const popover = await screen.findByTestId('console-completion-popover')

    expect(screen.getByTestId('clipped-pane')).not.toContainElement(popover)
    expect(document.body).toContainElement(popover)
    expect(popover).toHaveClass('w-[clamp(26.25rem,64vw,45rem)]', 'max-w-[calc(100vw-1.5rem)]')
  })

  it('offers root primary run/sub choices, expands More to all, and closes with Escape', async () => {
    ipcMocks.request.mockImplementation(async (route: string, input: { disclosure: 'primary' | 'all' }) => {
      if (route !== 'chemsmart_studio.console.complete') throw new Error(`Unexpected route: ${route}`)
      if (input.disclosure === 'all') {
        return completionResult({
          disclosure: 'all',
          items: [candidate('run'), candidate('sub', 1), candidate('config', 2)]
        })
      }
      return completionResult({ hasMore: true, items: [candidate('run'), candidate('sub', 1)] })
    })
    render(<CommandConsole />)

    const input = screen.getByTestId('console-input')
    fireEvent.change(input, { target: { value: 'c', selectionStart: 1 } })
    expect(await screen.findAllByRole('option')).toHaveLength(2)
    expect(ipcMocks.request).toHaveBeenLastCalledWith('chemsmart_studio.console.complete', {
      line: 'c',
      cursor: 1,
      disclosure: 'primary'
    })

    fireEvent.mouseDown(screen.getByTestId('console-more-completions'))
    fireEvent.click(screen.getByTestId('console-more-completions'))
    expect(await screen.findByRole('option', { name: /config/ })).toBeInTheDocument()
    expect(ipcMocks.request).toHaveBeenLastCalledWith('chemsmart_studio.console.complete', {
      line: 'c',
      cursor: 1,
      disclosure: 'all'
    })
    expect(input).toHaveFocus()

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByTestId('console-completions')).toBeNull()
    expect(input).toHaveAttribute('aria-expanded', 'false')
  })

  it('uses Ctrl+Space for all candidates and Shift+Tab for the previous required slot', async () => {
    ipcMocks.request.mockImplementation(async (route: string, input: { disclosure: 'primary' | 'all' }) => {
      if (route !== 'chemsmart_studio.console.complete') throw new Error(`Unexpected route: ${route}`)
      return completionResult({
        disclosure: input.disclosure,
        items: [candidate('choice')],
        semantic: {
          breadcrumb: ['chemsmart', 'run'],
          slots: [
            {
              id: 'file-slot',
              label: 'file',
              insertText: '--file',
              valueHint: 'path',
              kind: 'option',
              required: true,
              consumed: false,
              insertAt: 9
            }
          ],
          ghostSuffix: '⟨file⟩',
          complete: false
        }
      })
    })
    render(<CommandConsole />)

    const input = screen.getByTestId('console-input')
    fireEvent.change(input, { target: { value: 'chemsmart run', selectionStart: 13 } })
    await screen.findByRole('option')
    fireEvent.keyDown(input, { key: ' ', code: 'Space', ctrlKey: true })
    await waitFor(() =>
      expect(ipcMocks.request).toHaveBeenLastCalledWith('chemsmart_studio.console.complete', {
        line: 'chemsmart run',
        cursor: 13,
        disclosure: 'all'
      })
    )
    await screen.findByRole('option')
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })
    })
    expect(input).toHaveValue('chemsmart --file run')
    expect(input).toHaveFocus()
  })

  it('accepts one verified coordinate drop without losing the suffix, cursor, focus, or open action', async () => {
    const user = userEvent.setup()
    const onOpenCompletion = vi.fn()
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.console.complete') return completionResult()
      if (route === 'chemsmart_studio.console.prepare_file_drop') {
        return {
          replaceRange: { start: 21, end: 22 },
          item: {
            id: 'drop-water',
            label: 'water.xyz',
            insertText: 'water.xyz',
            kind: 'file',
            group: 'files',
            detail: 'Finder coordinate file',
            valueHint: 'path',
            appendSpace: true,
            contextRef: 'drop-water-context',
            openAction: 'molecule'
          }
        }
      }
      if (route === 'chemsmart_studio.console.accept_completion') {
        return { contextRef: 'drop-water-context', action: 'molecule', displayName: 'water.xyz' }
      }
      throw new Error(`Unexpected route: ${route}`)
    })
    render(<CommandConsole onOpenCompletion={onOpenCompletion} />)

    const input = screen.getByTestId('console-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'chemsmart run xtb -f  sp', selectionStart: 24 } })
    await user.click(input)
    await user.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}')
    await waitFor(() =>
      expect(ipcMocks.request).toHaveBeenLastCalledWith('chemsmart_studio.console.complete', {
        line: 'chemsmart run xtb -f  sp',
        cursor: 21,
        disclosure: 'primary'
      })
    )
    const file = new File(['coordinates'], 'water.xyz', { type: 'chemical/x-xyz' })
    fireEvent.drop(screen.getByTestId('command-console'), { dataTransfer: { files: [file], items: [] } })

    await waitFor(() => expect(input).toHaveValue('chemsmart run xtb -f water.xyz sp'))
    expect(ipcMocks.request).toHaveBeenCalledWith('chemsmart_studio.console.prepare_file_drop', {
      line: 'chemsmart run xtb -f  sp',
      cursor: 21,
      filePath: '/tmp/water.xyz'
    })
    expect(input.selectionStart).toBe(31)
    expect(input).toHaveFocus()
    await waitFor(() =>
      expect(onOpenCompletion).toHaveBeenCalledWith({
        contextRef: 'drop-water-context',
        action: 'molecule',
        displayName: 'water.xyz'
      })
    )
  })

  it('leaves the command unchanged for unsupported, directory, and multiple Finder drops', async () => {
    render(<CommandConsole />)
    const input = screen.getByTestId('console-input')
    const console = screen.getByTestId('command-console')
    fireEvent.change(input, { target: { value: 'chemsmart run xtb -f ', selectionStart: 21 } })

    fireEvent.drop(console, {
      dataTransfer: { files: [new File(['x'], 'notes.txt')], items: [] }
    })
    expect(input).toHaveValue('chemsmart run xtb -f ')
    expect(screen.getByTestId('console-drop-message')).toHaveTextContent('chemsmart_studio.console.drop_unsupported')

    fireEvent.drop(console, {
      dataTransfer: {
        files: [new File([], 'coordinates')],
        items: [{ webkitGetAsEntry: () => ({ isDirectory: true }) }]
      }
    })
    expect(input).toHaveValue('chemsmart run xtb -f ')
    expect(screen.getByTestId('console-drop-message')).toHaveTextContent('chemsmart_studio.console.drop_directory')

    fireEvent.drop(console, {
      dataTransfer: { files: [new File(['a'], 'a.xyz'), new File(['b'], 'b.sdf')], items: [] }
    })
    expect(input).toHaveValue('chemsmart run xtb -f ')
    expect(screen.getByTestId('console-drop-message')).toHaveTextContent('chemsmart_studio.console.drop_multiple')
    expect(ipcMocks.request.mock.calls.map(([route]) => route)).not.toContain(
      'chemsmart_studio.console.prepare_file_drop'
    )
  })

  it('leaves the command unchanged when main rejects a coordinate drop', async () => {
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.console.complete') return completionResult()
      if (route === 'chemsmart_studio.console.prepare_file_drop') throw new Error('not a regular supported file')
      throw new Error(`Unexpected route: ${route}`)
    })
    render(<CommandConsole />)

    const input = screen.getByTestId('console-input')
    fireEvent.change(input, { target: { value: 'chemsmart run xtb -f ', selectionStart: 21 } })
    fireEvent.drop(screen.getByTestId('command-console'), {
      dataTransfer: { files: [new File(['x'], 'water.xyz')], items: [] }
    })

    expect(await screen.findByTestId('console-drop-message')).toHaveTextContent('chemsmart_studio.console.drop_failed')
    expect(input).toHaveValue('chemsmart run xtb -f ')
  })

  it.each([
    ['wide', 1440, 900],
    ['focused', 1000, 700],
    ['compact', 760, 600]
  ])('keeps the completion overlay independent in the %s layout', async (_tier, width, height) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
    ipcMocks.request.mockResolvedValue(
      completionResult({ items: [candidate(`${_tier}-choice`)], replaceRange: { start: 0, end: 1 } })
    )
    render(<CommandConsole />)

    fireEvent.change(screen.getByTestId('console-input'), { target: { value: 'c', selectionStart: 1 } })
    const popover = await screen.findByTestId('console-completion-popover')

    expect(document.body).toContainElement(popover)
    expect(screen.getByTestId('command-console')).not.toContainElement(popover)
    expect(popover).toHaveClass('max-w-[calc(100vw-1.5rem)]')
  })
})
