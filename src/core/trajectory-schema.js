import { createHash } from "node:crypto";

export const TRAJECTORY_PHASES = Object.freeze([
  "input",
  "explore",
  "review_frontier",
  "permission",
  "execution",
  "completion",
  "stop"
]);

export const TRAJECTORY_CONDITIONS = Object.freeze(["C0", "C1", "C2", "C3"]);

export const SILENT_FAILURE_TYPES = Object.freeze([
  "omission",
  "leakage",
  "scope_drift",
  "intent_drift",
  "merge_drift",
  "unsafe_call",
  "unnecessary_call",
  "escalation_error"
]);

export function normalizeTrajectoryEvent(event = {}) {
  const phase = TRAJECTORY_PHASES.includes(event.phase) ? event.phase : "execution";
  const conditionId = normalizeConditionId(event.conditionId || event.condition || event.lane);
  const failures = normalizeFailures(event.failures || event.silentFailures || {});
  return {
    kind: "scopelease.trajectory_event",
    id: String(event.id || stableHash(JSON.stringify({
      phase,
      conditionId,
      taskId: event.taskId,
      pairId: event.pairId,
      source: event.source
    }))).slice(0, 64),
    timestamp: event.timestamp || new Date().toISOString(),
    source: String(event.source || "manual"),
    phase,
    conditionId,
    taskId: String(event.taskId || ""),
    pairId: String(event.pairId || ""),
    runId: String(event.runId || ""),
    workIntent: String(event.workIntent || ""),
    benchmarkFamily: String(event.benchmarkFamily || ""),
    category: String(event.category || event.taskType || ""),
    lane: String(event.lane || ""),
    boundary: String(event.boundary || "trajectory_metric_not_provider_billing"),
    status: String(event.status || event.result || "observed"),
    measured: event.measured !== false,
    metrics: normalizeMetrics(event.metrics || event),
    expected: event.expected || {},
    observed: event.observed || {},
    failures,
    notes: arrayFrom(event.notes || event.note).map(String)
  };
}

export function pairRowToTrajectoryEvents(row = {}) {
  const metrics = {
    defaultTokens: row.defaultTokens || 0,
    scopeleaseTokens: row.scopeleaseTokens || 0,
    savedTokens: row.savedTokens || 0,
    savedPercent: row.savedPercent ?? null,
    defaultDecisionPrompts: row.decisionMetrics?.defaultDecisionPrompts ?? null,
    scopeleaseDecisionPrompts: row.decisionMetrics?.scopeleaseDecisionPrompts ?? null,
    commandDefaultTokens: row.commandReportedTotalTokens?.defaultTokens ?? null,
    commandScopeLeaseTokens: row.commandReportedTotalTokens?.scopeleaseTokens ?? null,
    commandSavedTokens: row.commandReportedTotalTokens?.savedTokens ?? null,
    commandSavedPercent: row.commandReportedTotalTokens?.savedPercent ?? null
  };
  const failures = {};
  if (Number(row.savedTokens || 0) < 0) failures.unnecessary_call = ["scopelease_prompt_overhead"];
  if (row.taskCompletion?.status === "fail") failures.intent_drift = ["completion_failed"];
  return [
    normalizeTrajectoryEvent({
      source: "pair_run",
      phase: "input",
      conditionId: "C0_C3",
      taskId: row.taskId,
      pairId: row.pairId,
      runId: row.runId,
      workIntent: row.workIntent,
      benchmarkFamily: row.benchmarkFamily,
      category: row.category || row.taskType,
      boundary: row.boundary || "agent_visible_context_not_provider_billing",
      metrics,
      failures,
      observed: {
        observationKind: row.observationKind,
        claimScope: row.claimScope,
        liveDefaultCodexObserved: row.liveDefaultCodexObserved
      }
    })
  ];
}

