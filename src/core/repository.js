import fs from "node:fs";
import path from "node:path";
import { CARD_FILE, CODE_EXTENSIONS, CODEX_INPUT_FILE, CONFIG_EXTENSIONS, CONTEXT_FILE, CONTEXT_LEDGER_FILE, DECISION_DIR, DOC_EXTENSIONS, STATE_FILE, STATE_VERSION } from "../constants.js";
import {
  decisionPath,
  ensureDir,
  hashText,
  readJson,
  readText,
  shouldIgnoreRelative,
  toRelative,
  writeCompactJson,
  writeJson,
  writeText
} from "../fs-utils.js";
import { ensurePolicyFile, loadPolicies, matchPolicies } from "../policy.js";
import { buildDecisionCardMarkdown, buildContextPack } from "./artifacts.js";
import { assess } from "./assessment.js";
import { detectChanges, emptyAnalysis, mapChangedSymbols, summarizeChanges } from "./change-set.js";
import { buildEvent, compactEvents } from "./events.js";
import { findRelated, buildImpactGraph, buildKnowledgeGraph } from "./impact.js";
import { buildIndex } from "./indexer.js";
import { countTokensForTexts } from "./tokenizer.js";
import { buildTaskIntent, deriveWorkIntent, extractUserRequestText, normalizeRequestKey, requestHash } from "./work-intent.js";

const BASELINE_CONTENT_CHAR_LIMIT = 64_000;
const SENSITIVE_BASELINE_BASENAMES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials.json",
  "credential.json",
  "secrets.json",
  "secret.json",
  "service-account.json"
]);
const SENSITIVE_BASELINE_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx"]);

export function initRepository(repoPath) {
  const root = path.resolve(repoPath);
  ensureDir(decisionPath(root));
  ensurePolicyFile(root);
  ensureLocalStateIgnored(root);
  return checkpointRepository(root);
}

export function checkpointRepository(repoPath) {
  const root = path.resolve(repoPath);
  ensureDir(decisionPath(root));
  ensurePolicyFile(root);
  ensureLocalStateIgnored(root);
  const previous = loadState(root) || {};

  const index = buildIndex(root);
  const analysis = emptyAnalysis(root);
  analysis.repoStats = summarizeRepository(index);
  analysis.knowledgeGraph = buildKnowledgeGraph({
    root,
    index,
    changedFiles: [],
    changedSymbols: {},
    related: {},
    policyHits: [],
    assessment: { risk: "low" }
  });
  analysis.contextPack = buildContextPack(analysis);
  analysis.decisionCard = buildDecisionCardMarkdown(analysis);

  const state = {
    version: STATE_VERSION,
    repo: root,
    indexedAt: new Date().toISOString(),
    baselineHashes: index.fileHashes,
    baselineIndex: compactBaselineIndex(index),
    index: compactStoredIndex(index),
    events: [],
    requestLedgers: [],
    actualWorkEvents: [],
    graphLayoutMetricEvents: [],
    mcpContextEvents: [],
    modelUsageEvents: [],
    measurementMode: measurementModeForState(previous),
    approvalLeases: [],
    guardEvents: [],
    fatigueEvents: [],
    fatigueMetrics: emptyFatigueMetrics(),
    latestAnalysis: analysis
  };

  saveState(root, state);
  writeArtifacts(root, analysis);
  return state;
}

export function loadState(repoPath) {
  const root = path.resolve(repoPath);
  return readJson(decisionPath(root, STATE_FILE), null);
}

export function saveState(repoPath, state) {
  writeCompactJson(decisionPath(repoPath, STATE_FILE), state);
}

export function measurementModeForState(state = {}) {
  const mode = state.measurementMode && typeof state.measurementMode === "object"
    ? state.measurementMode
    : {};
  return {
    kind: "scopelease.measurement_mode",
    enabled: mode.enabled !== false,
    scope: "codex_hook_and_mcp_context_events",
    updatedAt: mode.updatedAt || "",
    source: mode.source || "default",
    note: mode.note || "Records Codex hook payloads and ScopeLease MCP context events for paired agent-visible metering."
  };
}

export function getMeasurementMode(repoPath) {
  const root = path.resolve(repoPath);
  const state = loadState(root) || checkpointRepository(root);
  return measurementModeForState(state);
}

export function setMeasurementMode(repoPath, options = {}) {
  const root = path.resolve(repoPath);
  const state = loadState(root) || checkpointRepository(root);
  const current = measurementModeForState(state);
  const enabled = options.enabled === undefined ? current.enabled : normalizeMeasurementEnabled(options.enabled);
  const measurementMode = {
    ...current,
    enabled,
    updatedAt: new Date().toISOString(),
    source: String(options.source || "manual").trim(),
    note: String(options.note || (enabled ? "Automatic metering enabled." : "Automatic metering disabled.")).trim()
  };
  const next = { ...state, measurementMode };
  saveState(root, next);
  return { state: next, measurementMode };
}

export function shouldRecordAutomaticMeasurement(state = {}, source = "") {
  const mode = measurementModeForState(state);
  if (mode.enabled !== false) return true;
  return !isAutomaticMeasurementSource(source);
}

