import { afterEach, describe, expect, it } from 'vitest'

import {
  controlledCalculationTestModelResponse,
  e7XtbTestModelResponse,
  isControlledCalculationTestHarnessEnabled,
  isE7XtbTestHarnessEnabled,
  isMoleculePreviewTestHarnessEnabled,
  moleculePreviewTestModelResponse
} from '../controlledCalculationTestHarness'

function responseToolCall(response: Record<string, unknown>) {
  return (
    response.choices as Array<{
      message: { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }
    }>
  )[0].message.tool_calls?.[0]
}

function messagesAfter(
  previous: unknown[],
  response: Record<string, unknown>,
  toolResult: Record<string, unknown>
): unknown[] {
  const call = (
    response.choices as Array<{
      message: { role: string; content: string; tool_calls: Array<{ id: string }> }
    }>
  )[0].message
  return [...previous, call, { role: 'tool', tool_call_id: call.tool_calls[0].id, content: JSON.stringify(toolResult) }]
}

function waterAnalysis(documentId = 'water', revision = 0) {
  return {
    type: 'current_molecule_analysis',
    molecule: {
      documentId,
      revision,
      atoms: [
        {
          id: 'atom-o',
          atomicNumber: 8,
          position: [0, 0, 0],
          formalCharge: 0,
          extensions: {}
        },
        {
          id: 'atom-h-b',
          atomicNumber: 1,
          position: [0.75716, 0, 0.58626],
          formalCharge: 0,
          extensions: {}
        },
        {
          id: 'atom-h-a',
          atomicNumber: 1,
          position: [-0.75716, 0, 0.58626],
          formalCharge: 0,
          extensions: {}
        }
      ],
      bonds: [],
      selections: [],
      frozenAxes: {},
      constraints: [],
      properties: { charge: 0, multiplicity: 1, extensions: {} },
      extensions: {}
    },
    geometryHash: `sha256:${'a'.repeat(64)}`,
    atomCount: 3,
    bondCount: 2,
    elementCounts: [
      { atomicNumber: 1, count: 2 },
      { atomicNumber: 8, count: 1 }
    ],
    formula: 'H2O',
    charge: 0,
    multiplicity: 1,
    extensions: {}
  }
}

const startPreparedTool = [{ type: 'function', function: { name: 'start_prepared_optimization' } }]
const commitPreviewTool = [{ type: 'function', function: { name: 'commit_molecule_preview' } }]

