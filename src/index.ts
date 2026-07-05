#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  projectSummaryVisual,
  projectSummaryVisualSchema
} from "./tools/project-summary-visual.js";

const server = new McpServer({
  name: "codebase-memory-plus",
  version: "0.1.0"
});

server.registerTool(
  "project_summary_visual",
  {
    title: "Project Summary Visual",
    description:
      "Build a visual, dashboard-friendly overview of an indexed codebase-memory-mcp project.",
    inputSchema: projectSummaryVisualSchema
  },
  projectSummaryVisual
);

const transport = new StdioServerTransport();
await server.connect(transport);
