import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";

import type { IndexedProject } from "./base-memory-client.js";
import type { PlusConfig } from "./config.js";

export type CacheProjectStats = {
  project: string;
  root_path: string;
  nodes: number;
  edges: number;
  path_exists: boolean;
};

export type ArchitectureFallback = {
  project: string;
  total_nodes: number;
  total_edges: number;
  node_labels: Array<{ label: string; count: number }>;
  edge_types: Array<{ type: string; count: number }>;
  packages: Array<{ name: string; node_count: number }>;
  total_packages: number;
  families: string[];
  source: "local-cache-fallback";
};

export type SymbolMeta = {
  complexity?: number;
  cognitive?: number;
  docstring?: string;
  signature?: string;
  isExported?: boolean;
  isTest?: boolean;
  isEntryPoint?: boolean;
  lines?: number;
  paramCount?: number;
  paramNames?: string[];
  paramTypes?: string[];
  returnType?: string;
  baseClasses?: string[];
  loopCount?: number;
  loopDepth?: number;
  transitiveLoopDepth?: number;
  linearScanInLoop?: number;
  allocInLoop?: number;
  recursionInLoop?: boolean;
  unguardedRecursion?: boolean;
  recursive?: boolean;
  maxAccessDepth?: number;
};

export type GraphNode = {
  id: string;
  label: string;
  kind: string;
  count?: number;
  file?: string;
  qualifiedName?: string;
  meta?: SymbolMeta;
};

export type GraphEdge = {
  source: string;
  target: string;
  type: string;
  count: number;
};

export type PackageDetails = {
  name: string;
  node_count: number;
  label_counts: Array<{ label: string; count: number }>;
  top_symbols: GraphNode[];
  relations: GraphEdge[];
  avg_complexity?: number;
};

let sqlPromise: Promise<SqlJsStatic> | undefined;

export async function enrichProjectsFromCache(
  projects: IndexedProject[],
  config: PlusConfig
): Promise<IndexedProject[]> {
  const enriched = await Promise.all(
    projects.map(async (project) => {
      if (project.root_path && project.nodes && project.edges) {
        return project;
      }

      const stats = await readProjectStats(project.name, config);
      if (!stats) {
        return project;
      }

      return {
        ...project,
        root_path: project.root_path || stats.root_path,
        nodes: project.nodes || stats.nodes,
        edges: project.edges || stats.edges
      };
    })
  );

  return enriched;
}

export async function listCachedProjects(config: PlusConfig): Promise<CacheProjectStats[]> {
  const dir = cacheDir(config);
  if (!existsSync(dir)) {
    return [];
  }

  const projectNames = readdirSync(dir)
    .filter((file) => file.endsWith(".db"))
    .filter((file) => !file.startsWith("_"))
    .map((file) => file.replace(/\.db$/, ""));

  const projects = await Promise.all(projectNames.map((name) => readProjectStats(name, config)));
  return projects.filter((project): project is CacheProjectStats => Boolean(project));
}

export async function readProjectStats(
  projectName: string,
  config: PlusConfig
): Promise<CacheProjectStats | undefined> {
  const dbPath = projectDbPath(projectName, config);
  if (!existsSync(dbPath)) {
    return undefined;
  }

  return withDatabase(dbPath, (db) => {
    const row = queryRows<Omit<CacheProjectStats, "path_exists">>(
      db,
      [
        "SELECT",
        "  (SELECT name FROM projects LIMIT 1) AS project,",
        "  (SELECT root_path FROM projects LIMIT 1) AS root_path,",
        "  (SELECT COUNT(*) FROM nodes) AS nodes,",
        "  (SELECT COUNT(*) FROM edges) AS edges"
      ].join("\n")
    )[0];
    if (!row) return undefined;

    return { ...row, path_exists: existsSync(row.root_path) };
  }).catch(() => undefined);
}

