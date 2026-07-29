import * as z from 'zod'

import { USER_DATA_RELOCATION_VALIDATION_REASONS } from '../../types/userDataRelocation'
import { defineRoute } from '../define'

const relocationInspectionSchema = z.discriminatedUnion('valid', [
  z.object({ valid: z.literal(true), targetEmpty: z.boolean() }),
  z.object({ valid: z.literal(false), reason: z.enum(USER_DATA_RELOCATION_VALIDATION_REASONS) })
])

export const appRequestSchemas = {
  'app.get_info': defineRoute({
    input: z.void(),
    output: z.object({
      version: z.string(),
      isPackaged: z.boolean(),
      appPath: z.string(),
      homePath: z.string(),
      notesPath: z.string(),
      configPath: z.string(),
      appDataPath: z.string(),
      resourcesPath: z.string(),
      logsPath: z.string(),
      arch: z.string(),
      isPortable: z.boolean(),
      installPath: z.string()
    })
  }),
  'app.user_data_relocation.inspect': defineRoute({
    input: z.object({ path: z.string().min(1) }),
    output: relocationInspectionSchema
  }),
  'app.user_data_relocation.request': defineRoute({
    input: z.object({
      path: z.string().min(1),
      copy: z.boolean()
    }),
    output: z.void()
  }),
  'app.relaunch': defineRoute({ input: z.void(), output: z.void() }),
  'app.adjust_zoom': defineRoute({
    input: z.object({ delta: z.number(), reset: z.boolean().optional() }),
    output: z.number()
  }),
  'app.set_spell_check_enabled': defineRoute({ input: z.boolean(), output: z.void() })
}

export type AppEventSchemas = Record<never, never>
