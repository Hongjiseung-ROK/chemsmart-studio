import { isLinux, isMac, isWin } from '@main/core/platform'
import { type WindowOptions, WindowType, type WindowTypeMetadata } from '@main/core/window/types'
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH } from '@shared/utils/window'

/**
 * Default window configuration.
 * Base configuration applied to all windows unless overridden by the type-specific config.
 */
export const DEFAULT_WINDOW_CONFIG: WindowOptions = {
  width: 1100,
  height: 720,
  autoHideMenuBar: true,
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true
  }
}

/**
 * Window type registry.
 * Maps each window type to its metadata and default configuration.
 *
 * Uses `Partial<Record<...>>` to support incremental migration: window types
 * are added here one-by-one as they are migrated to the WindowManager.
 *
 * @example Adding a new window type during migration:
 * ```typescript
 * WINDOW_TYPE_REGISTRY[WindowType.Main] = {
 *   type: WindowType.Main,
 *   lifecycle: 'singleton',
 *   htmlPath: 'index.html',
 *   windowOptions: { ...DEFAULT_WINDOW_CONFIG, minWidth: 350, minHeight: 400 },
 * }
 * ```
 */
export const WINDOW_TYPE_REGISTRY: Partial<Record<WindowType, WindowTypeMetadata>> = {
  // Main application window — singleton primary surface.
  // Managed by MainWindowService: dynamic options (theme-driven backgroundColor /
  // backgroundMaterial / frame / icon / zoomFactor) are injected via wm.open({ options }).
  // Window position/size/maximized are restored by WindowManager via `rememberBounds`
  // (no longer injected by the service). showMode 'manual' lets MainWindowService decide
  // first show in the ready-to-show handler (so tray-on-launch can suppress it).
  //
  // Intentionally NOT using `singletonConfig` here — MainWindowService's close handler
  // (see `setupWindowLifecycleEvents`) reads tray preferences at runtime, calls
  // `application.quit()` on Win/Linux without tray, guards on `isFullScreen()`, and
  // toggles `setMacShowInDockByType` for tray-mode transitions. None of this is
  // expressible via `retentionTime`, and forcing it through would regress Win/Linux
  // "close = quit" semantics. Eager warmup also clashes with the dynamic options +
  // state-preserving hide→show contract of Step A. See window-manager-warmup-mechanics.md
  // → Singleton Variant for the declarative alternative and its constraints.
  [WindowType.Main]: {
    type: WindowType.Main,
    lifecycle: 'singleton',
    htmlPath: 'windows/main/index.html',
    // preload omitted → defaults to 'preload.js' (full API preload).
    showMode: 'manual',
    // Persist & restore position/size across launches (maximize re-applied by the service).
    rememberBounds: true,
    windowOptions: {
      width: MIN_WINDOW_WIDTH,
      height: MIN_WINDOW_HEIGHT,
      minWidth: MIN_WINDOW_WIDTH,
      minHeight: MIN_WINDOW_HEIGHT,
      autoHideMenuBar: true,
      transparent: false,
      vibrancy: 'sidebar',
      visualEffectState: 'active',
      platformOverrides: {
        mac: {
          titleBarStyle: 'hidden',
          trafficLightPosition: { x: 13, y: 16 },
          // WCO height; consumed by renderer's env(titlebar-area-height)
          titleBarOverlay: { height: 42 }
        },
        win: {
          // Frameless + renderer-drawn WindowControls (mirrors SubWindow). Windows is
          // always frameless; backgroundMaterial stays runtime-computed → args.options.
          frame: false
        }
        // linux: frame honors `app.use_system_title_bar` preference, icon is nativeImage
        //        → both injected via args.options
      },
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webSecurity: false,
        webviewTag: true,
        allowRunningInsecureContent: true,
        backgroundThrottling: false
        // zoomFactor depends on PreferenceService → injected via args.options
      }
    },
    behavior: {
      // Main window is the primary surface — always reflected in the macOS Dock.
      // WindowManager.updateDockVisibility uses this to drive Dock show/hide on
      // every show/hide/minimize/restore, replacing the manual app.dock?.show()
      // / app.dock?.hide() calls that used to live in the close handler.
      macShowInDock: true
    }
  },

  // Hidden one-shot print surface. PrintService owns loading generated paper HTML
  // and closes the window after print / PDF export.
  [WindowType.Print]: {
    type: WindowType.Print,
    lifecycle: 'default',
    htmlPath: '',
    preload: '',
    showMode: 'manual',
    windowOptions: {
      skipTaskbar: true,
      autoHideMenuBar: true,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: false
      }
    },
    behavior: {
      // Hidden helper window: do not bring the macOS Dock icon back in tray mode.
      macShowInDock: false
    }
  },

  // Detached tab window — multi-instance, one per user-detached Tab.
  // Placed adjacent to Main because a SubWindow is logically a Main spin-off
  // (a Tab dragged out of Main becomes its own BrowserWindow here; drag back
  // to the Main tab bar re-attaches).
  // Managed by SubWindowService: dynamic options (per-tab title, theme-driven
  // backgroundColor / darkTheme, Linux-only icon nativeImage,
  // optional initial x/y) are injected via wm.open({ options }). showMode
  // 'manual' lets SubWindowService decide show timing based on whether an
  // initial position was provided at Tab_Detach time (drop-at-cursor detach
  // wants the window at that position before show; no-position detach uses a
  // ready-to-show auto-show fallback). Init payload (tabId, url, title, type,
  // isPinned) flows via initData and useWindowInitData<SubWindowInitData>() in
  // the renderer.
  [WindowType.SubWindow]: {
    type: WindowType.SubWindow,
    lifecycle: 'pooled',
    poolConfig: {
      // INVARIANT: this pool is destroy-on-close (standbySize:1 + warmup:'eager', and NO
      // recycleMaxSize). That is the *only* reason the SubWindow renderer is allowed to be
      // single-init: SubWindowAppShell opens its tab once (an `initialized` ref guard) and
      // ignores later WindowManager_Reused events. With no recycleMaxSize, close() always
      // destroys, so a window is never handed back carrying a *different* tab — every open()
      // either pops a pristine never-navigated standby or creates fresh. The renderer is NOT
      // reuse-safe. Do NOT add recycleMaxSize (or otherwise enable recycle) here without first
      // making the renderer re-initialize on window.reused; otherwise a recycled window would
      // keep displaying its previous tab.
      standbySize: 1,
      warmup: 'eager'
    },
    htmlPath: 'windows/subWindow/index.html',
    // preload omitted → defaults to 'preload.js' (full API preload).
    showMode: 'manual',
    windowOptions: {
      width: 800,
      height: 600,
      minWidth: 400,
      minHeight: 300,
      useContentSize: true,
      autoHideMenuBar: true,
      transparent: false,
      // Load-bearing for SubWindowService.createWindow's show path: that path shows the window
      // unconditionally + immediately (no ready-to-show wait), relying on the hidden window having
      // already painted its renderer. This is Electron's default (true) — pinned explicitly so it
      // is never silently flipped to false (which would re-introduce the empty-shell first-paint
      // flash on reuse and the never-fires ready-to-show stuck-hidden failure mode).
      paintWhenInitiallyHidden: true,
      vibrancy: 'sidebar',
      visualEffectState: 'active',
      platformOverrides: {
        mac: {
          titleBarStyle: 'hidden',
          trafficLightPosition: { x: 8, y: 13 },
          // WCO height; consumed by renderer's env(titlebar-area-height)
          titleBarOverlay: { height: 42 }
        },
        win: {
          frame: false
          // backgroundColor is theme-dependent → injected via args.options (non-mac only)
        },
        linux: {
          frame: false
          // icon is a nativeImage (required for Wayland task switcher) → injected via args.options
        }
      },
      webPreferences: {
        sandbox: false,
        webSecurity: false,
        webviewTag: true,
        // REQUIRED: SubWindow hosts streaming LLM responses and WebSocket heartbeats;
        // Chromium's background-tab throttling would freeze the UI for seconds after
        // focus switches. Mirrors the Main window's choice above; do not remove.
        backgroundThrottling: false
      }
    }
    // NOTE: Fields intentionally NOT set here, injected per-call via wm.open({ options }):
    //   - title (per-tab dynamic)
    //   - backgroundColor / darkTheme (theme snapshot at create time)
    //   - icon (Linux-only nativeImage; see SubWindowService.linuxIcon — mac/Windows omit)
    //   - x / y (only when Tab_Detach payload carries a drop position)
    // NOTE: setWindowOpenHandler + will-navigate are registered by WindowManager for
    // every BrowserWindow (see WindowManager.ts:1186-1201). SubWindow inherits both
    // automatically; do NOT attach another setWindowOpenHandler here or in the
    // service — Electron's API is single-slot and would overwrite WM's version.
  }
}

