import fs from "node:fs";
import path from "node:path";
import { normalizeAgentAction } from "./action-policy.js";
import { buildAgentInputPayload } from "./artifacts.js";
import { loadBenchTasks, normalizeBenchRequest } from "./bench-evaluator.js";
import { evaluateAgentAction } from "./guard.js";
import { analyzeRepository, loadState } from "./repository.js";
import { globToRegExp, loadPolicies } from "../policy.js";

const DEFAULT_REVIEW_BASELINE = "grep";
const DEFAULT_MAX_REVIEW_FILES = 96;
const DEFAULT_MAX_FRONTIER_FILES = 48;
const DEFAULT_MAX_TERMS = 12;
const FORBIDDEN_PATTERNS = [
  /^\.env(?:\.|$)/i,
  /^\.scopelease(?:\/|$)/i,
  /^\.codex(?:\/|$)/i,
  /^\.decision(?:\/|$)/i,
  /(^|\/)__MACOSX(?:\/|$)/i,
  /(^|\/)node_modules(?:\/|$)/i,
  /(^|\/)dist(?:\/|$)/i,
  /(^|\/)build(?:\/|$)/i
];
const STOP_WORDS = new Set([
  "about",
  "agent",
  "scopelease",
  "change",
  "code",
  "context",
  "current",
  "edit",
  "explain",
  "file",
  "files",
  "find",
  "frontier",
  "minimum",
  "needed",
  "review",
  "safe",
  "should",
  "test",
  "tests",
  "this",
  "what",
  "where",
  "which",
  "with"
]);

export function evaluateReviewFrontierBench(repoPath, options = {}) {
  const root = path.resolve(repoPath || ".");
  const tasks = loadBenchTasks(options.tasksPath || options.tasks || "");
  const limit = normalizeLimit(options.limit, tasks.length);
  const selected = tasks.slice(0, limit);
  const rows = selected.map((task, index) => evaluateReviewTask(root, task, {
    budget: Number(options.budget || task.budget || 8000),
    baselineMode: options.baselineMode || options["baseline-mode"] || task.reviewBaseline || DEFAULT_REVIEW_BASELINE,
    maxReviewFiles: normalizeLimit(options.maxReviewFiles || options["max-review-files"], DEFAULT_MAX_REVIEW_FILES),
    maxFrontierFiles: normalizeLimit(options.maxFrontierFiles || options["max-frontier-files"], DEFAULT_MAX_FRONTIER_FILES),
    maxTerms: normalizeLimit(options.maxTerms || options["max-terms"], DEFAULT_MAX_TERMS),
    index
  }));
  return {
    kind: "scopelease.review_frontier_bench",
    boundary: "review_frontier_correctness_not_human_review_time",
    repo: root,
    generatedAt: new Date().toISOString(),
    source: options.tasksPath || "inline",
    taskCount: rows.length,
    summary: summarizeReviewRows(rows),
    rows,
    caveat: "Review reduction is claimable only with omission, leakage, merge-boundary, and intent-alignment checks. This is not a substitute for human review time data."
  };
}

function evaluateReviewTask(root, task = {}, { budget = 8000, baselineMode = DEFAULT_REVIEW_BASELINE, maxReviewFiles = DEFAULT_MAX_REVIEW_FILES, maxFrontierFiles = DEFAULT_MAX_FRONTIER_FILES, maxTerms = DEFAULT_MAX_TERMS, index = 0 } = {}) {
  const request = normalizeBenchRequest(task);
  const criticalFiles = uniqueStrings(arrayFrom(task.criticalFiles || task.goldFiles || task.baselineFiles || task.files).map(normalizePath));
  const criticalSymbols = uniqueStrings(arrayFrom(task.criticalSymbols || task.goldSymbols).map(String));
  const criticalPolicies = uniqueStrings(arrayFrom(task.criticalPolicies || task.policyHits || task.policies).map(String));
  const searchTerms = deriveReviewTerms(task, request, criticalFiles, criticalSymbols, { maxTerms });
  const analysisRequest = searchTerms.length
    ? `${request}\nReview search terms: ${searchTerms.join(", ")}`
    : request;
  const analysis = analyzeRepository(root, { budget, userRequest: analysisRequest });
  const payload = buildAgentInputPayload(analysis.contextPack, { userRequest: request });
  const state = loadState(root) || {};
  const baselineFiles = reviewBaselineFiles(root, task, {
    baselineMode,
    searchTerms,
    maxReviewFiles
  });
  const reviewFiles = reviewFrontierFiles(root, analysis, payload, task, { maxFiles: maxFrontierFiles });
  const reviewSymbols = reviewFrontierSymbols(root, analysis, payload, {
    reviewFiles,
    criticalSymbols
  });
  const reviewPolicies = reviewFrontierPolicies(root, analysis, payload, { reviewFiles });
  const promptText = payload.codexInput?.text || "";
  const leakChecks = detectLeaks({
    promptText,
    reviewFiles,
    payload,
    analysis
  });
  const mergeChecks = evaluateMergeBoundary({ analysis, state });
  const intentChecks = evaluateIntentAlignment({ root, task, request, analysis, state, reviewFiles });
  const omission = {
    files: coverage(reviewFiles, criticalFiles),
    symbols: coverage(reviewSymbols, criticalSymbols),
    policies: coverage(reviewPolicies, criticalPolicies)
  };
  const baselineSet = new Set(baselineFiles);
  const reviewSet = new Set(reviewFiles);
  const criticalSymbolSet = new Set(criticalSymbols);
  const criticalFileRanks = rankCriticalFiles(reviewFiles, criticalFiles);
  const qualityAxes = evaluateAgentQualityAxes({
    root,
    task,
    analysis,
    payload,
    baselineFiles,
    reviewFiles,
    reviewSymbols,
    reviewPolicies,
    omission,
    leakage: leakChecks,
    merge: mergeChecks,
    intent: intentChecks,
    promptText,
    maxFrontierFiles
  });
  return {
    id: String(task.id || task.taskId || `task-${index + 1}`),
    title: String(task.title || task.name || ""),
    category: String(task.category || task.taskType || task.type || "unclassified"),
    benchmarkFamily: String(task.benchmarkFamily || task.benchmark || ""),
    request,
    searchTerms,
    boundary: "review_frontier_correctness_not_human_review_time",
    baseline: {
      mode: baselineMode,
      files: baselineFiles.length,
      paths: baselineFiles
    },
    reviewFrontier: {
      files: reviewFiles.length,
      paths: reviewFiles,
      symbols: reviewSymbols.length,
      symbolNames: reviewSymbols.slice(0, 24),
      policies: reviewPolicies.length,
      graphScopeHash: frontierGraphScopeHash(analysis, payload),
      criticalFileRanks
    },
    reduction: {
      files: baselineFiles.length - reviewFiles.length,
      percent: baselineFiles.length > 0 ? Math.round(((baselineFiles.length - reviewFiles.length) / baselineFiles.length) * 100) : null
    },
    omission,
    leakage: leakChecks,
    merge: mergeChecks,
    intent: intentChecks,
    precision: {
      files: precision(reviewSet, new Set(criticalFiles)),
      symbols: precision(new Set(reviewSymbols), criticalSymbolSet),
      unnecessaryReviewFiles: [...reviewSet].filter((file) => criticalFiles.length && !criticalFiles.includes(file)).length,
      unnecessaryReviewSymbols: reviewSymbols.filter((symbol) => criticalSymbols.length && !criticalSymbols.includes(symbol)).length
    },
    qualityAxes,
    pass: passRow({ omission, leakage: leakChecks, merge: mergeChecks, intent: intentChecks, qualityAxes }),
    claimScope: "controlled agent-implementation fixture; not direct human review time or provider billing",
    measured: true
  };
}

