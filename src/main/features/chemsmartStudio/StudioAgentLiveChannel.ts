import { randomUUID } from 'node:crypto'

import type { ChemSmartStudioAgentLiveEvent } from '@shared/ipc/schemas/chemsmartStudio'

type LiveTurnState = {
  activeBlockId: string | null
  sequence: number
  stopped: boolean
  text: string
  threadId: string
  turnId: string
}

/**
 * Main-owned transient prose channel. It intentionally has no replay or persistence API.
 */
export class StudioAgentLiveChannel {
  private readonly turns = new Map<string, LiveTurnState>()

  constructor(private readonly broadcast: (event: ChemSmartStudioAgentLiveEvent) => void) {}

  beginTurn(threadId: string, turnId: string): void {
    this.turns.set(turnId, {
      activeBlockId: null,
      sequence: 0,
      stopped: false,
      text: '',
      threadId,
      turnId
    })
  }

  beginText(turnId: string): void {
    const state = this.state(turnId)
    if (state.activeBlockId) throw new Error('Studio Agent live text block is already active')
    state.stopped = false
    state.activeBlockId = `block-${randomUUID()}`
    state.text = ''
    this.emit(state, 'text_started')
  }

  appendText(turnId: string, text: string): void {
    const state = this.state(turnId)
    if (!state.activeBlockId || state.stopped || !text) return
    state.text += text
    this.emit(state, 'text_delta', text)
  }

  completeText(turnId: string, fullText: string): void {
    const state = this.state(turnId)
    if (!state.activeBlockId || state.stopped) return
    state.text = fullText
    this.emit(state, 'text_completed', fullText)
    state.activeBlockId = null
  }

  publishText(turnId: string, text: string): void {
    this.beginText(turnId)
    this.appendText(turnId, text)
    this.completeText(turnId, text)
  }

  stopText(turnId: string): void {
    const state = this.turns.get(turnId)
    if (!state || state.stopped) return
    state.stopped = true
    if (!state.activeBlockId) {
      state.activeBlockId = `block-${randomUUID()}`
      this.emit(state, 'text_started')
    }
    state.text = 'Response stopped'
    this.emit(state, 'text_completed', state.text)
    state.activeBlockId = null
  }

  finishTurn(turnId: string): void {
    this.turns.delete(turnId)
  }

  private state(turnId: string): LiveTurnState {
    const state = this.turns.get(turnId)
    if (!state) throw new Error('Studio Agent live event is not bound to an active turn')
    return state
  }

  private emit(state: LiveTurnState, kind: ChemSmartStudioAgentLiveEvent['kind'], text?: string): void {
    if (!state.activeBlockId) throw new Error('Studio Agent live event has no active block')
    this.broadcast({
      threadId: state.threadId,
      turnId: state.turnId,
      blockId: state.activeBlockId,
      sequence: state.sequence++,
      kind,
      ...(text === undefined ? {} : { text }),
      transient: true
    })
  }
}
