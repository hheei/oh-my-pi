# omp-mctx is the sole OMP agentmemory bridge after cutover

## Decision

After the cutover, `omp-mctx` is the only OMP extension that handles
agentmemory Capture, Inject, Tool Surface, lifecycle binding, and delivery.
The existing `omp-agentmemory` bridge package is removed as part of this
cutover, rather than being enabled in parallel or retained as a second runtime
path. The agentmemory Docker service remains the canonical Durable Memory owner
and is not modified.

## Why

The integration must connect to an unmodified agentmemory deployment while
avoiding duplicate Capture, Inject, and session lifecycle events. Keeping the
bridge at the Window owner gives Historian, unified search, and provenance one
host-side integration boundary without moving backend logic into OMP.

This supersedes the runtime-owner wording in ADR-0003 and the final-owner
sequencing in ADR-0009. Package removal is part of the agreed cutover scope;
backend changes remain out of scope.

Automatic recall is a Context Projection event stored in `context.db`, not a
transient prefix on the provider request. `agentmemory.inject` is the public
switch for that new path. Previously removed `ephemeralMessage` must not return.
