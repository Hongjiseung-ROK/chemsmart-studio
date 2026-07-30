import type * as CherryStudioUi from '@cherrystudio/ui'
import { act, render, screen, waitFor } from '@testing-library/react'
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

describe('CommandConsole', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ipcMocks.listeners.clear()
    cacheMocks.history = []
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.console.complete') {
        return { commandPath: ['chemsmart'], replaceRange: { start: 0, end: 0 }, items: [] }
      }
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
        command: 'chemsmart run gaussian opt'
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
              detail: 'Multiplicity of the molecule.',
              appendSpace: true
            }
          ]
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
              detail: 'Run a Gaussian calculation.',
              appendSpace: true
            }
          ]
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
            detail: `${label} command`,
            appendSpace: true
          }))
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
})