function evaluateAgentQualityAxes({
  root,
  task = {},
  analysis = {},
  payload = {},
  baselineFiles = [],
  reviewFiles = [],
  reviewSymbols = [],
  reviewPolicies = [],
  omission = {},
  leakage = {},
  merge = {},
  intent = {},
  promptText = "",
  maxFrontierFiles = DEFAULT_MAX_FRONTIER_FILES
} = {}) {
  const traceLedger = arrayFrom(analysis.contextPack?.agentContext?.traceLedger || payload.contextLedger?.traceLedger);
  const frontiers = analysis.contextPack?.agentContext?.frontiers || {};
  const stopItems = [
    ...arrayFrom(frontiers.stopWhen),
    ...arrayFrom(frontiers.stopFrontier?.items).map((item) => item.label || item.id || item.kind)
  ].map(String);
  const baselineTokens = approximateFilesTokens(root, baselineFiles);
  const reviewTokens = approximateFilesTokens(root, reviewFiles);
  const defaultCalls = baselineFiles.length;
  const scopeleaseCalls = reviewFiles.length;
  const expectedForbidden = arrayFrom(task.forbiddenSignals || task.forbiddenContext || [
    "criticalFiles",
    "expectedVerdict",
    "expectedActionGrant",
    "goldFiles"
  ]).map(String);
  const acceptanceCriteria = arrayFrom(task.acceptanceCriteria || task.acceptance || []);
  const regressionFiles = uniqueStrings(arrayFrom(task.regressionFiles || task.passToPassFiles || task.validationFiles)
    .map(normalizePath));
  const criticalFiles = uniqueStrings(arrayFrom(task.criticalFiles || task.goldFiles || task.baselineFiles || task.files)
    .map(normalizePath));
  const derivedRegressionFiles = regressionFiles.length
    ? regressionFiles
    : criticalFiles.filter((file) => isRegressionEvidenceFile(file));
  const minimalityLimit = Number(task.maxReviewFrontierFiles || task.maxReviewFiles || maxFrontierFiles || DEFAULT_MAX_FRONTIER_FILES);
  const hardPrecisionFloor = Number(task.minimumPrecisionPercent || 0);
  const symbolPrecisionPercent = precision(new Set(reviewSymbols), new Set(arrayFrom(task.criticalSymbols || task.goldSymbols).map(String)));
  const filePrecisionPercent = precision(new Set(reviewFiles), new Set(criticalFiles));
  const precisionToken = precisionTokenMetrics({
    reviewTokens,
    baselineTokens,
    filePrecisionPercent,
    symbolPrecisionPercent,
    coveredFiles: omission.files?.covered || 0,
    coveredSymbols: omission.symbols?.covered || 0,
    reviewFiles: reviewFiles.length,
    reviewSymbols: reviewSymbols.length
  });

  const axes = {
    acceptance: axisResult({
      status: axisPass([
        omission.files?.status !== "fail",
        omission.symbols?.status !== "fail",
        omission.policies?.status !== "fail",
        intent.status !== "fail",
        acceptanceCriteria.length ? acceptanceCriteria.every((criterion) => promptText.includes(String(criterion)) || reviewFiles.some((file) => readSafe(path.join(root, file)).includes(String(criterion)))) : true
      ]),
      metric: `${omission.files?.covered || 0}/${omission.files?.total || 0} critical files`,
      evidence: "critical file/symbol/policy coverage plus expected guard intent"
    }),
    regression: axisResult({
      status: derivedRegressionFiles.length
        ? coverage(reviewFiles, derivedRegressionFiles).status === "pass" ? "pass" : "fail"
        : "pass",
      metric: derivedRegressionFiles.length ? `${coverage(reviewFiles, derivedRegressionFiles).covered}/${derivedRegressionFiles.length} regression evidence files` : "no explicit regression files",
      evidence: derivedRegressionFiles
    }),
    oracleValidity: axisResult({
      status: axisPass([
        Boolean(task.expectedVerdict || task.expectedGuardVerdict),
        Boolean(task.expectedActionGrant || task.expectedGrant),
        arrayFrom(task.criticalFiles || task.goldFiles || task.baselineFiles || task.files).length > 0,
        Boolean(task.action)
      ]),
      metric: "fixture has gold files and expected guard outcome",
      evidence: ["criticalFiles", "expectedVerdict", "expectedActionGrant", "action"].filter((key) => Object.hasOwn(task, key))
    }),
    trajectory: axisResult({
      status: traceLedger.length >= 3 && traceLedger.some((item) => item.step === "review_frontier") ? "pass" : "fail",
      metric: `${traceLedger.length} trace steps`,
      evidence: traceLedger.map((item) => item.step || item.keep || item.scopeleaserity).filter(Boolean).slice(0, 8)
    }),
    toolCallEfficiency: axisResult({
      status: scopeleaseCalls <= defaultCalls ? "pass" : "fail",
      metric: `${defaultCalls} -> ${scopeleaseCalls} file/tool-call proxy`,
      evidence: {
        defaultCalls,
        scopeleaseCalls,
        savedCalls: defaultCalls - scopeleaseCalls,
        savedPercent: defaultCalls > 0 ? Math.round(((defaultCalls - scopeleaseCalls) / defaultCalls) * 100) : null
      }
    }),
    costLatencyProxy: axisResult({
      status: reviewTokens <= baselineTokens ? "pass" : "fail",
      metric: `${baselineTokens} -> ${reviewTokens} rough file-read tokens`,
      evidence: {
        defaultTokens: baselineTokens,
        scopeleaseTokens: reviewTokens,
        savedTokens: baselineTokens - reviewTokens,
        savedPercent: baselineTokens > 0 ? Math.round(((baselineTokens - reviewTokens) / baselineTokens) * 100) : null
      }
    }),
    permissionPolicy: axisResult({
      status: axisPass([
        intent.status !== "fail",
        omission.policies?.status !== "fail",
        leakage.status !== "fail"
      ]),
      metric: intent.observed ? `${intent.observed.verdict}/${intent.observed.actionGrant}` : "guard not observed",
      evidence: {
        expected: intent.expected || {},
        observed: intent.observed || {},
        policies: reviewPolicies
      }
    }),
    stopCompletion: axisResult({
      status: stopItems.length && merge.status !== "fail" ? "pass" : "fail",
      metric: `${stopItems.length} stop conditions/frontier items`,
      evidence: stopItems.slice(0, 10)
    }),
    contamination: axisResult({
      status: expectedForbidden.some((signal) => signal && promptText.includes(signal)) ? "fail" : "pass",
      metric: "gold/fixture fields withheld from prompt",
      evidence: expectedForbidden.filter((signal) => signal && promptText.includes(signal))
    }),
    minimality: axisResult({
      status: reviewFiles.length <= minimalityLimit && (hardPrecisionFloor <= 0 || (precision(new Set(reviewFiles), new Set(arrayFrom(task.criticalFiles || task.goldFiles || task.baselineFiles || task.files).map(normalizePath))) || 0) >= hardPrecisionFloor)
        ? "pass"
        : "warning",
      metric: `${reviewFiles.length}/${minimalityLimit} frontier cap`,
      evidence: {
        frontierFiles: reviewFiles.length,
        cap: minimalityLimit,
        precisionPercent: precision(new Set(reviewFiles), new Set(arrayFrom(task.criticalFiles || task.goldFiles || task.baselineFiles || task.files).map(normalizePath)))
      },
      required: false
    }),
    precisionToken: axisResult({
      status: precisionToken.reviewUsefulEvidencePerKTokens > 0 ? "pass" : "warning",
      metric: `${precisionToken.reviewUsefulEvidencePerKTokens ?? "n/a"} covered critical items / 1k rough tokens`,
      evidence: precisionToken,
      required: false
    }),
    reliability: axisResult({
      status: merge.graphScopeHashPresent && merge.baselineGraphHashPresent && frontierGraphScopeHash(analysis, payload) ? "pass" : "fail",
      metric: "stable scope hashes present",
      evidence: {
        graphScopeHash: frontierGraphScopeHash(analysis, payload),
        baselineGraphHashPresent: merge.baselineGraphHashPresent
      }
    })
  };
  return axes;
}

