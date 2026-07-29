# Upstream reuse analysis

Audit date: 2026-07-28. Exact active commits are machine-readable in
`upstreams.lock.json`.

## Cherry Studio

Cherry supplies the React chat shell, provider/model settings, AI Core, data
layer, i18n, central logger, secure preload boundary, typed `IpcApi`, lifecycle
container, path registry, and electron-builder pipeline. ChemSmart Studio
extends those boundaries through the self-contained
`src/main/features/chemsmartStudio` domain.

The model boundary remains Cherry's local API gateway. It preserves OpenAI Chat
Completions tool-call shapes and resolves gateway model addresses, so Studio
does not add a second provider or secret-distribution layer.

## ChemSmart

The pinned ChemSmart agent supplies `AgentSession.run_loop()`, provider wire
adapters, deterministic harness gates, the tool registry and permission policy,
approval decisions, decision logs, and workspace/geometry/calculation tools.
Studio imports those components from the clean pinned submodule.

The bridge adds a Cherry provider adapter, RPC-backed approval, path-free Studio
molecule tools, bounded molecular import, and the portable optimization
trajectory store. Electron main remains responsible for trusted UI state,
project persistence, exact-argument approval cards, and supervised execution.

## Retired Avogadro lineage

AvogadroLibs was evaluated and used in the historical native-editor prototype.
That architecture has been retired: the gitlink and lock entry are absent, the
repository contains no Qt/Avogadro helper or UFF execution path, and historical
plans are read-only evidence. Current molecule authority is TypeScript main,
rendering is Three.js, and trajectory/import work belongs to Python.

The historical validation receipts remain append-only. They prove prior
behavior; they do not describe current runtime or packaging readiness.

## Explicit non-reuse

The dirty `/Users/hongjiseung/developer/chemsmart` checkout and its untracked
application trees remain excluded. No application scaffold, packaging claim, or
local secret is imported from them. Only the reproducible pinned ChemSmart
commit is executable dependency input.
