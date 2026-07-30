# Scientific Agent workbench

## Conversation experience

- Keep the right pane dedicated to ChemSmart Agent: thread header, one conversation, contextual status or inline approval, and sticky composer.
- Scope multiple independent threads to the active project. New threads inherit no prior conversation context; imported legacy conversation stays folded and opt-in.
- Stream safe assistant text deltas as transient events. Reconcile completion against the canonical structured answer; do not persist partial deltas.
- Render user request, assistant prose, grouped host-observed tools, inline approval, and compact scientific artifacts in reading order.
- Collapse successful tool groups to a bounded summary. Keep failed, denied, or approval-waiting tools open. Never steal composer focus or auto-open the pane for background activity.
- Never show or store raw chain-of-thought, `reasoning_content`, provider payloads, filesystem paths, credentials, Markdown approval cards, or model-authored trusted UI.

## Grounding and capabilities

- Obtain the visible scientific state from main-issued `StudioWorkspaceContext`: opaque project, committed document/revision/hash, display binding, draft hash/change count, selection, editor mode, panes, and active run/frame.
- Issue path-free context references for project, current molecule, selection, and current run/frame. Reject expired or foreign references.
- Main selects `inspect`, `plan`, or `act` for each turn. Text, provider output, and tool output cannot widen capability.
- Treat ambiguous requests as inspect or ask for clarification. Picker selection alone never commits or executes.
- Use the visible immutable draft for analysis and dry-run. Commit through Apply & Continue before a real calculation starts.

## Tool and result truth

- Generate reasoning summaries and tool lifecycle from host callbacks, not model prose.
- Require the model to finish tool turns with schema-validated `report_studio_result`. Publish only normalized answer sections and verified artifacts.
- Keep ChemSmart command synthesis deterministic: compact SPEC, adapter, real Click parser, safe dry-run, separate intent and semantic gates, exact approval, then execution.
- The semantic gate asks whether a command can run. The intent gate separately asks whether it still performs the requested chemistry. Passing one never substitutes for the other.
- Do not carry historical training or benchmark campaigns into product decisions.

## Approval and control

- Always require exact one-shot approval for `run_local`, `submit_hpc`, and `execute_chemsmart_command`. Bind approval to validated arguments, document revision/hash, engine, method, task, charge, and multiplicity as applicable.
- Keep final geometry accept/reject and run cancellation as researcher controls. Do not let the Agent approve its own compute or final result.
- Bind YAML write approval to the immutable candidate preview and digests; never accept regenerated YAML after approval.
- Denial of an active execution tool terminalizes the tool and turn with no
  provider retry, sibling execution, or process. Denial of a post-turn YAML
  candidate terminalizes that artifact decision and writes nothing. Changed
  molecule or settings invalidate an existing approval.
- Stop cancels the active provider/tool boundary, Steer applies at a safe boundary, and Queue runs only explicitly queued turns.
- Produce exactly one terminal outcome: completed, denied, failed, cancelled, or needs-user.

## Privacy

- Keep transcript projections and receipts private (`0600`) under private session directories (`0700`).
- Disable training capture in Studio. Do not create, package, inspect, or export `var/agent-training` from the application.
