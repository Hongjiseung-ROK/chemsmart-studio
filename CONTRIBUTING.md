# Contributing to ChemSmart Studio

ChemSmart Studio is maintained for Zhang Lab research workflows. Discuss
substantial product, protocol, or chemistry changes in a private GitHub Issue
before implementation.

## Development workflow

1. Branch from `main`.
2. Keep changes focused and add tests for changed behavior.
3. Run `pnpm lint`, `pnpm test`, `pnpm format`, and `pnpm build:check`.
4. Use a Conventional Commit with a specific scope and add a Developer
   Certificate of Origin sign-off:

   ```sh
   git commit --signoff -m "fix(studio-workbench): describe the change"
   ```

5. Open a pull request to `main` and include the tested workflow, gate results,
   known limitations, and screenshots for visible UI changes.

Never commit credentials, provider payloads, unpublished molecular data,
machine-local paths, or agent-session evidence. A calculation must not run and
an irreversible decision must not be granted merely to satisfy a test.

The project is licensed under [AGPL-3.0-only](LICENSE). By contributing, you
certify that you have the right to submit the contribution under that license.
