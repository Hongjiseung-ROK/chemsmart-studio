const { Arch } = require('electron-builder')
const { execFileSync, execSync } = require('child_process')
const { createHash } = require('crypto')
const fs = require('fs')
const path = require('path')
const { parse, stringify } = require('yaml')

const projectRoot = path.join(__dirname, '..')
const workspaceConfigPath = path.join(__dirname, '..', 'pnpm-workspace.yaml')

// if you want to add new prebuild binaries packages with different architectures, you can add them here
// please add to allX64 and allArm64 from pnpm-lock.yaml
const packages = [
  '@anthropic-ai/claude-agent-sdk-darwin-arm64',
  '@anthropic-ai/claude-agent-sdk-darwin-x64',
  '@anthropic-ai/claude-agent-sdk-linux-arm64',
  '@anthropic-ai/claude-agent-sdk-linux-arm64-musl',
  '@anthropic-ai/claude-agent-sdk-linux-x64',
  '@anthropic-ai/claude-agent-sdk-linux-x64-musl',
  '@anthropic-ai/claude-agent-sdk-win32-arm64',
  '@anthropic-ai/claude-agent-sdk-win32-x64',
  '@img/sharp-darwin-arm64',
  '@img/sharp-darwin-x64',
  '@img/sharp-libvips-darwin-arm64',
  '@img/sharp-libvips-darwin-x64',
  '@img/sharp-libvips-linux-arm64',
  '@img/sharp-libvips-linuxmusl-arm64',
  '@img/sharp-libvips-linux-x64',
  '@img/sharp-libvips-linuxmusl-x64',
  '@img/sharp-linux-arm64',
  '@img/sharp-linux-x64',
  '@img/sharp-linuxmusl-arm64',
  '@img/sharp-linuxmusl-x64',
  '@img/sharp-win32-arm64',
  '@img/sharp-win32-x64',
  '@napi-rs/system-ocr-darwin-arm64',
  '@napi-rs/system-ocr-darwin-x64',
  '@napi-rs/system-ocr-win32-arm64-msvc',
  '@napi-rs/system-ocr-win32-x64-msvc',
  '@napi-rs/canvas-linux-x64-gnu',
  '@napi-rs/canvas-linux-x64-musl',
  '@napi-rs/canvas-linux-arm64-gnu',
  '@napi-rs/canvas-linux-arm64-musl',
  '@napi-rs/canvas-darwin-x64',
  '@napi-rs/canvas-darwin-arm64',
  '@napi-rs/canvas-win32-x64-msvc',
  '@napi-rs/canvas-win32-arm64-msvc',
  // sqlite-vec prebuilt extensions (vec0.dylib/.so/.dll), from the @aiany/sqlite-vec fork
  // which adds a windows-arm64 build (upstream ships none). Note the package names use
  // `windows`, not `win32` — see platformTokens below for why the keep-filter must match both.
  '@aiany/sqlite-vec-darwin-arm64',
  '@aiany/sqlite-vec-darwin-x64',
  '@aiany/sqlite-vec-linux-arm64',
  '@aiany/sqlite-vec-linux-x64',
  '@aiany/sqlite-vec-windows-arm64',
  '@aiany/sqlite-vec-windows-x64'
]

const platformToArch = {
  mac: 'darwin',
  windows: 'win32',
  linux: 'linux',
  linuxmusl: 'linuxmusl'
}

const electronNativeModules = ['better-sqlite3', '@paymoapp/electron-shutdown-handler']

function buildElectronRebuildInvocation(context, arch) {
  const cli = path.join(path.dirname(require.resolve('@electron/rebuild')), 'cli.js')
  return {
    executable: process.execPath,
    args: [
      cli,
      '--version',
      context.packager.config.electronVersion,
      '--module-dir',
      projectRoot,
      '--arch',
      arch,
      '--only',
      electronNativeModules.join(','),
      '--sequential',
      '--force'
    ],
    options: {
      cwd: projectRoot,
      stdio: 'inherit'
    }
  }
}