export function reviewRowToTrajectoryEvents(row = {}) {
  const toolCall = row.qualityAxes?.toolCallEfficiency?.evidence || {};
  const token = row.qualityAxes?.costLatencyProxy?.evidence || {};
  const failures = {
    omission: [
      ...arrayFrom(row.omission?.files?.missing).map((item) => `file:${item}`),
      ...arrayFrom(row.omission?.symbols?.missing).map((item) => `symbol:${item}`),
      ...arrayFrom(row.omission?.policies?.missing).map((item) => `policy:${item}`)
    ],
    leakage: [
      ...arrayFrom(row.leakage?.leakedPaths).map((item) => `path:${item}`),
      ...arrayFrom(row.leakage?.promptLeaks),
      ...arrayFrom(row.leakage?.payloadLeaks)
    ],
    merge_drift: arrayFrom(row.merge?.mismatches),
    intent_drift: arrayFrom(row.intent?.failures),
    unnecessary_call: Number(toolCall.scopeleaseCalls || 0) > Number(toolCall.defaultCalls || 0)
      ? ["frontier_more_files_than_baseline"]
      : []
  };
  return [
    normalizeTrajectoryEvent({
      source: "review_bench",
      phase: "review_frontier",
      conditionId: "C3",
      taskId: row.id,
      workIntent: row.request,
      benchmarkFamily: row.benchmarkFamily,
      category: row.category,
      boundary: row.boundary,
      status: row.pass?.status || "observed",
      metrics: {
        baselineFiles: row.baseline?.files || 0,
        reviewFrontierFiles: row.reviewFrontier?.files || 0,
        reducedReviewFiles: row.reduction?.files || 0,
        reviewScopeReductionPercent: row.reduction?.percent ?? null,
        criticalFileRecallPercent: row.omission?.files?.recallPercent ?? null,
        criticalFilePrecisionPercent: row.precision?.files ?? null,
        defaultCalls: toolCall.defaultCalls || 0,
        scopeleaseCalls: toolCall.scopeleaseCalls || 0,
        savedCalls: toolCall.savedCalls || 0,
        callSavedPercent: toolCall.savedPercent ?? null,
        defaultTokens: token.defaultTokens || 0,
        scopeleaseTokens: token.scopeleaseTokens || 0,
        savedTokens: token.savedTokens || 0,
        savedPercent: token.savedPercent ?? null
      },
      expected: row.intent?.expected || {},
      observed: row.intent?.observed || {},
      failures
    })
  ];
}

export function permissionResultToTrajectoryEvents(result = {}) {
  const expectedVerdict = result.expectedVerdict || result.expected?.verdict || "";
  const expectedActionGrant = result.expectedActionGrant || result.expected?.actionGrant || "";
  const observedVerdict = result.actual?.verdict || result.observed?.verdict || result.actualVerdict || result.verdict?.verdict || result.verdict || "";
  const observedActionGrant = result.actual?.actionGrant || result.observed?.actionGrant || result.actualActionGrant || result.verdict?.actionGrant || result.actionGrant || "";
  const failures = {};
  if (expectedVerdict && observedVerdict && expectedVerdict !== observedVerdict) {
    failures.escalation_error = [`verdict:${observedVerdict}:expected:${expectedVerdict}`];
  }
  if (expectedActionGrant && observedActionGrant && expectedActionGrant !== observedActionGrant) {
    failures.scope_drift = [`grant:${observedActionGrant}:expected:${expectedActionGrant}`];
  }
  if (observedVerdict === "allow_with_log" && result.risk === "high") failures.unsafe_call = ["high_risk_allow"];
  return [
    normalizeTrajectoryEvent({
      source: "permission_fixture",
      phase: "permission",
      conditionId: "C3",
      taskId: result.id || result.fixtureId || result.name,
      category: result.category,
      status: result.pass === false || result.status === "fail" ? "fail" : "observed",
      metrics: {
        humanPrompt: observedVerdict === "ask_once" ? 1 : 0,
        deny: observedVerdict === "deny" ? 1 : 0,
        leaseHit: result.leaseHit ? 1 : 0
      },
      expected: {
        verdict: expectedVerdict,
        actionGrant: expectedActionGrant
      },
      observed: {
        verdict: observedVerdict,
        actionGrant: observedActionGrant
      },
      failures
    })
  ];
}