export function ensureLocalStateIgnored(repoPath) {
  const root = path.resolve(repoPath);
  const gitInfoDir = path.join(root, ".git", "info");
  if (!fs.existsSync(gitInfoDir)) return { applied: false, reason: "not_git_repo" };
  const excludePath = path.join(gitInfoDir, "exclude");
  const entries = [".decision/", ".codex/", ".scopelease/"];
  const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
  const lines = new Set(current.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const missing = entries.filter((entry) => !lines.has(entry));
  if (!missing.length) return { applied: false, path: excludePath, missing: [] };
  ensureDir(gitInfoDir);
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(excludePath, `${prefix}\n# ScopeLease local state\n${missing.join("\n")}\n`);
  return { applied: true, path: excludePath, missing };
}

function normalizeMeasurementEnabled(value) {
  if (typeof value === "boolean") return value;
  return /^(1|true|yes|on|enable|enabled|actual)$/i.test(String(value || "").trim());
}

function isAutomaticMeasurementSource(source = "") {
  return /^(codex-hook|mcp:scopelease_get_context|scopelease_get_context|watch:auto)/i.test(String(source || "").trim());
}

export function analyzeRepository(repoPath, options = {}) {
  const root = path.resolve(repoPath);
  const analysisOptions = {
    ...options,
    userRequest: normalizeUserRequestOption(options.userRequest)
  };
  ensureDir(decisionPath(root));
  ensurePolicyFile(root);

  const previous = loadState(root) || checkpointRepository(root);
  const index = buildIndex(root);
  const baselineIndex = selectBaselineIndex(previous, index);
  const previousForAnalysis = {
    ...previous,
    baselineIndex
  };
  const changes = detectChanges(previous.baselineHashes || {}, index.fileHashes);
  const changedFiles = [...changes.added, ...changes.modified].sort();
  const deletedFiles = changes.deleted.sort();
  const changedSymbols = mapChangedSymbols(index, changedFiles);
  const policyHits = findPolicyHits(root, index, changedFiles, changedSymbols);
  const impact = findRelated(index, changedFiles, changedSymbols, policyHits);
  const assessment = assess({ changedFiles, deletedFiles, changedSymbols, policyHits, related: impact, index });

  const analysis = createAnalysis({
    root,
    previous: previousForAnalysis,
    index,
    options: analysisOptions,
    changes,
    changedFiles,
    deletedFiles,
    changedSymbols,
    policyHits,
    impact,
    assessment
  });

  const events = changedFiles.length || deletedFiles.length
    ? compactEvents([buildEvent(analysis), ...(previous.events || [])]).slice(0, 80)
    : previous.events || [];
  const requestLedgers = compactRequestLedgers([
    buildRequestLedger(analysis),
    ...(previous.requestLedgers || [])
  ]).slice(0, 80);
  const autoWorkEvents = analysisOptions.autoMeasureWork && shouldRecordAutomaticMeasurement(previous, "watch:auto")
    ? buildAutoWorkEvents({ previous: previousForAnalysis, index, analysis, changedFiles, deletedFiles })
    : [];

  saveState(root, {
    ...previous,
    repo: root,
    version: STATE_VERSION,
    baselineIndex: compactBaselineIndex(baselineIndex),
    index: compactStoredIndex(index),
    events,
    requestLedgers,
    actualWorkEvents: compactActualWorkEvents([...autoWorkEvents, ...(previous.actualWorkEvents || [])]),
    modelUsageEvents: compactModelUsageEvents(previous.modelUsageEvents || []),
    measurementMode: measurementModeForState(previous),
    approvalLeases: previous.approvalLeases || [],
    guardEvents: (previous.guardEvents || []).slice(0, 160),
    fatigueEvents: compactFatigueEvents(previous.fatigueEvents || []),
    fatigueMetrics: previous.fatigueMetrics || emptyFatigueMetrics(),
    latestAnalysis: analysis
  });
  writeArtifacts(root, analysis);
  return analysis;
}

export function recordActualWork(repoPath, options = {}) {
  const root = path.resolve(repoPath);
  ensureDir(decisionPath(root));
  const state = loadState(root) || checkpointRepository(root);
  const latest = state.latestAnalysis || {};
  const phase = normalizeWorkPhase(options.phase);
  const text = String(options.text || "");
  const tokenResult = countTokensForTexts([text], {
    encoding: latest.contextPack?.tokenEconomy?.tokenizer?.encoding || latest.repoStats?.tokenizer?.encoding
  });
  const tokens = tokenResult.counts[0] || 0;
  const baselineTokens = resolveActualWorkBaseline(options, latest);
  const baselineDeltaTokens = baselineTokens ? Math.max(0, baselineTokens - tokens) : 0;
  const userRequest = String(options.request || latest.contextPack?.userRequest?.text || latest.userRequest || extractUserRequestText(text) || "").trim();
  const lane = normalizeObservationLane(options.lane || options.runLane || options.source);
  const pairId = normalizePairId(options.pairId || options.pair_id || options.pair || "");
  const explicitWorkIntent = options.workIntent || options.work_intent || options.intent || "";
  const workIntent = deriveWorkIntent({ request: userRequest, text, workIntent: explicitWorkIntent });
  const toolName = normalizeToolName(options.toolName || options.tool_name || options.tool || "");
  const callType = normalizeCallType(options.callType || options.call_type || (toolName ? "tool_call" : ""));
  const toolFamily = toolFamilyFor(toolName);
  const taskIntent = options.taskIntent || buildTaskIntent({ request: userRequest, text, workIntent }, {
    pairId,
    paths: [options.path].filter(Boolean)
  });
  const event = {
    kind: "scopelease.actual_work_event",
    id: hashText(JSON.stringify({
      timestamp: Date.now(),
      phase,
      source: options.source || "manual",
      label: options.label || options.path || phase,
      textHash: hashText(text),
      userRequest,
      lane,
      pairId
    })),
    timestamp: new Date().toISOString(),
    userRequest,
    requestKey: normalizeRequestKey(userRequest),
    requestHash: requestHash(userRequest),
    workIntent,
    pairingKey: workIntent,
    taskIntent,
    lane,
    pairId,
    runId: String(options.runId || options.run || "").trim(),
    phase,
    source: options.source || "manual",
    label: options.label || options.path || phase,
    path: options.path || "",
    callType,
    toolName,
    toolFamily,
    hookEventName: String(options.hookEventName || options.hook_event_name || "").trim(),
    tokenCounter: tokenResult.tokenizer?.exact
      ? `${tokenResult.tokenizer.method || "tiktoken"}:${tokenResult.tokenizer.encoding || ""}`
      : "fallback",
    tokens,
    chars: text.length,
    baselineTokens,
    baselineDeltaTokens,
    baselineDeltaPercent: baselineTokens ? Math.round((baselineDeltaTokens / baselineTokens) * 100) : null,
    baselineComparisonMeasured: Boolean(baselineTokens),
    note: baselineTokens
      ? "사용자가 제공한 기준 토큰과 실제 관측 payload 토큰의 차이입니다."
      : "실제 작업 payload 토큰은 계측됐지만, 절감률은 같은 workIntent의 default-codex lane과 scopelease-codex lane을 pair로 묶어 계산합니다."
  };
  const next = {
    ...state,
    actualWorkEvents: compactActualWorkEvents([event, ...(state.actualWorkEvents || [])])
  };
  saveState(root, next);
  return { state: next, event };
}

export function recordGraphLayoutMetrics(repoPath, options = {}) {
  const root = path.resolve(repoPath);
  ensureDir(decisionPath(root));
  const state = loadState(root) || checkpointRepository(root);
  const lanes = normalizeGraphLayoutLanes(options.lanes || options.metrics || []);
  const summary = normalizeGraphLayoutSummary(options.summary || {}, lanes);
  const event = {
    kind: "scopelease.graph_layout_metric_event",
    id: hashText(JSON.stringify({
      timestamp: Date.now(),
      layout: options.layout,
      scope: options.scope,
      eventReason: options.eventReason,
      lanes,
      summary
    })),
    timestamp: new Date().toISOString(),
    source: options.source || "graph-view",
    layout: String(options.layout || "lanes"),
    scope: String(options.scope || ""),
    eventReason: String(options.eventReason || ""),
    userRequest: String(options.userRequest || options.request || state.latestAnalysis?.contextPack?.userRequest?.text || ""),
    nodeCount: Number(options.nodeCount || 0),
    edgeCount: Number(options.edgeCount || 0),
    laneCount: lanes.length,
    summary,
    lanes
  };
  const next = {
    ...state,
    graphLayoutMetricEvents: compactGraphLayoutMetricEvents([event, ...(state.graphLayoutMetricEvents || [])])
  };
  saveState(root, next);
  return { state: next, event };
}

export function recordModelUsage(repoPath, options = {}) {
  const root = path.resolve(repoPath);
  ensureDir(decisionPath(root));
  const state = loadState(root) || checkpointRepository(root);
  const latest = state.latestAnalysis || {};
  const usage = normalizeModelUsage(options.usage || options.raw?.usage || options);
  const userRequest = String(options.request || options.userRequest || latest.contextPack?.userRequest?.text || latest.userRequest || "").trim();
  const workIntent = deriveWorkIntent({ request: userRequest, workIntent: options.workIntent || options.work_intent || options.intent || "" });
  const taskIntent = options.taskIntent || buildTaskIntent({ request: userRequest, workIntent });
  const requestId = String(options.requestId || options.responseId || options.id || options.raw?.id || "").trim();
  const source = String(options.source || "manual").trim();
  const provider = String(options.provider || "codex").trim();
  const model = String(options.model || options.raw?.model || latest.model || "").trim();
  const lane = normalizeObservationLane(options.lane || options.runLane || options.raw?.lane || "");
  const pairId = normalizePairId(options.pairId || options.pair_id || options.raw?.pairId || options.raw?.pair_id || "");
  const runId = String(options.runId || options.run_id || options.raw?.runId || options.raw?.run_id || "").trim();
  const idSeed = requestId ? {
    source,
    provider,
    model,
    requestId,
    userRequest,
    lane,
    pairId,
    runId,
    usage
  } : {
    timestamp: Date.now(),
    source,
    provider,
    model,
    userRequest,
    lane,
    pairId,
    runId,
    usage
  };
  const event = {
    kind: "scopelease.model_usage_event",
    id: `model_usage_${hashText(JSON.stringify(idSeed))}`,
    timestamp: new Date().toISOString(),
    userRequest,
    requestKey: normalizeRequestKey(userRequest),
    requestHash: requestHash(userRequest),
    workIntent,
    pairingKey: workIntent,
    taskIntent,
    lane,
    pairId,
    runId,
    source,
    provider,
    model,
    requestId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cachedInputTokens: usage.cachedInputTokens,
    totalTokens: usage.totalTokens,
    totalMeasured: usage.totalMeasured,
    totalCostUsd: usage.totalCostUsd,
    costMeasured: usage.costMeasured,
    totalCalls: usage.totalCalls,
    rawUsage: usage.rawUsage,
    note: usage.totalMeasured
      ? "모델/API 런타임이 반환한 usage.total_tokens 계열 값을 저장했습니다."
      : "모델/API usage에서 total token이 없어 부분 토큰만 저장했습니다. 이 값은 실사용 총량으로 확정하지 않습니다."
  };
  const next = {
    ...state,
    modelUsageEvents: compactModelUsageEvents([event, ...(state.modelUsageEvents || [])])
  };
  saveState(root, next);
  return { state: next, event };
}

export function recordGuardDecision(repoPath, options = {}) {
  const root = path.resolve(repoPath);
  ensureDir(decisionPath(root));
  const state = loadState(root) || checkpointRepository(root);
  const latest = state.latestAnalysis || {};
  const verdict = options.verdict || {};
  const action = options.action || verdict.action || {};
  const userRequest = String(
    options.request ||
    options.userRequest ||
    latest.contextPack?.userRequest?.text ||
    latest.userRequest ||
    ""
  ).trim();
  const workIntent = deriveWorkIntent({
    request: userRequest,
    workIntent: options.workIntent || options.work_intent || verdict.workIntent || ""
  });
  const event = {
    kind: "scopelease.guard_event",
    id: `guard_${hashText(JSON.stringify({
      timestamp: Date.now(),
      source: options.source || "manual",
      userRequest,
      verdict: verdict.verdict,
      actionGrant: verdict.actionGrant,
      action
    }))}`,
    timestamp: new Date().toISOString(),
    source: options.source || "manual",
    userRequest,
    requestKey: normalizeRequestKey(userRequest),
    requestHash: requestHash(userRequest),
    workIntent,
    pairingKey: workIntent,
    pairId: normalizePairId(options.pairId || options.pair_id || verdict.pairId || action.pairId || ""),
    runId: String(options.runId || options.run_id || verdict.runId || action.runId || "").trim(),
    verdict: verdict.verdict || "",
    actionGrant: verdict.actionGrant || "",
    reason: verdict.reason || "",
    leaseId: verdict.leaseId || null,
    shouldAskHuman: Boolean(verdict.shouldAskHuman),
    action: compactActionForState(action),
    decisionBundleId: verdict.decisionBundle?.id || null,
    scope: verdict.decisionBundle?.scope || null,
    agentJudgment: compactAgentJudgmentForState(verdict.decisionBundle?.agentJudgment),
    decisionAssistance: compactDecisionAssistanceForState(verdict.decisionBundle?.decisionAssistance)
  };
  const fatigueEvents = buildFatigueEventsFromGuard(event);
  const next = {
    ...state,
    guardEvents: compactGuardEvents([event, ...(state.guardEvents || [])]),
    fatigueEvents: compactFatigueEvents([...fatigueEvents, ...(state.fatigueEvents || [])]),
    fatigueMetrics: updateFatigueMetricsFromGuard(state.fatigueMetrics || emptyFatigueMetrics(), verdict)
  };
  saveState(root, next);
  return { state: next, event, fatigueEvents };
}

export function recordDecisionFatigueEvent(repoPath, options = {}) {
  const root = path.resolve(repoPath);
  ensureDir(decisionPath(root));
  const state = loadState(root) || checkpointRepository(root);
  const latest = state.latestAnalysis || {};
  const userRequest = String(
    options.request ||
    options.userRequest ||
    latest.contextPack?.userRequest?.text ||
    latest.userRequest ||
    ""
  ).trim();
  const workIntent = deriveWorkIntent({
    request: userRequest,
    workIntent: options.workIntent || options.work_intent || options.intent || ""
  });
  const eventType = normalizeFatigueEventType(options.type || options.eventType || options.kind || "human_decision_recorded");
  const event = {
    kind: "scopelease.decision_fatigue_event",
    id: `fatigue_${hashText(JSON.stringify({
      timestamp: Date.now(),
      source: options.source || "manual",
      eventType,
      userRequest,
      leaseId: options.leaseId || options.lease?.id || "",
      action: options.action || {}
    }))}`,
    timestamp: new Date().toISOString(),
    source: options.source || "manual",
    eventType,
    userRequest,
    requestKey: normalizeRequestKey(userRequest),
    requestHash: requestHash(userRequest),
    workIntent,
    pairingKey: workIntent,
    pairId: normalizePairId(options.pairId || options.pair_id || options.pair || ""),
    runId: String(options.runId || options.run_id || options.run || "").trim(),
    actor: String(options.actor || options.by || options.grantedBy || "human").trim(),
    leaseId: options.leaseId || options.lease?.id || null,
    decisionBundleId: options.decisionBundleId || options.decisionBundle?.id || null,
    verdict: options.verdict || "",
    actionGrant: options.actionGrant || "",
    label: String(options.label || "").trim(),
    durationMs: finiteNumber(options.durationMs || options.duration_ms),
    note: String(options.note || "").trim(),
    action: compactActionForState(options.action || {})
  };
  const next = {
    ...state,
    fatigueEvents: compactFatigueEvents([event, ...(state.fatigueEvents || [])]),
    fatigueMetrics: updateFatigueMetricsFromEvent(state.fatigueMetrics || emptyFatigueMetrics(), event)
  };
  saveState(root, next);
  return { state: next, event };
}

export function emptyFatigueMetrics() {
  return {
    humanPromptsShown: 0,
    humanDecisionsRecorded: 0,
    agentActionsAutoAllowed: 0,
    agentActionsDenied: 0,
    approvalLeaseHits: 0,
    approvalLeaseMisses: 0,
    approvalLeasesCreated: 0,
    repeatedQuestionsSuppressed: 0,
    clarificationPrompts: 0,
    overrideCount: 0,
    flowBreaks: 0,
    checkpointAttemptsBlocked: 0
  };
}

export function shouldIgnoreWatchPath(root, filename) {
  if (!filename) return true;
  const relativePath = toRelative(root, path.resolve(root, filename));
  return shouldIgnoreRelative(relativePath) || relativePath.startsWith(DECISION_DIR);
}

function findPolicyHits(root, index, changedFiles, changedSymbols) {
  const policies = loadPolicies(root);
  const fileTypes = Object.fromEntries(Object.entries(index.files).map(([file, value]) => [file, value.type]));
  const fileContents = Object.fromEntries(changedFiles.map((file) => [file, index.files[file]?.content || ""]));
  return matchPolicies({ policies, changedFiles, changedSymbols, fileTypes, fileContents });
}

function createAnalysis({
  root,
  previous,
  index,
  options,
  changes,
  changedFiles,
  deletedFiles,
  changedSymbols,
  policyHits,
  impact,
  assessment
}) {
  const analysis = {
    version: STATE_VERSION,
    repo: root,
    generatedAt: new Date().toISOString(),
    baselineAt: previous.indexedAt,
    summary: summarizeChanges({ changes, changedFiles, deletedFiles, changedSymbols, assessment }),
    userRequest: options.userRequest,
    risk: assessment.risk,
    uncertainty: assessment.uncertainty,
    recommendation: assessment.recommendation,
    reasons: assessment.reasons,
    changes: {
      added: changes.added,
      modified: changes.modified,
      deleted: changes.deleted,
      files: changedFiles,
      symbols: changedSymbols,
      fileHashes: Object.fromEntries(changedFiles.map((file) => [file, index.fileHashes[file]]))
    },
    impact,
    taskContext: findTaskContextCandidates(index, options.userRequest),
    policyHits,
    repoStats: summarizeRepository(index),
    graph: buildImpactGraph(index, changedFiles, changedSymbols, impact, policyHits),
    knowledgeGraph: buildKnowledgeGraph({
      root,
      index,
      changedFiles,
      changedSymbols,
      related: impact,
      policyHits,
      assessment
    }),
    operationalGraphBackend: options.graphBackendPayload || null,
    operationalGraphBackendName: options.graphBackendName || "",
    operationalGraphBackendSource: options.graphBackendSource || "",
    contextBudget: options.budget || 8000
  };

  analysis.contextPack = buildContextPack(analysis, { userRequest: options.userRequest });
  analysis.decisionCard = buildDecisionCardMarkdown(analysis);
  return analysis;
}

const TASK_CONTEXT_STOP_WORDS = new Set([
  "about",
  "agent",
  "scopelease",
  "change",
  "check",
  "code",
  "context",
  "current",
  "edit",
  "explain",
  "file",
  "files",
  "find",
  "identify",
  "minimum",
  "needed",
  "review",
  "safe",
  "should",
  "search",
  "test",
  "tests",
  "term",
  "terms",
  "this",
  "what",
  "where",
  "which",
  "with"
]);

function findTaskContextCandidates(index = {}, userRequest = "", limit = 48) {
  const terms = requestContextTerms(userRequest);
  if (!terms.length) return [];
  const rows = [];
  for (const [file, meta] of Object.entries(index.files || {})) {
    const score = scoreTaskContextFile(file, meta.content || "", terms);
    if (score.hits <= 0) continue;
    rows.push({
      type: "task_context",
      path: file,
      reason: "user request term match",
      hits: score.hits,
      terms: score.terms.slice(0, 5)
    });
  }
  return rows
    .sort((left, right) => right.hits - left.hits || left.path.localeCompare(right.path))
    .slice(0, limit);
}

function scoreTaskContextFile(file = "", content = "", terms = []) {
  const pathText = String(file || "").toLowerCase();
  const basename = path.basename(String(file || ""), path.extname(String(file || ""))).toLowerCase();
  const segments = pathText.split("/");
  const contentText = String(content || "").toLowerCase();
  let score = 0;
  const matched = [];
  for (const term of terms) {
    const lowered = term.toLowerCase();
    const pathHits = countTermHits(pathText, lowered);
    const contentHits = countTermHits(contentText, lowered);
    if (!pathHits && !contentHits) continue;
    matched.push(term);
    const weight = termScore(term);
    score += weight * Math.min(contentHits, 3);
    if (pathHits) score += weight * 8;
    if (basename === lowered) score += weight * 24;
    if (segments.includes(lowered)) score += weight * 16;
  }
  const sizePenalty = 1 + Math.log10(1 + String(content || "").length / 1000);
  return {
    hits: score > 0 ? Math.round(score / sizePenalty) : 0,
    terms: matched
  };
}

function requestContextTerms(userRequest = "") {
  const explicit = explicitReviewSearchTerms(userRequest);
  const raw = [...String(userRequest || "").matchAll(/\b[A-Za-z_][A-Za-z0-9_-]{2,}\b/g)]
    .map((match) => match[0])
    .filter((term) => !TASK_CONTEXT_STOP_WORDS.has(term.toLowerCase()));
  const ranked = [...new Set(raw)]
    .filter((term) => !explicit.includes(term))
    .sort((left, right) => termScore(right) - termScore(left) || left.localeCompare(right))
    .slice(0, Math.max(0, 12 - explicit.length));
  return [...new Set([...explicit, ...ranked])].slice(0, 12);
}

function explicitReviewSearchTerms(userRequest = "") {
  const match = String(userRequest || "").match(/^Review search terms:\s*(.+)$/im);
  if (!match) return [];
  return [...new Set(match[1]
    .split(",")
    .map((term) => term.trim())
    .filter(Boolean)
    .filter((term) => !TASK_CONTEXT_STOP_WORDS.has(term.toLowerCase())))];
}

function termScore(term = "") {
  let score = Math.min(12, String(term).length);
  if (/[A-Z]/.test(term) && /[a-z]/.test(term)) score += 6;
  if (term.includes("_") || term.includes("-")) score += 3;
  return score;
}

function countTermHits(text = "", term = "") {
  if (!term) return 0;
  let count = 0;
  let offset = 0;
  while (offset < text.length) {
    const index = text.indexOf(term, offset);
    if (index < 0) break;
    count += 1;
    offset = index + term.length;
  }
  return count;
}

function writeArtifacts(root, analysis) {
  writeJson(decisionPath(root, CONTEXT_FILE), analysis.contextPack);
  writeText(decisionPath(root, CARD_FILE), analysis.decisionCard);
  writeText(decisionPath(root, CODEX_INPUT_FILE), analysis.contextPack?.codexInput?.text || "");
  writeJson(decisionPath(root, CONTEXT_LEDGER_FILE), analysis.contextPack?.contextLedger || {});
}

function buildRequestLedger(analysis) {
  const economy = analysis.contextPack?.tokenEconomy || {};
  const labels = economy.labels || {};
  const userRequest = analysis.contextPack?.userRequest?.text || analysis.userRequest || "";
  const stages = new Map((analysis.contextPack?.agentContext?.processDelta?.stages || []).map((stage) => [stage.stage, stage]));
  const processTotal = stages.get("total_tokens");
  const processTotalKept = parseTokenLabel(processTotal?.kept);
  const totalKeptTokens = (economy.actualInputTokens || 0) + processTotalKept;
  const contextLedgerRows = Array.isArray(analysis.contextPack?.contextLedger?.rows)
    ? analysis.contextPack.contextLedger.rows.map(snapshotLedgerRow)
    : null;
  const entry = {
    timestamp: analysis.generatedAt,
    userRequest,
    tokenCounter: economy.exactTokens
      ? `${economy.tokenizer?.method || "tiktoken"}:${economy.tokenizer?.encoding || ""}`
      : "fallback",
    rows: contextLedgerRows?.length ? contextLedgerRows : [
      {
        key: "input",
        label: "입력",
        metric: "input_size",
        measured: true,
        baseline: labels.userRequest || String(economy.userRequestTokens || 0),
        kept: labels.actualInput || String(economy.actualInputTokens || 0),
        result: "절감 아님",
        percent: null,
        baselineTokens: economy.userRequestTokens || 0,
        keptTokens: economy.actualInputTokens || 0
      },
      stageLedgerRow(stages.get("explore"), { key: "explore", label: "탐색" }),
      stageLedgerRow(stages.get("edit"), { key: "edit", label: "수정" }),
      {
        key: "total",
        label: "총 토큰",
        metric: "session_total",
        measured: false,
        baseline: `입력 후보 ${formatTokenCount(economy.actualInputTokens || 0)} + 작업 프록시 ${formatTokenCount(processTotalKept)}`,
        kept: formatTokenCount(totalKeptTokens),
        result: `총 후보 ${formatTokenCount(totalKeptTokens)}`,
        percent: null,
        baselineTokens: totalKeptTokens,
        keptTokens: totalKeptTokens,
        note: "한 번의 요청에서 context window와 비교할 값입니다. 실제 Codex 내부 세션 토큰은 직접 계측 전까지 알 수 없어 작업 단계는 프록시로 더합니다."
      }
    ].filter(Boolean)
  };
  const signature = requestLedgerSignature(analysis, entry);
  return { id: signature, signature, ...entry };
}

function compactActualWorkEvents(events = []) {
  const seen = new Set();
  const seenAuto = new Set();
  const output = [];
  for (const event of events) {
    if (!event?.id || seen.has(event.id)) continue;
    if (isStaleEmptyAutoEditEvent(event)) continue;
    const autoKey = autoEventKey(event);
    if (autoKey) {
      if (seenAuto.has(autoKey)) continue;
      seenAuto.add(autoKey);
    }
    seen.add(event.id);
    output.push(event);
  }
  return output.slice(0, 500);
}

function normalizeGraphLayoutLanes(lanes = []) {
  return (Array.isArray(lanes) ? lanes : [])
    .map((lane) => ({
      key: String(lane.key || ""),
      label: String(lane.label || lane.key || ""),
      index: Number(lane.index || 0),
      count: Number(lane.count || 0),
      rows: Number(lane.rows || 0),
      columns: Number(lane.columns || 0),
      width: Number(lane.width || 0),
      height: Number(lane.height || 0),
      density: normalizeMetricNumber(lane.density),
      overlapCount: Number(lane.overlapCount || 0),
      minGap: normalizeMetricNumber(lane.minGap),
      maxRadius: normalizeMetricNumber(lane.maxRadius),
      status: String(lane.status || "ok")
    }))
    .filter((lane) => lane.key && lane.count >= 0)
    .sort((a, b) => a.index - b.index || a.key.localeCompare(b.key));
}

function normalizeGraphLayoutSummary(summary = {}, lanes = []) {
  return {
    laneCount: Number(summary.laneCount || lanes.length || 0),
    totalOverlapCount: Number(summary.totalOverlapCount ?? lanes.reduce((sum, lane) => sum + lane.overlapCount, 0)),
    maxDensity: normalizeMetricNumber(summary.maxDensity ?? Math.max(...lanes.map((lane) => lane.density), 0)),
    denseLaneCount: Number(summary.denseLaneCount ?? lanes.filter((lane) => lane.status === "dense").length),
    overlapLaneCount: Number(summary.overlapLaneCount ?? lanes.filter((lane) => lane.overlapCount > 0).length)
  };
}

function normalizeMetricNumber(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 1000) / 1000;
}