function prepareElectronNativeModules(context, platform, arch, runner = execFileSync) {
  if (platform !== process.platform) return false

  const invocation = buildElectronRebuildInvocation(context, arch)
  runner(invocation.executable, invocation.args, invocation.options)
  context.packager.config.npmRebuild = false
  return true
}

function splitLockPackageKey(key) {
  const withoutPeers = key.replace(/\(.+\)$/, '')
  const separator = withoutPeers.lastIndexOf('@')
  if (separator <= 0) return null
  const name = withoutPeers.slice(0, separator)
  const version = withoutPeers.slice(separator + 1)
  if (!name || !/^\d/.test(version)) return null
  return { name, version }
}

function writeStudioComplianceArtifacts(identityConfigured) {
  const root = path.join(__dirname, '..')
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const lockBytes = fs.readFileSync(path.join(root, 'pnpm-lock.yaml'))
  const lock = parse(lockBytes.toString('utf8'))
  const upstreamLock = JSON.parse(fs.readFileSync(path.join(root, 'upstreams.lock.json'), 'utf8'))
  const dependencyComponents = [...new Set(Object.keys(lock.packages || {}))]
    .map(splitLockPackageKey)
    .filter(Boolean)
    .map(({ name, version }) => {
      const purlName = name.split('/').map(encodeURIComponent).join('/')
      return {
        type: 'library',
        name,
        version,
        purl: `pkg:npm/${purlName}@${encodeURIComponent(version)}`
      }
    })
  const upstreamComponents = Object.entries(upstreamLock.upstreams).map(([name, upstream]) => ({
    type: 'library',
    name,
    version: upstream.commit,
    externalReferences: [{ type: 'vcs', url: `${upstream.url}#${upstream.commit}` }],
    licenses: [{ license: { id: upstream.license } }]
  }))
  const complianceDirectory = path.join(root, 'build', 'compliance')
  fs.mkdirSync(complianceDirectory, { recursive: true })
  fs.writeFileSync(
    path.join(complianceDirectory, 'studio-sbom.cdx.json'),
    JSON.stringify(
      {
        bomFormat: 'CycloneDX',
        specVersion: '1.5',
        version: 1,
        metadata: {
          component: {
            type: 'application',
            name: 'ChemSmart Studio',
            version: packageJson.version,
            licenses: [{ license: { id: 'AGPL-3.0-only' } }]
          },
          properties: [
            { name: 'chemsmart:pnpm-lock:sha256', value: createHash('sha256').update(lockBytes).digest('hex') },
            { name: 'chemsmart:upstream-audit-date', value: upstreamLock.auditDate }
          ]
        },
        components: [...upstreamComponents, ...dependencyComponents]
      },
      null,
      2
    )
  )

  const sourceUrl = process.env.CHEMSMART_STUDIO_SOURCE_URL?.trim() || null
  if (identityConfigured && !sourceUrl) {
    throw new Error('CHEMSMART_STUDIO_SOURCE_URL is required for a signed release candidate')
  }
  fs.writeFileSync(
    path.join(complianceDirectory, 'corresponding-source.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        product: 'ChemSmart Studio',
        sourceUrl,
        status: sourceUrl ? 'available' : 'required-before-release',
        upstreamLockSha256: createHash('sha256')
          .update(fs.readFileSync(path.join(root, 'upstreams.lock.json')))
          .digest('hex')
      },
      null,
      2
    )
  )
}

