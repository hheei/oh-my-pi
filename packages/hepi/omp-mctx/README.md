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
| Window only, no network | `enabled: true`, leave `agentmemory.enabled` false |
| Tool-first Durable Memory | `agentmemory.enabled: true`, `agentmemory.inject: false` |
| Automatic recall after each user turn | `agentmemory.enabled: true` (inject stays true) |

Do not install a separate `omp-agentmemory` extension.

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
