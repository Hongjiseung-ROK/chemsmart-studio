const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const outputFile = path.join(root, 'build', 'chemsmart-cli', 'cli-schema.json')

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableJson(value[key])])
    )
  }
  return value
}

function schemaHash(document) {
  const body = { ...document }
  delete body._meta
  return createHash('sha256')
    .update(JSON.stringify(stableJson(body)))
    .digest('hex')
}

function pinnedCommit() {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'upstreams.lock.json'), 'utf8'))
  return lock.upstreams.chemSmart.commit
}

function verifySource() {
  const expected = pinnedCommit()
  const actual = execFileSync('git', ['-C', path.join(root, 'vendor', 'chemsmart'), 'rev-parse', 'HEAD'], {
    encoding: 'utf8'
  }).trim()
  const dirty = execFileSync('git', ['-C', path.join(root, 'vendor', 'chemsmart'), 'status', '--porcelain'], {
    encoding: 'utf8'
  }).trim()
  if (actual !== expected || dirty) throw new Error('The pinned ChemSmart source is unavailable or dirty')
  return expected
}

function exporterFor(mode = 'dev') {
  const portable = path.join(root, 'build', 'chemsmart-bridge', '.venv', 'bin', 'chemsmart')
  const development = path.join(root, 'services', 'chemsmart_bridge', '.venv', 'bin', 'chemsmart')
  if (mode === 'portable' && fs.existsSync(portable)) return { executable: portable, args: [] }
  if (fs.existsSync(development)) return { executable: development, args: [] }
  const uv = path.join(root, 'resources', 'binaries', `${process.platform}-${process.arch}`, 'uv')
  if (!fs.existsSync(uv)) throw new Error('No locked ChemSmart CLI runtime is available')
  return {
    executable: uv,
    args: ['run', '--project', path.join(root, 'services', 'chemsmart_bridge'), '--frozen', 'chemsmart']
  }
}

function prepareChemSmartCliSchema({ mode = 'dev' } = {}) {
  const commit = verifySource()
  if (fs.existsSync(outputFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(outputFile, 'utf8'))
      if (cached._meta?.chemsmart_commit === commit && cached._meta?.schema_hash === schemaHash(cached)) {
        return outputFile
      }
    } catch {
      // Regenerate invalid cache.
    }
  }

  fs.mkdirSync(path.dirname(outputFile), { recursive: true })
  const temporary = `${outputFile}.${process.pid}.tmp`
  const exporter = exporterFor(mode)
  execFileSync(exporter.executable, [...exporter.args, 'agent', '_dump-cli-schema', '--out', temporary], {
    cwd: root,
    stdio: 'inherit'
  })
  const document = JSON.parse(fs.readFileSync(temporary, 'utf8'))
  const actualHash = schemaHash(document)
  if (document._meta?.schema_hash !== actualHash) {
    fs.rmSync(temporary, { force: true })
    throw new Error('ChemSmart CLI schema hash validation failed')
  }
  document._meta.chemsmart_commit = commit
  document._meta.exporter = 'chemsmart agent _dump-cli-schema'
  fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o444 })
  fs.renameSync(temporary, outputFile)
  fs.chmodSync(outputFile, 0o444)
  return outputFile
}

module.exports = { exporterFor, prepareChemSmartCliSchema, schemaHash }

if (require.main === module) {
  try {
    prepareChemSmartCliSchema({ mode: process.argv.includes('--portable') ? 'portable' : 'dev' })
  } catch (error) {
    console.error(`Failed to prepare ChemSmart CLI completion manifest: ${error.message}`)
    process.exit(1)
  }
}
