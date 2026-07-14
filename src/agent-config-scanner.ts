import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import * as toml from "toml";

const execFileAsync = promisify(execFile);
const HOME = homedir();
const DISABLED_SUFFIX = ".disabled";

export type AgentConfigType = "mcp" | "skill" | "plugin";
export type AgentConfigTool = "claude" | "cursor" | "codex";
export type AgentConfigScope = "global" | "project";

export type AgentConfigEntry = {
  id: string;
  name: string;
  type: AgentConfigType;
  tool: AgentConfigTool;
  scope: AgentConfigScope;
  project_path: string | null;
  enabled: boolean;
  source_path: string;
  raw_config: Record<string, unknown>;
};

export type DuplicateGroup = {
  name: string;
  entries: AgentConfigEntry[];
};

// id round-trips (tool, type, scope, project_path, name, source_path) so toggle/delete can
// re-locate the exact live entry without re-scanning everything and fuzzy-matching by name.
function makeId(fields: Pick<AgentConfigEntry, "tool" | "type" | "scope" | "project_path" | "name" | "source_path">): string {
  return Buffer.from(
    JSON.stringify([fields.tool, fields.type, fields.scope, fields.project_path, fields.name, fields.source_path])
  ).toString("base64url");
}

export function decodeAgentConfigId(id: string): Pick<
  AgentConfigEntry,
  "tool" | "type" | "scope" | "project_path" | "name" | "source_path"
> {
  const [tool, type, scope, project_path, name, source_path] = JSON.parse(
    Buffer.from(id, "base64url").toString("utf8")
  );
  return { tool, type, scope, project_path, name, source_path };
}

function makeEntry(fields: Omit<AgentConfigEntry, "id">): AgentConfigEntry {
  return { ...fields, id: makeId(fields) };
}

