import { deleteJson, getJson, postJson } from "./api.js";
import type {
  AgentConfigDuplicatesResponse,
  AgentConfigEntry,
  AgentConfigMutationResult,
  AgentConfigResponse,
  AgentConfigTool,
  AgentConfigType
} from "./types.js";
import { escapeHtml, formatNumber, prettyPath } from "./utils.js";

function q<T extends Element>(id: string): T {
  return document.querySelector<T>(id)!;
}

const FILTER_KEY = "codebase-memory-plus:agent-config-filters";

const TYPE_LABELS: Record<AgentConfigType, string> = {
  mcp: "MCP",
  skill: "Skill",
  plugin: "Plugin"
};

// Same stroke-icon style as the existing toolbar icons (search/sort/duplicates/refresh):
// 24x24 viewBox, no inline fill/stroke - color and stroke-width come from CSS.
const TOOL_ICONS: Record<AgentConfigTool, string> = {
  claude: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l1.8 5.2L19 11l-5.2 1.8L12 18l-1.8-5.2L5 11l5.2-1.8z" /></svg>`,
  cursor: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3l14 8-6 2-2 6-6-16z" /></svg>`,
  codex: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7.79 4.5v9L12 21l-7.79-4.5v-9z" /></svg>`
};

const TYPE_ICONS: Record<AgentConfigType, string> = {
  mcp: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 2v4M15 2v4M6 8h12l-1 6a5 5 0 0 1-10 0z" /><path d="M12 18v4" /></svg>`,
  skill: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l3 3v15H6z" /><path d="M15 3v3h3" /></svg>`,
  plugin: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M12 8v8M8 12h8" /></svg>`
};

