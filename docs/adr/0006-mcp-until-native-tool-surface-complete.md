# Historical MCP agentmemory transition

This ADR records the pre-cutover constraint that MCP and an OMP-native
agentmemory Tool Surface could not expose the same tools simultaneously. The
mctx cutover supersedes that arrangement: `omp-mctx` is now the only OMP-side
bridge and the standalone bridge package is removed. Any remaining MCP
configuration is outside this extension and must not be used to register a
duplicate OMP tool surface.
