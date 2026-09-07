# Build agentmemory integration before the mctx cutover; live cutovers stay serial

**Status: superseded by ADR-0010 for the final bridge owner.**

Repository work may use the existing `omp-agentmemory` bridge as a reference and migration source. Live cutovers remain serial: do not enable two bridges, and do not enable mctx's agentmemory bridge until its Window-only path and native Tool Surface are ready. The final runtime owner is defined by ADR-0010.
