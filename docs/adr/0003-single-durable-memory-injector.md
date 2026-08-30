# Only omp-agentmemory injects Durable Memory

Automatic Durable Memory injection has one owner: omp-agentmemory, via `before_agent_start` (Pi-aligned). omp-mctx must not inject `<project-memory>` once it is live. OMP will chain every extension's `context` transform, so two owners of the same durable block would duplicate prefix. Window compartments and Judy recall may both appear in a request; they are different blocks. Agentmemory Inject must not go live before omp-mctx has dropped memory injection (ADR-0001). Capture may exist without Inject.
