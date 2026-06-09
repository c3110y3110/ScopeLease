import { hashText } from "../fs-utils.js";
import { actionPaths } from "./action-policy.js";
import {
  actionNodeId,
  baselineGraphHash,
  buildOperationalGraph,
  fileNodeId,
  graphScopeHash,
  policyNodeId,
  symbolNodeId
} from "./graph-adapter.js";

const GRAPH_STOP_CONDITIONS = [
  "outside_graph_scope",
  "baseline_graph_changed",
  "new_policy_node"
];
const MAX_FRONTIER_SYMBOLS = 48;

export function buildFrontiers({
  analysis = {},
  readPlan = [],
  symbolProbePlan = [],
  policyHits = analysis.policyHits || [],
  affected = analysis.impact || {},
  decisionGate = {},
  action = null,
  state = {}
} = {}) {
  const graph = buildOperationalGraph(analysis, {
    backendPayload: analysis.operationalGraphBackend,
    backendName: analysis.operationalGraphBackendName
  });
  const changedFiles = analysis.changes?.files || [];
  const requestedActionFiles = action ? actionPaths(action) : [];
  const changedSymbols = Object.values(analysis.changes?.symbols || {}).flat();
  const frontierSymbols = changedSymbols.slice(0, MAX_FRONTIER_SYMBOLS);
  const probeSymbols = symbolProbePlan
    .filter((item) => item?.symbol && item?.path)
    .map((item) => ({ path: item.path, name: item.symbol, type: item.type || "function", line: item.line }));
  const symbolNodes = uniqueStrings([
    ...frontierSymbols.map(symbolNodeId),
    ...probeSymbols.map(symbolNodeId)
  ]);
  const contextNodes = uniqueStrings([
    ...readPlan.map((item) => item.path && fileNodeId(item.path)),
    ...symbolProbePlan.map((item) => item.path && fileNodeId(item.path)),
    ...symbolNodes,
    ...(affected.tests || []).map((item) => item.path && fileNodeId(item.path)),
    ...(affected.docs || []).map((item) => item.path && fileNodeId(item.path))
  ]);
  const reviewNodes = uniqueStrings([
    ...changedFiles.map(fileNodeId),
    ...symbolNodes,
    ...(affected.importedBy || []).map((item) => item.path && fileNodeId(item.path)),
    ...(affected.tests || []).map((item) => item.path && fileNodeId(item.path)),
    ...policyHits.map(policyNodeId)
  ]);
  const permissionNodes = uniqueStrings([
    ...contextNodes,
    ...reviewNodes,
    ...requestedActionFiles.map(fileNodeId),
    ...readPlan.map((item) => item.path && fileNodeId(item.path)),
    actionNodeId("read"),
    actionNodeId("grep"),
    actionNodeId("propose_patch"),
    actionNodeId("apply_patch"),
    ...(decisionGate.canAutoApplyPatch || decisionGate.canAutoPreparePatch ? [actionNodeId("run_tests")] : []),
    actionNodeId("run_tests")
  ]);
  const stopNodes = uniqueStrings([
    ...policyHits
      .filter((hit) => ["medium", "high", "critical"].includes(hit.risk))
      .map(policyNodeId),
    actionNodeId("network"),
    actionNodeId("external_write"),
    actionNodeId("checkpoint")
  ]);
  const scopeNodes = uniqueStrings([...contextNodes, ...reviewNodes, ...permissionNodes, ...stopNodes]);
  const scopeEdgeIds = graph.edges
    .filter((edge) => scopeNodes.includes(edge.source) && scopeNodes.includes(edge.target))
    .map(edgeId);
  const graphScope = {
    nodes: scopeNodes,
    edges: scopeEdgeIds,
    policyNodes: policyHits.map(policyNodeId),
    actionNodes: permissionNodes.filter((id) => id.startsWith("action:")),
    hash: graphScopeHash({
      backend: graph.stats.backend,
      nodes: scopeNodes,
      edges: scopeEdgeIds,
      policyNodes: policyHits.map(policyNodeId),
      actionNodes: permissionNodes.filter((id) => id.startsWith("action:"))
    }),
    nodeCount: scopeNodes.length,
    edgeCount: scopeEdgeIds.length,
    policyCount: policyHits.length,
    actionCount: permissionNodes.filter((id) => id.startsWith("action:")).length,
    symbolCount: scopeNodes.filter((id) => id.startsWith("symbol:")).length,
    baselineGraphHash: baselineGraphHash({ analysis, state }),
    backend: graph.stats.backend,
    stats: graph.stats
  };

  return compactObject({
    kind: "scopelease.scopeleaserity_frontiers",
    version: 1,
    graph: {
      schema: graph.schema,
      backend: graph.stats.backend,
      hash: graph.hash,
      nodes: graph.stats.nodes,
      edges: graph.stats.edges
    },
    graphScope,
    contextFrontier: frontierRecord({
      kind: "context",
      label: "Agent context frontier",
      nodes: contextNodes,
      items: [
        ...readPlan.map((item) => frontierItem("read", item.path, item.reason || item.action)),
        ...symbolProbePlan.map((item) => frontierItem("probe", item.path, item.symbol))
      ],
      reason: "agent가 전체 저장소를 읽기 전에 먼저 볼 파일/심볼 경계"
    }),
    symbolFrontier: frontierRecord({
      kind: "symbol",
      label: "Symbol-level frontier",
      nodes: symbolNodes,
      items: [
        ...frontierSymbols.map((symbol) => symbolFrontierItem("changed_symbol", symbol, "변경 심볼")),
        ...probeSymbols.map((symbol) => symbolFrontierItem("probe_symbol", symbol, "심볼 단위 확인"))
      ],
      reason: "파일 전체를 열기 전에 확인할 변경/탐색 심볼 경계"
    }),
    reviewFrontier: frontierRecord({
    kind: "review",
    label: "Human review frontier",
    nodes: reviewNodes,
    items: [
      ...changedFiles.map((file) => frontierItem("changed_file", file, "기준점 이후 변경")),
      ...frontierSymbols.slice(0, 16).map((symbol) => ({
          kind: "symbol",
          id: symbolNodeId(symbol),
          path: symbol.path,
          symbol: symbol.name,
          reason: "변경 심볼"
        })),
        ...policyHits.map((hit) => ({
          kind: "policy",
          id: policyNodeId(hit),
          label: hit.ruleId,
          risk: hit.risk,
          reason: hit.reason || hit.description || "정책 경계"
        }))
      ],
    reason: changedSymbols.length > frontierSymbols.length
      ? `사람이 전체 diff 대신 확인할 권한/위험 경계. 심볼 ${changedSymbols.length - frontierSymbols.length}개는 frontier hash 밖 상세 목록에서 생략`
      : "사람이 전체 diff 대신 확인할 권한/위험 경계"
    }),
    permissionFrontier: frontierRecord({
      kind: "permission",
      label: "Delegated permission frontier",
      nodes: permissionNodes,
      items: permissionNodes.map((id) => ({ id, kind: id.split(":")[0], label: id.split(":").slice(1).join(":") })),
      reason: "signed approval lease가 재사용할 수 있는 graph/action 경계"
    }),
    stopFrontier: frontierRecord({
      kind: "stop",
      label: "Stop frontier",
      nodes: stopNodes,
      items: [
        ...stopNodes.map((id) => ({ id, kind: id.split(":")[0], label: id.split(":").slice(1).join(":") })),
        ...GRAPH_STOP_CONDITIONS.map((condition) => ({ kind: "stop_condition", label: condition }))
      ],
      reason: "agent action이 이 경계를 넘으면 다시 묻거나 차단"
    }),
    stopWhen: GRAPH_STOP_CONDITIONS
  });
}

