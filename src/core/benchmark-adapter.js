import { createHash } from "node:crypto";
import { loadBenchTasks, normalizeBenchRequest } from "./bench-evaluator.js";
import { deriveWorkIntent } from "./work-intent.js";

export const CONDITION_PRESETS = Object.freeze([
  {
    id: "C0",
    label: "Baseline Agent",
    description: "Native coding agent without ScopeLease context, guard, signed lease, or stop frontier.",
    scopeleaseContext: false,
    reviewFrontier: false,
    permissionGuard: false,
    signedLease: false,
    stopFrontier: false,
    expectedInterface: "native_agent_prompt"
  },
  {
    id: "C1",
    label: "ScopeLease Context Only",
    description: "Graph-scoped read/review context is provided, but actions are not guarded.",
    scopeleaseContext: true,
    reviewFrontier: true,
    permissionGuard: false,
    signedLease: false,
    stopFrontier: false,
    expectedInterface: "context_card"
  },
  {
    id: "C2",
    label: "ScopeLease Guard Only",
    description: "Actions are normalized and guarded, but approvals are not reusable signed leases.",
    scopeleaseContext: false,
    reviewFrontier: false,
    permissionGuard: true,
    signedLease: false,
    stopFrontier: false,
    expectedInterface: "local_guard_prompt"
  },
  {
    id: "C3",
    label: "ScopeLease Full",
    description: "Graph-scoped context, review frontier, permission frontier, signed lease, and stop frontier are enabled.",
    scopeleaseContext: true,
    reviewFrontier: true,
    permissionGuard: true,
    signedLease: true,
    stopFrontier: true,
    expectedInterface: "graph_scoped_delegation_contract"
  }
]);

export function loadBenchmarkTaskSpecs(tasksPath) {
  return loadBenchTasks(tasksPath).map((task, index) => normalizeBenchmarkTaskSpec(task, index));
}

export function normalizeBenchmarkTaskSpec(task = {}, index = 0) {
  const request = normalizeBenchRequest(task);
  const id = String(task.id || task.taskId || task.competition_id || task.competitionId || `task-${index + 1}`).trim();
  const benchmarkFamily = inferBenchmarkFamily(task);
  const category = normalizeCategory(task.category || task.taskType || task.type || benchmarkFamily || "unclassified");
  const workIntent = String(task.workIntent || deriveWorkIntent({ request })).trim();
  const criticalFiles = uniqueStrings(arrayFrom(task.criticalFiles || task.goldFiles || task.baselineFiles || task.files).map(normalizePath));
  const reviewFiles = uniqueStrings(arrayFrom(task.reviewFrontierFiles || task.expectedReviewFiles).map(normalizePath));
  const forbiddenFiles = uniqueStrings(arrayFrom(task.forbiddenFiles || task.forbiddenPaths || task.forbiddenContext).map(normalizePath));
  const commands = uniqueStrings(arrayFrom(task.allowedCommands || task.commandScopes || task.safeCommands).map(String));
  const stopConditions = uniqueStrings(arrayFrom(task.stopConditions || task.stopWhen || defaultStopConditionsForTask(task, request)).map(String));
  return {
    id,
    title: String(task.title || task.name || task.competition || ""),
    request,
    workIntent,
    benchmarkFamily,
    category,
    sourceBenchmark: benchmarkFamily,
    criticalFiles,
    reviewFiles,
    forbiddenFiles,
    allowedCommands: commands,
    stopConditions,
    expectedVerdict: String(task.expectedVerdict || task.expectedGuardVerdict || "").trim(),
    expectedActionGrant: String(task.expectedActionGrant || task.expectedGrant || "").trim(),
    expectedTaskSuccess: normalizeExpectedTaskSuccess(task),
    expectedEscalation: normalizeExpectedEscalation(task),
    acceptanceCriteria: arrayFrom(task.acceptanceCriteria || task.acceptance || task.completion?.acceptanceCriteria),
    completion: task.completion || task.completionSpec || task.completion_spec || null,
    raw: task
  };
}

export function buildConditionMatrixForTasks(tasksOrSpecs = [], options = {}) {
  const specs = Array.isArray(tasksOrSpecs)
    ? tasksOrSpecs.map((task, index) => task?.criticalFiles && task?.workIntent ? task : normalizeBenchmarkTaskSpec(task, index))
    : loadBenchmarkTaskSpecs(options.tasksPath || options.tasks || tasksOrSpecs);
  const conditions = resolveConditions(options.conditions || options.conditionIds);
  const rows = [];
  for (const task of specs) {
    for (const condition of conditions) {
      rows.push(buildConditionRow(task, condition));
    }
  }
  return {
    kind: "scopelease.condition_matrix",
    generatedAt: new Date().toISOString(),
    boundary: "ablation_design_not_result_claim",
    taskCount: specs.length,
    conditionCount: conditions.length,
    rowCount: rows.length,
    conditions,
    tasks: specs.map((task) => withoutRaw(task)),
    rows,
    summary: summarizeConditionMatrix(rows),
    claimBoundary: "This matrix defines C0-C3 measurements. It is not evidence until paired trajectory events are collected under the same task, agent, model, and budget."
  };
}

