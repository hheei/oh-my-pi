# Only one OMP extension injects Durable Memory

**Status: superseded by ADR-0010.**

Automatic Durable Memory injection has one owner, via `before_agent_start` (Pi-aligned). The original owner was `omp-agentmemory`; after the mctx cutover, ADR-0010 assigns that owner to `omp-mctx`. OMP chains every extension's `context` transform, so two owners of the same durable block would duplicate prefix. Window compartments and agentmemory recall may both appear in a request; they are different blocks. Capture may exist without Inject.
