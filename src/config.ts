import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ProjectConfig = {
  name: string;
  root: string;
};

export type PlusConfig = {
  baseMcp?: {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cacheDir?: string;
  };
  projects?: ProjectConfig[];
};

const defaultConfigPath = join(homedir(), ".codebase-memory-plus", "config.json");

export function getConfigPath(): string {
  return process.env.CODEBASE_MEMORY_PLUS_CONFIG ?? defaultConfigPath;
}

export function loadConfig(): PlusConfig {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    return {};
  }

  const raw = readFileSync(configPath, "utf8");
  return JSON.parse(raw) as PlusConfig;
}

export function getBaseMcpCommand(config: PlusConfig): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  return {
    command:
      process.env.CODEBASE_MEMORY_MCP_COMMAND ??
      config.baseMcp?.command ??
      "codebase-memory-mcp",
    args: parseArgs(process.env.CODEBASE_MEMORY_MCP_ARGS) ?? config.baseMcp?.args ?? [],
    env: {
      ...process.env,
      ...config.baseMcp?.env
    } as Record<string, string>
  };
}

function parseArgs(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  return value
    .split(" ")
    .map((arg) => arg.trim())
    .filter(Boolean);
}
