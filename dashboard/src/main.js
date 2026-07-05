import { ApiError, deleteJson, getJson, postJson, putJson } from "./api.js";
import { PackageGraph } from "./graph.js";
import { loadPrefs, savePrefs } from "./storage.js";
import { debounce, edgeKey, escapeHtml, formatNumber, packageFromFile, prettyName, truncate } from "./utils.js";

const state = {
  projects: [],
  projectSort: "size",
  graphMode: "packages",
  activeProject: null,
  summary: null,
  graph: { nodes: [], edges: [] },
  selectedNode: null,
  selectedEdge: null,
  packageDetails: null,
  hiddenEdgeTypes: new Set(),
  minWeight: 1,
  isolate: false,
  architecture: null,
  apiSurface: null,
  configMap: null,
  churn: null,
  perf: null,
  duplicates: null,
  impact: null,
  crossRepoProjects: null,
  trace: { symbol: null, label: null, mode: "calls", direction: "both", depth: 3, includeTests: false }
};

const els = {
  homeView: document.querySelector("#homeView"),
  workspaceView: document.querySelector("#workspaceView"),
  projectGrid: document.querySelector("#projectGrid"),
  projectSearch: document.querySelector("#projectSearch"),
  projectSort: document.querySelector("#projectSort"),
  recentProjects: document.querySelector("#recentProjects"),
  recentProjectsGrid: document.querySelector("#recentProjectsGrid"),
  homeButton: document.querySelector("#homeButton"),
  allProjectsButton: document.querySelector("#allProjectsButton"),
  projectTitle: document.querySelector("#projectTitle"),
  breadcrumb: document.querySelector("#breadcrumb"),
  breadcrumbProject: document.querySelector("#breadcrumbProject"),
  breadcrumbPackage: document.querySelector("#breadcrumbPackage"),
  breadcrumbClear: document.querySelector("#breadcrumbClear"),
  nodesMetric: document.querySelector("#nodesMetric"),
  edgesMetric: document.querySelector("#edgesMetric"),
  packagesMetric: document.querySelector("#packagesMetric"),
  topPackageMetric: document.querySelector("#topPackageMetric"),
  indexHealth: document.querySelector("#indexHealth"),
  labelBars: document.querySelector("#labelBars"),
  graphCanvas: document.querySelector("#graph"),
  graphModePackages: document.querySelector("#graphModePackages"),
  graphModeSymbols: document.querySelector("#graphModeSymbols"),
  layoutMode: document.querySelector("#layoutMode"),
  graphFamily: document.querySelector("#graphFamily"),
  graphLimit: document.querySelector("#graphLimit"),
  graphTooltip: document.querySelector("#graphTooltip"),
  graphStatus: document.querySelector("#graphStatus"),
  graphStatusMessage: document.querySelector("#graphStatusMessage"),
  graphRetry: document.querySelector("#graphRetry"),
  edgeTypeFilters: document.querySelector("#edgeTypeFilters"),
  sizeByCount: document.querySelector("#sizeByCount"),
  sizeByDegree: document.querySelector("#sizeByDegree"),
  isolateButton: document.querySelector("#isolateButton"),
  minWeight: document.querySelector("#minWeight"),
  minWeightValue: document.querySelector("#minWeightValue"),
  relationsTitle: document.querySelector("#relationsTitle"),
  edgeList: document.querySelector("#edgeList"),
  relationCount: document.querySelector("#relationCount"),
  detailTitle: document.querySelector("#detailTitle"),
  detailSubtitle: document.querySelector("#detailSubtitle"),
  detailsTabSelection: document.querySelector("#detailsTabSelection"),
  detailsTabInsights: document.querySelector("#detailsTabInsights"),
  selectionTabPanel: document.querySelector("#selectionTabPanel"),
  insightsTabPanel: document.querySelector("#insightsTabPanel"),
  compositionToggle: document.querySelector("#compositionToggle"),
  compositionPanel: document.querySelector("#compositionPanel"),
  architectureToggle: document.querySelector("#architectureToggle"),
  architecturePanel: document.querySelector("#architecturePanel"),
  architectureStatus: document.querySelector("#architectureStatus"),
  architectureBody: document.querySelector("#architectureBody"),
  archLayers: document.querySelector("#archLayers"),
  archHotspots: document.querySelector("#archHotspots"),
  archBoundaries: document.querySelector("#archBoundaries"),
  archClusters: document.querySelector("#archClusters"),
  apiSurfaceStatus: document.querySelector("#apiSurfaceStatus"),
  apiSurface: document.querySelector("#apiSurface"),
  configMapStatus: document.querySelector("#configMapStatus"),
  configMap: document.querySelector("#configMap"),
  churnStatus: document.querySelector("#churnStatus"),
  churnList: document.querySelector("#churnList"),
  perfToggle: document.querySelector("#perfToggle"),
  perfPanel: document.querySelector("#perfPanel"),
  perfStatus: document.querySelector("#perfStatus"),
  perfList: document.querySelector("#perfList"),
  duplicatesToggle: document.querySelector("#duplicatesToggle"),
  duplicatesPanel: document.querySelector("#duplicatesPanel"),
  duplicatesStatus: document.querySelector("#duplicatesStatus"),
  duplicatesList: document.querySelector("#duplicatesList"),
  impactToggle: document.querySelector("#impactToggle"),
  impactPanel: document.querySelector("#impactPanel"),
  impactStatus: document.querySelector("#impactStatus"),
  impactBody: document.querySelector("#impactBody"),
  impactFiles: document.querySelector("#impactFiles"),
  impactSymbols: document.querySelector("#impactSymbols"),
  crossRepoToggle: document.querySelector("#crossRepoToggle"),
  crossRepoPanel: document.querySelector("#crossRepoPanel"),
  crossRepoProjects: document.querySelector("#crossRepoProjects"),
  crossRepoRun: document.querySelector("#crossRepoRun"),
  crossRepoStatus: document.querySelector("#crossRepoStatus"),
  crossRepoList: document.querySelector("#crossRepoList"),
  packageSymbols: document.querySelector("#packageSymbols"),
  headerSearch: document.querySelector("#headerSearch"),
  searchLabelFilter: document.querySelector("#searchLabelFilter"),
  globalSymbolSearch: document.querySelector("#globalSymbolSearch"),
  globalSearchResults: document.querySelector("#globalSearchResults"),
  refreshButton: document.querySelector("#refreshButton"),
  fitButton: document.querySelector("#fitButton"),
  shortcutsHelp: document.querySelector("#shortcutsHelp"),
  shortcutsButton: document.querySelector("#shortcutsButton"),
  shortcutsClose: document.querySelector("#shortcutsClose"),
  adrButton: document.querySelector("#adrButton"),
  adrDialog: document.querySelector("#adrDialog"),
  adrHint: document.querySelector("#adrHint"),
  adrTextarea: document.querySelector("#adrTextarea"),
  adrSave: document.querySelector("#adrSave"),
  adrSaveStatus: document.querySelector("#adrSaveStatus"),
  adrClose: document.querySelector("#adrClose"),
  queryButton: document.querySelector("#queryButton"),
  queryDialog: document.querySelector("#queryDialog"),
  queryTextarea: document.querySelector("#queryTextarea"),
  queryRun: document.querySelector("#queryRun"),
  queryStatus: document.querySelector("#queryStatus"),
  queryResults: document.querySelector("#queryResults"),
  queryClose: document.querySelector("#queryClose"),
  traceDialog: document.querySelector("#traceDialog"),
  traceTitle: document.querySelector("#traceTitle"),
  traceBody: document.querySelector("#traceBody"),
  traceClose: document.querySelector("#traceClose"),
  traceDirection: document.querySelector("#traceDirection"),
  traceDepth: document.querySelector("#traceDepth"),
  traceIncludeTests: document.querySelector("#traceIncludeTests")
};

const graph = new PackageGraph(els.graphCanvas, {
  onSelectNode: (node) => {
    state.selectedNode = node;
    state.selectedEdge = null;
    renderRelations();
    renderBreadcrumb();
    void selectGraphNode(node);
  },
  onSelectEdge: (edge) => {
    state.selectedEdge = edge;
    const node = state.graph.nodes.find((candidate) => candidate.id === edgeSourceId(edge));
    if (node) {
      state.selectedNode = node;
      void selectGraphNode(node);
    }
    renderRelations();
    renderBreadcrumb();
  },
  onHoverNode: (node, pos) => showTooltip(node, pos),
  onBackgroundClick: () => clearSelection()
});

function clearSelection() {
  state.selectedNode = null;
  state.selectedEdge = null;
  graph.clearSelection();
  renderRelations();
  renderEmptyInspector();
  renderBreadcrumb();
}