export function compactFrontierForLease(frontiers = {}) {
  const graphScope = frontiers.graphScope || {};
  return compactObject({
    baselineGraphHash: graphScope.baselineGraphHash,
    graphScopeHash: graphScope.hash,
    reviewFrontierHash: frontiers.reviewFrontier?.hash,
    symbolFrontierHash: frontiers.symbolFrontier?.hash,
    permissionFrontierHash: frontiers.permissionFrontier?.hash,
    allowedGraphNodes: frontiers.permissionFrontier?.nodes || [],
    reviewGraphNodes: frontiers.reviewFrontier?.nodes || [],
    symbolGraphNodes: frontiers.symbolFrontier?.nodes || [],
    stopGraphNodes: frontiers.stopFrontier?.nodes || [],
    graphBackend: frontiers.graph?.backend || graphScope.backend
  });
}

export function frontierSummary(frontiers = {}) {
  return compactObject({
    contextNodes: frontiers.contextFrontier?.nodes?.length || 0,
    symbolNodes: frontiers.symbolFrontier?.nodes?.length || 0,
    reviewNodes: frontiers.reviewFrontier?.nodes?.length || 0,
    permissionNodes: frontiers.permissionFrontier?.nodes?.length || 0,
    stopNodes: frontiers.stopFrontier?.nodes?.length || 0,
    graphScopeHash: frontiers.graphScope?.hash,
    symbolFrontierHash: frontiers.symbolFrontier?.hash,
    backend: frontiers.graph?.backend
  });
}

function frontierRecord({ kind = "", label = "", nodes = [], items = [], reason = "" } = {}) {
  const normalizedNodes = uniqueStrings(nodes);
  return compactObject({
    kind,
    label,
    nodes: normalizedNodes,
    hash: `sha1:${hashText(JSON.stringify({ kind, nodes: normalizedNodes }))}`,
    size: normalizedNodes.length,
    items: items.filter(Boolean).slice(0, 24),
    reason
  });
}

function frontierItem(kind = "", path = "", reason = "") {
  if (!path) return null;
  return {
    kind,
    id: fileNodeId(path),
    path,
    reason
  };
}

function symbolFrontierItem(kind = "", symbol = {}, reason = "") {
  const id = symbolNodeId(symbol);
  if (!id) return null;
  return {
    kind,
    id,
    path: symbol.path,
    symbol: symbol.name,
    type: symbol.type,
    line: symbol.line,
    reason
  };
}

function edgeId(edge = {}) {
  return `${edge.source}->${edge.target}:${edge.type}`;
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function compactObject(value) {
  if (Array.isArray(value)) return value.map(compactObject).filter((item) => !isEmptyValue(item));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const compacted = compactObject(item);
    if (!isEmptyValue(compacted)) result[key] = compacted;
  }
  return result;
}

function isEmptyValue(value) {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}
