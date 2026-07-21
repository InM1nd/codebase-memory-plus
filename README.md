# Codebase Memory Plus

Personal MCP layer + local dashboard on top of `codebase-memory-mcp`.
The goal is to keep the original indexer and graph engine intact, while adding higher-level
tools for visual summaries, route maps, symbol graphs, impact analysis, and a local dashboard.

This repo gives you two independent things, both built on the same local graph cache:

- **An MCP server** (`codebase-memory-plus`) - one tool, `project_summary_visual`, for use from
  any MCP-compatible AI agent (Claude Code, Cursor, Codex, etc.).
- **A local web dashboard** - project picker, package/symbol dependency graphs, relation
  filters, architecture/perf/duplicate insights, an Agent Config view for managing MCP
  servers/skills/plugins across Claude Code, Cursor, and Codex, a Serena panel for monitoring
  and managing a Serena MCP session against the selected project, and a toggle to embed
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

### Agent Config

Open via the header's **MCP & Skills** button. It scans MCP servers, skills, and
plugins across Claude Code, Cursor, and Codex (both global and per-project configs) and shows
them as one list, grouped by name so the same skill mirrored across tools appears once with a
per-tool breakdown.

- **Toggle / delete** any entry - uses each tool's native CLI where one exists (e.g.
  `claude plugin enable/disable`), otherwise edits the underlying config file directly
  (Codex's `config.toml`, Cursor's `mcp.json`, or a stash file for Claude's `mcpServers`,
  since it has no native disable flag). Delete always backs up the source file/directory to
  `~/.codebase-memory-plus/backups/<timestamp>/` first.
- **User vs plugin origin** - skills whose real files live inside a plugin's own cache
  (resolved through symlinks) are tagged `plugin`; the "Include plugin skills" toggle keeps
  them out of the default view so it isn't swamped by every sub-skill of every installed
  plugin. See [`docs/agent-config-sync.md`](./docs/agent-config-sync.md) for the sync policy
  this was built to enforce.
- **Duplicates** - flags names genuinely reused across *different* entity types (e.g. a
  `playwright` skill and a `playwright` MCP server), not just the same skill synced to
  multiple tools.
- **Usage** - when available, shows Claude Code's own tracked invocation counts
  (`skillUsage`/`pluginUsage` in `~/.claude.json`), plus a `hooked` badge on plugins that
  register their own session hooks (so they stay active regardless of the skill toggle).

### Serena

If you also run [Serena](https://github.com/oraios/serena) (an LSP-based semantic coding MCP)
against your projects, open its panel via the header's **Serena** button (only shown once a
project is selected). This proxies Serena's own local dashboard REST API - it does not run any
of Serena's LSP tools itself, so symbol/reference browsing still happens through Serena
directly.

**Prerequisite**: Serena's dashboard API is disabled by default. Set `web_dashboard: true` in
`~/.serena/serena_config.yml` and restart your Serena session(s) - this is a global Serena
setting, not per-project.

- **Status** - detects whether Serena's dashboard is enabled, whether an instance is reachable
  for the currently selected project, and whether that instance's *active* project actually
  matches (Serena only works on one project per instance at a time, so a running instance
  attached to a different project shows as connected-but-elsewhere, with the list of projects
  it has registered).
- **Discovery** - Serena exposes no endpoint that lists running instances, so discovery is a
  bounded scan of the local port range Serena allocates dashboards from
  (`24282`-`24297`). An instance outside that range, or one that doesn't answer within ~300ms,
  won't be found.
- **Project cards** - on the home screen and inside a project, a small **Serena** badge shows
  whether a live Serena instance is currently active on that project.
- **Overview & tool usage** - active project/language/context/modes, plus per-tool call counts
  and estimated input/output token usage for the session.
- **Memories** - list, view, create, edit, rename, and delete Serena's project memory files
  (`.serena/memories/*.md`) directly from the panel.
- **Log tail** - polls Serena's session log while the panel is open (paused when the tab or
  panel isn't visible).

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
