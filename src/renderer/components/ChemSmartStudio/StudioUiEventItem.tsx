import type { StudioUiEvent, StudioUiEventKind } from '@chemsmart/studio-protocol'
import { Alert } from '@cherrystudio/ui'
import { Activity, Bell, Brain, Crosshair, LoaderCircle, PanelRight } from 'lucide-react'
import type { ComponentProps, ComponentType } from 'react'

interface StudioUiEventComponentProps {
  event: StudioUiEvent
  live?: boolean
}

function EventMessage({ message }: { message: string }) {
  return <span className="min-w-0 whitespace-pre-wrap break-words">{message}</span>
}

function EventAlert({
  children,
  live = true,
  ...props
}: Omit<ComponentProps<typeof Alert>, 'role'> & { live?: boolean }) {
  return (
    <Alert aria-live={live ? 'polite' : 'off'} role={live ? 'status' : 'group'} {...props}>
      {children}
    </Alert>
  )
}

function StatusEvent({ event, live }: StudioUiEventComponentProps) {
  return (
    <EventAlert
      data-studio-ui-component="status"
      icon={<Activity aria-hidden="true" size={16} />}
      live={live}
      message={<EventMessage message={event.payload.message} />}
      showIcon
      type="info"
    />
  )
}

function ProgressEvent({ event, live }: StudioUiEventComponentProps) {
  const progress = Math.max(0, Math.min(1, event.payload.progress ?? 0))
  const percentage = Math.round(progress * 100)

  return (
    <EventAlert
      data-studio-ui-component="progress"
      icon={<LoaderCircle aria-hidden="true" size={16} />}
      live={live}
      showIcon
      type="info">
      <EventMessage message={event.payload.message} />
      <div
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={percentage}
        aria-valuetext={`${percentage}%`}
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-secondary"
        role="progressbar">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none"
          style={{ width: `${percentage}%` }}
        />
      </div>
    </EventAlert>
  )
}

function MoleculeFocusEvent({ event, live }: StudioUiEventComponentProps) {
  return (
    <EventAlert
      data-studio-ui-component="molecule-focus"
      icon={<Crosshair aria-hidden="true" size={16} />}
      live={live}
      message={<EventMessage message={event.payload.message} />}
      showIcon
      type="success"
    />
  )
}

function NoticeEvent({ event, live }: StudioUiEventComponentProps) {
  return (
    <EventAlert
      data-studio-ui-component="notice"
      icon={<Bell aria-hidden="true" size={16} />}
      live={live}
      message={<EventMessage message={event.payload.message} />}
      showIcon
      type="info"
    />
  )
}

/** Reasoning stays visually quiet and unstyled as a result, so it cannot be mistaken for a gate outcome. */
function AgentThoughtEvent({ event, live }: StudioUiEventComponentProps) {
  return (
    <EventAlert
      data-studio-ui-component="agent-thought"
      icon={<Brain aria-hidden="true" size={16} />}
      live={live}
      message={<EventMessage message={event.payload.message} />}
      showIcon
      type="info"
    />
  )
}

function InspectorTargetEvent({ event, live }: StudioUiEventComponentProps) {
  return (
    <EventAlert
      data-studio-ui-component="inspector-target"
      icon={<PanelRight aria-hidden="true" size={16} />}
      live={live}
      message={<EventMessage message={event.payload.message} />}
      showIcon
      type="info"
    />
  )
}

const eventComponents = {
  status: StatusEvent,
  progress: ProgressEvent,
  molecule_focus: MoleculeFocusEvent,
  notice: NoticeEvent,
  agent_thought: AgentThoughtEvent,
  inspector_target: InspectorTargetEvent
} satisfies Record<StudioUiEventKind, ComponentType<StudioUiEventComponentProps>>

/**
 * Renders a validated Studio UI event through a closed, local component map.
 * Event text is always a React text node; extensions never influence rendering.
 */
export function StudioUiEventItem({ event, live }: StudioUiEventComponentProps) {
  const EventComponent = eventComponents[event.kind]
  return <EventComponent event={event} live={live} />
}