export async function readArchitectureFallback(
  projectName: string,
  config: PlusConfig
): Promise<ArchitectureFallback | undefined> {
  const dbPath = projectDbPath(projectName, config);
  if (!existsSync(dbPath)) {
    return undefined;
  }

  return withDatabase(dbPath, (db) => {
    const stats = queryRows<CacheProjectStats>(
      db,
      [
        "SELECT",
        "  (SELECT name FROM projects LIMIT 1) AS project,",
        "  (SELECT root_path FROM projects LIMIT 1) AS root_path,",
        "  (SELECT COUNT(*) FROM nodes) AS nodes,",
        "  (SELECT COUNT(*) FROM edges) AS edges"
      ].join("\n")
    )[0];

    if (!stats) {
      return undefined;
    }

    const nodeRows = queryRows<{ file_path: string }>(db, "SELECT file_path FROM nodes");
    const families = [...new Set(nodeRows.filter((row) => row.file_path).map((row) => familyOf(packageOf(row.file_path))))].sort();

    return {
      project: stats.project || projectName,
      total_nodes: stats.nodes,
      total_edges: stats.edges,
      node_labels: queryRows<{ label: string; count: number }>(
        db,
        "SELECT label, COUNT(*) AS count FROM nodes GROUP BY label ORDER BY count DESC"
      ),
      edge_types: queryRows<{ type: string; count: number }>(
        db,
        "SELECT type, COUNT(*) AS count FROM edges GROUP BY type ORDER BY count DESC"
      ),
      packages: computePackageCounts(nodeRows, 15),
      total_packages: new Set(nodeRows.filter((row) => row.file_path).map((row) => packageOf(row.file_path))).size,
      families,
      source: "local-cache-fallback" as const
    };
  }).catch(() => undefined);
}

export async function readPackageGraph(
  projectName: string,
  config: PlusConfig,
  limit = 60,
  family?: string
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] } | undefined> {
  const dbPath = projectDbPath(projectName, config);
  if (!existsSync(dbPath)) {
    return undefined;
  }

  return withDatabase(dbPath, (db) => {
    const allNodeRows = queryRows<{ id: string; file_path: string }>(
      db,
      "SELECT id, file_path FROM nodes"
    );
    // A family scope shows every package in that area, not just the globally largest ones -
    // the whole point is guaranteed completeness within the chosen area.
    const nodeRows = family
      ? allNodeRows.filter((row) => familyOf(packageOf(row.file_path)) === family)
      : allNodeRows;
    const effectiveLimit = family ? Infinity : limit;
    const packages = computePackageCounts(nodeRows, effectiveLimit);
    const packageSet = new Set(packages.map((row) => row.name));

    const edgeRows = queryRows<{ source_id: string; target_id: string; type: string }>(
      db,
      "SELECT source_id, target_id, type FROM edges"
    );
    const packageIndex = buildPackageIndex(nodeRows);
    const edges = aggregatePackageEdges(edgeRows, packageIndex)
      .slice(0, family ? Infinity : Math.max(10, limit * 2))
      .filter((edge) => packageSet.has(edge.source) && packageSet.has(edge.target));

    return {
      nodes: packages.map((row) => ({
        id: row.name,
        label: row.name,
        kind: "package",
        count: row.node_count
      })),
      edges
    };
  }).catch(() => undefined);
}

const SYMBOL_GRAPH_LABELS = ["Function", "Method", "Class", "Interface", "Type", "Route"];

export async function readSymbolGraph(
  projectName: string,
  config: PlusConfig,
  limit = 60,
  family?: string
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] } | undefined> {
  const dbPath = projectDbPath(projectName, config);
  if (!existsSync(dbPath)) {
    return undefined;
  }

  return withDatabase(dbPath, (db) => {
    const placeholders = SYMBOL_GRAPH_LABELS.map(() => "?").join(",");
    const allNodeRows = queryRows<{
      id: number;
      name: string;
      label: string;
      qualified_name: string;
      file_path: string;
      properties: string;
    }>(
      db,
      `SELECT id, name, label, qualified_name, file_path, properties FROM nodes WHERE label IN (${placeholders})`,
      SYMBOL_GRAPH_LABELS
    );
    const nodeRows = family
      ? allNodeRows.filter((row) => familyOf(packageOf(row.file_path)) === family)
      : allNodeRows;
    const nodeIdSet = new Set(nodeRows.map((row) => row.id));

    const allEdgeRows = queryRows<{ source_id: number; target_id: number; type: string }>(
      db,
      "SELECT source_id, target_id, type FROM edges"
    );
    const edgeRows = allEdgeRows.filter(
      (edge) => edge.source_id !== edge.target_id && nodeIdSet.has(edge.source_id) && nodeIdSet.has(edge.target_id)
    );

    const degree = new Map<number, number>();
    for (const edge of edgeRows) {
      degree.set(edge.source_id, (degree.get(edge.source_id) ?? 0) + 1);
      degree.set(edge.target_id, (degree.get(edge.target_id) ?? 0) + 1);
    }

    const effectiveLimit = family ? Infinity : limit;
    const ranked = [...nodeRows]
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
      .slice(0, effectiveLimit);
    const selectedIds = new Set(ranked.map((row) => row.id));
    const rankedById = new Map(ranked.map((row) => [row.id, row]));

    const nodes: GraphNode[] = ranked.map((row) => ({
      id: row.qualified_name,
      label: row.name,
      kind: row.label,
      count: degree.get(row.id) ?? 0,
      file: row.file_path,
      qualifiedName: row.qualified_name,
      meta: parseSymbolMeta(row.properties)
    }));

    const edges: GraphEdge[] = edgeRows
      .filter((edge) => selectedIds.has(edge.source_id) && selectedIds.has(edge.target_id))
      .map((edge) => ({
        source: rankedById.get(edge.source_id)!.qualified_name,
        target: rankedById.get(edge.target_id)!.qualified_name,
        type: edge.type,
        count: 1
      }));

    return { nodes, edges };
  }).catch(() => undefined);
}

