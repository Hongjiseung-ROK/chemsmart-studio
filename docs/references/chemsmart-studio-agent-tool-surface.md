# ChemSmart Studio Agent tool surface

This document is the review boundary for tools exposed to ChemSmart Agent. A
tool is unavailable unless it is selected by the main-issued capability and
appears in the bounded phase profile in
`services/chemsmart_bridge/src/chemsmart_studio_bridge/runtime.py`. Unknown tools
fail closed.

## Capability profiles

Main selects one capability for each turn. Model text, provider payloads, and
tool output cannot widen it.

| Capability | Purpose | Representative tools |
|---|---|---|
| `inspect` | Read the visible scientific state and existing results | `get_studio_context`, `analyze_current_molecule`, `get_optimization_status`, `get_optimization_replay`, `list_calculation_artifacts`, `inspect_calculation`, `recommend_method` |
| `plan` | Inspect plus prepare, validate, preview, or dry-run | optimization preparation/validation, molecule preview, synthesis/repair, project-YAML read/render/validate/critic |
| `act` | Publish a reviewed draft or enter an approval-gated execution boundary | prepared optimization start, local/HPC/command execution, status, terminal result |

Every phase remains capped at ten direct tools and ends through the structured
`report_studio_result` contract. The active molecule, project, run, artifact,
and YAML bindings are opaque IDs and hashes; the model does not receive a path.

## Project YAML

`render_project_yaml` is a read-only plan tool for Gaussian and ORCA. It creates
a schema-validated candidate privately bound by main to the active project,
base digest, candidate digest, expected revision, and `changedSections` semantic
summary. xTB does not require project YAML and its profile excludes this tool.

`write_project_yaml`, `update_project_yaml`, and generic filesystem writers are
not model tools. The candidate appears as a trusted artifact; an exact one-shot
decision binds its immutable preview and digests. Main revalidates the source
and owns the atomic write. Denial, expiry, or stale context writes nothing.

## Execution approvals

These tools always require an exact one-shot trusted decision in both Agent
modes:

| Tool | Bound arguments |
|---|---|
| `run_local` | opaque validated job |
| `submit_hpc` | opaque job, configured server name, execute flag |
| `execute_chemsmart_command` | validated path-free command, test flag, timeout |
| `start_prepared_optimization` | current document/revision/hash and validated calculation preparation |

Approval is also bound to relevant molecule revision/hash, engine, method,
calculation kind, charge, and multiplicity. Changing those values invalidates
the decision. Denial terminalizes the tool and turn, skips siblings and provider
retry, and starts no process.

Cancellation and final-geometry accept/reject are trusted researcher controls;
the Agent cannot approve them for itself.

## Human surfaces are separate

The researcher-operated Console is not exposed to the Agent tool loop. A human
Console command uses deterministic parser/intent/semantic/dry-run preflight but
does not gain an Agent approval card. Explorer and Console may use deliberate
human path routes; Agent context remains path-free.

## Withheld surface

Generic `read`, unrestricted project writers, behavior-rule writers, SSH probe,
scheduler query, and log tail remain unavailable until a bounded, path-free,
researcher-reviewable Studio surface exists. Safe omission is intentional; a
future tool requires both a schema and an explicit capability/approval decision.
