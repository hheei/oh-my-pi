# Project Context

This file is the shared glossary for design and architecture discussions. Keep
it free of implementation details.

## Fork

- **Fork**: `hheei/oh-my-pi`, the downstream repository for local development.
- **Upstream**: `can1357/oh-my-pi`, the source repository whose `main` is synced
  into the fork.
- **Local main**: the fork's synchronization branch, tracking `origin/main`.
- **Upstream robot**: the automated upstream workflow that handles bug issues;
  bug reports should describe reproduction and observed behavior clearly.

## npm distribution

- **Fork CLI package**: `@hheei/oh-my-pi`, exposing the global `omp` command.
- **Version alignment**: first fork release matches aligned upstream SemVer; fork-only releases increment patch (`18.0.6` → `18.0.7`). The current aligned upstream version is recorded in `packages/coding-agent/package.json` as `fork.upstreamVersion`.

## Extension

**hepi extension**:
Fork-owned functionality that lives under `packages/hepi/omp-<name>/` and is independently testable and publishable as `@hheei/omp-<name>`.
_Avoid_: unscoped `omp-<name>` as the npm name; Pi `pi-*` packages; `@hheei/pi-ext-core` as an OMP dependency

**Integration hook**:
The smallest upstream source change that delegates to a fork-owned extension while preserving upstream behavior when the extension does not apply.
_Avoid_: calling agentmemory lifecycle listeners or shell `hooks/pre|post` this

## Window and Durable Memory

**Window**:
The in-session compressed conversation surface: compartments, tags, `ctx_reduce` / `ctx_expand` / `ctx_note`, and session-or-commit search. Owned by omp-mctx.
_Avoid_: context, memory, Magic Context as a synonym for Durable Memory

**Durable Memory**:
Cross-session facts stored in Judy. Owned by omp-agentmemory. Not the Window, not `ctx_memory`.
_Avoid_: project-memory, ctx_memory, Hindsight recall

**omp-mctx**:
The hepi extension that owns the Window. It does not own Durable Memory and does not ship Handoff.
_Avoid_: pi-mctx, @cortexkit/pi-magic-context (those are sources/predecessors, not this package)

**omp-agentmemory**:
The hepi extension that owns Durable Memory through Judy. Tool Surface and Capture/Inject are its two layers.
_Avoid_: MCP agentmemory, @agentmemory/mcp

**Judy**:
The shared agentmemory HTTP service other hosts may still reach via MCP. OMP talks to it with REST.
_Avoid_: local @agentmemory/mcp, in-process agentmemory

**Tool Surface**:
The model-visible Judy tools. First surface is `memory_search` and `memory_save` (no `memory_health` in the tool table). Later surface adds `memory_recall`, `memory_sessions`, `memory_lesson_save`, `memory_consolidate`, `memory_reflect`, `memory_diagnose`. Search keeps the Pi name.
_Avoid_: `memory_smart_search`; `memory_health` as a model tool; enabling `memory_save` live while MCP still exposes it

**Health Command**:
`memory_health` is an OMP slash command, not a model tool. It probes Judy.
_Avoid_: registering `memory_health` on the Tool Surface

**Capture**:
Posting session observations to Judy from extension lifecycle events (`session_start`, `tool_result`, `agent_end`, `session_shutdown`).
_Avoid_: hook, Integration hook, shell pre/post hooks

**Inject**:
Putting Judy recall into the model-bound request (`before_agent_start` system prompt). Only one Durable Memory Inject is allowed. Window transforms may still rewrite messages.
_Avoid_: Integration hook, `<project-memory>`
