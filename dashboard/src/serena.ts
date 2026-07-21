import { deleteJson, getJson, postJson } from "./api.js";
import { getActiveProject } from "./main.js";
import type { SerenaLogsResponse, SerenaMemory, SerenaOverview, SerenaStatus, SerenaToolStats } from "./types.js";
import { escapeHtml, formatNumber } from "./utils.js";

function q<T extends Element>(id: string): T {
  return document.querySelector<T>(id)!;
}

type ViewMode = "cards" | "table";

const VIEW_OPTIONS: Array<{ value: ViewMode; label: string }> = [
  { value: "cards", label: "Cards" },
  { value: "table", label: "Table" }
];

const LOG_POLL_MS = 4000;

const els = {
  view: q<HTMLElement>("#serenaView"),
  homeView: q<HTMLElement>("#homeView"),
  workspaceView: q<HTMLElement>("#workspaceView"),
  originalUiView: q<HTMLElement>("#originalUiView"),
  agentConfigView: q<HTMLElement>("#agentConfigView"),
  refresh: q<HTMLButtonElement>("#serenaRefresh"),
  status: q<HTMLDivElement>("#serenaStatus"),
  overview: q<HTMLDivElement>("#serenaOverview"),
  viewMode: q<HTMLDivElement>("#serenaViewMode"),
  toolStats: q<HTMLDivElement>("#serenaToolStats"),
  logs: q<HTMLPreElement>("#serenaLogs"),
  memories: q<HTMLDivElement>("#serenaMemories"),
  memoryNew: q<HTMLButtonElement>("#serenaMemoryNew"),
  memoryEditor: q<HTMLDivElement>("#serenaMemoryEditor"),
  memoryEditorName: q<HTMLInputElement>("#serenaMemoryEditorName"),
  memoryEditorContent: q<HTMLTextAreaElement>("#serenaMemoryEditorContent"),
  memoryEditorSave: q<HTMLButtonElement>("#serenaMemoryEditorSave"),
  memoryEditorCancel: q<HTMLButtonElement>("#serenaMemoryEditorCancel")
};

const state: {
  project: string | null;
  status: SerenaStatus | null;
  overview: SerenaOverview | null;
  toolStats: SerenaToolStats["stats"];
  logs: string[];
  logMaxIdx: number;
  memories: string[];
  editingMemory: { name: string; isNew: boolean } | null;
  viewMode: ViewMode;
  loaded: boolean;
  loading: boolean;
  pollHandle: ReturnType<typeof setInterval> | null;
} = {
  project: null,
  status: null,
  overview: null,
  toolStats: {},
  logs: [],
  logMaxIdx: 0,
  memories: [],
  editingMemory: null,
  viewMode: "cards",
  loaded: false,
  loading: false,
  pollHandle: null
};

export function showSerena(): void {
  els.homeView.hidden = true;
  els.workspaceView.hidden = true;
  els.originalUiView.hidden = true;
  els.agentConfigView.hidden = true;
  els.view.hidden = false;

  const project = getActiveProject();
  if (project !== state.project) {
    state.project = project;
    state.loaded = false;
    state.logs = [];
    state.logMaxIdx = 0;
  }
  if (!state.loaded && !state.loading) void loadSerena();
  startPolling();
}

function hideSerena(): void {
  els.view.hidden = true;
  stopPolling();
}

function startPolling(): void {
  stopPolling();
  state.pollHandle = setInterval(() => {
    if (els.view.hidden || document.visibilityState !== "visible") return;
    if (state.status?.state === "connected" || state.status?.state === "connected-other-project") {
      void pollLogs();
    }
  }, LOG_POLL_MS);
}

function stopPolling(): void {
  if (state.pollHandle) {
    clearInterval(state.pollHandle);
    state.pollHandle = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || els.view.hidden) return;
  void pollLogs();
});

function query(): string {
  return `project=${encodeURIComponent(state.project ?? "")}`;
}

