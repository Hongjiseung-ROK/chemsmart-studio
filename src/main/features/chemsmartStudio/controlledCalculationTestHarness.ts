const HARNESS_NAME = 'controlled-calculation'
const E7_XTB_HARNESS_NAME = 'e7-xtb'
const MOLECULE_PREVIEW_HARNESS_NAME = 'molecule-preview'
let responseSequence = 0

export const controlledCalculationTestModelId = 'deterministic::controlled-calculation'
export const e7XtbTestModelId = 'deterministic::e7-xtb'
export const moleculePreviewTestModelId = 'deterministic::molecule-preview'

type HarnessMode = typeof HARNESS_NAME | typeof E7_XTB_HARNESS_NAME | typeof MOLECULE_PREVIEW_HARNESS_NAME

interface HarnessToolCall {
  id: string
  name: string
}

interface HarnessToolResult {
  call: HarnessToolCall
  result: Record<string, unknown> | null
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function lastToolResult(messages: unknown[]): HarnessToolResult | null {
  let call: HarnessToolCall | null = null
  for (const value of messages) {
    const message = objectValue(value)
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue
    for (const valueCall of message.tool_calls) {
      const candidate = objectValue(valueCall)
      const fn = objectValue(candidate?.function)
      if (typeof candidate?.id === 'string' && typeof fn?.name === 'string') {
        call = { id: candidate.id, name: fn.name }
      }
    }
  }
  if (!call) return null

  for (const value of messages.toReversed()) {
    const message = objectValue(value)
    if (message?.role !== 'tool' || message.tool_call_id !== call.id || typeof message.content !== 'string') continue
    try {
      return { call, result: objectValue(JSON.parse(message.content)) }
    } catch {
      return { call, result: null }
    }
  }
  return { call, result: null }
}

function toolResponse(name: string, argumentsValue: Record<string, unknown>, index: number): Record<string, unknown> {
  responseSequence += 1
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: `call-controlled-harness-${responseSequence}-${index}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(argumentsValue) }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 }
  }
}

function finalResponse(content: string): Record<string, unknown> {
  return {
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 }
  }
}

function exposedToolNames(tools: unknown[]): Set<string> {
  const names = new Set<string>()
  for (const value of tools) {
    const tool = objectValue(value)
    const fn = objectValue(tool?.function)
    if (typeof fn?.name === 'string') names.add(fn.name)
  }
  return names
}

function preparedStartBinding(messages: unknown[]): { plan_id: string; plan_digest: string } | null {
  for (const value of messages.toReversed()) {
    const message = objectValue(value)
    if (message?.role !== 'user') continue
    const content = Array.isArray(message.content)
      ? message.content
          .map((part) => objectValue(part)?.text)
          .filter((part): part is string => typeof part === 'string')
          .join('\n')
      : message.content
    if (typeof content !== 'string') continue
    const match = content.match(/\b(plan-[A-Za-z0-9-]+)\s+(sha256:[0-9a-f]{64})\b/)
    if (match) return { plan_id: match[1], plan_digest: match[2] }
  }
  return null
}

function preparedPreviewBinding(messages: unknown[]): { preview_id: string; expected_revision: number } | null {
  for (const value of messages.toReversed()) {
    const message = objectValue(value)
    if (message?.role !== 'user' || typeof message.content !== 'string') continue
    const match = message.content.match(/\b(preview-[A-Za-z0-9-]+)\b.{0,80}\b(?:revision|rev)\s*[:=#]?\s*(\d+)\b/i)
    if (!match) return null
    const expectedRevision = Number(match[2])
    return Number.isSafeInteger(expectedRevision) ? { preview_id: match[1], expected_revision: expectedRevision } : null
  }
  return null
}

function requiredString(value: Record<string, unknown>, key: string): string | null {
  const candidate = value[key]
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null
}

function requiredRevision(value: Record<string, unknown>, key: string): number | null {
  const candidate = value[key]
  return typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0 ? candidate : null
}

function isExpectedWaterAnalysis(value: Record<string, unknown>): boolean {
  if (
    value.type !== 'current_molecule_analysis' ||
    value.atomCount !== 3 ||
    value.bondCount !== 2 ||
    value.formula !== 'H2O' ||
    value.charge !== 0 ||
    value.multiplicity !== 1
  ) {
    return false
  }
  const counts = value.elementCounts
  return (
    Array.isArray(counts) &&
    JSON.stringify(counts) ===
      JSON.stringify([
        { atomicNumber: 1, count: 2 },
        { atomicNumber: 8, count: 1 }
      ])
  )
}

function waterPreviewPatch(value: Record<string, unknown>): Record<string, unknown> | null {
  if (!isExpectedWaterAnalysis(value)) return null
  const molecule = objectValue(value.molecule)
  if (!molecule || !Array.isArray(molecule.atoms)) return null
  const baseRevision = requiredRevision(molecule, 'revision')
  if (baseRevision === null) return null

  const hydrogen = molecule.atoms
    .map(objectValue)
    .filter(
      (atom): atom is Record<string, unknown> =>
        atom !== null &&
        atom.atomicNumber === 1 &&
        typeof atom.id === 'string' &&
        Array.isArray(atom.position) &&
        atom.position.length === 3 &&
        atom.position.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate))
    )
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))[0]
  if (!hydrogen) return null

  const position = hydrogen.position as [number, number, number]
  return {
    operationId: `operation-water-preview-r${baseRevision}`,
    baseRevision,
    actor: 'agent',
    previewOnly: true,
    operations: [
      {
        op: 'set_positions',
        positions: [
          {
            atomId: hydrogen.id,
            position: [position[0], position[1], Number((position[2] + 0.05).toFixed(8))]
          }
        ]
      }
    ],
    extensions: {}
  }
}

export function isControlledCalculationTestHarnessEnabled(isPackaged: boolean): boolean {
  return !isPackaged && process.env.CHEMSMART_STUDIO_TEST_HARNESS?.trim() === HARNESS_NAME
}

export function isE7XtbTestHarnessEnabled(isPackaged: boolean): boolean {
  return !isPackaged && process.env.CHEMSMART_STUDIO_TEST_HARNESS?.trim() === E7_XTB_HARNESS_NAME
}

export function isMoleculePreviewTestHarnessEnabled(isPackaged: boolean): boolean {
  return !isPackaged && process.env.CHEMSMART_STUDIO_TEST_HARNESS?.trim() === MOLECULE_PREVIEW_HARNESS_NAME
}

function testModelResponse(messages: unknown[], mode: HarnessMode, tools: unknown[]): Record<string, unknown> {
  const latest = lastToolResult(messages)
  const exposedTools = exposedToolNames(tools)
  const callIndex =
    messages.reduce<number>((count, value) => {
      const message = objectValue(value)
      return count + (message?.role === 'assistant' && Array.isArray(message.tool_calls) ? 1 : 0)
    }, 0) + 1

  if (!latest) {
    if (mode === MOLECULE_PREVIEW_HARNESS_NAME && exposedTools.has('commit_molecule_preview')) {
      const previewBinding = preparedPreviewBinding(messages)
      return previewBinding
        ? toolResponse('commit_molecule_preview', previewBinding, callIndex)
        : finalResponse('Commit requires the visible preview ID and base revision.')
    }
    const startBinding = preparedStartBinding(messages)
    if (startBinding && exposedTools.has('start_prepared_optimization')) {
      return toolResponse('start_prepared_optimization', startBinding, callIndex)
    }
    return toolResponse('analyze_current_molecule', {}, callIndex)
  }
  const result = latest.result
  if (!result) return finalResponse('The deterministic test harness received an invalid tool result.')

  if (latest.call.name === 'get_studio_context') {
    const document = objectValue(result.document)
    if (!document) return finalResponse('No committed molecule is available for the deterministic test harness.')
    const documentId = requiredString(document, 'documentId')
    const expectedRevision = requiredRevision(document, 'revision')
    const geometryHash = requiredString(document, 'geometryHash')
    if (!documentId || expectedRevision === null || !geometryHash) {
      return finalResponse('The deterministic test harness rejected an invalid molecule binding.')
    }
    if (mode !== HARNESS_NAME) {
      return toolResponse(
        'analyze_current_molecule',
        { expected_revision: expectedRevision, geometry_hash: geometryHash },
        callIndex
      )
    }
    return toolResponse(
      'prepare_molecule_optimization',
      {
        document_id: documentId,
        expected_revision: expectedRevision,
        geometry_hash: geometryHash,
        engine: 'xtb',
        method: 'GFN2-xTB',
        settings: {
          maxSteps: 10,
          maxRuntimeSeconds: 30,
          threads: 1,
          charge: 0,
          multiplicity: 1,
          extensions: {}
        }
      },
      callIndex
    )
  }

  if (latest.call.name === 'analyze_current_molecule') {
    const molecule = objectValue(result.molecule)
    const documentId = molecule ? requiredString(molecule, 'documentId') : null
    const expectedRevision = molecule ? requiredRevision(molecule, 'revision') : null
    const geometryHash = requiredString(result, 'geometryHash')
    if (
      (mode !== HARNESS_NAME && !isExpectedWaterAnalysis(result)) ||
      !documentId ||
      expectedRevision === null ||
      !geometryHash
    ) {
      return finalResponse(
        mode === HARNESS_NAME
          ? 'The deterministic test harness rejected an invalid current-molecule analysis.'
          : 'The E7 validation harness requires the checked-in three-atom neutral-singlet water fixture.'
      )
    }
    if (mode === MOLECULE_PREVIEW_HARNESS_NAME) {
      const patch = waterPreviewPatch(result)
      return patch
        ? toolResponse('preview_molecule_patch', { patch }, callIndex)
        : finalResponse('The molecule preview harness rejected invalid trusted atom coordinates.')
    }
    return toolResponse(
      'prepare_molecule_optimization',
      {
        document_id: documentId,
        expected_revision: expectedRevision,
        geometry_hash: geometryHash,
        engine: 'xtb',
        method: 'GFN2-xTB',
        settings: {
          maxSteps: mode === HARNESS_NAME ? 10 : 100,
          maxRuntimeSeconds: mode === HARNESS_NAME ? 30 : 120,
          threads: 1,
          charge: 0,
          multiplicity: 1,
          extensions: {}
        }
      },
      callIndex
    )
  }

  if (latest.call.name === 'prepare_molecule_optimization') {
    const planId = requiredString(result, 'planId')
    const planDigest = requiredString(result, 'planDigest')
    if (!planId || !planDigest || result.state !== 'prepared') {
      return finalResponse('The deterministic test harness rejected an invalid prepared plan.')
    }
    return toolResponse('validate_prepared_optimization', { plan_id: planId, plan_digest: planDigest }, callIndex)
  }

  if (latest.call.name === 'validate_prepared_optimization') {
    const planId = requiredString(result, 'planId')
    const planDigest = requiredString(result, 'planDigest')
    if (!planId || !planDigest || result.state !== 'validated') {
      return finalResponse('The deterministic test harness rejected an invalid validated plan.')
    }
    if (!exposedTools.has('start_prepared_optimization')) {
      const message =
        mode === E7_XTB_HARNESS_NAME
          ? 'The bounded GFN2-xTB validation plan is validated and awaiting separate start approval.'
          : 'The deterministic controlled calculation plan is validated and awaiting separate start approval.'
      return finalResponse(message)
    }
    return toolResponse('start_prepared_optimization', { plan_id: planId, plan_digest: planDigest }, callIndex)
  }

  if (latest.call.name === 'start_prepared_optimization') {
    return result.type === 'controlled_calculation_reservation'
      ? finalResponse(
          mode === E7_XTB_HARNESS_NAME
            ? 'The bounded GFN2-xTB validation calculation was approved and started.'
            : 'The deterministic controlled calculation was approved and started.'
        )
      : finalResponse('The deterministic controlled calculation was denied; no calculation started.')
  }

  if (latest.call.name === 'start_molecule_optimization') {
    return finalResponse('Direct legacy optimization starts are unsupported.')
  }

  if (latest.call.name === 'preview_molecule_patch') {
    const previewId = requiredString(result, 'previewId')
    const baseRevision = requiredRevision(result, 'baseRevision')
    return previewId && baseRevision !== null
      ? finalResponse(
          `The molecule preview is ready. To request the trusted decision card, submit: Commit preview ${previewId} revision ${baseRevision}.`
        )
      : finalResponse('The deterministic molecule preview harness rejected an invalid preview receipt.')
  }

  if (latest.call.name === 'commit_molecule_preview') {
    return requiredString(result, 'previewId') && requiredRevision(result, 'revision') !== null
      ? finalResponse('The approved molecule preview was committed at the verified revision.')
      : finalResponse('The molecule preview was discarded or denied; the committed molecule was not changed.')
  }

  return finalResponse('The deterministic test harness stopped after an unexpected tool result.')
}

export function controlledCalculationTestModelResponse(
  messages: unknown[],
  tools: unknown[] = []
): Record<string, unknown> {
  return testModelResponse(messages, HARNESS_NAME, tools)
}

export function e7XtbTestModelResponse(messages: unknown[], tools: unknown[] = []): Record<string, unknown> {
  return testModelResponse(messages, E7_XTB_HARNESS_NAME, tools)
}

export function moleculePreviewTestModelResponse(messages: unknown[], tools: unknown[] = []): Record<string, unknown> {
  return testModelResponse(messages, MOLECULE_PREVIEW_HARNESS_NAME, tools)
}
