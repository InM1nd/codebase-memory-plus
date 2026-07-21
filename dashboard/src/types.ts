// Hand-written mirror of the JSON shapes returned by src/dashboard-server.ts's routes.
// Kept separate from src/cache-store.ts's internal types on purpose - that file is
// Node-oriented (fs, sql.js, NodeNext resolution) and type-checking it under this
// project's DOM/Bundler config would risk spurious errors for no real benefit here.

export type SymbolMeta = {
  complexity?: number;
  cognitive?: number;
  docstring?: string;
  signature?: string;
  isExported?: boolean;
  isTest?: boolean;
  isEntryPoint?: boolean;
  lines?: number;
  paramCount?: number;
  paramNames?: string[];
  paramTypes?: string[];
  returnType?: string;
  baseClasses?: string[];
  loopCount?: number;
  loopDepth?: number;
  transitiveLoopDepth?: number;
  linearScanInLoop?: number;
  allocInLoop?: number;
  recursionInLoop?: boolean;
  unguardedRecursion?: boolean;
  recursive?: boolean;
  maxAccessDepth?: number;
};

export type GraphNode = {
  id: string;
  label: string;
  kind: string;
  count?: number;
  file?: string;
  qualifiedName?: string;
  meta?: SymbolMeta;
};

export type GraphEdge = {
  source: string;
  target: string;
  type: string;
  count: number;
};

export type GraphResponse = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type ProjectSummary = {
  project: string;
  root_path: string;
  total_nodes: number;
  total_edges: number;
  node_labels: Array<{ label: string; count: number }>;
  edge_types: Array<{ type: string; count: number }>;
  packages: Array<{ name: string; node_count: number }>;
  total_packages: number;
  families: string[];
  source: "local-cache-fallback";
};

export type PackageDetails = {
  name: string;
  node_count: number;
  label_counts: Array<{ label: string; count: number }>;
  top_symbols: GraphNode[];
  relations: GraphEdge[];
  avg_complexity?: number;
};

export type SearchResult = {
  id: string;
  label: string;
  kind: string;
  file?: string;
  qualifiedName?: string;
};

export type SearchResponse = {
  results: SearchResult[];
  semantic_results?: SearchResult[];
};

export type PerfRisk = {
  id: string;
  label: string;
  file?: string;
  qualifiedName: string;
  score: number;
  isTooling: boolean;
  meta: SymbolMeta;
};

export type ApiSurfaceGroup = {
  urlPath: string;
  route?: { qualifiedName: string; name: string };
  callers: Array<{ name: string; qualifiedName: string; file?: string }>;
};

export type ConfigMapEntry = {
  key: string;
  configuredBy: Array<{ name: string; qualifiedName: string; file?: string }>;
};

export type ConfigMap = {
  envVars: GraphNode[];
  entries: ConfigMapEntry[];
};

export type DuplicatePair = {
  jaccard: number;
  sameFile: boolean;
  a: { name: string; qualifiedName: string; file?: string };
  b: { name: string; qualifiedName: string; file?: string };
};

export type FileChurn = {
  name: string;
  filePath: string;
  changeCount: number;
  lastModified?: number;
};

export type CrossRepoLink = {
  type: string;
  sourceName: string;
  sourceFile?: string;
  targetName: string;
  targetProject?: string;
};

export type CrossRepoSummary = {
  status?: string;
  projects_scanned?: number;
  total_cross_edges?: number;
  [key: string]: unknown;
};

export type CrossRepoResponse = {
  summary?: CrossRepoSummary;
  links: CrossRepoLink[];
};

export type IndexHealth = {
  hasEmbeddings: boolean;
  status?: string;
};

export type CachedProject = {
  project: string;
  root_path: string;
  nodes: number;
  edges: number;
  path_exists: boolean;
};

export type ProjectsResponse = {
  projects: CachedProject[];
};

// The routes below pass through whatever the base MCP tool returns - genuinely loose,
// mirrored here as "the fields this dashboard actually reads" rather than a full
// guaranteed contract (the server itself types these as Record<string, unknown>).

export type ArchLayerRow = { name?: string; layer?: string };
export type ArchHotspotRow = { name: string; qualified_name?: string; fan_in?: number };
export type ArchBoundaryRow = { from: string; to: string; call_count?: number };
export type ArchClusterRow = { id?: string | number; label?: string; members?: number; cohesion?: number; top_nodes?: string[] };

export type ArchitectureInsights = {
  layers?: ArchLayerRow[];
  hotspots?: ArchHotspotRow[];
  boundaries?: ArchBoundaryRow[];
  clusters?: ArchClusterRow[];
  error?: string;
};

export type TraceHop = {
  name: string;
  qualified_name?: string;
  hop?: number;
  risk?: string;
};

export type TraceResult = {
  callers?: TraceHop[];
  callees?: TraceHop[];
  error?: string;
};

export type ImpactedSymbol = { name: string; label: string; file?: string };

export type ImpactResult = {
  changed_files?: string[];
  changed_count?: number;
  impacted_symbols?: ImpactedSymbol[];
  computed_at?: number;
  error?: string;
};

export type AdrResult = {
  content?: string;
  adr_hint?: string;
  error?: string;
};

export type QueryResult = {
  columns?: string[];
  rows?: unknown[][];
  total?: number;
  error?: string;
};

export type AgentConfigType = "mcp" | "skill" | "plugin";
export type AgentConfigTool = "claude" | "cursor" | "codex";
export type AgentConfigScope = "global" | "project";
export type AgentConfigOrigin = "user" | "plugin";

export type AgentConfigEntry = {
  id: string;
  name: string;
  type: AgentConfigType;
  tool: AgentConfigTool;
  scope: AgentConfigScope;
  project_path: string | null;
  enabled: boolean;
  source_path: string;
  origin: AgentConfigOrigin;
  raw_config: Record<string, unknown>;
  usage_count?: number;
  last_used_at?: number;
  has_hooks?: boolean;
};

export type AgentConfigResponse = {
  entries: AgentConfigEntry[];
};

export type DuplicateGroup = {
  name: string;
  entries: AgentConfigEntry[];
};

export type AgentConfigDuplicatesResponse = {
  duplicates: DuplicateGroup[];
};

export type AgentConfigMutationResult = {
  dryRun: boolean;
  applied: boolean;
  usedNativeCli: boolean;
  diff: string;
  backupPath?: string;
  error?: string;
};

export type SerenaStatusState = "not-configured" | "not-found" | "connected-other-project" | "connected";

export type SerenaStatus = {
  state: SerenaStatusState;
  port?: number;
  activeProject?: { name: string | null; path: string | null } | null;
  registeredProjects?: Array<{ name: string; path: string; is_active: boolean }>;
};

export type SerenaOverview = {
  active_project?: { name: string | null; language: string | null; path: string | null };
  context?: { name: string; description: string };
  modes?: Array<{ name: string; description: string }>;
  active_tools?: string[];
  registered_projects?: Array<{ name: string; path: string; is_active: boolean }>;
  languages?: string[];
  encoding?: string | null;
  serena_version?: string;
  [key: string]: unknown;
};

export type SerenaToolStats = {
  stats: Record<string, { num_times_called: number; input_tokens: number; output_tokens: number }>;
};

export type SerenaLogsResponse = {
  messages: string[];
  max_idx: number;
};

export type SerenaMemory = {
  content: string;
  memory_name: string;
};
