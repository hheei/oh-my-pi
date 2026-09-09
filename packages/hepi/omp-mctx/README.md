# @hheei/omp-mctx

OMP Window owner and the sole OMP bridge to an unmodified [agentmemory](https://github.com/agentmemory)
Docker service. This package is an OMP extension (`omp.extensions: ["./src/index.ts"]`).
`enabled` defaults to **false**.

The Window (compartments, tags, `ctx_reduce` / `ctx_expand` / `ctx_note`, historian)
works with no network. Durable Memory is opt-in: one plugin, one REST backend,
no second `omp-agentmemory` extension.

## Quick start

1. Run a stock agentmemory service (default `http://127.0.0.1:3111`).
2. Enable the plugin and the bridge in OMP plugin settings:

```jsonc
{
  "enabled": true,
  "agentmemory.enabled": true,
  "agentmemory.url": "http://127.0.0.1:3111"
  // optional: AGENTMEMORY_URL / AGENTMEMORY_SECRET / AGENT_ID override settings
}
```

3. Restart or reload so tools register. Startup logs report whether automatic
   recall is `ENABLED`, `DISABLED` (`inject=false`), or `UNAVAILABLE` (backend down).

With the bridge on, Capture, `memory_search` / `memory_save`, historian
retrieval, and automatic recall (`agentmemory.inject`, default true) each have
their own kill switch and default to on.

| You want | Set |
| --- | --- |
| Window only, no network | `enabled: true`, leave `agentmemory.enabled: false` |
| Tool-first Durable Memory | `agentmemory.enabled: true`, `agentmemory.inject: false` |
| Automatic recall after each user turn | `agentmemory.enabled: true` (inject stays `true`) |
| AgentMemory only (no local notes) | `agentmemory.enabled: true`, `noteEnabled: false` |

Do not install a separate `omp-agentmemory` extension.

## Configuration Reference

Inspect and modify settings via the OMP plugin CLI:

```sh
# View current settings
omp plugin config list @hheei/omp-mctx

# Set a setting
omp plugin config set @hheei/omp-mctx <key> <value>
```

### Core Window & Session Compaction

The following keys are exposed by the published plugin manifest and are
supported through the plugin settings CLI:

| Setting | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `false` | Master switch for Magic Context session window management, continuous turn compaction, and context reduction. |
| `historianEnabled` | `boolean` | `true` | Enables background session compaction (Historian) to summarize older turns into `<session-history>`. |
| `historianModel` | `string` | `""` | Model identifier for background Historian compaction. Empty keeps Historian inactive. |
| `historianThinkingLevel` | `string` | `""` | Historian reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Empty uses the model default. |

### Runtime-recognized advanced keys

The runtime also parses the keys below, but they are not declared in the
published `omp.settings` manifest and are therefore not part of the supported
plugin CLI surface. Treat them as internal/compatibility configuration until
they are explicitly exposed by the manifest:

| Key | Current behavior |
|---|---|
| `historianTwoPass` | Enables a validation/repair pass when the runtime receives it. |
| `historianTimeoutMs` | Sets the per-call Historian timeout. |
| `historyBudgetPercentage` | Sets the fraction reserved for `<session-history>`. |
| `commitClusterTriggerEnabled`, `commitClusterMinClusters` | Controls the commit-cluster Historian trigger. |
| `compactionEnabled` | Disables mctx-owned compaction and makes `ctx_reduce`, `/ctx-flush`, and `/ctx-wrapup` unavailable. |
| `temporalAwareness`, `systemPromptInjection`, `sidekickModel` | Controls elapsed-time markers, prompt guidance, and `/ctx-aug` when supplied. |

Legacy `dreamerEnabled`, `dreamerModel`, and `dreamerInjectDocs` are parsed
for compatibility but do not start a Dreamer runtime. Legacy local-memory,
automatic-search, and project document/profile injection paths are not active;
AgentMemory is the supported durable-memory integration.

### Tool Surface Controls

| Setting | Type | Default | Description |
|---|---|---|---|
| `searchEnabled` | `boolean` | `true` | Registers the `ctx_search` tool for session-history retrieval. Superseded by `memory_search` when AgentMemory tools are active. |
| `noteEnabled` | `boolean` | `true` | Registers the `ctx_note` tool for session-scoped notes and nudges. |

### AgentMemory Durable Memory Bridge

| Setting | Type | Default | Description |
|---|---|---|---|
| `agentmemory.enabled` | `boolean` | `false` | Enables the bridge to an external AgentMemory service for cross-session durable memory and recall. |
| `agentmemory.url` | `string` | `http://127.0.0.1:3111` | AgentMemory service REST endpoint URL. `AGENTMEMORY_URL` environment variable overrides this. |
| `agentmemory.secret` | `string` | `""` | Bearer token secret for authenticating with the AgentMemory service. `AGENTMEMORY_SECRET` overrides this. |
| `agentmemory.agentId` | `string` | `""` | Agent identifier tag passed to AgentMemory. `AGENT_ID` environment variable overrides this. |
| `agentmemory.capture` | `boolean` | `true` | Captures session lifecycle events, tool outputs, and assistant observations to AgentMemory for background indexing. |
| `agentmemory.inject` | `boolean` | `true` | Admits automatic memory recall as a cache-stable Context Projection block following each user turn. |
| `agentmemory.historianRetrieval` | `boolean` | `true` | Allows the background Historian compaction process to query AgentMemory for project context. |
| `agentmemory.memoryTools` | `boolean` | `true` | Exposes AgentMemory tools to the agent: `memory_search` (federated search) and `memory_save` (durable memory write). |
| `agentmemory.requireHttps` | `boolean` | `false` | Enforces HTTPS when sending bearer authentication to non-loopback hosts. Default false permits private networks such as Tailscale. |

> **Project Identity:** The project namespace is never configured globally; it is derived automatically from the Git repository root (preserving the same identity across worktrees) or working directory. For ad-hoc overrides, use the `AGENTMEMORY_PROJECT_NAME` environment variable.

## What you get

- **Window:** current-session compression, compartments, notes, search.
- **`memory_search`:** one tool that federates this session's Window with
  agentmemory, grouped by source, never mixing score scales.
- **`memory_save`:** queued durable write through a local outbox.
- **Automatic recall:** prompt-specific AgentMemory hits admitted as a
  cache-stable Context Projection event *after* the triggering user message,
  replayed on retry/resume, shown in the TUI via `setWidget`.
- **Fail-closed Window:** AgentMemory outages do not take down tagging,
  reduce, expand, or LKG recovery.

## Command surface

The extension registers the following commands when their corresponding
capability is available:

| Command | Purpose |
| --- | --- |
| `/ctx-status` | View context usage, Window attribution, memory/recall state, and background progress. |
| `/ctx-flush` | Materialize pending Window drops and refresh derived context on the next provider call. |
| `/ctx-recomp [start-end]` | Rebuild all or a selected range of session-history compartments. |
| `/ctx-wrapup [count]` | Complete a bounded session wrapup for continuation. |
| `/ctx-session-upgrade` | Upgrade legacy session-history compartments to the current format. |
| `/ctx-aug <prompt>` | Add optional sidekick-generated project context to the next user turn. |
| `/agentmemory-health` | Run an explicit fresh health probe for the AgentMemory service. |

`/handoff` is not provided by this extension. Historian-dependent commands are
unavailable until `historianModel` is configured.

## Status

`/ctx-status` provides the shared interactive and headless status surface for
kernel usage, Window attribution, AgentMemory state, recall previews, and
background work. Refresh is read-only; use `/agentmemory-health` for an
explicit network health probe. See [features.md](docs/features.md) for the
status behavior and keyboard controls.

Details: [docs/features.md](docs/features.md). How it is implemented:
[docs/implementation.md](docs/implementation.md). Host integration and
maintenance notes: [docs/maintainers.md](docs/maintainers.md).

## Verify

```sh
bun run check && bun run test
```

Do not run bare `bun test` in this package: it picks up the copied HEPI `test/`
vitest suite.
