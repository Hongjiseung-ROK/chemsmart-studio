import { describe, expect, it } from 'vitest'

import {
  composeReplayRecord,
  composeReplayRecords,
  type LedgerReplayRecord,
  resolveOutcome
} from '../replayComposition'

function ledgerRecord(overrides: Partial<LedgerReplayRecord> = {}): LedgerReplayRecord {
  return {
    run: { runId: 'run-1' } as LedgerReplayRecord['run'],
    frameCount: 3,
    latestFrame: null,
    outcome: 'running',
    message: '',
    updatedAt: '2026-07-28T00:00:00Z',
    replayable: true,
    extensions: {},
    ...overrides
  }
}

const nothingRunning = { activeRunId: null, recoveredRunIds: new Set<string>() }

describe('resolveOutcome', () => {
  it('leaves a run that closed itself alone', () => {
    for (const outcome of ['accepted', 'rejected', 'cancelled', 'failed'] as const) {
      expect(resolveOutcome(ledgerRecord({ outcome }), nothingRunning)).toBe(outcome)
    }
  })

  it('keeps the run main is driving as running', () => {
    const runtime = { activeRunId: 'run-1', recoveredRunIds: new Set<string>() }

    expect(resolveOutcome(ledgerRecord(), runtime)).toBe('running')
  })

  it('calls an open ledger that nobody is driving interrupted', () => {
    // A crash leaves exactly the ledger a live run leaves. Without main's view this would show as
    // in progress forever.
    expect(resolveOutcome(ledgerRecord(), nothingRunning)).toBe('interrupted')
  })

  it('calls an open ledger interrupted while a different run is active', () => {
    const runtime = { activeRunId: 'run-2', recoveredRunIds: new Set<string>() }

    expect(resolveOutcome(ledgerRecord(), runtime)).toBe('interrupted')
  })
})

describe('composeReplayRecord', () => {
  it('marks only the run main is driving as active', () => {
    const runtime = { activeRunId: 'run-1', recoveredRunIds: new Set<string>() }

    expect(composeReplayRecord(ledgerRecord(), runtime).active).toBe(true)
    expect(composeReplayRecord(ledgerRecord({ run: { runId: 'run-9' } as never }), runtime).active).toBe(false)
  })

  it('reports a run main recovered as recovered', () => {
    const runtime = { activeRunId: null, recoveredRunIds: new Set(['run-1']) }

    expect(composeReplayRecord(ledgerRecord({ outcome: 'failed' }), runtime).recovered).toBe(true)
  })

  it('treats an interruption as a recovery in its own right', () => {
    // The run did not end on its own terms, so what is shown is its remains, not its result.
    expect(composeReplayRecord(ledgerRecord(), nothingRunning)).toMatchObject({
      outcome: 'interrupted',
      recovered: true
    })
  })

  it('does not call a cleanly finished run recovered', () => {
    expect(composeReplayRecord(ledgerRecord({ outcome: 'accepted' }), nothingRunning).recovered).toBe(false)
  })

  it('passes the ledger facts through untouched', () => {
    const record = ledgerRecord({ frameCount: 12, replayable: false, message: 'converged' })

    expect(composeReplayRecord(record, nothingRunning)).toMatchObject({
      frameCount: 12,
      replayable: false,
      message: 'converged',
      updatedAt: '2026-07-28T00:00:00Z'
    })
  })

  it('composes a whole page in order', () => {
    const runtime = { activeRunId: 'run-2', recoveredRunIds: new Set<string>() }
    const page = [
      ledgerRecord({ run: { runId: 'run-1' } as never, outcome: 'accepted' }),
      ledgerRecord({ run: { runId: 'run-2' } as never })
    ]

    expect(composeReplayRecords(page, runtime).map((entry) => [entry.run.runId, entry.outcome, entry.active])).toEqual([
      ['run-1', 'accepted', false],
      ['run-2', 'running', true]
    ])
  })
})
