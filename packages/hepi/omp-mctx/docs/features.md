# Features

Two specs landed in this plugin. The first made `omp-mctx` the sole OMP
agentmemory bridge. The second replaced hidden ephemeral Inject with a
cache-stable Context Projection.

Agentmemory remains the Durable Memory owner (REST on `:3111`). mctx remains
the Window and Context Projection owner. coding-agent has no AgentMemory-specific
ephemeral-message API.

## Spec 1 — sole OMP agentmemory bridge

Status: implemented and closure-verified.

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

### Historian provenance

- Automatic recall, `memory_search` / `memory_save` output, and restatements of
  those sources are not independent evidence for `/remember`.
- Accepted evidence carries stable host-entry identities so folds and branches
  cannot silently relink a candidate.
- Taint is per recall host entry when possible; whole-turn taint remains the
  fail-closed fallback.

### Outbox

- Window publication and outbox insert commit atomically so a crash cannot
  advance coverage while losing a candidate.
- One worker lease per row, with expiry and retry, so a sibling OMP process can
  finish delivery.
- At-least-once delivery; agentmemory's own dedup and versioning stay
  authoritative.

### Cutover and legacy

- `omp-mctx` is the only live OMP agentmemory integration. The standalone
  `omp-agentmemory` package is not enabled alongside it.
- Legacy mctx Durable Memory (`ctx_memory`, embeddings, mirrors) is retired from
  the runtime. Fresh `context.db` files do not create those tables. Existing
  legacy rows are kept, not deleted.

## Spec 2 — cache-stable Context Projection

Status: implemented (tickets 01–07). The old hidden prefix Inject is gone and
must not return.

The previous Inject put recall in front of the user message as a turn-local
ephemeral prefix, then deleted it. Later requests no longer shared an exact
prefix after `user-1`, which breaks KV-cache reuse and OpenAI Responses append
chains. A cache key cannot make different prefixes identical.

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

### TUI

- Newly admitted recall is shown in the interactive TUI through
  `ExtensionUIContext.setWidget` (above the editor).
- `notify` is a toast without scrollback; `custom()` takes keyboard focus.
  Neither is used for recall display.
- Presentation receipts prevent reprint on retry. Headless / RPC sessions do
  not present.

### Retention

- Unreachable Recall Events can be garbage-collected once they are not on the
  current head, not reachable from it, and not held by a recovery reference.
- Withdrawn snapshots are not last-known-good.

## Settings

All switches take effect at reload/restart (Pi registers tools once per process).

| Setting | Default | Role & Interaction Notes |
| --- | --- | --- |
| `enabled` | `false` | Master switch for Magic Context session window management, continuous turn compaction, and context reduction. |
| `historianEnabled` | `true` | Enables background session compaction (Historian) to summarize older turns into `<session-history>`. |
| `historianModel` | `""` | Model identifier for background Historian compaction, for example `gm/gemini-3.8-flash` or `lmxu/gpt-5.6-sol`. Empty keeps Historian inactive. |
| `historianThinkingLevel` | `""` | Reasoning effort level for the Historian compaction model: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Empty uses the model default. |
| `searchEnabled` | `true` | Registers the `ctx_search` tool for session-history retrieval. Superseded by `memory_search` when AgentMemory tools are active. |
| `noteEnabled` | `true` | Registers the `ctx_note` tool for session-scoped notes and nudges. |
| `agentmemory.enabled` | `false` | Enables the bridge to an external AgentMemory service for cross-session durable memory and recall. |
| `agentmemory.url` | `http://127.0.0.1:3111` | AgentMemory service REST endpoint URL. `AGENTMEMORY_URL` environment variable overrides this. |
| `agentmemory.secret` | `""` | Bearer token secret for authenticating with the AgentMemory service. `AGENTMEMORY_SECRET` overrides this. |
| `agentmemory.agentId` | `""` | Agent identifier tag passed to AgentMemory. `AGENT_ID` environment variable overrides this. |
| `agentmemory.capture` | `true` | Captures session lifecycle events, tool outputs, and assistant observations to AgentMemory for background indexing. |
| `agentmemory.inject` | `true` | Admits automatic memory recall as a cache-stable Context Projection block following each user turn. |
| `agentmemory.historianRetrieval` | `true` | Allows the background Historian compaction process to query AgentMemory for project context. |
| `agentmemory.memoryTools` | `true` | Exposes AgentMemory tools to the agent: `memory_search` (federated search) and `memory_save` (durable memory write). |
| `agentmemory.requireHttps` | `false` | Enforces HTTPS when sending bearer authentication to non-loopback hosts. Default false permits private networks such as Tailscale. |

Project identity is not configured as a global setting. It is resolved automatically per repository from the Git root (preserving identity across worktrees) or directory name, with optional override via `AGENTMEMORY_PROJECT_NAME`.
