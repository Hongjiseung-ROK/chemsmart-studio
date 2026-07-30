# ChemSmart Studio

![ChemSmart Studio icon](build/icons/128x128.png)

ChemSmart Studio combines a professional molecular workbench with an
agent-native computational-chemistry console. Version `0.1.4` is the current
Zhang Lab internal stable build for Apple Silicon.

Copyright © 2026 Zhang Lab. Maintained by Jiseung Hong.

## Install the internal macOS build

1. Open the private repository's
   [Releases](https://github.com/Hongjiseung-ROK/chemsmart-studio/releases)
   page.
2. Download `ChemSmart-Studio-0.1.4-arm64.zip`.
3. Expand the ZIP and move `ChemSmart Studio.app` to `Applications`.
4. On first launch, Control-click the app in Finder, choose **Open**, then
   confirm **Open**.

The application is ad-hoc signed for integrity, but it is not notarized by
Apple. The first-launch warning is therefore expected. Do not bypass macOS
security controls with a global quarantine or Gatekeeper disable command.

## Update

Updates are manual. Quit ChemSmart Studio, download the newer ZIP from the
private Releases page, and replace the application in `Applications`. Projects
and preferences are stored separately from the application bundle, but a
project backup is still recommended before updating.

## Current scope

The `0.1.4` workbench includes:

- main-owned molecule documents, revisions, draft history, undo, and redo;
- a Three.js molecular stage with periodic-table insertion, collision-safe
  coordination guides, explicit topology, overlays, and editing tools;
- project creation, import, save, and project switching;
- ChemSmart Agent, researcher console, jobs, trajectory, and replay surfaces;
- project-scoped Agent conversations with keyboard discovery for molecule,
  calculation, dry-run, decision, and result context;
- streaming Agent answers, grouped host-observed tool activity, project-scoped
  threads, structured scientific artifacts, and exact inline decisions;
- visible-molecule grounding and project-free xTB preflight without persisted
  provider reasoning or private training capture;
- explicit decisions for calculation execution and final geometry;
- a guided Click-derived Console with semantic completion, deterministic
  preflight, and molecule/YAML tab opening;
- a read-only semantic project-YAML renderer and approval-bound Gaussian/ORCA
  YAML proposals;
- Protocol v2 runtime contracts with version/hash handshake and narrow v1
  historical readers;
- relative dock and compact-sheet layouts that preserve researcher intent and
  allow hidden Agent or Console panes to reopen at every window size.

This is an ad-hoc-signed internal research build, not a notarized public macOS
release. Do not use this version as the sole record for regulated,
safety-critical, or publication-final calculations.

## Support

Report bugs, workflow problems, and feature requests through the private
[GitHub Issues](https://github.com/Hongjiseung-ROK/chemsmart-studio/issues)
page. Do not include credentials, private provider payloads, unpublished
structures, or sensitive filesystem paths in an issue.

## Development

Requirements are pinned in `package.json`. Install dependencies with `pnpm
install`, run the app with `pnpm dev`, and validate changes with:

```sh
pnpm lint
pnpm test
pnpm format
pnpm build:check
```

The internal macOS artifact is built with `pnpm build:mac`.

## License and corresponding source

ChemSmart Studio is distributed under
[AGPL-3.0-only](LICENSE). Every internal binary recipient must retain access to
the corresponding source in this private repository. Third-party and upstream
copyrights and licenses are retained in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and in the legal resources
embedded in the application bundle.
