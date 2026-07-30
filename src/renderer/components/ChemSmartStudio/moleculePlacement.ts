import type { MoleculeDocument, StagePlacementPreview } from '@chemsmart/studio-protocol'

/** Matches main's geometry identity: stable atom id, element and coordinates only. */
export async function moleculeGeometryHash(document: MoleculeDocument): Promise<string> {
  const rows = [...document.atoms]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((atom) => [atom.id, atom.atomicNumber, atom.position])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rows)))
  const hexadecimal = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `sha256:${hexadecimal}`
}

export function cyclePlacementSite(preview: StagePlacementPreview, direction: 1 | -1): StagePlacementPreview {
  const safe = preview.candidates
    .filter((candidate) => candidate.safe)
    .sort((left, right) => left.siteIndex - right.siteIndex)
  if (safe.length === 0) return preview
  const current = Math.max(
    0,
    safe.findIndex((candidate) => candidate.siteIndex === preview.selectedSiteIndex)
  )
  const next = (current + direction + safe.length) % safe.length
  return { ...preview, selectedSiteIndex: safe[next].siteIndex }
}