export async function readPackageDetails(
  projectName: string,
  config: PlusConfig,
  packageName: string
): Promise<PackageDetails | undefined> {
  const dbPath = projectDbPath(projectName, config);
  if (!existsSync(dbPath)) {
    return undefined;
  }

  return withDatabase(dbPath, (db) => {
    const nodeRows = queryRows<{
      id: string;
      name: string;
      label: string;
      qualified_name: string;
      file_path: string;
      properties: string;
    }>(db, "SELECT id, name, label, qualified_name, file_path, properties FROM nodes");
    const packageNodes = nodeRows.filter((row) => packageOf(row.file_path) === packageName);

    const labelTally = new Map<string, number>();
    for (const row of packageNodes) {
      labelTally.set(row.label, (labelTally.get(row.label) ?? 0) + 1);
    }
    const labelCounts = [...labelTally.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);
    const nodeCount = packageNodes.length;

    const complexities = packageNodes
      .map((row) => parseSymbolMeta(row.properties)?.complexity)
      .filter((value): value is number => typeof value === "number");
    const avgComplexity = complexities.length
      ? complexities.reduce((sum, value) => sum + value, 0) / complexities.length
      : undefined;

    const edgeRows = queryRows<{ source_id: string; target_id: string; type: string }>(
      db,
      "SELECT source_id, target_id, type FROM edges"
    );
    const degree = new Map<string, number>();
    for (const edge of edgeRows) {
      degree.set(edge.source_id, (degree.get(edge.source_id) ?? 0) + 1);
      degree.set(edge.target_id, (degree.get(edge.target_id) ?? 0) + 1);
    }

    const labelPriority: Record<string, number> = { Function: 0, Class: 1, Interface: 2, Module: 3 };
    const topSymbols = packageNodes
      .filter((row) => ["Function", "Class", "Interface", "Module", "Type"].includes(row.label))
      .map((row) => ({ ...row, degree: degree.get(row.id) ?? 0 }))
      .sort((a, b) => {
        if (b.degree !== a.degree) return b.degree - a.degree;
        const priorityDiff = (labelPriority[a.label] ?? 4) - (labelPriority[b.label] ?? 4);
        if (priorityDiff !== 0) return priorityDiff;
        return a.qualified_name.length - b.qualified_name.length;
      })
      .slice(0, 18)
      .map((row) => ({
        id: row.qualified_name,
        label: row.name,
        kind: row.label,
        file: row.file_path,
        qualifiedName: row.qualified_name,
        count: row.degree,
        meta: parseSymbolMeta(row.properties)
      }));

    const packageIndex = buildPackageIndex(nodeRows);
    const relations = aggregatePackageEdges(edgeRows, packageIndex)
      .filter((edge) => edge.source === packageName || edge.target === packageName)
      .slice(0, 24);

    return {
      name: packageName,
      node_count: nodeCount,
      label_counts: labelCounts,
      top_symbols: topSymbols,
      relations,
      avg_complexity: avgComplexity
    };
  }).catch(() => undefined);
}

