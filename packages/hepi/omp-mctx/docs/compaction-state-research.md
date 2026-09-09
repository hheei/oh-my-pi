# Model compaction and omp-mctx state continuity research

> Scope: implementation research only. No TypeScript source was changed. Sources are repository code (the first-party contracts used by this checkout), cited with path and line ranges.

## Executive conclusion

Re-enabling model compaction should be treated as a **history rewrite inside the same Pi session**, not as a new session. Pi appends a durable `compaction` entry, whose `firstKeptEntryId` defines the live boundary, then rebuilds the agent message array and resets provider/session-derived runtime state. (`packages/coding-agent/src/session/session-maintenance.ts:1476-1544`; `packages/agent/src/compaction/entries.ts:34-45`.)

The durable anchor for omp-mctx must remain the Pi `sessionId`, combined with real `SessionEntry.id` values and the latest compaction boundary. The safe post-compaction strategy is: invalidate cached m[0]/m[1] bytes and all boundary-dependent token/tag caches; signal a history refresh; let the next `context` transform rebuild from `getBranch()` after Pi's compaction marker; preserve durable compartments/tags/memories in `context.db`. If correspondence cannot be proved, fail closed to a fresh/rebuilt projection or a bounded reset—not by deleting the session's durable DB rows.

Current code already supports the key low-level invalidation and boundary-aware replay, but it only registers `session_before_compact`; it does not currently consume a `session_compact` post-commit event. (`packages/hepi/omp-mctx/src/index.ts:1505-1508`.) That post-event is the cleanest future hook for exact reconciliation after both automatic and manual compaction.

## 1. Current omp-mctx state model

### 1.1 Durable state (survives process restart)

`session_meta` stores m[0]/m[1] cache bytes plus the cache validity dimensions: project-memory epoch, workspace fingerprint, user-profile version, maximum compartment/memory/mutation IDs, project-docs hash, session-facts version, upgrade state, system hash, tool-set hash, model key, project identity, and materialization time. (`packages/hepi/omp-mctx/src/core/features/storage-meta-shared.ts:6-67`, `69-127`.) It also stores usage/pressure, reasoning watermark, stable-ID scheme, protected-tail recovery, and related per-session maintenance state.

Compartment/fact/tag/projection data is durable in the shared `context.db`; normal mode deliberately uses historian-driven compartments rather than Pi's monolithic compaction summary. (`packages/hepi/omp-mctx/src/read-session-pi.ts:56-69`.) The mctx implementation documentation describes the DB as the owner of window/projection state, while the coding agent owns generic extension lifecycle and provider conversion. (`packages/hepi/omp-mctx/docs/implementation.md:12-19`.)

### 1.2 Process-local state

The context handler owns many session-keyed maps/sets: history-refresh, system-prompt-refresh, pending/deferred materialization, project/session tracking, first-pass and commit tracking, live model, tagged stable IDs, taggers, token caches, identity caches, projection references, channel-1 state, and other cooldowns. (`packages/hepi/omp-mctx/src/context-handler.ts:328-386`; cleanup at `5368-5444`.)

`LiveSessionState` is explicitly plugin-process-scoped. It contains live model/variant/agent maps, refresh/materialization signal sets, cached session directories, recomp progress, and internal-child session sets. (`packages/hepi/omp-mctx/src/core/hooks/live-session-state.ts:7-18`, `18-56`.) Most of this state is intentionally ephemeral and must be rehydrated from the session/DB on a new process.

### 1.3 LKG and projection safety

Every context pass can capture a last-known-good transformed prefix; on a later transform failure, omp-mctx replays that prefix rather than sending the raw prompt, subject to an over-limit refusal. (`packages/hepi/omp-mctx/src/context-handler.ts:1-24`.) The projection implementation treats compaction as a reason for a new projection epoch, while preserving the previous LKG only when the transition is valid; privacy withdrawal explicitly removes the recoverable LKG. (`packages/hepi/omp-mctx/docs/implementation.md:113-131`.)

## 2. Compression event vs. new-session boundary

### 2.1 Automatic and manual compaction are the same durable boundary

