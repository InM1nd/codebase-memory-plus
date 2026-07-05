# What `codebase-memory-mcp` exposes, and what the dashboard shows

Snapshot from an audit of the base MCP (`~/.local/bin/codebase-memory-mcp`) done while
planning dashboard improvements. Useful as a reference for "what could we surface next."

## 1. Tools inventory

| Tool | What it returns | In dashboard? |
|---|---|---|
| `get_graph_schema` | Node labels + edge types with counts and the list of available `properties` per label/type | No (exploration only) |
| `get_architecture` | `total_nodes/edges`, `node_labels`, `edge_types`, `languages`, `packages` (fan_in/fan_out), `entry_points`, `hotspots`, `boundaries`, `layers`, `clusters` (Leiden community detection), `file_tree` | Partial - hotspots/layers/boundaries/clusters (Architecture panel) |
| `search_graph` | BM25 full-text, `name_pattern` regex, `semantic_query` (embeddings), filters (label/file_pattern/min_degree/max_degree/relationship), pagination | Partial - BM25 + semantic only, no extra filters |
| `trace_path` | Modes **calls** / **data_flow** / **cross_service**, direction, depth, `risk_labels`, `include_tests`, `edge_types` filter | Partial - `calls` mode only |
| `detect_changes` | Git-diff blast radius vs a base branch/ref | No |
| `manage_adr` | Architecture Decision Records - get/update/sections | No |
| `query_graph` | Arbitrary Cypher over the graph, up to 100k rows, built-in hot-path query guidance | No |
| `get_code_snippet` | Exact source for a symbol by qualified_name (+ neighbors) | No |
| `ingest_traces` | Enrich the graph with runtime traces | Out of scope (needs an external trace source) |
| `index_repository` | Indexing; special `cross-repo-intelligence` mode stitches Routes/Channels across projects (`CROSS_HTTP_CALLS` etc.) | No |
| `index_status` / `list_projects` / `delete_project` | Index/project management | Partial - `list_projects` only |

## 2. Node-level data (13 labels) - captured but not shown

Currently used: `complexity`, `is_exported`, `is_test`, `is_entry_point`.

Available but unused, on every `Function`/`Method`:

- `docstring`, `signature`, `param_names`/`param_types`, `return_type` - `docstring` only
  reaches a tooltip `title`, no readable panel
- `cognitive` (cognitive complexity, distinct from cyclomatic `complexity`)
- `loop_count`, `loop_depth`, `transitive_loop_depth`, `linear_scan_in_loop`,
  `alloc_in_loop`, `recursion_in_loop`, `unguarded_recursion`, `recursive`/`self_recursive`,
  `max_access_depth` - a ready-made hot-path/perf-risk signal set, entirely untouched
- `Class`/`Interface`: `base_classes` - in the type, never rendered
- `Route`: no dedicated API-surface view
- `EnvVar`: `env_key` - no configuration map
- `File`: `change_count`, `last_modified` - no churn signal (which files change most)

## 3. Edge-level data (14 types) - entirely unused

- `SIMILAR_TO` (`jaccard`, `same_file`) - structural code similarity, a potential
  duplicate/near-duplicate detector
- `SEMANTICALLY_RELATED` (`score`, `same_file`) - embedding neighbors, could surface as
  "related code" directly in the Inspector, not just via search
- `CONFIGURES` (`config_key`, `confidence`) - links code to config/env
- `HTTP_CALLS` (`url_path`, `via`, `callee`) - a real map of API endpoints and their callers
- `WRITES`, `INHERITS`, `IMPLEMENTS` - structural, currently folded into generic edge
  counts with no dedicated treatment

## 4. Concrete feature ideas from the above

1. **Symbol "Details" panel** - expandable card with `signature`, full `docstring`,
   `param_names/types`, `return_type`, `base_classes`. Cheap - the data is already in
   `properties`, just not rendered beyond the badge/complexity chip.
2. **Hot-path radar** - a "Perf risks" list: functions with high `transitive_loop_depth`,
   `linear_scan_in_loop`, `unguarded_recursion`.
3. **API surface map** - Route nodes + their callers via `HTTP_CALLS.url_path`.
4. **Config map** - EnvVar nodes + `CONFIGURES` edges: what depends on which env var.
5. **Duplicate finder** - top `SIMILAR_TO` pairs by jaccard score, useful pre-refactor.
6. **"Related code" in Inspector** - `SEMANTICALLY_RELATED` neighbors of the selected
   symbol, without going through search.
7. **Data flow / cross-service trace** - the other two `trace_path` modes; the Trace
   dialog infrastructure already exists, just needs a mode switch + rendering for the
   extra per-hop fields (`args`, `url_path`).
8. **Impact view (`detect_changes`)** - pick a `base_branch`/`since`, see blast radius of
   uncommitted/recent changes. Already noted as a fast-follow when Trace shipped.
9. **ADR viewer/editor (`manage_adr`)** - simple read/write panel over the existing
   markdown contract.
10. **Cypher console (`query_graph`)** - power-user escape hatch for custom queries
    without leaving the dashboard.
11. **Index health indicator** - surface `index_status` + whether embeddings were built
    (inferable from `node_vectors` presence), so it's clear why semantic search sometimes
    comes back empty. Confirmed on a sample project: embeddings do exist (1,138 vectors
    across Function/Method nodes), a query like "publish" just has no strong match in that
    project's vocabulary - expected behavior, not a broken feature.
12. **Cross-repo intelligence** - `index_repository(mode: "cross-repo-intelligence")` can
    stitch HTTP/async calls across indexed projects. Relevant given how many related
    projects/worktrees can end up indexed at once (a project plus its git worktree
    copies) - a potential multi-project graph view if cross-service relationships ever
    need inspecting.
