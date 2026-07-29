import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted state lets individual tests mutate platform flags / preferences without
// re-mocking modules. The mock factories below read these via getters, preserving
// live-binding semantics so each test sees the current value.
const {
  platformState,
  prefValues,
  applicationMock,
  windowManagerMock,
  loggerMock,
  windowCreatedListeners,
  windowDestroyedListeners
} = vi.hoisted(() => {
  const platformState = { isMac: false, isWin: false, isLinux: false, isDev: false }
  const prefValues: Record<string, unknown> = {
    'app.tray.enabled': false,
    'app.tray.on_close': false,
    'app.tray.on_launch': false,
    'app.zoom_factor': 1,
    'app.spell_check.enabled': false,
    'app.spell_check.languages': [],
    'app.use_system_title_bar': false
  }
  const windowCreatedListeners = new Set<(managed: unknown) => void>()
  const windowDestroyedListeners = new Set<(managed: unknown) => void>()
  const windowManagerMock = {
    close: vi.fn(),
    getWindowId: vi.fn(),
    getWindow: vi.fn(),
    // Mirrors the real shape: runtime behavior setters live on `wm.behavior`
    // (see BehaviorController in src/main/core/window/behavior.ts).
    behavior: {
      setMacShowInDockByType: vi.fn()
    },
    onWindowCreatedByType: vi.fn((_type: string, listener: (managed: unknown) => void) => {
      windowCreatedListeners.add(listener)
      return { dispose: () => windowCreatedListeners.delete(listener) }
    }),
    onWindowDestroyedByType: vi.fn((_type: string, listener: (managed: unknown) => void) => {
      windowDestroyedListeners.add(listener)
      return { dispose: () => windowDestroyedListeners.delete(listener) }
    }),
    open: vi.fn(() => 'mock-window-id'),
    pushInitDataToType: vi.fn(),
    // Bounds are restored declaratively by WindowManager; setupMainWindow reads
    // the saved maximized flag back through this to re-apply maximize itself.
    peekWindowBounds: vi.fn()
  }
  const loggerMock = {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  }
  const applicationMock = {
    isQuitting: false,
    quit: vi.fn(),
    forceExit: vi.fn(),
    get: vi.fn((name: string) => {
      if (name === 'PreferenceService') {
        return { get: (key: string) => prefValues[key] }
      }
      if (name === 'WindowManager') {
        return windowManagerMock
      }
      throw new Error(`unexpected service: ${name}`)
    }),
    getPath: vi.fn((key: string, filename?: string) => (filename ? `/mock/${key}/${filename}` : `/mock/${key}`))
  }
  return {
    platformState,
    prefValues,
    applicationMock,
    windowManagerMock,
    loggerMock,
    windowCreatedListeners,
    windowDestroyedListeners
  }
})

vi.mock('@main/core/platform', () => ({
  get isMac() {
    return platformState.isMac
  },
  get isWin() {
    return platformState.isWin
  },
  get isLinux() {
    return platformState.isLinux
  },
  get isDev() {
    return platformState.isDev
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => loggerMock
  }
}))

vi.mock('@application', () => ({
  application: applicationMock
}))