The maintenance layer's manual `compact()` and automatic maintenance both ultimately call the shared `#commitCompactionEntry`. That method appends a `compaction` entry with summary, `firstKeptEntryId`, token metadata, preserve data, and method; rebuilds display context; replaces live agent messages; rebases; resets plan/advisor/todo runtime; resets or closes provider sessions; and emits the `session_compact` extension event. (`packages/coding-agent/src/session/session-maintenance.ts:737-772`, `1073-1096`; shared commit at `1476-1544`; automatic caller at `3780-3839`.)

The `CompactionEntry` contract says `firstKeptEntryId` is the first retained entry and `preserveData` is hook-provided data carried across compaction. (`packages/agent/src/compaction/entries.ts:34-45`.) Thus a compaction is a durable branch marker plus a replacement live context, not a new session identity.

### 2.2 Compaction changes the emitted message array

`buildSessionContext()` walks the selected branch and finds the latest compaction. The latest compaction summary is represented in the model context, and entries before `firstKeptEntryId` are excluded from the active context while remaining on disk for transcript purposes. (`packages/coding-agent/src/session/session-context.ts:111-118`, `152-185`, `226-246`; `packages/hepi/omp-mctx/src/context-handler.ts:1068-1147` mirrors the same boundary algorithm.)

The agent's append-only context manager recognizes a shorter normalized message array as compaction: it clears its prior log and replays the new messages. (`packages/agent/src/append-only-context.ts:213-230`.) Any mctx cache keyed only by positional index or by old message-array length is therefore unsafe after compaction.

### 2.3 New session is different

`SessionManager.newSession()` drains/ closes the writer, mints a new UUID, creates a new session header, and persists it before returning. (`packages/coding-agent/src/session/session-manager.ts:1108-1158`, `1484-1489`.) Forking likewise mints a new session ID and records `parentSession`. (`packages/coding-agent/src/session/session-manager.ts:1501-1542`.)

An in-place `/clear` is a third boundary: it keeps the session identity but appends a durable `reset_boundary`; live messages, queues, checkpoint/runtime state, provider session state, and advisor/memory context are reset. (`packages/coding-agent/src/session/agent-session.ts:4682-4734`; reset marker type at `packages/agent/src/compaction/entries.ts:120-128`.)

**Implication:** compaction must preserve session-scoped durable mctx history and re-anchor it to a changed active branch; `/new`/fork requires a new session key and explicit initialization/copy policy; `/clear` requires a reset-like context baseline but must not be confused with process/session deletion.

## 3. Existing anchors that can preserve state

1. **Pi `sessionId`** — stable for the session lifetime and used by omp-mctx to key all durable and process-local state. `resolveSessionId()` prefers the UUID from `sessionManager.getSessionId()`, explicitly avoiding path/index identity drift. (`packages/hepi/omp-mctx/src/context-handler.ts:953-983`.)
2. **Real `SessionEntry.id`** — mctx resolves each emitted Pi message to the underlying durable entry ID. The resolver deliberately handles synthetic compaction summary entries as `undefined`, while retaining real IDs for kept/post-compaction messages. (`packages/hepi/omp-mctx/src/context-handler.ts:985-1006`, `1039-1147`.)
3. **Latest `compaction.firstKeptEntryId`** — the durable cut-point for deciding which old entries are summarized away and which tail remains live. (`packages/agent/src/compaction/entries.ts:34-45`; `packages/hepi/omp-mctx/src/context-handler.ts:1068-1138`.)
4. **Branch traversal (`getBranch()`)** — the authoritative current path after compaction, branch navigation, or resume. mctx's Pi reader intentionally skips non-message entries and separately handles the compaction boundary. (`packages/hepi/omp-mctx/src/read-session-pi.ts:44-69`; `packages/hepi/omp-mctx/src/context-handler.ts:1052-1066`.)
5. **Durable cache validity dimensions** — if m0/m1 is retained, it must still match system/tool/model/project/doc and max-row dimensions; otherwise `clearCachedM0M1()` is the safe operation. (`packages/hepi/omp-mctx/src/core/features/storage-meta-shared.ts:536-584`, `586-630`.)
6. **Compaction `preserveData`** — suitable only for extension/provider payload that Pi explicitly carries through the marker. It is not a substitute for mctx's DB state or for message-ID reconciliation. (`packages/agent/src/compaction/entries.ts:40-45`; commit plumbing at `packages/coding-agent/src/session/session-maintenance.ts:1496-1508`.)

