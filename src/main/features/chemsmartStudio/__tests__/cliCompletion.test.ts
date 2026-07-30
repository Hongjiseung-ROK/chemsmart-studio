import { describe, expect, it } from 'vitest'

import { type CliCommand, type CliOption, resolveCompletions, resolveFileDropTarget, tokenize } from '../cliCompletion'

function option(name: string, opts: string[], extra: Partial<CliOption> = {}): CliOption {
  return {
    name,
    opts,
    help: `${name} help`,
    choices: null,
    is_flag: false,
    multiple: false,
    required: false,
    nargs: 1,
    type: 'str',
    ...extra
  }
}

function command(name: string, children: CliCommand[] = [], options: CliOption[] = []): CliCommand {
  return {
    name,
    description: `${name} command`,
    options,
    subcommands: Object.fromEntries(children.map((child) => [child.name, child])),
    completion: {
      suggest: true,
      tier: 'primary',
      inspection_profile: name === 'run' || name === 'sub' ? 'calculation' : 'human_shell'
    }
  }
}

const schema = command('chemsmart', [
  command('run', [
    command(
      'xtb',
      [command('sp'), command('opt'), command('hess')],
      [
        option('charge', ['-c', '--charge'], { type: { type: 'int', min: -10, max: 10 } }),
        option('method', ['--method'], { choices: ['gfn1', 'gfn2'] }),
        option('project', ['-p', '--project'], {
          completion: { suggest: false, tier: 'advanced' }
        }),
        option('filename', ['-f', '--filename'], {
          completion: { suggest: true, tier: 'primary' },
          type: { type: 'path', exists: true, file_okay: true }
        })
      ]
    ),
    command('database')
  ]),
  command('sub', [], [option('server', ['-s', '--server'])]),
  command('update'),
  command('agent'),
  command('config')
])
schema.subcommands.run.subcommands.database.completion!.tier = 'advanced'
schema.subcommands.update.completion = { suggest: true, tier: 'advanced', inspection_profile: 'human_shell' }
schema.subcommands.agent.completion = { suggest: false, tier: 'advanced', inspection_profile: 'human_shell' }
schema.subcommands.config.completion = { suggest: false, tier: 'advanced', inspection_profile: 'human_shell' }
schema.subcommands.run.subcommands.xtb.semantic = {
  required_options: [{ name: 'filename', label: 'file' }]
}

describe('tokenize', () => {
  it('preserves decoded text and exact raw ranges', () => {
    expect(tokenize('chemsmart run -f "my file.xyz"')).toEqual([
      expect.objectContaining({ text: 'chemsmart', raw: 'chemsmart', start: 0, end: 9 }),
      expect.objectContaining({ text: 'run', raw: 'run', start: 10, end: 13 }),
      expect.objectContaining({ text: '-f', raw: '-f', start: 14, end: 16 }),
      expect.objectContaining({ text: 'my file.xyz', raw: '"my file.xyz"', start: 17, end: 30 })
    ])
  })
})

