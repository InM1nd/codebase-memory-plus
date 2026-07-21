#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

spawnDashboardIfFree();

// ponytail: probe-then-spawn has a tiny race if two sessions start in the same instant -
// acceptable for a single-user local tool, avoids a lockfile for a problem that never happens in practice.
function spawnDashboardIfFree(): void {
  const port = Number(process.env.PORT ?? 5178);
  const probe = createServer();
  probe.once("error", () => {
    // a dashboard (ours from a prior session, or someone else's on this port) is already listening
  });
  probe.once("listening", () => {
    probe.close(() => {
      const dashboardEntry = join(dirname(fileURLToPath(import.meta.url)), "dashboard-server.js");
      spawn(process.execPath, [dashboardEntry], { detached: true, stdio: "ignore" }).unref();
    });
  });
  probe.listen(port, "127.0.0.1");
}
