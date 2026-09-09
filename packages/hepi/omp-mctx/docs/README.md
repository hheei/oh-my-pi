# omp-mctx documentation

## Product documentation

- [Features](features.md) — user-visible capabilities and configuration behavior
- [Implementation](implementation.md) — ownership, data flow, and storage
- [Maintainers](maintainers.md) — host integration, recovery, and maintenance
  notes

The package [README](../README.md) is the getting-started and configuration
reference.

## Supporting material

- [Compaction state research](compaction-state-research.md) — implementation
  research and future integration considerations; not a product contract.
- Runtime prompt sources under `src/**` are model inputs, not user-facing
  documentation. `src/core/features/smart-notes/PARITY.md` documents a focused
  compiled-runtime test boundary. `src/handoff/README.md` records the
  handoff contract, although `/handoff` is not registered by omp-mctx.
