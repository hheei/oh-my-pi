# Features

`omp-mctx` owns the OMP Window and Context Projection and is the sole OMP
bridge to AgentMemory. AgentMemory remains the owner of durable, cross-session
memory; mctx owns the Window, projection, admission, replay, and presentation.

The bridge and projection are independent capabilities. The Window remains
fully local when the bridge is disabled or unavailable, and the host does not
need an AgentMemory-specific ephemeral-message API.

## Window and session continuity

When enabled, mctx manages the active context window locally. It tags eligible
conversation and tool output, protects a recent tail, applies queued or
automatic drops at provider-call boundaries, and keeps a last-known-good
transformed context for recovery. The Window remains usable without
AgentMemory or network access.

The session-history layer is produced by Historian as tiered compartments,
facts, and optional event or observation records. It is searchable with
`ctx_search` and expandable with `ctx_expand`; `ctx_note` stores session-scoped
notes and future nudges. The Window's active context is transformed locally;
legacy project-memory and automatic-search injection paths are not part of the
current OMP runtime.

The extension also provides the following maintenance and operator commands:

| Command | Purpose |
| --- | --- |
| `/ctx-status` | Inspect kernel context usage, Window attribution, memory/recall state, and background progress. |
| `/ctx-flush` | Force pending Window operations and related cache refreshes on the next provider call. |
| `/ctx-recomp [start-end]` | Rebuild all or a selected range of session-history compartments. |
| `/ctx-wrapup [count]` | Finish the current session with a bounded transformed tail and prepare it for continuation. |
| `/ctx-session-upgrade` | Upgrade legacy session-history compartments to the current format. |
| `/ctx-aug <prompt>` | Ask the configured sidekick for project context and add its augmentation to the next user turn. |

Historian, recomp, wrapup, and upgrade require a configured Historian model;
their work is isolated from the primary turn and reports progress through the
status surface. `/handoff` is not part of the omp-mctx command surface.

## Background and retrieval helpers

Historian runs on pressure and configured work-boundary triggers. Its output
uses progressive tiers so older history becomes smaller without losing the
current session's recovery anchors. A configurable two-pass mode can validate
and repair Historian output.


`/ctx-wrapup` is a primary-session command, keeps 20 transformed logical
messages by default (or the supplied count), and waits for its Historian work
to finish while reporting progress. It requires mctx-owned compaction and an
active Historian model.

The optional sidekick (`/ctx-aug`) is a separate short-lived model call. It
does not replace the primary model and falls back to the original prompt if
augmentation fails. Automatic recall from AgentMemory is a separate path and
is described below.

## AgentMemory bridge

The bridge is an opt-in integration with the upstream AgentMemory REST service.

### Bridge

- Independent opt-in (`agentmemory.enabled`, default false). Enabling the
  Window does not open a network path.
- One public REST client: health, session start/end, observe, search, lessons,
  hydration, remember, session list. No agentmemory SQLite, no extra endpoints.
- One resolved project identity per request (setting → env → git root → cwd).
  Optional `agentId` / `AGENT_ID` is a filter, not a security boundary.
- HTTPS required when a bearer secret targets non-loopback HTTP
  (`agentmemory.requireHttps`).
- When the bridge is off or the backend is down, the Window keeps working.

### Unified `memory_search`

- One model-visible search. Window (episodic, this session) and agentmemory
  (semantic, cross-session) run as separate lanes.
- Results are grouped (`Current session` / `Durable memory`). Scores are never
  numerically merged.
- Client-side Scope Gate drops unknown or mismatched project/agent hits after
  hydration.
- The active remote capture segment is excluded so the model is not shown what
  it just produced.
- Partial transport failure returns the healthy lane plus an explicit partial
  status, not a fake empty search.
- Tool details persist source identities (id, kind, project, session, agent,
  content digest), not just counts.

### `memory_save`

- Enqueues a durable candidate through a local transactional outbox.
- The UI reports queued vs delivered; it does not claim remote persistence
  before the outbox succeeds.

### Capture

- One remote capture segment per OMP session per process activation. Resume and
  session switch reuse the binding; they do not call non-idempotent start again.
