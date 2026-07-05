const KEY = "codebase-memory-plus:prefs";

export type Prefs = {
  project: string | null;
  graphLimit: number | "all";
  hiddenEdgeTypes: string[];
  minWeight: number;
  sizeBy: "count" | "degree";
  layoutMode: string;
  recentProjects: string[];
  projectSort: "size" | "name" | "recent";
  graphMode: "packages" | "symbols";
};

const defaults: Prefs = {
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

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...defaults };
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return { ...defaults };
  }
}

export function savePrefs(partial: Partial<Prefs>): void {
  try {
    const next = { ...loadPrefs(), ...partial };
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // localStorage unavailable (e.g. private mode) - persistence is best-effort.
  }
}
