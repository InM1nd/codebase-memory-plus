import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import { drag } from "d3-drag";
import { quadtree } from "d3-quadtree";
import { select } from "d3-selection";
import "d3-transition";
import { zoom, zoomIdentity } from "d3-zoom";

import { clamp, colorForKey, familyColor, packageFamily, packageFromFile, truncate } from "./utils.js";

// Idle-state edge color - calm and neutral until something is hovered/selected.
const MUTED_EDGE_COLOR = "#6f827d";

function idOf(value) {
  return typeof value === "string" ? value : value?.id;
}

function edgeKey(edge) {
  if (!edge) return "";
  return `${idOf(edge.source)}→${idOf(edge.target)}:${edge.type}`;
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
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
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onSelectNode = callbacks.onSelectNode ?? (() => {});
    this.onSelectEdge = callbacks.onSelectEdge ?? (() => {});
    this.onHoverNode = callbacks.onHoverNode ?? (() => {});
    this.onBackgroundClick = callbacks.onBackgroundClick ?? (() => {});

    this.nodes = [];
    this.edges = [];
    this.visibleEdges = [];
    this.maxEdgeCount = 1;
    this.topDegreeIds = new Set();
    this.filters = { hiddenTypes: new Set(), minWeight: 1 };
    this.typeColors = new Map();
    this.sizeMode = "count";
    this.isolate = false;
    this.layoutMode = "clustered";
    this._layoutTargets = new Map();
    this._clusterAnchors = new Map();

    this.selectedNode = null;
    this.selectedEdge = null;
    this.hoveredNode = null;

    this.transform = zoomIdentity;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.width = 0;
    this.height = 0;
    this.rafId = null;
    this.autoFit = false;
    this.dragging = false;
    this.dragMoved = false;

    this.simulation = forceSimulation([])
      .force(
        "link",
        forceLink([])
          .id((d) => d.id)
          .distance((d) => 240 - Math.min(130, (d.count / this.maxEdgeCount) * 130))
          .strength(() => (this._isStructuredLayout() ? 0 : 0.22))
      )
      .force(
        "charge",
        forceManyBody().strength((d) =>
          this._isStructuredLayout() ? 0 : -300 - Math.min(700, d.degree * 16)
        )
      )
      .force("collide", forceCollide().radius((d) => d.radius + 26))
      .force("center", forceCenter(0, 0))
      .force("x", forceX((d) => this._layoutTargetX(d)).strength((d) => this._layoutStrength(d)))
      .force("y", forceY((d) => this._layoutTargetY(d)).strength((d) => this._layoutStrength(d)))
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

  setData(nodes, edges) {
    const degree = new Map(nodes.map((node) => [node.id, 0]));
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + edge.count);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + edge.count);
    }

    const previous = new Map(this.nodes.map((node) => [node.id, node]));

    this.nodes = nodes.map((node) => {
      const prev = previous.get(node.id);
      const deg = degree.get(node.id) ?? 0;
      return {
        ...node,
        degree: deg,
        radius: this._radiusFor(node.count, deg),
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
    this.selectedNode = selectedId ? this.nodes.find((node) => node.id === selectedId) ?? null : null;
    this.selectedEdge = null;
    this.hoveredNode = null;

    this._applyFilters();
    this._applyLayoutTargets();

    this.simulation.nodes(this.nodes);
    this.simulation.force("link").links(this.visibleEdges);
    this.autoFit = true;
    this.simulation.alpha(1).restart();
    this.requestRender();
  }

  setFilters(partial) {
    this.filters = { ...this.filters, ...partial };
    this._applyFilters();
    this.simulation.force("link").links(this.visibleEdges);
    this.simulation.alpha(0.6).restart();
    this.requestRender();
  }

  setSizeMode(mode) {
    if (mode !== "count" && mode !== "degree") return;
    this.sizeMode = mode;
    for (const node of this.nodes) {
      node.radius = this._radiusFor(node.count, node.degree);
    }
    this.simulation.force("collide").radius((d) => d.radius + 16);
    this.simulation.alpha(0.4).restart();
    this.requestRender();
  }

  setIsolate(enabled) {
    this.isolate = Boolean(enabled);
    this.requestRender();
  }

  setLayoutMode(mode) {
    if (!["force", "clustered", "radial", "grid", "tree"].includes(mode)) return;
    this.layoutMode = mode;
    this._applyLayoutTargets();
    // Force accessors (link/charge/x/y strength+target) are cached per-node by d3-force at
    // initialize() time - re-registering nodes is what forces every force to re-read them.
    this.simulation.nodes(this.nodes);
    this.simulation.force("link").links(this.visibleEdges);
    this.autoFit = true;
    this.simulation.alpha(1).restart();
    this.requestRender();
  }

  getEdgeTypeColor(type) {
    return this._typeColor(type);
  }

  getEdgeTypeCounts() {
    const counts = new Map();
    for (const edge of this.edges) {
      counts.set(edge.type, (counts.get(edge.type) ?? 0) + edge.count);
    }
    return [...counts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);
  }

  focusNode(node) {
    this.selectedNode = node ?? null;
    this.selectedEdge = null;
    this.requestRender();
  }

  focusEdge(edge) {
    this.selectedEdge = edge ?? null;
    this.requestRender();
  }

  clearSelection() {
    this.selectedNode = null;
    this.selectedEdge = null;
    this.requestRender();
  }

  fit(padding = 60, duration = 320, subset = this.nodes) {
    if (!subset.length || !this.width || !this.height) return;

    const xs = subset.map((node) => node.x);
    const ys = subset.map((node) => node.y);
    const minX = Math.min(...xs) - padding;
    const maxX = Math.max(...xs) + padding;
    const minY = Math.min(...ys) - padding;
    const maxY = Math.max(...ys) + padding;
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const scale = clamp(Math.min(this.width / w, this.height / h), 0.15, 2.5);
    const tx = this.width / 2 - scale * ((minX + maxX) / 2);
    const ty = this.height / 2 - scale * ((minY + maxY) / 2);
    const target = zoomIdentity.translate(tx, ty).scale(scale);

    if (duration > 0) {
      this.selection.transition().duration(duration).call(this.zoomBehavior.transform, target);
    } else {
      this.selection.call(this.zoomBehavior.transform, target);
    }
  }

  centerOn(node, { padding = 200, duration = 420 } = {}) {
    if (!node) return;
    this.autoFit = false;
    const neighbors = this._neighborSet(node);
    const subset = this.nodes.filter((candidate) => neighbors.has(candidate.id));
    this.fit(padding, duration, subset);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.requestRender();
  }

  destroy() {
    this.resizeObserver.disconnect();
    this.simulation.stop();
    if (this.rafId) cancelAnimationFrame(this.rafId);
  }

  requestRender() {
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this._draw();
    });
  }

  _applyFilters() {
    const { hiddenTypes, minWeight } = this.filters;
    this.visibleEdges = this.edges.filter(
      (edge) => !hiddenTypes.has(edge.type) && edge.count >= minWeight
    );
  }

  _typeColor(type) {
    if (!this.typeColors.has(type)) {
      this.typeColors.set(type, colorForKey(type, { saturation: 72, lightness: 62 }));
    }
    return this.typeColors.get(type);
  }

  _radiusFor(count, degree) {
    const metric = this.sizeMode === "degree" ? degree : count;
    return 10 + Math.min(18, Math.sqrt(metric || 1) * 1.15);
  }

  _isStructuredLayout() {
    return this.layoutMode === "radial" || this.layoutMode === "grid" || this.layoutMode === "tree";
  }

  // Packages are keyed by their own id (a slash-delimited folder path); symbols have no
  // such path as their id (a dot-delimited qualified name), so family/depth grouping for
  // them is derived from their containing file's package instead.
  _familyPathOf(node) {
    return node.kind === "package" ? node.id : packageFromFile(node.file) || "(root)";
  }

  _layoutTargetX(node) {
    if (this.layoutMode === "clustered") return this._clusterAnchors.get(packageFamily(this._familyPathOf(node)))?.x ?? 0;
    if (this._isStructuredLayout()) return this._layoutTargets.get(node.id)?.x ?? 0;
    return 0;
  }

  _layoutTargetY(node) {
    if (this.layoutMode === "clustered") return this._clusterAnchors.get(packageFamily(this._familyPathOf(node)))?.y ?? 0;
    if (this._isStructuredLayout()) return this._layoutTargets.get(node.id)?.y ?? 0;
    return 0;
  }

  _layoutStrength() {
    if (this.layoutMode === "clustered") return 0.12;
    if (this._isStructuredLayout()) return 0.9;
    return 0.02;
  }

  _applyLayoutTargets() {
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

  _computeClusterAnchors() {
    const families = [...new Set(this.nodes.map((node) => packageFamily(this._familyPathOf(node))))].sort();
    const radius = Math.max(220, families.length * 70);
    const map = new Map();
    families.forEach((family, index) => {
      const angle = (index / families.length) * Math.PI * 2;
      map.set(family, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
    });
    return map;
  }

  _computeRadialTargets() {
    const sorted = [...this.nodes].sort((a, b) => a.id.localeCompare(b.id));
    const totalDiameter = sorted.reduce((sum, node) => sum + node.radius * 2 + 10, 0);
    const radius = Math.max(160, totalDiameter / (Math.PI * 2));
    const map = new Map();
    sorted.forEach((node, index) => {
      const angle = (index / sorted.length) * Math.PI * 2 - Math.PI / 2;
      map.set(node.id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
    });
    return map;
  }

  _computeGridTargets() {
    const sorted = [...this.nodes].sort((a, b) => a.id.localeCompare(b.id));
    const maxRadius = Math.max(10, ...sorted.map((node) => node.radius));
    const spacing = maxRadius * 2 + 30;
    const cols = Math.max(1, Math.ceil(Math.sqrt(sorted.length)));
    const rows = Math.max(1, Math.ceil(sorted.length / cols));
    const map = new Map();
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

  // Real folder nodes only - each attaches to its nearest existing ancestor package (there's
  // often no real node for an intermediate folder, e.g. "src/components" when every file
  // lives one level deeper). Depth -> horizontal, DFS leaf order -> vertical.
  _computeTreeTargets() {
    const ids = this.nodes.map((node) => node.id);
    const idSet = new Set(ids);
    const parentOf = new Map();

    for (const id of ids) {
      let cursor = id;
      let parent = null;
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

    const childrenOf = new Map(ids.map((id) => [id, []]));
    for (const id of ids) {
      const parent = parentOf.get(id);
      if (parent) childrenOf.get(parent).push(id);
    }
    const roots = ids.filter((id) => !parentOf.get(id)).sort();

    let leafIndex = 0;
    const yOf = new Map();
    const depthOf = new Map();

    const visit = (id, depth) => {
      depthOf.set(id, depth);
      const children = [...childrenOf.get(id)].sort();
      if (!children.length) {
        yOf.set(id, leafIndex++);
        return;
      }
      for (const child of children) visit(child, depth + 1);
      const childYs = children.map((child) => yOf.get(child));
      yOf.set(id, (Math.min(...childYs) + Math.max(...childYs)) / 2);
    };
    for (const root of roots) visit(root, 0);

    const maxDepth = Math.max(1, ...[...depthOf.values()]);
    const depthSpan = Math.max(1, this.width - 240);
    const leafSpan = Math.max(1, leafIndex - 1);
    const rowHeight = Math.max(46, Math.min(90, (this.height - 120) / Math.max(1, leafSpan)));

    const map = new Map();
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

  _toGraphCoords(px, py) {
    return [(px - this.transform.x) / this.transform.k, (py - this.transform.y) / this.transform.k];
  }

  _pointerPos(event) {
    const rect = this.canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  _findNode(x, y) {
    if (!this.nodes.length) return null;
    const tree = quadtree(
      this.nodes,
      (node) => node.x,
      (node) => node.y
    );
    const searchRadius = 26 / this.transform.k;
    let found = null;
    let bestDist = Infinity;
    tree.visit((node, x0, y0, x1, y1) => {
      if (!node.length) {
        let candidate = node;
        do {
          const dx = candidate.data.x - x;
          const dy = candidate.data.y - y;
          const dist = Math.hypot(dx, dy);
          if (dist <= Math.max(candidate.data.radius, searchRadius) && dist < bestDist) {
            bestDist = dist;
            found = candidate.data;
          }
          candidate = candidate.next;
        } while (candidate);
      }
      return x0 > x + searchRadius || x1 < x - searchRadius || y0 > y + searchRadius || y1 < y - searchRadius;
    });
    return found;
  }

  _findEdge(x, y) {
    const threshold = 8 / this.transform.k;
    let found = null;
    let bestDist = Infinity;
    for (const edge of this.visibleEdges) {
      const s = edge.source;
      const t = edge.target;
      if (!s || typeof s === "string" || !t || typeof t === "string") continue;
      const dist = distanceToSegment(x, y, s.x, s.y, t.x, t.y);
      if (dist <= threshold && dist < bestDist) {
        bestDist = dist;
        found = edge;
      }
    }
    return found;
  }

  _neighborSet(node) {
    if (!node) return null;
    const set = new Set([node.id]);
    for (const edge of this.visibleEdges) {
      const sourceId = idOf(edge.source);
      const targetId = idOf(edge.target);
      if (sourceId === node.id) set.add(targetId);
      if (targetId === node.id) set.add(sourceId);
    }
    return set;
  }

  _setupZoom() {
    this.zoomBehavior = zoom()
      .scaleExtent([0.15, 6])
      .filter((event) => {
        if (event.type === "wheel") return true;
        if (event.button) return false;
        const [px, py] = event.touches
          ? [event.touches[0].clientX - this.canvas.getBoundingClientRect().left, event.touches[0].clientY - this.canvas.getBoundingClientRect().top]
          : this._pointerPos(event);
        const [x, y] = this._toGraphCoords(px, py);
        return !this._findNode(x, y);
      })
      .on("start", (event) => {
        if (event.sourceEvent) this.autoFit = false;
      })
      .on("zoom", (event) => {
        this.transform = event.transform;
        this.requestRender();
      });

    this.selection.call(this.zoomBehavior);
  }

  _setupDrag() {
    const dragSubject = (event) => {
      const [px, py] = this._pointerPos(event.sourceEvent);
      const [x, y] = this._toGraphCoords(px, py);
      const node = this._findNode(x, y);
      if (node) {
        node.x = node.fx ?? node.x;
        node.y = node.fy ?? node.y;
      }
      return node ?? undefined;
    };

    const behavior = drag()
      .subject(dragSubject)
      .on("start", (event) => {
        this.autoFit = false;
        this.dragging = true;
        this.dragMoved = false;
        if (!event.active) this.simulation.alphaTarget(0.3).restart();
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
      })
      .on("drag", (event) => {
        this.dragMoved = true;
        const [px, py] = this._pointerPos(event.sourceEvent);
        const [x, y] = this._toGraphCoords(px, py);
        event.subject.fx = x;
        event.subject.fy = y;
        this.requestRender();
      })
      .on("end", (event) => {
        this.dragging = false;
        if (!event.active) this.simulation.alphaTarget(0);
      });

    this.selection.call(behavior);
  }

  _setupPointerEvents() {
    this.canvas.addEventListener("pointermove", (event) => {
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
    let downPos = null;
    let lastUp = null;

    this.canvas.addEventListener("pointerdown", (event) => {
      if (event.button) return;
      downPos = [event.clientX, event.clientY];
    });

    this.canvas.addEventListener("pointerup", (event) => {
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
        lastUp &&
        now - lastUp.time < 320 &&
        Math.hypot(event.clientX - lastUp.x, event.clientY - lastUp.y) < 6;
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

  _draw() {
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
    const reciprocal = new Set();
    const seen = new Set();
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
      const curvature = reciprocal.has(`${s.id}|${t.id}`)
        ? (s.id < t.id ? 18 : -18)
        : s.id < t.id
          ? 9
          : -9;
      const weight = clamp(0.6 + (edge.count / this.maxEdgeCount) * 1.8, 0.6, 2.4);

      let strokeStyle;
      let alpha;
      let lineWidth;
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

      const mx = (s.x + t.x) / 2;
      const my = (s.y + t.y) / 2;
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const len = Math.hypot(dx, dy) || 1;
      const cx = mx + (-dy / len) * curvature;
      const cy = my + (dx / len) * curvature;

      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.quadraticCurveTo(cx, cy, t.x, t.y);
      ctx.strokeStyle = strokeStyle;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = lineWidth;
      ctx.lineCap = "round";
      ctx.stroke();

      const angle = Math.atan2(t.y - cy, t.x - cx);
      const tipX = t.x - Math.cos(angle) * (t.radius + 1);
      const tipY = t.y - Math.sin(angle) * (t.radius + 1);
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

      ctx.globalAlpha = dimmed ? 0.22 : 1;
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      ctx.fillStyle = node.color;
      ctx.fill();
      ctx.lineWidth = isActive ? 2.5 : 1.2;
      ctx.strokeStyle = isActive ? "#e9fbf8" : "rgba(8, 12, 12, 0.55)";
      ctx.stroke();

      if (node.fx != null) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = "#0b0e0e";
        ctx.fill();
      }

      const showLabel = hoverSet
        ? hoverSet.has(node.id)
        : transform.k >= 1.3 || this.topDegreeIds.has(node.id);

      if (showLabel && !dimmed) {
        const label = truncate(node.label, 26);
        ctx.font = "600 11px Inter, ui-sans-serif, system-ui, sans-serif";
        ctx.textBaseline = "middle";
        const textX = node.x + node.radius + 8;
        const metrics = ctx.measureText(label);
        ctx.fillStyle = "rgba(8, 12, 12, 0.72)";
        ctx.fillRect(textX - 3, node.y - 8, metrics.width + 6, 16);
        ctx.fillStyle = "#f4f7f6";
        ctx.fillText(label, textX, node.y);
      }
    }

    ctx.restore();
  }
}
