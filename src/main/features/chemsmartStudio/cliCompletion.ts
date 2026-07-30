/**
 * Deterministic completion for ChemSmart's exported Click tree.
 *
 * This module is deliberately pure. Generating the manifest and discovering human-only
 * filesystem candidates happen outside the keystroke path; here we only parse the line and
 * project authoritative Click metadata into renderer-safe completion items. Submit-time semantic
 * truth stays with the ChemSmart harness rather than a second UI-owned command grammar.
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
  default?: unknown
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
  semantic?: {
    required_options: Array<{ name: string; label: string }>
  }
}

export interface CliSchemaDocument extends CliCommand {
  _meta?: {
    chemsmart_version?: string
    schema_hash?: string
    source_schema_hash?: string
    chemsmart_commit?: string
  }
}

export type CompletionItemKind = 'command' | 'option' | 'choice' | 'argument' | 'file' | 'project' | 'server'
export type CompletionItemGroup = 'commands' | 'options' | 'values' | 'files' | 'projects' | 'servers'
export type CompletionOpenAction = 'molecule' | 'project_yaml'

export interface CompletionItem {
  id: string
  label: string
  insertText: string
  kind: CompletionItemKind
  group: CompletionItemGroup
  detail: string
  valueHint?: string
  appendSpace: boolean
  contextRef?: string
  openAction?: CompletionOpenAction
}

export interface CompletionDiagnostic {
  code: 'unsupported_shell_syntax' | 'invalid_prefix' | 'value_required'
  message: string
}

export interface SemanticCommandSlot {
  id: string
  label: string
  insertText: string
  valueHint: string
  kind: 'leaf' | 'option'
  required: boolean
  consumed: boolean
  insertAt: number
}

export interface SemanticCommandGuide {
  breadcrumb: string[]
  slots: SemanticCommandSlot[]
  ghostSuffix: string
  complete: boolean
}

export interface CompletionResult {
  commandPath: string[]
  replaceRange: { start: number; end: number }
  items: CompletionItem[]
  semantic: SemanticCommandGuide
  diagnostic?: CompletionDiagnostic
}

export interface DynamicCompletionCandidate {
  label: string
  insertText: string
  kind: 'file' | 'project' | 'server'
  detail: string
  /** Option names which may consume this value, e.g. `filename` or `server`. */
  optionNames: string[]
  contextRef?: string
  openAction?: CompletionOpenAction
}

interface Token {
  raw: string
  text: string
  start: number
  end: number
  quote: '"' | "'" | null
  closed: boolean
}

interface CommandScope {
  command: CliCommand
  pathIndex: number
  token?: Token
  consumedOptions: Set<string>
}

interface ParseState {
  command: CliCommand
  path: string[]
  scopes: CommandScope[]
  pending: { option: CliOption; remaining: number } | null
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
  const rootScope: CommandScope = {
    command: root,
    pathIndex: 0,
    token: tokens[0]?.text === root.name ? tokens[0] : undefined,
    consumedOptions: new Set()
  }
  const state: ParseState = {
    command: root,
    path: [root.name],
    scopes: [rootScope],
    pending: null,
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
      state.scopes.at(-1)?.consumedOptions.add(match.option.name)
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
      state.scopes.push({
        command: child,
        pathIndex: state.path.length - 1,
        token,
        consumedOptions: new Set()
      })
      continue
    }
    // Click arguments are emitted with no option spellings. A token at that position is valid, but
    // an otherwise unknown positional token is not silently promoted to a subcommand.
    const positional = state.command.options.find((candidate) => candidate.opts.length === 0)
    if (!positional) state.invalid = true
  }
  return state
}

function typeName(option: CliOption): string {
  if (option.choices?.length) return option.choices.join(' | ')
  if (typeof option.type === 'string') return option.type
  if (!option.type) return 'value'
  if (option.type.min != null || option.type.max != null) {
    return `${option.type.type} ${option.type.min ?? '−∞'}…${option.type.max ?? '∞'}`
  }
  return option.type.type
}

function typeDetail(option: CliOption): string {
  return [option.help ?? '', typeName(option)].filter(Boolean).join(' · ')
}

