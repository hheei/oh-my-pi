# Project Context

This file is the shared glossary for design and architecture discussions. Keep
it free of implementation details.

## Fork

- **Fork**: `hheei/oh-my-pi`, the downstream repository for local development.
- **Upstream**: `can1357/oh-my-pi`, the source repository whose `main` is synced
  into the fork.
- **Local main**: the fork's synchronization branch, tracking `origin/main`.
- **Upstream robot**: the automated upstream workflow that handles bug issues;
  bug reports should describe reproduction and observed behavior clearly.

## Extension

- **hepi extension**: fork-owned functionality that lives under
  `packages/hepi/omp-<name>/` and is designed to be independently testable and
  publishable as an npm package named `omp-<name>`.
- **Integration hook**: the smallest upstream source change that delegates to
  a fork-owned extension while preserving upstream behavior when the extension
  does not apply.