function compactGraphLayoutMetricEvents(events = []) {
  const seen = new Set();
  const output = [];
  for (const event of events) {
    if (!event?.id || seen.has(event.id)) continue;
    seen.add(event.id);
    output.push(event);
  }
  return output.slice(0, 240);
}

function compactModelUsageEvents(events = []) {
  const seen = new Set();
  const output = [];
  for (const event of events) {
    if (!event?.id || seen.has(event.id)) continue;
    seen.add(event.id);
    output.push(event);
  }
  return output.slice(0, 500);
}

function compactGuardEvents(events = []) {
  const seen = new Set();
  const output = [];
  for (const event of events) {
    const key = event?.id || JSON.stringify({
      timestamp: event?.timestamp,
      verdict: event?.verdict,
      actionGrant: event?.actionGrant,
      leaseId: event?.leaseId
    });
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(event);
  }
  return output.slice(0, 300);
}

function compactAgentJudgmentForState(agentJudgment = null) {
  if (!agentJudgment?.headline && !agentJudgment?.interpretedInput) return null;
  return {
    headline: String(agentJudgment.headline || "").trim(),
    interpretedInput: String(agentJudgment.interpretedInput || "").trim(),
    risk: String(agentJudgment.risk || "").trim(),
    scopeleaserity: String(agentJudgment.scopeleaserity || "").trim(),
    attention: String(agentJudgment.attention || "").trim(),
    interruptHuman: Boolean(agentJudgment.interruptHuman),
    recommendedChoice: String(agentJudgment.recommendedChoice || "").trim(),
    riskReasons: (agentJudgment.riskReasons || []).map((item) => String(item || "").trim()).filter(Boolean).slice(0, 6),
    decisionHelp: (agentJudgment.decisionHelp || []).map((item) => String(item || "").trim()).filter(Boolean).slice(0, 6),
    decisionAssistance: compactDecisionAssistanceForState(agentJudgment.decisionAssistance),
    decision: String(agentJudgment.decision || "").trim(),
    willDo: (agentJudgment.willDo || []).map((item) => String(item || "").trim()).filter(Boolean).slice(0, 5),
    approvalEffect: String(agentJudgment.approvalEffect || "").trim(),
    willNotDo: (agentJudgment.willNotDo || []).map((item) => String(item || "").trim()).filter(Boolean).slice(0, 5),
    action: {
      grant: String(agentJudgment.action?.grant || "").trim(),
      kind: String(agentJudgment.action?.kind || "").trim(),
      paths: (agentJudgment.action?.paths || []).map((item) => String(item || "").trim()).filter(Boolean).slice(0, 8)
    }
  };
}

