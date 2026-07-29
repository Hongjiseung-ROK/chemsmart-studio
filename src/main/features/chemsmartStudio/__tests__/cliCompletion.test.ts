import { describe, expect, it } from 'vitest'

import type { CliCommand, CliOption } from '../cliCompletion'
import { explainToken, resolveCompletions, tokenize } from '../cliCompletion'

function option(opts: string[], name: string, help: string, extra: Partial<CliOption> = {}): CliOption {
  return { name, opts, help, choices: null, is_flag: false, required: false, type: 'str', ...extra }
}

function command(name: string, description: string, options: CliOption[], subcommands: CliCommand[] = []): CliCommand {
  return {
    name,
    description,
    options,
    subcommands: Object.fromEntries(subcommands.map((child) => [child.name, child]))
  }
}

/**
 * Mirrors the real overloading, verified in the chemsmart source:
 * `-m` is `--mem-gb` at run level (cli/jobrunner.py) but `--multiplicity` at program level
 * (cli/gaussian/gaussian.py); `-p` is `--project` for gaussian but `--printlevel` for orca irc
 * (cli/orca/irc.py). Getting these wrong is not a cosmetic completion bug — it is a researcher
 * setting a multiplicity when they meant to ask for memory.
 */
const schema: CliCommand = command(
  'chemsmart',
  'ChemSmart command line.',
  [],
  [
    command(
      'run',
      'Run a job locally.',
      [option(['-m', '--mem-gb'], 'mem_gb', 'Memory in GB.', { type: 'int' })],
      [
        command(
          'gaussian',
          'Run a Gaussian calculation.',
          [
            option(['-m', '--multiplicity'], 'multiplicity', 'Multiplicity of the molecule.', { type: 'int' }),
            option(['-c', '--charge'], 'charge', 'Charge of the molecule.', { type: 'int' }),
            option(['-p', '--project'], 'project', 'Project settings.'),
            option(['-f', '--filename'], 'filename', 'Input file name.')
          ],
          [
            command('opt', 'CLI subcommand for running Gaussian optimization.', []),
            command('ts', 'CLI subcommand for running Gaussian transition state calculation.', [
              option(['-f', '--freeze-atoms'], 'freeze_atoms', 'Indices of atoms to freeze. 1-indexed.')
            ])
          ]
        ),
        command(
          'orca',
          'Run an ORCA calculation.',
          [option(['-p', '--printlevel'], 'printlevel', 'Print level.', { type: 'int' })],
          []
        )
      ]
    ),
    command(
      'sub',
      'Submit a job to a scheduler.',
      [
        option(['-s', '--server'], 'server', 'Server to submit to.', {
          choices: ['slurm', 'pbs', 'local']
        })
      ],
      []
    )
  ]
)

describe('tokenize', () => {
  it('keeps a quoted run together so a path with a space stays one token', () => {
    expect(tokenize('chemsmart run -f "my file.xyz"').map((token) => token.text)).toEqual([
      'chemsmart',
      'run',
      '-f',
      'my file.xyz'
    ])
  })

  it('records where each token starts so a completion can replace it in place', () => {
    expect(tokenize('  chemsmart  run')).toEqual([
      { text: 'chemsmart', start: 2 },
      { text: 'run', start: 13 }
    ])
  })
})

