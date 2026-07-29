import type { ISeeder } from '../types'
import { ChemSmartAgentSeeder } from './seeders/chemSmartAgentSeeder'
import { CherryAiDefaultModelSeeder } from './seeders/cherryaiDefaultModelSeeder'
import { PreferenceSeeder } from './seeders/preferenceSeeder'
import { PresetProviderSeeder } from './seeders/presetProviderSeeder'

/**
 * All seeders in execution order.
 *
 * Keep CherryAiDefaultModelSeeder before ChemSmartAgentSeeder because the
 * built-in ChemSmart Agent may reference the default model (FK to user_model).
 *
 * To add a new seeder: create an ISeeder class, add it to this array.
 * No changes to DbService needed.
 */
export const seeders: ISeeder[] = [
  new CherryAiDefaultModelSeeder(),
  new ChemSmartAgentSeeder(),
  new PreferenceSeeder(),
  new PresetProviderSeeder()
]