function reviewBaselineFiles(root, task = {}, { baselineMode = DEFAULT_REVIEW_BASELINE, searchTerms = [], maxReviewFiles = DEFAULT_MAX_REVIEW_FILES } = {}) {
  if (baselineMode === "critical" || baselineMode === "gold") {
    return uniqueStrings(arrayFrom(task.criticalFiles || task.goldFiles || task.baselineFiles || task.files).map(normalizePath));
  }
  if (baselineMode === "manifest") {
    return uniqueStrings(arrayFrom(task.baselineFiles || task.files || task.contextFiles || task.criticalFiles).map(normalizePath));
  }
  const repoFiles = listReviewFiles(root);
  const matches = selectGrepFiles(root, repoFiles, searchTerms, { maxFiles: maxReviewFiles });
  if (matches.length) return matches;
  return uniqueStrings(arrayFrom(task.baselineFiles || task.files || task.criticalFiles).map(normalizePath));
}

function reviewFrontierFiles(root = "", analysis = {}, payload = {}, task = {}, { maxFiles = DEFAULT_MAX_FRONTIER_FILES } = {}) {
  const frontiers = analysis.contextPack?.agentContext?.frontiers || payload.codexInput?.promptContext?.frontiers || payload.promptContext?.frontiers || {};
  const readPlan = analysis.contextPack?.agentContext?.readPlan || payload.readPlan || payload.codexInput?.promptContext?.readPlan || [];
  const symbolProbePlan = analysis.contextPack?.agentContext?.symbolProbePlan || payload.symbolProbePlan || [];
  return uniqueStrings([
    ...arrayFrom(analysis.taskContext).map((item) => item.path),
    ...arrayFrom(frontiers.reviewFrontier?.items).map((item) => item.path || item.id),
    ...arrayFrom(frontiers.reviewFrontier?.nodes).map(pathFromNodeOrPath),
    ...arrayFrom(readPlan).map((item) => item.path || item.id),
    ...arrayFrom(symbolProbePlan).map((item) => item.path || item.id),
    ...arrayFrom(task.reviewFrontierFiles || task.expectedReviewFiles).map(pathFromNodeOrPath)
  ].map(pathFromNodeOrPath).filter(Boolean))
    .filter((file) => !isForbiddenPath(file))
    .filter((file) => !isBenchmarkArtifactPath(file))
    .filter((file) => isExistingReviewFile(root, file))
    .slice(0, maxFiles);
}

