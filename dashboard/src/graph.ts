import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type ForceLink,
  type Simulation,
  type SimulationNodeDatum
} from "d3-force";
import { drag, type D3DragEvent } from "d3-drag";
import { quadtree } from "d3-quadtree";
import { select, type Selection } from "d3-selection";
import "d3-transition";
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior, type ZoomTransform } from "d3-zoom";

import { clamp, colorForKey, familyColor, packageFamily, packageFromFile, truncate } from "./utils.js";
import type { GraphEdge, GraphNode } from "./types.js";

// Idle-state edge color - calm and neutral until something is hovered/selected.
const MUTED_EDGE_COLOR = "#6f827d";

export type SimNode = GraphNode &
  SimulationNodeDatum & {
    degree: number;
    // What "Size by Links" actually sizes nodes by - degree/count are near-identical for a
    // package with 100 symbols vs one with 5, so a second raw-degree mode barely reads as
    // different. This is a deliberately different signal: connection density for packages
    // (degree per symbol they contain), complexity for individual symbols (they don't
    // "contain" anything, so degree-per-symbol is undefined for them).
    secondaryMetric: number;
    radius: number;
    color: string;
    fx?: number | null;
    fy?: number | null;
  };

// d3-force replaces edge.source/target with the resolved node object once the link force
// initializes - both forms coexist over the object's lifetime, so every read site has to
// narrow with a typeof check (the original JS already did this defensively).
export type SimEdge = {
  type: string;
  count: number;
  source: SimNode | string;
  target: SimNode | string;
};

export type GraphCallbacks = {
  onSelectNode?: (node: SimNode) => void;
  onSelectEdge?: (edge: SimEdge) => void;
  onHoverNode?: (node: SimNode | null, pos?: { clientX: number; clientY: number }) => void;
  onBackgroundClick?: () => void;
  onZoomChange?: (scale: number) => void;
};

type Point = { x: number; y: number };

function idOf(value: SimNode | string | null | undefined): string {
  if (value == null) return "";
  return typeof value === "string" ? value : value.id;
}

function edgeKey(edge: SimEdge | null | undefined): string {
  if (!edge) return "";
  return `${idOf(edge.source)}→${idOf(edge.target)}:${edge.type}`;
}

function distanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lengthSq;
  t = clamp(t, 0, 1);
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

export class PackageGraph {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  onSelectNode: (node: SimNode) => void;
  onSelectEdge: (edge: SimEdge) => void;
  onHoverNode: (node: SimNode | null, pos?: { clientX: number; clientY: number }) => void;
  onBackgroundClick: () => void;
  onZoomChange: (scale: number) => void;

  nodes: SimNode[] = [];
  edges: SimEdge[] = [];
  visibleEdges: SimEdge[] = [];
  maxEdgeCount = 1;
  topDegreeIds: Set<string> = new Set();
  filters: { hiddenTypes: Set<string>; minWeight: number } = { hiddenTypes: new Set(), minWeight: 1 };
  typeColors: Map<string, string> = new Map();
  sizeMode: "count" | "degree" = "count";
  maxCountMetric = 1;
  maxSecondaryMetric = 1;
  nodeRadiusMin = 7;
  nodeRadiusMax = 36;
  edgeCurvature: "straight" | "curved" = "curved";
  reducedMotion = false;
  labelZoomThreshold = 1.3;
  isolate = false;
  layoutMode: "force" | "clustered" | "radial" | "grid" | "tree" = "clustered";
  _layoutTargets: Map<string, Point> = new Map();
  _clusterAnchors: Map<string, Point> = new Map();

  selectedNode: SimNode | null = null;
  selectedEdge: SimEdge | null = null;
  hoveredNode: SimNode | null = null;

  transform: ZoomTransform = zoomIdentity;
  dpr: number;
  width = 0;
  height = 0;
  rafId: number | null = null;
  autoFit = false;
  dragging = false;
  dragMoved = false;

  simulation: Simulation<SimNode, SimEdge>;
  selection: Selection<HTMLCanvasElement, unknown, null, undefined>;
  zoomBehavior!: ZoomBehavior<HTMLCanvasElement, unknown>;
  resizeObserver: ResizeObserver;