function renderBreadcrumb() {
  const has = Boolean(state.selectedNode);
  els.breadcrumb.hidden = !has;
  if (!has) return;
  els.breadcrumbProject.textContent = prettyName(state.activeProject ?? "");
  els.breadcrumbPackage.textContent = state.selectedNode.label;
}

await boot();

async function boot() {
  bindEvents();
  const prefs = loadPrefs();
  if (prefs.sizeBy === "degree") setSizeMode("degree");
  if (prefs.layoutMode && prefs.layoutMode !== "clustered") {
    els.layoutMode.value = prefs.layoutMode;
    graph.setLayoutMode(prefs.layoutMode);
  }
  state.projectSort = prefs.projectSort;
  els.projectSort.value = prefs.projectSort;
  if (prefs.graphMode === "symbols") applyGraphMode("symbols");
  await loadProjects();
}

function bindEvents() {
  els.projectSearch.addEventListener("input", renderProjectGrid);
  els.projectSort.addEventListener("change", () => {
    state.projectSort = els.projectSort.value;
    savePrefs({ projectSort: state.projectSort });
    renderProjectGrid();
  });
  els.homeButton.addEventListener("click", () => showHome());
  els.allProjectsButton.addEventListener("click", () => showHome());
  els.graphModePackages.addEventListener("click", () => setGraphMode("packages"));
  els.graphModeSymbols.addEventListener("click", () => setGraphMode("symbols"));
  els.layoutMode.addEventListener("change", () => {
    graph.setLayoutMode(els.layoutMode.value);
    savePrefs({ layoutMode: els.layoutMode.value });
  });
  els.graphLimit.addEventListener("change", () => {
    savePrefs({ graphLimit: els.graphLimit.value });
    void loadGraph();
  });
  els.graphFamily.addEventListener("change", () => {
    els.graphLimit.disabled = Boolean(els.graphFamily.value);
    void loadGraph();
  });
  els.refreshButton.addEventListener("click", () => loadActiveProject());
  els.fitButton.addEventListener("click", () => graph.fit());
  els.isolateButton.addEventListener("click", () => toggleIsolate());
  els.sizeByCount.addEventListener("click", () => setSizeMode("count"));
  els.sizeByDegree.addEventListener("click", () => setSizeMode("degree"));
  els.graphRetry.addEventListener("click", () => loadActiveProject());
  els.minWeight.addEventListener("input", () => {
    state.minWeight = Number(els.minWeight.value);
    els.minWeightValue.textContent = String(state.minWeight);
    graph.setFilters({ minWeight: state.minWeight });
    savePrefs({ minWeight: state.minWeight });
    renderRelations();
  });
  els.globalSymbolSearch.addEventListener("input", debounce(searchSymbols, 180));
  els.globalSymbolSearch.addEventListener("focus", () => void searchSymbols());
  els.searchLabelFilter.addEventListener("change", () => void searchSymbols());
  document.addEventListener("mousedown", (event) => {
    if (!els.headerSearch.contains(event.target)) showSearchResults(false);
  });
  els.breadcrumbClear.addEventListener("click", () => clearSelection());
  els.detailsTabSelection.addEventListener("click", () => setDetailsTab("selection"));
  els.detailsTabInsights.addEventListener("click", () => setDetailsTab("insights"));
  els.compositionToggle.addEventListener("click", () => toggleInsightPanel("composition"));
  els.architectureToggle.addEventListener("click", () =>
    toggleInsightPanel("architecture", () => {
      // Each fetched independently - a down MCP only blanks get_architecture's own section,
      // API surface / Config are pure local cache and keep working regardless.
      if (!state.architecture) void loadArchitecture();
      if (!state.apiSurface) void loadApiSurface();
      if (!state.configMap) void loadConfigMap();
      if (!state.churn) void loadChurn();
    })
  );
  els.perfToggle.addEventListener("click", () =>
    toggleInsightPanel("perf", () => {
      if (!state.perf) void loadPerfRisks();
    })
  );
  els.duplicatesToggle.addEventListener("click", () =>
    toggleInsightPanel("duplicates", () => {
      if (!state.duplicates) void loadDuplicates();
    })
  );
  els.impactToggle.addEventListener("click", () =>
    toggleInsightPanel("impact", () => {
      if (!state.impact) void loadImpact();
    })
  );
  els.crossRepoToggle.addEventListener("click", () =>
    toggleInsightPanel("crossRepo", () => {
      if (!state.crossRepoProjects) void loadCrossRepoProjectList();
    })
  );
  els.crossRepoRun.addEventListener("click", () => void runCrossRepo());
  els.adrButton.addEventListener("click", () => openAdr());
  els.adrClose.addEventListener("click", () => toggleAdr(false));
  els.adrDialog.addEventListener("click", (event) => {
    if (event.target === els.adrDialog) toggleAdr(false);
  });
  els.adrSave.addEventListener("click", () => void saveAdr());
  els.queryButton.addEventListener("click", () => toggleQuery(true));
  els.queryClose.addEventListener("click", () => toggleQuery(false));
  els.queryDialog.addEventListener("click", (event) => {
    if (event.target === els.queryDialog) toggleQuery(false);
  });
  els.queryRun.addEventListener("click", () => void runQuery());
  els.traceClose.addEventListener("click", () => toggleTrace(false));
  els.traceDialog.addEventListener("click", (event) => {
    if (event.target === els.traceDialog) toggleTrace(false);
  });
  els.traceDialog.querySelectorAll("[data-trace-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!state.trace.symbol) return;
      state.trace.mode = button.dataset.traceMode;
      setTraceModeButtons(state.trace.mode);
      void fetchTrace();
    });
  });
  els.traceDirection.addEventListener("change", () => {
    if (!state.trace.symbol) return;
    state.trace.direction = els.traceDirection.value;
    void fetchTrace();
  });
  els.traceDepth.addEventListener("change", () => {
    if (!state.trace.symbol) return;
    state.trace.depth = Number(els.traceDepth.value);
    void fetchTrace();
  });
  els.traceIncludeTests.addEventListener("change", () => {
    if (!state.trace.symbol) return;
    state.trace.includeTests = els.traceIncludeTests.checked;
    void fetchTrace();
  });
  els.shortcutsButton.addEventListener("click", () => toggleShortcuts(true));
  els.shortcutsClose.addEventListener("click", () => toggleShortcuts(false));
  els.shortcutsHelp.addEventListener("click", (event) => {
    if (event.target === els.shortcutsHelp) toggleShortcuts(false);
  });
  window.addEventListener("keydown", handleGlobalKeydown);
}

function showSearchResults(show) {
  els.globalSearchResults.hidden = !show;
}

function toggleShortcuts(show) {
  els.shortcutsHelp.hidden = !show;
}

function toggleTrace(show) {
  els.traceDialog.hidden = !show;
}

async function openTrace(symbol, label) {
  if (!state.activeProject || !symbol) return;

  state.trace = { symbol, label, mode: "calls", direction: "both", depth: 3, includeTests: false };
  setTraceModeButtons("calls");
  els.traceDirection.value = "both";
  els.traceDepth.value = "3";
  els.traceIncludeTests.checked = false;
  els.traceTitle.textContent = label ? `Trace · ${label}` : "Trace";
  toggleTrace(true);
  await fetchTrace();
}

function setTraceModeButtons(mode) {
  els.traceDialog.querySelectorAll("[data-trace-mode]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.traceMode === mode);
  });
}

async function fetchTrace() {
  const { symbol, mode, direction, depth, includeTests } = state.trace;
  els.traceBody.innerHTML = `<p class="empty">Loading trace…</p>`;

  try {
    const params = new URLSearchParams({
      symbol,
      mode,
      direction,
      depth: String(depth),
      include_tests: String(includeTests)
    });
    const data = await getJson(
      `/api/projects/${encodeURIComponent(state.activeProject)}/trace?${params}`
    );
    renderTrace(data);
  } catch (error) {
    els.traceBody.innerHTML = `<p class="empty is-error">${escapeHtml(errorMessage(error))}</p>`;
  }
}

function renderTrace(data) {
  const callers = Array.isArray(data.callers) ? data.callers : [];
  const callees = Array.isArray(data.callees) ? data.callees : [];

  const renderHops = (rows) =>
    rows.length
      ? rows
          .map(
            (row) => `
    <div class="trace-row">
      <span class="risk-chip risk-${escapeHtml(String(row.risk ?? "").toLowerCase())}">${escapeHtml(row.risk ?? "?")}</span>
      <span class="trace-name" title="${escapeHtml(row.qualified_name ?? "")}">${escapeHtml(row.name)}</span>
      <span class="trace-hop">hop ${formatNumber(row.hop ?? 0)}</span>
    </div>
  `
          )
          .join("")
      : `<p class="empty">None found.</p>`;

  els.traceBody.innerHTML = `
    <div class="trace-col">
      <h4>Callers</h4>
      <div class="trace-list">${renderHops(callers)}</div>
    </div>
    <div class="trace-col">
      <h4>Callees</h4>
      <div class="trace-list">${renderHops(callees)}</div>
    </div>
  `;
}