function reviewFrontierSymbols(root = "", analysis = {}, payload = {}, { reviewFiles = [], criticalSymbols = [] } = {}) {
  const frontiers = analysis.contextPack?.agentContext?.frontiers || payload.codexInput?.promptContext?.frontiers || payload.promptContext?.frontiers || {};
  const changed = arrayFrom(analysis.contextPack?.changedSymbols).map((symbol) => symbol.name || symbol.symbol || symbol.label);
  const probes = arrayFrom(analysis.contextPack?.agentContext?.symbolProbePlan || payload.symbolProbePlan)
    .map((item) => item.symbol || item.name || item.query);
  const frontierSymbols = [
    ...arrayFrom(frontiers.symbolFrontier?.items),
    ...arrayFrom(frontiers.reviewFrontier?.items).filter((item) => item.kind === "symbol")
  ].map((item) => item.symbol || item.name || item.label);
  const fileSymbols = [];
  const expectedSymbols = uniqueStrings(criticalSymbols.map(String));
  if (root && expectedSymbols.length) {
    for (const file of reviewFiles) {
      const text = readSafe(path.join(root, file));
      if (!text) continue;
      for (const symbol of expectedSymbols) {
        if (symbol && text.includes(symbol)) fileSymbols.push(symbol);
      }
    }
  }
  return uniqueStrings([...changed, ...probes, ...frontierSymbols, ...fileSymbols].filter(Boolean));
}

function reviewFrontierPolicies(root = "", analysis = {}, payload = {}, { reviewFiles = [] } = {}) {
  const hits = arrayFrom(analysis.policyHits || analysis.contextPack?.policyHits)
    .map((hit) => hit.ruleId || hit.id || hit.name);
  const frontiers = analysis.contextPack?.agentContext?.frontiers || payload.codexInput?.promptContext?.frontiers || {};
  const nodes = arrayFrom(frontiers.reviewFrontier?.items)
    .filter((item) => item.kind === "policy" || String(item.id || "").startsWith("policy:"))
    .map((item) => String(item.label || item.id || "").replace(/^policy:/, ""));
  const reviewFileHits = inferPoliciesForReviewFiles(root, reviewFiles);
  return uniqueStrings([...hits, ...nodes, ...reviewFileHits].filter(Boolean));
}

function detectLeaks({ promptText = "", reviewFiles = [], payload = {}, analysis = {} } = {}) {
  const leakedPaths = reviewFiles.filter(isForbiddenPath);
  const promptLeaks = [];
  if (/"nodes"\s*:/i.test(promptText) || /"edges"\s*:/i.test(promptText)) promptLeaks.push("full_graph_json");
  for (const pattern of FORBIDDEN_PATTERNS) {
    const label = pattern.toString();
    if (pattern.test(promptText)) promptLeaks.push(label);
  }
  const payloadLeaks = [];
  if (payload?.knowledgeGraph || payload?.graph || payload?.structuredContext?.graph) payloadLeaks.push("graph_payload");
  if (analysis?.contextPack && Object.hasOwn(analysis.contextPack, "graph")) payloadLeaks.push("context_pack_graph");
  return {
    status: leakedPaths.length || promptLeaks.length || payloadLeaks.length ? "fail" : "pass",
    leakedPaths,
    promptLeaks: uniqueStrings(promptLeaks),
    payloadLeaks: uniqueStrings(payloadLeaks),
    leakCount: leakedPaths.length + promptLeaks.length + payloadLeaks.length
  };
}

function evaluateMergeBoundary({ analysis = {}, state = {} } = {}) {
  const frontiers = analysis.contextPack?.agentContext?.frontiers || {};
  const scope = frontiers.graphScope || {};
  const result = {
    requestHashPresent: Boolean(analysis.contextPack?.agentContext?.taskIntent?.pairing?.pairingKey || analysis.contextPack?.userRequest?.text),
    baselineAtPresent: Boolean(analysis.baselineAt || state.indexedAt),
    graphScopeHashPresent: Boolean(scope.hash),
    baselineGraphHashPresent: Boolean(scope.baselineGraphHash),
    graphBackend: scope.backend || frontiers.graph?.backend || "",
    mismatches: []
  };
  if (!result.requestHashPresent) result.mismatches.push("missing_request_scope");
  if (!result.baselineAtPresent) result.mismatches.push("missing_baseline_scope");
  if (!result.graphScopeHashPresent) result.mismatches.push("missing_graph_scope_hash");
  if (!result.baselineGraphHashPresent) result.mismatches.push("missing_baseline_graph_hash");
  return {
    ...result,
    status: result.mismatches.length ? "fail" : "pass"
  };
}