## 4. Safe reset boundary (worst case)

### Required reset

On a native Pi compaction that mctx did not author, the minimum safe reset is:

- clear durable cached m[0]/m[1] bytes and all cache validity metadata;
- clear or invalidate positional/token/identity/tag caches tied to the pre-compaction message array;
- mark history refresh/materialization for the next transform;
- rebuild entry-ID alignment from the post-compaction `getBranch()` and latest `firstKeptEntryId`;
- rebuild and publish a new projection baseline/epoch if the serialized wire body changed.

`clearCachedM0M1()` explicitly clears bytes, murals, max-row dimensions, hashes, model/project identity, memory block caches, and baseline-end metadata. (`packages/hepi/omp-mctx/src/core/features/storage-meta-shared.ts:586-629`.) The existing `handlePiSessionBeforeCompact()` already clears m0/m1 best-effort before native compaction. (`packages/hepi/omp-mctx/src/index.ts:218-242`.)

### What must not be reset

Do **not** call durable `clearSession(db, sessionId)` merely because compaction, `session_before_switch`, or `session_shutdown` occurred. The context handler's explicit warning says those events are reversible/non-deletion boundaries; deleting rows would destroy compartments, tags, and memories for a session that can be resumed. (`packages/hepi/omp-mctx/src/context-handler.ts:5394-5403`.) Its cleanup function clears only process-local state. (`packages/hepi/omp-mctx/src/context-handler.ts:5404-5444`.)

### Fail-closed fallback

If post-compaction alignment, cache validity, or DB access cannot be established, prefer an empty/rebuilt m0/m1 baseline plus LKG or a bounded refusal over replaying stale bytes. The plugin's fail-closed policy says storage failure must not silently fall through to native compaction when mctx is enabled. (`packages/hepi/omp-mctx/src/core/features/fail-closed-pi.ts:1-7`; `packages/hepi/omp-mctx/docs/implementation.md:168-176`.)

## 5. Automatic vs. manual paths

| Path | Current host behavior | mctx implication |
| --- | --- | --- |
| Manual `/compact` / `AgentSession.compact()` | Aborts active work, prepares a cut, emits `session_before_compact`, computes summary, commits shared compaction entry, rebuilds live messages, emits `session_compact`. (`packages/coding-agent/src/session/session-maintenance.ts:737-872`, `1476-1544`.) | A post-commit hook can synchronously/awaitably reconcile state before the next turn. PreserveData is available for extension payload. |
| Automatic threshold/overflow compaction | Uses the same commit tail, with action/reason metadata and possible retry/rescue continuation. (`packages/coding-agent/src/session/session-maintenance.ts:3780-3858`.) | Must handle detached post-commit event emission and continuation turns; signal refresh idempotently and avoid doing expensive synchronous work in the event handler. |
| Native Pi compaction while mctx compaction is off | `session_before_compact` clears only cache and returns no cancellation, allowing Pi's native path. (`packages/hepi/omp-mctx/src/index.ts:218-242`.) | After re-enabling mctx, native compaction may already have changed the branch; treat first resumed transform as a catch-up/reconciliation pass. |
| mctx normal mode | The same hook returns `{cancel:true}`, so mctx owns compaction and prevents native fallback. (`packages/hepi/omp-mctx/src/index.ts:236-242`, `1505-1508`.) | Do not add a competing native compaction path without changing ownership and tests. |
| `/new` / fork | New UUID/header (fork also parentSession). (`packages/coding-agent/src/session/session-manager.ts:1484-1542`.) | Clear old in-memory maps, initialize new row; copy only explicitly intended cross-session/project state. |
| `/clear` | Same session ID, reset boundary, live/provider/advisor/runtime reset. (`packages/coding-agent/src/session/agent-session.ts:4682-4734`.) | Treat as a reset boundary distinct from compaction; invalidate baseline and do not delete durable historical rows. |

