import { describe, expect, it } from 'vitest'

import { approvalPolicy, approvalReason, defaultAgentMode, isPreAuthorized } from '../agentApprovalPolicy'

describe('agentApprovalPolicy', () => {
  it('opens in the mode that asks', () => {
    expect(defaultAgentMode).toBe('allow')
  })

  it('never grants in Allow mode, whatever the tool', () => {
    for (const tool of Object.keys(approvalPolicy)) {
      expect(isPreAuthorized('allow', tool)).toBe(false)
    }
  })

  it('does not classify draft append compatibility as an approval action', () => {
    expect(approvalPolicy).not.toHaveProperty('commit_molecule_preview')
    expect(isPreAuthorized('execute', 'commit_molecule_preview')).toBe(false)
  })

  it('never grants starting a calculation, in any mode', () => {
    // Compute spent is not given back by publishing a revision — this is the line the table draws.
    for (const mode of ['allow', 'execute'] as const) {
      expect(isPreAuthorized(mode, 'start_molecule_optimization')).toBe(false)
      expect(isPreAuthorized(mode, 'start_prepared_optimization')).toBe(false)
      expect(isPreAuthorized(mode, 'run_local')).toBe(false)
      expect(isPreAuthorized(mode, 'submit_hpc')).toBe(false)
      expect(isPreAuthorized(mode, 'execute_chemsmart_command')).toBe(false)
    }
  })

  it('never grants the researcher’s own controls', () => {
    for (const tool of [
      'cancel_molecule_optimization',
      'accept_optimization_geometry',
      'reject_optimization_geometry'
    ]) {
      expect(isPreAuthorized('execute', tool)).toBe(false)
    }
  })

  it('fails closed for a tool nobody classified', () => {
    // A tool added later must be safe by omission rather than dangerous by default.
    expect(isPreAuthorized('execute', 'future_execution_tool')).toBe(false)
    expect(approvalReason('future_execution_tool')).toContain('always asks')
  })

  it('documents exact one-shot approval for every generic execution tool', () => {
    for (const tool of ['run_local', 'submit_hpc', 'execute_chemsmart_command']) {
      expect(approvalPolicy[tool].grantable).toBe(false)
      expect(approvalReason(tool)).toContain('exact one-shot approval')
    }
  })

  it('states a reason for every classification it makes', () => {
    for (const [tool, entry] of Object.entries(approvalPolicy)) {
      expect(entry.reason, tool).not.toBe('')
      expect(approvalReason(tool)).toBe(entry.reason)
    }
  })

  it('does not session-grant any action', () => {
    const grantable = Object.entries(approvalPolicy)
      .filter(([, entry]) => entry.grantable)
      .map(([tool]) => tool)
    expect(grantable).toEqual([])
  })
})
