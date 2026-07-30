---
name: chemsmart-studio
description: Develop, audit, test, document, or release ChemSmart Studio as one integrated computational-chemistry IDE. Use for project selection and persistence, the Three.js molecular workbench, the guided ChemSmart console, the scientific Agent workbench, Protocol v2 contracts, typed Electron/Python boundaries, approvals, validation, packaging, or cross-surface workflow changes in the ChemSmart Studio repository.
---

# ChemSmart Studio

Build one professional scientific workbench: GaussView-class molecule interaction with a Cursor-class console and Agent experience. Treat the live repository and generated Protocol v2 contracts as authority; treat session plans, old skills, and historical prototypes as non-authoritative.

## Start safely

1. Confirm the repository root, branch, HEAD, dirty state, remotes, and submodule status. Preserve unrelated work.
2. Read root `AGENTS.md`, the nearest nested `AGENTS.md`, relevant local README files, `DESIGN.md` for UI work, and `upstreams.lock.json`.
3. Run `./dev/studio doctor --json`. It is read-only; do not install or repair from doctor.
4. Verify `vendor/chemsmart` matches the lock before relying on its CLI or Agent behavior. Never edit `vendor/` directly or copy from a dirty external checkout.
5. Do not read or print `api.env`, provider credentials, socket secrets, raw provider payloads, or private Agent reasoning.

## Preserve the product boundary

- Electron main owns project paths, `.cmsproj` durability, committed and draft molecule state, revisions, run lifecycle, trusted approvals, and helper supervision.
- `packages/chem-molecular-engine` renders complete validated documents with Three.js and emits gesture intents only.
- The Python sidecar owns bounded molecule import, portable trajectory ledgers, and the pinned ChemSmart Agent adapter.
- `schemas/v2` owns active process-boundary meaning and generates TypeScript and Python models. Keep v1 only for narrow historical reads.
- The renderer receives typed IpcApi data. Never expose Node, raw filesystem access, provider arguments, or an unvalidated sidecar payload.
- Keep the inherited provider, window, lifecycle, data, and `@cherrystudio/ui` foundations internal. Do not restore consumer Cherry product routes or identity.
- Do not reintroduce Qt, Avogadro, UFF, IOSurface transport, fork-owned native C++, CMake integration, or C++ protocol output.

## Route the work

- Project selection, Explorer, import, persistence, project switching, or YAML viewing: read [references/project-workspace.md](references/project-workspace.md).
- Molecule rendering, building, drafts, stable-ID picking, placement, overlays, run/replay display, or gestures: read [references/molecular-workbench.md](references/molecular-workbench.md).
- Human Console, completion, semantic guidance, preflight, execution, or file/YAML opening: read [references/console.md](references/console.md).
- Agent threads, streaming, context grounding, tools, artifacts, YAML proposals, decisions, or execution approval: read [references/agent-workbench.md](references/agent-workbench.md).
- Schema, IPC, lifecycle ownership, cross-pane data flow, compatibility, or package architecture: read [references/system-contracts.md](references/system-contracts.md).
- Validation, evidence, claims, release status, package audit, or process cleanup: read [references/trust-and-delivery.md](references/trust-and-delivery.md).

Load only the references needed for the task. For a cross-surface change, read `system-contracts.md` plus each affected surface reference.

## Work narrowly

1. Identify the authority and the user-visible invariant before editing.
2. Add or update the smallest schema/service/component boundary that owns the behavior.
3. Validate external input in main and keep Agent contracts path-free.
4. Add focused regression coverage and inspect the real UI when behavior is visual or interactive.
5. Run broad gates once at the appropriate milestone, not after every small edit. Re-run only failures and affected checks.
6. Report passed, failed, unavailable, and intentionally untested evidence separately. Never convert a focused pass into release readiness.
