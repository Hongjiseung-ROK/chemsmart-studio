# ChemSmart Studio contribution guide

The maintained contribution contract is [CONTRIBUTING.md](../../CONTRIBUTING.md).

Changes target `main`, remain focused, include tests, and use signed-off
Conventional Commits. Before opening a private pull request, run:

```sh
pnpm lint
pnpm test
pnpm format
pnpm build:check
```

Never commit credentials, unpublished molecular data, private provider
payloads, researcher paths, or local agent-session evidence.
