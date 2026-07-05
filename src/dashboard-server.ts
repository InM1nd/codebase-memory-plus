#!/usr/bin/env node

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { BaseMemoryClient } from "./base-memory-client.js";
import {
  hasEmbeddings,
  listCachedProjects,
  readApiSurface,
  readArchitectureFallback,
  readConfigMap,
  readCrossRepoLinks,
  readDuplicates,
  readFileChurn,
  readPackageDetails,
  readPackageGraph,
  readPerfRisks,
  readRelatedSymbols,
  readSymbolGraph,
  searchCachedNodes
} from "./cache-store.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const port = Number(process.env.PORT ?? 5178);
const host = process.env.HOST ?? "127.0.0.1";
// Shared across requests - BaseMemoryClient.connect() no-ops once the stdio subprocess is up,
// so this avoids re-spawning codebase-memory-mcp on every MCP-backed route.
const baseClient = new BaseMemoryClient(config);
const root = join(fileURLToPath(new URL("..", import.meta.url)), "dashboard");

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(url, request, response);
      return;
    }

    await serveStatic(url.pathname, response);
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : "Unknown server error"
    });
  }
});

server.listen(port, host, () => {
  console.log(`Codebase Memory Plus dashboard: http://${host}:${port}`);
});

async function handleApi(url: URL, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (url.pathname === "/api/projects") {
    sendJson(response, 200, { projects: await listCachedProjects(config) });
    return;
  }

  const deleteMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (deleteMatch) {
    if (request.method !== "DELETE") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
    const project = decodeURIComponent(deleteMatch[1]);
    try {
      const result = await baseClient.deleteProject(project);
      if (typeof result?.error === "string") throw new Error(result.error);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendJson(response, 503, { error: `Delete unavailable: ${mcpErrorMessage(error)}` });
    }
    return;
  }

  const summaryMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/summary$/);
  if (summaryMatch) {
    const project = decodeURIComponent(summaryMatch[1]);
    const summary = await readArchitectureFallback(project, config);
    sendJson(response, summary ? 200 : 404, summary ?? { error: "Project cache not found" });
    return;
  }

  const graphMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/graph$/);
  if (graphMatch) {
    const project = decodeURIComponent(graphMatch[1]);
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam === "all" ? Number.POSITIVE_INFINITY : Number(limitParam ?? 60);
    const family = url.searchParams.get("family") ?? undefined;
    const mode = url.searchParams.get("mode") === "symbols" ? "symbols" : "packages";
    const graph =
      mode === "symbols"
        ? await readSymbolGraph(project, config, limit, family)
        : await readPackageGraph(project, config, limit, family);
    sendJson(response, graph ? 200 : 404, graph ?? { error: "Project graph not found" });
    return;
  }

  const packageMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/packages\/([^/]+)$/);
  if (packageMatch) {
    const project = decodeURIComponent(packageMatch[1]);
    const packageName = decodeURIComponent(packageMatch[2]);
    const details = await readPackageDetails(project, config, packageName);
    sendJson(response, details ? 200 : 404, details ?? { error: "Package not found" });
    return;
  }

  const apiSurfaceMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/api-surface$/);
  if (apiSurfaceMatch) {
    const project = decodeURIComponent(apiSurfaceMatch[1]);
    sendJson(response, 200, { results: await readApiSurface(project, config) });
    return;
  }

  const configMapMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/config-map$/);
  if (configMapMatch) {
    const project = decodeURIComponent(configMapMatch[1]);
    sendJson(response, 200, await readConfigMap(project, config));
    return;
  }

  const queryMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/query$/);
  if (queryMatch) {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
    const project = decodeURIComponent(queryMatch[1]);
    try {
      const body = await readJsonBody(request);
      const query = typeof body.query === "string" ? body.query : "";
      if (!query.trim()) {
        sendJson(response, 400, { error: "Missing query" });
        return;
      }
      const result = await baseClient.queryGraph(project, query);
      if (!result) throw new Error("Empty response");
      if (typeof result.error === "string") throw new Error(result.error);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 503, { error: `Query unavailable: ${mcpErrorMessage(error)}` });
    }
    return;
  }

  const adrMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/adr$/);
  if (adrMatch) {
    const project = decodeURIComponent(adrMatch[1]);
    if (request.method === "PUT") {
      try {
        const body = await readJsonBody(request);
        const content = typeof body.content === "string" ? body.content : "";
        const result = await baseClient.updateAdr(project, content);
        if (!result) throw new Error("Empty response");
        if (typeof result.error === "string") throw new Error(result.error);
        sendJson(response, 200, result);
      } catch (error) {
        sendJson(response, 503, { error: `ADR save unavailable: ${mcpErrorMessage(error)}` });
      }
      return;
    }
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
    try {
      const adr = await baseClient.getAdr(project);
      if (!adr) throw new Error("Empty response");
      if (typeof adr.error === "string") throw new Error(adr.error);
      sendJson(response, 200, adr);
    } catch (error) {
      sendJson(response, 503, { error: `ADR unavailable: ${mcpErrorMessage(error)}` });
    }
    return;
  }

  const crossRepoMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/cross-repo$/);
  if (crossRepoMatch) {
    const project = decodeURIComponent(crossRepoMatch[1]);
    if (request.method === "POST") {
      try {
        const body = await readJsonBody(request);
        const targetProjects = Array.isArray(body.targetProjects)
          ? body.targetProjects.filter((entry): entry is string => typeof entry === "string")
          : [];
        const projects = await listCachedProjects(config);
        const anchor = projects.find((entry) => entry.project === project);
        if (!anchor) throw new Error("Project not found in local cache");
        if (!targetProjects.length) throw new Error("No target projects selected");

        const summary = await baseClient.runCrossRepoIntelligence(anchor.root_path, targetProjects);
        if (!summary) throw new Error("Empty response");
        if (typeof summary.error === "string") throw new Error(summary.error);
        const links = await readCrossRepoLinks(project, config);
        sendJson(response, 200, { summary, links });
      } catch (error) {
        sendJson(response, 503, { error: `Cross-repo analysis unavailable: ${mcpErrorMessage(error)}` });
      }
      return;
    }
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
    sendJson(response, 200, { links: await readCrossRepoLinks(project, config) });
    return;
  }

  const impactMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/impact$/);
  if (impactMatch) {
    const project = decodeURIComponent(impactMatch[1]);
    try {
      const impact = await baseClient.detectChanges(project);
      if (!impact) throw new Error("Empty response");
      if (typeof impact.error === "string") throw new Error(impact.error);
      sendJson(response, 200, impact);
    } catch (error) {
      sendJson(response, 503, { error: `Impact view unavailable: ${mcpErrorMessage(error)}` });
    }
    return;
  }

  const duplicatesMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/duplicates$/);
  if (duplicatesMatch) {
    const project = decodeURIComponent(duplicatesMatch[1]);
    sendJson(response, 200, { results: await readDuplicates(project, config) });
    return;
  }

  const churnMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/churn$/);
  if (churnMatch) {
    const project = decodeURIComponent(churnMatch[1]);
    sendJson(response, 200, { results: await readFileChurn(project, config) });
    return;
  }

  const indexHealthMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/index-health$/);
  if (indexHealthMatch) {
    const project = decodeURIComponent(indexHealthMatch[1]);
    const embeddings = await hasEmbeddings(project, config);
    // index_status is an MCP call - an outage should only drop the `status` field, never
    // hide the (locally available) embeddings info.
    let status: string | undefined;
    try {
      const payload = await baseClient.indexStatus(project);
      if (payload && typeof payload.status === "string") status = payload.status;
    } catch {
      // leave status undefined
    }
    sendJson(response, 200, { hasEmbeddings: embeddings, ...(status ? { status } : {}) });
    return;
  }

  const perfRisksMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/perf-risks$/);
  if (perfRisksMatch) {
    const project = decodeURIComponent(perfRisksMatch[1]);
    sendJson(response, 200, { results: await readPerfRisks(project, config) });
    return;
  }

  const relatedMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/related$/);
  if (relatedMatch) {
    const project = decodeURIComponent(relatedMatch[1]);
    const symbol = url.searchParams.get("symbol") ?? "";
    sendJson(response, 200, { results: await readRelatedSymbols(project, config, symbol) });
    return;
  }

  const searchMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/search$/);
  if (searchMatch) {
    const project = decodeURIComponent(searchMatch[1]);
    const q = url.searchParams.get("q") ?? "";
    const label = url.searchParams.get("label") ?? undefined;
    sendJson(response, 200, await searchProject(project, q, label));
    return;
  }

  const architectureMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/architecture$/);
  if (architectureMatch) {
    const project = decodeURIComponent(architectureMatch[1]);
    try {
      const architecture = await baseClient.getArchitecture(project, [
        "clusters",
        "hotspots",
        "layers",
        "boundaries"
      ]);
      if (!architecture) throw new Error("Empty response");
      // The MCP tool reports failures (e.g. unknown project) as a 200 payload with an
      // `error` field rather than throwing - treat that the same as a thrown error.
      if (typeof architecture.error === "string") throw new Error(architecture.error);
      sendJson(response, 200, architecture);
    } catch (error) {
      sendJson(response, 503, { error: `Architecture insights unavailable: ${mcpErrorMessage(error)}` });
    }
    return;
  }

  const traceMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/trace$/);
  if (traceMatch) {
    const project = decodeURIComponent(traceMatch[1]);
    const symbol = url.searchParams.get("symbol") ?? "";
    const direction = url.searchParams.get("direction") ?? "both";
    const depth = Number(url.searchParams.get("depth") ?? 3);
    const mode = url.searchParams.get("mode") ?? "calls";
    const includeTests = url.searchParams.get("include_tests") === "true";
    if (!symbol) {
      sendJson(response, 400, { error: "Missing symbol query param" });
      return;
    }
    try {
      const trace = await baseClient.tracePath(project, {
        function_name: symbol,
        mode,
        direction,
        depth,
        risk_labels: true,
        include_tests: includeTests
      });
      if (!trace) throw new Error("Empty response");
      if (typeof trace.error === "string") throw new Error(trace.error);
      sendJson(response, 200, trace);
    } catch (error) {
      sendJson(response, 503, { error: `Trace unavailable: ${mcpErrorMessage(error)}` });
    }
    return;
  }

  sendJson(response, 404, { error: "Unknown API route" });
}

