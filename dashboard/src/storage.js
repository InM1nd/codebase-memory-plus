const KEY = "codebase-memory-plus:prefs";

const defaults = {
  project: null,
  graphLimit: 60,
  hiddenEdgeTypes: [],
  minWeight: 1,
  sizeBy: "count",
  layoutMode: "clustered",
  recentProjects: [],
  projectSort: "size",
  graphMode: "packages"
};

export function loadPrefs() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...defaults };
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return { ...defaults };
  }
}

export function savePrefs(partial) {
  try {
    const next = { ...loadPrefs(), ...partial };
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // localStorage unavailable (e.g. private mode) - persistence is best-effort.
  }
}