async function loadSerena(): Promise<void> {
  if (!state.project) return;
  state.loading = true;
  els.status.textContent = "Checking Serena…";

  try {
    const status = await getJson<SerenaStatus>(`/api/serena/status?${query()}`);
    state.status = status;
    renderStatus();

    if (status.state === "connected" || status.state === "connected-other-project") {
      const [overview, toolStats] = await Promise.all([
        getJson<SerenaOverview>(`/api/serena/overview?${query()}`),
        getJson<SerenaToolStats>(`/api/serena/tool-stats?${query()}`)
      ]);
      state.overview = overview;
      state.toolStats = toolStats.stats ?? {};
      const memoriesResponse = await getJson<{ memories: string[] }>(`/api/serena/memories?${query()}`);
      state.memories = memoriesResponse.memories;
      renderOverview();
      renderToolStats();
      renderMemories();
      await pollLogs();
    } else {
      state.overview = null;
      state.toolStats = {};
      state.memories = [];
      renderOverview();
      renderToolStats();
      renderMemories();
      els.logs.textContent = "";
    }

    state.loaded = true;
  } catch (error) {
    els.status.innerHTML = `<p class="empty is-error">${escapeHtml(
      error instanceof Error ? error.message : "Failed to reach the dashboard server."
    )}</p>`;
  } finally {
    state.loading = false;
  }
}

async function pollLogs(): Promise<void> {
  if (!state.project) return;
  try {
    const response = await getJson<SerenaLogsResponse>(`/api/serena/logs?${query()}&startIdx=${state.logMaxIdx}`);
    if (response.messages.length) {
      state.logs.push(...response.messages);
      state.logs = state.logs.slice(-500);
    }
    state.logMaxIdx = response.max_idx;
    renderLogs();
  } catch {
    // transient - the next poll tick (or manual refresh) will retry
  }
}

function renderStatus(): void {
  const status = state.status;
  if (!status) return;

  const badges: Record<SerenaStatus["state"], string> = {
    "not-configured": `<p class="empty is-error">Serena's <code>web_dashboard</code> is disabled. Set <code>web_dashboard: true</code> in <code>~/.serena/serena_config.yml</code> and restart your Serena session.</p>`,
    "not-found": `<p class="empty">No running Serena instance found for this project. Start a Serena MCP session against it, then hit Refresh.</p>`,
    "connected-other-project": `<p class="empty">Serena is running, but attached to <strong>${escapeHtml(
      status.activeProject?.name ?? "another project"
    )}</strong>, not this one.</p>`,
    connected: `<p class="empty is-success">Connected${status.port ? ` · port ${status.port}` : ""}</p>`
  };

  els.status.innerHTML = badges[status.state];

  if (status.registeredProjects?.length && status.state === "connected-other-project") {
    els.status.innerHTML += `<p class="empty">Registered with Serena: ${status.registeredProjects
      .map((p) => escapeHtml(p.name))
      .join(", ")}</p>`;
  }
}

function renderOverview(): void {
  const overview = state.overview;
  if (!overview?.active_project) {
    els.overview.innerHTML = "";
    els.overview.hidden = true;
    return;
  }

  els.overview.hidden = false;
  const project = overview.active_project;
  els.overview.innerHTML = `
    <div class="serena-overview-grid">
      <div><span class="empty">Project</span><strong>${escapeHtml(project.name ?? "—")}</strong></div>
      <div><span class="empty">Language</span><strong>${escapeHtml(project.language ?? "—")}</strong></div>
      <div><span class="empty">Path</span><strong>${escapeHtml(project.path ?? "—")}</strong></div>
      <div><span class="empty">Context</span><strong>${escapeHtml(overview.context?.name ?? "—")}</strong></div>
      <div><span class="empty">Modes</span><strong>${escapeHtml(
        (overview.modes ?? []).map((m) => m.name).join(", ") || "—"
      )}</strong></div>
      <div><span class="empty">Version</span><strong>${escapeHtml(overview.serena_version ?? "—")}</strong></div>
    </div>`;
}

function renderToolStats(): void {
  const entries = Object.entries(state.toolStats);
  if (!entries.length) {
    els.toolStats.innerHTML = `<p class="empty">No tool calls recorded yet this session.</p>`;
    return;
  }

  entries.sort(([, a], [, b]) => b.num_times_called - a.num_times_called);

  els.toolStats.innerHTML =
    state.viewMode === "table"
      ? `<table class="serena-tool-stats-table">
          <thead><tr><th>Tool</th><th>Calls</th><th>Input tokens</th><th>Output tokens</th></tr></thead>
          <tbody>${entries
            .map(
              ([name, stats]) =>
                `<tr><td>${escapeHtml(name)}</td><td>${formatNumber(stats.num_times_called)}</td><td>${formatNumber(
                  stats.input_tokens
                )}</td><td>${formatNumber(stats.output_tokens)}</td></tr>`
            )
            .join("")}</tbody>
        </table>`
      : `<div class="serena-tool-stats-cards">${entries
          .map(
            ([name, stats]) => `
          <div class="serena-tool-stats-card">
            <strong>${escapeHtml(name)}</strong>
            <span>${formatNumber(stats.num_times_called)} calls</span>
            <span>${formatNumber(stats.input_tokens)} in / ${formatNumber(stats.output_tokens)} out tokens</span>
          </div>`
          )
          .join("")}</div>`;
}

