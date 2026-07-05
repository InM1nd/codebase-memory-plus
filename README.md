# Codebase Memory Plus

Personal MCP layer on top of `codebase-memory-mcp`.

The goal is to keep the original indexer and graph engine intact, while adding higher-level tools for visual summaries, route maps, symbol graphs, impact analysis, and a local dashboard.

## MVP

This first slice provides one MCP server with one tool:

- `project_summary_visual` - resolves a project, calls the underlying `codebase-memory-mcp`, and returns a readable project map with Mermaid output plus structured JSON.

It also includes a local dashboard:

- project picker from the local `codebase-memory-mcp` cache;
- project graph stats;
- package-level dependency graph;
- node and edge type summaries;
- symbol search.

## Install

```bash
npm install
npm run build
```

## Dashboard

```bash
npm run dashboard
```

Then open:

```txt
http://127.0.0.1:5178
```

The dashboard reads local graph databases from:

```txt
~/.cache/codebase-memory-mcp
```

Set a custom cache directory with:

```bash
CODEBASE_MEMORY_MCP_CACHE_DIR=/path/to/cache npm run dashboard
```

## Configure

Create `~/.codebase-memory-plus/config.json`:

```json
{
  "baseMcp": {
    "command": "/Users/you/.local/bin/codebase-memory-mcp",
    "args": []
  },
  "projects": [
    {
      "name": "marswalk",
      "root": "/Users/you/Documents/Project/marswalk"
    }
  ]
}
```

If the config file is missing, `codebase-memory-plus` falls back to running `codebase-memory-mcp` from `PATH`.

## Add To Codex

Add this to the global Codex MCP config:

```toml
[mcp_servers.codebase-memory-plus]
command = "/path/to/codebase-memory-plus/dist/index.js"
```

Or, after linking the package:

```toml
[mcp_servers.codebase-memory-plus]
command = "codebase-memory-plus"
```

## Tool Example

```json
{
  "projectRoot": "/Users/you/Documents/Project/marswalk",
  "includeIndexing": false
}
```

Set `includeIndexing` to `true` if the project is not indexed and you want the tool to run a fast index before summarizing.
