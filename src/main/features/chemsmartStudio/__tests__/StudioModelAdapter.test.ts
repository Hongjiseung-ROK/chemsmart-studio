import { describe, expect, it } from 'vitest'

import { consumeOpenAiStudioStream, type StudioModelStreamObserver, studioReasoningEffort } from '../StudioModelAdapter'

function sseResponse(events: unknown[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
}

describe('StudioModelAdapter reasoning policy', () => {
  it('requests high reasoning for the DeepSeek provider even when its model id is only v4-pro', () => {
    expect(studioReasoningEffort('deepseek', 'v4-pro')).toBe('high')
  })

  it('recognizes an aggregated DeepSeek model id', () => {
    expect(studioReasoningEffort('tokenhub', 'agent/deepseek-v4-pro')).toBe('high')
  })

  it('does not force reasoning controls onto unrelated models', () => {
    expect(studioReasoningEffort('openai', 'gpt-4.1')).toBeUndefined()
  })
})

describe('StudioModelAdapter streaming', () => {
  it('reconstructs one canonical tool response while projecting only safe prose deltas', async () => {
    const projected: string[] = []
    const completed: string[] = []
    let started = 0
    const observer: StudioModelStreamObserver = {
      onTextStarted: () => {
        started += 1
      },
      onTextDelta: (delta) => projected.push(delta),
      onTextCompleted: (text) => completed.push(text),
      onTextStopped: () => {
        throw new Error('stream unexpectedly stopped')
      }
    }
    const response = sseResponse([
      {
        id: 'chatcmpl-1',
        model: 'deepseek:reasoner',
        created: 1,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
      },
      {
        id: 'chatcmpl-1',
        model: 'deepseek:reasoner',
        created: 1,
        choices: [{ index: 0, delta: { reasoning_content: 'private chain' }, finish_reason: null }]
      },
      {
        id: 'chatcmpl-1',
        model: 'deepseek:reasoner',
        created: 1,
        choices: [{ index: 0, delta: { content: 'Inspecting ' }, finish_reason: null }]
      },
      {
        id: 'chatcmpl-1',
        model: 'deepseek:reasoner',
        created: 1,
        choices: [{ index: 0, delta: { content: 'the molecule.' }, finish_reason: null }]
      },
      {
        id: 'chatcmpl-1',
        model: 'deepseek:reasoner',
        created: 1,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'analyze_current_molecule', arguments: '{}' }
                }
              ]
            },
            finish_reason: null
          }
        ]
      },
      {
        id: 'chatcmpl-1',
        model: 'deepseek:reasoner',
        created: 1,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
      }
    ])

    const result = (await consumeOpenAiStudioStream(response, observer)) as {
      choices: Array<{
        message: {
          content: string
          reasoning_content: string
          tool_calls: Array<{
            id: string
            type: 'function'
            function: { name: string; arguments: string }
          }>
        }
      }>
    }

    expect(started).toBe(1)
    expect(projected.join('')).toBe('Inspecting the molecule.')
    expect(completed).toEqual(['Inspecting the molecule.'])
    expect(projected.join('')).not.toContain('private chain')
    expect(result.choices[0].message).toMatchObject({
      content: 'Inspecting the molecule.',
      reasoning_content: 'private chain',
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'analyze_current_molecule', arguments: '{}' }
        }
      ]
    })
  })

  it('redacts path and numeric claims from transient final narration', async () => {
    const projected: string[] = []
    const observer: StudioModelStreamObserver = {
      onTextStarted: () => undefined,
      onTextDelta: (delta) => projected.push(delta),
      onTextCompleted: () => undefined,
      onTextStopped: () => undefined
    }
    const response = sseResponse([
      {
        choices: [
          {
            delta: { content: 'Verified 3 atoms at /Users/researcher/project.' },
            finish_reason: 'stop'
          }
        ]
      }
    ])

    await consumeOpenAiStudioStream(response, observer, 'narration')

    expect(projected.join('')).toBe('Verified [private content withheld] atoms at [private content withheld]')
  })
})
