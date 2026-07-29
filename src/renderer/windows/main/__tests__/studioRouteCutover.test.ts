import { describe, expect, it } from 'vitest'

import { Route as AppIndexRoute } from '../../../routes/app.index'
import { Route as RetiredAppRoute } from '../../../routes/app/$'

describe('Studio product route cutover', () => {
  it.each([AppIndexRoute, RetiredAppRoute])('normalizes stale app URLs at one boundary', (route) => {
    let thrown: unknown
    try {
      route.options.beforeLoad?.({} as never)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({
      options: { to: '/app/chemsmart' }
    })
  })
})
