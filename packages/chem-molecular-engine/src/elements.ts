/**
 * Per-element appearance for the 3D scene: Jmol/CPK colour and covalent radius in angstrom.
 *
 * This is deliberately separate from `elementSymbols.ts` in the renderer, which carries Tailwind
 * pill classes chosen for text contrast in light and dark mode. Those are badge colours; these are
 * sphere colours. Sharing one table would force one of the two to be wrong.
 *
 * Colours follow the Jmol CPK convention researchers already read fluently — grey carbon, blue
 * nitrogen, red oxygen — so a structure looks the way it does in every other chemistry tool.
 * Radii are Cordero covalent radii, used to scale the ball-and-stick spheres.
 */

/** Index is the atomic number; index 0 is the unknown-element fallback. */
const CPK_COLORS: readonly number[] = [
  0xff1493, 0xffffff, 0xd9ffff, 0xcc80ff, 0xc2ff00, 0xffb5b5, 0x909090, 0x3050f8, 0xff0d0d, 0x90e050, 0xb3e3f5,
  0xab5cf2, 0x8aff00, 0xbfa6a6, 0xf0c8a0, 0xff8000, 0xffff30, 0x1ff01f, 0x80d1e3, 0x8f40d4, 0x3dff00, 0xe6e6e6,
  0xbfc2c7, 0xa6a6ab, 0x8a99c7, 0x9c7ac7, 0xe06633, 0xf090a0, 0x50d050, 0xc88033, 0x7d80b0, 0xc28f8f, 0x668f8f,
  0xbd80e3, 0xffa100, 0xa62929, 0x5cb8d1, 0x702eb0, 0x00ff00, 0x94ffff, 0x94e0e0, 0x73c2c9, 0x54b5b5, 0x3b9e9e,
  0x248f8f, 0x0a7d8c, 0x006985, 0xc0c0c0, 0xffd98f, 0xa67573, 0x668080, 0x9e63b5, 0xd47a00, 0x940094, 0x429eb0,
  0x57178f, 0x00c900, 0x70d4ff, 0xffffc7, 0xd9ffc7, 0xc7ffc7, 0xa3ffc7, 0x8fffc7, 0x61ffc7, 0x45ffc7, 0x30ffc7,
  0x1fffc7, 0x00ff9c, 0x00e675, 0x00d452, 0x00bf38, 0x00ab24, 0x4dc2ff, 0x4da6ff, 0x2194d6, 0x267dab, 0x266696,
  0x175487, 0xd0d0e0, 0xffd123, 0xb8b8d0, 0xa6544d, 0x575961, 0x9e4fb5, 0xab5c00, 0x754f45, 0x428296, 0x420066,
  0x007d00, 0x70abfa, 0x00baff, 0x00a1ff, 0x008fff, 0x0080ff, 0x006bff, 0x545cf2, 0x785ce3
]

/** Cordero covalent radii in angstrom. Index 0 is the unknown-element fallback. */
const COVALENT_RADII: readonly number[] = [
  0.8, 0.31, 0.28, 1.28, 0.96, 0.84, 0.76, 0.71, 0.66, 0.57, 0.58, 1.66, 1.41, 1.21, 1.11, 1.07, 1.05, 1.02, 1.06, 2.03,
  1.76, 1.7, 1.6, 1.53, 1.39, 1.39, 1.32, 1.26, 1.24, 1.32, 1.22, 1.22, 1.2, 1.19, 1.2, 1.2, 1.16, 2.2, 1.95, 1.9, 1.75,
  1.64, 1.54, 1.47, 1.46, 1.42, 1.39, 1.45, 1.44, 1.42, 1.39, 1.39, 1.38, 1.39, 1.4, 2.44, 2.15, 2.07, 2.04, 2.03, 2.01,
  1.99, 1.98, 1.98, 1.96, 1.94, 1.92, 1.92, 1.89, 1.9, 1.87, 1.87, 1.75, 1.7, 1.62, 1.51, 1.44, 1.41, 1.36, 1.36, 1.32,
  1.45, 1.46, 1.48, 1.4, 1.5, 1.5, 2.6, 2.21, 2.15, 2.06, 2.0, 1.96, 1.9, 1.87, 1.8, 1.69
]

function lookup(table: readonly number[], atomicNumber: number): number {
  return table[atomicNumber] ?? table[0]
}

/** CPK colour as a 0xRRGGBB integer, ready for `THREE.Color.setHex`. */
export function elementColor(atomicNumber: number): number {
  return lookup(CPK_COLORS, atomicNumber)
}

/** Covalent radius in angstrom. */
export function covalentRadius(atomicNumber: number): number {
  return lookup(COVALENT_RADII, atomicNumber)
}

/**
 * Sphere radius for ball-and-stick. Scaled well below the covalent radius so bonds stay visible
 * and the researcher can see through a structure rather than at a solid surface.
 */
export function ballRadius(atomicNumber: number): number {
  return covalentRadius(atomicNumber) * 0.32
}