const INSIGHT_PANEL_KEYS = ["composition", "architecture", "perf", "duplicates", "impact", "crossRepo"];

function setDetailsTab(tab) {
  const isSelection = tab === "selection";
  els.detailsTabSelection.classList.toggle("is-active", isSelection);
  els.detailsTabSelection.setAttribute("aria-selected", String(isSelection));
  els.detailsTabInsights.classList.toggle("is-active", !isSelection);
  els.detailsTabInsights.setAttribute("aria-selected", String(!isSelection));
  els.selectionTabPanel.hidden = !isSelection;
  els.insightsTabPanel.hidden = isSelection;
}

function closeInsightPanel(key) {
  els[`${key}Panel`].hidden = true;
  els[`${key}Toggle`].classList.remove("is-open");
  els[`${key}Toggle`].setAttribute("aria-expanded", "false");
}

function openInsightPanel(key) {
  INSIGHT_PANEL_KEYS.filter((other) => other !== key).forEach(closeInsightPanel);
  els[`${key}Panel`].hidden = false;
  els[`${key}Toggle`].classList.add("is-open");
  els[`${key}Toggle`].setAttribute("aria-expanded", "true");
}

function toggleInsightPanel(key, onFirstOpen) {
  if (els[`${key}Panel`].hidden) {
    openInsightPanel(key);
    onFirstOpen?.();
  } else {
    closeInsightPanel(key);
  }
}

async function loadApiSurface() {
  if (!state.activeProject) return;

  els.apiSurfaceStatus.hidden = false;
  els.apiSurfaceStatus.classList.remove("is-error");
  els.apiSurfaceStatus.textContent = "Loading…";
  els.apiSurface.hidden = true;

  try {
    const data = await getJson(`/api/projects/${encodeURIComponent(state.activeProject)}/api-surface`);
    state.apiSurface = data.results;
    els.apiSurface.innerHTML = data.results.length
      ? data.results
          .map(
            (group) => `
    <div class="arch-item arch-cluster">
      <div class="arch-item-name">${escapeHtml(group.urlPath)} <span class="arch-item-meta">· ${formatNumber(group.callers.length)} callers</span></div>
      <div class="arch-cluster-nodes">${group.callers
        .slice(0, 6)
        .map((caller) => `<span class="chip">${escapeHtml(caller.name)}</span>`)
        .join("")}</div>
    </div>
  `
          )
          .join("")
      : `<p class="empty">No HTTP calls found.</p>`;
    els.apiSurfaceStatus.hidden = true;
    els.apiSurface.hidden = false;
  } catch (error) {
    els.apiSurfaceStatus.classList.add("is-error");
    els.apiSurfaceStatus.textContent = errorMessage(error);
  }
}

async function loadConfigMap() {
  if (!state.activeProject) return;

  els.configMapStatus.hidden = false;
  els.configMapStatus.classList.remove("is-error");
  els.configMapStatus.textContent = "Loading…";
  els.configMap.hidden = true;

  try {
    const data = await getJson(`/api/projects/${encodeURIComponent(state.activeProject)}/config-map`);
    state.configMap = data;

    const envRows = (data.envVars ?? [])
      .map(
        (envVar) => `
    <div class="arch-item">
      <span class="arch-item-name">${escapeHtml(envVar.label)}</span>
      <span class="arch-item-meta">env var</span>
    </div>
  `
      )
      .join("");
    const entryRows = (data.entries ?? [])
      .map(
        (entry) => `
    <div class="arch-item arch-cluster">
      <div class="arch-item-name">${escapeHtml(entry.key)} <span class="arch-item-meta">· ${formatNumber(entry.configuredBy.length)} references</span></div>
      <div class="arch-cluster-nodes">${entry.configuredBy
        .slice(0, 6)
        .map((ref) => `<span class="chip">${escapeHtml(ref.name)}</span>`)
        .join("")}</div>
    </div>
  `
      )
      .join("");

    els.configMap.innerHTML = envRows + entryRows || `<p class="empty">No configuration links found.</p>`;
    els.configMapStatus.hidden = true;
    els.configMap.hidden = false;
  } catch (error) {
    els.configMapStatus.classList.add("is-error");
    els.configMapStatus.textContent = errorMessage(error);
  }
}

async function loadIndexHealth() {
  if (!state.activeProject) return;

  els.indexHealth.textContent = "";
  try {
    const data = await getJson(`/api/projects/${encodeURIComponent(state.activeProject)}/index-health`);
    const parts = [`Embeddings: ${data.hasEmbeddings ? "Yes" : "No"}`];
    if (data.status) parts.push(`Index: ${data.status}`);
    els.indexHealth.textContent = parts.join(" · ");
  } catch {
    // Non-critical status line - leave empty (and hidden via .index-health:empty) on failure.
  }
}

async function loadChurn() {
  if (!state.activeProject) return;

  els.churnStatus.hidden = false;
  els.churnStatus.classList.remove("is-error");
  els.churnStatus.textContent = "Loading…";
  els.churnList.hidden = true;

  try {
    const data = await getJson(`/api/projects/${encodeURIComponent(state.activeProject)}/churn`);
    state.churn = data.results;
    els.churnList.innerHTML = data.results.length
      ? data.results
          .map(
            (file) => `
    <div class="arch-item">
      <span class="arch-item-name">${escapeHtml(file.filePath)}</span>
      <span class="arch-item-meta">${formatNumber(file.changeCount)} changes${
        file.lastModified ? ` · ${new Date(file.lastModified * 1000).toLocaleDateString()}` : ""
      }</span>
    </div>
  `
          )
          .join("")
      : `<p class="empty">No file-change history captured.</p>`;
    els.churnStatus.hidden = true;
    els.churnList.hidden = false;
  } catch (error) {
    els.churnStatus.classList.add("is-error");
    els.churnStatus.textContent = errorMessage(error);
  }
}

async function loadArchitecture() {
  if (!state.activeProject) return;

  els.architectureStatus.hidden = false;
  els.architectureStatus.classList.remove("is-error");
  els.architectureStatus.textContent = "Loading architecture insights…";
  els.architectureBody.hidden = true;

  try {
    const data = await getJson(`/api/projects/${encodeURIComponent(state.activeProject)}/architecture`);
    state.architecture = data;
    renderArchitecture(data);
    els.architectureStatus.hidden = true;
    els.architectureBody.hidden = false;
  } catch (error) {
    els.architectureStatus.classList.add("is-error");
    els.architectureStatus.textContent = errorMessage(error);
  }
}

function renderArchitecture(data) {
  const layers = Array.isArray(data.layers) ? data.layers : [];
  els.archLayers.innerHTML = layers.length
    ? layers
        .map(
          (row) => `
    <div class="arch-item">
      <span class="arch-item-name">${escapeHtml(row.name || "(root)")}</span>
      <span class="arch-layer-badge arch-layer-${escapeHtml(row.layer ?? "")}">${escapeHtml(row.layer ?? "?")}</span>
    </div>
  `
        )
        .join("")
    : `<p class="empty">No layer data.</p>`;

  const hotspots = Array.isArray(data.hotspots) ? data.hotspots : [];
  els.archHotspots.innerHTML = hotspots.length
    ? hotspots
        .map(
          (row, index) => `
    <button type="button" class="arch-item arch-item-button" data-hotspot-index="${index}">
      <span class="arch-item-name">${escapeHtml(row.name)}</span>
      <span class="arch-item-meta">fan-in ${formatNumber(row.fan_in ?? 0)}</span>
    </button>
  `
        )
        .join("")
    : `<p class="empty">No hotspots found.</p>`;
  els.archHotspots.querySelectorAll("[data-hotspot-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const row = hotspots[Number(button.dataset.hotspotIndex)];
      if (row?.qualified_name) void openTrace(row.qualified_name, row.name);
    });
  });

  const boundaries = Array.isArray(data.boundaries) ? data.boundaries : [];
  els.archBoundaries.innerHTML = boundaries.length
    ? boundaries
        .slice(0, 12)
        .map(
          (row) => `
    <div class="arch-item">
      <span class="arch-item-name">${escapeHtml(row.from)} <span class="arch-arrow">→</span> ${escapeHtml(row.to)}</span>
      <span class="arch-item-meta">${formatNumber(row.call_count ?? 0)}</span>
    </div>
  `
        )
        .join("")
    : `<p class="empty">No cross-module boundaries found.</p>`;

  const clusters = Array.isArray(data.clusters) ? data.clusters : [];
  els.archClusters.innerHTML = clusters.length
    ? clusters
        .slice(0, 10)
        .map(
          (row) => `
    <div class="arch-item arch-cluster">
      <div class="arch-item-name">${escapeHtml(row.label ?? `Cluster ${row.id}`)} <span class="arch-item-meta">· ${formatNumber(row.members ?? 0)} members · cohesion ${(row.cohesion ?? 0).toFixed(2)}</span></div>
      <div class="arch-cluster-nodes">${(row.top_nodes ?? []).map((name) => `<span class="chip">${escapeHtml(name)}</span>`).join("")}</div>
    </div>
  `
        )
        .join("")
    : `<p class="empty">No clusters found.</p>`;
}