- Observations are posted asynchronously from session/tool/assistant/shutdown
  events. Memory tool payloads and credential-shaped values are redacted or
  excluded.
- Capture failure is dropped and logged. It never fails the OMP session.
- Process shutdown ends every unended segment.

### Historian provenance and delivery

- Recall, memory-tool output, and their restatements are not independent
  evidence for Historian facts.
- Durable saves report queued versus delivered state; capture and delivery are
  asynchronous and failures do not fail the OMP session.
- Delivery is retryable and deduplicated; legacy local-memory tables remain
  readable but are not used by the current runtime.
### Cutover and legacy

- `omp-mctx` is the only live OMP agentmemory integration. The standalone
  `omp-agentmemory` package is not enabled alongside it.
- Legacy mctx Durable Memory (`ctx_memory`, embeddings, mirrors) is retired from
  the runtime. Fresh `context.db` files do not create those tables. Existing
  legacy rows are kept, not deleted.

## Cache-stable Context Projection

Recall is represented by committed Recall Events in the Context Projection.
The provider-visible projection keeps a stable baseline and append-only tail,
which preserves cache reuse across retries and Responses append chains.

### Automatic recall as a Recall Event

- On a substantive user turn, mctx retrieves prompt-specific Durable Memory,
  binds the work to session, branch, user-entry id, epoch, and scope, then
  admits **one** Recall Event per user entry.
- The event is placed **after** the triggering user message and **before** the
  assistant reply. It is not a system-prompt rewrite, not a fake tool call, and
  not a session-JSONL body.
- Identity is the host user-entry id, never prompt text or array ordinal. The
  same wording in a later user message is a new event. Retry of the same
  anchored turn reuses the snapshot and does not search again.
- Stale work (generation, session, branch, anchor, epoch, or scope changed
  mid-flight) is discarded. Backend failure admits nothing and does not block
  the Window. An already admitted event stays replayable when the backend later
  changes or disappears.
- `agentmemory.inject` (default true once the bridge is on) is the public
  switch for this path. `false` leaves tool-first `memory_search` / `memory_save`.

### Context Projection epochs

- The provider-visible Window is an auditable projection: frozen baseline plus
  append-only tail.
- Repeated transforms with unchanged input produce byte-equivalent output.
- Later appends preserve the already presented prefix.
- Compaction, reduce/recomp, contract (model / system / tools) change, branch
  replacement, or rewriting earlier bytes starts a **new epoch** with a recorded
  reason.
- Publish is atomic. Ordinary failure reuses last-known-good. Privacy
  withdrawal cannot fall back to a withdrawn snapshot.
- Background m[1] / compartment preparation does not publish; only the
  provider-facing transform success path does.

### TUI and retention

- Newly admitted recall is shown in interactive sessions, but not duplicated
  in headless or RPC output.
- Repeated transforms preserve the already presented prefix and stale
  background work is discarded rather than appended to a changed session.
- Recall that is no longer reachable from the current projection or a recovery
  reference may be garbage-collected; withdrawn data is not used for recovery.

## Unified status

`/ctx-status` collects one mctx Status Snapshot, then renders the same semantic
sections in the TUI and headless Markdown. Kernel context usage is always the
authoritative total, capacity, and percentage. Model-aware attribution labels
any positive remainder `Unattributed/Framing`; a transient attribution overrun
is explicitly `refresh pending` rather than an impossible bar.

Summary is compact; the TUI moves through Context, Memory, Background Work,
and Diagnostics with Tab, `j`, or arrow keys, so narrow terminals retain every
section. Escape, Ctrl+C, and Return close the overlay. The Memory detail
distinguishes mctx **Local memories** from AgentMemory **Recalls** and includes
bounded sanitized previews of active committed Recall Events. Previews are not
put in the summary or logs.

Status refresh reads local state only: it makes no network request or repeated
database write. AgentMemory health is the last observed disabled, unknown,
healthy, or degraded state; pending and failed outbox work are reported
separately. `/agentmemory-health` is the explicit fresh probe. The same status
surface reports Historian/recomp activity and existing maintenance actions.

## Configuration

Public plugin settings and runtime-recognized advanced keys are documented in
the package [README](../README.md). The README distinguishes settings exposed
by the published manifest from internal compatibility keys.