exports.default = async function (context) {
  const arch = context.arch === Arch.arm64 ? 'arm64' : 'x64'
  const platformName = context.packager.platform.name
  const platform = platformToArch[platformName]
  const identity = process.env.CSC_NAME?.trim()

  prepareElectronNativeModules(context, platform, arch)
  writeStudioComplianceArtifacts(Boolean(identity))

  console.log(`Downloading bundled binaries for ${platform}-${arch}...`)
  execSync(`node "${path.join(__dirname, 'download-binaries.js')}" ${platform} ${arch}`, { stdio: 'inherit' })
  // Fail the build rather than ship a half-empty resources/binaries/<platform>.
  require('./download-binaries').verifyBundledBinaries(platform, arch)
  if (platform === 'darwin' && arch === 'arm64') {
    execFileSync(process.execPath, [path.join(__dirname, 'prepare-chemsmart-bridge.js')], { stdio: 'inherit' })
    execFileSync(process.execPath, [path.join(__dirname, 'prepare-chemsmart-cli-schema.js'), '--portable'], {
      stdio: 'inherit'
    })
  }

  const downloadPackages = async () => {
    // Skip if target platform and architecture match current system
    if (platform === process.platform && arch === process.arch) {
      console.log(`Skipping install: target (${platform}/${arch}) matches current system`)
      return
    }

    console.log(`Installing packages for target platform=${platform} arch=${arch}...`)

    // Backup and modify pnpm-workspace.yaml to add target platform support
    const originalWorkspaceConfig = fs.readFileSync(workspaceConfigPath, 'utf-8')
    const workspaceConfig = parse(originalWorkspaceConfig)

    // Add target platform to supportedArchitectures.os
    if (!workspaceConfig.supportedArchitectures.os.includes(platform)) {
      workspaceConfig.supportedArchitectures.os.push(platform)
    }

    // Add target architecture to supportedArchitectures.cpu
    if (!workspaceConfig.supportedArchitectures.cpu.includes(arch)) {
      workspaceConfig.supportedArchitectures.cpu.push(arch)
    }

    const modifiedWorkspaceConfig = stringify(workspaceConfig)
    console.log('Modified workspace config:', modifiedWorkspaceConfig)
    fs.writeFileSync(workspaceConfigPath, modifiedWorkspaceConfig)

    try {
      execSync(`pnpm install`, { stdio: 'inherit' })
    } finally {
      // Restore original pnpm-workspace.yaml
      fs.writeFileSync(workspaceConfigPath, originalWorkspaceConfig)
    }
  }

  await downloadPackages()

  const excludePackages = async (packagesToExclude) => {
    // 从项目根目录的 electron-builder.yml 读取 files 配置，避免多次覆盖配置导致出错
    const electronBuilderConfigPath = path.join(__dirname, '..', 'electron-builder.yml')
    const electronBuilderConfig = parse(fs.readFileSync(electronBuilderConfigPath, 'utf-8'))
    let filters = electronBuilderConfig.files

    // add filters for other architectures (exclude them)
    filters.push(...packagesToExclude)

    context.packager.config.files[0].filter = filters
  }

  // Most native packages encode Electron's platform key (win32) in their name, but some
  // (e.g. sqlite-vec) use the npm `windows` convention. Match either so a win32 build keeps
  // sqlite-vec-windows-x64 instead of wrongly excluding it.
  const platformTokens = platform === 'win32' ? ['win32', 'windows'] : [platform]
  const matchesPlatform = (p) => platformTokens.some((t) => p.includes(t))

  const arm64KeepPackages = packages.filter((p) => p.includes('arm64') && matchesPlatform(p))
  const arm64ExcludePackages = packages
    .filter((p) => !arm64KeepPackages.includes(p))
    .map((p) => '!node_modules/' + p + '/**')

  const x64KeepPackages = packages.filter((p) => p.includes('x64') && matchesPlatform(p))
  const x64ExcludePackages = packages
    .filter((p) => !x64KeepPackages.includes(p))
    .map((p) => '!node_modules/' + p + '/**')

  const currentPlatformKey = `${platform}-${arch}`
  // win32-arm64 is in this list so `build:win` (--x64 --arm64) can package it. The
  // @aiany/sqlite-vec fork provides a windows-arm64 vec0.dll, so knowledge-base vector
  // search works on that target too.
  const allBinaryPlatforms = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64']
  const excludeBundledBinaryFilters = allBinaryPlatforms
    .filter((p) => p !== currentPlatformKey)
    .map((p) => '!resources/binaries/' + p + '/**')

  if (context.arch === Arch.arm64) {
    await excludePackages([...arm64ExcludePackages, ...excludeBundledBinaryFilters])
  } else {
    await excludePackages([...x64ExcludePackages, ...excludeBundledBinaryFilters])
  }
}

exports.buildElectronRebuildInvocation = buildElectronRebuildInvocation
exports.prepareElectronNativeModules = prepareElectronNativeModules
