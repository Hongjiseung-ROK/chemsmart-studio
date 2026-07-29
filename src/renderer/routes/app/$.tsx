import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * One normalization boundary for stale product URLs. Retired route components are deliberately absent
 * from the active tree, so persisted Chat, Work, translation, painting, knowledge, file, note, and mini-app
 * URLs cannot render legacy product UI during startup.
 */
export const Route = createFileRoute('/app/$')({
  beforeLoad: () => {
    throw redirect({ to: '/app/chemsmart' })
  }
})
