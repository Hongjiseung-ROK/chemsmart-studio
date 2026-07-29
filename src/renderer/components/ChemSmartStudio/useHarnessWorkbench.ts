import { loggerService } from '@logger'
import { ipcApi } from '@renderer/ipc'
import type { UniqueModelId } from '@shared/data/types/model'
import type {
  ChemSmartStudioCommandSynthesisResult,
  ChemSmartStudioProjectCheckResult,
  ChemSmartStudioProjectList,
  ChemSmartStudioProjectProgram,
  ChemSmartStudioProjectReadResult
} from '@shared/ipc/schemas/chemsmartStudio'
import { useCallback, useEffect, useState } from 'react'

const logger = loggerService.withContext('useHarnessWorkbench')

/** What the harness decided, split the way the harness itself splits it. */
export interface GateVerdict {
  /** `ok` | `warn` | `reject`, straight from the gate. */
  verdict: string
  failedRuleIds: readonly string[]
}

export interface SynthesisOutcome {
  /** The chemsmart CLI command, empty until the harness is willing to produce one. */
  command: string
  explanation: string
  /** `ready`, `needs_clarification`, `intent_reject`, `infeasible`, … */
  status: string
  /** Runtime-owned project the command was resolved against, if any. */
  project: string
  missingInfo: readonly string[]
  /** "Does this command run?" */
  semantic: GateVerdict | null
  /** "Does it still do what was asked?" — the gate that catches a valid command that drifted. */
  intent: GateVerdict | null
  /** Auditable evidence trail, never the provider's private reasoning. */
  reasoning: string
}

/** Project the already schema-validated public contract into the panel view model. */
export function readSynthesis(result: ChemSmartStudioCommandSynthesisResult): SynthesisOutcome {
  return {
    command: result.command,
    explanation: result.explanation,
    intent: { failedRuleIds: result.intent.failedRuleIds, verdict: result.intent.verdict },
    missingInfo: result.missingInfo,
    project: result.projectName ?? '',
    reasoning: result.publicEvidence.map((item) => item.summary).join('\n'),
    semantic: { failedRuleIds: result.semantic.failedRuleIds, verdict: result.semantic.verdict },
    status: result.status
  }
}

/**
 * A command may only be presented as runnable after an exact green result from the harness. Warning and
 * unknown verdicts remain visible to the researcher, but neither authorizes execution.
 */
export function isRunnable(outcome: SynthesisOutcome): boolean {
  return (
    outcome.status === 'ready' &&
    outcome.command.trim().length > 0 &&
    outcome.intent?.verdict === 'ok' &&
    outcome.semantic?.verdict === 'ok'
  )
}

interface ProjectWorkspaceState {
  list: ChemSmartStudioProjectList | null
  detail: ChemSmartStudioProjectReadResult | null
  failed: boolean
  loading: boolean
}

/** The researcher's own view of the workspace's method projects — no model decides anything here. */
export function useProjectWorkspace(enabled: boolean) {
  const [state, setState] = useState<ProjectWorkspaceState>({
    detail: null,
    failed: false,
    list: null,
    loading: false
  })

  const refresh = useCallback(async () => {
    setState((current) => ({ ...current, failed: false, loading: true }))
    try {
      const list = await ipcApi.request('chemsmart_studio.project.list', { extensions: {} })
      setState((current) => ({ ...current, list, loading: false }))
    } catch (error) {
      setState((current) => ({ ...current, failed: true, loading: false }))
      logger.error('Failed to list workspace projects', error as Error)
    }
  }, [])

  const read = useCallback(async (project: string, program: ChemSmartStudioProjectProgram) => {
    setState((current) => ({ ...current, failed: false, loading: true }))
    try {
      const detail = await ipcApi.request('chemsmart_studio.project.read', {
        extensions: {},
        program,
        projectName: project
      })
      setState((current) => ({ ...current, detail, loading: false }))
    } catch (error) {
      setState((current) => ({ ...current, detail: null, failed: true, loading: false }))
      logger.error('Failed to read a workspace project', error as Error)
    }
  }, [])

  useEffect(() => {
    if (enabled) void refresh()
  }, [enabled, refresh])

  return { ...state, read, refresh }
}

export interface ProjectCheck {
  /** `ok` | `warn` | `reject` from the project validator. */
  verdict: string
  issues: readonly { ruleId: string; severity: string; message: string }[]
}

/** Project a schema-validated validation or critique result for the UI. */
export function readProjectCheck(result: ChemSmartStudioProjectCheckResult): ProjectCheck {
  return {
    issues: result.issues,
    verdict: result.verdict
  }
}

/** Validate and critique a draft. Persisting it requires a separate trusted-action contract. */
export function useProjectAuthoring(program: ChemSmartStudioProjectProgram) {
  const [check, setCheck] = useState<ProjectCheck | null>(null)
  const [critique, setCritique] = useState<ProjectCheck | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const run = useCallback(async <Result>(work: () => Promise<Result>, apply: (result: Result) => void) => {
    setBusy(true)
    setFailed(false)
    try {
      apply(await work())
    } catch (error) {
      setFailed(true)
      logger.error('A project authoring step failed', error as Error)
    } finally {
      setBusy(false)
    }
  }, [])

  const validate = useCallback(
    (project: string, yaml: string) =>
      run(
        () =>
          ipcApi.request('chemsmart_studio.project.validate', {
            extensions: {},
            program,
            projectName: project,
            yamlText: yaml
          }),
        (result) => {
          setCheck(readProjectCheck(result))
        }
      ),
    [program, run]
  )

  const criticise = useCallback(
    (project: string, yaml: string) =>
      run(
        () =>
          ipcApi.request('chemsmart_studio.project.critic', {
            extensions: {},
            program,
            projectName: project,
            yamlText: yaml
          }),
        (result) => setCritique(readProjectCheck(result))
      ),
    [program, run]
  )

  const reset = useCallback(() => {
    setCheck(null)
    setCritique(null)
    setFailed(false)
  }, [])

  return { busy, check, criticise, critique, failed, reset, validate }
}

/** Turns a request into a chemsmart command through the harness, and keeps both gate verdicts. */
export function useCommandSynthesis(sessionId: string, modelId: UniqueModelId | null) {
  const [outcome, setOutcome] = useState<SynthesisOutcome | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const synthesize = useCallback(
    async (request: string) => {
      const trimmed = request.trim()
      if (!trimmed || !modelId || busy) return

      setBusy(true)
      setFailed(false)
      try {
        const result = await ipcApi.request('chemsmart_studio.command.synthesize', {
          extensions: {},
          modelId,
          request: trimmed,
          sessionId
        })
        setOutcome(readSynthesis(result))
      } catch (error) {
        setOutcome(null)
        setFailed(true)
        logger.error('Failed to synthesize a chemsmart command', error as Error)
      } finally {
        setBusy(false)
      }
      // Rebind while busy so a re-rendered caller cannot reuse a stale callback and submit twice.
    },
    [busy, modelId, sessionId]
  )

  const reset = useCallback(() => {
    setOutcome(null)
    setFailed(false)
  }, [])

  return { busy, failed, outcome, reset, synthesize }
}