function compactDecisionAssistanceForState(decisionAssistance = null) {
  if (!decisionAssistance?.surface && !decisionAssistance?.recommendedChoice) return null;
  return {
    version: Number(decisionAssistance.version || 1),
    surface: String(decisionAssistance.surface || "").trim(),
    interruptHuman: Boolean(decisionAssistance.interruptHuman),
    severity: String(decisionAssistance.severity || "").trim(),
    recommendedChoice: String(decisionAssistance.recommendedChoice || "").trim(),
    userDecisionKind: String(decisionAssistance.userDecisionKind || "").trim(),
    riskReasons: (decisionAssistance.riskReasons || []).map((item) => String(item || "").trim()).filter(Boolean).slice(0, 6),
    decisionHelp: (decisionAssistance.decisionHelp || []).map((item) => String(item || "").trim()).filter(Boolean).slice(0, 6),
    evaluationSignals: {
      humanTarget: String(decisionAssistance.evaluationSignals?.humanTarget || "").trim(),
      expectedCognitiveLoad: String(decisionAssistance.evaluationSignals?.expectedCognitiveLoad || "").trim(),
      observable: (decisionAssistance.evaluationSignals?.observable || []).map((item) => String(item || "").trim()).filter(Boolean).slice(0, 8),
      claim: String(decisionAssistance.evaluationSignals?.claim || "").trim()
    },
    stopWhen: (decisionAssistance.stopWhen || []).map((item) => String(item || "").trim()).filter(Boolean).slice(0, 6)
  };
}