export async function searchCachedNodes(
  projectName: string,
  config: PlusConfig,
  term: string,
  limit = 30,
  label?: string
): Promise<GraphNode[]> {
  const dbPath = projectDbPath(projectName, config);
  if (!existsSync(dbPath) || !term.trim()) {
    return [];
  }

  return withDatabase(dbPath, (db) => {
    const escaped = `%${term.replace(/[%_]/g, "")}%`;

    return queryRows<{
      name: string;
      label: string;
      qualified_name: string;
      file_path: string;
      properties: string;
    }>(
      db,
      [
        "SELECT name, label, qualified_name, file_path, properties",
        "FROM nodes",
        // Mirrors search_graph's own BM25 mode, which drops these same labels as noise -
        // keeps the fallback path just as focused as the primary MCP path.
        "WHERE label NOT IN ('File', 'Folder', 'Module', 'Variable')",
        "  AND (name LIKE ? OR qualified_name LIKE ? OR file_path LIKE ?)",
        ...(label ? ["  AND label = ?"] : []),
        // Priority mirrors search_graph's structural boosting (Functions/Methods highest,
        // then Routes, then Classes/Interfaces).
        "ORDER BY",
        "  CASE label",
        "    WHEN 'Function' THEN 0",
        "    WHEN 'Method' THEN 0",
        "    WHEN 'Route' THEN 1",
        "    WHEN 'Class' THEN 2",
        "    WHEN 'Interface' THEN 2",
        "    ELSE 3",
        "  END,",
        "  length(qualified_name)",
        "LIMIT ?"
      ].join("\n"),
      [escaped, escaped, escaped, ...(label ? [label] : []), limit]
    ).map((row) => ({
      id: row.qualified_name,
      label: row.name,
      kind: row.label,
      file: row.file_path,
      qualifiedName: row.qualified_name,
      meta: parseSymbolMeta(row.properties)
    }));
  }).catch(() => []);
}

export async function readRelatedSymbols(
  projectName: string,
  config: PlusConfig,
  qualifiedName: string,
  limit = 6
): Promise<GraphNode[]> {
  const dbPath = projectDbPath(projectName, config);
  if (!existsSync(dbPath) || !qualifiedName) {
    return [];
  }

  return withDatabase(dbPath, (db) => {
    const node = queryRows<{ id: number }>(
      db,
      "SELECT id FROM nodes WHERE qualified_name = ?",
      [qualifiedName]
    )[0];
    if (!node) return [];

    const edgeRows = queryRows<{ source_id: number; target_id: number; properties: string }>(
      db,
      [
        "SELECT source_id, target_id, properties FROM edges",
        "WHERE type = 'SEMANTICALLY_RELATED' AND (source_id = ? OR target_id = ?)",
        "ORDER BY json_extract(properties, '$.score') DESC",
        "LIMIT ?"
      ].join("\n"),
      [node.id, node.id, limit]
    );
    if (!edgeRows.length) return [];

    const neighborIds = edgeRows.map((edge) => (edge.source_id === node.id ? edge.target_id : edge.source_id));
    const placeholders = neighborIds.map(() => "?").join(",");
    const neighborRows = queryRows<{
      id: number;
      name: string;
      label: string;
      qualified_name: string;
      file_path: string;
      properties: string;
    }>(
      db,
      `SELECT id, name, label, qualified_name, file_path, properties FROM nodes WHERE id IN (${placeholders})`,
      neighborIds
    );
    const neighborById = new Map(neighborRows.map((row) => [row.id, row]));

    return neighborIds
      .map((id) => neighborById.get(id))
      .filter((row): row is (typeof neighborRows)[number] => Boolean(row))
      .map((row) => ({
        id: row.qualified_name,
        label: row.name,
        kind: row.label,
        file: row.file_path,
        qualifiedName: row.qualified_name,
        meta: parseSymbolMeta(row.properties)
      }));
  }).catch(() => []);
}

export type PerfRisk = {
  id: string;
  label: string;
  file?: string;
  qualifiedName: string;
  score: number;
  meta: SymbolMeta;
};

