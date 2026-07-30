import type { MoleculeDocument, StudioAgentActionCue, Vector3 } from '@chemsmart/studio-protocol'

export type OverlaySegmentKind = 'action' | 'angle' | 'dihedral' | 'distance' | 'frozen-axis'

export interface MoleculeOverlaySegment {
  id: string
  kind: OverlaySegmentKind
  start: Vector3
  end: Vector3
  color: number
  dashed: boolean
}

export interface MoleculeOverlayMarker {
  id: string
  atomId: string
  position: Vector3
  color: number
  running: boolean
}

export interface MoleculeOverlayLabel {
  id: string
  position: Vector3
  text: string
}

export interface MoleculeOverlayScene {
  segments: MoleculeOverlaySegment[]
  markers: MoleculeOverlayMarker[]
  labels: MoleculeOverlayLabel[]
}

const AXES: readonly Vector3[] = [
  [0.35, 0, 0],
  [0, 0.35, 0],
  [0, 0, 0.35]
]
const AXIS_COLORS = [0xf05b61, 0x58ad73, 0x5a8dee] as const

const midpoint = (left: Vector3, right: Vector3): Vector3 => [
  (left[0] + right[0]) / 2,
  (left[1] + right[1]) / 2,
  (left[2] + right[2]) / 2
]

const add = (left: Vector3, right: Vector3): Vector3 => [left[0] + right[0], left[1] + right[1], left[2] + right[2]]

/** Builds topology-independent constraint and Agent cues without modifying molecule selection. */
export function buildMoleculeOverlayScene(
  document: MoleculeDocument,
  actionCues: readonly StudioAgentActionCue[] = []
): MoleculeOverlayScene {
  const atoms = new Map(document.atoms.map((atom) => [atom.id, atom.position]))
  const bonds = new Map(document.bonds.map((bond) => [bond.id, bond]))
  const segments: MoleculeOverlaySegment[] = []
  const markers: MoleculeOverlayMarker[] = []
  const labels: MoleculeOverlayLabel[] = []

  for (const [atomId, mask] of Object.entries(document.frozenAxes)) {
    const position = atoms.get(atomId)
    if (!position) continue
    mask.forEach((frozen, axis) => {
      if (!frozen) return
      segments.push({
        id: `frozen-${atomId}-${axis}`,
        kind: 'frozen-axis',
        start: position,
        end: add(position, AXES[axis]),
        color: AXIS_COLORS[axis],
        dashed: false
      })
    })
  }

  for (const constraint of document.constraints) {
    const positions = constraint.atomIds.map((atomId) => atoms.get(atomId)).filter((position) => position !== undefined)
    if (positions.length !== constraint.atomIds.length || positions.length < 2) continue
    for (let index = 1; index < positions.length; index += 1) {
      segments.push({
        id: `${constraint.id}-${index}`,
        kind: constraint.type,
        start: positions[index - 1],
        end: positions[index],
        color: 0x58a6ff,
        dashed: constraint.type === 'distance'
      })
    }
    labels.push({
      id: `label-${constraint.id}`,
      position: midpoint(positions[0], positions.at(-1) ?? positions[0]),
      text: `${constraint.target} ${constraint.unit === 'angstrom' ? 'Å' : '°'}`
    })
  }

  for (const cue of actionCues) {
    for (const atomId of cue.atomIds) {
      const position = atoms.get(atomId)
      if (!position) continue
      markers.push({
        id: `${cue.cueId}-${atomId}`,
        atomId,
        position,
        color: cue.phase === 'failed' ? 0xef4444 : cue.phase === 'succeeded' ? 0x22c55e : 0x58a6ff,
        running: cue.phase === 'running'
      })
    }
    for (const bondId of cue.bondIds) {
      const bond = bonds.get(bondId)
      if (!bond) continue
      const start = atoms.get(bond.atomIds[0])
      const end = atoms.get(bond.atomIds[1])
      if (!start || !end) continue
      segments.push({
        id: `${cue.cueId}-${bondId}`,
        kind: 'action',
        start,
        end,
        color: cue.phase === 'failed' ? 0xef4444 : cue.phase === 'succeeded' ? 0x22c55e : 0x58a6ff,
        dashed: false
      })
    }
  }

  return { segments, markers, labels }
}