function stableItemId(parts: readonly string[]): string {
  let hash = 2_166_136_261
  for (const character of parts.join('\u001f')) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16_777_619)
  }
  return `completion-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function groupForKind(kind: CompletionItemKind): CompletionItemGroup {
  if (kind === 'command') return 'commands'
  if (kind === 'option') return 'options'
  if (kind === 'file') return 'files'
  if (kind === 'project') return 'projects'
  if (kind === 'server') return 'servers'
  return 'values'
}

function item(
  commandPath: readonly string[],
  label: string,
  kind: CompletionItemKind,
  detail: string,
  insertText = label,
  extra: Pick<CompletionItem, 'contextRef' | 'openAction'> = {}
): CompletionItem {
  return {
    id: stableItemId([...commandPath, kind, insertText]),
    label,
    insertText,
    kind,
    group: groupForKind(kind),
    detail,
    appendSpace: true,
    ...extra
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
    .map((choice) => ({ ...item(state.path, choice, 'choice', typeDetail(option)), valueHint: typeName(option) }))
  const candidates = dynamic
    .filter((candidate) => candidate.optionNames.includes(option.name))
    .filter((candidate) => candidate.label.startsWith(prefix) || candidate.insertText.startsWith(prefix))
    .map((candidate) => ({
      ...item(
        state.path,
        candidate.label,
        candidate.kind,
        candidate.detail,
        quoteCandidate(candidate.insertText, token?.quote ?? null),
        { contextRef: candidate.contextRef, openAction: candidate.openAction }
      ),
      valueHint: typeName(option)
    }))
  return [...declared, ...candidates]
}

function longOption(option: CliOption): string {
  return option.opts.find((flag) => flag.startsWith('--')) ?? option.opts[0] ?? option.name
}

function optionSlotLabel(option: CliOption): string {
  const flag = longOption(option)
  if (option.is_flag) return flag
  return `${flag} <${typeName(option)}>`
}

function semanticGuide(state: ParseState, cursor: number): SemanticCommandGuide {
  const optionSlots: SemanticCommandSlot[] = []

  for (const scope of state.scopes) {
    const semanticRequirements = new Map(
      (scope.command.semantic?.required_options ?? []).map((requirement) => [requirement.name, requirement.label])
    )
    for (const option of scope.command.options) {
      if (option.opts.length === 0) continue
      const semanticLabel = semanticRequirements.get(option.name)
      const required = option.required || semanticLabel !== undefined
      const consumed = scope.consumedOptions.has(option.name)
      if (!required && consumed) continue
      const followingScope = state.scopes[scope.pathIndex + 1]
      optionSlots.push({
        id: `option-${option.name}`,
        label: required ? `⟨${semanticLabel ?? optionSlotLabel(option)}⟩` : `[${optionSlotLabel(option)}]`,
        insertText: `${longOption(option)} `,
        valueHint: typeName(option),
        kind: 'option',
        required,
        consumed,
        insertAt: followingScope?.token?.start ?? cursor
      })
    }
  }

  const nextCommands = Object.keys(state.command.subcommands)
  const leafSlot: SemanticCommandSlot | null =
    nextCommands.length > 0
      ? {
          id: `command-${state.path.length}`,
          label: `⟨${nextCommands.join(' | ')}⟩`,
          insertText: '',
          valueHint: 'command',
          kind: 'leaf',
          required: true,
          consumed: false,
          insertAt: cursor
        }
      : null
  const slots = [...optionSlots, ...(leafSlot ? [leafSlot] : [])]
  const unconsumed = slots.filter((slot) => !slot.consumed)
  const requiredMissing = unconsumed.filter((slot) => slot.required)
  const optional = unconsumed.filter((slot) => !slot.required).slice(0, 3)
  const remainingOptional = Math.max(0, unconsumed.filter((slot) => !slot.required).length - optional.length)
  const ghostParts = [...requiredMissing, ...optional].map((slot) => slot.label)
  if (remainingOptional > 0) ghostParts.push(`… ${remainingOptional} options`)

  return {
    breadcrumb: state.path,
    slots,
    ghostSuffix: ghostParts.join(' '),
    complete: !state.invalid && !state.pending && requiredMissing.length === 0 && nextCommands.length === 0
  }
}

function emptySemantic(schema: CliSchemaDocument): SemanticCommandGuide {
  return { breadcrumb: [schema.name], slots: [], ghostSuffix: '', complete: false }
}

/**
 * Resolve completions at an arbitrary cursor. The replacement range covers only the active value
 * (including only the value side of `--option=value`) so text after the cursor is preserved.
 */
export function resolveCompletions(
  schema: CliSchemaDocument,
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
      semantic: emptySemantic(schema),
      diagnostic: {
        code: 'unsupported_shell_syntax',
        message: 'Completion is unavailable for shell operators.'
      }
    }
  }

  const tokens = tokenize(line.slice(0, clamped))
  const current = clamped > 0 && !/\s/.test(line[clamped - 1]) ? tokens.at(-1) : undefined
  // An open quote is a valid completion boundary: applying a candidate closes it. A dangling
  // unquoted escape has no safe replacement range, so it remains an invalid prefix.
  if (current && !current.closed && !current.quote) {
    return {
      commandPath: [schema.name],
      replaceRange: { start: current.start, end: clamped },
      items: [],
      semantic: emptySemantic(schema),
      diagnostic: { code: 'invalid_prefix', message: 'Finish the escape before completing.' }
    }
  }
  const completed = current ? tokens.slice(0, -1) : tokens
  const state = parseCompletedTokens(schema, completed)
  const prefix = current?.text ?? ''
  let replaceRange = current ? { start: current.start, end: clamped } : emptyRange(clamped)
  const semantic = semanticGuide(state, clamped)

  if (state.invalid) {
    return {
      commandPath: state.path,
      replaceRange,
      items: [],
      semantic,
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
        : [],
      semantic
    }
  }

  if (state.pending) {
    return {
      commandPath: state.path,
      replaceRange,
      items: valueItems(state, state.pending.option, prefix, current, dynamic),
      semantic
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
        items: valueItems(state, inline.option, inline.inlineValue, current, dynamic),
        semantic
      }
    }
  }

  const currentScope = state.scopes.at(-1)
  const optionItems = state.command.options.flatMap((option) => {
    if (!option.multiple && currentScope?.consumedOptions.has(option.name)) return []
    return option.opts
      .filter((flag) => flag.startsWith(prefix || '-'))
      .map((flag) => ({
        ...item(state.path, flag, 'option', typeDetail(option)),
        valueHint: option.is_flag ? undefined : typeName(option)
      }))
  })
  const commandItems = Object.values(state.command.subcommands)
    .filter((command) => command.name.startsWith(prefix))
    .map((command) => item(state.path, command.name, 'command', command.description ?? ''))
  const requiredOptionItems = optionItems.filter((entry) =>
    state.command.options.some((option) => option.required && option.opts.some((flag) => flag === entry.insertText))
  )
  const ordinaryOptionItems = optionItems.filter((entry) => !requiredOptionItems.includes(entry))

  return {
    commandPath: state.path,
    replaceRange,
    items: prefix.startsWith('-')
      ? [...requiredOptionItems, ...ordinaryOptionItems]
      : [...requiredOptionItems, ...commandItems, ...(prefix === '' ? ordinaryOptionItems : [])],
    semantic
  }
}
