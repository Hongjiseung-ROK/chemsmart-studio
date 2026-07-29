const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.join(__dirname, '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
const version = packageJson.version
const appPath = path.join(projectRoot, 'dist', 'mac-arm64', 'ChemSmart Studio.app')
const executablePath = path.join(appPath, 'Contents', 'MacOS', 'ChemSmart Studio')
const zipPath = path.join(projectRoot, 'dist', `ChemSmart-Studio-${version}-arm64.zip`)
const manifestPath = path.join(projectRoot, 'dist', `ChemSmart-Studio-${version}-app-manifest.json`)
const packageExistingApp = process.argv.includes('--package-existing-app')
const forbiddenPackagePatterns = [
  /(^|\/)var\/agent-training(\/|$)/,
  /(^|\/)agent-training(\/|$)/,
  /(^|\/)api\.env$/,
  /(^|\/)\.env$/
]

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    maxBuffer: 64 * 1024 * 1024
  })
  if (result.status !== 0) {
    const detail = options.capture ? `${result.stdout || ''}${result.stderr || ''}`.trim() : ''
    throw new Error(`${command} failed with status ${result.status}${detail ? `\n${detail}` : ''}`)
  }
  return options.capture ? result.stdout.trim() : ''
}

function buildAppManifest(rootPath) {
  const entries = []
  const visit = (directory) => {
    const names = fs.readdirSync(directory).sort()
    for (const name of names) {
      const absolutePath = path.join(directory, name)
      const relativePath = path.relative(rootPath, absolutePath).split(path.sep).join('/')
      const stats = fs.lstatSync(absolutePath)
      if (stats.isDirectory()) {
        entries.push({ path: relativePath, type: 'directory', mode: stats.mode & 0o777 })
        visit(absolutePath)
      } else if (stats.isSymbolicLink()) {
        entries.push({
          path: relativePath,
          type: 'symlink',
          mode: stats.mode & 0o777,
          target: fs.readlinkSync(absolutePath)
        })
      } else {
        entries.push({
          path: relativePath,
          type: 'file',
          mode: stats.mode & 0o777,
          size: stats.size,
          sha256: createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex')
        })
      }
    }
  }
  visit(rootPath)
  return entries
}

function assertPackageContents(entries) {
  const forbidden = entries
    .map((entry) => entry.path)
    .filter((entryPath) => forbiddenPackagePatterns.some((pattern) => pattern.test(entryPath)))
  if (forbidden.length > 0) {
    throw new Error(`Release application contains forbidden private runtime data: ${forbidden.join(', ')}`)
  }
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error(`The internal v${version} package must be built on Apple Silicon macOS`)
}

if (!packageExistingApp) {
  run('pnpm', ['build'])
  run('pnpm', ['exec', 'electron-builder', '--dir', '--mac', '--arm64'])
}

if (!fs.existsSync(executablePath)) {
  throw new Error(`Packaged application executable not found: ${executablePath}`)
}

const architectures = run('lipo', ['-archs', executablePath], { capture: true }).split(/\s+/)
if (architectures.length !== 1 || architectures[0] !== 'arm64') {
  throw new Error(`Expected one arm64 executable, found: ${architectures.join(', ')}`)
}

assertPackageContents(buildAppManifest(appPath))
run('codesign', ['--force', '--deep', '--sign', '-', appPath])
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
const signedManifest = {
  schemaVersion: 1,
  product: 'ChemSmart Studio',
  version,
  architecture: 'arm64',
  entries: buildAppManifest(appPath)
}
assertPackageContents(signedManifest.entries)
fs.writeFileSync(manifestPath, `${JSON.stringify(signedManifest, null, 2)}\n`, { mode: 0o600 })

if (fs.existsSync(zipPath)) {
  fs.rmSync(zipPath)
}
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath])

const zipEntries = run('tar', ['-tf', zipPath], { capture: true }).split('\n').filter(Boolean)
if (!zipEntries.length || zipEntries.some((entry) => !entry.startsWith('ChemSmart Studio.app/'))) {
  throw new Error('Release ZIP contains an entry outside ChemSmart Studio.app')
}

const checksum = run('shasum', ['-a', '256', zipPath], { capture: true }).split(/\s+/)[0]
process.stdout.write(`Artifact: ${zipPath}\nManifest: ${manifestPath}\nSHA-256: ${checksum}\n`)
