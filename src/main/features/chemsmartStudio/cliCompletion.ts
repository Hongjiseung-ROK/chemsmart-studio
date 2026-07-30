/**
 * Deterministic completion for ChemSmart's exported Click tree.
 *
 * This module is deliberately pure. Generating the manifest and discovering human-only
 * filesystem candidates happen outside the keystroke path; here we only parse the line and
 * project the authoritative Click metadata into renderer-safe completion items.
 */

export type CliValueType =
  | string
  | {
      type: string
      choices?: string[]
      exists?: boolean
      file_okay?: boolean
      dir_okay?: boolean
      min?: number | null
      max?: number | null
    }

export interface CliOption {
  name: string
  opts: string[]
  help: string | null
  choices: string[] | null
  is_flag: boolean
  multiple: boolean
  required: boolean
  nargs: number
  type: CliValueType | null
}

export interface CliCommand {
  name: string
  description: string | null
  options: CliOption[]
  subcommands: Record<string, CliCommand>
}

export interface CliSchemaDocument extends CliCommand {
  _meta?: {
    chemsmart_version?: string
    schema_hash?: string
    chemsmart_commit?: string
  }
}

export type CompletionItemKind = 'command' | 'option' | 'choice' | 'argument' | 'file' | 'project' | 'server'

export interface CompletionItem {
  id: string
  label: string
  insertText: string
  kind: CompletionItemKind
  detail: string
  appendSpace: boolean
}

export interface CompletionDiagnostic {
  code: 'unsupported_shell_syntax' | 'invalid_prefix' | 'value_required'
  message: string
}

export interface CompletionResult {
  commandPath: string[]
  replaceRange: { start: number; end: number }
  items: CompletionItem[]
  diagnostic?: CompletionDiagnostic
}

export interface DynamicCompletionCandidate {
  label: string
  insertText: string
  kind: 'file' | 'project' | 'server'
  detail: string
  /** Option names which may consume this value, e.g. `filename` or `server`. */
  optionNames: string[]
}

interface Token {
  raw: string
  text: string
  start: number
  end: number
  quote: '"' | "'" | null
  closed: boolean
}

interface ParseState {
  command: CliCommand
  path: string[]
  pending: { option: CliOption; remaining: number } | null
  consumedOptions: Set<string>
  invalid: boolean
}

function emptyRange(cursor: number): { start: number; end: number } {
  return { start: cursor, end: cursor }
}

/** Tokenize shell words without executing or expanding any shell syntax. */
export function tokenize(line: string): Token[] {
  const tokens: Token[] = []
  let start = -1
  let quote: '"' | "'" | null = null
  let tokenQuote: '"' | "'" | null = null
  let escaped = false
  let text = ''

  const flush = (end: number, closed = true) => {
    if (start < 0) return
    tokens.push({ raw: line.slice(start, end), text, start, end, quote: tokenQuote, closed })
    start = -1
    quote = null
    tokenQuote = null
    escaped = false
    text = ''
  }

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (start < 0 && /\s/.test(character)) continue
    if (start < 0) start = index
    if (escaped) {
      text += character
      escaped = false
      continue
    }
    if (character === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (character === quote) quote = null
      else text += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      tokenQuote ??= character
      continue
    }
    if (/\s/.test(character)) {
      flush(index)
      continue
    }
    text += character
  }
  if (start >= 0) flush(line.length, quote === null && !escaped)
  return tokens
}

function unsupportedShellSyntax(line: string): boolean {
  let quote: '"' | "'" | null = null
  let escaped = false
  for (const character of line) {
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (';&|<>'.includes(character)) return true
  }
  return false
}

function optionAt(
  command: CliCommand,
  text: string
): { option: CliOption; inlineValue?: string; valueStart?: number } | null {
  const equals = text.indexOf('=')
  const flag = equals >= 0 ? text.slice(0, equals) : text
  const option = command.options.find((candidate) => candidate.opts.includes(flag))
  if (!option) return null
  return equals >= 0 ? { option, inlineValue: text.slice(equals + 1), valueStart: equals + 1 } : { option }
}

function parseCompletedTokens(root: CliCommand, tokens: readonly Token[]): ParseState {
  const state: ParseState = {
    command: root,
    path: [root.name],
    pending: null,
    consumedOptions: new Set(),
    invalid: false
  }
  const rest = tokens[0]?.text === root.name ? tokens.slice(1) : tokens

  for (const token of rest) {
    if (state.pending) {
      state.pending.remaining -= 1
      if (state.pending.remaining <= 0) state.pending = null
      continue
    }
    const match = optionAt(state.command, token.text)
    if (match) {
      state.consumedOptions.add(match.option.name)
      if (!match.option.is_flag) {
        const required = Math.max(1, match.option.nargs || 1)
        const suppliedInline = match.inlineValue !== undefined && match.inlineValue.length > 0 ? 1 : 0
        if (required > suppliedInline) state.pending = { option: match.option, remaining: required - suppliedInline }
      }
      continue
    }
    if (token.text.startsWith('-')) {
      state.invalid = true
      continue
    }
    const child = state.command.subcommands[token.text]
    if (child) {
      state.command = child
      state.path.push(child.name)
      state.consumedOptions = new Set()
    }
  }
  return state
}