/**
 * Get window type metadata.
 * @param type - The window type to look up
 * @returns The metadata for the specified window type
 * @throws Error if the window type is not registered
 */
export function getWindowTypeMetadata(type: WindowType): WindowTypeMetadata {
  const metadata = WINDOW_TYPE_REGISTRY[type]
  if (!metadata) {
    throw new Error(
      `WindowType '${type}' is not registered in WINDOW_TYPE_REGISTRY. ` +
        `Register it before calling open() or create().`
    )
  }
  return metadata
}

/**
 * Pick the `platformOverrides` branch matching the current runtime.
 * Returns `undefined` when no override is configured for the current platform.
 */
function pickPlatformOverride(
  overrides: WindowOptions['platformOverrides']
): Partial<Omit<WindowOptions, 'platformOverrides'>> | undefined {
  if (!overrides) return undefined
  if (isMac) return overrides.mac
  if (isWin) return overrides.win
  if (isLinux) return overrides.linux
  return undefined
}

/**
 * Merge window configuration.
 *
 * Order of precedence (later wins):
 *   1. baseOptions (from registry `windowOptions`)
 *   2. baseOptions.platformOverrides[currentPlatform]
 *   3. caller-provided `overrides`
 *   4. caller-provided `overrides.platformOverrides[currentPlatform]`
 *
 * `webPreferences` is deep-merged in the same order.
 * The `platformOverrides` field is stripped from the returned config so it never
 * leaks into `new BrowserWindow(...)` (Electron would silently ignore it, but keeping
 * the return type clean avoids confusion for consumers and future refactors).
 *
 * @param type - The window type
 * @param overrides - Optional configuration overrides from the caller
 * @returns Merged window configuration, guaranteed to omit `platformOverrides`.
 */
export function mergeWindowOptions(
  type: WindowType,
  overrides?: Partial<WindowOptions>
): Omit<WindowOptions, 'platformOverrides'> {
  const metadata = getWindowTypeMetadata(type)
  const baseOptions = metadata.windowOptions

  const basePlatform = pickPlatformOverride(baseOptions.platformOverrides)
  const overridePlatform = pickPlatformOverride(overrides?.platformOverrides)

  const webPreferences = {
    ...baseOptions.webPreferences,
    ...basePlatform?.webPreferences,
    ...overrides?.webPreferences,
    ...overridePlatform?.webPreferences
  }

  const merged: WindowOptions = {
    ...baseOptions,
    ...basePlatform,
    ...overrides,
    ...overridePlatform,
    webPreferences
  }

  // Strip platformOverrides from the returned object so it never leaks to `new BrowserWindow(...)`.
  const rest: Record<string, unknown> = { ...merged }
  delete rest.platformOverrides
  return rest as Omit<WindowOptions, 'platformOverrides'>
}