describe('resolveCompletions', () => {
  it('completes chem to the executable without spawning anything', () => {
    expect(resolveCompletions(schema, 'chem', 4).items.map((entry) => entry.label)).toEqual(['chemsmart'])
  })

  it('walks run → xtb → projectless sp/opt/hess', () => {
    const result = resolveCompletions(schema, 'chemsmart run xtb ', 18)
    expect(result.commandPath).toEqual(['chemsmart', 'run', 'xtb'])
    expect(result.items.filter((item) => item.kind === 'command').map((item) => item.label)).toEqual([
      'sp',
      'opt',
      'hess'
    ])
    expect(result.items.some((item) => item.label === '-p')).toBe(false)
    expect(result.items[0].label).toBe('-f')
    expect(result.stage).toBe('required_value')
    expect(result.semantic).toMatchObject({
      breadcrumb: ['chemsmart', 'run', 'xtb'],
      complete: false
    })
    expect(result.semantic.ghostSuffix).toContain('⟨file⟩')
    expect(result.semantic.ghostSuffix).toContain('⟨sp | opt | hess⟩')
  })

  it('does not interpret an option value as a subcommand', () => {
    const result = resolveCompletions(schema, 'chemsmart run xtb --method run ', 33)
    expect(result.commandPath).toEqual(['chemsmart', 'run', 'xtb'])
  })

  it('does not create value tokens for repeated whitespace', () => {
    const result = resolveCompletions(schema, 'chemsmart run xtb --method  ', 29)
    expect(result.items.map((item) => item.label)).toEqual(['gfn1', 'gfn2'])
  })

  it('completes declared choices and --option=value in place', () => {
    const line = 'chemsmart run xtb --method=gf suffix'
    const cursor = line.indexOf(' suffix')
    const result = resolveCompletions(schema, line, cursor)
    expect(result.replaceRange).toEqual({ start: line.indexOf('gf'), end: cursor })
    expect(result.items.map((item) => item.insertText)).toEqual(['gfn1', 'gfn2'])
  })

  it('preserves repeated options only when Click declares multiple', () => {
    const single = resolveCompletions(schema, 'chemsmart run xtb --charge 0 ', 29, [], 'all')
    expect(single.items.map((item) => item.label)).not.toContain('--charge')
    schema.subcommands.run.subcommands.xtb.options[0].multiple = true
    const repeated = resolveCompletions(schema, 'chemsmart run xtb --charge 0 ', 29, [], 'all')
    expect(repeated.items.map((item) => item.label)).toContain('--charge')
    schema.subcommands.run.subcommands.xtb.options[0].multiple = false
  })

  it('offers path-free dynamic human candidates only for their declared value slot', () => {
    const result = resolveCompletions(schema, 'chemsmart run xtb -f ', 22, [
      {
        label: 'water.xyz',
        insertText: 'water.xyz',
        kind: 'file',
        detail: 'Studio project artifact',
        optionNames: ['filename'],
        contextRef: 'completion-water',
        openAction: 'molecule'
      }
    ])
    expect(result.items).toContainEqual(
      expect.objectContaining({
        label: 'water.xyz',
        kind: 'file',
        group: 'files',
        contextRef: 'completion-water',
        openAction: 'molecule'
      })
    )
  })

  it('fails closed for shell operators and completes safely inside an open quote', () => {
    expect(resolveCompletions(schema, 'chemsmart run | ', 16).diagnostic?.code).toBe('unsupported_shell_syntax')
    const result = resolveCompletions(schema, 'chemsmart run xtb -f "my', 24, [
      {
        label: 'my file.xyz',
        insertText: 'my file.xyz',
        kind: 'file',
        detail: 'Studio project artifact',
        optionNames: ['filename']
      }
    ])
    expect(result.items[0].insertText).toBe('"my file.xyz"')
  })

  it('keeps the suffix replacement boundary for mid-line completion', () => {
    const line = 'chemsmart r --help'
    const result = resolveCompletions(schema, line, 'chemsmart r'.length)
    expect(result.replaceRange).toEqual({ start: 10, end: 11 })
    expect(result.items.map((item) => item.label)).toContain('run')
  })

  it('keeps ancestor option state after a leaf and reports structural completeness', () => {
    const line = 'chemsmart run xtb -f water.xyz sp '
    const result = resolveCompletions(schema, line, line.length)

    expect(result.commandPath).toEqual(['chemsmart', 'run', 'xtb', 'sp'])
    expect(result.semantic.slots).toContainEqual(
      expect.objectContaining({ id: 'option-filename', consumed: true, required: true })
    )
    expect(result.semantic.complete).toBe(true)
  })

  it('places a missing ancestor option before the next command token', () => {
    const line = 'chemsmart run xtb sp '
    const result = resolveCompletions(schema, line, line.length)

    expect(result.semantic.slots).toContainEqual(
      expect.objectContaining({
        id: 'option-filename',
        consumed: false,
        insertAt: line.indexOf('sp')
      })
    )
    expect(result.semantic.complete).toBe(false)
  })

  it('publishes the primary/all decision tree without suggesting agent or config', () => {
    const primary = resolveCompletions(schema, 'chemsmart ', 10)
    expect(primary.items.map((item) => item.label)).toEqual(['run', 'sub'])
    expect(primary).toMatchObject({ stage: 'subcommand', disclosure: 'primary', hasMore: true })
    expect(primary.semantic.ghostSuffix).toContain('⟨run | sub⟩')
    expect(primary.semantic.ghostSuffix).not.toMatch(/agent|config|update/)

    const all = resolveCompletions(schema, 'chemsmart ', 10, [], 'all')
    expect(all.items.map((item) => item.label)).toEqual(['run', 'sub', 'update'])
    expect(all.hasMore).toBe(false)
    expect(all.semantic.ghostSuffix).toContain('⟨run | sub | update⟩')
    expect(all.semantic.ghostSuffix).not.toMatch(/agent|config/)
  })

  it('reveals advanced programs through More or an explicit program prefix', () => {
    expect(resolveCompletions(schema, 'chemsmart run ', 14).items.map((item) => item.label)).toEqual(['xtb'])
    expect(resolveCompletions(schema, 'chemsmart run d', 15).items.map((item) => item.label)).toEqual(['database'])
    expect(resolveCompletions(schema, 'chemsmart run ', 14, [], 'all').items.map((item) => item.label)).toEqual([
      'xtb',
      'database'
    ])
  })

  it('shows ordinary options only for a dash prefix or all disclosure and never exposes xTB project', () => {
    const primary = resolveCompletions(schema, 'chemsmart run xtb ', 18)
    expect(primary.items.map((item) => item.label)).not.toContain('--charge')
    expect(primary.hasMore).toBe(true)

    const dash = resolveCompletions(schema, 'chemsmart run xtb -', 19)
    expect(dash.items.map((item) => item.label)).toContain('--charge')
    expect(dash.items.map((item) => item.label)).not.toContain('-p')
    expect(
      resolveCompletions(schema, 'chemsmart run xtb ', 18, [], 'all').items.map((item) => item.label)
    ).not.toContain('--project')
    expect(primary.semantic.ghostSuffix).not.toContain('project')
    const explicitProject = resolveCompletions(
      schema,
      'chemsmart run xtb -p ',
      'chemsmart run xtb -p '.length,
      [
        {
          label: 'default',
          insertText: 'default',
          kind: 'project',
          detail: 'XTB project',
          optionNames: ['project'],
          openAction: 'project_yaml'
        }
      ],
      'all'
    )
    expect(explicitProject.items).toEqual([])
  })

  it('returns the full bounded candidate set and reports overflow', () => {
    const candidates = Array.from({ length: 120 }, (_, index) => ({
      label: `molecule-${index.toString().padStart(3, '0')}.xyz`,
      insertText: `molecule-${index.toString().padStart(3, '0')}.xyz`,
      kind: 'file' as const,
      detail: 'Studio project artifact',
      optionNames: ['filename']
    }))
    const result = resolveCompletions(schema, 'chemsmart run xtb -f ', 22, candidates)

    expect(result.items).toHaveLength(100)
    expect(result.hasMore).toBe(true)
  })

  it('accepts a file drop only while the current value has the filename role', () => {
    const filenameLine = 'chemsmart run xtb -f old.xyz'
    expect(resolveFileDropTarget(schema, filenameLine, filenameLine.length)).toMatchObject({
      replaceRange: { start: 21, end: filenameLine.length },
      option: { name: 'filename' }
    })
    const methodLine = 'chemsmart run xtb --method '
    expect(() => resolveFileDropTarget(schema, methodLine, methodLine.length)).toThrow(/filename/)
  })
})
