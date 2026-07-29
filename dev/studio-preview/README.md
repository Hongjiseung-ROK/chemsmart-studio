# Studio UI preview harness

Serves `ChemSmartWorkspace` in a plain browser with the **real** components, design tokens and English
copy, and replaces only the IPC boundary with an in-page mock. It exists so the Studio surface can be driven
and screenshotted deterministically — no molecule editor, no agent, no calculation, no Electron.

```bash
npx vite --config dev/studio-preview/vite.config.ts
# http://127.0.0.1:5199/?scenario=working
```

## What is real and what is not

| Real | Mocked |
| --- | --- |
| Every `ChemSmartStudio/*` component, `@cherrystudio/ui`, Tailwind theme tokens, `en-us.json` copy | `@renderer/ipc` (`mocks/ipc.tsx`) |
| Container-tier behaviour (a real `ResizeObserver` on a real window) | `@renderer/data/hooks/useCache` — in-memory, so every reload starts from the default layout |
| Panel geometry, collapse/expand, transitions | `@renderer/hooks/useModel`, `@logger` |

The Three.js stage is the same component used by the Electron app. The harness supplies a trusted
`MoleculeDocument` through its IPC mock; it does not start a native helper or a calculation.

## Scenarios

`?scenario=` selects one of `empty`, `working`, `human-edit`, `approval`, `running`, `final`, `standalone`
(see `scenarios.ts`). `?theme=dark` renders the dark theme.

The mock is **stateful**: proposing a patch really produces a preview approval, and committing it really
advances the document revision and the coordinate table, so a whole flow can be screenshotted end to end.

`window.studioHarness` exposes `setScenario`, `setViewport`, `pushEvents` and `requests` for scripted runs.

## Why it exists

It found the defects fixed in the commits that introduced it, including a panel-group desync that left the
inspector and the command workbench rendered open while their toggles reported closed — visible, `inert`,
and off by one on every press. Nothing in jsdom reproduces that: the panel group needs a real layout pass.
Prefer this harness for anything about size, overflow, collapse or motion.