function compactFatigueEvents(events = []) {
  const seen = new Set();
  const output = [];
  for (const event of events) {
    const key = event?.id || JSON.stringify({
      timestamp: event?.timestamp,
      eventType: event?.eventType,
      leaseId: event?.leaseId,
      verdict: event?.verdict
    });
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(event);
  }
  return output.slice(0, 500);
}

function buildFatigueEventsFromGuard(guardEvent = {}) {
  const events = [];
  const base = {
    source: guardEvent.source,
    userRequest: guardEvent.userRequest,
    requestKey: guardEvent.requestKey,
    requestHash: guardEvent.requestHash,
    workIntent: guardEvent.workIntent,
    pairingKey: guardEvent.pairingKey,
    pairId: guardEvent.pairId,
    runId: guardEvent.runId,
    verdict: guardEvent.verdict,
    actionGrant: guardEvent.actionGrant,
    leaseId: guardEvent.leaseId,
    decisionBundleId: guardEvent.decisionBundleId,
    action: guardEvent.action
  };
  if (guardEvent.shouldAskHuman) {
    events.push(fatigueEventFromGuard({ ...base, eventType: "human_prompt_shown" }));
  }
  if (guardEvent.leaseId) {
    events.push(fatigueEventFromGuard({ ...base, eventType: "approval_lease_hit" }));
  } else if (guardEvent.verdict === "ask_once") {
    events.push(fatigueEventFromGuard({ ...base, eventType: "approval_lease_miss" }));
  }
  if (["allow", "allow_with_log", "prepare_only"].includes(guardEvent.verdict)) {
    events.push(fatigueEventFromGuard({ ...base, eventType: "agent_action_auto_allowed" }));
  }
  if (guardEvent.verdict === "deny") {
    events.push(fatigueEventFromGuard({ ...base, eventType: "agent_action_denied" }));
  }
  if (guardEvent.actionGrant === "checkpoint" && guardEvent.verdict !== "allow_with_log") {
    events.push(fatigueEventFromGuard({ ...base, eventType: "checkpoint_attempt_blocked" }));
  }
  return events;
}

function fatigueEventFromGuard(value = {}) {
  const eventType = normalizeFatigueEventType(value.eventType);
  return {
    kind: "scopelease.decision_fatigue_event",
    id: `fatigue_${hashText(JSON.stringify({
      timestamp: Date.now(),
      guardId: value.id,
      eventType,
      verdict: value.verdict,
      actionGrant: value.actionGrant,
      leaseId: value.leaseId
    }))}`,
    timestamp: new Date().toISOString(),
    actor: "agent",
    eventType,
    ...value
  };
}

function updateFatigueMetricsFromGuard(metrics = {}, verdict = {}) {
  let next = { ...emptyFatigueMetrics(), ...metrics };
  for (const event of buildFatigueEventsFromGuard({
    verdict: verdict.verdict,
    actionGrant: verdict.actionGrant,
    leaseId: verdict.leaseId || null,
    shouldAskHuman: Boolean(verdict.shouldAskHuman)
  })) {
    next = updateFatigueMetricsFromEvent(next, event);
  }
  return next;
}

