export function prettyName(value: string): string {
  return value
    // Project names are the absolute root path with "/" replaced by "-" - strip the
    // generic home-directory prefix ("Users-<name>-" on macOS, "home-<name>-" on Linux)
    // so the display name isn't tied to any one machine's username or folder layout.
    .replace(/^(Users|home)-[^-]+-/, "")
    .replaceAll("-", " / ");
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

// Top-level path segment - the "family" a package belongs to (e.g. "src/components/ui" -> "src").
export function packageFamily(id: string): string {
  if (!id || id === "(root)") return "(root)";
  const idx = id.indexOf("/");
  return idx === -1 ? id : id.slice(0, idx);
}

// Siblings under the same top-level family share a hue; deeper nesting gets lighter,
// so related packages read as a color group instead of unrelated random hues.
export function familyColor(id: string): string {
  const family = packageFamily(id);
  const depth = id === family ? 0 : id.split("/").length - 1;
  const lightness = Math.max(42, Math.min(72, 44 + depth * 7));
  return `hsl(${hashHue(family)}, 58%, ${lightness}%)`;
}