vi.mock('electron', () => ({
  app: { dock: { hide: vi.fn(), show: vi.fn() }, on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
  nativeImage: { createFromPath: vi.fn(() => ({})) },
  nativeTheme: { shouldUseDarkColors: false },
  shell: { openExternal: vi.fn(), openPath: vi.fn() }
}))

vi.mock('@electron-toolkit/utils', () => ({ optimizer: { watchWindowShortcuts: vi.fn() } }))

vi.mock('@main/utils/windowUtil', () => ({
  getWindowsBackgroundMaterial: vi.fn(() => undefined),
  replaceDevtoolsFont: vi.fn()
}))

vi.mock('../ContextMenu', () => ({ contextMenu: { contextMenu: vi.fn() } }))
vi.mock('../../utils/externalUrlSafety', () => ({ isSafeExternalUrl: vi.fn(() => false) }))

// `?asset` import resolves to a string at build time; in tests we just stub the path.
vi.mock('../../../../build/icon.png?asset', () => ({ default: '/mock/icon.png' }))

// BaseService.ipcHandle/ipcOn/registerDisposable rely on real ipc internals; bypass them here.
vi.mock('@main/core/lifecycle', async () => {
  const actual = (await vi.importActual('@main/core/lifecycle')) as Record<string, unknown>
  class StubBase {
    ipcHandle = vi.fn()
    ipcOn = vi.fn()
    registerDisposable = <T>(d: T) => d
  }
  return { ...actual, BaseService: StubBase }
})

import { WindowType } from '@main/core/window/types'

import { MainWindowService } from '../MainWindowService'

interface MockBrowserWindow extends EventEmitter {
  isDestroyed: ReturnType<typeof vi.fn>
  isFullScreen: ReturnType<typeof vi.fn>
  isMinimized: ReturnType<typeof vi.fn>
  isVisible: ReturnType<typeof vi.fn>
  isFocused: ReturnType<typeof vi.fn>
  isMaximized: ReturnType<typeof vi.fn>
  hide: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
  minimize: ReturnType<typeof vi.fn>
  maximize: ReturnType<typeof vi.fn>
  setVisibleOnAllWorkspaces: ReturnType<typeof vi.fn>
  setFullScreen: ReturnType<typeof vi.fn>
  webContents: MockWebContents
}

interface MockWebContents extends EventEmitter {
  id: number
  close: ReturnType<typeof vi.fn>
  getOSProcessId: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  reload: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
}

function createMockWindow(webContentsId = 101, rendererProcessId = 1_001): MockBrowserWindow {
  const win = new EventEmitter() as MockBrowserWindow
  win.isDestroyed = vi.fn(() => false)
  win.isFullScreen = vi.fn(() => false)
  win.isMinimized = vi.fn(() => false)
  win.isVisible = vi.fn(() => true)
  win.isFocused = vi.fn(() => true)
  win.isMaximized = vi.fn(() => false)
  win.hide = vi.fn()
  win.show = vi.fn()
  win.focus = vi.fn()
  win.restore = vi.fn()
  win.minimize = vi.fn()
  win.maximize = vi.fn()
  win.setVisibleOnAllWorkspaces = vi.fn()
  win.setFullScreen = vi.fn()
  const webContents = new EventEmitter() as MockWebContents
  const on = webContents.on.bind(webContents)
  webContents.id = webContentsId
  webContents.getOSProcessId = vi.fn(() => rendererProcessId)
  webContents.isDestroyed = vi.fn(() => false)
  webContents.reload = vi.fn()
  webContents.on = vi.fn((event: string, listener: (...args: unknown[]) => void) => on(event, listener))
  webContents.close = vi.fn(() => {
    webContents.isDestroyed.mockReturnValue(true)
    webContents.emit('destroyed')
  })
  win.webContents = webContents
  return win
}

function attachCloseListener(svc: MainWindowService, win: MockBrowserWindow) {
  // Private method — invoked directly so we can capture the registered close handler.

  ;(svc as any).setupWindowLifecycleEvents(win)
}

function attachCrashMonitor(svc: MainWindowService, win: MockBrowserWindow) {

  ;(svc as any).setupMainWindowMonitor(win)
}

function getCrashListener(win: MockBrowserWindow): (event: unknown, details: unknown) => void {
  const call = win.webContents.on.mock.calls.find(([event]) => event === 'render-process-gone')
  if (!call) throw new Error('render-process-gone listener not registered')
  return call[1]
}

function makeCloseEvent() {
  return { preventDefault: vi.fn() }
}

describe('MainWindowService', () => {
  let svc: MainWindowService
  let win: MockBrowserWindow

  beforeEach(() => {
    platformState.isMac = false
    platformState.isWin = false
    platformState.isLinux = false
    platformState.isDev = false
    prefValues['app.tray.enabled'] = false
    prefValues['app.tray.on_close'] = false
    applicationMock.isQuitting = false
    windowCreatedListeners.clear()
    windowDestroyedListeners.clear()
    applicationMock.quit.mockReset()
    applicationMock.forceExit.mockReset()
    windowManagerMock.close.mockReset()
    windowManagerMock.getWindowId.mockReset()
    windowManagerMock.behavior.setMacShowInDockByType.mockReset()
    windowManagerMock.open.mockReset()
    windowManagerMock.open.mockReturnValue('mock-window-id')
    windowManagerMock.pushInitDataToType.mockClear()
    loggerMock.error.mockReset()
    loggerMock.info.mockReset()

    svc = new MainWindowService()
    win = createMockWindow()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('replays the existing main window to late subscribers', () => {
    ;(svc as any).mainWindow = win
    const listener = vi.fn()

    svc.onMainWindowCreated(listener)

    expect(listener).toHaveBeenCalledWith(win)
  })

  it('logs late subscriber replay failures without throwing', () => {
    ;(svc as any).mainWindow = win
    const error = new Error('listener failed')
    const listener = vi.fn(() => {
      throw error
    })

    expect(() => svc.onMainWindowCreated(listener)).not.toThrow()

    expect(listener).toHaveBeenCalledWith(win)
    expect(loggerMock.error).toHaveBeenCalledWith('Failed to replay main window listener', error)
  })

  it('clears only the destroyed active window and adopts the fresh managed window', async () => {
    const freshWindow = createMockWindow(202, 2_002)
    vi.spyOn(svc as any, 'setupMainWindow').mockImplementation(() => {})
    await (svc as any).onInit()

    for (const listener of [...windowCreatedListeners]) {
      listener({ id: 'window-a', type: WindowType.Main, window: win })
    }
    expect((svc as any).mainWindow).toBe(win)

    for (const listener of [...windowDestroyedListeners]) {
      listener({ id: 'unrelated-main', type: WindowType.Main, window: freshWindow })
    }
    expect((svc as any).mainWindow).toBe(win)

    for (const listener of [...windowDestroyedListeners]) {
      listener({ id: 'window-a', type: WindowType.Main, window: win })
    }
    expect((svc as any).mainWindow).toBeNull()

    for (const listener of [...windowCreatedListeners]) {
      listener({ id: 'window-b', type: WindowType.Main, window: freshWindow })
    }
    expect((svc as any).mainWindow).toBe(freshWindow)
  })

  describe('close handler', () => {
    it('does nothing when application.isQuitting is true (lets native close proceed)', () => {
      applicationMock.isQuitting = true
      attachCloseListener(svc, win)
      const event = makeCloseEvent()

      win.emit('close', event)

      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(win.hide).not.toHaveBeenCalled()
      expect(applicationMock.quit).not.toHaveBeenCalled()
    })

    it('calls application.quit() on Win when tray is disabled', () => {
      platformState.isWin = true
      prefValues['app.tray.enabled'] = false
      attachCloseListener(svc, win)
      const event = makeCloseEvent()

      win.emit('close', event)

      expect(applicationMock.quit).toHaveBeenCalledTimes(1)
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(win.hide).not.toHaveBeenCalled()
    })

    it('calls application.quit() on Linux when tray is enabled but on_close is false', () => {
      platformState.isLinux = true
      prefValues['app.tray.enabled'] = true
      prefValues['app.tray.on_close'] = false
      attachCloseListener(svc, win)
      const event = makeCloseEvent()

      win.emit('close', event)

      expect(applicationMock.quit).toHaveBeenCalledTimes(1)
      expect(win.hide).not.toHaveBeenCalled()
    })

    it('preventDefaults and hides on Win when tray + on_close are both enabled', () => {
      platformState.isWin = true
      prefValues['app.tray.enabled'] = true
      prefValues['app.tray.on_close'] = true
      attachCloseListener(svc, win)
      const event = makeCloseEvent()

      win.emit('close', event)

      expect(applicationMock.quit).not.toHaveBeenCalled()
      expect(event.preventDefault).toHaveBeenCalledTimes(1)
      expect(win.hide).toHaveBeenCalledTimes(1)
    })

    it('hides on macOS by default (system handles dock + relaunch)', () => {
      platformState.isMac = true
      prefValues['app.tray.enabled'] = false
      attachCloseListener(svc, win)
      const event = makeCloseEvent()

      win.emit('close', event)

      // No quit on macOS even with tray disabled — system follows the standard
      // "close hides, app stays in Dock" pattern; quit is reserved for Cmd+Q.
      expect(applicationMock.quit).not.toHaveBeenCalled()
      expect(event.preventDefault).toHaveBeenCalledTimes(1)
      expect(win.hide).toHaveBeenCalledTimes(1)
      // Critical: must NOT suppress Dock on standard mac close. Previous regression
      // hid the Dock icon along with the window, breaking macOS native semantics
      // (Dock tracks app liveness, not window visibility).
      expect(windowManagerMock.behavior.setMacShowInDockByType).not.toHaveBeenCalled()
    })

    it('does not preventDefault when window is fullscreen on macOS+tray (lets native close exit fullscreen)', () => {
      platformState.isMac = true
      prefValues['app.tray.enabled'] = true
      prefValues['app.tray.on_close'] = true
      win.isFullScreen.mockReturnValue(true)
      attachCloseListener(svc, win)
      const event = makeCloseEvent()

      win.emit('close', event)

      expect(event.preventDefault).not.toHaveBeenCalled()
      // hide is still called — the native close path will tear down fullscreen first.
      expect(win.hide).toHaveBeenCalledTimes(1)
    })

    it('suppresses Main-type Dock contribution on macOS + tray on_close', () => {
      platformState.isMac = true
      prefValues['app.tray.enabled'] = true
      prefValues['app.tray.on_close'] = true
      attachCloseListener(svc, win)
      const event = makeCloseEvent()

      win.emit('close', event)

      // wm.behavior.setMacShowInDockByType(Main, false) must be called BEFORE hide so the
      // Dock update resolves to hidden before the window transition lands.
      expect(windowManagerMock.behavior.setMacShowInDockByType).toHaveBeenCalledWith('main', false)
      expect(event.preventDefault).toHaveBeenCalledTimes(1)
      expect(win.hide).toHaveBeenCalledTimes(1)
    })

    it('does not touch Dock override on Win/Linux tray close (Dock is macOS-only)', () => {
      platformState.isWin = true
      prefValues['app.tray.enabled'] = true
      prefValues['app.tray.on_close'] = true
      attachCloseListener(svc, win)
      const event = makeCloseEvent()

      win.emit('close', event)

      expect(windowManagerMock.behavior.setMacShowInDockByType).not.toHaveBeenCalled()
    })
  })

  describe('toggleMainWindow', () => {
    it('hides a focused visible main window even when tray-close is disabled', () => {
      ;(svc as any).mainWindow = win
      prefValues['app.tray.on_close'] = false

      svc.toggleMainWindow()

      expect(win.hide).toHaveBeenCalledTimes(1)
      expect(windowManagerMock.behavior.setMacShowInDockByType).not.toHaveBeenCalled()
    })

    it('focuses a visible unfocused main window instead of hiding it', () => {
      ;(svc as any).mainWindow = win
      win.isFocused.mockReturnValue(false)

      svc.toggleMainWindow()

      expect(win.focus).toHaveBeenCalledTimes(1)
      expect(win.hide).not.toHaveBeenCalled()
    })

    it('keeps Dock suppression when hiding on macOS with tray-close enabled', () => {
      platformState.isMac = true
      prefValues['app.tray.on_close'] = true
      ;(svc as any).mainWindow = win

      svc.toggleMainWindow()

      expect(windowManagerMock.behavior.setMacShowInDockByType).toHaveBeenCalledWith('main', false)
      expect(win.hide).toHaveBeenCalledTimes(1)
    })
  })

  describe('showMainWindow init data', () => {
    it('pushes init data to an existing main window', () => {
      const initData = { kind: 'navigation' as const, to: '/settings/about' as const, requestId: 1 }
      ;(svc as any).mainWindow = win

      svc.showMainWindow(initData)

      expect(windowManagerMock.pushInitDataToType).toHaveBeenCalledWith(WindowType.Main, initData)
      expect(windowManagerMock.open).not.toHaveBeenCalled()
    })

    it('passes init data into WindowManager when creating the main window', () => {
      const initData = { kind: 'navigation' as const, to: '/settings/provider' as const, requestId: 1 }

      svc.showMainWindow(initData)

      expect(windowManagerMock.open).toHaveBeenCalledWith(
        WindowType.Main,
        expect.objectContaining({
          initData
        })
      )
      expect(windowManagerMock.pushInitDataToType).not.toHaveBeenCalled()
    })
  })

  describe('crash recovery', () => {
    function configureFreshWindowRecovery(oldWindow: MockBrowserWindow, freshWindow: MockBrowserWindow) {
      windowManagerMock.getWindowId.mockImplementation((candidate: MockBrowserWindow) =>
        candidate === oldWindow ? 'window-a' : candidate === freshWindow ? 'window-b' : undefined
      )
      windowManagerMock.close.mockImplementation((windowId: string) => {
        if (windowId !== 'window-a') return false
        oldWindow.isDestroyed.mockReturnValue(true)
        for (const listener of [...windowDestroyedListeners]) {
          listener({ id: 'window-a', type: WindowType.Main, window: oldWindow })
        }
        return true
      })
      windowManagerMock.open.mockImplementation(() => {
        for (const listener of [...windowCreatedListeners]) {
          listener({ id: 'window-b', type: WindowType.Main, window: freshWindow })
        }
        return 'window-b'
      })
    }

    async function waitForRecovery(service: MainWindowService) {
      const recovery = (service as any).rendererCrashRecovery as Promise<void> | null
      expect(recovery).not.toBeNull()
      await recovery
      await Promise.resolve()
    }

    it('replaces Window A with a fresh Window B without reloading or prematurely reopening GPU imports', async () => {
      const freshWindow = createMockWindow(202, 2_002)
      configureFreshWindowRecovery(win, freshWindow)
      attachCrashMonitor(svc, win)
      const listener = getCrashListener(win)
      // Electron does not guarantee a live process handle after render-process-gone, so recovery
      // must compare against the renderer identity it tracked before the crash.
      win.webContents.getOSProcessId.mockReturnValue(0)

      listener(null, { reason: 'crashed' })
      await waitForRecovery(svc)

      expect(windowManagerMock.close).toHaveBeenCalledWith('window-a')
      expect(win.webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false })
      expect(win.webContents.isDestroyed()).toBe(true)
      expect(windowManagerMock.open).toHaveBeenCalledWith(WindowType.Main, expect.any(Object))
      expect(freshWindow.webContents.id).toBe(202)
      expect(freshWindow.webContents.getOSProcessId()).toBe(2_002)
      expect(win.webContents.reload).not.toHaveBeenCalled()
      expect(applicationMock.forceExit).not.toHaveBeenCalled()
    })

    it('coalesces duplicate crash events from Window A into one recovery', async () => {
      const freshWindow = createMockWindow(202, 2_002)
      configureFreshWindowRecovery(win, freshWindow)
      attachCrashMonitor(svc, win)
      const listener = getCrashListener(win)

      listener(null, { reason: 'crashed' })
      listener(null, { reason: 'crashed' })
      await waitForRecovery(svc)

      expect(windowManagerMock.close).toHaveBeenCalledTimes(1)
      expect(windowManagerMock.open).toHaveBeenCalledTimes(1)
      expect(applicationMock.forceExit).not.toHaveBeenCalled()
    })

    it('does not create Window B until the surviving crashed webContents emits destroyed', async () => {
      const freshWindow = createMockWindow(202, 2_002)
      configureFreshWindowRecovery(win, freshWindow)
      win.webContents.close.mockImplementation(() => {})
      attachCrashMonitor(svc, win)

      getCrashListener(win)(null, { reason: 'crashed' })
      const recovery = (svc as any).rendererCrashRecovery as Promise<void>
      await vi.waitFor(() => expect(win.webContents.close).toHaveBeenCalledTimes(1))
      expect(windowManagerMock.open).not.toHaveBeenCalled()

      win.webContents.isDestroyed.mockReturnValue(true)
      win.webContents.emit('destroyed')
      await recovery

      expect(windowManagerMock.open).toHaveBeenCalledTimes(1)
    })

    it('forceExits when fresh Window B crashes within 60 seconds', async () => {
      const freshWindow = createMockWindow(202, 2_002)
      configureFreshWindowRecovery(win, freshWindow)
      attachCrashMonitor(svc, win)
      attachCrashMonitor(svc, freshWindow)
      const oldListener = getCrashListener(win)
      const freshListener = getCrashListener(freshWindow)
      const realNow = Date.now
      try {
        Date.now = vi.fn().mockReturnValueOnce(100_000).mockReturnValueOnce(100_500)
        oldListener(null, { reason: 'crashed' })
        await waitForRecovery(svc)
        freshListener(null, { reason: 'crashed' })
      } finally {
        Date.now = realNow
      }

      expect(applicationMock.forceExit).toHaveBeenCalledWith(1)
      expect(windowManagerMock.close).toHaveBeenCalledTimes(1)
      expect(freshWindow.webContents.reload).not.toHaveBeenCalled()
    })

    it('restores hidden, maximized state only after Window B is ready to show', async () => {
      const freshWindow = createMockWindow(202, 2_002)
      configureFreshWindowRecovery(win, freshWindow)
      windowManagerMock.open.mockImplementation(() => {
        for (const listener of [...windowCreatedListeners]) {
          listener({ id: 'window-b', type: WindowType.Main, window: freshWindow })
        }
        // WindowManager fires onWindowCreated synchronously before loading content.
        // Even an immediate ready-to-show after creation must see the restore listener.
        freshWindow.emit('ready-to-show')
        return 'window-b'
      })
      win.isVisible.mockReturnValue(false)
      win.isFocused.mockReturnValue(false)
      win.isMaximized.mockReturnValue(true)
      attachCrashMonitor(svc, win)

      getCrashListener(win)(null, { reason: 'crashed' })
      await waitForRecovery(svc)

      expect(freshWindow.maximize).toHaveBeenCalledTimes(1)
      expect(freshWindow.hide).toHaveBeenCalledTimes(1)
    })
  })

  // Maximize restore stays consumer-side (WindowManager restores position/size
  // declaratively; the service re-applies the maximized flag on its own show
  // schedule because tray-on-launch must defer it to the first show).
  describe('setupMaximize restore', () => {
    const setupMaximize = (isMaximized: boolean) => (svc as any).setupMaximize(win, isMaximized)

    it('maximizes immediately when restoring a maximized window on a normal launch', () => {
      prefValues['app.tray.on_launch'] = false
      setupMaximize(true)
      expect(win.maximize).toHaveBeenCalledTimes(1)
    })

    it('defers maximize to first show when launching to tray', () => {
      prefValues['app.tray.on_launch'] = true
      setupMaximize(true)

      // Not yet — the window is still hidden in the tray.
      expect(win.maximize).not.toHaveBeenCalled()

      win.emit('show')
      expect(win.maximize).toHaveBeenCalledTimes(1)
    })

    it('does nothing when the saved state was not maximized', () => {
      prefValues['app.tray.on_launch'] = false
      setupMaximize(false)
      win.emit('show')
      expect(win.maximize).not.toHaveBeenCalled()
    })
  })

  // The wiring itself: setupMainWindow must read the saved maximized flag back
  // from WindowManager (bounds are restored declaratively by WM; the service only
  // re-applies maximize). Tested via setupMainWindow (not setupMaximize directly)
  // so a regression that read the wrong type or dropped the call would be caught.
  describe('setupMainWindow → maximize wiring', () => {
    beforeEach(() => {
      // Stub the other (heavy) setup steps so this isolates the read-back path.
      for (const m of [
        'setupContextMenu',
        'setupSpellCheck',
        'setupWindowEvents',
        'setupWebContentsHandlers',
        'setupWindowLifecycleEvents',
        'setupMainWindowMonitor'
      ]) {
        vi.spyOn(svc as any, m).mockImplementation(() => {})
      }
      prefValues['app.tray.on_launch'] = false
    })

    it('reads the saved maximized flag from WindowManager and re-applies maximize', () => {
      windowManagerMock.peekWindowBounds.mockReturnValue({
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        isMaximized: true,
        displayBounds: { x: 0, y: 0, width: 1920, height: 1080 }
      })

      ;(svc as any).setupMainWindow(win)

      expect(windowManagerMock.peekWindowBounds).toHaveBeenCalledWith(WindowType.Main)
      expect(win.maximize).toHaveBeenCalledTimes(1)
    })

    it('does not maximize when WindowManager has no saved bounds', () => {
      windowManagerMock.peekWindowBounds.mockReturnValue(undefined)

      ;(svc as any).setupMainWindow(win)

      expect(windowManagerMock.peekWindowBounds).toHaveBeenCalledWith(WindowType.Main)
      expect(win.maximize).not.toHaveBeenCalled()
    })
  })
})
