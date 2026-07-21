import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Serena's dashboard API (serena/dashboard.py) has no endpoint that lists running instances,
// so discovery is a bounded scan of the port range it allocates from (SerenaDashboardAPI.BASE_PORT).
// Ceiling: an instance outside this range, or one slower than PROBE_TIMEOUT_MS to answer, is invisible.
const BASE_PORT = 24282;
const PORT_RANGE = 16;
const PROBE_TIMEOUT_MS = 300;
const SERENA_CONFIG_PATH = join(homedir(), ".serena", "serena_config.yml");

export type SerenaStatusState = "not-configured" | "not-found" | "connected-other-project" | "connected";

export type SerenaStatus = {
  state: SerenaStatusState;
  port?: number;
  activeProject?: { name: string | null; path: string | null } | null;
  registeredProjects?: Array<{ name: string; path: string; is_active: boolean }>;
};

type SerenaInstance = { port: number; overview: Record<string, unknown> };

export class SerenaClient {
  private cachedPortByProject = new Map<string, number>();

  async isWebDashboardEnabled(): Promise<boolean> {
    if (!existsSync(SERENA_CONFIG_PATH)) return false;
    const raw = readFileSync(SERENA_CONFIG_PATH, "utf8");
    return /^web_dashboard:\s*true/m.test(raw);
  }

  async getStatus(projectRootPath: string): Promise<SerenaStatus> {
    if (!(await this.isWebDashboardEnabled())) {
      return { state: "not-configured" };
    }

    const instance = await this.findInstance(projectRootPath);
    if (!instance) {
      return { state: "not-found" };
    }

    const activeProject = (instance.overview.active_project ?? null) as
      | { name: string | null; path: string | null }
      | null;
    const registeredProjects = (instance.overview.registered_projects ?? []) as Array<{
      name: string;
      path: string;
      is_active: boolean;
    }>;
    const matches = activeProject?.path ? pathsMatch(activeProject.path, projectRootPath) : false;

    return {
      state: matches ? "connected" : "connected-other-project",
      port: instance.port,
      activeProject,
      registeredProjects
    };
  }

  async getOverview(projectRootPath: string): Promise<Record<string, unknown> | undefined> {
    const instance = await this.findInstance(projectRootPath);
    return instance?.overview;
  }

  async getToolStats(projectRootPath: string): Promise<Record<string, unknown> | undefined> {
    const port = await this.resolvePort(projectRootPath);
    if (!port) return undefined;
    return fetchJson(port, "/get_tool_stats");
  }

  async getLogs(
    projectRootPath: string,
    startIdx: number
  ): Promise<{ messages: string[]; max_idx: number } | undefined> {
    const port = await this.resolvePort(projectRootPath);
    if (!port) return undefined;
    return fetchJson(port, "/get_log_messages", "POST", { start_idx: startIdx });
  }

  async getMemories(projectRootPath: string): Promise<string[]> {
    const overview = await this.getOverview(projectRootPath);
    const memories = overview?.available_memories;
    return Array.isArray(memories) ? (memories as string[]) : [];
  }

  async getMemory(
    projectRootPath: string,
    name: string
  ): Promise<{ content: string; memory_name: string } | undefined> {
    const port = await this.resolvePort(projectRootPath);
    if (!port) return undefined;
    return fetchJson(port, "/get_memory", "POST", { memory_name: name });
  }

  async saveMemory(projectRootPath: string, name: string, content: string): Promise<void> {
    const port = await this.resolvePort(projectRootPath);
    if (!port) throw new Error("No Serena instance found for this project");
    await fetchJson(port, "/save_memory", "POST", { memory_name: name, content });
  }

  async deleteMemory(projectRootPath: string, name: string): Promise<void> {
    const port = await this.resolvePort(projectRootPath);
    if (!port) throw new Error("No Serena instance found for this project");
    await fetchJson(port, "/delete_memory", "POST", { memory_name: name });
  }

  async renameMemory(projectRootPath: string, oldName: string, newName: string): Promise<void> {
    const port = await this.resolvePort(projectRootPath);
    if (!port) throw new Error("No Serena instance found for this project");
    await fetchJson(port, "/rename_memory", "POST", { old_name: oldName, new_name: newName });
  }

  private async resolvePort(projectRootPath: string): Promise<number | undefined> {
    const instance = await this.findInstance(projectRootPath);
    return instance?.port;
  }

  // All active_project.path values (realpath-normalized) across every reachable Serena
  // instance - used to badge project cards without a per-project 16-port scan each.
  async getActiveProjectPaths(): Promise<string[]> {
    const instances = await this.findAliveInstances();
    const paths = instances
      .map((instance) => (instance.overview.active_project as { path: string | null } | undefined)?.path)
      .filter((path): path is string => Boolean(path));
    return [...new Set(paths.map(realpath))];
  }

  private async findInstance(projectRootPath: string): Promise<SerenaInstance | undefined> {
    const cachedPort = this.cachedPortByProject.get(projectRootPath);
    if (cachedPort) {
      const overview = await fetchJson<Record<string, unknown>>(cachedPort, "/get_config_overview").catch(
        () => undefined
      );
      if (overview) return { port: cachedPort, overview };
      this.cachedPortByProject.delete(projectRootPath);
    }

    const instances = await this.findAliveInstances();

    const match = instances.find((instance) => {
      const activeProject = instance.overview.active_project as { path: string | null } | undefined;
      return Boolean(activeProject?.path && pathsMatch(activeProject.path, projectRootPath));
    });

    if (match) {
      this.cachedPortByProject.set(projectRootPath, match.port);
      return match;
    }

    // No instance is actively on this project - fall back to any alive instance so the
    // caller can still render "connected-other-project" with its registered_projects list.
    return instances[0];
  }

  private async findAliveInstances(): Promise<SerenaInstance[]> {
    const candidatePorts = Array.from({ length: PORT_RANGE }, (_, i) => BASE_PORT + i);
    const alive = await Promise.all(
      candidatePorts.map(async (port) => {
        const ok = await probeHeartbeat(port);
        return ok ? port : undefined;
      })
    );
    const alivePorts = alive.filter((port): port is number => port !== undefined);

    const instances = await Promise.all(
      alivePorts.map(async (port) => {
        const overview = await fetchJson<Record<string, unknown>>(port, "/get_config_overview").catch(
          () => undefined
        );
        return overview ? { port, overview } : undefined;
      })
    );

    return instances.filter((instance): instance is SerenaInstance => Boolean(instance));
  }
}

function pathsMatch(a: string, b: string): boolean {
  return realpath(a) === realpath(b);
}

export function normalizeProjectPath(path: string): string {
  return realpath(path);
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

async function probeHeartbeat(port: number): Promise<boolean> {
  try {
    const result = await fetchJson<{ status: string }>(port, "/heartbeat");
    return result?.status === "alive";
  } catch {
    return false;
  }
}

// ponytail: same short timeout for every call, not just the heartbeat probe - these are all
// loopback requests to a local Flask process, so 300ms is generous; raise it if a slow call
// (e.g. a huge memory file) starts timing out in practice.
async function fetchJson<T = Record<string, unknown>>(
  port: number,
  path: string,
  method: "GET" | "POST" = "GET",
  body?: unknown
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      signal: controller.signal,
      ...(body !== undefined
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {})
    });
    if (!response.ok) throw new Error(`Serena API ${path} returned ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}
