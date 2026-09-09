# Maintainers

Host layout, lineage, and maintenance notes for the AgentMemory integration.
Product behavior: [features.md](features.md). Wiring:
[implementation.md](implementation.md).

## Host

- Settings: OMP plugin settings only (`getPluginSettings`). No CortexKit
  `magic-context.jsonc` dual-read (ADR-0005).
- Store: `${OMP_CODING_AGENT_DIR:-~/.omp/agent}/extensions/omp-mctx/`.
- `/handoff` is not registered. `src/handoff` is excluded from the build.
- Factory: `loadOmpMctxPluginSettings` → `shouldStartOmpMctx` (`enabled === true`)
  → latch + boot quiet period.

### Memory schema modes

- **Window-only (default):** fresh `context.db` has Window/session tables,
  `message_history_fts`, `lkg_slots`, recall ledger, and projection tables. It
  has no legacy memory, embedding, authority, or mirror tables.
- **Legacy Memory data:** old tables and rows remain untouched. New databases
  do not create the legacy schema.
- Both modes use only
  `${OMP_CODING_AGENT_DIR:-~/.omp/agent}/extensions/omp-mctx/context.db`.

Durable architectural decisions: `docs/adr/0010-mctx-sole-agentmemory-bridge.md`
in the repo root. Glossary: root `CONTEXT.md`.

## Capability matrix

| Area | Current state |
| --- | --- |
| Window, Historian, session-history, status | Active when the plugin is enabled; Historian-dependent work also needs `historianModel`. |
| AgentMemory bridge, capture, tools, recall | Optional and controlled by the public `agentmemory.*` settings. |
| Legacy Dreamer, automatic-search, git indexing, embeddings, local durable memory | Retained in source or schema for compatibility, but disabled in the current OMP integration. |
| Project-docs and user-profile injection | Disabled by the OMP host wiring. Do not document as active behavior without changing that integration. |
| `/handoff` | Not migrated or registered. |

The published manifest is the supported settings surface. Runtime-recognized
advanced keys documented in the README are not automatically public API.
Configuration is loaded at extension startup; `/reload` is required after a
settings change. Keep this distinction when adding a new setting or changing
the manifest.

## Lineage and portability

The package is an OMP adaptation assembled from the HEPI mctx implementation,
the CortexKit host overlay, and selected upstream history. It is not a
drop-in copy of any one upstream package. Keep the adaptation boundary narrow:
host-specific lifecycle wiring belongs in the OMP integration layer, while
Window, projection, and recovery behavior remains in the mctx-owned modules.

When comparing with upstream, preserve the HEPI-specific nudge and
fail-closed behavior, and do not reintroduce host-only walkers, migration
lanes, or command handlers that are not part of OMP. Validate changes against
the current OMP extension API rather than copying upstream files wholesale.

### Recovery implementation

- LKG capture/replay is on the Pi `context` handler via `lkg-pi.ts`; keep
  `AgentMessage` and `MessageLike` conversions explicit.
- `RawFallbackContextLimitError` is intentionally loud. A failed transform
  must not silently send an over-limit original prompt.
- Do not delete durable session rows on compaction, session switch, or
  shutdown. These are reversible boundaries; process-local caches are cleared
  separately.
- Native compaction while mctx compaction is off invalidates cached m[0]/m[1]
  and relies on the next transform or restart to rebuild alignment.
### Operational notes

- Privacy withdrawal starts a new projection epoch; a withdrawn head is not
  eligible for LKG recovery.
- Recall garbage collection removes eligible unreachable events, not epoch
  rows that remain part of the lineage.
- The package does not ship an AgentMemory Docker Compose file; use an
  unmodified upstream service.