async function loadPerfRisks() {
  if (!state.activeProject) return;

  els.perfStatus.hidden = false;
  els.perfStatus.classList.remove("is-error");
  els.perfStatus.textContent = "Loading perf risks…";
  els.perfList.hidden = true;

  try {
    const data = await getJson(`/api/projects/${encodeURIComponent(state.activeProject)}/perf-risks`);
    state.perf = data.results;
    renderPerfRisks(data.results);
    els.perfStatus.hidden = true;
    els.perfList.hidden = false;
  } catch (error) {
    els.perfStatus.classList.add("is-error");
    els.perfStatus.textContent = errorMessage(error);
  }
}

function perfRiskChips(meta) {
  return [
    meta.transitiveLoopDepth ? `<span class="chip">loop depth ${formatNumber(meta.transitiveLoopDepth)}</span>` : "",
    meta.linearScanInLoop ? `<span class="chip">linear scan in loop</span>` : "",
    meta.unguardedRecursion ? `<span class="chip">unguarded recursion</span>` : "",
    meta.allocInLoop ? `<span class="chip">alloc in loop</span>` : ""
  ].join("");
}

function renderPerfRisks(risks) {
  els.perfList.innerHTML = risks.length
    ? risks
        .map(
          (risk, index) => `
    <div class="arch-item arch-cluster">
      <div class="arch-item-name">
        ${escapeHtml(risk.label)}
        <span class="arch-item-meta">· ${escapeHtml(risk.file ?? "")}</span>
      </div>
      <div class="arch-cluster-nodes">${perfRiskChips(risk.meta ?? {})}</div>
      <button type="button" class="row-action" data-perf-trace="${index}">Trace</button>
    </div>
  `
        )
        .join("")
    : `<p class="empty">No perf risks found.</p>`;

  els.perfList.querySelectorAll("[data-perf-trace]").forEach((button) => {
    button.addEventListener("click", () => {
      const risk = risks[Number(button.dataset.perfTrace)];
      if (risk) void openTrace(risk.qualifiedName, risk.label);
    });
  });
}

async function loadDuplicates() {
  if (!state.activeProject) return;

  els.duplicatesStatus.hidden = false;
  els.duplicatesStatus.classList.remove("is-error");
  els.duplicatesStatus.textContent = "Loading duplicates…";
  els.duplicatesList.hidden = true;

  try {
    const data = await getJson(`/api/projects/${encodeURIComponent(state.activeProject)}/duplicates`);
    state.duplicates = data.results;
    renderDuplicates(data.results);
    els.duplicatesStatus.hidden = true;
    els.duplicatesList.hidden = false;
  } catch (error) {
    els.duplicatesStatus.classList.add("is-error");
    els.duplicatesStatus.textContent = errorMessage(error);
  }
}

function renderDuplicates(pairs) {
  els.duplicatesList.innerHTML = pairs.length
    ? pairs
        .map(
          (pair) => `
    <div class="arch-item arch-cluster">
      <div class="arch-item-name">
        ${escapeHtml(pair.a.name)} <span class="arch-arrow">~</span> ${escapeHtml(pair.b.name)}
        <span class="arch-item-meta">· jaccard ${pair.jaccard.toFixed(2)}</span>
      </div>
      <div class="arch-cluster-nodes">
        <span class="chip">${escapeHtml(pair.a.file ?? "")}</span>
        <span class="chip">${escapeHtml(pair.b.file ?? "")}</span>
      </div>
    </div>
  `
        )
        .join("")
    : `<p class="empty">No similar code pairs found.</p>`;
}

async function loadImpact() {
  if (!state.activeProject) return;

  els.impactStatus.hidden = false;
  els.impactStatus.classList.remove("is-error");
  els.impactStatus.textContent = "Loading impact…";
  els.impactBody.hidden = true;

  try {
    const data = await getJson(`/api/projects/${encodeURIComponent(state.activeProject)}/impact`);
    state.impact = data;
    renderImpact(data);
    els.impactStatus.hidden = true;
    els.impactBody.hidden = false;
  } catch (error) {
    els.impactStatus.classList.add("is-error");
    els.impactStatus.textContent = errorMessage(error);
  }
}

function renderImpact(data) {
  const files = Array.isArray(data.changed_files) ? data.changed_files : [];
  els.impactFiles.innerHTML = files.length
    ? files.map((file) => `<div class="arch-item"><span class="arch-item-name">${escapeHtml(file)}</span></div>`).join("")
    : `<p class="empty">No uncommitted changes detected.</p>`;

  const symbols = Array.isArray(data.impacted_symbols) ? data.impacted_symbols : [];
  els.impactSymbols.innerHTML = symbols.length
    ? symbols
        .map((symbol) =>
          // detect_changes doesn't return a qualified_name, only a short name - passing it
          // as the id anyway lets Trace/Copy work on a best-effort basis (trace_path also
          // accepts short names), at the cost of "Related code" not resolving for these rows.
          symbolRowHtml(
            { label: symbol.name, kind: symbol.label, file: symbol.file, qualifiedName: symbol.name },
            `${escapeHtml(symbol.label)} · ${escapeHtml(symbol.file ?? "")}`
          )
        )
        .join("")
    : `<p class="empty">No impacted symbols.</p>`;
  wireSymbolRows(els.impactSymbols);
}

async function loadCrossRepoProjectList() {
  if (!state.activeProject) return;

  els.crossRepoProjects.innerHTML = `<p class="empty">Loading projects…</p>`;
  try {
    const data = await getJson("/api/projects");
    const others = (data.projects ?? []).filter((entry) => entry.project !== state.activeProject);
    state.crossRepoProjects = others;
    els.crossRepoProjects.innerHTML = others.length
      ? others
          .map(
            (entry) => `
    <label class="cross-repo-project">
      <input type="checkbox" value="${escapeHtml(entry.project)}" />
      <span>${escapeHtml(prettyName(entry.project))}</span>
    </label>
  `
          )
          .join("")
      : `<p class="empty">No other indexed projects.</p>`;
  } catch (error) {
    els.crossRepoProjects.innerHTML = `<p class="empty is-error">${escapeHtml(errorMessage(error))}</p>`;
  }
}

async function runCrossRepo() {
  if (!state.activeProject) return;

  const targetProjects = [...els.crossRepoProjects.querySelectorAll("input:checked")].map((input) => input.value);
  if (!targetProjects.length) {
    els.crossRepoStatus.classList.add("is-error");
    els.crossRepoStatus.textContent = "Select at least one project.";
    return;
  }

  els.crossRepoStatus.hidden = false;
  els.crossRepoStatus.classList.remove("is-error");
  els.crossRepoStatus.textContent = "Running analysis…";
  els.crossRepoList.hidden = true;

  try {
    const data = await postJson(`/api/projects/${encodeURIComponent(state.activeProject)}/cross-repo`, {
      targetProjects
    });
    renderCrossRepoLinks(data);
  } catch (error) {
    els.crossRepoStatus.classList.add("is-error");
    els.crossRepoStatus.textContent = errorMessage(error);
  }
}

function renderCrossRepoLinks(data) {
  const summary = data.summary;
  const links = Array.isArray(data.links) ? data.links : [];

  const summaryLine = summary
    ? `Scanned ${formatNumber(summary.projects_scanned ?? 0)} projects · ${formatNumber(summary.total_cross_edges ?? 0)} cross-repo links found`
    : `${formatNumber(links.length)} cross-repo links`;

  els.crossRepoList.innerHTML =
    `<p class="arch-hint">${escapeHtml(summaryLine)}</p>` +
    (links.length
      ? links
          .map(
            (link) => `
    <div class="arch-item">
      <span class="arch-item-name">${escapeHtml(link.sourceName)} <span class="arch-arrow">→</span> ${escapeHtml(link.targetName)}</span>
      <span class="arch-item-meta">${escapeHtml(link.type)}${link.targetProject ? ` · ${escapeHtml(prettyName(link.targetProject))}` : ""}</span>
    </div>
  `
          )
          .join("")
      : `<p class="empty">No cross-repo links found between the selected projects.</p>`);
  els.crossRepoStatus.hidden = true;
  els.crossRepoList.hidden = false;
}

function toggleAdr(show) {
  els.adrDialog.hidden = !show;
}

