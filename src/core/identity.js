export const KG_SCHEMA_VERSION = "scopelease-kg-v1";

export function graphSchema() {
  return {
    version: KG_SCHEMA_VERSION,
    basis: "repo_relative_path_plus_code_symbol",
    visibility: "folder_kg_default_decision_scope_optional",
    nodeIdentity: ["scope", "kind", "stableKey"],
    edgeIdentity: ["source", "target", "relation"],
    layers: ["memory", "filesystem", "ast", "route", "evidence", "policy", "decision"],
    conventions: {
      memory: "Project-scoped memories, typed for precise recall.",
      cognify: "Ingested files keep dataset/node-set/provenance metadata before graph search.",
      cpg: "Code nodes are typed, attributed graph nodes with repo-relative source locations."
    }
  };
}

export function enrichGraph(graph, options = {}) {
  return {
    ...graph,
    schema: graphSchema(),
    nodes: (graph.nodes || []).map((node) => enrichNode(node, options)),
    edges: (graph.edges || []).map((edge) => enrichEdge(edge))
  };
}

export function enrichNode(node, options = {}) {
  const profile = nodeProfile(node);
  const stableKey = stableNodeKey(node);
  return {
    ...node,
    identity: {
      schema: KG_SCHEMA_VERSION,
      stableKey,
      scope: options.scope || "repo",
      kind: profile.kind,
      layer: profile.layer,
      memoryType: profile.memoryType,
      cpgType: profile.cpgType,
      displayTypeKo: profile.displayTypeKo,
      confidence: profile.confidence
    },
    memory: {
      projectScoped: true,
      dataset: datasetName(node),
      nodeSet: profile.nodeSet,
      recallRole: profile.memoryType
    },
    provenance: {
      source: profile.source,
      basis: profile.basis,
      path: node.path || null,
      line: node.line || null
    }
  };
}

export function enrichEdge(edge) {
  const profile = edgeProfile(edge);
  return {
    ...edge,
    identity: {
      schema: KG_SCHEMA_VERSION,
      relation: profile.relation,
      layer: profile.layer,
      direction: "directed",
      confidence: profile.confidence
    },
    provenance: {
      source: profile.source,
      basis: profile.basis,
      line: edge.meta?.line || null
    }
  };
}

function nodeProfile(node) {
  const type = String(node.type || "").replace(/^changed_/, "");
  if (type === "policy") {
    return profile("policy_rule", "policy", "policy", "FINDING", "정책", "policy", "policy_engine", "rule_match", "deterministic");
  }

  if (type === "route") {
    return profile("endpoint", "route", "implementation", "METHOD", "라우트", "route", "symbol_extractor", "route_pattern", "heuristic");
  }

  if (type === "function") {
    return profile("code_symbol", "ast", "implementation", "METHOD", "함수", "code", "symbol_extractor", "function_signature", "heuristic");
  }

  if (type === "class" || type === "type") {
    return profile("code_symbol", "ast", "implementation", "TYPE_DECL", type === "class" ? "클래스" : "타입", "code", "symbol_extractor", "type_declaration", "heuristic");
  }

  if (type === "table") {
    return profile("data_schema", "ast", "implementation", "CONFIG_FILE", "DB 테이블", "data", "symbol_extractor", "sql_statement", "heuristic");
  }

  if (type === "file") {
    return fileProfile(node);
  }

  return fileProfile(node);
}

function fileProfile(node) {
  const fileType = node.fileType || fileTypeFromPath(node.path || node.label || "");
  if (fileType === "test") return profile("test_file", "evidence", "test_evidence", "FILE", "테스트", "test", "local_index", "repo_relative_path", "deterministic");
  if (fileType === "doc") return profile("document", "memory", "documentation", "FILE", "문서", "doc", "local_index", "repo_relative_path", "deterministic");
  if (fileType === "config") return profile("config_file", "filesystem", "configuration", "CONFIG_FILE", "설정", "config", "local_index", "repo_relative_path", "deterministic");
  if (fileType === "code") return profile("code_file", "filesystem", "implementation", "FILE", "코드 파일", "code", "local_index", "repo_relative_path", "deterministic");
  return profile("file", "filesystem", "artifact", "FILE", "파일", "artifact", "local_index", "repo_relative_path", "deterministic");
}

function profile(kind, layer, memoryType, cpgType, displayTypeKo, nodeSet, source, basis, confidence) {
  return { kind, layer, memoryType, cpgType, displayTypeKo, nodeSet, source, basis, confidence };
}

function edgeProfile(edge) {
  const type = edge.type || "relation";
  const map = {
    defines: ["contains", "ast", "symbol_extractor", "file_to_symbol", "heuristic"],
    imports: ["imports", "filesystem", "import_resolver", "resolved_relative_import", "deterministic"],
    imported_by: ["imported_by", "filesystem", "import_resolver", "reverse_import", "deterministic"],
    tests: ["tests", "evidence", "test_linker", "import_or_name_match", "heuristic"],
    mentions: ["mentions", "memory", "doc_linker", "symbol_name_match", "heuristic"],
    route: ["exposes", "route", "route_extractor", "route_pattern", "heuristic"],
    defined_by: ["defined_by", "ast", "symbol_extractor", "symbol_source", "heuristic"],
    policy_hit: ["violates_policy", "policy", "policy_engine", "rule_match", "deterministic"]
  };
  const [relation, layer, source, basis, confidence] = map[type] || [type, "memory", "local_index", "graph_edge", "heuristic"];
  return { relation, layer, source, basis, confidence };
}

function stableNodeKey(node) {
  if (node.path && node.line) return `${node.path}#${node.type || "node"}:${node.label || node.id}:${node.line}`;
  if (node.path) return node.path;
  return node.id;
}

function datasetName(node) {
  const pathValue = node.path || node.label || "";
  const [head, second] = String(pathValue).split("/").filter(Boolean);
  if (!head) return "repo";
  if (head === "src" && second) return `src/${second}`;
  if (head === "examples" && second) return `examples/${second}`;
  return head;
}

function fileTypeFromPath(pathValue) {
  const lower = String(pathValue).toLowerCase();
  if (/(\.|-)(test|spec)\./.test(lower) || lower.includes("/test/") || lower.includes("/tests/")) return "test";
  if (/\.(md|mdx|txt|rst|adoc)$/.test(lower)) return "doc";
  if (/\.(json|ya?ml|toml|ini|env|config)$/.test(lower)) return "config";
  if (/\.(js|jsx|ts|tsx|mjs|cjs|py|go|java|kt|sql)$/.test(lower)) return "code";
  return "other";
}