describe('controlled calculation test harness', () => {
  afterEach(() => {
    delete process.env.CHEMSMART_STUDIO_TEST_HARNESS
  })

  it('is explicit and unavailable to a packaged application', () => {
    process.env.CHEMSMART_STUDIO_TEST_HARNESS = 'controlled-calculation'
    expect(isControlledCalculationTestHarnessEnabled(false)).toBe(true)
    expect(isControlledCalculationTestHarnessEnabled(true)).toBe(false)

    process.env.CHEMSMART_STUDIO_TEST_HARNESS = 'other'
    expect(isControlledCalculationTestHarnessEnabled(false)).toBe(false)

    process.env.CHEMSMART_STUDIO_TEST_HARNESS = 'e7-xtb'
    expect(isE7XtbTestHarnessEnabled(false)).toBe(true)
    expect(isE7XtbTestHarnessEnabled(true)).toBe(false)

    process.env.CHEMSMART_STUDIO_TEST_HARNESS = 'molecule-preview'
    expect(isMoleculePreviewTestHarnessEnabled(false)).toBe(true)
    expect(isMoleculePreviewTestHarnessEnabled(true)).toBe(false)
  })

  it('derives each call from the immediately preceding trusted result', () => {
    const initial: unknown[] = [{ role: 'user', content: 'Run the controlled test.' }]
    const analysisCall = controlledCalculationTestModelResponse(initial)
    expect(responseToolCall(analysisCall)?.function).toEqual({
      name: 'analyze_current_molecule',
      arguments: '{}'
    })

    const analysisMessages = messagesAfter(initial, analysisCall, waterAnalysis('mol-water', 3))
    const prepareCall = controlledCalculationTestModelResponse(analysisMessages)
    expect(responseToolCall(prepareCall)?.function).toEqual({
      name: 'prepare_molecule_optimization',
      arguments: JSON.stringify({
        document_id: 'mol-water',
        expected_revision: 3,
        geometry_hash: `sha256:${'a'.repeat(64)}`,
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
      })
    })

    const prepareMessages = messagesAfter(analysisMessages, prepareCall, {
      type: 'prepared_controlled_calculation',
      planId: 'plan-1',
      planDigest: `sha256:${'b'.repeat(64)}`,
      state: 'prepared'
    })
    const validateCall = controlledCalculationTestModelResponse(prepareMessages)
    expect(responseToolCall(validateCall)?.function.name).toBe('validate_prepared_optimization')

    const validateMessages = messagesAfter(prepareMessages, validateCall, {
      type: 'prepared_controlled_calculation',
      planId: 'plan-1',
      planDigest: `sha256:${'b'.repeat(64)}`,
      state: 'validated'
    })
    const startCall = controlledCalculationTestModelResponse(validateMessages, startPreparedTool)
    expect(responseToolCall(startCall)?.function.name).toBe('start_prepared_optimization')
  })

  it('pauses a validated plan until the separate start phase exposes its tool', () => {
    const validateCall = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call-controlled-harness-validate',
                type: 'function',
                function: {
                  name: 'validate_prepared_optimization',
                  arguments: JSON.stringify({ plan_id: 'plan-1', plan_digest: `sha256:${'b'.repeat(64)}` })
                }
              }
            ]
          }
        }
      ]
    }
    const messages = messagesAfter([], validateCall, {
      type: 'prepared_controlled_calculation',
      planId: 'plan-1',
      planDigest: `sha256:${'b'.repeat(64)}`,
      state: 'validated'
    })

    const paused = e7XtbTestModelResponse(messages)
    expect(responseToolCall(paused)?.function.name).toBe('report_studio_result')
    expect(JSON.stringify(paused)).toContain('awaiting separate start approval')
    expect(responseToolCall(e7XtbTestModelResponse(messages, startPreparedTool))?.function.name).toBe(
      'start_prepared_optimization'
    )
    expect(
      responseToolCall(
        e7XtbTestModelResponse(
          [
            {
              role: 'user',
              content: `Start the validated controlled plan plan-1 sha256:${'b'.repeat(64)}.`
            }
          ],
          startPreparedTool
        )
      )?.function
    ).toEqual({
      name: 'start_prepared_optimization',
      arguments: JSON.stringify({ plan_id: 'plan-1', plan_digest: `sha256:${'b'.repeat(64)}` })
    })
  })

  it('never reuses provider call IDs across repeated turns', () => {
    const messages: unknown[] = [{ role: 'user', content: 'Run the controlled test.' }]
    const firstId = responseToolCall(controlledCalculationTestModelResponse(messages))?.id
    const secondId = responseToolCall(controlledCalculationTestModelResponse(messages))?.id

    expect(firstId).toMatch(/^call-controlled-harness-/)
    expect(secondId).toMatch(/^call-controlled-harness-/)
    expect(secondId).not.toBe(firstId)
  })

  it('binds the E7 xTB request to one thread and a bounded runtime', () => {
    const initial: unknown[] = [{ role: 'user', content: 'Run the bounded xTB proof.' }]
    const analysisCall = e7XtbTestModelResponse(initial)
    expect(responseToolCall(analysisCall)?.function).toEqual({
      name: 'analyze_current_molecule',
      arguments: '{}'
    })
    const analysisMessages = messagesAfter(initial, analysisCall, waterAnalysis())

    expect(responseToolCall(e7XtbTestModelResponse(analysisMessages))?.function).toEqual({
      name: 'prepare_molecule_optimization',
      arguments: JSON.stringify({
        document_id: 'water',
        expected_revision: 0,
        geometry_hash: `sha256:${'a'.repeat(64)}`,
        engine: 'xtb',
        method: 'GFN2-xTB',
        settings: {
          maxSteps: 100,
          maxRuntimeSeconds: 120,
          threads: 1,
          charge: 0,
          multiplicity: 1,
          extensions: {}
        }
      })
    })
  })

  it('builds a deterministic preview from trusted water coordinates without committing', () => {
    const initial: unknown[] = [{ role: 'user', content: 'Preview a bounded water edit.' }]
    const analysisCall = moleculePreviewTestModelResponse(initial)
    expect(responseToolCall(analysisCall)?.function).toEqual({
      name: 'analyze_current_molecule',
      arguments: '{}'
    })

    const previewCall = moleculePreviewTestModelResponse(
      messagesAfter(initial, analysisCall, waterAnalysis('water', 4))
    )
    expect(responseToolCall(previewCall)?.function).toEqual({
      name: 'preview_molecule_patch',
      arguments: JSON.stringify({
        patch: {
          operationId: 'operation-water-preview-r4',
          baseRevision: 4,
          actor: 'agent',
          previewOnly: true,
          operations: [
            {
              op: 'set_positions',
              positions: [{ atomId: 'atom-h-a', position: [-0.75716, 0, 0.63626] }]
            }
          ],
          extensions: {}
        }
      })
    })
  })

  it('requires an exact visible preview binding before requesting trusted commit approval', () => {
    const missing = moleculePreviewTestModelResponse(
      [{ role: 'user', content: 'Commit the preview.' }],
      commitPreviewTool
    )
    expect(responseToolCall(missing)).toBeUndefined()
    expect(JSON.stringify(missing)).toContain('requires the visible preview ID and base revision')

    const response = moleculePreviewTestModelResponse(
      [{ role: 'user', content: 'Commit preview preview-123e4567-e89b-12d3-a456-426614174000 revision 4.' }],
      commitPreviewTool
    )
    expect(responseToolCall(response)?.function).toEqual({
      name: 'commit_molecule_preview',
      arguments: JSON.stringify({
        preview_id: 'preview-123e4567-e89b-12d3-a456-426614174000',
        expected_revision: 4
      })
    })
  })

  it('ends the preview path without retrying when the trusted decision is denied', () => {
    const commitCall = moleculePreviewTestModelResponse(
      [{ role: 'user', content: 'Commit preview preview-1 revision 4.' }],
      commitPreviewTool
    )
    const response = moleculePreviewTestModelResponse(
      messagesAfter([], commitCall, {
        ok: false,
        error: { type: 'PermissionDenied', message: 'Denied', tool: 'commit_molecule_preview' }
      })
    )

    expect(responseToolCall(response)?.function.name).toBe('report_studio_result')
    expect(JSON.stringify(response)).toContain('discarded or denied')
  })

  it('refuses E7 execution when the trusted molecule analysis is not the three-atom water fixture', () => {
    const analysisCall = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call-e7-analysis',
                type: 'function',
                function: {
                  name: 'analyze_current_molecule',
                  arguments: JSON.stringify({
                    expected_revision: 0,
                    geometry_hash: `sha256:${'a'.repeat(64)}`
                  })
                }
              }
            ]
          }
        }
      ]
    }
    const response = e7XtbTestModelResponse(messagesAfter([], analysisCall, { ...waterAnalysis(), atomCount: 4 }))

    expect(responseToolCall(response)?.function.name).toBe('report_studio_result')
    expect(JSON.stringify(response)).toContain('requires the checked-in three-atom neutral-singlet water fixture')
  })

  it('ends without retrying when the visible approval is denied', () => {
    const startResponse = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call-controlled-harness-4',
                type: 'function',
                function: {
                  name: 'start_prepared_optimization',
                  arguments: JSON.stringify({ plan_id: 'plan-1', plan_digest: `sha256:${'b'.repeat(64)}` })
                }
              }
            ]
          }
        }
      ]
    }
    const response = controlledCalculationTestModelResponse(
      messagesAfter([], startResponse, {
        ok: false,
        error: { type: 'PermissionDenied', message: 'Denied', tool: 'start_prepared_optimization' }
      })
    )
    expect(responseToolCall(response)?.function.name).toBe('report_studio_result')
    expect(JSON.stringify(response)).toContain('denied; no calculation started')
  })

  it('ends the E7 xTB path without retrying when start approval is denied', () => {
    const startResponse = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call-e7-xtb-start',
                type: 'function',
                function: {
                  name: 'start_prepared_optimization',
                  arguments: JSON.stringify({ plan_id: 'plan-e7', plan_digest: `sha256:${'b'.repeat(64)}` })
                }
              }
            ]
          }
        }
      ]
    }
    const response = e7XtbTestModelResponse(
      messagesAfter([], startResponse, {
        ok: false,
        error: { type: 'PermissionDenied', message: 'Denied', tool: 'start_prepared_optimization' }
      })
    )

    expect(responseToolCall(response)?.function.name).toBe('report_studio_result')
    expect(JSON.stringify(response)).toContain('denied; no calculation started')
  })
})