  constructor(canvas: HTMLCanvasElement, callbacks: GraphCallbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.onSelectNode = callbacks.onSelectNode ?? (() => {});
    this.onSelectEdge = callbacks.onSelectEdge ?? (() => {});
    this.onHoverNode = callbacks.onHoverNode ?? (() => {});
    this.onBackgroundClick = callbacks.onBackgroundClick ?? (() => {});
    this.onZoomChange = callbacks.onZoomChange ?? (() => {});

    this.dpr = Math.max(1, window.devicePixelRatio || 1);

    this.simulation = forceSimulation<SimNode, SimEdge>([])
      .force(
        "link",
        forceLink<SimNode, SimEdge>([])
          .id((d) => d.id)
          .distance((d) => 240 - Math.min(130, (d.count / this.maxEdgeCount) * 130))
          .strength(() => (this._isStructuredLayout() ? 0 : 0.22))
      )
      .force(
        "charge",
        forceManyBody<SimNode>().strength((d) => {
          if (this._isStructuredLayout()) return 0;
          const [base, cap, perDegree] = this.reducedMotion ? [-120, 300, 6] : [-300, 700, 16];
          return base - Math.min(cap, d.degree * perDegree);
        })
      )
      .force("collide", forceCollide<SimNode>().radius((d) => d.radius + 26))
      .force("center", forceCenter<SimNode>(0, 0))
      .force(
        "x",
        forceX<SimNode>((d) => this._layoutTargetX(d)).strength(() => this._layoutStrength())
      )
      .force(
        "y",
        forceY<SimNode>((d) => this._layoutTargetY(d)).strength(() => this._layoutStrength())
      )
      .alphaDecay(0.015)
      .on("tick", () => {
        if (this.autoFit) this.fit(60, 0);
        this.requestRender();
      });
    this.simulation.stop();

    this.selection = select(canvas);
    this._setupZoom();
    this._setupDrag();
    this._setupPointerEvents();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  setData(nodes: GraphNode[], edges: GraphEdge[]): void {
    const degree = new Map<string, number>(nodes.map((node) => [node.id, 0]));
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + edge.count);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + edge.count);
    }

    const previous = new Map(this.nodes.map((node) => [node.id, node]));

    this.maxCountMetric = Math.max(1, ...nodes.map((node) => node.count ?? 0));

    const secondaryOf = (node: GraphNode, deg: number): number => {
      if (node.kind === "package") return deg / Math.max(1, node.count ?? 1);
      const meta = node.meta;
      return meta?.complexity ?? meta?.cognitive ?? meta?.lines ?? deg;
    };
    this.maxSecondaryMetric = Math.max(1, ...nodes.map((node) => secondaryOf(node, degree.get(node.id) ?? 0)));

    this.nodes = nodes.map((node) => {
      const prev = previous.get(node.id);
      const deg = degree.get(node.id) ?? 0;
      const secondaryMetric = secondaryOf(node, deg);
      return {
        ...node,
        degree: deg,
        secondaryMetric,
        radius: this._radiusFor(node.count, secondaryMetric),
        color: familyColor(this._familyPathOf(node)),
        x: prev?.x ?? (Math.random() - 0.5) * 320,
        y: prev?.y ?? (Math.random() - 0.5) * 320,
        vx: prev?.vx ?? 0,
        vy: prev?.vy ?? 0,
        fx: prev?.fx ?? null,
        fy: prev?.fy ?? null
      };
    });

    this.topDegreeIds = new Set(
      [...this.nodes]
        .sort((a, b) => b.degree - a.degree)
        .slice(0, Math.min(12, this.nodes.length))
        .map((node) => node.id)
    );

    this.maxEdgeCount = Math.max(1, ...edges.map((edge) => edge.count));
    this.edges = edges.map((edge) => ({ ...edge }));
    this.filters.minWeight = 1;

    const selectedId = this.selectedNode?.id;
    this.selectedNode = selectedId ? (this.nodes.find((node) => node.id === selectedId) ?? null) : null;
    this.selectedEdge = null;
    this.hoveredNode = null;

    this._applyFilters();
    this._applyLayoutTargets();

    this.simulation.nodes(this.nodes);
    (this.simulation.force("link") as ForceLink<SimNode, SimEdge>).links(this.visibleEdges);
    this.autoFit = true;
    this.simulation.alpha(1).restart();
    this.requestRender();
  }

  setFilters(partial: Partial<{ hiddenTypes: Set<string>; minWeight: number }>): void {
    this.filters = { ...this.filters, ...partial };
    this._applyFilters();
    (this.simulation.force("link") as ForceLink<SimNode, SimEdge>).links(this.visibleEdges);
    this.simulation.alpha(0.6).restart();
    this.requestRender();
  }

  setSizeMode(mode: "count" | "degree"): void {
    if (mode !== "count" && mode !== "degree") return;
    this.sizeMode = mode;
    for (const node of this.nodes) {
      node.radius = this._radiusFor(node.count, node.secondaryMetric);
    }
    this.simulation.force<ReturnType<typeof forceCollide<SimNode>>>("collide")?.radius((d) => d.radius + 16);
    this.simulation.alpha(0.4).restart();
    this.requestRender();
  }

  setIsolate(enabled: boolean): void {
    this.isolate = Boolean(enabled);
    this.requestRender();
  }

  setOptions(
    partial: Partial<{
      nodeRadiusMin: number;
      nodeRadiusMax: number;
      edgeCurvature: "straight" | "curved";
      reducedMotion: boolean;
      labelZoomThreshold: number;
    }>
  ): void {
    const radiusChanged =
      (partial.nodeRadiusMin !== undefined && partial.nodeRadiusMin !== this.nodeRadiusMin) ||
      (partial.nodeRadiusMax !== undefined && partial.nodeRadiusMax !== this.nodeRadiusMax);
    Object.assign(this, partial);
    if (radiusChanged) {
      for (const node of this.nodes) {
        node.radius = this._radiusFor(node.count, node.secondaryMetric);
      }
      this.simulation.force<ReturnType<typeof forceCollide<SimNode>>>("collide")?.radius((d) => d.radius + 16);
      this.simulation.alpha(0.3).restart();
    }
    this.requestRender();
  }

  setLayoutMode(mode: string): void {
    if (!["force", "clustered", "radial", "grid", "tree"].includes(mode)) return;
    this.layoutMode = mode as typeof this.layoutMode;
    this._applyLayoutTargets();
    // Force accessors (link/charge/x/y strength+target) are cached per-node by d3-force at
    // initialize() time - re-registering nodes is what forces every force to re-read them.
    this.simulation.nodes(this.nodes);
    (this.simulation.force("link") as ForceLink<SimNode, SimEdge>).links(this.visibleEdges);
    this.autoFit = true;
    this.simulation.alpha(1).restart();
    this.requestRender();
  }

  getEdgeTypeColor(type: string): string {
    return this._typeColor(type);
  }

  getEdgeTypeCounts(): Array<{ type: string; count: number }> {
    const counts = new Map<string, number>();
    for (const edge of this.edges) {
      counts.set(edge.type, (counts.get(edge.type) ?? 0) + edge.count);
    }
    return [...counts.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);
  }

  focusNode(node: SimNode | null): void {
    this.selectedNode = node ?? null;
    this.selectedEdge = null;
    this.requestRender();
  }

  focusEdge(edge: SimEdge | null): void {
    this.selectedEdge = edge ?? null;
    this.requestRender();
  }

  clearSelection(): void {
    this.selectedNode = null;
    this.selectedEdge = null;
    this.requestRender();
  }

  _effectiveDuration(duration: number): number {
    return this.reducedMotion ? 0 : duration;
  }

  zoomBy(factor: number, duration = 200): void {
    this.autoFit = false;
    this.selection
      .transition()
      .duration(this._effectiveDuration(duration))
      .call(this.zoomBehavior.scaleBy as never, factor);
  }

  zoomReset(duration = 200): void {
    this.autoFit = false;
    this.selection
      .transition()
      .duration(this._effectiveDuration(duration))
      .call(this.zoomBehavior.scaleTo as never, 1);
  }

  fit(padding = 60, duration = 320, subset: SimNode[] = this.nodes): void {
    if (!subset.length || !this.width || !this.height) return;

    const xs = subset.map((node) => node.x ?? 0);
    const ys = subset.map((node) => node.y ?? 0);
    const minX = Math.min(...xs) - padding;
    const maxX = Math.max(...xs) + padding;
    const minY = Math.min(...ys) - padding;
    const maxY = Math.max(...ys) + padding;
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const scale = clamp(Math.min(this.width / w, this.height / h), 0.04, 2.5);
    const tx = this.width / 2 - scale * ((minX + maxX) / 2);
    const ty = this.height / 2 - scale * ((minY + maxY) / 2);
    const target = zoomIdentity.translate(tx, ty).scale(scale);
    const effectiveDuration = this._effectiveDuration(duration);

    if (effectiveDuration > 0) {
      this.selection.transition().duration(effectiveDuration).call(this.zoomBehavior.transform as never, target);
    } else {
      this.selection.call(this.zoomBehavior.transform as never, target);
    }
  }

  centerOn(node: SimNode | null, { padding = 200, duration = 420 }: { padding?: number; duration?: number } = {}): void {
    if (!node) return;
    this.autoFit = false;
    const neighbors = this._neighborSet(node);
    const subset = this.nodes.filter((candidate) => neighbors?.has(candidate.id));
    this.fit(padding, duration, subset);
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.requestRender();
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    this.simulation.stop();
    if (this.rafId) cancelAnimationFrame(this.rafId);
  }

  requestRender(): void {
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this._draw();
    });
  }

  _applyFilters(): void {
    const { hiddenTypes, minWeight } = this.filters;
    this.visibleEdges = this.edges.filter((edge) => !hiddenTypes.has(edge.type) && edge.count >= minWeight);
  }

  _typeColor(type: string): string {
    if (!this.typeColors.has(type)) {
      this.typeColors.set(type, colorForKey(type, { saturation: 72, lightness: 62 }));
    }
    return this.typeColors.get(type)!;
  }

  _radiusFor(count: number | undefined, secondaryMetric: number): number {
    const minRadius = this.nodeRadiusMin;
    const maxRadius = Math.max(minRadius + 1, this.nodeRadiusMax);
    const metric = this.sizeMode === "degree" ? secondaryMetric : (count ?? 0);
    const maxMetric = this.sizeMode === "degree" ? this.maxSecondaryMetric : this.maxCountMetric;
    if (maxMetric <= 0) return minRadius;
    // Relative to the largest node currently in view, so the biggest hubs read as
    // clearly biggest instead of everything past a small metric flattening to one size.
    const t = Math.sqrt(Math.min(metric, maxMetric) / maxMetric);
    return minRadius + t * (maxRadius - minRadius);
  }

  _isStructuredLayout(): boolean {
    return this.layoutMode === "radial" || this.layoutMode === "grid" || this.layoutMode === "tree";
  }

  // Packages are keyed by their own id (a slash-delimited folder path); symbols have no
  // such path as their id (a dot-delimited qualified name), so family/depth grouping for
  // them is derived from their containing file's package instead.
  _familyPathOf(node: GraphNode): string {
    return node.kind === "package" ? node.id : packageFromFile(node.file) || "(root)";
  }

  _layoutTargetX(node: SimNode): number {
    if (this.layoutMode === "clustered") return this._clusterAnchors.get(packageFamily(this._familyPathOf(node)))?.x ?? 0;
    if (this._isStructuredLayout()) return this._layoutTargets.get(node.id)?.x ?? 0;
    return 0;
  }

  _layoutTargetY(node: SimNode): number {
    if (this.layoutMode === "clustered") return this._clusterAnchors.get(packageFamily(this._familyPathOf(node)))?.y ?? 0;
    if (this._isStructuredLayout()) return this._layoutTargets.get(node.id)?.y ?? 0;
    return 0;
  }

  _layoutStrength(): number {
    if (this.layoutMode === "clustered") return 0.12;
    if (this._isStructuredLayout()) return 0.9;
    return 0.02;
  }

  _applyLayoutTargets(): void {
    if (this.layoutMode === "clustered") {
      this._clusterAnchors = this._computeClusterAnchors();
    } else if (this.layoutMode === "radial") {
      this._layoutTargets = this._computeRadialTargets();
    } else if (this.layoutMode === "grid") {
      this._layoutTargets = this._computeGridTargets();
    } else if (this.layoutMode === "tree") {
      this._layoutTargets = this._computeTreeTargets();
    }
  }

  _computeClusterAnchors(): Map<string, Point> {
    const families = [...new Set(this.nodes.map((node) => packageFamily(this._familyPathOf(node))))].sort();
    const radius = Math.max(220, families.length * 70);
    const map = new Map<string, Point>();
    families.forEach((family, index) => {
      const angle = (index / families.length) * Math.PI * 2;
      map.set(family, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
    });
    return map;
  }

  _computeRadialTargets(): Map<string, Point> {
    const sorted = [...this.nodes].sort((a, b) => a.id.localeCompare(b.id));
    const totalDiameter = sorted.reduce((sum, node) => sum + node.radius * 2 + 10, 0);
    const radius = Math.max(160, totalDiameter / (Math.PI * 2));
    const map = new Map<string, Point>();
    sorted.forEach((node, index) => {
      const angle = (index / sorted.length) * Math.PI * 2 - Math.PI / 2;
      map.set(node.id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
    });
    return map;
  }

  _computeGridTargets(): Map<string, Point> {
    const sorted = [...this.nodes].sort((a, b) => a.id.localeCompare(b.id));
    const maxRadius = Math.max(10, ...sorted.map((node) => node.radius));
    const spacing = maxRadius * 2 + 30;
    const cols = Math.max(1, Math.ceil(Math.sqrt(sorted.length)));
    const rows = Math.max(1, Math.ceil(sorted.length / cols));
    const map = new Map<string, Point>();
    sorted.forEach((node, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      map.set(node.id, {
        x: (col - (cols - 1) / 2) * spacing,
        y: (row - (rows - 1) / 2) * spacing
      });
    });
    return map;
  }

  // Packages mode has real folder nodes to nest against; Symbols mode doesn't (a symbol's id
  // is a dot-delimited qualified name, not a path), so it needs the folder hierarchy
  // synthesized from each symbol's file path instead.
  _computeTreeTargets(): Map<string, Point> {
    const allPackageNodes = this.nodes.every((node) => node.kind === "package");
    return allPackageNodes ? this._computeTreeTargetsFromRealNodes() : this._computeTreeTargetsFromFolders();
  }

  // Real folder nodes only - each attaches to its nearest existing ancestor package (there's
  // often no real node for an intermediate folder, e.g. "src/components" when every file
  // lives one level deeper). Depth -> horizontal, DFS leaf order -> vertical.
  _computeTreeTargetsFromRealNodes(): Map<string, Point> {
    const ids = this.nodes.map((node) => node.id);
    const idSet = new Set(ids);
    const parentOf = new Map<string, string | null>();

    for (const id of ids) {
      let cursor = id;
      let parent: string | null = null;
      while (true) {
        const idx = cursor.lastIndexOf("/");
        if (idx === -1) break;
        cursor = cursor.slice(0, idx);
        if (idSet.has(cursor) && cursor !== id) {
          parent = cursor;
          break;
        }
      }
      parentOf.set(id, parent);
    }

    const childrenOf = new Map<string, string[]>(ids.map((id) => [id, []]));
    for (const id of ids) {
      const parent = parentOf.get(id);
      if (parent) childrenOf.get(parent)?.push(id);
    }
    const roots = ids.filter((id) => !parentOf.get(id)).sort();

    let leafIndex = 0;
    const yOf = new Map<string, number>();
    const depthOf = new Map<string, number>();

    const visit = (id: string, depth: number): void => {
      depthOf.set(id, depth);
      const children = [...(childrenOf.get(id) ?? [])].sort();
      if (!children.length) {
        yOf.set(id, leafIndex++);
        return;
      }
      for (const child of children) visit(child, depth + 1);
      const childYs = children.map((child) => yOf.get(child) ?? 0);
      yOf.set(id, (Math.min(...childYs) + Math.max(...childYs)) / 2);
    };
    for (const root of roots) visit(root, 0);

    const maxDepth = Math.max(1, ...[...depthOf.values()]);
    const depthSpan = Math.max(1, this.width - 240);
    const leafSpan = Math.max(1, leafIndex - 1);
    const rowHeight = Math.max(46, Math.min(90, (this.height - 120) / Math.max(1, leafSpan)));

    const map = new Map<string, Point>();
    for (const id of ids) {
      const depth = depthOf.get(id) ?? 0;
      const y = yOf.get(id) ?? 0;
      map.set(id, {
        x: (depth / maxDepth) * depthSpan - depthSpan / 2,
        y: (y - leafSpan / 2) * rowHeight
      });
    }
    return map;
  }

  // Every node here hangs off its file's folder, but none of those folders exist as real
  // nodes - the whole chain (root -> every intermediate segment -> the node's own folder)
  // is synthesized purely to compute a position, so folders never get map entries of their own.
  _computeTreeTargetsFromFolders(): Map<string, Point> {
    type FolderEntry = { children: Set<string>; leaves: SimNode[] };
    const folders = new Map<string, FolderEntry>();
    const ensureFolder = (path: string): FolderEntry => {
      let entry = folders.get(path);
      if (!entry) {
        entry = { children: new Set(), leaves: [] };
        folders.set(path, entry);
      }
      return entry;
    };

    const ROOT = "(root)";
    ensureFolder(ROOT);
    for (const node of this.nodes) {
      const folderPath = this._familyPathOf(node);
      const segments = folderPath === ROOT ? [] : folderPath.split("/");
      let cursor = ROOT;
      for (const segment of segments) {
        const next = cursor === ROOT ? segment : `${cursor}/${segment}`;
        ensureFolder(next);
        ensureFolder(cursor).children.add(next);
        cursor = next;
      }
      ensureFolder(cursor).leaves.push(node);
    }

    let leafIndex = 0;
    const yOf = new Map<string, number>();
    const depthOf = new Map<string, number>();

    const visitFolder = (path: string, depth: number): void => {
      const entry = folders.get(path)!;
      for (const child of [...entry.children].sort()) visitFolder(child, depth + 1);
      for (const leaf of [...entry.leaves].sort((a, b) => a.label.localeCompare(b.label))) {
        depthOf.set(leaf.id, depth + 1);
        yOf.set(leaf.id, leafIndex++);
      }
    };
    visitFolder(ROOT, 0);

    const maxDepth = Math.max(1, ...[...depthOf.values()]);
    const depthSpan = Math.max(1, this.width - 240);
    const leafSpan = Math.max(1, leafIndex - 1);
    const rowHeight = Math.max(46, Math.min(90, (this.height - 120) / Math.max(1, leafSpan)));

    const map = new Map<string, Point>();
    for (const node of this.nodes) {
      const depth = depthOf.get(node.id) ?? 0;
      const y = yOf.get(node.id) ?? 0;
      map.set(node.id, {
        x: (depth / maxDepth) * depthSpan - depthSpan / 2,
        y: (y - leafSpan / 2) * rowHeight
      });
    }
    return map;
  }

  _toGraphCoords(px: number, py: number): [number, number] {
    return [(px - this.transform.x) / this.transform.k, (py - this.transform.y) / this.transform.k];
  }

  _pointerPos(event: { clientX: number; clientY: number }): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  _findNode(x: number, y: number): SimNode | null {
    if (!this.nodes.length) return null;
    const tree = quadtree<SimNode>(
      this.nodes,
      (node) => node.x ?? 0,
      (node) => node.y ?? 0
    );
    const searchRadius = 26 / this.transform.k;
    let found: SimNode | null = null;
    let bestDist = Infinity;
    tree.visit((node, x0, y0, x1, y1) => {
      if (!("length" in node)) {
        let candidate: typeof node | undefined = node;
        do {
          const data = candidate.data;
          const dx = (data.x ?? 0) - x;
          const dy = (data.y ?? 0) - y;
          const dist = Math.hypot(dx, dy);
          if (dist <= Math.max(data.radius, searchRadius) && dist < bestDist) {
            bestDist = dist;
            found = data;
          }
          candidate = candidate.next;
        } while (candidate);
      }
      return x0 > x + searchRadius || x1 < x - searchRadius || y0 > y + searchRadius || y1 < y - searchRadius;
    });
    return found;
  }

  _findEdge(x: number, y: number): SimEdge | null {
    const threshold = 8 / this.transform.k;
    let found: SimEdge | null = null;
    let bestDist = Infinity;
    for (const edge of this.visibleEdges) {
      const s = edge.source;
      const t = edge.target;
      if (!s || typeof s === "string" || !t || typeof t === "string") continue;
      const dist = distanceToSegment(x, y, s.x ?? 0, s.y ?? 0, t.x ?? 0, t.y ?? 0);
      if (dist <= threshold && dist < bestDist) {
        bestDist = dist;
        found = edge;
      }
    }
    return found;
  }

  _neighborSet(node: SimNode | null): Set<string> | null {
    if (!node) return null;
    const set = new Set<string>([node.id]);
    for (const edge of this.visibleEdges) {
      const sourceId = idOf(edge.source);
      const targetId = idOf(edge.target);
      if (sourceId === node.id) set.add(targetId);
      if (targetId === node.id) set.add(sourceId);
    }
    return set;
  }

  _setupZoom(): void {
    this.zoomBehavior = zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.04, 6])
      .filter((event: Event) => {
        if (event.type === "wheel") return true;
        if ((event as MouseEvent).button) return false;
        const touchEvent = event as TouchEvent;
        const rect = this.canvas.getBoundingClientRect();
        const [px, py] = touchEvent.touches?.length
          ? [touchEvent.touches[0].clientX - rect.left, touchEvent.touches[0].clientY - rect.top]
          : this._pointerPos(event as MouseEvent);
        const [x, y] = this._toGraphCoords(px, py);
        return !this._findNode(x, y);
      })
      .on("start", (event: D3ZoomEvent<HTMLCanvasElement, unknown>) => {
        if (event.sourceEvent) this.autoFit = false;
      })
      .on("zoom", (event: D3ZoomEvent<HTMLCanvasElement, unknown>) => {
        this.transform = event.transform;
        this.onZoomChange(event.transform.k);
        this.requestRender();
      });

    this.selection.call(this.zoomBehavior);
  }

  _setupDrag(): void {
    const dragSubject = (event: D3DragEvent<HTMLCanvasElement, unknown, SimNode | undefined>): SimNode | undefined => {
      const [px, py] = this._pointerPos(event.sourceEvent as MouseEvent);
      const [x, y] = this._toGraphCoords(px, py);
      const node = this._findNode(x, y);
      if (node) {
        node.x = node.fx ?? node.x;
        node.y = node.fy ?? node.y;
      }
      return node ?? undefined;
    };

    const behavior = drag<HTMLCanvasElement, unknown, SimNode | undefined>()
      .subject(dragSubject)
      .on("start", (event: D3DragEvent<HTMLCanvasElement, unknown, SimNode>) => {
        this.autoFit = false;
        this.dragging = true;
        this.dragMoved = false;
        if (!event.active) this.simulation.alphaTarget(0.3).restart();
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
      })
      .on("drag", (event: D3DragEvent<HTMLCanvasElement, unknown, SimNode>) => {
        this.dragMoved = true;
        const [px, py] = this._pointerPos(event.sourceEvent as MouseEvent);
        const [x, y] = this._toGraphCoords(px, py);
        event.subject.fx = x;
        event.subject.fy = y;
        this.requestRender();
      })
      .on("end", (event: D3DragEvent<HTMLCanvasElement, unknown, SimNode>) => {
        this.dragging = false;
        if (!event.active) this.simulation.alphaTarget(0);
      });

    this.selection.call(behavior);
  }

  _setupPointerEvents(): void {
    this.canvas.addEventListener("pointermove", (event: PointerEvent) => {
      if (this.dragging) return;
      const [px, py] = this._pointerPos(event);
      const [x, y] = this._toGraphCoords(px, py);
      const node = this._findNode(x, y);
      if (node !== this.hoveredNode) {
        this.hoveredNode = node;
        this.canvas.style.cursor = node ? "pointer" : "grab";
        this.requestRender();
      }
      this.onHoverNode(node, { clientX: event.clientX, clientY: event.clientY });
    });

    this.canvas.addEventListener("pointerleave", () => {
      if (this.hoveredNode) {
        this.hoveredNode = null;
        this.requestRender();
      }
      this.onHoverNode(null);
    });

    // Native click/dblclick are unreliable here: d3-zoom swallows the click
    // event that follows any mouse-based pan gesture, even a zero-movement
    // one, so clicks are detected manually from pointerdown/pointerup instead.
    let downPos: [number, number] | null = null;
    let lastUp: { time: number; x: number; y: number } | null = null;

    this.canvas.addEventListener("pointerdown", (event: PointerEvent) => {
      if (event.button) return;
      downPos = [event.clientX, event.clientY];
    });

    this.canvas.addEventListener("pointerup", (event: PointerEvent) => {
      if (!downPos) return;
      const moved = Math.hypot(event.clientX - downPos[0], event.clientY - downPos[1]);
      downPos = null;

      if (this.dragMoved) {
        this.dragMoved = false;
        return;
      }
      if (moved > 5) return;

      const [px, py] = this._pointerPos(event);
      const [x, y] = this._toGraphCoords(px, py);
      const node = this._findNode(x, y);

      const now = performance.now();
      const isDoubleClick =
        lastUp !== null && now - lastUp.time < 320 && Math.hypot(event.clientX - lastUp.x, event.clientY - lastUp.y) < 6;
      lastUp = { time: now, x: event.clientX, y: event.clientY };

      if (isDoubleClick) {
        if (node) {
          node.fx = null;
          node.fy = null;
          this.simulation.alpha(0.4).restart();
        }
        return;
      }

      if (node) {
        this.selectedNode = node;
        this.selectedEdge = null;
        this.requestRender();
        this.onSelectNode(node);
        return;
      }

      const edge = this._findEdge(x, y);
      if (edge) {
        this.selectedEdge = edge;
        this.requestRender();
        this.onSelectEdge(edge);
        return;
      }

      this.onBackgroundClick();
    });
  }

  _draw(): void {
    const { ctx, dpr, transform } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (!this.nodes.length) return;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);

    const isolateSet = this.isolate && this.selectedNode ? this._neighborSet(this.selectedNode) : null;
    const hoverSet = this._neighborSet(this.hoveredNode ?? this.selectedNode);
    const focused = Boolean(hoverSet);
    const reciprocal = new Set<string>();
    const seen = new Set<string>();
    for (const edge of this.visibleEdges) {
      seen.add(`${idOf(edge.source)}|${idOf(edge.target)}`);
    }
    for (const edge of this.visibleEdges) {
      if (seen.has(`${idOf(edge.target)}|${idOf(edge.source)}`)) {
        reciprocal.add(`${idOf(edge.source)}|${idOf(edge.target)}`);
      }
    }

    for (const edge of this.visibleEdges) {
      const s = edge.source;
      const t = edge.target;
      if (!s || typeof s === "string" || !t || typeof t === "string") continue;
      if (isolateSet && !(isolateSet.has(s.id) && isolateSet.has(t.id))) continue;

      const isNeighbor = hoverSet ? hoverSet.has(s.id) && hoverSet.has(t.id) : false;
      const active = edgeKey(edge) === edgeKey(this.selectedEdge);
      // Every edge gets a gentle arc (not just reciprocal pairs) so a dense graph reads as
      // a web rather than a ruler-straight tangle; reciprocal pairs arc further apart.
      const curvature =
        this.edgeCurvature === "straight"
          ? 0
          : reciprocal.has(`${s.id}|${t.id}`)
            ? s.id < t.id
              ? 18
              : -18
            : s.id < t.id
              ? 9
              : -9;
      const weight = clamp(0.6 + (edge.count / this.maxEdgeCount) * 1.8, 0.6, 2.4);

      let strokeStyle: string;
      let alpha: number;
      let lineWidth: number;
      if (active) {
        strokeStyle = "#4fd1c5";
        alpha = 0.95;
        lineWidth = weight + 1.2;
      } else if (focused && isNeighbor) {
        strokeStyle = this._typeColor(edge.type);
        alpha = 0.85;
        lineWidth = weight + 0.8;
      } else if (focused) {
        strokeStyle = this._typeColor(edge.type);
        alpha = 0.06;
        lineWidth = weight;
      } else {
        strokeStyle = MUTED_EDGE_COLOR;
        alpha = 0.28;
        lineWidth = weight;
      }

      const sx = s.x ?? 0;
      const sy = s.y ?? 0;
      const tx = t.x ?? 0;
      const ty = t.y ?? 0;
      const mx = (sx + tx) / 2;
      const my = (sy + ty) / 2;
      const dx = tx - sx;
      const dy = ty - sy;
      const len = Math.hypot(dx, dy) || 1;
      const cx = mx + (-dy / len) * curvature;
      const cy = my + (dx / len) * curvature;

      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(cx, cy, tx, ty);
      ctx.strokeStyle = strokeStyle;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = lineWidth;
      ctx.lineCap = "round";
      ctx.stroke();

      const angle = Math.atan2(ty - cy, tx - cx);
      const tipX = tx - Math.cos(angle) * (t.radius + 1);
      const tipY = ty - Math.sin(angle) * (t.radius + 1);
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - Math.cos(angle - 0.42) * 6, tipY - Math.sin(angle - 0.42) * 6);
      ctx.lineTo(tipX - Math.cos(angle + 0.42) * 6, tipY - Math.sin(angle + 0.42) * 6);
      ctx.closePath();
      ctx.fillStyle = strokeStyle;
      ctx.fill();
    }

    ctx.globalAlpha = 1;

    for (const node of this.nodes) {
      if (isolateSet && !isolateSet.has(node.id)) continue;
      const dimmed = hoverSet ? !hoverSet.has(node.id) : false;
      const isActive = this.selectedNode?.id === node.id || this.hoveredNode?.id === node.id;
      const nx = node.x ?? 0;
      const ny = node.y ?? 0;

      ctx.globalAlpha = dimmed ? 0.22 : 1;
      ctx.beginPath();
      ctx.arc(nx, ny, node.radius, 0, Math.PI * 2);
      ctx.fillStyle = node.color;
      ctx.fill();
      ctx.lineWidth = isActive ? 2.5 : 1.2;
      ctx.strokeStyle = isActive ? "#e9fbf8" : "rgba(8, 12, 12, 0.55)";
      ctx.stroke();

      if (node.fx != null) {
        ctx.beginPath();
        ctx.arc(nx, ny, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = "#0b0e0e";
        ctx.fill();
      }

      const showLabel = hoverSet
        ? hoverSet.has(node.id)
        : transform.k >= this.labelZoomThreshold || this.topDegreeIds.has(node.id);

      if (showLabel && !dimmed) {
        const label = truncate(node.label, 26);
        ctx.font = "600 11px Inter, ui-sans-serif, system-ui, sans-serif";
        ctx.textBaseline = "middle";
        const textX = nx + node.radius + 8;
        const metrics = ctx.measureText(label);
        ctx.fillStyle = "rgba(8, 12, 12, 0.72)";
        ctx.fillRect(textX - 3, ny - 8, metrics.width + 6, 16);
        ctx.fillStyle = "#f4f7f6";
        ctx.fillText(label, textX, ny);
      }
    }

    ctx.restore();
  }
}
