# Smart-note compiled-check parity

The compiled-check runner and SSRF guard live beside the Pi smart-note feature. The Node parity test covers the executable runtime contract.

Security parity coverage:

- `ssrf-guard.test.ts` exercises the fail-closed bypass classes in-process under Vitest/Node.
- `ssrf-guard.parity.test.ts` bundles the same guard module for `target: "node"` and runs the same public-vs-mixed-private DNS classification under Node. Electron uses the same Node `dns`, `https`, and `net` APIs for this module, so the Node parity test is the executable proxy for Electron.
- The guard does not use Bun-only APIs; socket connection is via Node-compatible `https.request` with a pinned `lookup` result.