function buildConditionRow(task, condition) {
  return {
    id: `${task.id}:${condition.id}`,
    taskId: task.id,
    conditionId: condition.id,
    conditionLabel: condition.label,
    benchmarkFamily: task.benchmarkFamily,
    category: task.category,
    workIntent: task.workIntent,
    requestHash: stableHash(task.request),
    request: task.request,
    enabledFrontiers: {
      read: Boolean(condition.scopeleaseContext),
      review: Boolean(condition.reviewFrontier),
      permission: Boolean(condition.permissionGuard),
      lease: Boolean(condition.signedLease),
      stop: Boolean(condition.stopFrontier)
    },
    expectedSignals: {
      taskSuccess: task.expectedTaskSuccess,
      criticalFiles: task.criticalFiles,
      reviewFiles: task.reviewFiles,
      forbiddenFiles: task.forbiddenFiles,
      allowedCommands: task.allowedCommands,
      stopConditions: task.stopConditions,
      expectedVerdict: task.expectedVerdict,
      expectedActionGrant: task.expectedActionGrant,
      expectedEscalation: task.expectedEscalation
    },
    measurementPlan: measurementPlanForCondition(condition),
    claimUse: claimUseForCondition(condition),
    boundary: condition.id === "C0"
      ? "native_agent_behavior_baseline"
      : condition.id === "C3"
        ? "full_scopelease_delegation_contract"
        : "ablation_only"
  };
}

function measurementPlanForCondition(condition = {}) {
  const common = [
    "task_completion",
    "command_count",
    "file_read_count",
    "touched_file_count",
    "duration_ms"
  ];
  if (condition.scopeleaseContext) common.push("agent_visible_context_tokens", "review_frontier_precision_recall");
  if (condition.permissionGuard) common.push("guard_verdict", "unsafe_call_rate", "scope_violation_rate");
  if (condition.signedLease) common.push("lease_hit_count", "repeated_prompt_count", "lease_invalidation_count");
  if (condition.stopFrontier) common.push("stop_condition_adherence", "silent_guessing_rate");
  return common;
}

function claimUseForCondition(condition = {}) {
  if (condition.id === "C0") return "baseline behavior for the same task and agent budget";
  if (condition.id === "C1") return "separates graph-scoped context from scopeleaserity control";
  if (condition.id === "C2") return "separates action guard from reusable signed delegation";
  if (condition.id === "C3") return "tests the full scoped-delegation contract";
  return "ablation";
}

function summarizeConditionMatrix(rows = []) {
  const byCondition = {};
  const byBenchmark = {};
  for (const row of rows) {
    byCondition[row.conditionId] = (byCondition[row.conditionId] || 0) + 1;
    byBenchmark[row.benchmarkFamily || "unclassified"] = (byBenchmark[row.benchmarkFamily || "unclassified"] || 0) + 1;
  }
  return {
    byCondition,
    byBenchmark,
    taskFamilies: Object.keys(byBenchmark).length,
    requiredPairing: "Rows with the same taskId and workIntent must be run under each condition before C0-C3 deltas are claimable."
  };
}

function resolveConditions(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!raw.length) return CONDITION_PRESETS.map((item) => ({ ...item }));
  const wanted = new Set(raw.map((item) => item.toUpperCase()));
  return CONDITION_PRESETS.filter((item) => wanted.has(item.id)).map((item) => ({ ...item }));
}

function inferBenchmarkFamily(task = {}) {
  const raw = String(task.benchmarkFamily || task.benchmark || task.sourceBenchmark || task.source || "").trim();
  if (raw) return normalizeCategory(raw);
  const id = String(task.id || task.taskId || task.competition_id || "").toLowerCase();
  const request = normalizeBenchRequest(task).toLowerCase();
  if (id.includes("mle") || request.includes("kaggle") || request.includes("submission")) return "mle_bench_like";
  if (id.includes("hil") || request.includes("ask") || request.includes("ambiguous")) return "hil_bench_like";
  if (id.includes("swe") || request.includes("issue") || request.includes("bug")) return "swe_bench_like";
  if (request.includes("refactor")) return "swe_atlas_refactor_like";
  if (request.includes("test")) return "swe_atlas_test_like";
  return "local_repo_task";
}

function normalizeExpectedTaskSuccess(task = {}) {
  if (task.expectedTaskSuccess !== undefined) return Boolean(task.expectedTaskSuccess);
  if (task.expectedSuccess !== undefined) return Boolean(task.expectedSuccess);
  return null;
}

function normalizeExpectedEscalation(task = {}) {
  const raw = task.expectedEscalation || task.expectedAsk || task.askOracle || "";
  if (typeof raw === "boolean") return raw ? "ask" : "no_ask";
  return String(raw || "").trim();
}

function defaultStopConditionsForTask(task = {}, request = "") {
  const conditions = ["changed_file_outside_scope", "test_failure_without_known_cause"];
  const text = `${request} ${task.category || ""}`.toLowerCase();
  if (/(network|download|api|external)/.test(text)) conditions.push("network_access_requested");
  if (/(checkpoint|baseline|merge)/.test(text)) conditions.push("baseline_graph_changed");
  if (/(mle|training|submission|model)/.test(text)) conditions.push("metric_or_artifact_mismatch");
  return conditions;
}

function stableHash(value = "") {
  return `sha1:${createHash("sha1").update(String(value || "")).digest("hex")}`;
}

function withoutRaw(task = {}) {
  const { raw, ...rest } = task;
  return rest;
}

function normalizeCategory(value = "") {
  return String(value || "unclassified").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unclassified";
}

function normalizePath(value = "") {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function arrayFrom(value) {
  return Array.isArray(value) ? value : [];
}
