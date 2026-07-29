import { IpcChannel } from '@shared/IpcChannel'
import { ipcRenderer, type IpcRendererEvent } from 'electron'

type IpcApiEventListener = (payload: unknown) => void

const eventListeners = new Map<string, Set<IpcApiEventListener>>()

const dispatchIpcApiEvent = (_event: IpcRendererEvent, name: string, payload: unknown): void => {
  for (const listener of eventListeners.get(name) ?? []) listener(payload)
}

const attachEventTransport = (): void => {
  if (eventListeners.size === 0) ipcRenderer.on(IpcChannel.IpcApi_Event, dispatchIpcApiEvent)
}

const detachEventTransport = (): void => {
  if (eventListeners.size === 0) ipcRenderer.removeListener(IpcChannel.IpcApi_Event, dispatchIpcApiEvent)
}

/**
 * Low-level IpcApi bridge exposed at `window.api.ipcApi`.
 *
 * Generic by design: adding a request route or an event needs ZERO changes here.
 * All events share the single `IpcApi_Event` channel and are demultiplexed by
 * name. The typed, error-unwrapping facade lives in `src/renderer/ipc`; this is
 * the raw transport that crosses the contextBridge.
 */
export const ipcApi = {
  request: (route: string, input?: unknown, meta?: unknown): Promise<unknown> =>
    ipcRenderer.invoke(IpcChannel.IpcApi_Request, route, input, meta),

  on: (event: string, callback: (payload: unknown) => void): (() => void) => {
    attachEventTransport()
    const listeners = eventListeners.get(event) ?? new Set<IpcApiEventListener>()
    const listener = (payload: unknown): void => callback(payload)
    listeners.add(listener)
    eventListeners.set(event, listeners)

    return () => {
      const current = eventListeners.get(event)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) eventListeners.delete(event)
      detachEventTransport()
    }
  }
}
