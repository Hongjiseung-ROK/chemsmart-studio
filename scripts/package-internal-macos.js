const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.join(__dirname, '..')
const appPath = path.join(projectRoot, 'dist', 'mac-arm64', 'ChemSmart Studio.app')
const executablePath = path.join(appPath, 'Contents', 'MacOS', 'ChemSmart Studio')
const zipPath = path.join(projectRoot, 'dist', 'ChemSmart-Studio-0.1.0-arm64.zip')
const packageExistingApp = process.argv.includes('--package-existing-app')

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

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('The internal v0.1.0 package must be built on Apple Silicon macOS')
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

run('codesign', ['--force', '--deep', '--sign', '-', appPath])
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])

if (fs.existsSync(zipPath)) {
  fs.rmSync(zipPath)
}
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath])

const zipEntries = run('tar', ['-tf', zipPath], { capture: true }).split('\n').filter(Boolean)
if (!zipEntries.length || zipEntries.some((entry) => !entry.startsWith('ChemSmart Studio.app/'))) {
  throw new Error('Release ZIP contains an entry outside ChemSmart Studio.app')
}

const checksum = run('shasum', ['-a', '256', zipPath], { capture: true }).split(/\s+/)[0]
process.stdout.write(`Artifact: ${zipPath}\nSHA-256: ${checksum}\n`)