async function searchProject(project: string, q: string, label?: string): Promise<{
  results: Array<{ id: string; label: string; kind: string; file?: string; qualifiedName?: string }>;
  semantic_results?: Array<{ id: string; label: string; kind: string; file?: string; qualifiedName?: string }>;
}> {
  const trimmed = q.trim();
  if (!trimmed) {
    return { results: [] };
  }

  try {
    // Skip semantic_query entirely when this project has no embeddings (indexed in "fast"
    // mode) - the base MCP could never return anything for it, so don't make it try.
    const semanticQuery = (await hasEmbeddings(project, config)) ? tokenize(trimmed) : undefined;
    const payload = await baseClient.searchGraph(project, {
      query: trimmed,
      ...(semanticQuery?.length ? { semantic_query: semanticQuery } : {}),
      ...(label ? { label } : {}),
      limit: 30
    });
    if (!payload) throw new Error("Empty response");
    if (typeof payload.error === "string") throw new Error(payload.error);

    const results = mapSearchHits(payload.results);
    const semantic_results = mapSearchHits(payload.semantic_results);
    return semantic_results.length ? { results, semantic_results } : { results };
  } catch {
    return { results: await searchCachedNodes(project, config, trimmed, 30, label) };
  }
}

function mapSearchHits(raw: unknown): Array<{
  id: string;
  label: string;
  kind: string;
  file?: string;
  qualifiedName?: string;
}> {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const hit = item as Record<string, unknown>;
    const qualifiedName = String(hit.qualified_name ?? "");
    return {
      id: qualifiedName,
      label: String(hit.name ?? qualifiedName),
      kind: String(hit.label ?? ""),
      file: typeof hit.file_path === "string" ? hit.file_path : undefined,
      qualifiedName
    };
  });
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are",
  "this", "that", "with", "from", "by", "as", "at", "be", "it", "its", "into", "via"
]);

function tokenize(text: string): string[] {
  // Split camelCase boundaries before lowercasing (updateCloudClient -> update Cloud Client) -
  // lowercasing first would destroy the case signal search_graph's own tokenizer relies on.
  const camelSplit = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return [
    ...new Set(
      camelSplit
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 2 && !STOPWORDS.has(token))
    )
  ];
}

function mcpErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Base MCP unavailable";
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(root, safePath);

  if (!filePath.startsWith(root) || !existsSync(filePath)) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  const body = await readFile(filePath);
  response.writeHead(200, { "content-type": mimeType(filePath) });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function mimeType(filePath: string): string {
  switch (extname(filePath)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".html":
    default:
      return "text/html; charset=utf-8";
  }
}
