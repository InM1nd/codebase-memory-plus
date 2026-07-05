export function prettyName(value) {
  return value
    .replace(/^Users-oleksandrzabolotnyi-Documents-Project-/, "")
    .replace(/^Users-oleksandrzabolotnyi-\.superset-worktrees-/, "")
    .replaceAll("-", " / ");
}

export function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value ?? 0);
}

export function edgeKey(edge) {
  if (!edge) return "";
  return `${edge.source}→${edge.target}:${edge.type}`;
}

export function packageFromFile(file) {
  if (!file) return "";
  const idx = file.lastIndexOf("/");
  return idx === -1 ? "(root)" : file.slice(0, idx);
}

export function truncate(value, max) {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Deterministic hash -> hue, stable across reloads without a backend cluster lookup.
function hashHue(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash << 5) - hash + key.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}

export function colorForKey(key, { saturation = 62, lightness = 52 } = {}) {
  return `hsl(${hashHue(key)}, ${saturation}%, ${lightness}%)`;
}

// Top-level path segment - the "family" a package belongs to (e.g. "src/components/ui" -> "src").
export function packageFamily(id) {
  if (!id || id === "(root)") return "(root)";
  const idx = id.indexOf("/");
  return idx === -1 ? id : id.slice(0, idx);
}

// Siblings under the same top-level family share a hue; deeper nesting gets lighter,
// so related packages read as a color group instead of unrelated random hues.
export function familyColor(id) {
  const family = packageFamily(id);
  const depth = id === family ? 0 : id.split("/").length - 1;
  const lightness = Math.max(42, Math.min(72, 44 + depth * 7));
  return `hsl(${hashHue(family)}, 58%, ${lightness}%)`;
}
