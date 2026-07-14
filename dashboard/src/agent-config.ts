import { deleteJson, getJson, postJson } from "./api.js";
import type { AgentConfigDuplicatesResponse, AgentConfigEntry, AgentConfigMutationResult, AgentConfigResponse } from "./types.js";
import { escapeHtml, prettyPath } from "./utils.js";

function q<T extends Element>(id: string): T {
  return document.querySelector<T>(id)!;
}

const els = {
  view: q<HTMLElement>("#agentConfigView"),
  homeView: q<HTMLElement>("#homeView"),
  workspaceView: q<HTMLElement>("#workspaceView"),
  originalUiView: q<HTMLElement>("#originalUiView"),
  refresh: q<HTMLButtonElement>("#agentConfigRefresh"),
  toolFilter: q<HTMLDivElement>("#agentConfigToolFilter"),
  typeFilter: q<HTMLDivElement>("#agentConfigTypeFilter"),
  scopeFilter: q<HTMLDivElement>("#agentConfigScopeFilter"),
  duplicatesOnly: q<HTMLButtonElement>("#agentConfigDuplicatesOnly"),
  status: q<HTMLParagraphElement>("#agentConfigStatus"),
  tableWrap: q<HTMLDivElement>("#agentConfigTableWrap"),
  tableBody: q<HTMLTableSectionElement>("#agentConfigTableBody")
};

type Filters = {
  tool: string;
  type: string;
  scope: string;
  duplicatesOnly: boolean;
};

const state: {
  entries: AgentConfigEntry[];
  duplicateNames: Set<string>;
  filters: Filters;
  loaded: boolean;
} = {
  entries: [],
  duplicateNames: new Set(),
  filters: { tool: "", type: "", scope: "", duplicatesOnly: false },
  loaded: false
};

const TOOL_OPTIONS = [
  { value: "", label: "All" },
  { value: "claude", label: "Claude" },
  { value: "cursor", label: "Cursor" },
  { value: "codex", label: "Codex" }
];

const TYPE_OPTIONS = [
  { value: "", label: "All" },
  { value: "mcp", label: "MCP" },
  { value: "skill", label: "Skill" },
  { value: "plugin", label: "Plugin" }
];

const SCOPE_OPTIONS = [
  { value: "", label: "All" },
  { value: "global", label: "Global" },
  { value: "project", label: "Project" }
];

function renderFilterGroup(
  container: HTMLDivElement,
  options: Array<{ value: string; label: string }>,
  activeValue: string,
  onSelect: (value: string) => void
): void {
  container.innerHTML = options
    .map(
      (option) =>
        `<button type="button" class="size-toggle-btn ${option.value === activeValue ? "is-active" : ""}" data-value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</button>`
    )
    .join("");
  container.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.addEventListener("click", () => onSelect(button.dataset.value ?? ""));
  });
}

function renderFilters(): void {
  renderFilterGroup(els.toolFilter, TOOL_OPTIONS, state.filters.tool, (value) => {
    state.filters.tool = value;
    renderFilters();
    renderTable();
  });
  renderFilterGroup(els.typeFilter, TYPE_OPTIONS, state.filters.type, (value) => {
    state.filters.type = value;
    renderFilters();
    renderTable();
  });
  renderFilterGroup(els.scopeFilter, SCOPE_OPTIONS, state.filters.scope, (value) => {
    state.filters.scope = value;
    renderFilters();
    renderTable();
  });
  els.duplicatesOnly.classList.toggle("is-off", !state.filters.duplicatesOnly);
}

function filteredEntries(): AgentConfigEntry[] {
  return state.entries.filter((entry) => {
    if (state.filters.tool && entry.tool !== state.filters.tool) return false;
    if (state.filters.type && entry.type !== state.filters.type) return false;
    if (state.filters.scope && entry.scope !== state.filters.scope) return false;
    if (state.filters.duplicatesOnly && !state.duplicateNames.has(entry.name)) return false;
    return true;
  });
}

function renderTable(): void {
  const entries = filteredEntries();
  els.tableBody.innerHTML = entries.length
    ? entries.map((entry) => rowHtml(entry)).join("")
    : `<tr><td colspan="7" class="empty">No matching entries.</td></tr>`;

  els.tableBody.querySelectorAll<HTMLButtonElement>("[data-toggle-id]").forEach((button) => {
    button.addEventListener("click", () => void toggleEntry(button.dataset.toggleId!));
  });
  els.tableBody.querySelectorAll<HTMLButtonElement>("[data-delete-id]").forEach((button) => {
    button.addEventListener("click", () => void deleteEntry(button.dataset.deleteId!));
  });
}

