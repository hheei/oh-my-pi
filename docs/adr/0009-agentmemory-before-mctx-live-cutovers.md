# Build omp-agentmemory first; live cutovers stay serial

Repository work starts with omp-agentmemory (Pi extension copy, OMP host, `memory_search`/`memory_save`, `/memory-health`, then Capture, then the rest of the Tool Surface). omp-mctx's three-way merge may proceed in parallel but must not be live-enabled. Live MCP stays until the native Tool Surface is complete. Live Window stays on `@cortexkit/pi-magic-context` until omp-mctx has unregistered Durable Memory. Inject waits until that Window cutover so only one Durable Memory injector is live.
