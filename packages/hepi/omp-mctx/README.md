# @hheei/omp-mctx

OMP Window and agentmemory bridge owner: historian compaction, compartments,
`ctx_reduce` / `ctx_expand` / `ctx_note`, and the optional agentmemory REST
integration. The unmodified agentmemory Docker service remains the canonical
Durable Memory backend.

This package **is** an OMP extension. `package.json` registers `omp.extensions: ["./src/index.ts"]`. `enabled` defaults to **false**. The legacy mctx Durable Memory surface is retired: the Window runtime does not register `ctx_memory` or `/ctx-embed`, and fresh `context.db` files contain no legacy memory, embedding, authority, or mirror tables. Existing legacy tables and rows are retained without migration or deletion. `ctx_search` and `ctx_note` default on but have independent `searchEnabled` / `noteEnabled` settings; turning either off removes its agent tool after reload. `noteEnabled: false` also suppresses session-note nudges. `ctx_expand` and `ctx_reduce` remain Window controls.

The previous README text (“no `pi.extensions`, unloadable until the first HEPI slice”) described the frozen copy of `@hheei/pi-mctx` and is **stale**.

## Host

- Settings: OMP plugin settings only (`getPluginSettings`). No CortexKit `magic-context.jsonc` dual-read (ADR-0005).
- Store: `${OMP_CODING_AGENT_DIR:-~/.omp/agent}/extensions/omp-mctx/`.
- `/handoff` is not registered. `src/handoff` is excluded from the build.
- Factory: `loadOmpMctxPluginSettings` → `shouldStartOmpMctx` (`enabled === true`) → latch + boot quiet period.

### Memory schema modes

- **Window-only (default):** fresh `context.db` has Window/session tables, `message_history_fts`, and `lkg_slots`; it has no legacy memory/primer/git-commit FTS, embedding vectors, authority, or mirror tables.
- **Legacy Memory data:** old tables and rows remain untouched for inspection or later migration. New databases do not create the legacy schema.
- Both modes use only `${OMP_CODING_AGENT_DIR:-~/.omp/agent}/extensions/omp-mctx/context.db`; they never open CortexKit or frozen HEPI storage.

### Tool switches

All switches apply at reload/restart because Pi registers tools once per process:

| Setting | Default | Effect when false |
| --- | --- | --- |
| `searchEnabled` | `true` | Removes `ctx_search` and its system-prompt guidance; historian/compaction remains active. |
| `noteEnabled` | `true` | Removes `ctx_note`, its system-prompt guidance, and transform-time note nudges; existing note rows are retained. |

### Agentmemory bridge

The bridge is disabled by default. Enable `agentmemory.enabled` to connect to
an ordinary agentmemory Docker service over its public REST API. Capture,
prompt-specific Inject, historian retrieval, and the native `memory_search` /
`memory_save` Tool Surface each have independent kill switches and default to
on once the top-level bridge is enabled. When disabled, mctx performs no
agentmemory network work. No separate `omp-agentmemory` extension should be
installed or enabled.

## Lineage

Three-way merge, not a v0.40.1 fork (ADR-0002):

1. HEPI `packages/pi-mctx` (fail-closed SQLite + in-process latch)
2. Host overlay from cortexkit `packages/pi-plugin@0.40.1`
3. Mapped `src/core` cherry-picks from pin `7dcd2e5726a1466126b2eea460482cca2b53283b` through `v0.40.1` (`a239835e`)

Do **not** copy official `packages/pi-plugin/src` over `src/core`.

## Remaining gaps

**Intentional HEPI rewrite (do not graft CortexKit machinery):**

- Nudge cadence: `lastLevel` + `channel1TurnsSinceNudge`. Not CortexKit `realUserTurnCount` / `lastOrdinal` / `shouldUseStickyChannel1Reminder` / `tail-hygiene-walk` (`bc7862f`, `656ab0f`, `c0b060b`).
- `5f031cd` copy is HEPI-adapted (“Housekeeping, not a crisis”) with `usableTokens`; not byte-for-byte `usableWindow` ratio + sticky ordinal.
- `ee3c812` `agentDropsAppliedThisPass` is the CortexKit queued-drop hygiene bit; HEPI has no walker, so the field is absent.

**Host / missing-file skip:**

- `1b7648a`: Rust transform + audit scripts only (not a TS nudge rewrite).
- `efa6ee2`: Rust-only; TS already keeps real tool-argument keys.
- No `command-handler.ts` (`975e450` sinkless TUI), `storage-session-tables.ts` (`978ea89` / `746963e`), `project-security.ts` (`d45749c`).

**Mapped recovery now in this package:**

- LKG capture/replay is on the Pi `context` handler via `lkg-pi.ts` (`piMessagesToLkg` / `lkgMessagesToPi`). Do not cast `AgentMessage` to `MessageLike`. Slots persist in `lkg_slots`.
- `RawFallbackContextLimitError` is a loud abort: rethrown, and thrown when a failed transform would otherwise fall through with an original prompt estimated above the resolved context limit.

**Inapplicable (not a remaining port):**

- `714bc4c` migration-blocker process evidence. OMP does not keep a multi-process schema-migration lane; `FailClosedReason` is only `storage_failure`.

## Verify

```sh
bun run check && bun run test
```

Do not run bare `bun test` in this package: it picks up the copied HEPI `test/` vitest suite.