function rowHtml(entry: AgentConfigEntry): string {
  const project = entry.project_path ? escapeHtml(prettyPath(entry.project_path)) : "-";
  return `
    <tr>
      <td>${escapeHtml(entry.name)}</td>
      <td><span class="chip">${escapeHtml(entry.type)}</span></td>
      <td>${escapeHtml(entry.tool)}</td>
      <td>${escapeHtml(entry.scope)}</td>
      <td>${project}</td>
      <td>
        <span class="badge ${entry.enabled ? "badge-entry" : "badge-test"}">${entry.enabled ? "Enabled" : "Disabled"}</span>
      </td>
      <td class="agent-config-row-actions">
        <button type="button" class="row-action" data-toggle-id="${escapeHtml(entry.id)}">${entry.enabled ? "Disable" : "Enable"}</button>
        <button type="button" class="row-action" data-delete-id="${escapeHtml(entry.id)}">Delete</button>
      </td>
    </tr>
  `;
}

async function toggleEntry(id: string): Promise<void> {
  const entry = state.entries.find((item) => item.id === id);
  if (!entry) return;

  const nextEnabled = !entry.enabled;
  const confirmed = window.confirm(`${nextEnabled ? "Enable" : "Disable"} "${entry.name}" (${entry.tool}/${entry.type})?`);
  if (!confirmed) return;

  try {
    const result = await postJson<AgentConfigMutationResult>(`/api/agent-config/${encodeURIComponent(id)}/toggle`, {
      enabled: nextEnabled
    });
    if (!result.applied) {
      window.alert(`Nothing changed: ${result.diff}`);
      return;
    }
  } catch (error) {
    window.alert(error instanceof Error ? error.message : "Toggle failed");
    return;
  }

  await loadAgentConfig();
}

async function deleteEntry(id: string): Promise<void> {
  const entry = state.entries.find((item) => item.id === id);
  if (!entry) return;

  const confirmed = window.confirm(`Delete "${entry.name}" (${entry.tool}/${entry.type})? A backup will be created first.`);
  if (!confirmed) return;

  try {
    const result = await deleteJson<AgentConfigMutationResult>(`/api/agent-config/${encodeURIComponent(id)}`);
    if (result.applied) {
      window.alert(result.backupPath ? `Deleted. Backup saved at ${result.backupPath}` : "Deleted.");
    } else {
      window.alert(`Nothing changed: ${result.diff}`);
    }
  } catch (error) {
    window.alert(error instanceof Error ? error.message : "Delete failed");
    return;
  }

  await loadAgentConfig();
}

async function loadAgentConfig(): Promise<void> {
  els.status.hidden = false;
  els.status.textContent = "Loading agent config…";
  els.tableWrap.hidden = true;

  try {
    const [configResponse, duplicatesResponse] = await Promise.all([
      getJson<AgentConfigResponse>("/api/agent-config"),
      getJson<AgentConfigDuplicatesResponse>("/api/agent-config/duplicates")
    ]);
    state.entries = configResponse.entries;
    state.duplicateNames = new Set(duplicatesResponse.duplicates.map((group) => group.name));
    state.loaded = true;
    els.status.hidden = true;
    els.tableWrap.hidden = false;
    renderTable();
  } catch (error) {
    els.status.hidden = false;
    els.tableWrap.hidden = true;
    els.status.textContent = error instanceof Error ? error.message : "Failed to load agent config.";
  }
}

function bindAgentConfigEvents(): void {
  els.refresh.addEventListener("click", () => void loadAgentConfig());
  els.duplicatesOnly.addEventListener("click", () => {
    state.filters.duplicatesOnly = !state.filters.duplicatesOnly;
    renderFilters();
    renderTable();
  });

  // Additive listeners on main.ts's own nav buttons so navigating away hides this view too,
  // without needing to edit showHome()/showWorkspace() in main.ts.
  document.querySelectorAll<HTMLButtonElement>("#homeButton, #allProjectsButton, #uiModePlus, #uiModeOriginal").forEach((button) => {
    button.addEventListener("click", () => {
      els.view.hidden = true;
    });
  });
}

bindAgentConfigEvents();
renderFilters();

export function showAgentConfig(): void {
  els.homeView.hidden = true;
  els.workspaceView.hidden = true;
  els.originalUiView.hidden = true;
  els.view.hidden = false;
  if (!state.loaded) void loadAgentConfig();
}