export function buildDelegationContract({ analysis = {}, taskSpec = {}, lease = null, frontiers = null, decisionGate = {} } = {}) {
  const scopedFrontiers = frontiers || analysis.contextPack?.agentContext?.frontiers || {};
  const reviewFrontier = scopedFrontiers.reviewFrontier || {};
  const symbolFrontier = scopedFrontiers.symbolFrontier || {};
  const permissionFrontier = scopedFrontiers.permissionFrontier || {};
  const graphScope = scopedFrontiers.graphScope || {};
  const allowedActions = uniqueStrings(arrayFrom(permissionFrontier.items)
    .map((item) => item.id || item.label)
    .filter((item) => String(item || "").startsWith("action:"))
    .map((item) => String(item).replace(/^action:/, "")));
  const reviewFiles = uniqueStrings(arrayFrom(reviewFrontier.items)
    .map((item) => item.path)
    .filter(Boolean))
    .slice(0, 8);
  const symbols = uniqueStrings(arrayFrom(symbolFrontier.items)
    .map((item) => item.symbol ? `${item.path || ""}#${item.symbol}` : "")
    .filter(Boolean))
    .slice(0, 8);
  return {
    kind: "scopelease.compact_agent_contract",
    version: 2,
    requestHash: taskSpec.requestHash || stableHash(taskSpec.request || analysis.contextPack?.userRequest?.text || ""),
    baselineHash: analysis.baselineHash || analysis.baselineAt || "",
    graphScopeHash: graphScope.hash || analysis.contextPack?.agentContext?.frontierSummary?.graphScopeHash || "",
    baselineGraphHash: graphScope.baselineGraphHash || "",
    reviewFrontierHash: reviewFrontier.hash || stableHash(JSON.stringify(reviewFrontier || {})),
    symbolFrontierHash: symbolFrontier.hash || stableHash(JSON.stringify(symbolFrontier || {})),
    permissionFrontierHash: permissionFrontier.hash || stableHash(JSON.stringify(permissionFrontier || {})),
    graphBackend: graphScope.backend || scopedFrontiers.graph?.backend || "",
    readFrontier: {
      files: reviewFiles,
      fileCount: reviewFrontier.size || reviewFrontier.nodes?.length || reviewFiles.length
    },
    symbolFrontier: {
      symbols,
      symbolCount: symbolFrontier.size || symbolFrontier.nodes?.length || symbols.length
    },
    permission: {
      allowedActions,
      canAutoApplyPatch: Boolean(decisionGate.canAutoApplyPatch),
      canAutoPreparePatch: Boolean(decisionGate.canAutoPreparePatch)
    },
    agentMust: [
      "start with graphQueryHints/readPlan before broad search",
      "use symbolFrontier for changed symbol definitions and direct callers",
      "call guard before apply_patch, network, external write, or checkpoint"
    ],
    agentMustNot: [
      "treat full repository tokens as measured savings",
      "leave graph scope without a new guard decision",
      "checkpoint baseline without explicit approval"
    ],
    stopConditions: arrayFrom(scopedFrontiers.stopWhen || scopedFrontiers.stopFrontier?.items).map((item) => item.label || item.id || item),
    lease: lease
      ? {
        id: lease.id,
        signatureAlgorithm: lease.signatureAlgorithm,
        signatureKeyId: lease.signatureKeyId,
        expiresAt: lease.expiresAt
      }
      : null,
    boundary: "compact_contract_guides_agent; enforcement still requires guard or connected hook"
  };
}

function normalizeMetrics(value = {}) {
  const keys = [
    "defaultTokens",
    "scopeleaseTokens",
    "savedTokens",
    "savedPercent",
    "commandDefaultTokens",
    "commandScopeLeaseTokens",
    "commandSavedTokens",
    "commandSavedPercent",
    "defaultCalls",
    "scopeleaseCalls",
    "savedCalls",
    "callSavedPercent",
    "baselineFiles",
    "reviewFrontierFiles",
    "criticalFileRecallPercent",
    "criticalFilePrecisionPercent",
    "humanPrompt",
    "deny",
    "leaseHit",
    "durationMs"
  ];
  const metrics = {};
  for (const key of keys) {
    if (value[key] !== undefined) metrics[key] = value[key];
  }
  return metrics;
}

function normalizeFailures(value = {}) {
  const failures = {};
  for (const type of SILENT_FAILURE_TYPES) {
    const items = arrayFrom(value[type]);
    failures[type] = items.filter(Boolean).map(String);
  }
  return failures;
}

function normalizeConditionId(value = "") {
  const text = String(value || "").toUpperCase();
  if (TRAJECTORY_CONDITIONS.includes(text)) return text;
  if (text.includes("SCOPELEASE") || text === "C3") return "C3";
  if (text.includes("DEFAULT") || text.includes("BASELINE") || text === "C0") return "C0";
  return text || "unknown";
}

function stableHash(value = "") {
  return `sha1:${createHash("sha1").update(String(value || "")).digest("hex")}`;
}

function arrayFrom(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}
