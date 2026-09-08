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

| Setting | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `false` | Master switch for the Magic Context extension. Enables continuous session window management, turn compaction into `<session-history>`, tag tracking (`§N§`), and `ctx_reduce` / `ctx_expand` controls. |
| `historianEnabled` | `boolean` | `true` | Enable background LLM-driven session compaction (Historian). When active, older turns are automatically summarized into structured `<session-history>` compartments when the token threshold is reached. |
| `historianModel` | `string` | `""` | Provider/model ID used for background Historian compaction (e.g. `gm/gemini-3.8-flash` or `lmxu/gpt-5.6-sol`). Do not append `:thinking` here; configure `historianThinkingLevel` separately. Must be set for Historian to run. |
| `historianThinkingLevel` | `string` | `""` | Reasoning/thinking effort level for the Historian model (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Empty uses the model default. Recommended `low` for reasoning models. |

### Tool Surface Controls

| Setting | Type | Default | Description |
|---|---|---|---|
| `searchEnabled` | `boolean` | `true` | Exposes the standalone `ctx_search` tool for local SQLite session history search. **Note:** When `agentmemory.memoryTools` is active, unified `memory_search` automatically supersedes `ctx_search`. |
| `noteEnabled` | `boolean` | `true` | Exposes the local SQLite note tool `ctx_note`. **Recommendation:** Set to `false` when using AgentMemory (`agentmemory.enabled: true`), so the agent saves durable facts exclusively to AgentMemory via `memory_save`. |

### AgentMemory Durable Memory Bridge

| Setting | Type | Default | Description |
|---|---|---|---|
| `agentmemory.enabled` | `boolean` | `false` | Master switch to connect OMP to an external AgentMemory REST service for cross-session durable memory, project knowledge, and automated recall. |
| `agentmemory.url` | `string` | `http://127.0.0.1:3111` | Base URL of the AgentMemory REST service (e.g. `http://127.0.0.1:3111` or Tailscale node URL). Can be overridden via `AGENTMEMORY_URL`. |
| `agentmemory.secret` | `string` | `""` | Bearer token authentication secret for the AgentMemory service. Can be overridden via `AGENTMEMORY_SECRET`. |
| `agentmemory.project` | `string` | `""` | Explicit project namespace to scope memories. If blank, automatically resolves to the Git repository root or current working directory. |
| `agentmemory.agentId` | `string` | `""` | Optional caller identifier tag in AgentMemory observations. Can be overridden via `AGENT_ID`. |
| `agentmemory.capture` | `boolean` | `true` | Automatically capture session lifecycle events, tool outputs, and assistant observations to AgentMemory for background learning and indexing. |
| `agentmemory.inject` | `boolean` | `true` | Automatically recall relevant long-term memories and inject them as a cache-stable Context Projection block right after each user message. Disable if you only want tool-driven recall (`memory_search`). |
| `agentmemory.historianRetrieval` | `boolean` | `true` | Allow the background Historian compaction process to query AgentMemory to enrich compressed session summaries with project context. |
| `agentmemory.memoryTools` | `boolean` | `true` | Expose AgentMemory tools to the agent: `memory_search` (federated search across active session context and durable memories) and `memory_save` (explicit durable fact write). |
| `agentmemory.requireHttps` | `boolean` | `false` | Security policy: fail closed with an error if a bearer secret would be transmitted over plaintext HTTP to a non-loopback host. Set to `false` when connecting over trusted VPNs (e.g. Tailscale). |

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

Details: [docs/features.md](docs/features.md). How it is implemented:
[docs/implementation.md](docs/implementation.md). Host, lineage, and remaining
gaps: [docs/maintainers.md](docs/maintainers.md).

## Verify

```sh
bun run check && bun run test
```

Do not run bare `bun test` in this package: it picks up the copied HEPI `test/`
vitest suite.
