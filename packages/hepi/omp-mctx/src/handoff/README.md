# Handoff

`/handoff` is owned by `pi-mctx`. It is a compaction-like command, not an
interactive conversation.

## Contract

- Source Session must be persisted, primary, compaction-enabled, and idle.
- Historian wrapup keeps five transformed logical messages, then freezes a
  Source Context Snapshot.
- Handoff Completion uses the current main model, current thinking level, and
  `tools: []`. There is no fallback, repair, goal, or automatic next turn.
- Destination is a same-project, same-model Continuation Session with parent
  lineage. It does not inherit session-scoped extension state.
- Source JSONL is the payload authority (`magic-context:handoff-request`).
  Replacement writes `magic-context:handoff-attempt`. Success is only a
  destination `magic-context:handoff` custom message.
- SQLite stores only the short-lived handoff lease.

See `docs/handoff/README.md` and `docs/adr/0016-pi-mctx-clean-session-handoff.md`.