export async function readPerfRisks(
  projectName: string,
  config: PlusConfig,
  limit = 20
): Promise<PerfRisk[]> {
  const dbPath = projectDbPath(projectName, config);
  if (!existsSync(dbPath)) {
    return [];
  }

  return withDatabase(dbPath, (db) => {
    const rows = queryRows<{
      name: string;
      qualified_name: string;
      file_path: string;
      properties: string;
    }>(
      db,
      "SELECT name, qualified_name, file_path, properties FROM nodes WHERE label IN ('Function', 'Method')"
    );

    const risks: PerfRisk[] = [];
    for (const row of rows) {
      const meta = parseSymbolMeta(row.properties);
      if (!meta) continue;

      const score =
        (meta.transitiveLoopDepth ?? 0) * 10 +
        (meta.linearScanInLoop ?? 0) * 5 +
        (meta.unguardedRecursion ? 20 : 0) +
        (meta.allocInLoop ?? 0) * 2;
      if (score <= 0) continue;

      risks.push({
        id: row.qualified_name,
        label: row.name,
        file: row.file_path,
        qualifiedName: row.qualified_name,
        score,
        meta
      });
    }

    return risks.sort((a, b) => b.score - a.score).slice(0, limit);
  }).catch(() => []);
}

export type ApiSurfaceGroup = {
  urlPath: string;
  route?: { qualifiedName: string; name: string };
  callers: Array<{ name: string; qualifiedName: string; file?: string }>;
};

// Groups HTTP_CALLS edges by the URL path they hit - source_id is the calling code,
// target_id is the Route node representing that endpoint (confirmed empirically against
// a real project's cache DB before writing this).
export async function readApiSurface(projectName: string, config: PlusConfig): Promise<ApiSurfaceGroup[]> {
  const dbPath = projectDbPath(projectName, config);
  if (!existsSync(dbPath)) {
    return [];
  }

  return withDatabase(dbPath, (db) => {
    const edgeRows = queryRows<{ source_id: number; target_id: number; properties: string }>(
      db,
      "SELECT source_id, target_id, properties FROM edges WHERE type = 'HTTP_CALLS'"
    );
    if (!edgeRows.length) return [];

    const nodeIds = [...new Set(edgeRows.flatMap((edge) => [edge.source_id, edge.target_id]))];
    const nodeById = queryNodesByIds(db, nodeIds);

    const groups = new Map<string, ApiSurfaceGroup>();
    for (const edge of edgeRows) {
      const urlPath = jsonProp(edge.properties, "url_path");
      const target = nodeById.get(edge.target_id);
      const key = urlPath || target?.name || String(edge.target_id);

      if (!groups.has(key)) {
        groups.set(key, {
          urlPath: key,
          route: target ? { qualifiedName: target.qualified_name, name: target.name } : undefined,
          callers: []
        });
      }
      const source = nodeById.get(edge.source_id);
      if (source) {
        groups.get(key)!.callers.push({
          name: source.name,
          qualifiedName: source.qualified_name,
          file: source.file_path
        });
      }
    }

    return [...groups.values()].sort((a, b) => b.callers.length - a.callers.length).slice(0, 30);
  }).catch(() => []);
}

export type ConfigMapEntry = {
  key: string;
  configuredBy: Array<{ name: string; qualifiedName: string; file?: string }>;
};

export type ConfigMap = {
  envVars: GraphNode[];
  entries: ConfigMapEntry[];
};

// EnvVar declarations plus CONFIGURES edges grouped by config_key - source_id is the code
// referencing the key, confirmed empirically the same way as readApiSurface above.
export async function readConfigMap(projectName: string, config: PlusConfig): Promise<ConfigMap> {
  const dbPath = projectDbPath(projectName, config);
  if (!existsSync(dbPath)) {
    return { envVars: [], entries: [] };
  }

  return withDatabase(dbPath, (db) => {
    const envRows = queryRows<{
      name: string;
      qualified_name: string;
      file_path: string;
    }>(db, "SELECT name, qualified_name, file_path FROM nodes WHERE label = 'EnvVar'");
    const envVars: GraphNode[] = envRows.map((row) => ({
      id: row.qualified_name,
      label: row.name,
      kind: "EnvVar",
      file: row.file_path,
      qualifiedName: row.qualified_name
    }));

    const edgeRows = queryRows<{ source_id: number; properties: string }>(
      db,
      "SELECT source_id, properties FROM edges WHERE type = 'CONFIGURES'"
    );
    if (!edgeRows.length) return { envVars, entries: [] };

    const nodeById = queryNodesByIds(db, [...new Set(edgeRows.map((edge) => edge.source_id))]);

    const groups = new Map<string, ConfigMapEntry>();
    for (const edge of edgeRows) {
      const key = jsonProp(edge.properties, "config_key");
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, { key, configuredBy: [] });
      const source = nodeById.get(edge.source_id);
      if (source) {
        groups.get(key)!.configuredBy.push({
          name: source.name,
          qualifiedName: source.qualified_name,
          file: source.file_path
        });
      }
    }

    const entries = [...groups.values()].sort((a, b) => b.configuredBy.length - a.configuredBy.length).slice(0, 30);
    return { envVars, entries };
  }).catch(() => ({ envVars: [], entries: [] }));
}