function safeReadJson(path: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function safeReadToml(path: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return toml.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function listDirs(root: string): Array<{ name: string; path: string }> {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((item) => {
        if (item.isDirectory()) return true;
        // Skills are often symlinked from a canonical ~/.claude/skills copy.
        if (item.isSymbolicLink()) return statSync(join(root, item.name)).isDirectory();
        return false;
      })
      .map((item) => ({ name: item.name, path: join(root, item.name) }));
  } catch {
    return [];
  }
}

function skillFrontmatterName(skillMdPath: string, fallback: string): string {
  try {
    const raw = readFileSync(skillMdPath, "utf8");
    const frontmatter = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    const nameLine = frontmatter?.[1].match(/^name:\s*(.+)$/m);
    if (nameLine) return nameLine[1].trim().replace(/^["']|["']$/g, "");
  } catch {
    // fall through to fallback
  }
  return fallback;
}

// Skills are the one type toggled by folder rename (mySkill <-> mySkill.disabled), so
// "enabled" has to be read back off the directory name rather than any config file.
function scanSkills(
  skillsRoot: string,
  tool: AgentConfigTool,
  scope: AgentConfigScope,
  projectPath: string | null
): AgentConfigEntry[] {
  return listDirs(skillsRoot)
    .filter((dir) => existsSync(join(dir.path, "SKILL.md")))
    .map((dir) => {
      const disabled = dir.name.endsWith(DISABLED_SUFFIX);
      const skillMd = join(dir.path, "SKILL.md");
      const name = skillFrontmatterName(skillMd, disabled ? dir.name.slice(0, -DISABLED_SUFFIX.length) : dir.name);
      return makeEntry({
        name,
        type: "skill",
        tool,
        scope,
        project_path: projectPath,
        enabled: !disabled,
        source_path: dir.path,
        raw_config: { skill_md_path: skillMd }
      });
    });
}

function claudeJsonPath(): string {
  return join(HOME, ".claude.json");
}

function scanClaudeMcp(json: Record<string, unknown> | undefined, scope: AgentConfigScope, projectPath: string | null): AgentConfigEntry[] {
  const servers = (json?.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
  return Object.entries(servers).map(([name, raw]) =>
    makeEntry({
      name,
      type: "mcp",
      tool: "claude",
      scope,
      project_path: projectPath,
      enabled: true,
      source_path: claudeJsonPath(),
      raw_config: raw
    })
  );
}

function scanClaudeGlobal(): AgentConfigEntry[] {
  const entries: AgentConfigEntry[] = [];
  const claudeJson = safeReadJson(claudeJsonPath());
  entries.push(...scanClaudeMcp(claudeJson, "global", null));

  const settingsPath = join(HOME, ".claude", "settings.json");
  const settings = safeReadJson(settingsPath);
  const enabledPlugins = (settings?.enabledPlugins ?? {}) as Record<string, boolean>;

  const installedPluginsPath = join(HOME, ".claude", "plugins", "installed_plugins.json");
  const installed = safeReadJson(installedPluginsPath);
  const plugins = (installed?.plugins ?? {}) as Record<string, unknown>;
  for (const [name, raw] of Object.entries(plugins)) {
    entries.push(
      makeEntry({
        name,
        type: "plugin",
        tool: "claude",
        scope: "global",
        project_path: null,
        enabled: enabledPlugins[name] !== false,
        source_path: installedPluginsPath,
        raw_config: { installations: raw, enabled_in_settings: enabledPlugins[name] ?? null }
      })
    );
  }

  entries.push(...scanSkills(join(HOME, ".claude", "skills"), "claude", "global", null));
  return entries;
}

function scanClaudeProject(projectPath: string): AgentConfigEntry[] {
  const entries: AgentConfigEntry[] = [];
  const claudeJson = safeReadJson(claudeJsonPath());
  const projects = (claudeJson?.projects ?? {}) as Record<string, Record<string, unknown>>;
  const projectEntry = projects[projectPath];
  if (projectEntry) {
    entries.push(...scanClaudeMcp(projectEntry, "project", projectPath));
  }

  const sharedMcpPath = join(projectPath, ".mcp.json");
  const sharedMcp = safeReadJson(sharedMcpPath);
  if (sharedMcp) {
    const servers = (sharedMcp.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
    for (const [name, raw] of Object.entries(servers)) {
      entries.push(
        makeEntry({
          name,
          type: "mcp",
          tool: "claude",
          scope: "project",
          project_path: projectPath,
          enabled: true,
          source_path: sharedMcpPath,
          raw_config: raw
        })
      );
    }
  }

  const settingsPath = join(projectPath, ".claude", "settings.json");
  const settings = safeReadJson(settingsPath);
  if (settings) {
    const enabledPlugins = (settings.enabledPlugins ?? {}) as Record<string, boolean>;
    for (const [name, value] of Object.entries(enabledPlugins)) {
      entries.push(
        makeEntry({
          name,
          type: "plugin",
          tool: "claude",
          scope: "project",
          project_path: projectPath,
          enabled: value !== false,
          source_path: settingsPath,
          raw_config: { enabled: value }
        })
      );
    }
  }

  entries.push(...scanSkills(join(projectPath, ".claude", "skills"), "claude", "project", projectPath));
  return entries;
}

function scanCursorMcp(mcpJsonPath: string, scope: AgentConfigScope, projectPath: string | null): AgentConfigEntry[] {
  const json = safeReadJson(mcpJsonPath);
  const servers = (json?.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
  return Object.entries(servers).map(([name, raw]) =>
    makeEntry({
      name,
      type: "mcp",
      tool: "cursor",
      scope,
      project_path: projectPath,
      // Cursor's own mcp.json convention supports a per-server "disabled" flag.
      enabled: raw.disabled !== true,
      source_path: mcpJsonPath,
      raw_config: raw
    })
  );
}

function scanCursorGlobal(): AgentConfigEntry[] {
  const entries: AgentConfigEntry[] = [];
  entries.push(...scanCursorMcp(join(HOME, ".cursor", "mcp.json"), "global", null));
  entries.push(...scanSkills(join(HOME, ".cursor", "skills-cursor"), "cursor", "global", null));
  return entries;
}

function scanCursorProject(projectPath: string): AgentConfigEntry[] {
  const entries: AgentConfigEntry[] = [];
  entries.push(...scanCursorMcp(join(projectPath, ".cursor", "mcp.json"), "project", projectPath));
  entries.push(...scanSkills(join(projectPath, ".cursor", "skills-cursor"), "cursor", "project", projectPath));
  return entries;
}

function codexConfigPath(root = HOME): string {
  return join(root, ".codex", "config.toml");
}

function scanCodexConfig(configPath: string, scope: AgentConfigScope, projectPath: string | null): AgentConfigEntry[] {
  const entries: AgentConfigEntry[] = [];
  const parsed = safeReadToml(configPath);
  if (!parsed) return entries;

  const mcpServers = (parsed.mcp_servers ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, raw] of Object.entries(mcpServers)) {
    entries.push(
      makeEntry({
        name,
        type: "mcp",
        tool: "codex",
        scope,
        project_path: projectPath,
        enabled: raw.enabled !== false,
        source_path: configPath,
        raw_config: raw
      })
    );
  }

  const plugins = (parsed.plugins ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, raw] of Object.entries(plugins)) {
    entries.push(
      makeEntry({
        name,
        type: "plugin",
        tool: "codex",
        scope,
        project_path: projectPath,
        enabled: raw.enabled !== false,
        source_path: configPath,
        raw_config: raw
      })
    );
  }

  return entries;
}

function scanCodexGlobal(): AgentConfigEntry[] {
  const entries: AgentConfigEntry[] = [];
  entries.push(...scanCodexConfig(codexConfigPath(), "global", null));
  entries.push(...scanSkills(join(HOME, ".codex", "skills"), "codex", "global", null));
  return entries;
}

function scanCodexProject(projectPath: string): AgentConfigEntry[] {
  const entries: AgentConfigEntry[] = [];
  entries.push(...scanCodexConfig(codexConfigPath(projectPath), "project", projectPath));
  entries.push(...scanSkills(join(projectPath, ".codex", "skills"), "codex", "project", projectPath));
  return entries;
}

export type AgentConfigFilter = {
  tool?: string;
  type?: string;
  scope?: string;
  project?: string;
};

// Disabling a Claude mcp entry removes it from the live config and stashes its raw config
// here (see toggleClaudeMcpViaStash) - without surfacing those stashed entries too, a
// disabled entry would vanish from the list entirely and could never be re-enabled again.
function scanClaudeMcpStash(): AgentConfigEntry[] {
  const stash = safeReadJson(stashFilePath()) as Record<string, Record<string, unknown>> | undefined;
  if (!stash) return [];
  return Object.entries(stash).map(([id, raw_config]) => ({
    ...decodeAgentConfigId(id),
    id,
    enabled: false,
    raw_config
  }));
}

export function scanAgentConfig(projectRoots: string[], filter: AgentConfigFilter = {}): AgentConfigEntry[] {
  let entries: AgentConfigEntry[] = [
    ...scanClaudeGlobal(),
    ...scanCursorGlobal(),
    ...scanCodexGlobal(),
    ...scanClaudeMcpStash()
  ];

  for (const root of new Set(projectRoots)) {
    if (!existsSync(root)) continue;
    entries.push(...scanClaudeProject(root), ...scanCursorProject(root), ...scanCodexProject(root));
  }

  if (filter.tool) entries = entries.filter((e) => e.tool === filter.tool);
  if (filter.type) entries = entries.filter((e) => e.type === filter.type);
  if (filter.scope) entries = entries.filter((e) => e.scope === filter.scope);
  if (filter.project) entries = entries.filter((e) => e.project_path === filter.project);

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function findDuplicates(entries: AgentConfigEntry[]): DuplicateGroup[] {
  const byName = new Map<string, AgentConfigEntry[]>();
  for (const entry of entries) {
    const bucket = byName.get(entry.name) ?? [];
    bucket.push(entry);
    byName.set(entry.name, bucket);
  }
  return [...byName.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([name, group]) => ({ name, entries: group }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type MutationResult = {
  dryRun: boolean;
  applied: boolean;
  usedNativeCli: boolean;
  diff: string;
  backupPath?: string;
};

function backupDir(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(HOME, ".codebase-memory-plus", "backups", timestamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function backupFile(sourcePath: string): string {
  const dir = backupDir();
  const dest = join(dir, basename(sourcePath));
  const stat = statSync(sourcePath);
  if (stat.isDirectory()) cpSync(sourcePath, dest, { recursive: true });
  else cpSync(sourcePath, dest);
  return dest;
}

// Surgical text-level edit of one `[tableRoot.name]` (or `[tableRoot."name"]`) TOML block -
// avoids round-tripping the whole file through a generic serializer, which would reformat
// or reorder unrelated tables in a hand-maintained dotfile.
function setTomlTableEnabled(raw: string, tableRoot: string, name: string, enabled: boolean): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerPattern = new RegExp(`^\\[${tableRoot}\\.(?:"${escapedName}"|${escapedName})\\](\\s*)$`, "m");
  const headerMatch = headerPattern.exec(raw);
  if (!headerMatch) return raw;

  const headerEnd = headerMatch.index + headerMatch[0].length;
  const rest = raw.slice(headerEnd);
  const nextHeaderMatch = /^\[(?!.*\.\S*\.)/m.exec(rest) ?? /^\[/m.exec(rest);
  const blockEnd = headerEnd + (nextHeaderMatch ? nextHeaderMatch.index : rest.length);
  const block = raw.slice(headerEnd, blockEnd);

  const enabledLinePattern = /^enabled\s*=\s*(true|false)\s*\n?/m;
  let newBlock: string;
  if (enabledLinePattern.test(block)) {
    newBlock = enabled ? block.replace(enabledLinePattern, "") : block.replace(enabledLinePattern, "enabled = false\n");
  } else {
    newBlock = enabled ? block : `\nenabled = false\n${block.replace(/^\n/, "")}`;
  }

  return raw.slice(0, headerEnd) + newBlock + raw.slice(blockEnd);
}

function removeTomlTable(raw: string, tableRoot: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerPattern = new RegExp(`^\\[${tableRoot}\\.(?:"${escapedName}"|${escapedName})\\]\\s*$`, "m");
  const headerMatch = headerPattern.exec(raw);
  if (!headerMatch) return raw;

  const rest = raw.slice(headerMatch.index + headerMatch[0].length);
  const nextHeaderMatch = /^\[(?!.*\.\S*\.)/m.exec(rest) ?? /^\[/m.exec(rest);
  const blockEnd = headerMatch.index + headerMatch[0].length + (nextHeaderMatch ? nextHeaderMatch.index : rest.length);
  return raw.slice(0, headerMatch.index) + raw.slice(blockEnd);
}

async function claudePluginCli(name: string, action: "enable" | "disable"): Promise<void> {
  await execFileAsync("claude", ["plugin", action, name]);
}

export async function toggleAgentConfig(entry: AgentConfigEntry, enabled: boolean, dryRun: boolean): Promise<MutationResult> {
  if (entry.type === "skill") {
    const disabled = entry.source_path.endsWith(DISABLED_SUFFIX);
    if (disabled === !enabled) {
      return { dryRun, applied: false, usedNativeCli: false, diff: "Already in requested state" };
    }
    const target = enabled ? entry.source_path.slice(0, -DISABLED_SUFFIX.length) : `${entry.source_path}${DISABLED_SUFFIX}`;
    const diff = `rename ${entry.source_path} -> ${target}`;
    if (!dryRun) renameSync(entry.source_path, target);
    return { dryRun, applied: !dryRun, usedNativeCli: false, diff };
  }

  if (entry.type === "plugin" && entry.tool === "claude" && entry.source_path.endsWith("installed_plugins.json")) {
    const diff = `claude plugin ${enabled ? "enable" : "disable"} ${entry.name}`;
    if (!dryRun) await claudePluginCli(entry.name, enabled ? "enable" : "disable");
    return { dryRun, applied: !dryRun, usedNativeCli: true, diff };
  }

  if (entry.type === "plugin" && entry.tool === "claude") {
    // project-scoped enabledPlugins map in .claude/settings.json - no CLI for project scope.
    return mutateJsonFile(entry.source_path, dryRun, (json) => {
      const settings = json as { enabledPlugins?: Record<string, boolean> };
      settings.enabledPlugins = settings.enabledPlugins ?? {};
      settings.enabledPlugins[entry.name] = enabled;
    }, `set enabledPlugins["${entry.name}"] = ${enabled} in ${entry.source_path}`);
  }

  if ((entry.type === "mcp" || entry.type === "plugin") && entry.tool === "codex") {
    const tableRoot = entry.type === "mcp" ? "mcp_servers" : "plugins";
    return mutateTomlFile(
      entry.source_path,
      dryRun,
      (raw) => setTomlTableEnabled(raw, tableRoot, entry.name, enabled),
      `set enabled = ${enabled} on [${tableRoot}.${entry.name}] in ${entry.source_path}`
    );
  }

  if (entry.type === "mcp" && entry.tool === "cursor") {
    return mutateJsonFile(entry.source_path, dryRun, (json) => {
      const servers = (json as { mcpServers?: Record<string, Record<string, unknown>> }).mcpServers ?? {};
      if (servers[entry.name]) servers[entry.name].disabled = !enabled;
    }, `set mcpServers["${entry.name}"].disabled = ${!enabled} in ${entry.source_path}`);
  }

  if (entry.type === "mcp" && entry.tool === "claude") {
    // No native disable flag for Claude's mcpServers schema - stash the removed config in
    // a sidecar file instead of writing an unrecognized key into ~/.claude.json.
    return toggleClaudeMcpViaStash(entry, enabled, dryRun);
  }

  return { dryRun, applied: false, usedNativeCli: false, diff: "No toggle strategy for this entry type/tool combination" };
}

function stashFilePath(): string {
  return join(HOME, ".codebase-memory-plus", "disabled-mcp-stash.json");
}

async function toggleClaudeMcpViaStash(entry: AgentConfigEntry, enabled: boolean, dryRun: boolean): Promise<MutationResult> {
  const stashPath = stashFilePath();
  const stashKey = entry.id;

  if (!enabled) {
    const diff = `remove ${entry.name} from mcpServers in ${entry.source_path}, stash raw config at ${stashPath}`;
    if (dryRun) return { dryRun, applied: false, usedNativeCli: false, diff };

    mkdirSync(join(HOME, ".codebase-memory-plus"), { recursive: true });
    const stash = safeReadJson(stashPath) ?? {};
    (stash as Record<string, unknown>)[stashKey] = entry.raw_config;
    writeFileSync(stashPath, JSON.stringify(stash, null, 2));

    await mutateJsonFile(entry.source_path, false, (json) => {
      const target = resolveClaudeMcpContainer(json, entry);
      if (target) delete target[entry.name];
    }, diff);
    return { dryRun, applied: true, usedNativeCli: false, diff };
  }

  const diff = `restore ${entry.name} into mcpServers in ${entry.source_path} from stash`;
  if (dryRun) return { dryRun, applied: false, usedNativeCli: false, diff };

  const stash = (safeReadJson(stashPath) ?? {}) as Record<string, unknown>;
  const rawConfig = stash[stashKey] ?? entry.raw_config;
  await mutateJsonFile(entry.source_path, false, (json) => {
    const target = resolveClaudeMcpContainer(json, entry);
    if (target) target[entry.name] = rawConfig as Record<string, unknown>;
  }, diff);
  delete stash[stashKey];
  writeFileSync(stashPath, JSON.stringify(stash, null, 2));
  return { dryRun, applied: true, usedNativeCli: false, diff };
}

function resolveClaudeMcpContainer(json: Record<string, unknown>, entry: AgentConfigEntry): Record<string, Record<string, unknown>> | undefined {
  if (entry.source_path.endsWith(".mcp.json")) {
    const container = json as { mcpServers?: Record<string, Record<string, unknown>> };
    container.mcpServers = container.mcpServers ?? {};
    return container.mcpServers;
  }
  if (entry.scope === "global") {
    const container = json as { mcpServers?: Record<string, Record<string, unknown>> };
    container.mcpServers = container.mcpServers ?? {};
    return container.mcpServers;
  }
  const container = json as { projects?: Record<string, { mcpServers?: Record<string, Record<string, unknown>> }> };
  const project = container.projects?.[entry.project_path ?? ""];
  if (!project) return undefined;
  project.mcpServers = project.mcpServers ?? {};
  return project.mcpServers;
}

async function mutateJsonFile(
  path: string,
  dryRun: boolean,
  mutate: (json: Record<string, unknown>) => void,
  diff: string
): Promise<MutationResult> {
  if (dryRun) return { dryRun, applied: false, usedNativeCli: false, diff };
  const json = safeReadJson(path) ?? {};
  mutate(json);
  writeFileSync(path, JSON.stringify(json, null, 2));
  return { dryRun, applied: true, usedNativeCli: false, diff };
}

async function mutateTomlFile(
  path: string,
  dryRun: boolean,
  mutate: (raw: string) => string,
  diff: string
): Promise<MutationResult> {
  if (dryRun) return { dryRun, applied: false, usedNativeCli: false, diff };
  const raw = readFileSync(path, "utf8");
  writeFileSync(path, mutate(raw));
  return { dryRun, applied: true, usedNativeCli: false, diff };
}

export async function deleteAgentConfig(entry: AgentConfigEntry, dryRun: boolean): Promise<MutationResult> {
  if (entry.type === "skill") {
    const diff = `backup and remove directory ${entry.source_path}`;
    if (dryRun) return { dryRun, applied: false, usedNativeCli: false, diff };
    const backup = backupFile(entry.source_path);
    rmSync(entry.source_path, { recursive: true, force: true });
    return { dryRun, applied: true, usedNativeCli: false, diff, backupPath: backup };
  }

  if ((entry.type === "mcp" || entry.type === "plugin") && entry.tool === "codex") {
    const tableRoot = entry.type === "mcp" ? "mcp_servers" : "plugins";
    const diff = `backup ${entry.source_path} and remove [${tableRoot}.${entry.name}]`;
    if (dryRun) return { dryRun, applied: false, usedNativeCli: false, diff };
    const backup = backupFile(entry.source_path);
    const raw = readFileSync(entry.source_path, "utf8");
    writeFileSync(entry.source_path, removeTomlTable(raw, tableRoot, entry.name));
    return { dryRun, applied: true, usedNativeCli: false, diff, backupPath: backup };
  }

  if (entry.type === "plugin" && entry.tool === "claude" && entry.source_path.endsWith("installed_plugins.json")) {
    const diff = `backup ${entry.source_path} and ${join(HOME, ".claude", "settings.json")}, remove plugin ${entry.name}`;
    if (dryRun) return { dryRun, applied: false, usedNativeCli: false, diff };
    const backup = backupFile(entry.source_path);
    const settingsPath = join(HOME, ".claude", "settings.json");
    if (existsSync(settingsPath)) backupFile(settingsPath);

    const installed = safeReadJson(entry.source_path) ?? {};
    const plugins = (installed as { plugins?: Record<string, unknown> }).plugins ?? {};
    delete plugins[entry.name];
    writeFileSync(entry.source_path, JSON.stringify(installed, null, 2));

    const settings = safeReadJson(settingsPath);
    if (settings) {
      const enabledPlugins = (settings as { enabledPlugins?: Record<string, boolean> }).enabledPlugins ?? {};
      delete enabledPlugins[entry.name];
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    }
    return { dryRun, applied: true, usedNativeCli: false, diff, backupPath: backup };
  }

  if (entry.type === "plugin" && entry.tool === "claude") {
    const diff = `backup ${entry.source_path} and remove enabledPlugins["${entry.name}"]`;
    if (dryRun) return { dryRun, applied: false, usedNativeCli: false, diff };
    const backup = backupFile(entry.source_path);
    const settings = safeReadJson(entry.source_path) ?? {};
    const enabledPlugins = (settings as { enabledPlugins?: Record<string, boolean> }).enabledPlugins ?? {};
    delete enabledPlugins[entry.name];
    writeFileSync(entry.source_path, JSON.stringify(settings, null, 2));
    return { dryRun, applied: true, usedNativeCli: false, diff, backupPath: backup };
  }

  if (entry.type === "mcp" && entry.tool === "cursor") {
    const diff = `backup ${entry.source_path} and remove mcpServers["${entry.name}"]`;
    if (dryRun) return { dryRun, applied: false, usedNativeCli: false, diff };
    const backup = backupFile(entry.source_path);
    const json = safeReadJson(entry.source_path) ?? {};
    const servers = (json as { mcpServers?: Record<string, unknown> }).mcpServers ?? {};
    delete servers[entry.name];
    writeFileSync(entry.source_path, JSON.stringify(json, null, 2));
    return { dryRun, applied: true, usedNativeCli: false, diff, backupPath: backup };
  }

  if (entry.type === "mcp" && entry.tool === "claude") {
    const diff = `backup ${entry.source_path} and remove mcpServers["${entry.name}"]`;
    if (dryRun) return { dryRun, applied: false, usedNativeCli: false, diff };
    const backup = backupFile(entry.source_path);
    const json = safeReadJson(entry.source_path) ?? {};
    const target = resolveClaudeMcpContainer(json, entry);
    if (target) delete target[entry.name];
    writeFileSync(entry.source_path, JSON.stringify(json, null, 2));
    return { dryRun, applied: true, usedNativeCli: false, diff, backupPath: backup };
  }

  return { dryRun, applied: false, usedNativeCli: false, diff: "No delete strategy for this entry type/tool combination" };
}
