import { StudioWorkbench } from '@renderer/windows/main/StudioWorkbench'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/app/chemsmart')({
  component: StudioWorkbench
})