export type DuplicatePair = {
  jaccard: number;
  sameFile: boolean;
  a: { name: string; qualifiedName: string; file?: string };
  b: { name: string; qualifiedName: string; file?: string };
};

export async function readDuplicates(
  projectName: string,
  config: PlusConfig,
  limit = 30
): Promise<DuplicatePair[]> {
  const dbPath = projectDbPath(projectName, config);
  if (!existsSync(dbPath)) {
    return [];
  }

  return withDatabase(dbPath, (db) => {
    const edgeRows = queryRows<{ source_id: number; target_id: number; properties: string }>(
      db,
      "SELECT source_id, target_id, properties FROM edges WHERE type = 'SIMILAR_TO'"
    );
    if (!edgeRows.length) return [];

    const nodeIds = [...new Set(edgeRows.flatMap((edge) => [edge.source_id, edge.target_id]))];
    const nodeById = queryNodesByIds(db, nodeIds);

    const pairs: DuplicatePair[] = [];
    for (const edge of edgeRows) {
      const a = nodeById.get(edge.source_id);
      const b = nodeById.get(edge.target_id);
      if (!a || !b) continue;

      let jaccard = 0;
      let sameFile = false;
      try {
        const parsed = JSON.parse(edge.properties);
        jaccard = typeof parsed.jaccard === "number" ? parsed.jaccard : 0;
        sameFile = Boolean(parsed.same_file);
      } catch {
        continue;
      }

      pairs.push({
        jaccard,
        sameFile,
        a: { name: a.name, qualifiedName: a.qualified_name, file: a.file_path },
        b: { name: b.name, qualifiedName: b.qualified_name, file: b.file_path }
      });
    }

    return pairs.sort((x, y) => y.jaccard - x.jaccard).slice(0, limit);
  }).catch(() => []);
}

export type FileChurn = {
  name: string;
  filePath: string;
  changeCount: number;
  lastModified?: number;
};

export async function readFileChurn(
  projectName: string,
  config: PlusConfig,
  limit = 10
): Promise<FileChurn[]> {
  const dbPath = projectDbPath(projectName, config);
  if (!existsSync(dbPath)) {
    return [];
  }

  return withDatabase(dbPath, (db) => {
    const rows = queryRows<{ name: string; file_path: string; properties: string }>(
      db,
      "SELECT name, file_path, properties FROM nodes WHERE label = 'File'"
    );

    const churn: FileChurn[] = [];
    for (const row of rows) {
      let changeCount: number | undefined;
      let lastModified: number | undefined;
      try {
        const parsed = JSON.parse(row.properties);
        changeCount = typeof parsed.change_count === "number" ? parsed.change_count : undefined;
        lastModified = typeof parsed.last_modified === "number" ? parsed.last_modified : undefined;
      } catch {
        continue;
      }
      // Only files with git history captured carry change_count - most don't have the
      // field at all (see docs/mcp-capabilities.md), so skip rather than showing zeroes.
      if (changeCount === undefined) continue;

      churn.push({ name: row.name, filePath: row.file_path, changeCount, lastModified });
    }

    return churn.sort((a, b) => b.changeCount - a.changeCount).slice(0, limit);
  }).catch(() => []);
}

const CROSS_REPO_EDGE_TYPES = [
  "CROSS_HTTP_CALLS",
  "CROSS_ASYNC_CALLS",
  "CROSS_CHANNEL",
  "CROSS_GRPC_CALLS",
  "CROSS_GRAPHQL_CALLS",
  "CROSS_TRPC_CALLS"
];

export type CrossRepoLink = {
  type: string;
  sourceName: string;
  sourceFile?: string;
  targetName: string;
  targetProject?: string;
};

