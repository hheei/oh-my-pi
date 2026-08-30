# Live OMP enables omp-mctx only after memory is off

omp-mctx may keep Durable Memory code while it is being aligned with cortexkit, but `~/.omp` must not enable it until `ctx_memory` is unregistered and `<project-memory>` / auto-promote are off. Until that commit, live Window stays on `@cortexkit/pi-magic-context` with `memory.enabled: false`. Enabling a memory-on omp-mctx earlier would undo the jsonc cutover and run two Durable Memory injectors.
