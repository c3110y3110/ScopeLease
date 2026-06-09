import {
  SILENT_FAILURE_TYPES,
  normalizeTrajectoryEvent,
  pairRowToTrajectoryEvents,
  permissionResultToTrajectoryEvents,
  reviewRowToTrajectoryEvents
} from "./trajectory-schema.js";

export function summarizeTrajectoryEvents(events = [], options = {}) {
  const normalized = events.map(normalizeTrajectoryEvent);
  const summary = {
    kind: "scopelease.trajectory_summary",
    boundary: "trajectory_metrics_not_provider_billing_or_human_fatigue",
    eventCount: normalized.length,
    byPhase: countBy(normalized, (event) => event.phase),
    byCondition: countBy(normalized, (event) => event.conditionId),
    silentFailures: summarizeSilentFailures(normalized),
    contextAndCall: summarizeContextAndCalls(normalized),
    permission: summarizePermission(normalized),
    taskSuccess: summarizeTaskSuccess(normalized),
    tokenClaim: buildTokenClaimStatus(normalized, options),
    notes: [
      "Positive token deltas are savings only for paired observed or named command protocols.",
      "Review-frontier file/token reductions are proxy evidence, not provider billing and not human review time.",
      "Human fatigue remains a study outcome; prompt counts and lease hits are proxies."
    ]
  };
  summary.overallStatus = deriveOverallStatus(summary);
  return summary;
}

export function buildSilentFailureSummary({
  pairRun = null,
  reviewBench = null,
  permissionRun = null,
  conditionMatrix = null,
  events = []
} = {}) {
  const allEvents = [...events];
  for (const row of pairRun?.rows || []) allEvents.push(...pairRowToTrajectoryEvents(row));
  for (const row of reviewBench?.rows || []) allEvents.push(...reviewRowToTrajectoryEvents(row));
  for (const row of permissionRun?.results || permissionRun?.rows || []) allEvents.push(...permissionResultToTrajectoryEvents(row));
  const summary = summarizeTrajectoryEvents(allEvents, {
    conditionMatrix,
    pairRun,
    reviewBench,
    permissionRun
  });
  return {
    kind: "scopelease.silent_failure_summary",
    generatedAt: new Date().toISOString(),
    boundary: summary.boundary,
    conditionMatrix: conditionMatrix
      ? {
        taskCount: conditionMatrix.taskCount,
        conditionCount: conditionMatrix.conditionCount,
        rowCount: conditionMatrix.rowCount,
        status: "design_ready_not_result_evidence"
      }
      : null,
    pairRun: summarizePairRun(pairRun),
    reviewBench: summarizeReviewBench(reviewBench),
    permissionRun: summarizePermissionRun(permissionRun),
    summary
  };
}

function summarizeSilentFailures(events = []) {
  const result = {};
  for (const type of SILENT_FAILURE_TYPES) {
    const items = events.flatMap((event) => event.failures?.[type] || []);
    result[type] = {
      count: items.length,
      affectedEvents: events.filter((event) => (event.failures?.[type] || []).length).length,
      examples: items.slice(0, 12)
    };
  }
  return result;
}

