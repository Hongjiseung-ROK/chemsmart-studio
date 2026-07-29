import { IpcChannel } from '@shared/IpcChannel'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}))

vi.mock('electron', () => ({ ipcRenderer: electronMocks }))

describe('IpcApi preload event transport', () => {
  beforeEach(() => {
    vi.resetModules()
    electronMocks.invoke.mockReset()
    electronMocks.on.mockReset()
    electronMocks.removeListener.mockReset()
  })

  it('multiplexes all typed events through one native listener and detaches after the last subscriber', async () => {
    const { ipcApi } = await import('../../../preload/ipc')
    const resized = vi.fn()
    const stream = vi.fn()

    const unsubscribeResized = ipcApi.on('window.resized', resized)
    const unsubscribeStream = ipcApi.on('ai.stream_chunk', stream)

    expect(electronMocks.on).toHaveBeenCalledTimes(1)
    expect(electronMocks.on).toHaveBeenCalledWith(IpcChannel.IpcApi_Event, expect.any(Function))

    const dispatch = electronMocks.on.mock.calls[0][1]
    dispatch({}, 'window.resized', { width: 640 })
    expect(resized).toHaveBeenCalledWith({ width: 640 })
    expect(stream).not.toHaveBeenCalled()

    dispatch({}, 'ai.stream_chunk', { text: 'safe' })
    expect(stream).toHaveBeenCalledWith({ text: 'safe' })

    unsubscribeResized()
    expect(electronMocks.removeListener).not.toHaveBeenCalled()

    unsubscribeStream()
    expect(electronMocks.removeListener).toHaveBeenCalledTimes(1)
    expect(electronMocks.removeListener).toHaveBeenCalledWith(IpcChannel.IpcApi_Event, dispatch)
  })

  it('preserves duplicate subscriptions and reattaches after complete teardown', async () => {
    const { ipcApi } = await import('../../../preload/ipc')
    const callback = vi.fn()

    const unsubscribeFirst = ipcApi.on('window.resized', callback)
    const unsubscribeDuplicate = ipcApi.on('window.resized', callback)
    const firstDispatch = electronMocks.on.mock.calls[0][1]
    firstDispatch({}, 'window.resized', { width: 640 })
    expect(callback).toHaveBeenCalledTimes(2)

    unsubscribeFirst()
    expect(electronMocks.removeListener).not.toHaveBeenCalled()
    unsubscribeDuplicate()
    expect(electronMocks.removeListener).toHaveBeenCalledWith(IpcChannel.IpcApi_Event, firstDispatch)

    ipcApi.on('window.resized', callback)
    expect(electronMocks.on).toHaveBeenCalledTimes(2)
  })
})
