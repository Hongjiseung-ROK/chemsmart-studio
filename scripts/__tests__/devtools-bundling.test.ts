import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { isMainExternalModule } from '../../electron.vite.config'

const root = path.resolve(__dirname, '..', '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

describe('development DevTools bundling contract', () => {
  it('keeps electron-devtools-installer development-only and external to the main bundle', () => {
    expect(pkg.devDependencies?.['electron-devtools-installer']).toBeDefined()
    expect(pkg.dependencies?.['electron-devtools-installer']).toBeUndefined()
    expect(isMainExternalModule('electron-devtools-installer')).toBe(true)
  })
})
