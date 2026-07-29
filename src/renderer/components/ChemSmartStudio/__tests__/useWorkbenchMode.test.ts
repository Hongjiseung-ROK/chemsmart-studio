import { describe, expect, it } from 'vitest'

import { workbenchModeContracts, workbenchModes } from '../useWorkbenchMode'

describe('workbenchModeContracts', () => {
  it('covers every mode exactly once', () => {
    expect(Object.keys(workbenchModeContracts).sort()).toEqual([...workbenchModes].sort())
  })

  it('gives each mode its own work instead of one shared surface', () => {
    const fingerprints = workbenchModes.map((mode) => {
      const contract = workbenchModeContracts[mode]
      return [contract.selection, [...contract.allowedOperations].sort().join('+')].join('|')
    })
    // Build, inspect, measure, and constrain must each differ; only the two read-only modes may share ops.
    expect(new Set(fingerprints).size).toBeGreaterThanOrEqual(5)
  })

  it('lets only editing modes propose molecule changes', () => {
    expect(workbenchModeContracts.build.allowedOperations).toContain('add_atoms')
    expect(workbenchModeContracts.build.allowedOperations).toContain('set_atomic_numbers')
    expect(workbenchModeContracts.build.allowedOperations).toContain('set_bond_orders')
    expect(workbenchModeContracts.measure.allowedOperations).toContain('set_positions')
    expect(workbenchModeContracts.constrain.allowedOperations).toContain('set_constraints')

    expect(workbenchModeContracts.inspect.allowedOperations).toEqual([])
    expect(workbenchModeContracts.run.allowedOperations).toEqual([])
    expect(workbenchModeContracts.replay.allowedOperations).toEqual([])
  })

  it('never lets a mode propose an operation another mode owns', () => {
    expect(workbenchModeContracts.build.allowedOperations).not.toContain('set_constraints')
    expect(workbenchModeContracts.constrain.allowedOperations).not.toContain('add_atoms')
    expect(workbenchModeContracts.inspect.allowedOperations).not.toContain('set_positions')
  })

  it('names operations exactly as the patch schema writes them on the wire', () => {
    // Main compares these against `operation.op`, so camelCase definition names would never match.
    for (const mode of workbenchModes) {
      for (const operation of workbenchModeContracts[mode].allowedOperations) {
        expect(operation).toMatch(/^[a-z]+(_[a-z]+)*$/)
      }
    }
  })

  it('reveals the command workbench only for the mode that runs commands', () => {
    const revealing = workbenchModes.filter((mode) => workbenchModeContracts[mode].opensCommandWorkbench)
    expect(revealing).toEqual(['run'])
  })

  it('routes researcher-selected modes to the context sheet that holds their work', () => {
    expect(workbenchModeContracts.run.contextPane).toBe('decisions')
    expect(workbenchModeContracts.replay.contextPane).toBe('decisions')
    expect(workbenchModeContracts.build.contextPane).toBe('properties')
    expect(workbenchModeContracts.measure.contextPane).toBe('properties')
    expect(workbenchModeContracts.constrain.contextPane).toBe('properties')
    expect(workbenchModeContracts.inspect.contextPane).toBe('properties')
  })
})
