import type * as CherryStudioUi from '@cherrystudio/ui'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@cherrystudio/ui', async (importOriginal) => importOriginal<typeof CherryStudioUi>())
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key })
}))

import { AgentModeSwitch } from '../AgentModeSwitch'

describe('AgentModeSwitch', () => {
  it('shows which mode the session is in', () => {
    render(<AgentModeSwitch disabled={false} mode="allow" onChange={vi.fn()} />)

    expect(screen.getByRole('radio', { name: /chemsmart_studio.agent_mode.allow/ })).toBeChecked()
    expect(screen.getByRole('radio', { name: /chemsmart_studio.agent_mode.execute/ })).not.toBeChecked()
  })

  it('names the mode the researcher chose', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<AgentModeSwitch disabled={false} mode="allow" onChange={onChange} />)

    await user.click(screen.getByRole('radio', { name: /chemsmart_studio.agent_mode.execute/ }))

    expect(onChange).toHaveBeenCalledWith('execute')
  })

  it('does not switch while a switch is in flight', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<AgentModeSwitch disabled mode="allow" onChange={onChange} />)

    await user.click(screen.getByRole('radio', { name: /chemsmart_studio.agent_mode.execute/ }))

    expect(onChange).not.toHaveBeenCalled()
  })
})
