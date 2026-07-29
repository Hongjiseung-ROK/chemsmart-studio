/**
 * BuiltinAgentProvisioner
 *
 * Provisions built-in agent workspaces by copying neutral runtime templates
 * from bundled resources into the SDK-specific workspace layout.
 *
 * The Claude Agent SDK auto-discovers skills from .claude/skills/ and
 * plugins from .claude/plugins.json, so no programmatic injection is needed.
 */
import { application } from '@application'
import { loggerService } from '@logger'
import { getAppLanguage } from '@main/i18n'
import fs from 'fs'
import path from 'path'

const logger = loggerService.withContext('BuiltinAgentProvisioner')

/** Resolve a localized field: string passes through; locale-keyed object resolves by current language. */
function resolveLocalizedField(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null) return undefined

  const map = value as Record<string, string>
  const lang = getAppLanguage()
  const prefix = lang.split('-')[0]
  const prefixKey = Object.keys(map).find((k) => k.startsWith(prefix))

  return map[lang] || (prefixKey && map[prefixKey]) || map['en-US'] || Object.values(map)[0]
}

const ROLE_TO_TEMPLATE: Record<string, string> = {
  assistant: 'chemsmart-agent'
}

function getTemplateDir(builtinRole: string): string | undefined {
  const templateName = ROLE_TO_TEMPLATE[builtinRole]
  if (!templateName) {
    logger.warn('Unknown builtin role, skipping provisioning', { builtinRole })
    return undefined
  }

  return path.join(application.getPath('feature.agents.builtin'), templateName)
}

/**
 * Recursively copy a directory, creating target dirs as needed.
 */
function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

// No `description` here: the builtin agent's display/search description is owned by i18n
// (`agent.builtin.cherry_assistant.description`), not the bundle — a bundle copy would be a
// drift-prone second source of truth.
export interface BuiltinAgentConfig {
  name?: string
  instructions?: string
  configuration?: Record<string, unknown>
}

export function loadBuiltinAgentDefinition(builtinRole: string): BuiltinAgentConfig | undefined {
  const templateDir = getTemplateDir(builtinRole)
  if (!templateDir) return undefined

  const agentJsonPath = path.join(templateDir, 'agent.json')
  if (!fs.existsSync(agentJsonPath)) {
    logger.error('Builtin agent definition not found', { agentJsonPath, builtinRole })
    return undefined
  }

  try {
    const agentConfig = JSON.parse(fs.readFileSync(agentJsonPath, 'utf-8'))
    return {
      name: agentConfig.name,
      instructions: resolveLocalizedField(agentConfig.instructions),
      configuration: agentConfig.configuration
    } as BuiltinAgentConfig
  } catch (error) {
    logger.error('Failed to load builtin agent definition', {
      builtinRole,
      agentJsonPath,
      error: error instanceof Error ? error.message : String(error)
    })
    return undefined
  }
}

/**
 * Provision a built-in agent's workspace with template files.
 *
 * Writes `.claude/skills/` and `.claude/plugins.json` only to the runtime
 * working directory so the SDK can auto-discover them. The bundled source
 * stays provider-neutral under `runtime/`.
 *
 * @param workspacePath - The agent session's workspace directory
 * @param builtinRole - The built-in role identifier (`assistant`)
 * @returns The parsed agent.json config, or undefined if not found
 */
export async function provisionBuiltinAgent(
  workspacePath: string,
  builtinRole: string
): Promise<BuiltinAgentConfig | undefined> {
  const templateDir = getTemplateDir(builtinRole)
  if (!templateDir) return undefined

  if (!fs.existsSync(templateDir)) {
    logger.error('Builtin agent template not found', { templateDir, builtinRole })
    return undefined
  }

  try {
    const runtimeTemplateDir = path.join(templateDir, 'runtime')
    const destClaudeDir = path.join(workspacePath, '.claude')

    if (fs.existsSync(runtimeTemplateDir)) {
      copyDirSync(runtimeTemplateDir, destClaudeDir)
      logger.info('Provisioned SDK runtime resources for builtin agent', {
        builtinRole,
        workspacePath
      })
    }

    return loadBuiltinAgentDefinition(builtinRole)
  } catch (error) {
    logger.error('Failed to provision builtin agent workspace', {
      builtinRole,
      workspacePath,
      error: error instanceof Error ? error.message : String(error)
    })
    return undefined
  }
}

/**
 * Check if a workspace has already been provisioned (has .claude/skills/).
 */
export function isProvisioned(workspacePath: string): boolean {
  return fs.existsSync(path.join(workspacePath, '.claude', 'skills'))
}
