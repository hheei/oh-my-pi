# Maintainers

Host layout, lineage, and gaps that are not part of the user-facing AgentMemory
story. Product behavior: [features.md](features.md). Wiring:
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

## Lineage

Three-way merge, not a v0.40.1 fork (ADR-0002):

1. HEPI `packages/pi-mctx` (fail-closed SQLite + in-process latch)
2. Host overlay from cortexkit `packages/pi-plugin@0.40.1`
3. Mapped `src/core` cherry-picks from pin `7dcd2e5726a1466126b2eea460482cca2b53283b`
   through `v0.40.1` (`a239835e`)

Do **not** copy official `packages/pi-plugin/src` over `src/core`.

## Remaining gaps

**Intentional HEPI rewrite (do not graft CortexKit machinery):**

- Nudge cadence: `lastLevel` + `channel1TurnsSinceNudge`. Not CortexKit
  `realUserTurnCount` / `lastOrdinal` / `shouldUseStickyChannel1Reminder` /
  `tail-hygiene-walk` (`bc7862f`, `656ab0f`, `c0b060b`).
- `5f031cd` copy is HEPI-adapted (“Housekeeping, not a crisis”) with
  `usableTokens`; not byte-for-byte `usableWindow` ratio + sticky ordinal.
- `ee3c812` `agentDropsAppliedThisPass` is the CortexKit queued-drop hygiene
  bit; HEPI has no walker, so the field is absent.

**Host / missing-file skip:**

- `1b7648a`: Rust transform + audit scripts only (not a TS nudge rewrite).
- `efa6ee2`: Rust-only; TS already keeps real tool-argument keys.
- No `command-handler.ts` (`975e450` sinkless TUI), `storage-session-tables.ts`
  (`978ea89` / `746963e`), `project-security.ts` (`d45749c`).

**Mapped recovery now in this package:**

- LKG capture/replay is on the Pi `context` handler via `lkg-pi.ts`
  (`piMessagesToLkg` / `lkgMessagesToPi`). Do not cast `AgentMessage` to
  `MessageLike`. Slots persist in `lkg_slots`.
- `RawFallbackContextLimitError` is a loud abort: rethrown, and thrown when a
  failed transform would otherwise fall through with an original prompt
  estimated above the resolved context limit.

**Inapplicable (not a remaining port):**

- `714bc4c` migration-blocker process evidence. OMP does not keep a
  multi-process schema-migration lane; `FailClosedReason` is only
  `storage_failure`.

**Known AgentMemory follow-ups (not missing ticket work):**

- Restoration after privacy withdrawal is a new epoch; the store does not
  resurrect a withdrawn head.
- `gcUnreachableRecall` deletes eligible events, not unused epoch rows.
- This package does not ship an agentmemory Docker Compose file. Use an
  unmodified upstream service.