async function openAdr() {
  if (!state.activeProject) return;

  els.adrTextarea.value = "";
  els.adrHint.hidden = true;
  els.adrHint.classList.remove("is-error");
  els.adrSaveStatus.textContent = "";
  toggleAdr(true);

  try {
    const data = await getJson(`/api/projects/${encodeURIComponent(state.activeProject)}/adr`);
    els.adrTextarea.value = data.content ?? "";
    if (!data.content && data.adr_hint) {
      els.adrHint.hidden = false;
      els.adrHint.textContent = data.adr_hint;
    }
  } catch (error) {
    els.adrHint.hidden = false;
    els.adrHint.classList.add("is-error");
    els.adrHint.textContent = errorMessage(error);
  }
}

async function saveAdr() {
  if (!state.activeProject) return;

  els.adrSaveStatus.textContent = "Saving…";
  try {
    await putJson(`/api/projects/${encodeURIComponent(state.activeProject)}/adr`, {
      content: els.adrTextarea.value
    });
    els.adrSaveStatus.textContent = "Saved";
    els.adrHint.hidden = true;
    setTimeout(() => {
      if (els.adrSaveStatus.textContent === "Saved") els.adrSaveStatus.textContent = "";
    }, 1500);
  } catch (error) {
    els.adrSaveStatus.textContent = errorMessage(error);
  }
}

function toggleQuery(show) {
  els.queryDialog.hidden = !show;
  if (show) els.queryTextarea.focus();
}

async function runQuery() {
  if (!state.activeProject) return;

  const query = els.queryTextarea.value.trim();
  if (!query) return;

  els.queryStatus.textContent = "Running…";
  els.queryStatus.classList.remove("is-error");
  els.queryResults.innerHTML = "";

  try {
    const data = await postJson(`/api/projects/${encodeURIComponent(state.activeProject)}/query`, { query });
    els.queryStatus.textContent = `${formatNumber(data.total ?? (data.rows ?? []).length)} rows`;
    renderQueryResults(data);
  } catch (error) {
    els.queryStatus.classList.add("is-error");
    els.queryStatus.textContent = errorMessage(error);
  }
}

function renderQueryResults(data) {
  const columns = Array.isArray(data.columns) ? data.columns : [];
  const rows = Array.isArray(data.rows) ? data.rows : [];

  if (!rows.length) {
    els.queryResults.innerHTML = `<p class="empty">No rows returned.</p>`;
    return;
  }

  els.queryResults.innerHTML = `
    <table>
      <thead>
        <tr>${columns.map((col) => `<th>${escapeHtml(col)}</th>`).join("")}</tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (row) => `<tr>${row.map((cell) => `<td title="${escapeHtml(String(cell ?? ""))}">${escapeHtml(String(cell ?? ""))}</td>`).join("")}</tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function setSizeMode(mode) {
  graph.setSizeMode(mode);
  savePrefs({ sizeBy: mode });
  els.sizeByCount.classList.toggle("is-active", mode === "count");
  els.sizeByDegree.classList.toggle("is-active", mode === "degree");
}

function toggleIsolate() {
  state.isolate = !state.isolate;
  graph.setIsolate(state.isolate);
  els.isolateButton.classList.toggle("is-toggled", state.isolate);
  if (state.isolate && state.selectedNode) graph.centerOn(state.selectedNode);
}

function handleGlobalKeydown(event) {
  const target = event.target;
  const isTyping =
    target instanceof HTMLElement &&
    (target.matches("input, textarea, select") || target.isContentEditable);

  if (event.key === "Escape") {
    if (!els.traceDialog.hidden) {
      toggleTrace(false);
      return;
    }
    if (!els.adrDialog.hidden) {
      toggleAdr(false);
      return;
    }
    if (!els.queryDialog.hidden) {
      toggleQuery(false);
      return;
    }
    if (!els.shortcutsHelp.hidden) {
      toggleShortcuts(false);
      return;
    }
    if (target === els.globalSymbolSearch) {
      showSearchResults(false);
      target.blur();
      return;
    }
    if (isTyping) {
      target.blur();
      return;
    }
    clearSelection();
    return;
  }

  if (isTyping) return;

  if (event.key === "/") {
    event.preventDefault();
    if (els.workspaceView.hidden) els.projectSearch.focus();
    else els.globalSymbolSearch.focus();
    return;
  }

  if (event.key === "f" || event.key === "F") {
    graph.fit();
    return;
  }

  if (event.key === "i" || event.key === "I") {
    toggleIsolate();
    return;
  }

  if (event.key === "r" || event.key === "R") {
    loadActiveProject();
    return;
  }

  if (event.key === "?") {
    toggleShortcuts(true);
  }
}

function showHome() {
  els.workspaceView.hidden = true;
  els.homeView.hidden = false;
  els.headerSearch.hidden = true;
  els.adrButton.hidden = true;
  els.queryButton.hidden = true;
  showSearchResults(false);
  renderProjectGrid();
}

function showWorkspace() {
  els.homeView.hidden = true;
  els.workspaceView.hidden = false;
  els.headerSearch.hidden = false;
  els.adrButton.hidden = false;
  els.queryButton.hidden = false;
}

async function loadProjects() {
  els.projectGrid.innerHTML = renderSkeletonCards(6);

  try {
    const data = await getJson("/api/projects");
    state.projects = data.projects;
    renderProjectGrid();

    const prefs = loadPrefs();
    if (els.graphLimit.querySelector(`option[value="${prefs.graphLimit}"]`)) {
      els.graphLimit.value = String(prefs.graphLimit);
    }
  } catch (error) {
    els.projectGrid.innerHTML = `
      <div class="list-error">
        <p>${escapeHtml(errorMessage(error))}</p>
        <button class="icon-button" id="projectListRetry" type="button">Retry</button>
      </div>
    `;
    document.querySelector("#projectListRetry")?.addEventListener("click", () => loadProjects());
  }
}

function renderSkeletonCards(count) {
  return Array.from({ length: count }, () => `<div class="skeleton-card"></div>`).join("");
}

function buildProjectGroups(projects) {
  const groups = new Map();
  for (const project of projects) {
    const pretty = prettyName(project.project);
    const sepIndex = pretty.indexOf(" / ");
    const key = sepIndex === -1 ? pretty : pretty.slice(0, sepIndex);
    const suffix = sepIndex === -1 ? null : pretty.slice(sepIndex + 3);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ project, pretty, suffix });
  }

  for (const items of groups.values()) {
    items.sort((a, b) => {
      if (a.suffix === null) return -1;
      if (b.suffix === null) return 1;
      return b.project.nodes - a.project.nodes;
    });
  }

  return [...groups.entries()].map(([key, items]) => ({ key, items }));
}

function sortProjects(projects) {
  const sorted = [...projects];
  if (state.projectSort === "name") {
    sorted.sort((a, b) => prettyName(a.project).localeCompare(prettyName(b.project)));
  } else if (state.projectSort === "recent") {
    const recent = loadPrefs().recentProjects;
    const rankOf = (project) => {
      const index = recent.indexOf(project.project);
      return index === -1 ? Infinity : index;
    };
    sorted.sort((a, b) => rankOf(a) - rankOf(b) || b.nodes - a.nodes);
  } else {
    sorted.sort((a, b) => b.nodes - a.nodes);
  }
  return sorted;
}

function renderProjectGrid() {
  const filter = els.projectSearch.value.trim().toLowerCase();
  const projects = sortProjects(state.projects).filter((project) =>
    `${project.project} ${project.root_path}`.toLowerCase().includes(filter)
  );

  renderRecentProjects(Boolean(filter));

  els.projectGrid.innerHTML = "";

  if (!projects.length) {
    els.projectGrid.innerHTML = `<p class="empty">No cached projects found.</p>`;
    return;
  }

  for (const group of buildProjectGroups(projects)) {
    els.projectGrid.append(renderProjectCard(group, Boolean(filter)));
  }
}

function renderRecentProjects(filterActive) {
  const recentNames = loadPrefs().recentProjects;
  const projectByName = new Map(state.projects.map((project) => [project.project, project]));
  const recents = recentNames.map((name) => projectByName.get(name)).filter(Boolean);

  if (filterActive || !recents.length) {
    els.recentProjects.hidden = true;
    return;
  }

  els.recentProjects.hidden = false;
  els.recentProjectsGrid.innerHTML = "";
  for (const project of recents) {
    els.recentProjectsGrid.append(renderRecentCard(project));
  }
}

function renderRecentCard(project) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = `project-card recent-card ${project.project === state.activeProject ? "is-active" : ""}`;
  card.innerHTML = `
    <header class="project-card-head">
      <h3>${escapeHtml(prettyName(project.project))}</h3>
    </header>
    <p class="project-card-meta">${formatNumber(project.nodes)} nodes · ${formatNumber(project.edges)} edges</p>
  `;
  card.addEventListener("click", () => selectProject(project.project, { restoreFilters: true }));
  return card;
}

