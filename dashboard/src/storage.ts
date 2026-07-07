const KEY = "codebase-memory-plus:prefs";

export type Settings = {
  nodeRadiusMin: number;
  nodeRadiusMax: number;
  showGrid: boolean;
  edgeCurvature: "straight" | "curved";
  autoFitOnLoad: boolean;
  reducedMotion: boolean;
  labelZoomThreshold: number;
  originalUiUrl: string;
};

export type Prefs = Settings & {
  project: string | null;
  graphLimit: number | "all";
  hiddenEdgeTypes: string[];
  minWeight: number;
  sizeBy: "count" | "degree";
  layoutMode: string;
  recentProjects: string[];
  projectSort: "size" | "name" | "recent";
  graphMode: "packages" | "symbols";
  filtersCollapsed: boolean;
  uiMode: "plus" | "original";
};

// Seeded from the OS/browser preference so reduced-motion users get a calmer graph by
// default, but it's just the starting value - the settings panel can still override it.
const prefersReducedMotion =
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export const defaultSettings: Settings = {
  nodeRadiusMin: 7,
  nodeRadiusMax: 36,
  showGrid: true,
  edgeCurvature: "curved",
  autoFitOnLoad: true,
  reducedMotion: prefersReducedMotion,
  labelZoomThreshold: 1.3,
  originalUiUrl: "http://localhost:9749"
};

const defaults: Prefs = {
  ...defaultSettings,
  project: null,
  graphLimit: 60,
  hiddenEdgeTypes: [],
  minWeight: 1,
  sizeBy: "count",
  layoutMode: "clustered",
  recentProjects: [],
  projectSort: "size",
  graphMode: "packages",
  filtersCollapsed: false,
  uiMode: "plus"
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
