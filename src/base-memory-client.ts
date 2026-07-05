import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { getBaseMcpCommand, type PlusConfig } from "./config.js";

export type IndexedProject = {
  name: string;
  root_path: string;
  nodes?: number;
  edges?: number;
  size_bytes?: number;
};

export class BaseMemoryClient {
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;

  constructor(private readonly config: PlusConfig) {}

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    await this.connect();
    return this.client!.callTool({ name, arguments: args }) as Promise<CallToolResult>;
  }

  async listProjects(): Promise<IndexedProject[]> {
    const result = await this.callTool("list_projects", {});
    const payload = parseFirstJsonObject(result);
    return Array.isArray(payload?.projects) ? (payload.projects as IndexedProject[]) : [];
  }

  async getArchitecture(
    project: string,
    aspects: string[]
  ): Promise<Record<string, unknown> | undefined> {
    const result = await this.callTool("get_architecture", { project, aspects });
    return parseFirstJsonObject(result);
  }

  async searchGraph(
    project: string,
    args: { query?: string; semantic_query?: string[]; limit?: number; label?: string }
  ): Promise<Record<string, unknown> | undefined> {
    const result = await this.callTool("search_graph", { project, ...args });
    return parseFirstJsonObject(result);
  }

  async tracePath(
    project: string,
    args: {
      function_name: string;
      mode?: string;
      direction?: string;
      depth?: number;
      risk_labels?: boolean;
      include_tests?: boolean;
    }
  ): Promise<Record<string, unknown> | undefined> {
    const result = await this.callTool("trace_path", { project, ...args });
    return parseFirstJsonObject(result);
  }

  async deleteProject(project: string): Promise<Record<string, unknown> | undefined> {
    const result = await this.callTool("delete_project", { project });
    return parseFirstJsonObject(result);
  }

  async detectChanges(project: string): Promise<Record<string, unknown> | undefined> {
    const result = await this.callTool("detect_changes", { project });
    return parseFirstJsonObject(result);
  }

  async indexStatus(project: string): Promise<Record<string, unknown> | undefined> {
    const result = await this.callTool("index_status", { project });
    return parseFirstJsonObject(result);
  }

  async getAdr(project: string): Promise<Record<string, unknown> | undefined> {
    const result = await this.callTool("manage_adr", { project, mode: "get" });
    return parseFirstJsonObject(result);
  }

  async updateAdr(project: string, content: string): Promise<Record<string, unknown> | undefined> {
    const result = await this.callTool("manage_adr", { project, mode: "update", content });
    return parseFirstJsonObject(result);
  }

  async queryGraph(
    project: string,
    query: string,
    maxRows?: number
  ): Promise<Record<string, unknown> | undefined> {
    const result = await this.callTool("query_graph", {
      project,
      query,
      ...(maxRows ? { max_rows: maxRows } : {})
    });
    return parseFirstJsonObject(result);
  }

  async runCrossRepoIntelligence(
    repoPath: string,
    targetProjects: string[]
  ): Promise<Record<string, unknown> | undefined> {
    const result = await this.callTool("index_repository", {
      repo_path: repoPath,
      mode: "cross-repo-intelligence",
      target_projects: targetProjects
    });
    return parseFirstJsonObject(result);
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
    this.transport = undefined;
  }

  private async connect(): Promise<void> {
    if (this.client) {
      return;
    }

    const base = getBaseMcpCommand(this.config);
    this.transport = new StdioClientTransport({
      command: base.command,
      args: base.args,
      env: base.env
    });

    this.client = new Client(
      {
        name: "codebase-memory-plus-bridge",
        version: "0.1.0"
      },
      {
        capabilities: {}
      }
    );

    await this.client.connect(this.transport);
  }
}

export function resultText(result: CallToolResult): string {
  return (result.content ?? [])
    .map((item) => {
      if (item.type === "text") {
        return item.text;
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function parseFirstJsonObject(result: CallToolResult): Record<string, unknown> | undefined {
  const text = resultText(result).trim();

  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