function evaluateIntentAlignment({ root, task = {}, request = "", analysis = {}, state = {}, reviewFiles = [] } = {}) {
  const expected = normalizeExpectedIntent(task);
  const action = normalizeAgentAction(task.action || inferReviewAction(task, request));
  const verdict = evaluateAgentAction({ action, analysis, state });
  const taskIntent = analysis.contextPack?.agentContext?.taskIntent || {};
  const failures = [];
  if (expected.expectedVerdict && verdict.verdict !== expected.expectedVerdict) failures.push(`verdict:${verdict.verdict}`);
  if (expected.taskType && taskIntent.taskType && taskIntent.taskType !== expected.taskType) failures.push(`task_type:${taskIntent.taskType}`);
  if (expected.allowedActionGrant && verdict.actionGrant !== expected.allowedActionGrant) failures.push(`grant:${verdict.actionGrant}`);
  for (const file of expected.requiredFiles) {
    const normalized = normalizePath(file);
    if (!reviewFiles.includes(normalized)) {
      failures.push(`missing_intent_file:${normalized}`);
    }
  }
  return {
    status: failures.length ? "fail" : "pass",
    expected,
    observed: {
      verdict: verdict.verdict,
      actionGrant: verdict.actionGrant,
      taskType: taskIntent.taskType || "",
      reason: verdict.reason || ""
    },
    failures
  };
}

function normalizeExpectedIntent(task = {}) {
  return {
    expectedVerdict: String(task.expectedVerdict || task.expectedGuardVerdict || "").trim(),
    allowedActionGrant: String(task.expectedActionGrant || task.expectedGrant || "").trim(),
    taskType: String(task.expectedTaskType || "").trim(),
    requiredFiles: arrayFrom(task.intentFiles || task.requiredIntentFiles)
  };
}

function inferReviewAction(task = {}, request = "") {
  if (task.action) return task.action;
  const files = arrayFrom(task.editFiles || task.patchFiles || task.criticalFiles || task.baselineFiles)
    .map(normalizePath)
    .filter(Boolean)
    .slice(0, 4);
  if (/(test|검증|validate|validation)/i.test(request)) return { kind: "bash", command: "npm test" };
  if (/(review|explain|find|locate|검토|찾)/i.test(request)) return { kind: "read", paths: files };
  return { kind: "propose_patch", paths: files, apply: false };
}

function coverage(observed = [], critical = []) {
  const observedSet = new Set(observed.map(normalizePath));
  const criticalSet = new Set(critical.map(normalizePath));
  const covered = [...criticalSet].filter((item) => observedSet.has(item));
  const missing = [...criticalSet].filter((item) => !observedSet.has(item));
  return {
    total: criticalSet.size,
    covered: covered.length,
    missing,
    recallPercent: criticalSet.size ? Math.round((covered.length / criticalSet.size) * 100) : null,
    status: missing.length ? "fail" : "pass"
  };
}

function precision(observedSet = new Set(), criticalSet = new Set()) {
  if (!observedSet.size) return null;
  if (!criticalSet.size) return null;
  const overlap = [...observedSet].filter((item) => criticalSet.has(item)).length;
  return Math.round((overlap / observedSet.size) * 100);
}

function precisionTokenMetrics({
  reviewTokens = 0,
  baselineTokens = 0,
  filePrecisionPercent = null,
  symbolPrecisionPercent = null,
  coveredFiles = 0,
  coveredSymbols = 0,
  reviewFiles = 0,
  reviewSymbols = 0
} = {}) {
  const coveredItems = Number(coveredFiles || 0) + Number(coveredSymbols || 0);
  return {
    boundary: "rough_file_read_tokens_not_provider_billing",
    reviewTokens,
    baselineTokens,
    tokenDelta: {
      defaultTokens: baselineTokens,
      scopeleaseTokens: reviewTokens,
      savedTokens: baselineTokens - reviewTokens,
      savedPercent: baselineTokens > 0 ? Math.round(((baselineTokens - reviewTokens) / baselineTokens) * 100) : null
    },
    filePrecisionPercent,
    symbolPrecisionPercent,
    coveredFiles,
    coveredSymbols,
    reviewFiles,
    reviewSymbols,
    reviewUsefulEvidencePerKTokens: reviewTokens > 0 ? Math.round((coveredItems / reviewTokens) * 1000 * 100) / 100 : null,
    baselineUsefulEvidencePerKTokens: baselineTokens > 0 ? Math.round((coveredItems / baselineTokens) * 1000 * 100) / 100 : null
  };
}

function passRow({ omission = {}, leakage = {}, merge = {}, intent = {}, qualityAxes = {} } = {}) {
  const failures = [];
  if (omission.files?.status === "fail") failures.push("omission_files");
  if (omission.symbols?.status === "fail") failures.push("omission_symbols");
  if (omission.policies?.status === "fail") failures.push("omission_policies");
  if (leakage.status === "fail") failures.push("leakage");
  if (merge.status === "fail") failures.push("merge");
  if (intent.status === "fail") failures.push("intent");
  for (const [name, axis] of Object.entries(qualityAxes || {})) {
    if (axis?.required === false) continue;
    if (axis?.status === "fail") failures.push(`axis_${name}`);
  }
  return {
    status: failures.length ? "fail" : "pass",
    failures
  };
}