// index_repository(mode: "cross-repo-intelligence") writes these edge types into the
// anchor project's own local cache. The target node may live in a different project's
// SQLite file - source_id/target_id alone can't resolve that, so this falls back to
// whatever qualified_name/project fields the edge's own `properties` blob carries when the
// target isn't one of this project's own nodes.
export async function readCrossRepoLinks(
  projectName: string,
  config: PlusConfig
): Promise<CrossRepoLink[]> {
  const dbPath = projectDbPath(projectName, config);
  if (!existsSync(dbPath)) {
    return [];
  }

  return withDatabase(dbPath, (db) => {
    const placeholders = CROSS_REPO_EDGE_TYPES.map(() => "?").join(",");
    const edgeRows = queryRows<{ type: string; source_id: number; target_id: number; properties: string }>(
      db,
      `SELECT type, source_id, target_id, properties FROM edges WHERE type IN (${placeholders})`,
      CROSS_REPO_EDGE_TYPES
    );
    if (!edgeRows.length) return [];

    const nodeIds = [...new Set(edgeRows.flatMap((edge) => [edge.source_id, edge.target_id]))];
    const nodeById = queryNodesByIds(db, nodeIds);

    return edgeRows.map((edge) => {
      const source = nodeById.get(edge.source_id);
      const target = nodeById.get(edge.target_id);
      let targetProject: string | undefined;
      let targetNameFromProps: string | undefined;
      try {
        const parsed = JSON.parse(edge.properties);
        targetProject = typeof parsed.target_project === "string" ? parsed.target_project : undefined;
        targetNameFromProps =
          typeof parsed.target_qualified_name === "string" ? parsed.target_qualified_name : undefined;
      } catch {
        // properties not JSON or missing - fall back to whatever local resolution found
      }

      return {
        type: edge.type,
        sourceName: source?.name ?? `#${edge.source_id}`,
        sourceFile: source?.file_path,
        targetName: target?.name ?? targetNameFromProps ?? `#${edge.target_id}`,
        targetProject
      };
    });
  }).catch(() => []);
}

function jsonProp(raw: string | undefined, key: string): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed[key] === "string" ? parsed[key] : "";
  } catch {
    return "";
  }
}

function queryNodesByIds(
  db: Database,
  ids: number[]
): Map<number, { id: number; name: string; qualified_name: string; file_path: string }> {
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => "?").join(",");
  const rows = queryRows<{ id: number; name: string; qualified_name: string; file_path: string }>(
    db,
    `SELECT id, name, qualified_name, file_path FROM nodes WHERE id IN (${placeholders})`,
    ids
  );
  return new Map(rows.map((row) => [row.id, row]));
}

// Whether embeddings were actually built for this project (search_graph's semantic_query
// needs "moderate"/"full" index mode - "fast" mode skips them). Checking this locally avoids
// asking the base MCP to run a semantic search that can never return anything.
export async function hasEmbeddings(projectName: string, config: PlusConfig): Promise<boolean> {
  const dbPath = projectDbPath(projectName, config);
  if (!existsSync(dbPath)) {
    return false;
  }

  return withDatabase(dbPath, (db) => {
    return queryRows<{ found: number }>(db, "SELECT 1 AS found FROM node_vectors LIMIT 1").length > 0;
  }).catch(() => false);
}

async function withDatabase<T>(dbPath: string, callback: (db: Database) => T): Promise<T> {
  const SQL = await getSql();
  const bytes = await readFile(dbPath);
  const db = new SQL.Database(bytes);

  try {
    return callback(db);
  } finally {
    db.close();
  }
}

function queryRows<T = Record<string, unknown>>(
  db: Database,
  query: string,
  params: Array<string | number> = []
): T[] {
  const statement = db.prepare(query, params);
  const rows: T[] = [];

  try {
    while (statement.step()) {
      rows.push(statement.getAsObject() as T);
    }
  } finally {
    statement.free();
  }

  return rows;
}

function getSql(): Promise<SqlJsStatic> {
  sqlPromise ??= initSqlJs({
    locateFile: (file) => join(process.cwd(), "node_modules", "sql.js", "dist", file)
  });

  return sqlPromise;
}

function projectDbPath(projectName: string, config: PlusConfig): string {
  return join(cacheDir(config), `${projectName}.db`);
}

