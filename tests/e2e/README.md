# ChemSmart Studio E2E tests

This directory contains the Electron launch smoke test for the ChemSmart Studio
workbench. Run it after building the application:

```bash
pnpm build
pnpm playwright test tests/e2e/specs/app-launch.spec.ts
```

Product workflow acceptance is maintained in Studio-specific component tests.
The retired Cherry consumer routes are intentionally not represented here.
