# Agent config sync policy

What's supposed to be identical across Claude, Cursor, and Codex, what's
tool-specific, and how each category gets there. Written after the
[cleanup in `TASK-agent-config-cleanup.md`](./TASK-agent-config-cleanup.md)
pruned ~260 stray skill symlinks (130 unique names down to 44) back to this
policy.

## MCP servers

7 core servers, same name/command in all three tools:
`cavemem`, `chrome-devtools`, `codebase-memory-mcp`, `pencil`, `playwright`,
`refero`, `serena`.

| Tool | Config file |
|---|---|
| Claude | `~/.claude.json` (`mcpServers`) |
| Cursor | `~/.cursor/mcp.json` (`mcpServers`) |
| Codex | `~/.codex/config.toml` (`[mcp_servers.*]`) |

Codex additionally has `node_repl` (Codex-app-bundled, no equivalent
elsewhere) and `computer-use` (present but `enabled = false`). Neither
should be added to Claude/Cursor.

## Skills

44 unique names, split by `origin` (see `src/agent-config-scanner.ts`,
`skillOrigin()`):

- **`user` (33 names)** — real directories, canonical source `~/.claude/skills/`
  for the 14 core design/dev skills and `~/.cursor/skills-cursor/` for the
  19 Cursor-workflow skills. Every other tool gets a symlink pointing at
  the canonical real dir (already wired up; nothing to recreate).
- **`plugin` (11 names)** — the skill's real files live under a plugin's own
  `plugins/cache/**` (or Codex's `.tmp/bundled-marketplaces/**`); every
  tool that has it is a symlink into that plugin cache, never a copy.

| Component | Claude | Cursor | Codex | Sync strategy |
|---|---|---|---|---|
| 14 core design/dev skills | real dir | symlink → claude | symlink → claude | `~/.claude/skills/` is canonical |
| 19 Cursor-workflow skills | symlink → cursor | real dir | symlink → cursor | `~/.cursor/skills-cursor/` is canonical |
| `frontend-design` | symlink → plugin cache | symlink → plugin cache | — | claude-plugins-official plugin |
| `ponytail`, `ponytail-review`, `ponytail-help` | symlink → plugin cache | symlink → plugin cache | native plugin | Cursor has no plugin loader, so skills-only there |
| `caveman`, `caveman-review`, `cavecrew` | symlink → plugin cache | symlink → plugin cache | native plugin | same as ponytail |
| `nextjs`, `vercel-cli`, `ai-sdk`, `shadcn` | symlink → plugin cache | symlink → plugin cache | — | vercel plugin, Cursor accesses the rest of vercel via MCP instead |

**Never mirror `plugins/cache/**` wholesale into a skills directory again.**
That's what produced the 130-skill blowup — every sub-skill of every
installed plugin (all 23 vercel skills, all 20 `artifact-template-*`,
Codex's bundled `documents`/`pdf`/`spreadsheets`/etc.) got a symlink even
though nothing referenced most of them. If a new plugin skill is genuinely
needed in more than one tool, add its name to the curated list by hand
(`docs/TASK-agent-config-cleanup.md` § 1.2) — don't re-run a blanket sync.

## Plugins

| Component | Claude | Cursor | Codex | Sync strategy |
|---|---|---|---|---|
| `ponytail` | native plugin | skills only | native plugin | `enabledPlugins` (claude) / `[plugins."ponytail@ponytail"]` (codex) |
| `caveman` | native plugin | skills only | native plugin | same shape |
| `vercel` | native plugin | MCP (no plugin system) | native plugin | skills optional per table above |
| Codex-bundled (`documents`, `spreadsheets`, `presentations`, `pdf`, `browser`, `latex`, `computer-use`, `template-creator`, `visualize`) | never | never | native | ChatGPT-app runtime, not portable |
| Claude-official (`claude-tokens-plugin`, `code-review`, `frontend-design`) | native | skill-mirror only where listed above | never | Claude-plugin-marketplace specific |

## Where this is enforced

- `src/agent-config-scanner.ts` — `skillOrigin()` tags every skill entry
  `user` or `plugin` by resolving its real path.
- `GET /api/agent-config?origin=user|plugin` — server-side filter.
- Dashboard Agent Config view — "Include plugin skills" toggle, off by
  default; plugin-origin skill cards/rows get a `plugin` badge when shown.
