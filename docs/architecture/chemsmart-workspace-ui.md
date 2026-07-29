# ChemSmart Workspace UI decision

## Decision

ChemSmart Studio uses a dedicated `/app/chemsmart` route whose page owns one
scientific workspace state surface. ChemSmart is not a `TopicRightPane`
capability. Generic conversation resource, branch, and trace panels remain
available only in the generic conversation route.

The workspace adapts by priority:

1. Wide: project and molecule navigation, scientific work surface, and
   ChemSmart Agent activity are visible together.
2. Medium: project navigation collapses before molecule or Agent state.
3. Narrow: Molecule, Agent, and Run tabs share a persistent document and
   trusted-decision status strip.

Pending trusted approvals, active runs, and actionable failures live outside
the scrollable scientific detail regions. The native 3D Molecule Editor remains
a lifecycle-owned companion window until existing architecture can prove safe
in-process embedding, input routing, and crash recovery.

Cross-process state continues to arrive only through schema-validated snapshots
and ordered events. The renderer may choose presentation from trusted host
state, but neither a model response nor an untrusted event can create approval
wording, trusted controls, raw paths, arbitrary HTML, or layout.

## Why maximizing the old panel is insufficient

`canMaximize` changes only the geometry of a generic trailing capability. It
does not change product ownership or reading order, remove the assistant rail
and generic empty chat, establish scientific navigation, preserve critical
decisions outside a scroll boundary, or define responsive degradation.
Maximizing also leaves two competing ChemSmart surfaces: the generic
conversation remains the owning route while the scientific state is an
optional panel. A dedicated route makes the scientific workspace the owner,
allows one recoverable state model, and gives approval, run, replay, and Agent
state stable placement at every supported window size.
