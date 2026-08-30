# omp-mctx reads plugin settings, not CortexKit jsonc

A loadable omp-mctx uses `getPluginSettings("@hheei/omp-mctx")` only. `~/.config/cortexkit/magic-context.jsonc` is the live official plugin's file until ADR-0001 cutover, then it is not a runtime source. Cutover copies knobs by hand. Dual-read was rejected. The guidance override file may stay at `~/.config/cortexkit/guidance-primary.md` if that path is stored in plugin settings.
