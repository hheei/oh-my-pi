# Durable Memory search stays `memory_search`

The live search tool name is the Pi extension's `memory_search`, not MCP `memory_smart_search`. Both call the same Judy smart-search REST. Keeping the Pi name avoids teaching two search tools; dropping the MCP name is a one-time cutover when native Tool Surface replaces MCP. Aliasing both names was rejected.