const EXCLUDE_OPEN_SELECTOR = ".project-card-branch, .project-card-more, .project-card-delete";

function renderProjectCard(group, forceExpand) {
  const isActive = group.items.some((item) => item.project.project === state.activeProject);
  const primary = group.items.find((item) => item.suffix === null) ?? group.items[0];
  const totalNodes = group.items.reduce((sum, item) => sum + item.project.nodes, 0);
  const totalEdges = group.items.reduce((sum, item) => sum + item.project.edges, 0);

  const card = document.createElement("article");
  card.className = `project-card ${isActive ? "is-active" : ""}`;
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.innerHTML = `
    <header class="project-card-head">
      <h3>${escapeHtml(group.key)}</h3>
      <div class="project-card-head-meta">
        ${group.items.length > 1 ? `<span class="project-card-count">${group.items.length} variants</span>` : ""}
        ${
          group.items.length === 1
            ? `<button type="button" class="project-card-delete" title="Remove from cache" aria-label="Remove from cache">Remove</button>`
            : ""
        }
      </div>
    </header>
    <p class="project-card-meta">${formatNumber(totalNodes)} nodes · ${formatNumber(totalEdges)} edges</p>
    <p class="project-card-path">
      ${!primary.project.path_exists ? `<span class="badge badge-missing">Missing</span>` : ""}
      <span class="path-text">${escapeHtml(truncate(primary.project.root_path, 54))}</span>
    </p>
  `;

  const open = () => selectProject(primary.project.project, { restoreFilters: true });
  card.addEventListener("click", (event) => {
    if (event.target.closest(EXCLUDE_OPEN_SELECTOR)) return;
    open();
  });
  card.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && !event.target.closest(EXCLUDE_OPEN_SELECTOR)) {
      event.preventDefault();
      open();
    }
  });

  card.querySelector(".project-card-delete")?.addEventListener("click", (event) => {
    event.stopPropagation();
    void deleteProjectFlow(primary.project.project, group.key);
  });

  if (group.items.length > 1) {
    const branches = document.createElement("div");
    branches.className = "project-card-branches";
    const showAll = forceExpand || group.items.length <= 5;
    const visible = showAll ? group.items : group.items.slice(0, 4);

    for (const item of visible) branches.append(renderBranchRow(item));

    if (!showAll) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "project-card-more";
      more.textContent = `+${group.items.length - visible.length} more`;
      more.addEventListener("click", (event) => {
        event.stopPropagation();
        branches.innerHTML = "";
        for (const item of group.items) branches.append(renderBranchRow(item));
      });
      branches.append(more);
    }

    card.append(branches);
  }

  return card;
}

function renderBranchRow(item) {
  const row = document.createElement("div");
  row.className = `project-card-branch ${item.project.project === state.activeProject ? "is-active" : ""}`;
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.innerHTML = `
    <div class="project-card-branch-main">
      <span class="project-card-branch-label">
        <span class="branch-name">${escapeHtml(truncate(item.suffix ?? "main", 22))}</span>
        ${item.project.nodes < 5 ? '<span class="badge badge-sparse">sparse</span>' : ""}
        ${!item.project.path_exists ? '<span class="badge badge-missing">Missing</span>' : ""}
      </span>
      <span class="path-text">${escapeHtml(truncate(item.project.root_path, 48))}</span>
    </div>
    <span class="project-card-branch-meta">${formatNumber(item.project.nodes)} nodes</span>
    <button type="button" class="project-card-delete" title="Remove from cache" aria-label="Remove from cache">Remove</button>
  `;
  row.addEventListener("click", (event) => {
    if (event.target.closest(".project-card-delete")) return;
    event.stopPropagation();
    selectProject(item.project.project, { restoreFilters: true });
  });
  row.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && !event.target.closest(".project-card-delete")) {
      event.preventDefault();
      selectProject(item.project.project, { restoreFilters: true });
    }
  });
  row.querySelector(".project-card-delete").addEventListener("click", (event) => {
    event.stopPropagation();
    void deleteProjectFlow(item.project.project, item.suffix ?? "main");
  });
  return row;
}

async function deleteProjectFlow(projectName, displayName) {
  const confirmed = window.confirm(`Remove "${displayName}" from the cache? This cannot be undone.`);
  if (!confirmed) return;

  try {
    await deleteJson(`/api/projects/${encodeURIComponent(projectName)}`);
  } catch (error) {
    window.alert(errorMessage(error));
    return;
  }

  state.projects = state.projects.filter((project) => project.project !== projectName);
  const prefs = loadPrefs();
  savePrefs({ recentProjects: prefs.recentProjects.filter((name) => name !== projectName) });
  renderProjectGrid();
}

function pushRecent(projectName) {
  const prefs = loadPrefs();
  const next = [projectName, ...prefs.recentProjects.filter((name) => name !== projectName)].slice(0, 6);
  savePrefs({ recentProjects: next });
}

async function selectProject(projectName, { restoreFilters = false } = {}) {
  state.activeProject = projectName;
  state.selectedNode = null;
  state.selectedEdge = null;
  state.packageDetails = null;
  savePrefs({ project: projectName });
  pushRecent(projectName);
  showWorkspace();
  await loadActiveProject({ restoreFilters });
}

function graphQueryString() {
  const params = new URLSearchParams({ limit: els.graphLimit.value, mode: state.graphMode });
  if (els.graphFamily.value) params.set("family", els.graphFamily.value);
  return params.toString();
}

function applyGraphMode(mode) {
  state.graphMode = mode;
  els.graphModePackages.classList.toggle("is-active", mode === "packages");
  els.graphModeSymbols.classList.toggle("is-active", mode === "symbols");

  // Tree's "nearest existing ancestor" nesting relies on real package/folder nodes to
  // walk up to - there are none in Symbols mode, so it has nothing to nest against.
  const treeOption = els.layoutMode.querySelector('option[value="tree"]');
  treeOption.disabled = mode === "symbols";
  if (mode === "symbols" && els.layoutMode.value === "tree") {
    els.layoutMode.value = "clustered";
    graph.setLayoutMode("clustered");
    savePrefs({ layoutMode: "clustered" });
  }
}

function setGraphMode(mode) {
  applyGraphMode(mode);
  savePrefs({ graphMode: mode });
  void loadGraph();
}

async function loadActiveProject({ restoreFilters = false } = {}) {
  if (!state.activeProject) return;

  setGraphStatus("loading");
  els.graphFamily.value = "";
  els.graphLimit.disabled = false;

  let summary;
  let graphData;
  try {
    [summary, graphData] = await Promise.all([
      getJson(`/api/projects/${encodeURIComponent(state.activeProject)}/summary`),
      getJson(`/api/projects/${encodeURIComponent(state.activeProject)}/graph?${graphQueryString()}`)
    ]);
  } catch (error) {
    setGraphStatus("error", errorMessage(error));
    return;
  }

  state.summary = summary;
  state.graph = graphData;
  state.selectedNode = null;
  state.selectedEdge = null;
  state.architecture = null;
  state.apiSurface = null;
  state.configMap = null;
  state.churn = null;
  state.perf = null;
  state.duplicates = null;
  state.impact = null;
  state.crossRepoProjects = null;
  INSIGHT_PANEL_KEYS.forEach(closeInsightPanel);
  setDetailsTab("selection");
  void loadIndexHealth();

  if (restoreFilters) {
    const prefs = loadPrefs();
    const availableTypes = new Set(graphData.edges.map((edge) => edge.type));
    state.hiddenEdgeTypes = new Set(prefs.hiddenEdgeTypes.filter((type) => availableTypes.has(type)));
    state.minWeight = prefs.minWeight;
  } else {
    state.hiddenEdgeTypes = new Set();
    state.minWeight = 1;
  }

  renderSummary();
  renderBreadcrumb();
  setGraphStatus(graphData.nodes.length ? "ready" : "empty");
  graph.setData(graphData.nodes, graphData.edges);
  graph.setFilters({ hiddenTypes: state.hiddenEdgeTypes, minWeight: state.minWeight });
  renderEdgeTypeFilters();
  renderRelations();
  renderEmptyInspector();
  els.globalSymbolSearch.value = "";
  els.globalSearchResults.innerHTML = "";
  showSearchResults(false);
}

