# @hheei/omp-optimizer

`@hheei/omp-optimizer` is an Oh My Pi extension that combines five tools behind one
`/optimizer` command:

## Fork provenance

This extension is forked from [`pix-optimizer`](https://github.com/xynogen/pix-mono/tree/main/packages/pix-optimizer) in [`xynogen/pix-mono`](https://github.com/xynogen/pix-mono). It has been adapted for Oh My Pi's public Extension API and does not retain the original pix host integration. The T2S tool is ported from [`@hheei/pi-t2s`](https://github.com/hheei/hepi-mono/tree/main/packages/pi-t2s).

- **Caveman** — injects a terse-output system prompt (`off`, `lite`, `full`,
  `ultra`, `micro`).
- **RTK** — injects the RTK prompt and rewrites supported `bash` command chains
  to use `rtk` when the binary is available. Direct `sudo` segments are blocked
  so the model can use OMP's `sudo_run` flow when available.
- **Ponytail** — injects a minimal-code/YAGNI system prompt (`off`, `lite`,
  `full`, `ultra`).
- **T2S** — converts interactive Traditional Chinese prose to Simplified Chinese while preserving inline and fenced code (`on`, `off`).
- **Edit Guard** — when enabled, aborts malformed `apply_patch`/unified-diff `@@` syntax in hashline edits and shell `apply_patch` calls when that tool is unavailable (`on`, `off`).

## Install and load

From this checkout, load the extension file directly:

```text
packages/hepi/omp-optimizer/src/index.ts
```

For a published package, the manifest uses OMP's `omp.extensions` field:

```json
{
  "omp": {
    "extensions": ["./src/index.ts"]
  }
}
```

After publishing, install it through OMP:

```bash
./scripts/omp install @hheei/omp-optimizer
```

## Usage

Run `/optimizer` and use OMP's configured selection keys (normally `↑↓`) to
move between tools. `Enter` and `Space` cycle the selected value; `Esc` closes
the panel. The optional `q` shortcut also closes it. T2S and Edit Guard are
configured from the same panel. Edit Guard is enabled by default: it blocks
unified-diff syntax in hashline payloads and shell `apply_patch` calls when
`apply_patch` is not an active tool. In print/RPC mode, the command emits a
plain status summary instead of opening the interactive panel.

State is persisted by the extension under the active OMP agent directory as
`optimizer.json`. Session custom entries are also recorded through
`pi.appendEntry`, so branch/session navigation can restore the in-session value.

## OMP integration

The implementation uses OMP's public extension APIs and built-in packages:

- `ExtensionAPI` lifecycle hooks and `appendEntry` for prompt injection and
  session state.
- `ctx.ui.custom`, `ctx.ui.setStatus`, `ctx.ui.notify`, and the OMP theme for
  the panel and status bar.
- `ExtensionAPI.exec` for the RTK availability probe.
- `@oh-my-pi/pi-utils` for the active agent directory and centralized logging.

No `pix-pretty` or Pi fork compatibility package is required.

The status bar and `/optimizer` panel use Nerd Font glyphs. Use a terminal font
with Nerd Font support for the intended icons.

## Development

Run the focused tests from the repository root:

```bash
bun test packages/hepi/omp-optimizer/src
```

## License

MIT. See `LICENSE`.
