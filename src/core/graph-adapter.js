import { hashText } from "../fs-utils.js";
import { actionGrant, actionPaths, normalizeAgentAction } from "./action-policy.js";

const DEFAULT_ACTIONS = ["read", "grep", "propose_patch", "apply_patch", "run_tests"];

export function buildOperationalGraph(analysis = {}, { backendPayload = null, backendName = "" } = {}) {
  const normalized = normalizeGraphBackendPayload(
    backendPayload || analysis.operationalGraphBackend || analysis.knowledgeGraph || analysis.graph || {},
    { backendName }
  );
  const nodes = new Map(normalized.nodes.map((node) => [node.id, node]));
  const edges = [...normalized.edges];

  for (const hit of analysis.policyHits || []) {
    const policyId = policyNodeId(hit);
    if (!nodes.has(policyId)) {
      nodes.set(policyId, {
        id: policyId,
        type: "policy",
        label: hit.ruleId || "policy",
        risk: hit.risk || "low",
        route: hit.route || ""
      });
    }
    for (const file of hit.files || []) {
      const source = fileNodeId(file);
      if (nodes.has(source)) edges.push({ source, target: policyId, type: "policy_hit", sourceBackend: "scopelease_policy" });
    }
  }

  for (const action of DEFAULT_ACTIONS) {
    const id = actionNodeId(action);
    nodes.set(id, {
      id,
      type: "action",
      label: action,
      sourceBackend: "scopelease_action"
    });
  }

  const graph = {
    schema: "scopelease-operational-code-graph-v1",
    backend: normalized.backend,
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: dedupeEdges(edges).sort((left, right) =>
      String(left.source).localeCompare(String(right.source)) ||
      String(left.target).localeCompare(String(right.target)) ||
      String(left.type).localeCompare(String(right.type))
    )
  };

  return {
    ...graph,
    hash: graphHash(graph),
    stats: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      backend: normalized.backend.name,
      source: normalized.backend.source
    }
  };
}

export function normalizeGraphBackendPayload(payload = {}, { backendName = "" } = {}) {
  const rawNodes = Array.isArray(payload.nodes)
    ? payload.nodes
    : Array.isArray(payload.vertices)
      ? payload.vertices
      : [];
  const rawEdges = Array.isArray(payload.edges)
    ? payload.edges
    : Array.isArray(payload.relationships)
      ? payload.relationships
      : [];
  const nodes = rawNodes
    .map(normalizeNode)
    .filter((node) => node.id);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = rawEdges
    .map(normalizeEdge)
    .filter((edge) => edge.source && edge.target)
    .filter((edge) => !nodeIds.size || (nodeIds.has(edge.source) && nodeIds.has(edge.target)));
  const name = backendName || payload.backend || payload.source || payload.schema?.backend || payload.schema?.model || "scopelease_internal";
  return {
    backend: {
      name: String(name || "scopelease_internal"),
      source: payload === undefined || payload === null ? "empty" : "provided"
    },
    nodes,
    edges
  };
}

export function graphHash(graph = {}) {
  return `sha1:${hashText(JSON.stringify({
    schema: graph.schema || "",
    backend: graph.backend?.name || "",
    nodes: (graph.nodes || []).map((node) => [node.id, node.type, node.path || "", node.symbol || node.label || ""]),
    edges: (graph.edges || []).map((edge) => [edge.source, edge.target, edge.type])
  }))}`;
}

export function graphScopeHash(scope = {}) {
  return `sha1:${hashText(JSON.stringify({
    backend: scope.backend || "",
    nodes: [...new Set(scope.nodes || [])].sort(),
    edges: [...new Set(scope.edges || [])].sort(),
    policies: [...new Set(scope.policyNodes || [])].sort(),
    actions: [...new Set(scope.actionNodes || [])].sort()
  }))}`;
}

export function baselineGraphHash({ analysis = {}, state = {} } = {}) {
  const backendName = analysis.operationalGraphBackendName ||
    analysis.contextPack?.agentContext?.frontiers?.graphScope?.backend ||
    analysis.knowledgeGraph?.schema?.model ||
    analysis.graph?.schema?.model ||
    "scopelease_internal";
  return `sha1:${hashText(JSON.stringify({
    schema: "scopelease-operational-code-graph-v1",
    repo: state.repo || analysis.repo || "",
    baselineHashes: state.baselineHashes || {},
    backend: backendName,
    backendPayloadHash: analysis.operationalGraphBackend
      ? hashText(JSON.stringify(analysis.operationalGraphBackend))
      : ""
  }))}`;
}

export function actionGraphRefs(action = {}) {
  const normalized = normalizeAgentAction(action);
  const grant = actionGrant(normalized);
  return {
    actionNode: actionNodeId(grant),
    fileNodes: actionPaths(normalized).map(fileNodeId),
    grant
  };
}

export function fileNodeId(filePath = "") {
  return `file:${String(filePath || "").replace(/\\/g, "/").replace(/^\.\//, "")}`;
}

export function symbolNodeId(symbol = {}) {
  if (symbol.id) return String(symbol.id);
  const path = String(symbol.path || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const type = String(symbol.type || "symbol");
  const name = String(symbol.name || symbol.label || "");
  return path && name ? `symbol:${path}:${type}:${name}` : "";
}

export function policyNodeId(hit = {}) {
  return `policy:${String(hit.ruleId || hit.id || hit.name || "policy")}`;
}

export function actionNodeId(action = "") {
  return `action:${String(action || "unknown")}`;
}

function normalizeNode(node = {}) {
  const properties = node.properties || {};
  const path = node.path || properties.path || node.file || properties.file || "";
  const type = normalizeNodeType(node.type || properties.type || firstLabel(node.labels) || node.kind || properties.kind || "");
  const id = node.id || properties.id || inferNodeId({ type, path, node, properties });
  return {
    id: String(id || ""),
    type,
    label: node.label || node.caption || properties.name || properties.label || path || id || "",
    path: path || undefined,
    line: node.line || properties.line || undefined,
    symbol: properties.symbol || node.symbol || undefined,
    sourceBackend: node.sourceBackend || properties.source || undefined
  };
}

function normalizeEdge(edge = {}) {
  return {
    source: String(edge.source || edge.from || edge.start || edge.startNode || ""),
    target: String(edge.target || edge.to || edge.end || edge.endNode || ""),
    type: String(edge.type || edge.relationshipType || edge.relation || "related").toLowerCase(),
    sourceBackend: edge.sourceBackend || edge.properties?.source || undefined
  };
}

function inferNodeId({ type = "", path = "", node = {}, properties = {} }) {
  if (type === "file" && path) return fileNodeId(path);
  if (type === "policy") return policyNodeId(properties);
  if (type === "action") return actionNodeId(node.label || properties.name);
  return "";
}

function normalizeNodeType(value = "") {
  const text = String(value || "").toLowerCase();
  if (text.includes("file") || ["code", "test", "doc", "document"].includes(text)) return text === "document" ? "doc" : text;
  if (text.includes("function") || text.includes("class") || text.includes("symbol")) return "symbol";
  if (text.includes("policy")) return "policy";
  if (text.includes("action")) return "action";
  return text || "node";
}

function firstLabel(labels = []) {
  return Array.isArray(labels) && labels.length ? labels[labels.length - 1] : "";
}

function dedupeEdges(edges = []) {
  const seen = new Set();
  return edges.filter((edge) => {
    const key = `${edge.source}->${edge.target}:${edge.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
