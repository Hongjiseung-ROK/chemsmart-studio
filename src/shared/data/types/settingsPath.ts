const STUDIO_SETTINGS_PATHS = [
  '/settings/model',
  '/settings/provider',
  '/settings/dependencies',
  '/settings/appearance',
  '/settings/about'
] as const

type StudioSettingsBasePath = (typeof STUDIO_SETTINGS_PATHS)[number]
export type SettingsPath = StudioSettingsBasePath | `/settings/provider?${string}`

export const DEFAULT_SETTINGS_PATH: SettingsPath = '/settings/provider'

export function isSettingsPath(value: unknown): value is SettingsPath {
  return (
    typeof value === 'string' &&
    (STUDIO_SETTINGS_PATHS.some((path) => path === value) || value.startsWith('/settings/provider?'))
  )
}

export function normalizeSettingsPath(value: unknown): SettingsPath {
  return isSettingsPath(value) ? value : DEFAULT_SETTINGS_PATH
}