function updateFatigueMetricsFromEvent(metrics = {}, event = {}) {
  const next = { ...emptyFatigueMetrics(), ...metrics };
  const eventType = normalizeFatigueEventType(event.eventType);
  if (eventType === "human_prompt_shown" || eventType === "approval_prompt_shown") next.humanPromptsShown += 1;
  if (eventType === "human_decision_recorded") next.humanDecisionsRecorded += 1;
  if (eventType === "agent_action_auto_allowed") next.agentActionsAutoAllowed += 1;
  if (eventType === "agent_action_denied") next.agentActionsDenied += 1;
  if (eventType === "approval_lease_hit") {
    next.approvalLeaseHits += 1;
    next.repeatedQuestionsSuppressed += 1;
  }
  if (eventType === "approval_lease_miss") next.approvalLeaseMisses += 1;
  if (eventType === "approval_lease_created") {
    next.approvalLeasesCreated += 1;
    if (String(event.actor || "").toLowerCase() !== "agent") next.humanDecisionsRecorded += 1;
  }
  if (eventType === "repeated_question_suppressed") next.repeatedQuestionsSuppressed += 1;
  if (eventType === "clarification_prompt_shown") next.clarificationPrompts += 1;
  if (eventType === "override_recorded") next.overrideCount += 1;
  if (eventType === "flow_break") next.flowBreaks += 1;
  if (eventType === "checkpoint_attempt_blocked") next.checkpointAttemptsBlocked += 1;
  return next;
}

function normalizeFatigueEventType(value = "") {
  const type = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (type === "ask_once" || type === "prompt" || type === "approval_prompt") return "human_prompt_shown";
  if (type === "allow" || type === "allow_with_log" || type === "prepare_only") return "agent_action_auto_allowed";
  if (type === "deny") return "agent_action_denied";
  if (type === "lease_hit") return "approval_lease_hit";
  if (type === "lease_miss") return "approval_lease_miss";
  if (type === "lease_created") return "approval_lease_created";
  return type || "human_decision_recorded";
}

function compactActionForState(action = {}) {
  if (!action || typeof action !== "object") return {};
  const paths = action.paths || action.files || action.path || action.file || [];
  const normalizedPaths = Array.isArray(paths) ? paths : [paths].filter(Boolean);
  return {
    kind: action.kind || action.type || "",
    summary: action.summary || action.label || "",
    risk: action.risk || "",
    paths: normalizedPaths.map(String).slice(0, 32),
    command: action.command ? String(action.command).slice(0, 400) : "",
    target: action.target ? String(action.target).slice(0, 400) : ""
  };
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeModelUsage(value = {}) {
  const usage = value?.usage && typeof value.usage === "object" ? value.usage : value;
  const inputTokens = firstNumber(
    usage.inputTokens,
    usage.input_tokens,
    usage.prompt_tokens,
    usage.totalInputTokens,
    usage.total_input_tokens
  );
  const outputTokens = firstNumber(
    usage.outputTokens,
    usage.output_tokens,
    usage.completion_tokens,
    usage.totalOutputTokens,
    usage.total_output_tokens
  );
  const reasoningTokens = firstNumber(
    usage.reasoningTokens,
    usage.reasoning_tokens,
    usage.output_tokens_details?.reasoning_tokens,
    usage.completion_tokens_details?.reasoning_tokens
  );
  const cachedInputTokens = firstNumber(
    usage.cachedInputTokens,
    usage.cached_input_tokens,
    usage.input_tokens_details?.cached_tokens,
    usage.prompt_tokens_details?.cached_tokens
  );
  const explicitTotal = firstNumber(
    usage.totalTokens,
    usage.total_tokens,
    usage.total
  );
  const costFields = [
    usage.totalCostUsd,
    usage.total_cost_usd,
    usage.costUsd,
    usage.cost_usd,
    usage.cost
  ];
  const totalCostUsd = firstNumber(...costFields);
  const totalCalls = firstNumber(
    usage.totalCalls,
    usage.total_calls,
    usage.calls,
    usage.call_count
  );
  const hasProviderSummaryTotals = [
    usage.totalInputTokens,
    usage.total_input_tokens,
    usage.totalOutputTokens,
    usage.total_output_tokens
  ].some((item) => Number.isFinite(Number(item)) && Number(item) >= 0);
  const costMeasured = costFields.some((item) => Number.isFinite(Number(item)) && Number(item) >= 0);
  const fallbackTotal = [inputTokens, outputTokens].some((item) => item > 0)
    ? inputTokens + outputTokens
    : 0;
  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedInputTokens,
    totalTokens: explicitTotal || fallbackTotal,
    totalMeasured: explicitTotal > 0 || hasProviderSummaryTotals,
    totalCostUsd,
    costMeasured,
    totalCalls,
    rawUsage: usage
  };
}

function firstNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return 0;
}

function autoEventKey(event = {}) {
  if (!String(event.source || "").startsWith("watch:auto-")) return "";
  return [
    event.requestKey || normalizeRequestKey(event.userRequest || ""),
    event.source || "",
    event.phase || "",
    event.path || "",
    String(event.label || "").replace(/\d+/g, "#")
  ].join("|");
}

function isStaleEmptyAutoEditEvent(event = {}) {
  return event.source === "watch:auto-edit" &&
    String(event.label || "").startsWith("자동 감지 diff") &&
    Number(event.tokens || 0) <= 10 &&
    Number(event.chars || 0) <= 100;
}

function normalizeWorkPhase(value = "") {
  const phase = String(value || "").toLowerCase().trim();
  if (["input", "prompt", "user-prompt", "user_prompt"].includes(phase)) return "input";
  if (["explore", "read", "bash", "tool"].includes(phase)) return "explore";
  if (["edit", "patch", "diff", "write"].includes(phase)) return "edit";
  if (["output", "final", "answer", "response", "conclusion"].includes(phase)) return "output";
  throw new Error("measure phase must be one of input, explore, edit, output");
}

function normalizeObservationLane(value = "") {
  const lane = String(value || "").toLowerCase().trim().replace(/[_\s]+/g, "-");
  if (lane === "scopelease-internal" || lane.startsWith("watch:auto")) return "scopelease-internal";
  if (/(default|baseline|without-scopelease|no-scopelease|plain-codex)/.test(lane)) return "default-codex";
  if (/(scopelease-codex|with-scopelease|mcp|scopelease)/.test(lane)) return "scopelease-codex";
  return "unassigned";
}

function normalizeToolName(value = "") {
  return String(value || "").trim();
}

function normalizeCallType(value = "") {
  const type = String(value || "").toLowerCase().trim().replace(/[_\s]+/g, "-");
  if (!type) return "";
  if (["tool", "tool-call", "tool-use", "post-tool-use"].includes(type)) return "tool_call";
  if (["pre-tool", "pre-tool-use", "guard", "enforcement"].includes(type)) return "pre_tool_guard";
  return type;
}

function toolFamilyFor(toolName = "") {
  const tool = String(toolName || "").trim().toLowerCase();
  if (!tool) return "";
  if (tool === "bash" || tool === "shell") return "shell";
  if (/(apply_patch|edit|write)/.test(tool)) return "write";
  if (/(read|grep|glob|ls|find)/.test(tool)) return "read";
  return "other";
}

function normalizePairId(value = "") {
  return String(value || "").trim();
}