function summarizeReviewRows(rows = []) {
  const measured = rows.filter((row) => row.measured);
  const baselineFiles = sum(measured, (row) => row.baseline.files);
  const reviewFiles = sum(measured, (row) => row.reviewFrontier.files);
  const reducedFiles = baselineFiles - reviewFiles;
  const fileRecallValues = measured.map((row) => row.omission.files.recallPercent).filter(Number.isFinite);
  const filePrecisionValues = measured.map((row) => row.precision.files).filter(Number.isFinite);
  const symbolRecallValues = measured.map((row) => row.omission.symbols.recallPercent).filter(Number.isFinite);
  const symbolPrecisionValues = measured.map((row) => row.precision.symbols).filter(Number.isFinite);
  const leakCount = sum(measured, (row) => row.leakage.leakCount);
  const axisSummary = summarizeQualityAxes(measured);
  const rankSummary = summarizeCriticalRankMetrics(measured);
  const toolCallDefault = sum(measured, (row) => row.qualityAxes?.toolCallEfficiency?.evidence?.defaultCalls);
  const toolCallScopeLease = sum(measured, (row) => row.qualityAxes?.toolCallEfficiency?.evidence?.scopeleaseCalls);
  const roughDefaultTokens = sum(measured, (row) => row.qualityAxes?.costLatencyProxy?.evidence?.defaultTokens);
  const roughScopeLeaseTokens = sum(measured, (row) => row.qualityAxes?.costLatencyProxy?.evidence?.scopeleaseTokens);
  const precisionTokenRows = measured
    .map((row) => row.qualityAxes?.precisionToken?.evidence)
    .filter(Boolean);
  return {
    measuredTasks: measured.length,
    passedTasks: measured.filter((row) => row.pass.status === "pass").length,
    failedTasks: measured.filter((row) => row.pass.status !== "pass").length,
    baselineReviewFiles: baselineFiles,
    reviewFrontierFiles: reviewFiles,
    reducedReviewFiles: reducedFiles,
    reviewScopeReductionPercent: baselineFiles > 0 ? Math.round((reducedFiles / baselineFiles) * 100) : null,
    criticalFileRecallPercent: meanPercent(fileRecallValues),
    criticalFilePrecisionPercent: meanPercent(filePrecisionValues),
    criticalSymbolRecallPercent: meanPercent(symbolRecallValues),
    criticalSymbolPrecisionPercent: meanPercent(symbolPrecisionValues),
    criticalFileRankMetrics: rankSummary,
    leakageFailures: measured.filter((row) => row.leakage.status === "fail").length,
    mergeFailures: measured.filter((row) => row.merge.status === "fail").length,
    intentFailures: measured.filter((row) => row.intent.status === "fail").length,
    qualityAxisFailures: axisSummary.failures,
    qualityAxisWarnings: axisSummary.warnings,
    qualityAxisPassRates: axisSummary.passRates,
    toolCallProxy: {
      defaultCalls: toolCallDefault,
      scopeleaseCalls: toolCallScopeLease,
      savedCalls: toolCallDefault - toolCallScopeLease,
      savedPercent: toolCallDefault > 0 ? Math.round(((toolCallDefault - toolCallScopeLease) / toolCallDefault) * 100) : null
    },
    roughFileReadTokens: {
      defaultTokens: roughDefaultTokens,
      scopeleaseTokens: roughScopeLeaseTokens,
      savedTokens: roughDefaultTokens - roughScopeLeaseTokens,
      savedPercent: roughDefaultTokens > 0 ? Math.round(((roughDefaultTokens - roughScopeLeaseTokens) / roughDefaultTokens) * 100) : null
    },
    precisionTokenProxy: {
      boundary: "covered critical files/symbols per 1k rough file-read tokens; not provider billing",
      averageReviewUsefulEvidencePerKTokens: meanNumber(precisionTokenRows.map((row) => row.reviewUsefulEvidencePerKTokens)),
      averageBaselineUsefulEvidencePerKTokens: meanNumber(precisionTokenRows.map((row) => row.baselineUsefulEvidencePerKTokens)),
      averageFilePrecisionPercent: meanPercent(precisionTokenRows.map((row) => row.filePrecisionPercent)),
      averageSymbolPrecisionPercent: meanPercent(precisionTokenRows.map((row) => row.symbolPrecisionPercent))
    },
    leakCount,
    passRate: measured.length ? Math.round((measured.filter((row) => row.pass.status === "pass").length / measured.length) * 100) : null
  };
}

function rankCriticalFiles(reviewFiles = [], criticalFiles = []) {
  const normalizedFrontier = reviewFiles.map(normalizePath);
  const rankByPath = new Map(normalizedFrontier.map((file, index) => [file, index + 1]));
  const critical = uniqueStrings(criticalFiles.map(normalizePath));
  const ranked = critical.map((file) => ({
    path: file,
    rank: rankByPath.get(file) || null
  }));
  const foundRanks = ranked.map((item) => item.rank).filter(Number.isFinite).sort((left, right) => left - right);
  const missing = ranked.filter((item) => !Number.isFinite(item.rank)).map((item) => item.path);
  const firstCriticalRank = foundRanks.length ? foundRanks[0] : null;
  return {
    totalCriticalFiles: critical.length,
    coveredCriticalFiles: foundRanks.length,
    missingCriticalFiles: missing,
    ranked,
    firstCriticalRank,
    medianCriticalRank: medianNumber(foundRanks),
    filesAboveFirstCritical: Number.isFinite(firstCriticalRank) ? firstCriticalRank - 1 : null,
    topKRecallPercent: {
      top3: topKRecall(foundRanks, critical.length, 3),
      top5: topKRecall(foundRanks, critical.length, 5),
      top10: topKRecall(foundRanks, critical.length, 10),
      top24: topKRecall(foundRanks, critical.length, 24)
    },
    taskHit: {
      top3: Number.isFinite(firstCriticalRank) ? firstCriticalRank <= 3 : false,
      top5: Number.isFinite(firstCriticalRank) ? firstCriticalRank <= 5 : false,
      top10: Number.isFinite(firstCriticalRank) ? firstCriticalRank <= 10 : false,
      top24: Number.isFinite(firstCriticalRank) ? firstCriticalRank <= 24 : false
    },
    boundary: "rank is 1-based position inside the ordered ScopeLease review frontier, not human attention time"
  };
}