function typeDetail(option: CliOption): string {
  const valueType = option.type
  let description = ''
  if (typeof valueType === 'string') description = valueType
  else if (valueType) {
    description = valueType.type
    if (valueType.min != null || valueType.max != null) {
      description += ` ${valueType.min ?? '−∞'}…${valueType.max ?? '∞'}`
    }
  }
  return [option.help ?? '', description].filter(Boolean).join(' · ')
}

function item(
  commandPath: readonly string[],
  label: string,
  kind: CompletionItemKind,
  detail: string,
  insertText = label
): CompletionItem {
  return {
    id: `${commandPath.join('/')}:${kind}:${insertText}`,
    label,
    insertText,
    kind,
    detail,
    appendSpace: true
  }
}

function choiceValues(option: CliOption): string[] {
  if (option.choices) return option.choices
  if (typeof option.type === 'object' && option.type?.choices) return option.type.choices
  return []
}

function quoteCandidate(value: string, quote: Token['quote']): string {
  if (quote) return `${quote}${value.replaceAll(quote, `\\${quote}`)}${quote}`
  if (!/[\s"'\\]/.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}

function valueItems(
  state: ParseState,
  option: CliOption,
  prefix: string,
  token: Token | undefined,
  dynamic: readonly DynamicCompletionCandidate[]
): CompletionItem[] {
  const declared = choiceValues(option)
    .filter((choice) => choice.startsWith(prefix))
    .map((choice) => item(state.path, choice, 'choice', typeDetail(option)))
  const candidates = dynamic
    .filter((candidate) => candidate.optionNames.includes(option.name))
    .filter((candidate) => candidate.label.startsWith(prefix) || candidate.insertText.startsWith(prefix))
    .map((candidate) =>
      item(
        state.path,
        candidate.label,
        candidate.kind,
        candidate.detail,
        quoteCandidate(candidate.insertText, token?.quote ?? null)
      )
    )
  return [...declared, ...candidates]
}

/**
 * Resolve completions at an arbitrary cursor. The replacement range covers only the active value
 * (including only the value side of `--option=value`) so text after the cursor is preserved.
 */
export function resolveCompletions(
  schema: CliCommand,
  line: string,
  cursor: number,
  dynamic: readonly DynamicCompletionCandidate[] = []
): CompletionResult {
  const clamped = Math.max(0, Math.min(cursor, line.length))
  if (unsupportedShellSyntax(line.slice(0, clamped))) {
    return {
      commandPath: [schema.name],
      replaceRange: emptyRange(clamped),
      items: [],
      diagnostic: {
        code: 'unsupported_shell_syntax',
        message: 'Completion is unavailable for shell operators.'
      }
    }
  }

  const tokens = tokenize(line.slice(0, clamped))
  const current = clamped > 0 && !/\s/.test(line[clamped - 1]) ? tokens.at(-1) : undefined
  if (current && !current.closed) {
    return {
      commandPath: [schema.name],
      replaceRange: { start: current.start, end: clamped },
      items: [],
      diagnostic: { code: 'invalid_prefix', message: 'Close the quote or escape before completing.' }
    }
  }
  const completed = current ? tokens.slice(0, -1) : tokens
  const state = parseCompletedTokens(schema, completed)
  const prefix = current?.text ?? ''
  let replaceRange = current ? { start: current.start, end: clamped } : emptyRange(clamped)

  if (state.invalid) {
    return {
      commandPath: state.path,
      replaceRange,
      items: [],
      diagnostic: { code: 'invalid_prefix', message: 'The command prefix is not valid at this level.' }
    }
  }

  if (completed.length === 0) {
    const executablePrefix = prefix === 'chem' ? 'chem' : prefix
    return {
      commandPath: [schema.name],
      replaceRange,
      items: schema.name.startsWith(executablePrefix)
        ? [item([schema.name], schema.name, 'command', schema.description ?? '')]
        : []
    }
  }

  if (state.pending) {
    return {
      commandPath: state.path,
      replaceRange,
      items: valueItems(state, state.pending.option, prefix, current, dynamic)
    }
  }

  if (current) {
    const inline = optionAt(state.command, current.text)
    if (inline?.inlineValue !== undefined && !inline.option.is_flag) {
      const valueStart = current.start + (inline.valueStart ?? 0)
      replaceRange = { start: valueStart, end: clamped }
      return {
        commandPath: state.path,
        replaceRange,
        items: valueItems(state, inline.option, inline.inlineValue, current, dynamic)
      }
    }
  }

  const optionItems = state.command.options.flatMap((option) => {
    if (!option.multiple && state.consumedOptions.has(option.name)) return []
    return option.opts
      .filter((flag) => flag.startsWith(prefix || '-'))
      .map((flag) => item(state.path, flag, 'option', typeDetail(option)))
  })
  const commandItems = Object.values(state.command.subcommands)
    .filter((command) => command.name.startsWith(prefix))
    .map((command) => item(state.path, command.name, 'command', command.description ?? ''))

  return {
    commandPath: state.path,
    replaceRange,
    items: prefix.startsWith('-') ? optionItems : [...commandItems, ...(prefix === '' ? optionItems : [])]
  }
}