function cacheDir(config: PlusConfig): string {
  return (
    process.env.CODEBASE_MEMORY_MCP_CACHE_DIR ??
    config.baseMcp?.cacheDir ??
    join(homedir(), ".cache", "codebase-memory-mcp")
  );
}

function parseSymbolMeta(raw: string | undefined): SymbolMeta | undefined {
  if (!raw) return undefined;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  return {
    complexity: typeof parsed.complexity === "number" ? parsed.complexity : undefined,
    cognitive: typeof parsed.cognitive === "number" ? parsed.cognitive : undefined,
    docstring: typeof parsed.docstring === "string" ? parsed.docstring : undefined,
    signature: typeof parsed.signature === "string" ? parsed.signature : undefined,
    isExported: typeof parsed.is_exported === "boolean" ? parsed.is_exported : undefined,
    isTest: typeof parsed.is_test === "boolean" ? parsed.is_test : undefined,
    isEntryPoint: typeof parsed.is_entry_point === "boolean" ? parsed.is_entry_point : undefined,
    lines: typeof parsed.lines === "number" ? parsed.lines : undefined,
    paramCount: typeof parsed.param_count === "number" ? parsed.param_count : undefined,
    paramNames: Array.isArray(parsed.param_names) ? (parsed.param_names as string[]) : undefined,
    paramTypes: Array.isArray(parsed.param_types) ? (parsed.param_types as string[]) : undefined,
    returnType: typeof parsed.return_type === "string" ? parsed.return_type : undefined,
    baseClasses: Array.isArray(parsed.base_classes) ? (parsed.base_classes as string[]) : undefined,
    loopCount: typeof parsed.loop_count === "number" ? parsed.loop_count : undefined,
    loopDepth: typeof parsed.loop_depth === "number" ? parsed.loop_depth : undefined,
    transitiveLoopDepth:
      typeof parsed.transitive_loop_depth === "number" ? parsed.transitive_loop_depth : undefined,
    linearScanInLoop:
      typeof parsed.linear_scan_in_loop === "number" ? parsed.linear_scan_in_loop : undefined,
    allocInLoop: typeof parsed.alloc_in_loop === "number" ? parsed.alloc_in_loop : undefined,
    recursionInLoop: typeof parsed.recursion_in_loop === "boolean" ? parsed.recursion_in_loop : undefined,
    unguardedRecursion:
      typeof parsed.unguarded_recursion === "boolean" ? parsed.unguarded_recursion : undefined,
    recursive: typeof parsed.recursive === "boolean" ? parsed.recursive : undefined,
    maxAccessDepth: typeof parsed.max_access_depth === "number" ? parsed.max_access_depth : undefined
  };
}

// Full directory path, all levels (not just the first segment) - e.g. "src/components/x.ts" -> "src/components".
function packageOf(filePath: string): string {
  if (!filePath) return "(root)";
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? "(root)" : filePath.slice(0, idx);
}

// Top-level segment of a package path - mirrors packageFamily() in dashboard/src/utils.js.
function familyOf(pkg: string): string {
  if (!pkg || pkg === "(root)") return "(root)";
  const idx = pkg.indexOf("/");
  return idx === -1 ? pkg : pkg.slice(0, idx);
}

function buildPackageIndex(nodes: Array<{ id: string; file_path: string }>): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of nodes) map.set(node.id, packageOf(node.file_path));
  return map;
}

function computePackageCounts(
  nodes: Array<{ file_path: string }>,
  limit: number
): Array<{ name: string; node_count: number }> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (!node.file_path) continue;
    const pkg = packageOf(node.file_path);
    counts.set(pkg, (counts.get(pkg) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, node_count]) => ({ name, node_count }))
    .sort((a, b) => b.node_count - a.node_count)
    .slice(0, limit);
}

function aggregatePackageEdges(
  edges: Array<{ source_id: string; target_id: string; type: string }>,
  packageIndex: Map<string, string>
): GraphEdge[] {
  const counts = new Map<string, GraphEdge>();
  for (const edge of edges) {
    const source = packageIndex.get(edge.source_id);
    const target = packageIndex.get(edge.target_id);
    if (!source || !target || source === target) continue;
    const key = `${source}|${target}|${edge.type}`;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { source, target, type: edge.type, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}
