import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  BaseMemoryClient,
  parseFirstJsonObject,
  resultText,
  type IndexedProject
} from "../base-memory-client.js";
import { enrichProjectsFromCache, readArchitectureFallback } from "../cache-store.js";
import { loadConfig } from "../config.js";
import { resolveProject, type ResolvedProject } from "../project-resolver.js";

export const projectSummaryVisualSchema = {
  projectName: z
    .string()
    .optional()
    .describe("Configured or indexed project name. Optional if projectRoot is provided."),
  projectRoot: z
    .string()
    .optional()
    .describe("Absolute path to the project root. Optional if projectName is provided."),
  includeIndexing: z
    .boolean()
    .default(false)
    .describe("Run a fast index if the project is not already indexed."),
  maxSearchResults: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(15)
    .describe("Maximum enriched search results for route and entrypoint probes.")
};

type ProjectSummaryInput = {
  projectName?: string;
  projectRoot?: string;
  includeIndexing: boolean;
  maxSearchResults: number;
};

type SummaryPayload = {
  project: {
    name: string;
    root: string;
    indexed: boolean;
    nodes?: number;
    edges?: number;
  };
  architecture?: unknown;
  probes: {
    routes?: unknown;
    entrypoints?: unknown;
    tests?: unknown;
  };
  mermaid: string;
  notes: string[];
};

export async function projectSummaryVisual(
  input: ProjectSummaryInput
): Promise<CallToolResult> {
  const config = loadConfig();
  const base = new BaseMemoryClient(config);

  try {
    let indexedProjects = await enrichProjectsFromCache(await base.listProjects(), config);
    let project = resolveProject({
      projectName: input.projectName,
      projectRoot: input.projectRoot,
      indexedProjects,
      config
    });

    if (!project) {
      return textResult(
        "No indexed or configured project was found. Pass projectRoot, or add projects to ~/.codebase-memory-plus/config.json."
      );
    }

    if (!project.indexed && input.includeIndexing) {
      await base.callTool("index_repository", {
        repo_path: project.root,
        mode: "fast",
        persistence: false
      });
      indexedProjects = await enrichProjectsFromCache(await base.listProjects(), config);
      project = resolveProject({
        projectName: input.projectName,
        projectRoot: project.root,
        indexedProjects,
        config
      })!;
    }

    const architecture = project.indexed
      ? await getArchitecture(base, project, config)
      : undefined;
    const probes = project.indexed
      ? await getProjectProbes(base, project, input.maxSearchResults)
      : {};

    const payload = buildSummaryPayload(project, architecture, probes);
    const markdown = renderMarkdown(payload);

    return {
      content: [
        {
          type: "text",
          text: markdown
        }
      ],
      structuredContent: payload
    };
  } finally {
    await base.close();
  }
}

async function getArchitecture(
  base: BaseMemoryClient,
  project: ResolvedProject,
  config: ReturnType<typeof loadConfig>
): Promise<unknown> {
  const result = await base.callTool("get_architecture", {
    project: project.indexed?.name ?? project.name,
    aspects: ["packages", "dependencies", "clusters", "structure"]
  });

  const parsed = parseFirstJsonObject(result);
  if (parsed && !("error" in parsed)) {
    return parsed;
  }

  return (
    (await readArchitectureFallback(project.indexed?.name ?? project.name, config)) ??
    parsed ??
    resultText(result)
  );
}

async function getProjectProbes(
  base: BaseMemoryClient,
  project: ResolvedProject,
  maxSearchResults: number
): Promise<SummaryPayload["probes"]> {
  const projectName = project.indexed?.name ?? project.name;
  const [routes, entrypoints, tests] = await Promise.all([
    searchCode(base, projectName, "(page|layout|route)\\.(tsx|ts|jsx|js)$", maxSearchResults),
    searchCode(base, projectName, "(main|index|server|app)\\.(ts|tsx|js|jsx)$", maxSearchResults),
    searchCode(base, projectName, "\\.(test|spec)\\.(ts|tsx|js|jsx)$", maxSearchResults)
  ]);

  return {
    routes,
    entrypoints,
    tests
  };
}

async function searchCode(
  base: BaseMemoryClient,
  project: string,
  pattern: string,
  maxSearchResults: number
): Promise<unknown> {
  const result = await base.callTool("search_code", {
    project,
    pattern,
    regex: true,
    mode: "compact",
    limit: maxSearchResults
  });

  return parseFirstJsonObject(result) ?? resultText(result);
}

function buildSummaryPayload(
  project: ResolvedProject,
  architecture: unknown,
  probes: SummaryPayload["probes"]
): SummaryPayload {
  const notes: string[] = [];

  if (!project.indexed) {
    notes.push("Project is configured or requested, but not indexed yet.");
  }

  const payload: SummaryPayload = {
    project: {
      name: project.name,
      root: project.root,
      indexed: Boolean(project.indexed),
      nodes: project.indexed?.nodes,
      edges: project.indexed?.edges
    },
    architecture,
    probes,
    mermaid: "",
    notes
  };

  payload.mermaid = buildMermaid(payload);
  return payload;
}

function buildMermaid(payload: SummaryPayload): string {
  const projectLabel = escapeMermaidLabel(payload.project.name);
  const nodeCount = payload.project.nodes ?? 0;
  const edgeCount = payload.project.edges ?? 0;

  return [
    "flowchart LR",
    `  P["${projectLabel}"]`,
    `  G["Graph: ${nodeCount} nodes / ${edgeCount} edges"]`,
    '  A["Architecture"]',
    '  R["Routes probe"]',
    '  E["Entrypoints probe"]',
    '  T["Tests probe"]',
    "  P --> G",
    "  G --> A",
    "  G --> R",
    "  G --> E",
    "  G --> T"
  ].join("\n");
}

function renderMarkdown(payload: SummaryPayload): string {
  const lines = [
    `# ${payload.project.name}`,
    "",
    `Root: ${payload.project.root}`,
    `Indexed: ${payload.project.indexed ? "yes" : "no"}`,
    `Graph: ${payload.project.nodes ?? 0} nodes / ${payload.project.edges ?? 0} edges`,
    "",
    "```mermaid",
    payload.mermaid,
    "```"
  ];

  if (payload.notes.length > 0) {
    lines.push("", "Notes:", ...payload.notes.map((note) => `- ${note}`));
  }

  lines.push(
    "",
    "Structured JSON is returned in structuredContent for dashboards and follow-up tools."
  );

  return lines.join("\n");
}

function textResult(text: string): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text
      }
    ]
  };
}

function escapeMermaidLabel(value: string): string {
  return value.replace(/"/g, "'");
}
