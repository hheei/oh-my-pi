# omp-mctx keeps fail-closed SQLite and the in-process latch

After the host overlay, omp-mctx still fails closed if the Window store cannot open, and still uses the in-process latch for sub-agents. Matching official pi-plugin's looser host behavior was rejected; those two HEPI adapter rules are why the starting tree is pi-mctx rather than a 0.40.1 fork.
