import { describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({ loggerService: { withContext: () => ({ error: vi.fn(), warn: vi.fn() }) } }))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request: vi.fn() }, useIpcOn: vi.fn() }))

import { isRunnable, readSynthesis, type SynthesisOutcome } from '../useHarnessWorkbench'

const readyPayload = {
  schemaVersion: '1' as const,
  synthesisId: 'synthesis-1',
  sessionId: 'session-1',
  command: 'chemsmart run xtb -f ethanol.xyz -c 0 -m 1 opt',
  commandDigest: '0'.repeat(64),
  explanation: 'Optimises the registered structure.',
  intent: { verdict: 'ok' as const, failedRuleIds: [], message: 'Intent gate passed.', extensions: {} },
  missingInfo: [],
  projectName: null,
  publicEvidence: [
    {
      evidenceId: 'evidence-intent-1',
      kind: 'intentGate' as const,
      verdict: 'ok' as const,
      summary: 'Intent gate passed.',
      ruleIds: [],
      extensions: {}
    }
  ],
  semantic: { verdict: 'ok' as const, failedRuleIds: [], message: 'Semantic gate passed.', extensions: {} },
  status: 'ready' as const,
  executionPerformed: false as const,
  approvalRequiredForExecution: true as const,
  extensions: {}
}

describe('readSynthesis', () => {
  it('keeps the two gate verdicts and public evidence distinct', () => {
    const outcome = readSynthesis(readyPayload)

    expect(outcome.semantic).toEqual({ verdict: 'ok', failedRuleIds: [] })
    expect(outcome.intent).toEqual({ verdict: 'ok', failedRuleIds: [] })
    expect(outcome.command).toBe(readyPayload.command)
    expect(outcome.project).toBe('')
    expect(outcome.reasoning).toBe('Intent gate passed.')
  })

  it('carries the failed rule ids a closed result reports', () => {
    const outcome = readSynthesis({
      ...readyPayload,
      status: 'intentRejected',
      commandDigest: null,
      intent: {
        verdict: 'reject',
        failedRuleIds: ['intent.charge', 'intent.kind'],
        message: 'Intent gate rejected two rules.',
        extensions: {}
      }
    })

    expect(outcome.intent?.failedRuleIds).toEqual(['intent.charge', 'intent.kind'])
  })
})

describe('isRunnable', () => {
  const outcome = readSynthesis(readyPayload)

  it('accepts only the exact ready, non-empty, two-gate green case', () => {
    expect(isRunnable(outcome)).toBe(true)
  })

  it('keeps warning verdicts visible but refuses to run them', () => {
    expect(isRunnable({ ...outcome, intent: { verdict: 'warn', failedRuleIds: ['intent.review'] } })).toBe(false)
    expect(isRunnable({ ...outcome, semantic: { verdict: 'warn', failedRuleIds: ['cmd.semantic.review'] } })).toBe(
      false
    )
  })

  it('refuses a command that runs but no longer matches the request', () => {
    const drifted: SynthesisOutcome = {
      ...outcome,
      status: 'intentRejected',
      intent: { verdict: 'reject', failedRuleIds: ['intent.charge'] }
    }

    expect(drifted.semantic?.verdict).toBe('ok')
    expect(isRunnable(drifted)).toBe(false)
  })

  it('refuses rejected, unavailable, missing, or non-ready evidence', () => {
    expect(isRunnable({ ...outcome, semantic: { verdict: 'reject', failedRuleIds: ['cmd.semantic.project'] } })).toBe(
      false
    )
    expect(isRunnable({ ...outcome, intent: { verdict: 'unavailable', failedRuleIds: [] } })).toBe(false)
    expect(isRunnable({ ...outcome, semantic: null })).toBe(false)
    expect(isRunnable({ ...outcome, status: 'needsClarification' })).toBe(false)
  })

  it('refuses empty and whitespace-only commands', () => {
    expect(isRunnable({ ...outcome, command: '' })).toBe(false)
    expect(isRunnable({ ...outcome, command: ' \t\n ' })).toBe(false)
  })
})
