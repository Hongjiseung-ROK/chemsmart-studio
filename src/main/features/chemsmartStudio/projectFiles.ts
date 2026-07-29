import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

import {
  manifestRuntimeSchema,
  type MoleculeDocument,
  moleculeDocumentRuntimeSchema,
  type ProjectManifest
} from '@chemsmart/studio-protocol'
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'

const PROJECT_EXTENSION = '.cmsproj'
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_MOLECULE_BYTES = 128 * 1024 * 1024
const MAX_IMPORT_BYTES = 128 * 1024 * 1024
const SUPPORTED_IMPORT_EXTENSIONS = new Set(['.cjson', '.sdf', '.xyz'])

const runtimeValidator = new CfWorkerJsonSchemaValidator({ draft: '2020-12', shortcircuit: false })
const manifestValidator = runtimeValidator.getValidator<ProjectManifest>(manifestRuntimeSchema as JsonSchemaType)
const moleculeValidator = runtimeValidator.getValidator<MoleculeDocument>(
  moleculeDocumentRuntimeSchema as JsonSchemaType
)

export interface ProjectBundleInfo {
  projectPath: string
  activeRunId: string | null
  manifest: ProjectManifest
  document: MoleculeDocument
}

function invalidProject(message: string): Error {
  return new Error(`Invalid ChemSmart Studio project: ${message}`)
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function requireRegularFile(filePath: string, name: string): Promise<number> {
  const stat = await lstat(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw invalidProject(`${name} must be a regular file`)
  return stat.size
}

function validateMoleculeSemantics(document: MoleculeDocument): void {
  const atomIds = new Set(document.atoms.map((atom) => atom.id))
  if (atomIds.size !== document.atoms.length) throw invalidProject('molecule.json contains duplicate atom ids')
  const bondIds = new Set<string>()
  const bondedPairs = new Set<string>()
  for (const bond of document.bonds) {
    if (bondIds.has(bond.id)) throw invalidProject('molecule.json contains duplicate bond ids')
    bondIds.add(bond.id)
    const [first, second] = bond.atomIds
    if (first === second || !atomIds.has(first) || !atomIds.has(second)) {
      throw invalidProject('molecule.json contains a bond with invalid atom references')
    }
    const pair = [first, second].sort().join('\0')
    if (bondedPairs.has(pair)) throw invalidProject('molecule.json contains duplicate bonded atom pairs')
    bondedPairs.add(pair)
  }
  if (document.selections.some((atomId) => !atomIds.has(atomId))) {
    throw invalidProject('molecule.json selection references an unknown atom')
  }
  if (Object.keys(document.frozenAxes).some((atomId) => !atomIds.has(atomId))) {
    throw invalidProject('molecule.json frozen axes reference an unknown atom')
  }
  const constraintIds = new Set<string>()
  for (const constraint of document.constraints) {
    if (
      constraintIds.has(constraint.id) ||
      constraint.atomIds.some((atomId) => !atomIds.has(atomId)) ||
      new Set(constraint.atomIds).size !== constraint.atomIds.length
    ) {
      throw invalidProject('molecule.json contains an invalid constraint reference')
    }
    constraintIds.add(constraint.id)
  }
}

export function validateProjectState(
  manifest: unknown,
  document: unknown
): {
  manifest: ProjectManifest
  document: MoleculeDocument
} {
  const manifestResult = manifestValidator(manifest)
  if (!manifestResult.valid) throw invalidProject('manifest.json does not match the protocol')
  const moleculeResult = moleculeValidator(document)
  if (!moleculeResult.valid) throw invalidProject('molecule.json does not match the protocol')
  const verifiedManifest = manifest as ProjectManifest
  const verifiedDocument = document as MoleculeDocument
  validateMoleculeSemantics(verifiedDocument)
  if (
    verifiedManifest.documentId !== verifiedDocument.documentId ||
    verifiedManifest.currentRevision !== verifiedDocument.revision
  ) {
    throw invalidProject('manifest.json and molecule.json identify different revisions')
  }
  return { manifest: verifiedManifest, document: verifiedDocument }
}

export function normalizeProjectPath(candidate: string): string {
  const resolved = path.resolve(candidate)
  return resolved.toLowerCase().endsWith(PROJECT_EXTENSION) ? resolved : `${resolved}${PROJECT_EXTENSION}`
}

export function projectDisplayName(projectPath: string): string {
  const name = path.basename(projectPath)
  return name.toLowerCase().endsWith(PROJECT_EXTENSION) ? name.slice(0, -PROJECT_EXTENSION.length) : name
}

/**
 * An opaque, stable handle for a project. A renderer needs to tell projects apart — and name one it
 * wants back — without ever learning where it lives, so this is a digest of the path rather than the
 * path or any fragment of it. Stable across restarts because it is derived, not minted.
 */
export function projectHandleId(projectPath: string): string {
  return `project-${createHash('sha256').update(path.resolve(projectPath)).digest('hex').slice(0, 32)}`
}

export async function prepareNewProjectPath(requestedPath: string): Promise<string> {
  const target = normalizeProjectPath(requestedPath)
  if (await pathExists(target)) throw new Error('The selected project already exists')
  await mkdir(path.dirname(target), { recursive: true })
  return target
}

export async function validateImportFile(filePath: string): Promise<string> {
  const sourceStat = await lstat(filePath)
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error('The selected molecule must be a regular file')
  }
  const resolved = await realpath(filePath)
  const stat = await lstat(resolved)
  if (!stat.isFile()) throw new Error('The selected molecule must be a regular file')
  if (!SUPPORTED_IMPORT_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
    throw new Error('The selected molecule format is unsupported')
  }
  if (stat.size === 0) throw new Error('The selected molecule file is empty')
  if (stat.size > MAX_IMPORT_BYTES) throw new Error('The selected molecule file is too large')
  return resolved
}

export async function validateProjectBundle(projectPath: string): Promise<ProjectBundleInfo> {
  const sourceStat = await lstat(projectPath)
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw invalidProject('the package must be a real directory')
  }
  const resolved = await realpath(projectPath)
  const rootStat = await lstat(resolved)
  if (!rootStat.isDirectory()) throw invalidProject('the package must be a real directory')

  const manifestPath = path.join(resolved, 'manifest.json')
  const moleculePath = path.join(resolved, 'molecule.json')
  const manifestSize = await requireRegularFile(manifestPath, 'manifest.json')
  const moleculeSize = await requireRegularFile(moleculePath, 'molecule.json')
  if (manifestSize > MAX_MANIFEST_BYTES) throw invalidProject('manifest.json is too large')
  if (moleculeSize > MAX_MOLECULE_BYTES) throw invalidProject('molecule.json is too large')

  let manifest: unknown
  let document: unknown
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    throw invalidProject('manifest.json is malformed')
  }
  try {
    document = JSON.parse(await readFile(moleculePath, 'utf8'))
  } catch {
    throw invalidProject('molecule.json is malformed')
  }
  const verified = validateProjectState(manifest, document)
  return {
    projectPath: resolved,
    activeRunId: verified.manifest.activeRunId,
    manifest: verified.manifest,
    document: verified.document
  }
}