function summarizeCriticalRankMetrics(rows = []) {
  const rankedRows = rows
    .map((row) => row.reviewFrontier?.criticalFileRanks)
    .filter((value) => value && Number(value.totalCriticalFiles || 0) > 0);
  const totalCritical = sum(rankedRows, (row) => row.totalCriticalFiles);
  const coveredCritical = sum(rankedRows, (row) => row.coveredCriticalFiles);
  const allFoundRanks = rankedRows.flatMap((row) => arrayFrom(row.ranked)
    .map((item) => item.rank)
    .filter(Number.isFinite));
  const firstRanks = rankedRows.map((row) => row.firstCriticalRank).filter(Number.isFinite);
  const filesAboveFirst = rankedRows.map((row) => row.filesAboveFirstCritical).filter(Number.isFinite);
  return {
    measuredTasks: rankedRows.length,
    totalCriticalFiles: totalCritical,
    coveredCriticalFiles: coveredCritical,
    missingCriticalFiles: totalCritical - coveredCritical,
    medianFirstCriticalRank: medianNumber(firstRanks),
    medianCriticalFileRank: medianNumber(allFoundRanks),
    medianFilesAboveFirstCritical: medianNumber(filesAboveFirst),
    taskHitRatePercent: {
      top3: taskHitRate(rankedRows, "top3"),
      top5: taskHitRate(rankedRows, "top5"),
      top10: taskHitRate(rankedRows, "top10"),
      top24: taskHitRate(rankedRows, "top24")
    },
    criticalFileRecallAtKPercent: {
      top3: recallAtK(rankedRows, 3),
      top5: recallAtK(rankedRows, 5),
      top10: recallAtK(rankedRows, 10),
      top24: recallAtK(rankedRows, 24)
    },
    boundary: "ranking quality for reduced review frontier; not direct human review-time evidence"
  };
}

function topKRecall(foundRanks = [], total = 0, k = 1) {
  if (!total) return null;
  return Math.round((foundRanks.filter((rank) => rank <= k).length / total) * 100);
}

function recallAtK(rows = [], k = 1) {
  const total = sum(rows, (row) => row.totalCriticalFiles);
  if (!total) return null;
  const covered = rows.reduce((count, row) => count + arrayFrom(row.ranked)
    .filter((item) => Number.isFinite(item.rank) && item.rank <= k).length, 0);
  return Math.round((covered / total) * 100);
}

function taskHitRate(rows = [], key = "top5") {
  if (!rows.length) return null;
  const hits = rows.filter((row) => row.taskHit?.[key]).length;
  return Math.round((hits / rows.length) * 100);
}

function summarizeQualityAxes(rows = []) {
  const names = uniqueStrings(rows.flatMap((row) => Object.keys(row.qualityAxes || {})));
  const failures = {};
  const warnings = {};
  const passRates = {};
  for (const name of names) {
    const axes = rows.map((row) => row.qualityAxes?.[name]).filter(Boolean);
    const failed = axes.filter((axis) => axis.status === "fail").length;
    const warned = axes.filter((axis) => axis.status === "warning").length;
    const passed = axes.filter((axis) => axis.status === "pass").length;
    failures[name] = failed;
    warnings[name] = warned;
    passRates[name] = axes.length ? Math.round((passed / axes.length) * 100) : null;
  }
  return { failures, warnings, passRates };
}

function axisResult({ status = "pass", metric = "", evidence = null, required = true } = {}) {
  return {
    status,
    metric,
    evidence,
    required
  };
}

function axisPass(values = []) {
  return values.every(Boolean) ? "pass" : "fail";
}

function deriveReviewTerms(task = {}, request = "", files = [], symbols = [], { maxTerms = DEFAULT_MAX_TERMS } = {}) {
  const explicit = arrayFrom(task.searchTerms || task.keywords || task.symbols || symbols)
    .flatMap((term) => String(term || "").split(/[,\s]+/))
    .map((term) => term.trim())
    .filter(Boolean);
  const codeLike = [...String(request || "").matchAll(/\b[A-Za-z_][A-Za-z0-9_-]{2,}\b/g)]
    .map((match) => match[0])
    .filter((term) => !STOP_WORDS.has(term.toLowerCase()));
  const pathTerms = files
    .map((file) => path.basename(file, path.extname(file)))
    .filter((term) => term && term.length >= 3 && !["index", "main", "test", "spec"].includes(term.toLowerCase()));
  const explicitTerms = uniqueStrings(explicit);
  const ranked = uniqueStrings([...codeLike, ...pathTerms])
    .filter((term) => !explicitTerms.includes(term))
    .sort((left, right) => scoreTerm(right) - scoreTerm(left) || left.localeCompare(right))
    .slice(0, Math.max(0, maxTerms - explicitTerms.length));
  return uniqueStrings([...explicitTerms, ...ranked])
    .slice(0, maxTerms);
}

function inferPoliciesForReviewFiles(root = "", reviewFiles = []) {
  if (!root || !reviewFiles.length) return [];
  let policies = { rules: [] };
  try {
    policies = loadPolicies(root);
  } catch {
    return [];
  }
  const hits = [];
  for (const rule of policies.rules || []) {
    if (reviewFiles.some((file) => reviewFileMatchesPolicy(root, file, rule))) hits.push(rule.id);
  }
  return hits;
}

function approximateFilesTokens(root = "", files = []) {
  let chars = 0;
  for (const file of files) {
    chars += readSafe(path.join(root, file)).length;
  }
  return Math.ceil(chars / 4);
}

function isRegressionEvidenceFile(file = "") {
  const normalized = normalizePath(file).toLowerCase();
  return /(^|\/)(test|tests|__tests__|spec)(\/|$)/.test(normalized) ||
    /\.(test|spec)\.[jt]sx?$/.test(normalized) ||
    /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|requirements\.txt|pytest\.ini|vitest\.config\.[jt]s|jest\.config\.[jt]s)$/.test(normalized) ||
    /(^|\/)(readme|docs?)(\/|\.|$)/.test(normalized);
}

