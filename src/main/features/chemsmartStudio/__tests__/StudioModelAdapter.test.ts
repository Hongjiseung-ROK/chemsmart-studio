import { describe, expect, it } from 'vitest'

import { studioReasoningEffort } from '../StudioModelAdapter'

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
