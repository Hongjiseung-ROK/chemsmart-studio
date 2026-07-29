/**
 * Completion for the ChemSmart CLI, resolved against the command path.
 *
 * chemsmart's short flags change meaning by level — `-m` is `--mem-gb` at run/sub level but
 * `--multiplicity` at program level, `-p` is `--project` for gaussian/orca but `--program` in the
 * folder options, and `-s`, `-c`, `-f` are likewise overloaded. A flat flag table is therefore wrong
 * by construction: the only way to answer "what does `-m` mean here" is to walk the tokens to the
 * node they land on and offer that node's own options.
 *
 * The prose comes from the schema itself (click's own help and docstrings), so the meaning a
 * researcher reads is the meaning chemsmart will act on — there is no second copy to drift.
 */

/** One click option, exactly as `chemsmart agent _dump-cli-schema` writes it. */
export interface CliOption {
  name: string
  opts: string[]
  help: string | null
  choices: string[] | null
  is_flag: boolean
  required: boolean
  type: string | null
}

/** One command node. The dumped root is this shape plus `_meta`. */
export interface CliCommand {
  name: string
  description: string | null
  options: CliOption[]
  subcommands: Record<string, CliCommand>
}

export interface CliSchemaDocument extends CliCommand {
  _meta?: { chemsmart_version?: string; schema_hash?: string }
}

export type CompletionKind = 'subcommand' | 'option' | 'choice'

export interface Completion {
  /** Text that replaces the word being completed. */
  value: string
  kind: CompletionKind
  /** What it means, in chemsmart's own words. Empty when the schema carries no help. */
  detail: string
  /** For an option, the long form it is a short alias of — the answer to "what does -m mean here". */
  expandsTo?: string
}

export interface CompletionResult {
  /** The command path the tokens resolved to, e.g. `['chemsmart', 'run', 'gaussian']`. */
  commandPath: string[]
  /** Start offset of the word being completed, so a caller can splice a choice in. */
  replaceFrom: number
  completions: Completion[]
}

interface Token {
  text: string
  start: number
}

/**
 * Splits on whitespace, keeping quoted runs together so a path with a space stays one token.
 * Deliberately not a shell parser: it only has to be good enough to find the command path.
 */
export function tokenize(line: string): Token[] {
  const tokens: Token[] = []
  let quote: '"' | "'" | null = null
  let current = ''
  let start = -1

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (quote) {
      if (character === quote) quote = null
      else current += character
      continue
    }
    if (character === '"' || character === "'") {
      if (start < 0) start = index
      quote = character
      continue
    }
    if (/\s/.test(character)) {
      if (start >= 0) {
        tokens.push({ text: current, start })
        current = ''
        start = -1
      }
      continue
    }
    if (start < 0) start = index
    current += character
  }
  if (start >= 0) tokens.push({ text: current, start })
  return tokens
}

/** The long form a short flag stands for, so `-m` can be shown as what it actually means here. */
function longForm(option: CliOption): string | undefined {
  return option.opts.find((opt) => opt.startsWith('--'))
}

function optionCompletions(command: CliCommand, prefix: string): Completion[] {
  const completions: Completion[] = []
  for (const option of command.options) {
    for (const opt of option.opts) {
      if (!opt.startsWith(prefix)) continue
      const long = longForm(option)
      completions.push({
        value: opt,
        kind: 'option',
        detail: option.help ?? '',
        ...(long && long !== opt ? { expandsTo: long } : {})
      })
    }
  }
  return completions
}

function subcommandCompletions(command: CliCommand, prefix: string): Completion[] {
  return Object.values(command.subcommands)
    .filter((child) => child.name.startsWith(prefix))
    .map((child) => ({ value: child.name, kind: 'subcommand' as const, detail: child.description ?? '' }))
}

/**
 * Finds the node the tokens before the cursor land on.
 *
 * A token is a step down the tree only when it names a subcommand of the current node. Anything else
 * — an option, its value, a filename — leaves the node where it is, which is what makes the level
 * correct for a line like `chemsmart run -c 0 gaussian`.
 */
function resolveCommandPath(root: CliCommand, tokens: readonly Token[]): { command: CliCommand; path: string[] } {
  let command = root
  const path = [root.name]
  // The first token is the executable itself; it names the root rather than a step below it.
  for (const token of tokens.slice(1)) {
    const child = command.subcommands[token.text]
    if (child) {
      command = child
      path.push(child.name)
    }
  }
  return { command, path }
}

/**
 * Completions for `line` at `cursor`.
 *
 * Pure: no process, no filesystem, no clock. Given the same schema and the same line it always
 * answers the same way, which is what makes the level-sensitivity testable rather than anecdotal.
 */
export function resolveCompletions(schema: CliCommand, line: string, cursor: number): CompletionResult {
  const clampedCursor = Math.max(0, Math.min(cursor, line.length))
  const head = line.slice(0, clampedCursor)
  const tokens = tokenize(head)
  const endsMidToken = clampedCursor > 0 && !/\s/.test(line[clampedCursor - 1])
  const currentToken = endsMidToken ? tokens.at(-1) : undefined
  const prefix = currentToken?.text ?? ''
  const replaceFrom = currentToken?.start ?? clampedCursor
  // The word under construction is not yet a command path element.
  const pathTokens = currentToken ? tokens.slice(0, -1) : tokens
  const { command, path } = resolveCommandPath(schema, pathTokens)

  // Nothing typed yet, or still typing the executable: offering the tree's options would be noise.
  if (pathTokens.length === 0) {
    return {
      commandPath: [schema.name],
      replaceFrom,
      completions: schema.name.startsWith(prefix)
        ? [{ value: schema.name, kind: 'subcommand', detail: schema.description ?? '' }]
        : []
    }
  }

  const previous = pathTokens.at(-1)?.text
  if (previous?.startsWith('-')) {
    // A value slot: if the option it belongs to is a choice, the choices are the only right answers.
    const awaiting = command.options.find((option) => option.opts.includes(previous) && !option.is_flag)
    if (awaiting?.choices) {
      return {
        commandPath: path,
        replaceFrom,
        completions: awaiting.choices
          .filter((choice) => choice.startsWith(prefix))
          .map((choice) => ({ value: choice, kind: 'choice' as const, detail: awaiting.help ?? '' }))
      }
    }
    if (awaiting) return { commandPath: path, replaceFrom, completions: [] }
  }

  const completions = prefix.startsWith('-')
    ? optionCompletions(command, prefix)
    : [...subcommandCompletions(command, prefix), ...(prefix === '' ? optionCompletions(command, '-') : [])]

  return { commandPath: path, replaceFrom, completions }
}

/**
 * What a token means at the point it appears — the answer to "what does `-m` mean here".
 *
 * Returns `null` when the token is not an option of the node it lands on, which is itself the useful
 * answer: the researcher is looking at a flag that does not exist at this level.
 */
export function explainToken(schema: CliCommand, line: string, cursor: number): Completion | null {
  const tokens = tokenize(line)
  const token = tokens.find(
    (candidate) => cursor >= candidate.start && cursor <= candidate.start + candidate.text.length
  )
  if (!token?.text.startsWith('-')) return null
  const before = tokens.slice(0, tokens.indexOf(token))
  const { command } = resolveCommandPath(schema, before)
  const option = command.options.find((candidate) => candidate.opts.includes(token.text))
  if (!option) return null
  const long = longForm(option)
  return {
    value: token.text,
    kind: 'option',
    detail: option.help ?? '',
    ...(long && long !== token.text ? { expandsTo: long } : {})
  }
}