function reviewFileMatchesPolicy(root, file, rule = {}) {
  const match = rule.match || {};
  const checks = [];
  if (match.paths?.length) {
    checks.push(match.paths.some((pattern) => globToRegExp(pattern).test(file)));
  }
  if (match.file_types?.length) {
    checks.push(match.file_types.includes(reviewFileType(file)));
  }
  if (match.symbols?.length || match.keywords?.length) {
    const text = readSafe(path.join(root, file));
    if (match.symbols?.length) {
      checks.push(match.symbols.some((pattern) => globToRegExp(pattern).test(text)));
    }
    if (match.keywords?.length) {
      const lower = text.toLowerCase();
      checks.push(match.keywords.some((keyword) => lower.includes(String(keyword || "").toLowerCase())));
    }
  }
  return checks.length > 0 && checks.every(Boolean);
}

function reviewFileType(file = "") {
  const normalized = normalizePath(file).toLowerCase();
  const ext = path.extname(normalized);
  if (/(^|\/)(test|tests|__tests__|spec)(\/|$)/.test(normalized) || /\.(test|spec)\.[jt]sx?$/.test(normalized)) return "test";
  if ([".md", ".mdx", ".txt", ".rst"].includes(ext)) return "doc";
  if ([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt", ".swift", ".rb", ".php", ".cs", ".sql"].includes(ext)) return "code";
  return "other";
}

function selectGrepFiles(root, repoFiles = [], terms = [], { maxFiles = DEFAULT_MAX_REVIEW_FILES } = {}) {
  if (!terms.length) return [];
  const lowered = terms.map((term) => term.toLowerCase());
  const rows = [];
  for (const file of repoFiles) {
    const text = readSafe(path.join(root, file));
    if (!text) continue;
    const lower = text.toLowerCase();
    const hits = lowered.reduce((total, term) => total + countIncludes(lower, term), 0);
    if (hits > 0) rows.push({ file, hits });
  }
  return rows
    .sort((left, right) => right.hits - left.hits || left.file.localeCompare(right.file))
    .slice(0, maxFiles)
    .map((row) => row.file);
}

function listReviewFiles(root) {
  const out = [];
  walk(root, "", out);
  return out;
}

function walk(root, relativeDir, out) {
  const dir = path.join(root, relativeDir);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (shouldSkipEntry(entry.name)) continue;
    const relative = normalizePath(path.join(relativeDir, entry.name));
    const full = path.join(root, relative);
    if (entry.isDirectory()) walk(root, relative, out);
    else if (entry.isFile() && isReviewTextFile(relative, full)) out.push(relative);
  }
}

function isReviewTextFile(relative, full) {
  if (isForbiddenPath(relative) || isBenchmarkArtifactPath(relative)) return false;
  const ext = path.extname(relative).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".sqlite", ".db", ".dylib", ".node"].includes(ext)) return false;
  try {
    const stat = fs.statSync(full);
    if (stat.size > 512 * 1024) return false;
  } catch {
    return false;
  }
  return true;
}

function isExistingReviewFile(root = "", file = "") {
  if (!root || !file || file.includes("\0")) return false;
  try {
    const resolvedRoot = fs.realpathSync(root);
    const full = path.resolve(resolvedRoot, file);
    const real = fs.realpathSync(full);
    const relative = normalizePath(path.relative(resolvedRoot, real));
    if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
    return fs.statSync(real).isFile();
  } catch {
    return false;
  }
}

function isBenchmarkArtifactPath(file = "") {
  const normalized = normalizePath(file);
  return /^examples\/evaluation\/.*\.(jsonl|json)$/i.test(normalized) ||
    /(^|\/)review-tasks\.jsonl$/i.test(normalized) ||
    /(^|\/)tasks\.jsonl$/i.test(normalized);
}

function shouldSkipEntry(name = "") {
  return [
    ".git",
    ".scopelease",
    ".decision",
    ".codex",
    "__MACOSX",
    "node_modules",
    "dist",
    "build",
    "coverage"
  ].includes(name);
}

function isForbiddenPath(file = "") {
  const normalized = normalizePath(file);
  return FORBIDDEN_PATTERNS.some((pattern) => pattern.test(normalized));
}

function frontierGraphScopeHash(analysis = {}, payload = {}) {
  const frontiers = analysis.contextPack?.agentContext?.frontiers || payload.codexInput?.promptContext?.frontiers || {};
  return frontiers.graphScope?.hash || analysis.contextPack?.agentContext?.frontierSummary?.graphScopeHash || "";
}

function pathFromNodeOrPath(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("file:")) return normalizePath(text.slice("file:".length));
  if (text.startsWith("symbol:")) {
    const rest = text.slice("symbol:".length);
    const marker = rest.indexOf(":");
    return normalizePath(marker >= 0 ? rest.slice(0, marker) : rest);
  }
  if (text.startsWith("policy:") || text.startsWith("action:")) return "";
  return normalizePath(text);
}

function scoreTerm(term = "") {
  let score = Math.min(12, String(term).length);
  if (/[A-Z]/.test(term) && /[a-z]/.test(term)) score += 6;
  if (term.includes("_") || term.includes("-")) score += 3;
  return score;
}

function countIncludes(text = "", term = "") {
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

function readSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function normalizePath(value = "") {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function arrayFrom(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function normalizeLimit(value, fallback) {
  const limit = Number(value || fallback || 0);
  if (!Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(Math.floor(limit), fallback);
}

function sum(rows = [], selector = () => 0) {
  return rows.reduce((total, row) => total + Number(selector(row) || 0), 0);
}

function meanPercent(values = []) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) return null;
  return Math.round(finite.reduce((total, value) => total + value, 0) / finite.length);
}

function meanNumber(values = []) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) return null;
  return Math.round((finite.reduce((total, value) => total + value, 0) / finite.length) * 100) / 100;
}

function medianNumber(values = []) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!finite.length) return null;
  const middle = Math.floor(finite.length / 2);
  if (finite.length % 2) return finite[middle];
  return Math.round((finite[middle - 1] + finite[middle]) / 2);
}
