// Fallback for when only the cache-key id string is available (e.g. a cross-repo link's
// targetProject) - the id is the absolute root path with EVERY "/" replaced by "-", so this
// can't tell a real path separator apart from a hyphen that's actually part of a folder or
// worktree branch name (e.g. "cyclic-ethernet" reads back as "cyclic / ethernet"). Prefer
// prettyPath() below whenever the real root_path is available, since it isn't lossy.
export function prettyName(value: string): string {
  return value
    // Project names are the absolute root path with "/" replaced by "-" - strip the
    // generic home-directory prefix ("Users-<name>-" on macOS, "home-<name>-" on Linux)
    // so the display name isn't tied to any one machine's username or folder layout.
    .replace(/^(Users|home)-[^-]+-/, "")
    .replaceAll("-", " / ");
}

// Same idea as prettyName(), but built from the real filesystem path (real "/" separators),
// so hyphens inside actual folder/branch names survive intact instead of getting split apart.
export function prettyPath(rootPath: string): string {
  return rootPath
    .replace(/^\/(Users|home)\/[^/]+\//, "")
    .replaceAll("/", " / ");
}

export function formatNumber(value: number | null | undefined): string {
  return new Intl.NumberFormat("en-US").format(value ?? 0);
}

export type EdgeLike = {
  source: string;
  target: string;
  type: string;
};

export function edgeKey(edge: EdgeLike | null | undefined): string {
  if (!edge) return "";
  return `${edge.source}→${edge.target}:${edge.type}`;
}

export function packageFromFile(file: string | null | undefined): string {
  if (!file) return "";
  const idx = file.lastIndexOf("/");
  return idx === -1 ? "(root)" : file.slice(0, idx);
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  wait: number
): (...args: Args) => void {
  let timer: ReturnType<typeof setTimeout>;
  return (...args: Args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Deterministic hash -> hue, stable across reloads without a backend cluster lookup.
function hashHue(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash << 5) - hash + key.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}

export function colorForKey(
  key: string,
  { saturation = 62, lightness = 52 }: { saturation?: number; lightness?: number } = {}
): string {
  return `hsl(${hashHue(key)}, ${saturation}%, ${lightness}%)`;
}

// The "family" a package belongs to, used to group siblings under one color/cluster.
// Almost every real project nests everything under one generic top segment (src, app,
// lib...), so using just that segment collapses the whole codebase into a single family -
// one hue, one cluster. Taking the first two segments instead (e.g. "src/components",
// "src/domain") gives each real module its own identity while still grouping deep siblings.
export function packageFamily(id: string): string {
  if (!id || id === "(root)") return "(root)";
  const parts = id.split("/");
  return parts.length > 1 ? parts.slice(0, 2).join("/") : parts[0];
}

// Siblings under the same family share a hue range so related packages read as a color
// group, but the exact folder gets its own bounded nudge off that base hue - otherwise
// every folder nested the same number of levels under a family (e.g. "src/domain/user"
// and "src/domain/billing") would render as one indistinguishable color.
export function familyColor(id: string): string {
  const family = packageFamily(id);
  if (id === family) return `hsl(${hashHue(family)}, 58%, 52%)`;
  const baseHue = hashHue(family);
  const leafHue = (baseHue + (hashHue(id) % 40) - 20 + 360) % 360;
  const depth = id.split("/").length - family.split("/").length;
  const lightness = Math.max(40, Math.min(70, 46 + depth * 4));
  return `hsl(${leafHue}, 58%, ${lightness}%)`;
}
