import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

const { schemaHash } = require('../prepare-chemsmart-cli-schema.js')

describe('prepare-chemsmart-cli-schema', () => {
  it('uses the same recursively sorted compact hash as the pinned Python exporter', () => {
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
})
