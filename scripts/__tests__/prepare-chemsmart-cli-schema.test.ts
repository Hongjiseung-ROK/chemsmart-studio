import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

const { schemaHash } = require('../prepare-chemsmart-cli-schema.js')

describe('prepare-chemsmart-cli-schema', () => {
  it('uses the recursively sorted compact hash consumed by the Studio runtime', () => {
    const document = {
      subcommands: { run: { options: [], name: 'run', description: null, subcommands: {} } },
      options: [],
      name: 'chemsmart',
      description: null,
      _meta: { schema_hash: 'ignored' }
    }
    const canonical =
      '{"description":null,"name":"chemsmart","options":[],"subcommands":{"run":{"description":null,"name":"run","options":[],"subcommands":{}}}}'
    expect(schemaHash(document)).toBe(createHash('sha256').update(canonical).digest('hex'))
  })

  it('keeps scientific units and non-BMP text stable across Studio processes', () => {
    const document = {
      name: 'chemsmart',
      description: 'distance in Å 🧪',
      options: [],
      subcommands: {},
      _meta: { schema_hash: 'ignored' }
    }
    const canonical = '{"description":"distance in Å 🧪","name":"chemsmart","options":[],"subcommands":{}}'
    expect(schemaHash(document)).toBe(createHash('sha256').update(canonical).digest('hex'))
  })
})