const TRASH_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>`;

const STATUS_OPTIONS = [
  { value: "", label: "All status" },
  { value: "enabled", label: "Enabled" },
  { value: "disabled", label: "Disabled" },
  { value: "mixed", label: "Mixed" }
] as const;

type StatusFilter = (typeof STATUS_OPTIONS)[number]["value"];
type SortMode = "name" | "type" | "status" | "tools" | "usage";
type StatusTone = "neutral" | "success" | "error";
type ViewMode = "cards" | "table";

type Filters = {
  tool: string;
  type: string;
  scope: string;
  status: StatusFilter;
  sort: SortMode;
  search: string;
  duplicatesOnly: boolean;
  view: ViewMode;
  includePluginSkills: boolean;
};

type PersistedFilters = Partial<Filters>;

type AgentConfigGroup = {
  key: string;
  name: string;
  type: AgentConfigType;
  entries: AgentConfigEntry[];
};

type GroupStatus = "enabled" | "disabled" | "mixed";

const DEFAULT_FILTERS: Filters = {
  tool: "",
  type: "",
  scope: "",
  status: "",
  sort: "name",
  search: "",
  duplicatesOnly: false,
  view: "cards",
  includePluginSkills: false
};

const TOOL_OPTIONS = [
  { value: "", label: "All tools" },
  { value: "claude", label: "Claude", icon: TOOL_ICONS.claude },
  { value: "cursor", label: "Cursor", icon: TOOL_ICONS.cursor },
  { value: "codex", label: "Codex", icon: TOOL_ICONS.codex }
];

const VIEW_OPTIONS: Array<{ value: ViewMode; label: string }> = [
  { value: "cards", label: "Cards" },
  { value: "table", label: "Table" }
];

const els = {
  view: q<HTMLElement>("#agentConfigView"),
  homeView: q<HTMLElement>("#homeView"),
  workspaceView: q<HTMLElement>("#workspaceView"),
  originalUiView: q<HTMLElement>("#originalUiView"),
  refresh: q<HTMLButtonElement>("#agentConfigRefresh"),
  search: q<HTMLInputElement>("#agentConfigSearch"),
  resultCount: q<HTMLParagraphElement>("#agentConfigResultCount"),
  toolFilter: q<HTMLDivElement>("#agentConfigToolFilter"),
  typeFilter: q<HTMLDivElement>("#agentConfigTypeFilter"),
  scopeFilter: q<HTMLSelectElement>("#agentConfigScopeFilter"),
  statusFilter: q<HTMLSelectElement>("#agentConfigStatusFilter"),
  sortSelect: q<HTMLSelectElement>("#agentConfigSort"),
  duplicatesOnly: q<HTMLButtonElement>("#agentConfigDuplicatesOnly"),
  includePluginSkills: q<HTMLButtonElement>("#agentConfigIncludePluginSkills"),
  viewMode: q<HTMLDivElement>("#agentConfigViewMode"),
  status: q<HTMLParagraphElement>("#agentConfigStatus"),
  stats: q<HTMLDivElement>("#agentConfigStats"),
  mcpCount: q<HTMLButtonElement>("#agentConfigMcpCount"),
  skillCount: q<HTMLButtonElement>("#agentConfigSkillCount"),
  pluginCount: q<HTMLButtonElement>("#agentConfigPluginCount"),
  mcpCountValue: q<HTMLElement>("#agentConfigMcpCountValue"),
  skillCountValue: q<HTMLElement>("#agentConfigSkillCountValue"),
  pluginCountValue: q<HTMLElement>("#agentConfigPluginCountValue"),
  cards: q<HTMLDivElement>("#agentConfigCards")
};

const state: {
  entries: AgentConfigEntry[];
  duplicateNames: Set<string>;
  filters: Filters;
  loaded: boolean;
  loading: boolean;
  statusTimer: ReturnType<typeof setTimeout> | null;
} = {
  entries: [],
  duplicateNames: new Set(),
  filters: loadPersistedFilters(),
  loaded: false,
  loading: false,
  statusTimer: null
};

function loadPersistedFilters(): Filters {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    if (!raw) return { ...DEFAULT_FILTERS };
    const parsed = JSON.parse(raw) as PersistedFilters;
    return { ...DEFAULT_FILTERS, ...parsed };
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}

function persistFilters(): void {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(state.filters));
  } catch {
    // Persistence is best-effort.
  }
}

function groupKey(entry: AgentConfigEntry): string {
  return `${entry.type}::${entry.name}`;
}

function groupEntries(entries: AgentConfigEntry[]): AgentConfigGroup[] {
  const byKey = new Map<string, AgentConfigEntry[]>();
  for (const entry of entries) {
    const key = groupKey(entry);
    const bucket = byKey.get(key) ?? [];
    bucket.push(entry);
    byKey.set(key, bucket);
  }
  return [...byKey.entries()].map(([key, group]) => ({
    key,
    name: group[0].name,
    type: group[0].type,
    entries: group.sort((a, b) => a.tool.localeCompare(b.tool) || a.scope.localeCompare(b.scope))
  }));
}

function uniqueSorted<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort();
}

function uniqueCountsByType(entries: AgentConfigEntry[]): Record<AgentConfigType, number> {
  const namesByType: Record<AgentConfigType, Set<string>> = {
    mcp: new Set(),
    skill: new Set(),
    plugin: new Set()
  };
  for (const entry of entries) namesByType[entry.type].add(entry.name);
  return { mcp: namesByType.mcp.size, skill: namesByType.skill.size, plugin: namesByType.plugin.size };
}

function typeFilterOptions(): Array<{ value: string; label: string; icon?: string }> {
  const counts = uniqueCountsByType(state.entries);
  return [
    { value: "", label: "All types" },
    { value: "mcp", label: `MCP (${formatNumber(counts.mcp)})`, icon: TYPE_ICONS.mcp },
    { value: "skill", label: `Skill (${formatNumber(counts.skill)})`, icon: TYPE_ICONS.skill },
    { value: "plugin", label: `Plugin (${formatNumber(counts.plugin)})`, icon: TYPE_ICONS.plugin }
  ];
}

function setStatus(message: string, tone: StatusTone = "neutral", autoHideMs = 0): void {
  if (state.statusTimer) {
    clearTimeout(state.statusTimer);
    state.statusTimer = null;
  }
  els.status.hidden = false;
  els.status.classList.toggle("is-error", tone === "error");
  els.status.classList.toggle("is-success", tone === "success");
  els.status.textContent = message;
  if (autoHideMs > 0) {
    state.statusTimer = setTimeout(() => {
      els.status.hidden = true;
      els.status.classList.remove("is-error", "is-success");
      state.statusTimer = null;
    }, autoHideMs);
  }
}

function hideStatus(): void {
  if (state.statusTimer) {
    clearTimeout(state.statusTimer);
    state.statusTimer = null;
  }
  els.status.hidden = true;
  els.status.classList.remove("is-error", "is-success");
}

function setLoading(loading: boolean, preserveCards = false): void {
  state.loading = loading;
  els.view.classList.toggle("is-loading", loading);
  els.refresh.classList.toggle("is-loading", loading);
  els.refresh.disabled = loading;
  if (loading && !preserveCards) {
    els.cards.innerHTML = renderSkeletonCards(6);
  }
}

function renderSkeletonCards(count: number): string {
  return `<div class="agent-config-grid">${Array.from({ length: count }, () => `<div class="skeleton-card agent-config-skeleton"></div>`).join("")}</div>`;
}

function toolPill(tool: AgentConfigTool): string {
  return `<span class="agent-config-tool-pill tool-${escapeHtml(tool)}">${TOOL_ICONS[tool]}${escapeHtml(tool)}</span>`;
}

function typeBadgeHtml(type: AgentConfigType): string {
  return `<span class="agent-config-type type-${escapeHtml(type)}">${TYPE_ICONS[type]}${escapeHtml(TYPE_LABELS[type])}</span>`;
}

function groupStatus(group: AgentConfigGroup): GroupStatus {
  const enabled = group.entries.filter((entry) => entry.enabled).length;
  if (enabled === 0) return "disabled";
  if (enabled === group.entries.length) return "enabled";
  return "mixed";
}

function statusLabel(status: GroupStatus): string {
  if (status === "enabled") return "Enabled";
  if (status === "disabled") return "Disabled";
  return "Mixed";
}

function statusRank(status: GroupStatus): number {
  if (status === "enabled") return 0;
  if (status === "mixed") return 1;
  return 2;
}

function hasActiveFilters(): boolean {
  return (
    Boolean(state.filters.tool) ||
    Boolean(state.filters.type) ||
    Boolean(state.filters.scope) ||
    Boolean(state.filters.status) ||
    Boolean(state.filters.search.trim()) ||
    state.filters.duplicatesOnly ||
    state.filters.sort !== "name" ||
    state.filters.includePluginSkills
  );
}

function isPluginOriginGroup(group: AgentConfigGroup): boolean {
  return group.type === "skill" && group.entries.every((entry) => entry.origin === "plugin");
}

function filteredAndSortedGroups(): { groups: AgentConfigGroup[]; total: number } {
  const allGroups = groupEntries(state.entries);
  const query = state.filters.search.trim().toLowerCase();
  const groups = allGroups.filter((group) => {
    const tools = new Set(group.entries.map((entry) => entry.tool));
    const scopes = new Set(group.entries.map((entry) => entry.scope));
    if (state.filters.tool && !tools.has(state.filters.tool as AgentConfigTool)) return false;
    if (state.filters.type && group.type !== state.filters.type) return false;
    if (state.filters.scope && !scopes.has(state.filters.scope as AgentConfigEntry["scope"])) return false;
    if (state.filters.duplicatesOnly && !state.duplicateNames.has(group.name)) return false;
    if (!state.filters.includePluginSkills && isPluginOriginGroup(group)) return false;
    if (state.filters.status) {
      const status = groupStatus(group);
      if (status !== state.filters.status) return false;
    }
    if (query && !group.name.toLowerCase().includes(query)) return false;
    return true;
  });

  groups.sort((a, b) => {
    if (state.filters.sort === "type") {
      return TYPE_LABELS[a.type].localeCompare(TYPE_LABELS[b.type]) || a.name.localeCompare(b.name);
    }
    if (state.filters.sort === "status") {
      return statusRank(groupStatus(a)) - statusRank(groupStatus(b)) || a.name.localeCompare(b.name);
    }
    if (state.filters.sort === "tools") {
      return b.entries.length - a.entries.length || a.name.localeCompare(b.name);
    }
    if (state.filters.sort === "usage") {
      return (groupUsage(b) ?? -1) - (groupUsage(a) ?? -1) || a.name.localeCompare(b.name);
    }
    return a.name.localeCompare(b.name) || TYPE_LABELS[a.type].localeCompare(TYPE_LABELS[b.type]);
  });

  return { groups, total: allGroups.length };
}

function locationMeta(group: AgentConfigGroup): string {
  const scopes = uniqueSorted(group.entries.map((entry) => entry.scope));
  const projects = uniqueSorted(group.entries.map((entry) => entry.project_path).filter((value): value is string => Boolean(value)));
  const scopesText = scopes.join(", ");
  if (!projects.length) return scopesText;
  const projectText = projects.map((project) => prettyPath(project)).join(", ");
  return `${scopesText} · ${projectText}`;
}

// A short, single-line label for the card/table location cell - the full scope/project
// breakdown (locationMeta above) always fits, but wraps onto multiple lines the moment a
// project path is involved, which is what made row/card heights uneven. Full detail still
// available via the title= tooltip.
function locationSummary(group: AgentConfigGroup): { short: string; full: string } {
  const full = locationMeta(group);
  const scopes = uniqueSorted(group.entries.map((entry) => entry.scope));
  const projects = uniqueSorted(group.entries.map((entry) => entry.project_path).filter((value): value is string => Boolean(value)));

  if (!projects.length) return { short: "Global", full };

  const hasGlobal = scopes.includes("global");
  if (projects.length === 1) {
    const segments = prettyPath(projects[0]).split(" / ");
    const label = segments[segments.length - 1] || projects[0];
    return { short: hasGlobal ? `Global + ${label}` : label, full };
  }
  return { short: hasGlobal ? `Global + ${projects.length}` : `${projects.length} projects`, full };
}

// Icon-only tool marks for the card meta row - just enough to see at a glance which tools a
// skill/plugin is mirrored to without expanding Details. Table view shows full icon+text
// pills instead (there's a dedicated Tools column with room for it).
function toolIconsHtml(group: AgentConfigGroup): string {
  const tools = uniqueSorted(group.entries.map((entry) => entry.tool));
  return `<span class="agent-config-tool-icons">${tools
    .map((tool) => `<span class="agent-config-tool-icon tool-${escapeHtml(tool)}" title="${escapeHtml(tool)}">${TOOL_ICONS[tool]}</span>`)
    .join("")}</span>`;
}

function groupUsage(group: AgentConfigGroup): number | undefined {
  const counts = group.entries
    .map((entry) => entry.usage_count)
    .filter((count): count is number => typeof count === "number");
  return counts.length ? Math.max(...counts) : undefined;
}

function hasHooksBadgeHtml(group: AgentConfigGroup): string {
  if (group.type !== "plugin" || !group.entries.some((entry) => entry.has_hooks)) return "";
  return `<span class="agent-config-hooks-badge" title="This plugin registers its own hooks (e.g. SessionStart) - it stays active every session regardless of the skill toggle below">hooked</span>`;
}

function usageBadgeHtml(group: AgentConfigGroup): string {
  const usage = groupUsage(group);
  if (usage === undefined) return "";
  return `<span class="agent-config-usage-badge" title="Claude-tracked invocation count">${formatNumber(usage)}&times;</span>`;
}

function formatLastUsed(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString();
}

function configPreview(entry: AgentConfigEntry): string {
  const keys = Object.keys(entry.raw_config ?? {});
  if (!keys.length) return "No extra config fields";
  if (keys.length <= 3) return keys.join(", ");
  return `${keys.slice(0, 3).join(", ")} +${keys.length - 3} more`;
}

function variantActionsHtml(entry: AgentConfigEntry): string {
  return `
    <button
      type="button"
      class="agent-config-switch ${entry.enabled ? "is-on" : ""}"
      data-toggle-id="${escapeHtml(entry.id)}"
      aria-pressed="${entry.enabled ? "true" : "false"}"
      aria-label="${entry.enabled ? "Disable" : "Enable"} ${escapeHtml(entry.name)} in ${escapeHtml(entry.tool)}"
    >
      <span class="agent-config-switch-track" aria-hidden="true">
        <span class="agent-config-switch-thumb"></span>
      </span>
    </button>
    <button
      type="button"
      class="agent-config-delete"
      data-delete-id="${escapeHtml(entry.id)}"
      aria-label="Delete ${escapeHtml(entry.name)} from ${escapeHtml(entry.tool)}"
      title="Delete"
    >
      ${TRASH_ICON}
    </button>
  `;
}

function variantHtml(entry: AgentConfigEntry): string {
  return `
    <div class="agent-config-variant" data-variant-id="${escapeHtml(entry.id)}">
      ${toolPill(entry.tool)}
      <span class="agent-config-variant-scope">${escapeHtml(entry.scope)}</span>
      ${variantActionsHtml(entry)}
    </div>
  `;
}

function detailsRowsHtml(group: AgentConfigGroup): string {
  return group.entries
    .map(
      (entry) => `
      <div class="agent-config-detail-row">
        <span class="agent-config-detail-tool">${escapeHtml(entry.tool)}</span>
        <code class="agent-config-detail-path" title="${escapeHtml(entry.source_path)}">${escapeHtml(entry.source_path)}</code>
        <button type="button" class="copy-btn" data-copy-source="${escapeHtml(entry.source_path)}">Copy</button>
        <span class="agent-config-detail-preview">${escapeHtml(configPreview(entry))}</span>
        ${
          typeof entry.usage_count === "number"
            ? `<span class="agent-config-detail-usage">used ${formatNumber(entry.usage_count)}&times;${entry.last_used_at ? ` · last ${formatLastUsed(entry.last_used_at)}` : ""}</span>`
            : ""
        }
      </div>
    `
    )
    .join("");
}

// Tool-variant toggles and the source-path details live in one collapsed-by-default panel,
// shared verbatim between the card and table views - only the wrapping element differs
// (a <div> for cards, a <tr> for table rows), located by index via [data-details-panel].
function expandPanelHtml(group: AgentConfigGroup, index: number, wrapTag: "div" | "tr" = "div"): string {
  const isMulti = group.entries.length > 1;
  const inner = `
    ${isMulti ? `<div class="agent-config-variants">${group.entries.map((entry) => variantHtml(entry)).join("")}</div>` : ""}
    <div class="agent-config-details-body">${detailsRowsHtml(group)}</div>
  `;
  if (wrapTag === "tr") {
    return `<tr class="agent-config-details-row" data-details-panel="${index}" hidden><td colspan="7">${inner}</td></tr>`;
  }
  return `<div class="agent-config-expand" data-details-panel="${index}" hidden>${inner}</div>`;
}

function detailsToggleHtml(index: number): string {
  return `
    <button type="button" class="agent-config-details-toggle" data-details-toggle="${index}" aria-expanded="false">
      <span>Details</span>
      <span class="chevron" aria-hidden="true">▾</span>
    </button>
  `;
}

function cardHtml(group: AgentConfigGroup, index: number): string {
  const status = groupStatus(group);
  const isDuplicate = state.duplicateNames.has(group.name);
  const isPlugin = isPluginOriginGroup(group);
  const isMulti = group.entries.length > 1;
  const singleEntry = isMulti ? null : group.entries[0];
  const canEnableAll = group.entries.some((entry) => !entry.enabled);
  const canDisableAll = group.entries.some((entry) => entry.enabled);

  return `
    <article class="agent-config-card ${isMulti ? "is-multi" : "is-single"}" data-group-key="${escapeHtml(group.key)}">
      <div class="agent-config-card-top">
        <div class="agent-config-card-main">
          <h3 class="agent-config-card-name" title="${escapeHtml(group.name)}">${escapeHtml(group.name)}</h3>
          <div class="agent-config-card-meta">
            ${typeBadgeHtml(group.type)}
            <span class="badge badge-${status}">${statusLabel(status)}</span>
            ${toolIconsHtml(group)}
            ${isDuplicate ? `<span class="agent-config-duplicate">dup</span>` : ""}
            ${isPlugin ? `<span class="agent-config-origin-badge">plugin</span>` : ""}
            ${hasHooksBadgeHtml(group)}
            ${usageBadgeHtml(group)}
            <span class="agent-config-card-location" title="${escapeHtml(locationSummary(group).full)}">${escapeHtml(locationSummary(group).short)}</span>
            ${detailsToggleHtml(index)}
          </div>
        </div>
        <div class="agent-config-card-actions">
          ${
            isMulti
              ? `<div class="agent-config-bulk-actions">
                   <button type="button" class="row-action" data-bulk-enabled="true" data-group-key="${escapeHtml(group.key)}" ${!canEnableAll ? "disabled" : ""}>All on</button>
                   <button type="button" class="row-action" data-bulk-enabled="false" data-group-key="${escapeHtml(group.key)}" ${!canDisableAll ? "disabled" : ""}>All off</button>
                 </div>`
              : singleEntry
                ? variantActionsHtml(singleEntry)
                : ""
          }
        </div>
      </div>
      ${expandPanelHtml(group, index, "div")}
    </article>
  `;
}

function tableRowHtml(group: AgentConfigGroup, index: number): string {
  const status = groupStatus(group);
  const isDuplicate = state.duplicateNames.has(group.name);
  const isPlugin = isPluginOriginGroup(group);
  const isMulti = group.entries.length > 1;
  const singleEntry = isMulti ? null : group.entries[0];
  const canEnableAll = group.entries.some((entry) => !entry.enabled);
  const canDisableAll = group.entries.some((entry) => entry.enabled);
  const tools = uniqueSorted(group.entries.map((entry) => entry.tool));

  const location = locationSummary(group);

  return `
    <tr class="agent-config-table-row" data-group-key="${escapeHtml(group.key)}">
      <td class="agent-config-table-name"><div class="agent-config-table-name-inner">
        <span class="agent-config-table-name-text">${escapeHtml(group.name)}</span>
        ${isDuplicate ? `<span class="agent-config-duplicate">dup</span>` : ""}
        ${isPlugin ? `<span class="agent-config-origin-badge">plugin</span>` : ""}
        ${hasHooksBadgeHtml(group)}
      </div></td>
      <td>${typeBadgeHtml(group.type)}</td>
      <td><span class="badge badge-${status}">${statusLabel(status)}</span></td>
      <td class="agent-config-table-uses">${usageBadgeHtml(group) || `<span class="agent-config-table-uses-empty">—</span>`}</td>
      <td class="agent-config-table-tools"><div class="agent-config-table-tools-inner">${tools.map((tool) => toolPill(tool)).join("")}</div></td>
      <td class="agent-config-table-location" title="${escapeHtml(location.full)}">${escapeHtml(location.short)}</td>
      <td class="agent-config-table-actions"><div class="agent-config-table-actions-inner">
        ${
          isMulti
            ? `<div class="agent-config-bulk-actions">
                 <button type="button" class="row-action" data-bulk-enabled="true" data-group-key="${escapeHtml(group.key)}" title="Enable all tools" ${!canEnableAll ? "disabled" : ""}>On</button>
                 <button type="button" class="row-action" data-bulk-enabled="false" data-group-key="${escapeHtml(group.key)}" title="Disable all tools" ${!canDisableAll ? "disabled" : ""}>Off</button>
               </div>`
            : singleEntry
              ? variantActionsHtml(singleEntry)
              : ""
        }
        ${detailsToggleHtml(index)}
      </div></td>
    </tr>
    ${expandPanelHtml(group, index, "tr")}
  `;
}

function tableHtml(groups: AgentConfigGroup[]): string {
  return `
    <table class="agent-config-table">
      <colgroup>
        <col class="agent-config-col-name" />
        <col class="agent-config-col-type" />
        <col class="agent-config-col-status" />
        <col class="agent-config-col-uses" />
        <col class="agent-config-col-tools" />
        <col class="agent-config-col-scope" />
        <col class="agent-config-col-actions" />
      </colgroup>
      <thead>
        <tr>
          <th>Name</th>
          <th>Type</th>
          <th>Status</th>
          <th>Uses</th>
          <th>Tools</th>
          <th>Scope</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>${groups.map((group, index) => tableRowHtml(group, index)).join("")}</tbody>
    </table>
  `;
}

function emptyStateHtml(): string {
  return `
    <div class="agent-config-empty-state">
      <p>No matching entries.</p>
      ${hasActiveFilters() ? `<button type="button" class="icon-button" data-clear-filters="true">Clear filters</button>` : ""}
    </div>
  `;
}

function renderResultCount(filtered: number, total: number): void {
  els.resultCount.hidden = false;
  els.resultCount.textContent = `${formatNumber(filtered)} of ${formatNumber(total)} items`;
}

function renderStats(): void {
  const counts = uniqueCountsByType(state.entries);
  const applyCount = (button: HTMLButtonElement, valueEl: HTMLElement, count: number, type: AgentConfigType) => {
    valueEl.textContent = formatNumber(count);
    button.classList.toggle("is-active", state.filters.type === type);
  };
  applyCount(els.mcpCount, els.mcpCountValue, counts.mcp, "mcp");
  applyCount(els.skillCount, els.skillCountValue, counts.skill, "skill");
  applyCount(els.pluginCount, els.pluginCountValue, counts.plugin, "plugin");
  els.stats.hidden = false;
}

function renderFilterGroup(
  container: HTMLDivElement,
  options: Array<{ value: string; label: string; icon?: string }>,
  activeValue: string,
  onSelect: (value: string) => void
): void {
  container.innerHTML = options
    .map(
      (option) =>
        `<button type="button" class="size-toggle-btn ${option.value === activeValue ? "is-active" : ""}" data-value="${escapeHtml(option.value)}">${option.icon ?? ""}${escapeHtml(option.label)}</button>`
    )
    .join("");
  container.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.addEventListener("click", () => onSelect(button.dataset.value ?? ""));
  });
}

function renderFilters(): void {
  renderFilterGroup(els.toolFilter, TOOL_OPTIONS, state.filters.tool, (value) => {
    state.filters.tool = value;
    persistFilters();
    renderFilters();
    renderCards();
  });
  renderFilterGroup(els.typeFilter, typeFilterOptions(), state.filters.type, (value) => {
    state.filters.type = value;
    persistFilters();
    renderFilters();
    renderCards();
  });
  els.scopeFilter.value = state.filters.scope;
  els.statusFilter.value = state.filters.status;
  els.duplicatesOnly.classList.toggle("is-off", !state.filters.duplicatesOnly);
  els.duplicatesOnly.classList.toggle("is-active", state.filters.duplicatesOnly);
  els.includePluginSkills.classList.toggle("is-off", !state.filters.includePluginSkills);
  els.includePluginSkills.classList.toggle("is-active", state.filters.includePluginSkills);
  els.sortSelect.value = state.filters.sort;
  renderFilterGroup(els.viewMode, VIEW_OPTIONS, state.filters.view, (value) => {
    state.filters.view = value as ViewMode;
    persistFilters();
    renderFilters();
    renderCards();
  });
}

function renderCards(): void {
  const { groups, total } = filteredAndSortedGroups();
  renderResultCount(groups.length, total);
  if (!groups.length) {
    els.cards.innerHTML = emptyStateHtml();
  } else if (state.filters.view === "table") {
    els.cards.innerHTML = tableHtml(groups);
  } else {
    els.cards.innerHTML = `<div class="agent-config-grid">${groups.map((group, index) => cardHtml(group, index)).join("")}</div>`;
  }
  renderStats();

  els.cards.querySelectorAll<HTMLButtonElement>("[data-toggle-id]").forEach((button) => {
    button.addEventListener("click", () => void toggleEntry(button.dataset.toggleId!));
  });
  els.cards.querySelectorAll<HTMLButtonElement>("[data-delete-id]").forEach((button) => {
    button.addEventListener("click", () => void deleteEntry(button.dataset.deleteId!));
  });
  els.cards.querySelectorAll<HTMLButtonElement>("[data-bulk-enabled]").forEach((button) => {
    button.addEventListener("click", () => {
      const enabled = button.dataset.bulkEnabled === "true";
      const groupKeyValue = button.dataset.groupKey;
      if (!groupKeyValue) return;
      void bulkToggle(groupKeyValue, enabled);
    });
  });
  els.cards.querySelectorAll<HTMLButtonElement>("[data-copy-source]").forEach((button) => {
    button.addEventListener("click", () => void copySourcePath(button));
  });
  els.cards.querySelectorAll<HTMLButtonElement>("[data-details-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = button.dataset.detailsToggle;
      const panel = index ? els.cards.querySelector<HTMLElement>(`[data-details-panel="${index}"]`) : null;
      if (!panel) return;
      const nextOpen = panel.hidden;
      panel.hidden = !nextOpen;
      button.classList.toggle("is-open", nextOpen);
      button.setAttribute("aria-expanded", nextOpen ? "true" : "false");
    });
  });
  els.cards.querySelectorAll<HTMLButtonElement>("[data-clear-filters]").forEach((button) => {
    button.addEventListener("click", () => clearFilters());
  });
}

function clearFilters(): void {
  state.filters = { ...DEFAULT_FILTERS };
  els.search.value = "";
  persistFilters();
  renderFilters();
  renderCards();
}

function updateEntry(id: string, patch: Partial<AgentConfigEntry>): void {
  state.entries = state.entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
}

function removeEntry(id: string): AgentConfigEntry | null {
  const found = state.entries.find((entry) => entry.id === id) ?? null;
  if (!found) return null;
  state.entries = state.entries.filter((entry) => entry.id !== id);
  return found;
}

async function toggleEntry(id: string): Promise<void> {
  const entry = state.entries.find((item) => item.id === id);
  if (!entry) return;
  const prevEnabled = entry.enabled;
  const nextEnabled = !prevEnabled;

  updateEntry(id, { enabled: nextEnabled });
  renderCards();
  setStatus(`${nextEnabled ? "Enabling" : "Disabling"} ${entry.name} in ${entry.tool}…`);

  try {
    const result = await postJson<AgentConfigMutationResult>(`/api/agent-config/${encodeURIComponent(id)}/toggle`, {
      enabled: nextEnabled
    });
    if (!result.applied) {
      updateEntry(id, { enabled: prevEnabled });
      renderCards();
      setStatus(result.diff, "error", 3500);
      return;
    }
    setStatus(`${nextEnabled ? "Enabled" : "Disabled"} ${entry.name} in ${entry.tool}.`, "success", 2200);
  } catch (error) {
    updateEntry(id, { enabled: prevEnabled });
    renderCards();
    setStatus(error instanceof Error ? error.message : "Toggle failed", "error", 3500);
  }
}

async function bulkToggle(groupKeyValue: string, enabled: boolean): Promise<void> {
  const group = groupEntries(state.entries).find((item) => item.key === groupKeyValue);
  if (!group) return;
  const targets = group.entries.filter((entry) => entry.enabled !== enabled);
  if (!targets.length) return;

  setStatus(`${enabled ? "Enabling" : "Disabling"} ${targets.length} entries…`);
  for (let index = 0; index < targets.length; index += 1) {
    const entry = targets[index];
    const prevEnabled = entry.enabled;
    updateEntry(entry.id, { enabled });
    renderCards();
    try {
      const result = await postJson<AgentConfigMutationResult>(`/api/agent-config/${encodeURIComponent(entry.id)}/toggle`, {
        enabled
      });
      if (!result.applied) {
        updateEntry(entry.id, { enabled: prevEnabled });
      }
    } catch {
      updateEntry(entry.id, { enabled: prevEnabled });
    }
    setStatus(`${enabled ? "Enable" : "Disable"} all: ${index + 1}/${targets.length}`);
  }

  renderCards();
  setStatus(`${enabled ? "Enable" : "Disable"} all finished for ${group.name}.`, "success", 2500);
}

async function deleteEntry(id: string): Promise<void> {
  const entry = state.entries.find((item) => item.id === id);
  if (!entry) return;

  const location = entry.project_path ? `${entry.scope} · ${prettyPath(entry.project_path)}` : entry.scope;
  const confirmed = window.confirm(
    `Delete "${entry.name}" (${entry.type}, ${entry.tool}, ${location})?\n\nSource: ${entry.source_path}\n\nA backup will be created first, but this removes it from ${entry.tool} until restored.`
  );
  if (!confirmed) return;

  const removed = removeEntry(id);
  if (!removed) return;
  renderCards();
  setStatus(`Deleting ${removed.name} from ${removed.tool}…`);

  try {
    const result = await deleteJson<AgentConfigMutationResult>(`/api/agent-config/${encodeURIComponent(id)}`);
    if (!result.applied) {
      state.entries.push(removed);
      renderCards();
      setStatus(result.diff, "error", 3500);
      return;
    }
    const success = result.backupPath
      ? `Deleted ${removed.name} (${removed.tool}). Backup: ${result.backupPath}`
      : `Deleted ${removed.name} (${removed.tool}).`;
    setStatus(success, "success", 3200);
  } catch (error) {
    state.entries.push(removed);
    renderCards();
    setStatus(error instanceof Error ? error.message : "Delete failed", "error", 3500);
  }
}

async function copySourcePath(button: HTMLButtonElement): Promise<void> {
  const path = button.dataset.copySource;
  if (!path) return;
  try {
    await navigator.clipboard.writeText(path);
    button.classList.add("is-copied");
    button.textContent = "Copied";
    setTimeout(() => {
      button.classList.remove("is-copied");
      button.textContent = "Copy";
    }, 1500);
  } catch {
    setStatus("Clipboard is unavailable.", "error", 2200);
  }
}

async function loadAgentConfig(force = false): Promise<void> {
  const firstLoad = !state.loaded || force;
  setLoading(true, !firstLoad);
  if (firstLoad) {
    setStatus("Loading agent config…");
  } else {
    setStatus("Refreshing agent config…");
  }

  try {
    const [configResponse, duplicatesResponse] = await Promise.all([
      getJson<AgentConfigResponse>("/api/agent-config"),
      getJson<AgentConfigDuplicatesResponse>("/api/agent-config/duplicates")
    ]);
    state.entries = configResponse.entries;
    state.duplicateNames = new Set(duplicatesResponse.duplicates.map((group) => group.name));
    state.loaded = true;
    renderFilters();
    renderCards();
    hideStatus();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Failed to load agent config.", "error");
    if (!state.loaded) els.cards.innerHTML = `<div class="agent-config-empty-state"><p class="empty is-error">Failed to load agent config.</p></div>`;
  } finally {
    setLoading(false, true);
  }
}

function onStatTypeClick(type: AgentConfigType): void {
  state.filters.type = state.filters.type === type ? "" : type;
  persistFilters();
  renderFilters();
  renderCards();
}

function bindAgentConfigEvents(): void {
  els.refresh.addEventListener("click", () => void loadAgentConfig(true));
  els.search.addEventListener("input", () => {
    state.filters.search = els.search.value;
    persistFilters();
    renderCards();
  });
  els.sortSelect.addEventListener("change", () => {
    state.filters.sort = els.sortSelect.value as SortMode;
    persistFilters();
    renderCards();
  });
  els.scopeFilter.addEventListener("change", () => {
    state.filters.scope = els.scopeFilter.value;
    persistFilters();
    renderCards();
  });
  els.statusFilter.addEventListener("change", () => {
    state.filters.status = els.statusFilter.value as StatusFilter;
    persistFilters();
    renderCards();
  });
  els.duplicatesOnly.addEventListener("click", () => {
    state.filters.duplicatesOnly = !state.filters.duplicatesOnly;
    persistFilters();
    renderFilters();
    renderCards();
  });
  els.includePluginSkills.addEventListener("click", () => {
    state.filters.includePluginSkills = !state.filters.includePluginSkills;
    persistFilters();
    renderFilters();
    renderCards();
  });
  els.mcpCount.addEventListener("click", () => onStatTypeClick("mcp"));
  els.skillCount.addEventListener("click", () => onStatTypeClick("skill"));
  els.pluginCount.addEventListener("click", () => onStatTypeClick("plugin"));

  document.addEventListener("keydown", (event) => {
    if (els.view.hidden) return;
    if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
    event.preventDefault();
    els.search.focus();
    els.search.select();
  });

  document.querySelectorAll<HTMLButtonElement>("#homeButton, #uiModePlus, #uiModeOriginal, #serenaButton").forEach((button) => {
    button.addEventListener("click", () => {
      els.view.hidden = true;
    });
  });
}

bindAgentConfigEvents();
renderFilters();
els.search.value = state.filters.search;
els.sortSelect.value = state.filters.sort;

export function showAgentConfig(): void {
  els.homeView.hidden = true;
  els.workspaceView.hidden = true;
  els.originalUiView.hidden = true;
  q<HTMLElement>("#serenaView").hidden = true;
  els.view.hidden = false;
  if (!state.loaded && !state.loading) void loadAgentConfig();
}