## 6. Recommended change points (no source changes made)

1. **Add a `session_compact` handler in `startPiMagicContextRuntime()`**, adjacent to the current `session_before_compact` registration (`packages/hepi/omp-mctx/src/index.ts:1505-1508`). Read `ctx.sessionManager.getSessionId()` and the emitted `compactionEntry`; invalidate m0/m1 and signal the deferred/history refresh channels. This is the exact point after Pi has durably committed and rebuilt the active context.
2. **Keep `session_before_compact` as a pre-invalidation guard.** It protects against stale m0/m1 during the compaction window; the post-hook must be idempotent because a compaction can be followed by retries/continuations.
3. **Use real entry IDs, never array indexes.** Re-run the existing `collectMessageEntryIds`/`resolvePiStableId` alignment after the marker is committed. Synthetic summary index 0 must remain non-durable (`undefined`). (`packages/hepi/omp-mctx/src/context-handler.ts:985-1006`, `1068-1147`.)
4. **Signal, do not force expensive work in the event hook.** `historyRefreshSessions` and `pendingMaterializationSessions` are already designed as consumed-on-success channels. (`packages/hepi/omp-mctx/src/context-handler.ts:328-353`.) Let the next context pass rebuild after all host state is coherent.
5. **Record the compaction boundary in projection classification.** Compaction changes the serialized context and should create a projection epoch/transition with reason `compaction`, rather than append stale pre-compaction bytes. The existing projection docs/tests establish that contract. (`packages/hepi/omp-mctx/docs/implementation.md:113-131`; `packages/hepi/omp-mctx/test/core/features/context-projection.test.ts:119-174`.)
6. **Reuse `clearContextHandlerSession` only for actual outgoing-session cleanup.** Do not use it as the compaction handler: it erases useful process-local caches and project tracking, while compaction is still the same session. (`packages/hepi/omp-mctx/src/context-handler.ts:5368-5444`.)
7. **Use `CompactionEntry.preserveData` only for narrowly defined provider/extension continuity.** For example, provider-native encrypted replay payload is explicitly supported by the agent compaction layer; mctx projection/compartment state belongs in `context.db`, not in a summary entry. (`packages/agent/src/compaction/entries.ts:40-45`; `packages/coding-agent/src/session/session-context.ts:165-177`.)
8. **When turning mctx ownership back on after compaction-off**, retain the existing durable transition behavior: invalidate baseline first, then signal historian catch-up; do not trim dormant history before rebuilding the on-mode baseline. (`packages/hepi/omp-mctx/src/compaction-off-pi.ts:80-105`; `packages/hepi/omp-mctx/src/core/hooks/compaction-off-transition.ts:190-230`.)

## 7. Unknown risks

- **Event ordering and detached emissions:** automatic compaction can detach `session_compact` emission while scheduling continuation work; a handler must tolerate the next `context` pass racing with notification delivery. (`packages/coding-agent/src/session/session-maintenance.ts:1528-1542`, `3780-3839`.)
- **Synthetic summary alignment:** the summary at context index 0 has no real SessionEntry ID; treating it as a tag/compartment owner can create orphan state. (`packages/hepi/omp-mctx/src/context-handler.ts:1108-1115`.)
- **Split-turn and tool-result boundaries:** compaction cut selection avoids invalid tool-result cuts and may represent synthetic folded user IDs; mctx defers unsafe boundary selection in that case. (`packages/agent/src/compaction/compaction.ts:537-561`; `packages/hepi/omp-mctx/src/read-session-pi.ts:77-88`.)
- **Provider-side history:** the host closes/resets provider sessions after ordinary history rewrites and may preserve provider-native replay payload for remote compaction. Stale provider state can diverge even when local JSONL looks correct. (`packages/coding-agent/src/session/session-maintenance.ts:1519-1524`; `packages/agent/src/compaction/compaction.ts:683-692`.)
- **Native compaction while disabled:** mctx currently pre-clears cache but has no post-compaction hook, so a process restart or first resumed transform is the only guaranteed rehydration point. (`packages/hepi/omp-mctx/src/index.ts:218-242`, `1505-1508`.)
- **Durable DB/session identity mismatch on fork or move:** paths are not sufficient identity; use the session UUID and project identity resolution. (`packages/hepi/omp-mctx/src/context-handler.ts:953-983`; `633-662`.)

