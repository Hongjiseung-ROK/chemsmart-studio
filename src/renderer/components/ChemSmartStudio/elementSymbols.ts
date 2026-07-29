/**
 * Element symbols by atomic number, and the CPK-derived pill colours the coordinate table and the
 * periodic table share. These are data-visualization colours, not semantic state colours, so they live
 * here rather than in the theme tokens — and each pair is checked for readable contrast in both modes.
 */
const symbols = [
  'H',
  'He',
  'Li',
  'Be',
  'B',
  'C',
  'N',
  'O',
  'F',
  'Ne',
  'Na',
  'Mg',
  'Al',
  'Si',
  'P',
  'S',
  'Cl',
  'Ar',
  'K',
  'Ca',
  'Sc',
  'Ti',
  'V',
  'Cr',
  'Mn',
  'Fe',
  'Co',
  'Ni',
  'Cu',
  'Zn',
  'Ga',
  'Ge',
  'As',
  'Se',
  'Br',
  'Kr',
  'Rb',
  'Sr',
  'Y',
  'Zr',
  'Nb',
  'Mo',
  'Tc',
  'Ru',
  'Rh',
  'Pd',
  'Ag',
  'Cd',
  'In',
  'Sn',
  'Sb',
  'Te',
  'I',
  'Xe',
  'Cs',
  'Ba',
  'La',
  'Ce',
  'Pr',
  'Nd',
  'Pm',
  'Sm',
  'Eu',
  'Gd',
  'Tb',
  'Dy',
  'Ho',
  'Er',
  'Tm',
  'Yb',
  'Lu',
  'Hf',
  'Ta',
  'W',
  'Re',
  'Os',
  'Ir',
  'Pt',
  'Au',
  'Hg',
  'Tl',
  'Pb',
  'Bi',
  'Po',
  'At',
  'Rn',
  'Fr',
  'Ra',
  'Ac',
  'Th',
  'Pa',
  'U',
  'Np',
  'Pu',
  'Am',
  'Cm',
  'Bk',
  'Cf',
  'Es',
  'Fm',
  'Md',
  'No',
  'Lr',
  'Rf',
  'Db',
  'Sg',
  'Bh',
  'Hs',
  'Mt',
  'Ds',
  'Rg',
  'Cn',
  'Nh',
  'Fl',
  'Mc',
  'Lv',
  'Ts',
  'Og'
] as const

export const MAX_ATOMIC_NUMBER = symbols.length

/** Common building elements, offered first in the element picker. */
export const commonAtomicNumbers = [1, 6, 7, 8, 9, 15, 16, 17, 35, 53] as const

export function elementSymbol(atomicNumber: number): string {
  return symbols[atomicNumber - 1] ?? String(atomicNumber)
}

const elementGroups = {
  hydrogen: [1],
  carbon: [6],
  nitrogen: [7],
  oxygen: [8],
  halogen: [9, 17, 35, 53, 85],
  phosphorus: [15],
  sulfur: [16]
} as const

const groupClassName = {
  carbon: 'bg-secondary text-secondary-foreground',
  halogen: 'bg-success/15 text-success',
  hydrogen: 'bg-background-subtle text-foreground-secondary',
  nitrogen: 'bg-info/15 text-info',
  other: 'bg-muted text-foreground-secondary',
  oxygen: 'bg-destructive/15 text-destructive',
  phosphorus: 'bg-warning/15 text-warning',
  sulfur: 'bg-warning/20 text-warning'
} as const

/** Pill classes for one element, keyed off the token set so both themes stay readable. */
export function elementPillClassName(atomicNumber: number): string {
  for (const [group, numbers] of Object.entries(elementGroups)) {
    if ((numbers as readonly number[]).includes(atomicNumber)) {
      return groupClassName[group as keyof typeof groupClassName]
    }
  }
  return groupClassName.other
}
