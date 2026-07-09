# Codebase Memory Plus

Personal MCP layer + local dashboard on top of `codebase-memory-mcp`.
The goal is to keep the original indexer and graph engine intact, while adding higher-level
tools for visual summaries, route maps, symbol graphs, impact analysis, and a local dashboard.

This repo gives you two independent things, both built on the same local graph cache:

- **An MCP server** (`codebase-memory-plus`) - one tool, `project_summary_visual`, for use from
  any MCP-compatible AI agent (Claude Code, Cursor, Codex, etc.).
- **A local web dashboard** - project picker, package/symbol dependency graphs, relation
  filters, architecture/perf/duplicate insights, and a toggle to embed
  `codebase-memory-mcp`'s own built-in graph UI alongside it.

## Prerequisites

- **Node.js >= 22**
- **`codebase-memory-mcp` already installed** and reachable as a command (on your `PATH`, or
  pointed to via config - see [Configure](#configure)). This project only adds tooling on top
  of it; it does not index code itself. At least one project needs to have been indexed by
  `codebase-memory-mcp` before there's anything for the dashboard or the
  `project_summary_visual` tool to show.

## Install

```bash
git clone https://github.com/InM1nd/codebase-memory-plus.git
cd codebase-memory-plus
npm install
```

`npm install` runs the `prepare` script, which builds both required gitignored artifacts:
`dist/` for the MCP server and `dashboard/app.js` for the web dashboard.

To rebuild manually after local changes:

```bash
npm run build
npm run build:dashboard
```

## Use the dashboard

```bash
npm run dashboard
```

Then open:

```txt
http://127.0.0.1:5178
```

The dashboard reads local graph databases from `~/.cache/codebase-memory-mcp`. Useful
environment variables:

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | Dashboard HTTP port | `5178` |
| `HOST` | Dashboard bind address | `127.0.0.1` |
| `CODEBASE_MEMORY_MCP_CACHE_DIR` | Custom cache directory to read projects from | `~/.cache/codebase-memory-mcp` |

```bash
PORT=9000 CODEBASE_MEMORY_MCP_CACHE_DIR=/path/to/cache npm run dashboard
```

## Use the MCP server

The server talks over stdio, so add it to your AI tool's MCP config, pointing at
`dist/index.js` from where you cloned this repo.

### Claude Code

```bash
claude mcp add codebase-memory-plus -- node /absolute/path/to/codebase-memory-plus/dist/index.js
```

Or add it manually to your Claude Code / Claude Desktop MCP config JSON:

```json
{
  "mcpServers": {
    "codebase-memory-plus": {
      "command": "node",
      "args": ["/absolute/path/to/codebase-memory-plus/dist/index.js"]
    }
  }
}
```

### Cursor and other JSON-config MCP clients

Same shape as above - add a `codebase-memory-plus` entry under `mcpServers` in whatever
MCP config file the client reads (e.g. `~/.cursor/mcp.json`).

### Codex

Add this to the global Codex MCP config:

```toml
[mcp_servers.codebase-memory-plus]
command = "node"
args = ["/absolute/path/to/codebase-memory-plus/dist/index.js"]
```

### Optional: expose a bare `codebase-memory-plus` command

Instead of pointing every client at `node .../dist/index.js`, you can link the package once:

```bash
npm link
```

This uses the `bin` entry in `package.json` to put `codebase-memory-plus` on your `PATH`, so
MCP configs can use it directly:

```toml
[mcp_servers.codebase-memory-plus]
command = "codebase-memory-plus"
```

## Configure

Create `~/.codebase-memory-plus/config.json` to point this tool at a non-default
`codebase-memory-mcp` binary or cache directory:

```json
{
  "baseMcp": {
    "command": "/Users/you/.local/bin/codebase-memory-mcp",
    "args": []
  },
  "projects": [
    {
      "name": "my-project",
      "root": "/Users/you/Documents/Project/my-project"
    }
  ]
}
```

If the config file is missing, `codebase-memory-plus` falls back to running
`codebase-memory-mcp` from `PATH`. All of the following can also be set via environment
variables, which take priority over the config file:

| Variable | Overrides |
|---|---|
| `CODEBASE_MEMORY_PLUS_CONFIG` | Path to the config file itself (default `~/.codebase-memory-plus/config.json`) |
| `CODEBASE_MEMORY_MCP_COMMAND` | `baseMcp.command` |
| `CODEBASE_MEMORY_MCP_ARGS` | `baseMcp.args` (space-separated) |

## Tool example

`project_summary_visual` input:

```json
{
  "projectRoot": "/Users/you/Documents/Project/my-project",
  "includeIndexing": false
}
```

Set `includeIndexing` to `true` if the project is not indexed and you want the tool to run a
fast index before summarizing.