function renderLogs(): void {
  els.logs.textContent = state.logs.join("\n");
  els.logs.scrollTop = els.logs.scrollHeight;
}

function renderMemories(): void {
  if (!state.memories.length) {
    els.memories.innerHTML = `<p class="empty">No memories for this project yet.</p>`;
    return;
  }

  els.memories.innerHTML = state.memories
    .map(
      (name) => `
      <div class="serena-memory-row" data-name="${escapeHtml(name)}">
        <button type="button" class="serena-memory-name" data-action="open">${escapeHtml(name)}</button>
        <button type="button" class="serena-memory-rename" data-action="rename" title="Rename">Rename</button>
        <button type="button" class="serena-memory-delete" data-action="delete" title="Delete">Delete</button>
      </div>`
    )
    .join("");
}

function openMemoryEditor(name: string, content: string, isNew: boolean): void {
  state.editingMemory = { name, isNew };
  els.memoryEditor.hidden = false;
  els.memoryEditorName.value = name;
  els.memoryEditorName.disabled = !isNew;
  els.memoryEditorContent.value = content;
}

function closeMemoryEditor(): void {
  state.editingMemory = null;
  els.memoryEditor.hidden = true;
  els.memoryEditorName.value = "";
  els.memoryEditorContent.value = "";
}

async function openMemory(name: string): Promise<void> {
  if (!state.project) return;
  try {
    const memory = await getJson<SerenaMemory>(`/api/serena/memories/${encodeURIComponent(name)}?${query()}`);
    openMemoryEditor(name, memory.content, false);
  } catch (error) {
    els.status.innerHTML = `<p class="empty is-error">${escapeHtml(
      error instanceof Error ? error.message : "Failed to load memory."
    )}</p>`;
  }
}

async function saveMemory(): Promise<void> {
  if (!state.project || !state.editingMemory) return;
  const name = els.memoryEditorName.value.trim();
  if (!name) return;
  await postJson(`/api/serena/memories?${query()}`, { name, content: els.memoryEditorContent.value });
  closeMemoryEditor();
  await loadSerena();
}

async function deleteMemory(name: string): Promise<void> {
  if (!state.project) return;
  if (!confirm(`Delete Serena memory "${name}"?`)) return;
  await deleteJson(`/api/serena/memories/${encodeURIComponent(name)}?${query()}`);
  await loadSerena();
}

async function renameMemory(oldName: string): Promise<void> {
  if (!state.project) return;
  const newName = prompt("Rename memory to:", oldName);
  if (!newName || newName === oldName) return;
  await postJson(`/api/serena/memories/${encodeURIComponent(oldName)}/rename?${query()}`, { newName });
  await loadSerena();
}

function bindSerenaEvents(): void {
  els.refresh.addEventListener("click", () => void loadSerena());

  els.memoryNew.addEventListener("click", () => openMemoryEditor("", "", true));
  els.memoryEditorCancel.addEventListener("click", () => closeMemoryEditor());
  els.memoryEditorSave.addEventListener("click", () => void saveMemory());

  els.memories.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
    if (!button) return;
    const row = button.closest<HTMLElement>(".serena-memory-row");
    const name = row?.dataset.name;
    if (!name) return;
    if (button.dataset.action === "open") void openMemory(name);
    if (button.dataset.action === "delete") void deleteMemory(name);
    if (button.dataset.action === "rename") void renameMemory(name);
  });

  els.viewMode.innerHTML = VIEW_OPTIONS.map(
    (option) =>
      `<button type="button" class="size-toggle-btn${option.value === state.viewMode ? " is-active" : ""}" data-view="${option.value}">${option.label}</button>`
  ).join("");
  els.viewMode.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-view]");
    if (!button) return;
    state.viewMode = button.dataset.view as ViewMode;
    els.viewMode.querySelectorAll(".size-toggle-btn").forEach((btn) => btn.classList.toggle("is-active", btn === button));
    renderToolStats();
  });

  document.querySelectorAll<HTMLButtonElement>("#homeButton, #uiModePlus, #uiModeOriginal, #agentConfigButton").forEach((button) => {
    button.addEventListener("click", () => hideSerena());
  });
}

bindSerenaEvents();