async function loadGraph() {
  if (!state.activeProject) return;

  setGraphStatus("loading");

  let graphData;
  try {
    graphData = await getJson(
      `/api/projects/${encodeURIComponent(state.activeProject)}/graph?${graphQueryString()}`
    );
  } catch (error) {
    setGraphStatus("error", errorMessage(error));
    return;
  }

  state.graph = graphData;
  state.selectedNode = null;
  state.selectedEdge = null;
  state.hiddenEdgeTypes = new Set();
  state.minWeight = 1;

  renderBreadcrumb();
  setGraphStatus(graphData.nodes.length ? "ready" : "empty");
  graph.setData(graphData.nodes, graphData.edges);
  graph.setFilters({ hiddenTypes: state.hiddenEdgeTypes, minWeight: state.minWeight });
  renderEdgeTypeFilters();
  renderRelations();
  renderEmptyInspector();
}

function setGraphStatus(mode, message) {
  const el = els.graphStatus;
  el.classList.toggle("is-loading", mode === "loading");
  el.classList.toggle("is-error", mode === "error");
  el.classList.toggle("is-empty", mode === "empty");
  el.hidden = mode === "ready";
  els.graphRetry.hidden = mode !== "error";

  if (mode === "loading") els.graphStatusMessage.textContent = "Loading graph…";
  else if (mode === "error") els.graphStatusMessage.textContent = message ?? "Failed to load graph.";
  else if (mode === "empty") els.graphStatusMessage.textContent = "No graph data for this project.";
}

function renderSummary() {
  const summary = state.summary;
  els.projectTitle.textContent = prettyName(summary.project);
  els.nodesMetric.textContent = formatNumber(summary.total_nodes);
  els.edgesMetric.textContent = formatNumber(summary.total_edges);
  els.packagesMetric.textContent = formatNumber(summary.total_packages ?? summary.packages.length);

  const families = summary.families ?? [];
  els.graphFamily.innerHTML =
    `<option value="">All areas</option>` +
    families.map((family) => `<option value="${escapeHtml(family)}">${escapeHtml(family)}</option>`).join("");

  const topPackage = [...summary.packages].sort((a, b) => b.node_count - a.node_count)[0];
  els.topPackageMetric.textContent = topPackage
    ? `${topPackage.name} · ${formatNumber(topPackage.node_count)}`
    : "-";

  const maxLabel = Math.max(...summary.node_labels.map((row) => row.count), 1);
  els.labelBars.innerHTML = summary.node_labels
    .slice(0, 8)
    .map(
      (row) => `
    <div class="bar">
      <div class="bar-row">
        <span>${escapeHtml(row.label)}</span>
        <span>${formatNumber(row.count)}</span>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(4, (row.count / maxLabel) * 100)}%"></div></div>
    </div>
  `
    )
    .join("");
}

function renderEdgeTypeFilters() {
  const counts = graph.getEdgeTypeCounts();
  const maxCount = Math.max(1, ...state.graph.edges.map((edge) => edge.count));
  els.minWeight.min = "1";
  els.minWeight.max = String(Math.max(1, maxCount));
  els.minWeight.value = String(Math.min(state.minWeight, Math.max(1, maxCount)));
  els.minWeightValue.textContent = els.minWeight.value;

  if (!counts.length) {
    els.edgeTypeFilters.innerHTML = `<p class="empty">No relations in view.</p>`;
    return;
  }

  els.edgeTypeFilters.innerHTML = counts
    .map(
      (row) => `
    <button class="filter-chip ${state.hiddenEdgeTypes.has(row.type) ? "is-off" : ""}" type="button" data-type="${escapeHtml(row.type)}">
      <span class="filter-dot" style="background:${graph.getEdgeTypeColor(row.type)}"></span>
      ${escapeHtml(row.type)} <em>${formatNumber(row.count)}</em>
    </button>
  `
    )
    .join("");

  els.edgeTypeFilters.querySelectorAll(".filter-chip").forEach((button) => {
    button.addEventListener("click", () => {
      const type = button.dataset.type;
      if (state.hiddenEdgeTypes.has(type)) state.hiddenEdgeTypes.delete(type);
      else state.hiddenEdgeTypes.add(type);
      button.classList.toggle("is-off", state.hiddenEdgeTypes.has(type));
      graph.setFilters({ hiddenTypes: state.hiddenEdgeTypes });
      savePrefs({ hiddenEdgeTypes: [...state.hiddenEdgeTypes] });
      renderRelations();
    });
  });
}

function visibleEdges() {
  return state.graph.edges.filter(
    (edge) => !state.hiddenEdgeTypes.has(edge.type) && edge.count >= state.minWeight
  );
}

function relationsSource() {
  if (state.graphMode === "symbols" && state.selectedNode) {
    const id = state.selectedNode.id;
    return state.graph.edges
      .filter((edge) => edgeSourceId(edge) === id || edgeTargetId(edge) === id)
      .slice(0, 14);
  }
  if (state.selectedNode && state.packageDetails) {
    return state.packageDetails.relations.slice(0, 8);
  }
  return visibleEdges()
    .slice()
    .sort((a, b) => b.count - a.count)
    .slice(0, 14);
}

function nodeLabel(id) {
  return state.graph.nodes.find((node) => node.id === id)?.label ?? id;
}

function renderRelations() {
  const scoped = Boolean(state.selectedNode && (state.packageDetails || state.graphMode === "symbols"));
  const edges = relationsSource();

  els.relationsTitle.textContent = scoped ? `Relations · ${state.selectedNode.label}` : "Relations";
  els.relationCount.textContent = `${edges.length} shown`;

  if (!edges.length) {
    els.edgeList.innerHTML = `<p class="empty">${scoped ? "No relations." : "No cross-package relations."}</p>`;
    return;
  }

  els.edgeList.innerHTML = edges
    .map(
      (edge, index) => `
    <button class="edge-row ${edgeKey(edge) === edgeKey(state.selectedEdge) ? "is-active" : ""}" type="button" data-edge-index="${index}" title="${escapeHtml(edge.source)} → ${escapeHtml(edge.target)}">
      <span class="edge-route">${escapeHtml(nodeLabel(edge.source))} <span>→</span> ${escapeHtml(nodeLabel(edge.target))}</span>
      <span class="edge-meta">${escapeHtml(edge.type)} · ${formatNumber(edge.count)}</span>
    </button>
  `
    )
    .join("");

  els.edgeList.querySelectorAll(".edge-row").forEach((button) => {
    button.addEventListener("click", () => {
      selectEdgeFromList(edges[Number(button.dataset.edgeIndex)]);
    });
  });
}

function selectEdgeFromList(edge) {
  state.selectedEdge = edge;
  const node = state.graph.nodes.find((candidate) => candidate.id === edge.source);
  if (node) {
    state.selectedNode = node;
    graph.focusNode(node);
    graph.centerOn(node);
    void selectGraphNode(node);
  }
  graph.focusEdge(edge);
  renderRelations();
  renderBreadcrumb();
}

async function selectGraphNode(node) {
  setDetailsTab("selection");
  if (state.graphMode === "symbols") {
    selectSymbolNode(node);
  } else {
    await loadPackageDetails(node);
  }
}

function selectSymbolNode(node) {
  state.packageDetails = null;
  els.detailTitle.textContent = node.label;
  els.detailSubtitle.textContent = `${node.kind}${node.file ? ` · ${node.file}` : ""}`;
  els.packageSymbols.innerHTML = symbolRowHtml(node, escapeHtml(node.file ?? ""));
  wireSymbolRows(els.packageSymbols);
  renderRelations();
}

async function loadPackageDetails(node) {
  if (!node || !state.activeProject) {
    renderEmptyInspector();
    return;
  }

  state.packageDetails = null;
  try {
    state.packageDetails = await getJson(
      `/api/projects/${encodeURIComponent(state.activeProject)}/packages/${encodeURIComponent(node.id)}`
    );
    renderInspector();
  } catch (error) {
    els.detailTitle.textContent = "Couldn't load package";
    els.detailSubtitle.textContent = errorMessage(error);
    els.packageSymbols.innerHTML = "";
    renderRelations();
  }
}

function renderInspector() {
  const details = state.packageDetails;
  if (!details) {
    renderEmptyInspector();
    return;
  }

  els.detailTitle.textContent = details.name;
  els.detailSubtitle.textContent = `Package · ${formatNumber(details.node_count)} nodes`;

  els.packageSymbols.innerHTML = details.top_symbols.length
    ? details.top_symbols
        .slice(0, 8)
        .map((symbol) => symbolRowHtml(symbol, `${escapeHtml(symbol.kind)} · ${escapeHtml(symbol.file ?? "")}`))
        .join("")
    : `<p class="empty">No symbols in this package.</p>`;

  wireSymbolRows(els.packageSymbols);
  renderRelations();
}

const TRACEABLE_KINDS = new Set(["Function", "Method", "Route"]);
const DETAILABLE_KINDS = new Set(["Function", "Method", "Class", "Interface", "Type"]);
const ROW_INTERACTIVE_SELECTOR = ".copy-btn, .row-action, .symbol-details";

function complexityClass(value) {
  if (value >= 15) return "complexity-hot";
  if (value >= 8) return "complexity-warn";
  return "complexity-calm";
}

