import { createHash } from 'node:crypto'

import type { MoleculeDocument, PreparedControlledCalculation } from '@chemsmart/studio-protocol'

const elementSymbols =
  ' H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split(
    ' '
  )
const atomicNumbers = new Map(elementSymbols.map((symbol, atomicNumber) => [symbol.toLowerCase(), atomicNumber]))

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function digestJson(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

export function moleculeGeometryHash(document: MoleculeDocument): string {
  const geometry = document.atoms
    .map((atom) => [atom.id, atom.atomicNumber, atom.position] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `sha256:${createHash('sha256').update(JSON.stringify(geometry)).digest('hex')}`
}

export function preparedPlanDigestPayload(
  plan: Omit<PreparedControlledCalculation, 'planDigest' | 'state'> | PreparedControlledCalculation
) {
  return Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'planDigest' && key !== 'state'))
}

export function elementSymbolForAtomicNumber(atomicNumber: number): string {
  const symbol = elementSymbols[atomicNumber]
  if (!symbol) throw new Error('Atomic number is outside the supported periodic table')
  return symbol
}

export function atomicNumberForElementSymbol(symbol: string): number {
  const atomicNumber = atomicNumbers.get(symbol.toLowerCase())
  if (!atomicNumber) throw new Error('xTB trajectory contains an unknown element symbol')
  return atomicNumber
}
