# ChemSmart Workspace UI decision

## Decision

`/app/chemsmart` is the sole product workspace. Its information architecture is:

```text
Activity | Explorer | Stage and editor tabs | ChemSmart Agent
                    | Console / Jobs / Problems
```

- Explorer owns project selection and human file context.
- The embedded Three.js Stage is the dominant document surface.
- Console is docked only beneath the central Stage column; it never extends
  beneath Explorer or Agent.
- The right pane is dedicated to Agent threads, streamed prose, grouped tool
  lifecycle, inline decisions, and structured artifacts.
- Properties opens as a contextual Sheet. Decisions live inline and in artifact
  Review; they are not permanent peer tabs beside Agent.

The generic consumer Sidebar, browser tab bar, Launchpad, and Chat, Work,
Translation, Paintings, Knowledge Base, Files, Code, Notes, or Mini App routes
are not product UI. Active inherited framework services remain internal.

## Pane intent and presentation

Pane intent records whether the researcher opened a pane and its normalized
splitter ratio. Window size may change only presentation:

- wide/focused workspaces use docked panes when space permits;
- compact workspaces use relative Sheets;
- Agent and Console toggles remain directly available in the title bar;
- resizing never closes a pane, changes its intent, clears input, or steals
  focus;
- closing a compact Sheet removes it from the focus and accessibility trees but
  preserves other pane intent.

Explorer and Agent open by default in a wide clean profile. The bottom panel is
closed until explicitly requested. Background Agent, job, or replay events may
update content and badges but cannot open a pane or move focus.

## Scientific interaction

The Stage always labels whether it shows committed, draft, run, or replay
geometry. Build tools use stable IDs, explicit bonds, a searchable periodic
table, and a user-selected Coordination guide. Main rotates validated geometry
templates, applies element radii, checks global clearance, and returns only safe
placement sites. Changing tools clears prior selection; Agent action overlays
never replace researcher selection.

The guided Console shows Click-derived completion in a workspace overlay,
semantic required/optional slots, and green/warning/rejected preflight. Exact
molecule candidates open through the existing importer; project YAML opens in a
read-only semantic tab. Typing and completion start no chemistry process.

The Agent conversation streams safe prose deltas while host callbacks report
tool progress. Successful groups collapse to summaries; failures, denial, and
approval remain open. Raw reasoning, provider payloads, credentials, paths, and
model-authored trusted controls never render.

## Trust boundary

Cross-process state arrives only through Protocol v2 validated snapshots and
ordered events. Renderer presentation may derive from trusted host state, but
neither a model response nor an untrusted event can create approval wording,
filesystem authority, arbitrary HTML, pane activation, or scientific state.
