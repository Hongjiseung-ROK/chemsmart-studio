# Project workspace

## Authority and layout

- Treat `.cmsproj` as the canonical project package. Main alone owns its real path, active-project binding, manifest, molecule document, receipts, and run ledgers.
- Keep Explorer a human surface. `ResearchRail` may show main-issued paths from `chemsmart_studio.workspace.roots`; Agent contracts may not.
- Identify projects outside main with the opaque `projectHandleId`. Main keeps the only reverse map and rejects handles it did not issue.
- Keep project Open, Import, and Save As in Explorer and the Studio command palette. Open documents belong in IDE-style workbench tabs.

## Durability and switching

- Validate complete manifests and molecule documents before publishing state.
- Write same-directory journals and private temporary files, sync them, rename them atomically, and only then publish the new in-memory revision.
- Recover only hash-valid journals. Fail closed on ambiguous or corrupt recovery state.
- Before switching projects, stop the active Agent turn and controlled run as required, deny pending approvals, and close transient capabilities.
- Rebind the sidecar only after the new project transaction succeeds. If rebinding fails, restore the prior project and binding.

## Import and documents

- Keep real import paths in main. Issue a bounded opaque capability, verify regular-file/no-symlink identity, and serve fixed-size chunks to Python.
- Accept schema-validated `MoleculeDocument` results. Preserve explicit CJSON/SDF topology.
- Permit XYZ bond inference only during import. Record algorithm/version provenance and show it for researcher review.
- Opening a molecule candidate from Console or Explorer creates or switches to
  its durable project and activates a workbench tab without exposing its path to
  Agent state.

## Project YAML

- Treat raw YAML as the only data authority. The semantic renderer is read-only and must preserve ordered unknown nodes, scalar types, explicit values, inherited defaults, digest, and validation findings.
- Use one renderer for Explorer YAML, Console-selected YAML, and Agent candidate review.
- Expose `render_project_yaml` only as a Gaussian/ORCA plan tool. Do not require or generate project YAML for xTB.
- Main privately binds an Agent YAML candidate to the active project. Expose only
  `previewId`, base digest, candidate digest, expected revision, validation
  verdict, and `changedSections` semantic summary to the review surface.
- Write only after exact one-shot approval and main revalidation. A changed base digest or project binding invalidates the preview. Denial, expiry, or failure writes nothing.
