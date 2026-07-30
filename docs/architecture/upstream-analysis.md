# Upstream reuse analysis

Audit date: 2026-07-30. Exact active commits and trees are machine-readable in
`upstreams.lock.json`.

## Inherited application foundation

ChemSmart Studio retains the actively referenced provider/model gateway,
Electron window lifecycle, application lifecycle container, data services,
i18n, central logger, secure preload boundary, typed `IpcApi`, shared
`@cherrystudio/ui` components, and electron-builder pipeline inherited from its
original application foundation. These are internal implementation layers, not
consumer product routes or visible product identity.

The provider boundary remains the local gateway. Studio therefore does not add
a second credential-distribution or provider-configuration system.

## Pinned ChemSmart

The clean pinned ChemSmart submodule supplies the Click command tree,
deterministic synthesis adapter, parser, intent and semantic gates, Agent tool
registry, approval decisions, project-YAML rendering, and calculation/HPC
workflow primitives.

The Python bridge adds Studio context binding, RPC approval, path-free molecule
tools, bounded import, Protocol v2 identity, and portable trajectory storage.
Electron main remains responsible for projects, revisions, trusted decisions,
atomic YAML publication, supervised execution, and human-facing projections.

## Historical provenance

The retired native prototype evaluated AvogadroLibs and Qt. That lineage is
provenance only: no gitlink, lock entry, runtime branch, package helper, UFF
adapter, C++ generator, or current development instruction depends on it.
Current molecule authority is TypeScript main, rendering is embedded Three.js,
and trajectory/import work belongs to Python.

No source or secret is copied from a dirty external ChemSmart checkout. Only the
reproducible pinned submodule commit is executable dependency input.
