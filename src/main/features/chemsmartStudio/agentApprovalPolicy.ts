/**
 * Which agent actions a session grant may cover, and which always ask.
 *
 * This is a table rather than conditionals scattered through the approval path so that the answer to
 * "what can Execute mode do without me?" is one file a reviewer can read end to end. Anything not
 * listed here is treated as always-ask: a tool added later is safe by omission rather than dangerous
 * by default.
 */

/** Agent modes, in the researcher's terms. */
export const agentModes = ['allow', 'execute'] as const
export type AgentMode = (typeof agentModes)[number]

/** Studio opens in Allow: the researcher decides once per action until they say otherwise. */
export const defaultAgentMode: AgentMode = 'allow'

export interface ApprovalPolicyEntry {
  /** True when Execute mode may pre-authorize this tool for the session. */
  grantable: boolean
  /**
   * Why. Shown to the researcher when the action is auto-approved, and the record a reviewer reads
   * when asking whether the classification is still right.
   */
  reason: string
}

/**
 * The classification.
 *
 * Starting a calculation is not grantable in any mode. It spends real compute — a Gaussian or ORCA
 * job is minutes to days of CPU, and on a cluster it is someone's allocation — and once submitted it
 * is not undone by publishing a revision. That is the line: reversible edits may be granted, spent
 * resources may not.
 *
 * The three trusted-control tools are listed for completeness. They never reach a grant check because
 * the approval path refuses them outright: cancelling a run, and accepting or rejecting a final
 * geometry, are the researcher's own controls and the agent may not ask for them at all.
 */
export const approvalPolicy: Readonly<Record<string, ApprovalPolicyEntry>> = {
  start_molecule_optimization: {
    grantable: false,
    reason: 'Starting a calculation spends compute that cannot be given back.'
  },
  start_prepared_optimization: {
    grantable: false,
    reason: 'Starting a calculation spends compute that cannot be given back.'
  },
  run_local: {
    grantable: false,
    reason: 'Running a local job spends compute and always requires an exact one-shot approval.'
  },
  submit_hpc: {
    grantable: false,
    reason: 'Submitting an HPC job spends a shared allocation and always requires an exact one-shot approval.'
  },
  execute_chemsmart_command: {
    grantable: false,
    reason: 'Executing a ChemSmart command can spend compute and always requires an exact one-shot approval.'
  },
  cancel_molecule_optimization: {
    grantable: false,
    reason: 'Cancelling a run is the researcher’s own control, never the agent’s.'
  },
  accept_optimization_geometry: {
    grantable: false,
    reason: 'Accepting a final geometry is the researcher’s own control, never the agent’s.'
  },
  reject_optimization_geometry: {
    grantable: false,
    reason: 'Rejecting a final geometry is the researcher’s own control, never the agent’s.'
  }
}

/**
 * Whether `mode` lets `tool` proceed without raising a card.
 *
 * Allow mode never grants — that is what makes it Allow. Execute mode grants only what the table
 * marks grantable, and an unknown tool is never granted, so adding a tool without classifying it
 * fails closed.
 */
export function isPreAuthorized(mode: AgentMode, tool: string): boolean {
  if (mode !== 'execute') return false
  return approvalPolicy[tool]?.grantable === true
}

/** The reason a tool is or is not grantable, for the researcher-visible record. */
export function approvalReason(tool: string): string {
  return approvalPolicy[tool]?.reason ?? 'This action has not been classified, so it always asks.'
}
