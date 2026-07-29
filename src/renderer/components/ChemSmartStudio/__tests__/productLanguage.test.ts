import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, relative, resolve } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import enUs from '../../../i18n/locales/en-us.json'

const upstreamProductBranding = /\b(?:Cherry(?: Studio| Assistant)?|Avogadro)\b/
const sourceRoots = ['src/main', 'src/renderer', 'src/shared'] as const
const sourceExtensions = new Set(['.ts', '.tsx'])

const provenanceAllowlist = new Map<string, ReadonlySet<string>>([
  [
    'src/main/services/LegacyBackupManager.ts',
    new Set([
      // The exact discriminator and error belong to the frozen v1 archive format.
      'Cherry Studio',
      'This backup file is not from Cherry Studio and cannot be restored'
    ])
  ],
  [
    'src/renderer/services/oauth.ts',
    new Set([
      // The external provider owns this registered OAuth application URL.
      'https://dash.302.ai/sso/login?app=cherry-ai.com&name=Cherry%20Studio'
    ])
  ]
])

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(collectStrings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(collectStrings)
  return []
}

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__' || entry.name === 'tests') return []
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return listSourceFiles(path)
    if (!sourceExtensions.has(extname(entry.name)) || /\.test\.[cm]?[jt]sx?$/.test(entry.name)) return []
    return [path]
  })
}

function collectSourceStrings(path: string): string[] {
  const source = readFileSync(path, 'utf8')
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    extname(path) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const strings: string[] = []

  function visit(node: ts.Node) {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      strings.push(node.text)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return strings
}

function isAllowedProvenance(path: string, value: string): boolean {
  return provenanceAllowlist.get(path)?.has(value) ?? false
}

describe('ChemSmart product language', () => {
  it('excludes upstream branding from the product-owned workspace strings', () => {
    const productStrings = collectStrings(enUs.chemsmart_studio)

    expect(productStrings.filter((value) => upstreamProductBranding.test(value))).toEqual([])
  })

  it('uses the ChemSmart product name for the main application window', () => {
    const mainWindowHtml = readFileSync(resolve(process.cwd(), 'src/renderer/windows/main/index.html'), 'utf8')

    expect(mainWindowHtml).toContain('<title>ChemSmart Studio</title>')
    expect(mainWindowHtml.match(upstreamProductBranding)).toBeNull()
  })

  it('excludes upstream branding from every shipped locale value', () => {
    const localeDirectories = [
      'src/main/i18n/locales',
      'src/main/i18n/translate',
      'src/renderer/i18n/locales',
      'src/renderer/i18n/translate'
    ]
    const violations = localeDirectories.flatMap((directory) =>
      readdirSync(resolve(process.cwd(), directory))
        .filter((name) => name.endsWith('.json'))
        .flatMap((name) => {
          const path = `${directory}/${name}`
          const catalog = JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8')) as unknown
          return collectStrings(catalog)
            .filter((value) => upstreamProductBranding.test(value))
            .map((value) => ({ path, value }))
        })
    )

    expect(violations).toEqual([])
  })

  it('excludes upstream branding from user-facing source strings with a narrow provenance allowlist', () => {
    const violations = sourceRoots.flatMap((root) =>
      listSourceFiles(resolve(process.cwd(), root)).flatMap((absolutePath) => {
        const path = relative(process.cwd(), absolutePath)
        return collectSourceStrings(absolutePath)
          .filter((value) => upstreamProductBranding.test(value) && !isAllowedProvenance(path, value))
          .map((value) => ({ path, value }))
      })
    )

    expect(violations).toEqual([])
  })

  it('uses ChemSmart product language in every renderer window title', () => {
    const windowsRoot = resolve(process.cwd(), 'src/renderer/windows')
    const titlePattern = /<title>(.*?)<\/title>/i
    const titles = readdirSync(windowsRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name === 'index.html')
      .map((entry) => {
        const path = resolve(entry.parentPath, entry.name)
        const title = readFileSync(path, 'utf8').match(titlePattern)?.[1] ?? ''
        return { path: relative(process.cwd(), path), title }
      })
    const violations = titles.filter(({ title }) => upstreamProductBranding.test(title))

    expect(violations).toEqual([])
  })

  it('uses ChemSmart product language in the bundled assistant identity and guide', () => {
    const upstreamProductIdentity = /\b(?:Cherry Studio|Cherry Assistant|Avogadro)\b/
    const agentDefinition = JSON.parse(
      readFileSync(resolve(process.cwd(), 'resources/builtin-agents/chemsmart-agent/agent.json'), 'utf8')
    ) as { configuration: { avatar: string }; instructions: Record<string, string>; name: string }
    const bundledAgentPaths = [
      'resources/builtin-agents/chemsmart-agent/agent.json',
      'resources/builtin-agents/chemsmart-agent/runtime/plugins.json',
      'resources/builtin-agents/chemsmart-agent/runtime/skills/chemsmart-agent-guide/SKILL.md'
    ]
    const violations = bundledAgentPaths
      .filter((path) => upstreamProductIdentity.test(readFileSync(resolve(process.cwd(), path), 'utf8')))
      .map((path) => ({ path }))

    expect(agentDefinition).toMatchObject({
      configuration: { avatar: '🧪' },
      name: 'ChemSmart Agent'
    })
    expect(Object.values(agentDefinition.instructions)).toEqual([
      expect.stringContaining('ChemSmart Agent'),
      expect.stringContaining('ChemSmart Agent')
    ])
    expect(violations).toEqual([])
  })

  it('keeps the bundled assistant guide metadata synchronized with its exact content', () => {
    const guidePath = resolve(
      process.cwd(),
      'resources/builtin-agents/chemsmart-agent/runtime/skills/chemsmart-agent-guide/SKILL.md'
    )
    const pluginsPath = resolve(process.cwd(), 'resources/builtin-agents/chemsmart-agent/runtime/plugins.json')
    const guide = readFileSync(guidePath)
    const plugins = JSON.parse(readFileSync(pluginsPath, 'utf8')) as {
      plugins: Array<{ filename: string; metadata: { contentHash: string; size: number } }>
    }
    const metadata = plugins.plugins.find(({ filename }) => filename === 'chemsmart-agent-guide')?.metadata

    expect(metadata).toMatchObject({
      contentHash: createHash('sha256').update(guide).digest('hex'),
      size: guide.byteLength
    })
  })

  it('keeps SDK dot-directories out of bundled agent source resources', () => {
    const bundledAgentRoot = resolve(process.cwd(), 'resources/builtin-agents')
    const dotDirectories = readdirSync(bundledAgentRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name === '.claude')
      .map((entry) => relative(process.cwd(), resolve(entry.parentPath, entry.name)))

    expect(dotDirectories).toEqual([])
  })
})