function summarizeContextAndCalls(events = []) {
  const tokenEvents = events.filter((event) => Number.isFinite(Number(event.metrics.defaultTokens)) && Number.isFinite(Number(event.metrics.scopeleaseTokens)));
  const defaultTokens = sum(tokenEvents, (event) => event.metrics.defaultTokens);
  const scopeleaseTokens = sum(tokenEvents, (event) => event.metrics.scopeleaseTokens);
  const commandEvents = events.filter((event) => Number.isFinite(Number(event.metrics.commandDefaultTokens)) && Number.isFinite(Number(event.metrics.commandScopeLeaseTokens)));
  const commandDefaultTokens = sum(commandEvents, (event) => event.metrics.commandDefaultTokens);
  const commandScopeLeaseTokens = sum(commandEvents, (event) => event.metrics.commandScopeLeaseTokens);
  const callEvents = events.filter((event) => Number.isFinite(Number(event.metrics.defaultCalls)) && Number.isFinite(Number(event.metrics.scopeleaseCalls)));
  const defaultCalls = sum(callEvents, (event) => event.metrics.defaultCalls);
  const scopeleaseCalls = sum(callEvents, (event) => event.metrics.scopeleaseCalls);
  const reviewEvents = events.filter((event) => event.phase === "review_frontier");
  return {
    agentVisibleTokens: {
      measuredEvents: tokenEvents.length,
      defaultTokens,
      scopeleaseTokens,
      savedTokens: defaultTokens - scopeleaseTokens,
      savedPercent: defaultTokens > 0 ? Math.round(((defaultTokens - scopeleaseTokens) / defaultTokens) * 100) : null,
      positiveEvents: tokenEvents.filter((event) => Number(event.metrics.savedTokens || 0) > 0).length,
      overheadEvents: tokenEvents.filter((event) => Number(event.metrics.savedTokens || 0) < 0).length
    },
    commandReportedTokens: {
      measuredEvents: commandEvents.length,
      defaultTokens: commandDefaultTokens,
      scopeleaseTokens: commandScopeLeaseTokens,
      savedTokens: commandDefaultTokens - commandScopeLeaseTokens,
      savedPercent: commandDefaultTokens > 0 ? Math.round(((commandDefaultTokens - commandScopeLeaseTokens) / commandDefaultTokens) * 100) : null,
      boundary: "command_reported_total_tokens_not_provider_billing"
    },
    toolCallProxy: {
      measuredEvents: callEvents.length,
      defaultCalls,
      scopeleaseCalls,
      savedCalls: defaultCalls - scopeleaseCalls,
      savedPercent: defaultCalls > 0 ? Math.round(((defaultCalls - scopeleaseCalls) / defaultCalls) * 100) : null
    },
    reviewFrontier: {
      measuredEvents: reviewEvents.length,
      baselineFiles: sum(reviewEvents, (event) => event.metrics.baselineFiles),
      frontierFiles: sum(reviewEvents, (event) => event.metrics.reviewFrontierFiles),
      averageCriticalFileRecallPercent: mean(reviewEvents.map((event) => event.metrics.criticalFileRecallPercent).filter(Number.isFinite)),
      averageCriticalFilePrecisionPercent: mean(reviewEvents.map((event) => event.metrics.criticalFilePrecisionPercent).filter(Number.isFinite))
    }
  };
}

function summarizePermission(events = []) {
  const permissionEvents = events.filter((event) => event.phase === "permission");
  return {
    measuredEvents: permissionEvents.length,
    humanPrompts: sum(permissionEvents, (event) => event.metrics.humanPrompt),
    denies: sum(permissionEvents, (event) => event.metrics.deny),
    leaseHits: sum(permissionEvents, (event) => event.metrics.leaseHit),
    falseVerdictEvents: permissionEvents.filter((event) => (event.failures?.escalation_error || []).length).length,
    falseGrantEvents: permissionEvents.filter((event) => (event.failures?.scope_drift || []).length).length,
    unsafeAllowEvents: permissionEvents.filter((event) => (event.failures?.unsafe_call || []).length).length
  };
}

function summarizeTaskSuccess(events = []) {
  const completionEvents = events.filter((event) => event.phase === "completion" || event.status === "pass" || event.status === "fail");
  const passed = completionEvents.filter((event) => event.status === "pass").length;
  const failed = completionEvents.filter((event) => event.status === "fail").length;
  return {
    measuredEvents: completionEvents.length,
    passed,
    failed,
    passRate: completionEvents.length ? Math.round((passed / completionEvents.length) * 100) : null,
    boundary: "non_inferiority_requires_same_task_same_agent_budget"
  };
}

