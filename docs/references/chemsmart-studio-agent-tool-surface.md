# ChemSmart Studio agent tool surface

This document is the review boundary for tools exposed to the ChemSmart agent. A tool is unavailable
unless it appears in the phase profile in
`services/chemsmart_bridge/src/chemsmart_studio_bridge/runtime.py`. Unknown tools fail closed.

## Exposed execution tools

The execution phase exposes three generic ChemSmart tools. They are never session-approved, including
in Execute mode. Each invocation requires a trusted card for the exact schema-validated arguments,
and an `allow_session` response is reduced to `allow_once`.

| Tool | Exact approval arguments | Policy |
|---|---|---|
| `run_local` | `{ job }` | Always ask; `job` is an opaque handle |
| `submit_hpc` | `{ job, server?: string \| null, execute?: boolean }` | Always ask; `server` is a path-free configured name |
| `execute_chemsmart_command` | `{ command, test?: boolean, timeout_s?: number }` | Always ask; `command` cannot contain path separators |

The model-facing input schemas use the same narrowed shapes. Denial returns a visible denied outcome
without invoking the tool.

## Exposed read-only tools

`recommend_method` is available during synthesis. `inspect_calculation` is available during
diagnostics and accepts only an opaque run ID. Main-owned session roots are injected internally, and
filesystem-bearing keys or text are removed from the result before it returns to the model.

## Deliberately withheld tools

These tools have no trusted Studio surface and therefore do not appear in any phase:

| Tools | Missing trusted surface |
|---|---|
| `save_geometry` | Main-owned revision-bound molecule transaction |
| `ssh_probe`, `scheduler_query`, `log_tail` | Bounded server/run capabilities with path-free result projection |
| `read` | A generic filesystem read is incompatible with the path-free agent boundary |
| `render_project_yaml`, `update_project_yaml`, `write_project_yaml` | Main-owned project preview, validation, revision binding, and durable commit |
| `wizard_write`, `write_behavior_rules` | Explicit researcher review and a bounded destination contract |

`read_project_yaml`, `validate_project_yaml`, and `critic_project_yaml` remain narrow named-project
operations. They do not authorize any of the withheld writers.

## Phase cap

Each task phase exposes at most ten direct tools. The cap is tested together with the exact exposed
and withheld sets so adding a tool requires an explicit policy and phase decision.