## 8. Verification plan for a future implementation

1. **Manual compaction:** start with tagged messages and materialized m0/m1; run `/compact`; assert one durable `compaction` entry, unchanged `sessionId`, correct `firstKeptEntryId`, cache invalidation, next-pass history rebuild, and no duplicate tags.
2. **Automatic compaction:** trigger threshold and emergency/overflow paths separately; assert post-commit signal delivery, continuation turn correctness, and no stale projection append.
3. **Native compaction then resume:** run with mctx compaction off, allow native compaction, re-enable mctx, switch away/back and restart; assert first transform rebuilds rather than replays stale m0/m1.
4. **Reset distinctions:** exercise `/clear`, `/new`, fork, `session_before_switch`, and `session_shutdown`; verify only `/new`/fork mint IDs and none of switch/shutdown deletes durable mctx rows.
5. **Failure injection:** make DB read/write, provider summary, and post-hook alignment fail independently; assert LKG/refusal behavior and no silent native fallback when mctx owns compaction.
6. **Boundary cases:** test compaction at a turn boundary, split tool turn, synthetic summary index 0, branch navigation, remote preserveData, and a compaction followed immediately by a continuation.

No full test suite, formatter, or linter was run for this research-only report.
 
## 9. Matt review correction: minimum viable mctx-only path

The initial recommendation needs one important correction: adding only a `session_compact` post-hook is insufficient. The current `session_before_compact` registration can return `{ cancel: true }` in normal mode, which prevents the host's native/manual and automatic compaction commit path from running. The first implementation must change that mctx-owned behavior; this is still an `omp-mctx`-only change and does not require editing `packages/coding-agent`.

Recommended short path:

1. Keep `session_before_compact`, but make it perform only idempotent pre-invalidation and return no cancellation in both compaction modes.
2. Add an idempotent `session_compact` handler that clears m0/m1 and boundary-dependent caches, signals history/materialization refresh, and records a projection transition reason of `compaction`.
3. Let the next `context` transform rebuild from the authoritative current branch. Do not run historian or projection rebuild synchronously inside the event hook.
4. Treat the post-hook as a convergence signal, not the sole correctness gate: automatic emission may be detached and the next transform may race ahead. Pre-invalidation must already prevent stale cache reuse.

### Gains

- Restores manual `/compact` and ordinary threshold/overflow compaction through the host's existing shared commit lifecycle without copying compaction logic.
- Keeps the same `sessionId`, so durable compartments, tags, memories, and AgentMemory state survive.
- Keeps the change surface inside `omp-mctx`; provider-session reset remains owned by the existing host lifecycle.
- Uses conservative pre-clear plus deferred rebuild, making duplicate notifications safe and rollback simple.

### Losses and limits

- Because `session_before_compact` remains registered, host speculative/armed automatic compaction stays disabled. This short path restores automatic compaction but gives up speculative latency hiding.
- Native Pi summaries can overlap with mctx `<session-history>`/compartment summaries, causing some token duplication; prompt equivalence with pure Pi or pure mctx is not guaranteed.
- Every compaction causes at least one m0/m1/projection cache miss and rebuild cost.
- Detached automatic post-events can arrive after the next context pass; correctness must come from pre-invalidation plus idempotent catch-up.
- Remote/provider-native `replacementHistory` alignment is not guaranteed by this plan. Until targeted tests prove the mapping, support should be stated as ordinary local/manual and non-speculative automatic compaction, with remote paths explicitly marked as unverified.

### Non-negotiable vetoes

- Do not add only the post-hook while leaving the existing cancel path intact.
- Do not assume `session_compact` arrives before the next context transform.
- Do not call `clearSession` or delete durable compartments/tags/memories.
- Do not claim remote/provider-native compaction support before testing real entry-ID alignment and synthetic summary handling.

The cited implementation paths should be re-read immediately before coding: some older report references have moved, and the production message-to-entry alignment is not necessarily the older helper name described in earlier notes.