function buildTokenClaimStatus(events = [], options = {}) {
  const pairRun = options.pairRun || {};
  const command = pairRun.summary?.commandReportedTotalTokens || pairRun.summary?.commandReported || {};
  const pairRows = pairRun.rows || [];
  const hasLiveObserved = pairRows.some((row) => row.liveDefaultCodexObserved);
  const positivePairs = pairRows.filter((row) => Number(row.savedTokens || 0) > 0).length;
  const overheadPairs = pairRows.filter((row) => Number(row.savedTokens || 0) < 0).length;
  if (command?.measuredPairs > 0 || command?.defaultTokens > 0) {
    return {
      status: command.savedTokens > 0 ? "partial_command_reported_delta" : "command_reported_no_savings",
      boundary: "command_reported_total_tokens_not_provider_billing",
      measuredPairs: command.measuredPairs || 0,
      defaultTokens: command.defaultTokens || 0,
      scopeleaseTokens: command.scopeleaseTokens || 0,
      savedTokens: command.savedTokens || 0,
      savedPercent: command.savedPercent ?? null
    };
  }
  if (pairRows.length) {
    return {
      status: hasLiveObserved && positivePairs > 0 ? "partial_agent_visible_pair_delta" : "controlled_or_insufficient_pair_delta",
      boundary: "agent_visible_input_not_provider_billing",
      measuredPairs: pairRows.length,
      positivePairs,
      overheadPairs,
      reason: hasLiveObserved
        ? "live observed pair rows exist, but report-grade average still requires enough repos and pairs"
        : "controlled prompt protocol or token-only pair rows are diagnostic, not natural Codex average behavior"
    };
  }
  return {
    status: "needs_same_work_intent_pairs",
    boundary: "no_average_token_saving_claim",
    measuredPairs: 0,
    reason: "Run pair-run or product-wide-summary with same workIntent/pairId C0 and C3 lanes before claiming token savings."
  };
}

function deriveOverallStatus(summary = {}) {
  const failures = summary.silentFailures || {};
  const silentFailureCount = Object.values(failures).reduce((total, row) => total + Number(row.count || 0), 0);
  if (summary.tokenClaim?.status === "needs_same_work_intent_pairs") return "mechanism_ready_pairs_needed";
  if (silentFailureCount > 0) return "measured_with_failures_visible";
  return "measured_no_silent_failures_detected";
}

function summarizePairRun(pairRun = null) {
  if (!pairRun) return null;
  return {
    mode: pairRun.mode,
    observationKind: pairRun.observationKind,
    claimScope: pairRun.claimScope,
    measuredPairs: pairRun.summary?.measuredPairs || pairRun.rows?.length || 0,
    defaultTokens: pairRun.summary?.defaultTokens || 0,
    scopeleaseTokens: pairRun.summary?.scopeleaseTokens || 0,
    savedTokens: pairRun.summary?.savedTokens || 0,
    savedPercent: pairRun.summary?.savedPercent ?? null
  };
}

function summarizeReviewBench(reviewBench = null) {
  if (!reviewBench) return null;
  return {
    boundary: reviewBench.boundary,
    measuredTasks: reviewBench.summary?.measuredTasks || 0,
    passedTasks: reviewBench.summary?.passedTasks || 0,
    failedTasks: reviewBench.summary?.failedTasks || 0,
    baselineReviewFiles: reviewBench.summary?.baselineReviewFiles || 0,
    reviewFrontierFiles: reviewBench.summary?.reviewFrontierFiles || 0,
    reviewScopeReductionPercent: reviewBench.summary?.reviewScopeReductionPercent ?? null,
    criticalFileRecallPercent: reviewBench.summary?.criticalFileRecallPercent ?? null,
    criticalFilePrecisionPercent: reviewBench.summary?.criticalFilePrecisionPercent ?? null,
    toolCallProxy: reviewBench.summary?.toolCallProxy || null,
    roughFileReadTokens: reviewBench.summary?.roughFileReadTokens || null
  };
}

function summarizePermissionRun(permissionRun = null) {
  if (!permissionRun) return null;
  return {
    passed: permissionRun.summary?.passed ?? null,
    failed: permissionRun.summary?.failed ?? null,
    total: permissionRun.summary?.total ?? null,
    humanPrompts: permissionRun.summary?.humanPrompts ?? null,
    denies: permissionRun.summary?.denies ?? permissionRun.summary?.denied ?? null,
    leaseHits: permissionRun.summary?.leaseHits ?? null
  };
}

function countBy(values = [], keyFn = () => "") {
  const result = {};
  for (const item of values) {
    const key = String(keyFn(item) || "unknown");
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

function sum(values = [], mapper = (value) => value) {
  return values.reduce((total, value) => {
    const number = Number(mapper(value) || 0);
    return total + (Number.isFinite(number) ? number : 0);
  }, 0);
}

function mean(values = []) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (!nums.length) return null;
  return Math.round(nums.reduce((total, value) => total + value, 0) / nums.length);
}
