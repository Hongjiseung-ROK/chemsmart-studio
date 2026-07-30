import type { HistoricalProjectManifestV1, ProjectManifest, StableId } from './generated'

export interface HistoricalRunV1 {
  runId: StableId
  engine: 'avogadro' | 'xtb' | 'gaussian' | 'orca'
  method: string
}

export interface HistoricalRunDisposition {
  inspectable: true
  resumable: boolean
  replayExecutionAllowed: boolean
  newOutputAllowed: boolean
  reason: 'historical_avogadro_unsupported' | 'historical_run_read_only'
}

export interface NormalizedHistoricalProject {
  manifest: ProjectManifest
  sourceProtocolVersion: '1.0.0'
  upgradeRequired: true
}

export function isHistoricalProjectManifestV1(value: unknown): value is HistoricalProjectManifestV1 {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<HistoricalProjectManifestV1>
  return (
    candidate.schemaVersion === '1.0.0' &&
    candidate.protocolVersion === '1.0.0' &&
    typeof candidate.documentId === 'string' &&
    Number.isInteger(candidate.currentRevision) &&
    candidate.currentRevision! >= 0 &&
    (candidate.activeRunId === null || typeof candidate.activeRunId === 'string') &&
    !!candidate.extensions &&
    typeof candidate.extensions === 'object'
  )
}

/**
 * Normalizes a historical bundle in memory only. The project store must journal
 * and persist this manifest together with the first successful v2 mutation.
 */
export function normalizeHistoricalProjectManifest(manifest: HistoricalProjectManifestV1): NormalizedHistoricalProject {
  return {
    manifest: {
      ...manifest,
      schemaVersion: '2.0.0',
      protocolVersion: '2.0.0'
    },
    sourceProtocolVersion: '1.0.0',
    upgradeRequired: true
  }
}

export function classifyHistoricalRun(run: HistoricalRunV1): HistoricalRunDisposition {
  if (run.engine === 'avogadro') {
    return {
      inspectable: true,
      resumable: false,
      replayExecutionAllowed: false,
      newOutputAllowed: false,
      reason: 'historical_avogadro_unsupported'
    }
  }
  return {
    inspectable: true,
    resumable: false,
    replayExecutionAllowed: false,
    newOutputAllowed: false,
    reason: 'historical_run_read_only'
  }
}