function symbolDetailsBodyHtml(meta) {
  const params = (meta.paramNames ?? [])
    .map((name, index) => `${escapeHtml(name)}${meta.paramTypes?.[index] ? `: ${escapeHtml(meta.paramTypes[index])}` : ""}`)
    .join(", ");

  return [
    meta.signature
      ? `<div class="detail-row"><span class="detail-label">Signature</span><code>${escapeHtml(meta.signature)}${escapeHtml(meta.returnType ?? "")}</code></div>`
      : "",
    meta.docstring ? `<p class="detail-doc">${escapeHtml(meta.docstring)}</p>` : "",
    params ? `<div class="detail-row"><span class="detail-label">Params</span><code>${params}</code></div>` : "",
    meta.baseClasses?.length
      ? `<div class="detail-row"><span class="detail-label">Extends</span><code>${escapeHtml(meta.baseClasses.join(", "))}</code></div>`
      : ""
  ].join("");
}

function symbolRowHtml(item, metaText) {
  const qualified = item.qualifiedName ?? "";
  const meta = item.meta ?? {};
  const title = meta.docstring || qualified;

  const badges = [
    meta.isEntryPoint ? `<span class="badge badge-entry">Entry</span>` : "",
    meta.isExported ? `<span class="badge badge-exported">Exported</span>` : "",
    meta.isTest ? `<span class="badge badge-test">Test</span>` : ""
  ].join("");

  const complexity =
    typeof meta.complexity === "number"
      ? `<span class="complexity-chip ${complexityClass(meta.complexity)}" title="Cyclomatic complexity">C${meta.complexity}</span>`
      : "";
  const cognitive =
    typeof meta.cognitive === "number"
      ? `<span class="complexity-chip ${complexityClass(meta.cognitive)}" title="Cognitive complexity">G${meta.cognitive}</span>`
      : "";

  const traceButton =
    qualified && TRACEABLE_KINDS.has(item.kind)
      ? `<button type="button" class="row-action" data-trace="${escapeHtml(qualified)}" data-trace-label="${escapeHtml(item.label)}" title="Trace calls" aria-label="Trace calls">Trace</button>`
      : "";

  const detailsBody = symbolDetailsBodyHtml(meta);
  const canRelate = Boolean(qualified) && DETAILABLE_KINDS.has(item.kind);
  const showDetails = Boolean(detailsBody) || canRelate;
  const detailsToggle = showDetails
    ? `<button type="button" class="row-action details-toggle" title="Show details" aria-label="Show details" aria-expanded="false">Details</button>`
    : "";

  return `
    <div class="symbol-row" tabindex="0" role="button" data-package="${escapeHtml(packageFromFile(item.file))}" title="${escapeHtml(title)}">
      <div class="row-main">
        <div class="row-title">
          <strong>${escapeHtml(item.label)}</strong>
          ${badges}
        </div>
        <span>${metaText} ${complexity}${cognitive}</span>
      </div>
      <div class="row-actions">
        ${detailsToggle}
        ${traceButton}
        ${
          qualified
            ? `<button type="button" class="copy-btn" data-copy="${escapeHtml(qualified)}" title="Copy qualified name" aria-label="Copy qualified name">Copy</button>`
            : ""
        }
      </div>
      ${
        showDetails
          ? `<div class="symbol-details" hidden data-qualified="${escapeHtml(qualified)}" data-can-relate="${canRelate}" data-related-loaded="false">
              ${detailsBody}
              ${canRelate ? `<div class="related-code"></div>` : ""}
            </div>`
          : ""
      }
    </div>
  `;
}

function wireSymbolRows(container) {
  container.querySelectorAll(".symbol-row").forEach((row) => {
    row.addEventListener("click", (event) => {
      if (event.target.closest(ROW_INTERACTIVE_SELECTOR)) return;
      selectPackageByName(row.dataset.package);
    });
    row.addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && !event.target.closest(ROW_INTERACTIVE_SELECTOR)) {
        event.preventDefault();
        selectPackageByName(row.dataset.package);
      }
    });
  });

  container.querySelectorAll(".details-toggle").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const details = button.closest(".symbol-row").querySelector(".symbol-details");
      const next = details.hidden;
      details.hidden = !next;
      button.setAttribute("aria-expanded", String(next));
      if (next && details.dataset.canRelate === "true" && details.dataset.relatedLoaded === "false") {
        details.dataset.relatedLoaded = "true";
        void loadRelatedSymbols(details);
      }
    });
  });

  container.querySelectorAll(".copy-btn").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void copyToClipboard(button.dataset.copy, button);
    });
  });

  container.querySelectorAll(".row-action[data-trace]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void openTrace(button.dataset.trace, button.dataset.traceLabel);
    });
  });
}

async function loadRelatedSymbols(detailsEl) {
  const container = detailsEl.querySelector(".related-code");
  if (!container || !state.activeProject) return;

  container.innerHTML = `<p class="empty">Loading related code…</p>`;
  try {
    const data = await getJson(
      `/api/projects/${encodeURIComponent(state.activeProject)}/related?symbol=${encodeURIComponent(detailsEl.dataset.qualified)}`
    );
    container.innerHTML = data.results.length
      ? `<p class="detail-label">Related code</p>` +
        data.results.map((result) => symbolRowHtml(result, escapeHtml(result.file ?? ""))).join("")
      : `<p class="empty">No related code found.</p>`;
    wireSymbolRows(container);
  } catch (error) {
    container.innerHTML = `<p class="empty is-error">${escapeHtml(errorMessage(error))}</p>`;
  }
}

async function copyToClipboard(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return;
  }
  const original = button.textContent;
  button.textContent = "Copied";
  button.classList.add("is-copied");
  setTimeout(() => {
    button.textContent = original;
    button.classList.remove("is-copied");
  }, 1200);
}

function renderEmptyInspector() {
  els.detailTitle.textContent = "Select a package";
  els.detailSubtitle.textContent = "Package details, relations, and symbols appear here.";
  els.packageSymbols.innerHTML = "";
}

async function searchSymbols() {
  if (!state.activeProject) return;

  const q = els.globalSymbolSearch.value.trim();
  if (!q) {
    els.globalSearchResults.innerHTML = `<p class="empty">Type to search functions, modules, and files.</p>`;
    showSearchResults(true);
    return;
  }

  try {
    const params = new URLSearchParams({ q });
    if (els.searchLabelFilter.value) params.set("label", els.searchLabelFilter.value);
    const data = await getJson(`/api/projects/${encodeURIComponent(state.activeProject)}/search?${params}`);
    const renderRow = (result) =>
      symbolRowHtml(
        { ...result, label: `${result.label} · ${result.kind}` },
        escapeHtml(result.file || result.qualifiedName || "")
      );

    let html = data.results.length ? data.results.map(renderRow).join("") : `<p class="empty">No matches.</p>`;

    const seenIds = new Set(data.results.map((result) => result.id));
    const semanticExtra = (data.semantic_results ?? []).filter((result) => !seenIds.has(result.id));
    if (semanticExtra.length) {
      html += `<p class="search-group-label">Similar by meaning</p>${semanticExtra.map(renderRow).join("")}`;
    }

    els.globalSearchResults.innerHTML = html;
    wireSymbolRows(els.globalSearchResults);
  } catch (error) {
    els.globalSearchResults.innerHTML = `<p class="empty is-error">${escapeHtml(errorMessage(error))}</p>`;
  }
  showSearchResults(true);
}

function selectPackageByName(packageName) {
  const node = state.graph.nodes.find((candidate) => candidate.id === packageName);
  if (node) {
    state.selectedNode = node;
    state.selectedEdge = null;
    graph.focusNode(node);
    graph.centerOn(node);
    renderRelations();
    renderBreadcrumb();
    void loadPackageDetails(node);
  }
  showSearchResults(false);
  els.globalSymbolSearch.blur();
}

function showTooltip(node, pos) {
  if (!node) {
    els.graphTooltip.hidden = true;
    return;
  }

  const wrap = els.graphCanvas.parentElement.getBoundingClientRect();
  els.graphTooltip.hidden = false;
  els.graphTooltip.style.left = `${pos.clientX - wrap.left + 14}px`;
  els.graphTooltip.style.top = `${pos.clientY - wrap.top + 14}px`;
  els.graphTooltip.innerHTML = `
    <strong>${escapeHtml(node.label)}</strong>
    <span>${formatNumber(node.count ?? 0)} nodes · ${formatNumber(node.degree ?? 0)} relations</span>
  `;
}

function edgeSourceId(edge) {
  return typeof edge.source === "string" ? edge.source : edge.source?.id;
}

function edgeTargetId(edge) {
  return typeof edge.target === "string" ? edge.target : edge.target?.id;
}

function errorMessage(error) {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}
