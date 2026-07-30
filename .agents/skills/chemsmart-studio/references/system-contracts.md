# System contracts and cross-surface flow

## Runtime authority

| Layer | Owns |
|---|---|
| Electron main | project paths, molecule/draft/revision, durable transactions, runs, approvals, process supervision |
| React renderer | human interaction and presentation of validated state |
| Three.js engine | pure document-to-scene reconciliation and gesture intent |
| Python sidecar | bounded import, trajectory ledger, ChemSmart Agent adapter |
| Pinned ChemSmart | CLI grammar, synthesis adapter, semantic and intent gates |
| `schemas/v2` | active cross-process meaning and fixtures |

- Generate active TypeScript and Python models from Draft 2020-12 schemas. Never hand-edit generated files or produce C++ models.
- Authenticate the sidecar, then compare protocol version, schema SHA-256, and ChemSmart commit before marking it ready.
- Keep v1 decoders only for historical projects, receipts, trajectories, and conversation data. Normalize on read and upgrade transactionally on first successful mutation.
- Validate every renderer IPC input in main and every sidecar request/result at the boundary. Use typed IpcApi; never expose Node directly.

## Cross-surface mechanisms

1. **Project selection**: Explorer sends a human action to main; main resolves the path, validates/switches the project, rebinds the sidecar, publishes open documents, and refreshes Agent context.
2. **Molecule editing**: Stage sends stable-ID gesture intent; main revalidates document identity/revision, updates draft history, and broadcasts a complete display document. Agent action cues annotate but do not mutate selection.
3. **Console context**: completion returns an opaque context reference; accepting it makes main revalidate the file, then Python import or YAML projection opens a typed workbench tab.
4. **Agent work**: main issues a capability manifest and context references; the sidecar runs the bounded tool loop; host events stream tool state; artifacts and decisions return through schema-validated projection.
5. **Controlled calculation**: main prepares and reserves trusted state, Python opens the durable ledger, main claims `activeRunId`, and only durable verified frames reach Jobs and Stage.
6. **Replay and final decision**: main verifies run/frame/document/revision/hash, leases display-only geometry, and commits an accepted final frame through the normal durable molecule transaction.

## Human and Agent surfaces

- Human Explorer and Console may show or accept real paths through deliberate typed routes.
- Agent context remains path-free and receives opaque handles, safe names, hashes, summaries, and verified artifacts only.
- Background Agent, job, and replay events may update content and badges but cannot open panes, create approval wording, or move focus.
- Keep Agent and Console pane intent independent of window size. Responsive tiers choose dock versus relative sheet presentation, not whether a pane is open.

## Compatibility and provenance

- Keep upstream provider/window/lifecycle/data code only where active entrypoints use it. Product UI and accessibility strings must say ChemSmart Studio.
- Historical native/editor plans may remain inspectable as data but cannot resume or execute. No active code, package input, or skill may depend on them.
