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

After publishing, install it globally through OMP's npm plugin manager:

```bash
omp install @hheei/omp-optimizer
```

## Quick start

Install the OMP package first, then install this plugin:

```bash
npm install -g @hheei/oh-my-pi
omp install @hheei/omp-optimizer
```

Restart `omp`, enter `/optimizer`, and use `↑`/`↓` to select a tool. Press
`Enter` or `Space` to cycle its value; press `Esc` or `q` to close the panel.
The status cell shows which tools are active.

### Tool guide

- **Caveman**: choose `off`, `lite`, `full`, `ultra`, or `micro` to control
  response terseness.
- **RTK**: when `rtk` is installed, supported bash chains are rewritten to use
  it. Direct `sudo` segments use OMP's permission flow instead.
- **Ponytail**: choose a level to inject minimal-code/YAGNI implementation
  guidance.
- **T2S**: converts interactive Traditional Chinese prose to Simplified
  Chinese; inline and fenced code are left unchanged.
- **Edit Guard**: enabled by default; stops malformed hashline `@@` patches and
  shell `apply_patch` calls when `apply_patch` is not an active tool.

In print or RPC mode, `/optimizer` prints a status summary instead of opening
the interactive panel. Settings persist in OMP plugin settings
(`omp-plugins.lock.json`). Session custom entries restore a tool only when the
lockfile has no value for it; otherwise the lockfile wins.

## OMP integration

The implementation uses OMP's public extension APIs and built-in packages:

- `ExtensionAPI` lifecycle hooks and `appendEntry` for prompt injection and
  session state.
- `ctx.ui.custom`, `ctx.ui.setStatus`, `ctx.ui.notify`, and the OMP theme for
- `ExtensionAPI.exec` for the RTK availability probe.
- `@oh-my-pi/pi-utils` `getPluginsLockfile` for persistence in the host plugin
  lockfile.

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