describe('resolveCompletions — level-sensitive short flags', () => {
  it('reads -m as memory at run level', () => {
    const line = 'chemsmart run -m'
    const result = resolveCompletions(schema, line, line.length)

    expect(result.commandPath).toEqual(['chemsmart', 'run'])
    expect(result.completions).toContainEqual({
      value: '-m',
      kind: 'option',
      detail: 'Memory in GB.',
      expandsTo: '--mem-gb'
    })
  })

  it('reads the same -m as multiplicity at program level', () => {
    const line = 'chemsmart run gaussian -m'
    const result = resolveCompletions(schema, line, line.length)

    expect(result.commandPath).toEqual(['chemsmart', 'run', 'gaussian'])
    expect(result.completions).toContainEqual({
      value: '-m',
      kind: 'option',
      detail: 'Multiplicity of the molecule.',
      expandsTo: '--multiplicity'
    })
    // The run-level meaning must not leak down, or the researcher reads the wrong one.
    expect(result.completions.map((entry) => entry.expandsTo)).not.toContain('--mem-gb')
  })

  it('reads -p as project for gaussian and print level for orca', () => {
    const gaussian = 'chemsmart run gaussian -p'
    const orca = 'chemsmart run orca -p'

    expect(resolveCompletions(schema, gaussian, gaussian.length).completions).toContainEqual({
      value: '-p',
      kind: 'option',
      detail: 'Project settings.',
      expandsTo: '--project'
    })
    expect(resolveCompletions(schema, orca, orca.length).completions).toContainEqual({
      value: '-p',
      kind: 'option',
      detail: 'Print level.',
      expandsTo: '--printlevel'
    })
  })

  it('reads -f as freeze-atoms only once the ts subcommand is reached', () => {
    const atProgram = 'chemsmart run gaussian -f'
    const atTs = 'chemsmart run gaussian ts -f'

    expect(resolveCompletions(schema, atProgram, atProgram.length).completions).toContainEqual(
      expect.objectContaining({ expandsTo: '--filename' })
    )
    expect(resolveCompletions(schema, atTs, atTs.length).completions).toContainEqual(
      expect.objectContaining({ expandsTo: '--freeze-atoms' })
    )
  })

  it('keeps the level when an option and its value sit between subcommands', () => {
    const line = 'chemsmart run -m 8 gaussian -c'
    const result = resolveCompletions(schema, line, line.length)

    // `-m`, `8` and `-c` are not path steps; only `run` and `gaussian` are.
    expect(result.commandPath).toEqual(['chemsmart', 'run', 'gaussian'])
    expect(result.completions).toContainEqual(expect.objectContaining({ expandsTo: '--charge' }))
  })
})

describe('resolveCompletions — subcommands and values', () => {
  it('offers subcommands with the descriptions chemsmart wrote for them', () => {
    const line = 'chemsmart run gaussian '
    const result = resolveCompletions(schema, line, line.length)

    expect(result.completions).toContainEqual({
      value: 'opt',
      kind: 'subcommand',
      detail: 'CLI subcommand for running Gaussian optimization.'
    })
    expect(result.completions).toContainEqual({
      value: 'ts',
      kind: 'subcommand',
      detail: 'CLI subcommand for running Gaussian transition state calculation.'
    })
  })

  it('narrows subcommands by the prefix already typed', () => {
    const line = 'chemsmart run gaussian t'
    const result = resolveCompletions(schema, line, line.length)

    expect(result.completions.map((entry) => entry.value)).toEqual(['ts'])
    expect(result.replaceFrom).toBe(line.length - 1)
  })

  it('offers the declared choices in an option value slot', () => {
    const line = 'chemsmart sub -s '
    const result = resolveCompletions(schema, line, line.length)

    expect(result.completions).toEqual([
      { value: 'slurm', kind: 'choice', detail: 'Server to submit to.' },
      { value: 'pbs', kind: 'choice', detail: 'Server to submit to.' },
      { value: 'local', kind: 'choice', detail: 'Server to submit to.' }
    ])
  })

  it('offers nothing for a free-text value slot rather than guessing', () => {
    const line = 'chemsmart run gaussian -p '
    expect(resolveCompletions(schema, line, line.length).completions).toEqual([])
  })

  it('completes the executable itself on an empty line', () => {
    const result = resolveCompletions(schema, '', 0)
    expect(result.completions).toEqual([{ value: 'chemsmart', kind: 'subcommand', detail: 'ChemSmart command line.' }])
  })

  it('completes at the cursor, not at the end of the line', () => {
    const line = 'chemsmart run gaussian  --charge 0'
    // Cursor sits just after `gaussian `, before the rest of the line.
    const result = resolveCompletions(schema, line, 'chemsmart run gaussian '.length)

    expect(result.commandPath).toEqual(['chemsmart', 'run', 'gaussian'])
    expect(result.completions.map((entry) => entry.value)).toContain('opt')
  })
})

describe('explainToken', () => {
  it('explains a short flag by the level it appears at', () => {
    const line = 'chemsmart run gaussian -m 3'

    expect(explainToken(schema, line, line.indexOf('-m') + 1)).toEqual({
      value: '-m',
      kind: 'option',
      detail: 'Multiplicity of the molecule.',
      expandsTo: '--multiplicity'
    })
  })

  it('reports a flag that does not exist at this level rather than borrowing a meaning', () => {
    // `--freeze-atoms` is a `ts` option; at program level it is simply not a flag.
    expect(explainToken(schema, 'chemsmart run gaussian -f x', 24)).toEqual(
      expect.objectContaining({ expandsTo: '--filename' })
    )
    expect(explainToken(schema, 'chemsmart sub -m 8', 15)).toBeNull()
  })

  it('says nothing about a token that is not a flag', () => {
    expect(explainToken(schema, 'chemsmart run gaussian', 16)).toBeNull()
  })
})