function resolveActualWorkBaseline(options = {}, latest = {}) {
  const value = Number(options.baselineTokens || options["baseline-tokens"] || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function buildAutoWorkEvents({ previous = {}, index = {}, analysis = {}, changedFiles = [], deletedFiles = [] }) {
  return [
    buildAutoExploreWorkEvent({ analysis, changedFiles, deletedFiles }),
    buildAutoEditWorkEvent({ previous, index, analysis, changedFiles, deletedFiles }),
    buildAutoOutputWorkEvent({ analysis })
  ].filter(Boolean);
}

function buildAutoExploreWorkEvent({ analysis = {}, changedFiles = [], deletedFiles = [] }) {
  const context = analysis.contextPack?.agentContext || {};
  const readPlan = context.readPlan || context.inputPlan?.readPlan || [];
  const traceLedger = context.traceLedger || context.inputPlan?.traceLedger || [];
  const text = JSON.stringify({
    summary: analysis.summary,
    risk: analysis.risk,
    recommendation: analysis.recommendation,
    changedFiles: changedFiles.slice(0, 24),
    deletedFiles: deletedFiles.slice(0, 12),
    readPlan: readPlan.slice(0, 24),
    traceLedger: traceLedger.slice(0, 8),
    policyHits: (analysis.policyHits || []).slice(0, 12).map((hit) => ({
      ruleId: hit.ruleId,
      risk: hit.risk,
      route: hit.route,
      paths: (hit.paths || []).slice(0, 8)
    })),
    affected: compactAffectedPayload(analysis.contextPack?.affected || context.affected || analysis.impact || {})
  }, null, 2);
  return buildAutoWorkEvent({
    analysis,
    phase: "explore",
    source: "watch:auto-explore",
    label: `자동 탐색 근거 ${readPlan.length}개 경로`,
    path: readPlan.slice(0, 3).map((item) => item.path).filter(Boolean).join(", "),
    text,
    signatureParts: {
      readPlan,
      traceLedger,
      changedFiles,
      deletedFiles,
      policyHits: (analysis.policyHits || []).map((hit) => hit.ruleId)
    },
    note: "ScopeLease가 실제 생성한 readPlan, trace, policy 근거 payload를 자동 계측했습니다. Codex 내부 hidden thinking은 포함하지 않습니다."
  });
}

function compactAffectedPayload(affected = {}) {
  return {
    paths: (affected.paths || []).slice(0, 12),
    routes: (affected.routes || []).slice(0, 8),
    tests: (affected.tests || []).slice(0, 8),
    docs: (affected.docs || []).slice(0, 8),
    policies: (affected.policies || []).slice(0, 8),
    counts: {
      paths: (affected.paths || []).length,
      routes: (affected.routes || []).length,
      tests: (affected.tests || []).length,
      docs: (affected.docs || []).length,
      policies: (affected.policies || []).length
    }
  };
}

function buildAutoEditWorkEvent({ previous = {}, index = {}, analysis = {}, changedFiles = [], deletedFiles = [] }) {
  const files = [...changedFiles, ...deletedFiles].filter(Boolean).sort();
  if (!files.length) return null;
  const text = buildChangePayload({ previous, index, changedFiles, deletedFiles });
  const fileHashes = analysis.changes?.fileHashes || {};
  return buildAutoWorkEvent({
    analysis,
    phase: "edit",
    source: "watch:auto-edit",
    label: `자동 감지 수정 ${files.length}개 파일`,
    path: files.slice(0, 3).join(", "),
    text,
    signatureParts: { files, fileHashes, deletedFiles },
    note: "watch가 기준점 이후 변경된 파일의 diff/snapshot payload를 자동 계측했습니다. 절감량은 비교 기준이 있을 때만 계산합니다."
  });
}

function buildAutoOutputWorkEvent({ analysis = {} }) {
  const gate = analysis.contextPack?.decisionGate || analysis.contextPack?.agentContext?.decisionGate || {};
  const fatiguePlan = analysis.contextPack?.agentContext?.fatiguePlan || {};
  const outputTrace = analysis.contextPack?.agentContext?.outputTrace || {};
  const contextLedger = analysis.contextPack?.contextLedger || {};
  const text = JSON.stringify({
    summary: analysis.summary,
    risk: analysis.risk,
    recommendation: analysis.recommendation,
    decision: {
      status: gate.status,
      statusLabel: gate.statusLabel,
      nextAction: gate.nextAction,
      permissionSummary: gate.permissionSummary,
      allowedActions: gate.allowedActions || [],
      blockedActions: gate.blockedActions || [],
      requiredChecks: gate.requiredChecks || []
    },
    fatigue: {
      askOnce: fatiguePlan.askOnce || [],
      stopWhen: fatiguePlan.stopWhen || [],
      decisionBundle: fatiguePlan.decisionBundle || null
    },
    outputTrace,
    contextLedgerRows: contextLedger.rows || []
  }, null, 2);
  return buildAutoWorkEvent({
    analysis,
    phase: "output",
    source: "watch:auto-output",
    label: gate.statusLabel ? `자동 결론 ${gate.statusLabel}` : "자동 결론 요약",
    path: "decisionGate, contextLedger",
    text,
    signatureParts: {
      gateStatus: gate.status,
      gateNextAction: gate.nextAction,
      risk: analysis.risk,
      recommendation: analysis.recommendation,
      contextLedgerRows: contextLedger.rows || []
    },
    note: "ScopeLease가 화면과 Codex input에 전달하는 결정/결론 요약 payload를 자동 계측했습니다. 실제 최종 답변 텍스트는 별도 output 이벤트로 보강할 수 있습니다."
  });
}

function buildAutoWorkEvent({ analysis = {}, phase, source, label, path: eventPath = "", text = "", signatureParts = {}, note = "" }) {
  if (!String(text || "").trim()) return null;
  const tokenResult = countTokensForTexts([text], {
    encoding: analysis.contextPack?.tokenEconomy?.tokenizer?.encoding || analysis.repoStats?.tokenizer?.encoding
  });
  const userRequest = String(analysis.contextPack?.userRequest?.text || analysis.userRequest || "").trim();
  const workIntent = deriveWorkIntent({ request: userRequest });
  const taskIntent = buildTaskIntent({ request: userRequest, workIntent }, { paths: [eventPath].filter(Boolean) });
  const signature = hashText(JSON.stringify({
    source,
    phase,
    userRequest,
    signatureParts
  }));
  return {
    kind: "scopelease.actual_work_event",
    id: `${String(source || "auto").replace(/[^a-z0-9]+/gi, "_")}_${signature}`,
    timestamp: analysis.generatedAt || new Date().toISOString(),
    userRequest,
    requestKey: normalizeRequestKey(userRequest),
    requestHash: requestHash(userRequest),
    workIntent,
    pairingKey: workIntent,
    taskIntent,
    lane: "scopelease-internal",
    runId: "",
    phase,
    source,
    label,
    path: eventPath,
    tokenCounter: tokenResult.tokenizer?.exact
      ? `${tokenResult.tokenizer.method || "tiktoken"}:${tokenResult.tokenizer.encoding || ""}`
      : "fallback",
    tokens: tokenResult.counts[0] || 0,
    chars: text.length,
    baselineTokens: 0,
    note
  };
}

function selectBaselineIndex(previous = {}, index = {}) {
  if (indexHasFileContent(previous.baselineIndex)) return previous.baselineIndex;
  if (indexHasFileContent(previous.index)) return previous.index;
  if (previous.baselineIndex?.files) return previous.baselineIndex;
  return index;
}

function compactStoredIndex(index = {}) {
  const files = Object.fromEntries(Object.entries(index.files || {}).map(([filePath, file = {}]) => [filePath, {
    path: file.path || filePath,
    type: file.type || "unknown",
    hash: file.hash || "",
    size: file.size || 0,
    lineCount: file.lineCount || 0,
    symbolCount: (file.symbols || []).length,
    importCount: (file.imports || []).length
  }]));
  return {
    generatedAt: index.generatedAt,
    schema: index.schema,
    fileHashes: index.fileHashes || {},
    files,
    fileCount: Object.keys(files).length,
    nodeCount: Object.keys(index.nodes || {}).length,
    edgeCount: (index.edges || []).length,
    contentStored: false,
    graphStored: false
  };
}

function compactBaselineIndex(index = {}) {
  let storedContentFiles = 0;
  const files = Object.fromEntries(Object.entries(index.files || {}).map(([filePath, file = {}]) => {
    const content = compactBaselineContent(file);
    if (content.contentStored) storedContentFiles += 1;
    return [filePath, {
      path: file.path || filePath,
      type: file.type || "unknown",
      hash: file.hash || "",
      size: file.size || 0,
      lineCount: file.lineCount || 0,
      ...content
    }];
  }));
  return {
    generatedAt: index.generatedAt,
    schema: index.schema,
    fileHashes: index.fileHashes || {},
    files,
    fileCount: Object.keys(files).length,
    contentStored: storedContentFiles > 0,
    storedContentFiles,
    graphStored: false
  };
}

function compactBaselineContent(file = {}) {
  if (typeof file.content !== "string") return { contentStored: false };
  if (!shouldStoreBaselineContent(file.path || "")) return { contentStored: false };
  const truncated = file.content.length > BASELINE_CONTENT_CHAR_LIMIT;
  return {
    content: truncated ? file.content.slice(0, BASELINE_CONTENT_CHAR_LIMIT) : file.content,
    contentStored: true,
    contentTruncated: truncated
  };
}

function shouldStoreBaselineContent(filePath = "") {
  if (isSensitiveBaselinePath(filePath)) return false;
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return CODE_EXTENSIONS.has(ext) || DOC_EXTENSIONS.has(ext) || CONFIG_EXTENSIONS.has(ext);
}

function isSensitiveBaselinePath(filePath = "") {
  const normalized = String(filePath || "").replace(/\\/g, "/").toLowerCase();
  const basename = path.posix.basename(normalized);
  if (!basename) return false;
  if (basename === ".env" || basename.startsWith(".env.")) return true;
  if (SENSITIVE_BASELINE_BASENAMES.has(basename)) return true;
  if (SENSITIVE_BASELINE_EXTENSIONS.has(path.posix.extname(basename))) return true;
  if (normalized.split("/").some((part) => [".aws", ".ssh", ".gnupg"].includes(part))) return true;
  return /(^|[._-])(secret|secrets|credential|credentials|api[_-]?key|private[_-]?key|service[_-]?account)([._-]|$)/i.test(basename);
}

function indexHasFileContent(index = {}) {
  return Object.values(index.files || {}).some((file) => typeof file?.content === "string");
}

function buildChangePayload({ previous = {}, index = {}, changedFiles = [], deletedFiles = [] }) {
  const parts = [];
  const baselineIndex = previous.baselineIndex || previous.index || {};
  for (const file of changedFiles.slice(0, 24)) {
    const before = baselineIndex.files?.[file]?.content || "";
    const after = index.files?.[file]?.content || "";
    parts.push(formatFilePatch(file, before, after) || formatFileSnapshot(file, after));
  }
  for (const file of deletedFiles.slice(0, 24)) {
    const before = baselineIndex.files?.[file]?.content || "";
    parts.push(formatFilePatch(file, before, "") || formatFileSnapshot(file, before));
  }
  const omitted = changedFiles.length + deletedFiles.length - parts.length;
  if (omitted > 0) parts.push(`... ${omitted} files omitted from automatic edit payload`);
  return parts.filter(Boolean).join("\n\n");
}

function formatFilePatch(file, before = "", after = "") {
  if (!before && !after) return "";
  if (!before) return truncatePatch(`+++ ${file}\n${prefixLines(after, "+")}`);
  if (!after) return truncatePatch(`--- ${file}\n${prefixLines(before, "-")}`);
  if (before === after) return "";
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  let start = 0;
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) start += 1;
  let endBefore = beforeLines.length - 1;
  let endAfter = afterLines.length - 1;
  while (endBefore >= start && endAfter >= start && beforeLines[endBefore] === afterLines[endAfter]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  const contextStart = Math.max(0, start - 3);
  const contextEndBefore = Math.min(beforeLines.length - 1, endBefore + 3);
  const contextEndAfter = Math.min(afterLines.length - 1, endAfter + 3);
  const contextBefore = beforeLines.slice(contextStart, start).map((line) => ` ${line}`);
  const removed = beforeLines.slice(start, endBefore + 1).map((line) => `-${line}`);
  const added = afterLines.slice(start, endAfter + 1).map((line) => `+${line}`);
  const contextAfter = afterLines.slice(endAfter + 1, contextEndAfter + 1).map((line) => ` ${line}`);
  const header = `--- ${file}\n+++ ${file}\n@@ ${contextStart + 1},${contextEndBefore + 1} @@`;
  return truncatePatch([header, ...contextBefore, ...removed, ...added, ...contextAfter].join("\n"));
}

function formatFileSnapshot(file, content = "") {
  if (!content) return "";
  return truncatePatch(`*** changed snapshot: ${file}\n${content}`);
}

function prefixLines(text = "", prefix = "") {
  return String(text || "").split(/\r?\n/).map((line) => `${prefix}${line}`).join("\n");
}

function truncatePatch(text = "", limit = 5000) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n... truncated ${text.length - limit} chars`;
}

function snapshotLedgerRow(row = {}) {
  const keptTokens = Number(row.keptTokens || parseTokenLabel(row.kept) || 0);
  const baselineTokens = Number(row.baselineTokens || keptTokens || 0);
  return {
    key: row.key,
    label: row.label,
    metric: row.metric || "actual_context",
    measured: row.measured !== false,
    baseline: row.baseline || formatTokenCount(baselineTokens),
    kept: row.kept || formatTokenCount(keptTokens),
    result: row.result || (row.measured === false ? "미계측" : `입력 후보 ${formatTokenCount(keptTokens)}`),
    percent: row.percent ?? null,
    baselineTokens,
    keptTokens,
    note: row.note || "ScopeLease context ledger snapshot"
  };
}

function stageLedgerRow(stage, { key, label }) {
  if (!stage) return null;
  const keptTokens = parseTokenLabel(stage.kept);
  return {
    key,
    label,
    metric: "work_proxy",
    measured: false,
    baseline: "직접 사용 미계측",
    kept: stage.kept || formatTokenCount(keptTokens),
    result: `후보 ${stage.kept || formatTokenCount(keptTokens)}`,
    percent: null,
    baselineTokens: 0,
    keptTokens,
    note: stage.basis
      ? `${stage.basis} 이 값은 실제 런타임 사용량이 아니라 계획 payload 후보입니다.`
      : "계획 payload 후보입니다. 실제 런타임 토큰과 구분합니다."
  };
}

function parseTokenLabel(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const text = String(value || "");
  const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*k/i);
  if (match) return Math.round(Number(match[1]) * 1000);
  const plain = Number(text.replace(/,/g, ""));
  return Number.isFinite(plain) ? plain : 0;
}

function formatTokenCount(value) {
  const tokens = Number(value || 0);
  if (!Number.isFinite(tokens) || tokens <= 0) return "0k";
  const scaled = tokens / 1000;
  return `${trimTrailingZero(scaled.toFixed(scaled >= 10 ? 1 : 2))}k`;
}

function trimTrailingZero(value) {
  return String(value).replace(/\.0$/, "").replace(/(\.\d*[1-9])0$/, "$1");
}

function compactRequestLedgers(entries = []) {
  const output = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!entry) continue;
    if (!entry.rows?.some((row) => row.key === "input" && ["input_size", "actual_context_input"].includes(row.metric))) continue;
    const signature = entry.signature || hashText(JSON.stringify({
      userRequest: entry.userRequest || "",
      rows: entry.rows || []
    }));
    if (seen.has(signature)) continue;
    seen.add(signature);
    output.push({ ...entry, signature, id: entry.id || signature });
  }
  return output;
}

function requestLedgerSignature(analysis, entry) {
  return hashText(JSON.stringify({
    userRequest: entry.userRequest || "",
    changedFiles: analysis.changes?.files || [],
    fileHashes: analysis.changes?.fileHashes || {},
    rows: entry.rows || []
  }));
}

function normalizeUserRequestOption(value) {
  if (value === true || value === false || value == null) return "";
  const text = String(value).trim();
  return text === "true" || text === "false" ? "" : text;
}

function summarizeRepository(index) {
  const files = Object.entries(index.files || {}).map(([relativePath, file]) => ({
    ...file,
    path: file.path || relativePath
  }));
  const byType = {};
  const byTypeText = {};

  for (const file of files) {
    const type = file.type || "other";
    const current = byType[type] || { files: 0, chars: 0, lines: 0, tokens: 0 };
    current.files += 1;
    current.chars += file.size || file.content?.length || 0;
    current.lines += file.lineCount || 0;
    byType[type] = current;
    byTypeText[type] = [...(byTypeText[type] || []), fileTokenText(file)];
  }

  const totalChars = files.reduce((sum, file) => sum + (file.size || file.content?.length || 0), 0);
  const totalLines = files.reduce((sum, file) => sum + (file.lineCount || 0), 0);
  const typeEntries = Object.entries(byType);
  const tokenTexts = [
    files.map(fileTokenText).join("\n"),
    ...typeEntries.map(([type]) => (byTypeText[type] || []).join("\n"))
  ];
  const tokenCounts = countTokensForTexts(tokenTexts);
  for (let index = 0; index < typeEntries.length; index += 1) {
    const [type] = typeEntries[index];
    byType[type].tokens = tokenCounts.counts[index + 1] || 0;
  }

  return {
    fileCount: files.length,
    totalChars,
    totalLines,
    fullContextTokens: tokenCounts.counts[0] || 0,
    tokenizer: tokenCounts.tokenizer,
    byType
  };
}

function fileTokenText(file) {
  return [
    `--- ${file.path || "unknown"}`,
    file.content || ""
  ].join("\n");
}
