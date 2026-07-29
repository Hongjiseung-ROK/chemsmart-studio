import type { OptimizationReplayRecord } from '@chemsmart/studio-protocol'

/**
 * Completes a catalog record the trajectory store could only half answer.
 *
 * The ledger is a file. It knows what was recorded — the run, its frames, how it ended if it ended,
 * and whether it kept the input geometry its frames are displacements from. It cannot know what is
 * happening now, and it must not guess: a run that crashed leaves exactly the same ledger as one
 * still going, so inferring liveness from a missing terminal event would show every crashed run as
 * in progress forever.
 *
 * Main knows the difference, so main supplies it here.
 */

/** What the store returns: everything derivable from the ledger alone. */
export interface LedgerReplayRecord {
  run: OptimizationReplayRecord['run']
  frameCount: number
  latestFrame: OptimizationReplayRecord['latestFrame']
  outcome: OptimizationReplayRecord['outcome']
  message: string
  updatedAt: string
  replayable: boolean
  extensions: OptimizationReplayRecord['extensions']
}

/** A page of ledger records, before main completes them. Mirrors `ledgerCatalogResponse`. */
export interface LedgerReplayCatalog {
  totalRuns: number
  runs: LedgerReplayRecord[]
  nextRunId: string | null
  extensions: OptimizationReplayRecord['extensions']
}

export interface ReplayRuntimeState {
  /** The run main is currently driving, or null when nothing is running. */
  activeRunId: string | null
  /** Runs main recovered after a restart or a helper crash. */
  recoveredRunIds: ReadonlySet<string>
}

/**
 * A ledger with no terminal event says `running`. That is true of the file and not necessarily of
 * the world: only the run main is actually driving is still running, and any other open ledger
 * belongs to a run that was interrupted before it could close itself.
 */
export function resolveOutcome(
  record: Pick<LedgerReplayRecord, 'outcome' | 'run'>,
  runtime: ReplayRuntimeState
): OptimizationReplayRecord['outcome'] {
  if (record.outcome !== 'running') return record.outcome
  return record.run.runId === runtime.activeRunId ? 'running' : 'interrupted'
}

export function composeReplayRecord(record: LedgerReplayRecord, runtime: ReplayRuntimeState): OptimizationReplayRecord {
  const outcome = resolveOutcome(record, runtime)
  return {
    ...record,
    outcome,
    active: record.run.runId === runtime.activeRunId,
    // An interruption main had to notice is itself a recovery: the run did not end on its own terms,
    // and the researcher is being shown its remains rather than its result.
    recovered: runtime.recoveredRunIds.has(record.run.runId) || outcome === 'interrupted'
  }
}

export function composeReplayRecords(
  records: readonly LedgerReplayRecord[],
  runtime: ReplayRuntimeState
): OptimizationReplayRecord[] {
  return records.map((record) => composeReplayRecord(record, runtime))
}
