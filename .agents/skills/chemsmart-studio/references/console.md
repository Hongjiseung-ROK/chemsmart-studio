# Guided scientific Console

## Human execution boundary

- Treat Console as a human surface. A command the researcher submits does not require Agent approval.
- Never expose `StudioConsoleService` to the Agent tool loop. Agent execution uses its separate approval-gated path.
- Run no Python, ChemSmart, xTB, or chemistry process while the user is typing or browsing completions.

## Completion authority

- Generate the completion manifest from the pinned ChemSmart Click tree. Include ChemSmart version, upstream commit, and schema hash; do not maintain a second manual flag table.
- Read the manifest through the central path registry. A missing or mismatched manifest disables guidance only; it must not disable human Console execution.
- Parse raw ranges, quotes, escapes, `--option=value`, repeated options, nargs, and mid-line suffixes. Reject unsupported shell operators and invalid prefixes instead of suggesting false candidates.
- Compare request generations and discard late completion responses. Clear cached items, semantic slots, and ghost text immediately when the command becomes empty or no longer matches.

## Guided interaction

- Show a semantic rail with command breadcrumbs, required `⟨slot⟩`, optional `[slot]`, and remaining option count.
- Group popup entries by command, option, value, file, project, and server. Show kind, short description, expected value, enum/range, or example where available.
- Use Up/Down for selection, Tab or popup Enter to apply, Shift+Tab for the previous required slot, Escape to dismiss, and Ctrl/Cmd+Space to reopen.
- Keep the popup in a workspace overlay layer so Console scrolling and panel clipping cannot obscure it. Preserve Console input, cursor, and focus.
- Do not require or auto-insert `-p` for xTB; project-free `sp`, `opt`, and `hess` remain valid.

## File and YAML opening

- Attach a main-issued `contextRef`, fixed validated format, and typed
  `openAction` only to an exact supported candidate.
- On acceptance, revalidate the one-shot handle, root membership, real path,
  regular-file/no-symlink identity, size, device, and inode in main.
- Open `.xyz`, `.cjson`, and `.sdf` through the Python importer by creating or
  switching to its durable project and activating the 3D tab. Open
  Gaussian/ORCA project YAML in the shared semantic renderer.
- Do not add generic renderer filesystem IPC or auto-open unsupported output/log formats.

## Preflight and run

- Run deterministic parser, intent, semantic, and dry-run inspection only after a structurally complete command is submitted.
- Green executes on the first Enter. Warning requires a second Enter bound to the same command digest. Rejected focuses the invalid slot and starts no process.
- Show safe program, task, input name, charge, multiplicity, rule IDs, and verdict. Hide paths, secrets, and provider data from Agent-facing projections.
- Bind output and exit events to a run ID so late output from a cancelled command cannot appear under a later run.
