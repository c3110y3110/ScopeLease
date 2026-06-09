import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildProductWideTokenSummary } from "./evidence-export.js";
import { buildConditionMatrixForTasks, loadBenchmarkTaskSpecs } from "./benchmark-adapter.js";
import { evaluateReviewFrontierBench } from "./review-bench.js";
import { buildSilentFailureSummary } from "./trajectory-metrics.js";
import { runControlledAblation } from "./ablation-runner.js";

const DEFAULT_TASKS = "examples/evaluation/patent-paper-review-frontier-tasks.jsonl";

export function buildDelegationControlReport(repoPath, options = {}) {
  const root = path.resolve(repoPath || ".");
  const outputDir = path.resolve(root, options.outputDir || options.output || path.join(".scopelease", "reports", `delegation-control-${timestampId()}`));
  const tasksPath = resolveTasksPath(root, options.tasksPath || options.tasks || DEFAULT_TASKS);
  const frozenProductWide = loadFrozenProductWideSummary(root, options.productWideSummaryPath || options.productWideSummary || options["product-wide-summary"] || options.productSummary);
  const tasks = tasksPath && fs.existsSync(tasksPath) ? loadBenchmarkTaskSpecs(tasksPath) : [];
  const conditionMatrix = buildConditionMatrixForTasks(tasks, {
    conditions: options.conditions || options.conditionIds
  });
  const reviewBench = options.noReview
    ? null
    : evaluateReviewFrontierBench(root, {
      tasksPath,
      budget: Number(options.budget || 8000),
      limit: options.limit,
      baselineMode: options.baselineMode || options["baseline-mode"],
      maxReviewFiles: options.maxReviewFiles || options["max-review-files"],
      maxFrontierFiles: options.maxFrontierFiles || options["max-frontier-files"],
      maxTerms: options.maxTerms || options["max-terms"]
    });
  const controlledAblation = options.noAblation
    ? null
    : runControlledAblation(root, {
      tasksPath,
      reviewBench,
      budget: Number(options.budget || 8000),
      conditions: options.conditions || options.conditionIds,
      baselineMode: options.baselineMode || options["baseline-mode"],
      maxReviewFiles: options.maxReviewFiles || options["max-review-files"],
      maxFrontierFiles: options.maxFrontierFiles || options["max-frontier-files"],
      maxTerms: options.maxTerms || options["max-terms"]
    });
  const productWide = frozenProductWide?.summary || buildProductWideTokenSummary(options.repos || options.manifest || [root], {
    cwd: options.cwd || process.cwd(),
    minRepos: options.minRepos || options["min-repos"] || 10,
    minPairs: options.minPairs || options["min-pairs"] || 100,
    minDefaultTokens: options.minDefaultTokens || options["min-default-tokens"] || 100,
    observedPairScope: options.observedPairScope || options["observed-pair-scope"],
    claimMetric: options.claimMetric || options["claim-metric"] || "command-reported",
    runId: options.runId || options["run-id"],
    runIdPrefix: options.runIdPrefix || options["run-id-prefix"],
    commandPairSelection: options.commandPairSelection || options["command-pair-scope"],
    inputCostPerMillion: options.inputCostPerMillion || options["input-cost-per-1m"],
    currency: options.currency || "USD"
  });
  const latestPermission = options.permissionRunPath
    ? readPermissionRun(options.permissionRunPath)
    : findLatestPermissionFixtureRun(root);
  const silentFailures = buildSilentFailureSummary({
    reviewBench,
    permissionRun: latestPermission?.raw || latestPermission,
    conditionMatrix
  });
  const axes = buildDelegationAxes({
    productWide,
    reviewBench,
    latestPermission,
    silentFailures,
    conditionMatrix,
    controlledAblation
  });
  const report = sanitizeReportPaths(root, {
    kind: "scopelease.delegation_control_report",
    generatedAt: new Date().toISOString(),
    repo: artifactPath(root, root),
    boundary: "scoped_delegation_control_not_provider_billing_or_human_fatigue",
    status: axes.overallStatus,
    tasksPath: artifactPath(root, tasksPath),
    evaluationConfig: buildEvaluationConfig({ root, tasksPath, options, frozenProductWide }),
    evidenceSources: buildEvidenceSources({ root, tasksPath, productWide, frozenProductWide, reviewBench, latestPermission, controlledAblation }),
    axes,
    conditionMatrix,
    controlledAblation,
    tokenSavings: buildTokenSavingsSection({ productWide, reviewBench, silentFailures }),
    silentFailures,
    productWide: compactProductWideForReport(productWide),
    latestPermission: compactPermissionRunForReport(root, latestPermission),
    claimMetricBoundaries: buildClaimMetricBoundaries({ productWide, reviewBench, latestPermission }),
    claimPolicy: buildDelegationClaimPolicy({ productWide, reviewBench, latestPermission }),
    nextEvidence: buildDelegationNextEvidence({ productWide, reviewBench, latestPermission, controlledAblation })
  });

  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "delegation-control-report.json");
  const mdPath = path.join(outputDir, "delegation-control-report.md");
  const manifestPath = path.join(outputDir, "evidence-manifest.json");
  report.evidenceManifestPath = artifactPath(root, manifestPath);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(mdPath, renderDelegationMarkdown(report));
  const manifest = buildEvidenceManifest({
    root,
    outputDir,
    jsonPath,
    mdPath,
    manifestPath,
    tasksPath,
    frozenProductWide,
    latestPermission,
    report
  });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    kind: "scopelease.delegation_control_report_export",
    outputDir,
    files: [jsonPath, mdPath, manifestPath],
    report
  };
}

function buildEvaluationConfig({ root = "", tasksPath = "", options = {}, frozenProductWide = null } = {}) {
  return {
    repo: artifactPath(root, root),
    tasksPath: artifactPath(root, tasksPath),
    productWideSummaryPath: frozenProductWide?.path ? artifactPath(root, frozenProductWide.path) : null,
    budget: Number(options.budget || 8000),
    baselineMode: options.baselineMode || options["baseline-mode"] || null,
    maxReviewFiles: numericOrNull(options.maxReviewFiles || options["max-review-files"]),
    maxFrontierFiles: numericOrNull(options.maxFrontierFiles || options["max-frontier-files"]),
    maxTerms: numericOrNull(options.maxTerms || options["max-terms"]),
    noReview: Boolean(options.noReview),
    noAblation: Boolean(options.noAblation),
    boundary: "reported_values_are_valid_for_this_configuration_only"
  };
}

function buildDelegationAxes({
  productWide = {},
  reviewBench = null,
  latestPermission = null,
  silentFailures = {},
  conditionMatrix = {},
  controlledAblation = null
} = {}) {
  const review = reviewBench?.summary || {};
  const permissionReady = Boolean(latestPermission?.summary?.failed === 0 && latestPermission?.summary?.total > 0);
  const productReady = productWide.commandReported?.status === "claim_ready" || productWide.status === "claim_ready";
  const reviewReady = Boolean(review.measuredTasks > 0 && review.failedTasks === 0);
  const reviewMeasured = Number(review.measuredTasks || 0) > 0;
  const matrixReady = Number(conditionMatrix.rowCount || 0) > 0;
  const ablationReady = Number(controlledAblation?.rowCount || 0) > 0;
  const agentVisible = productWide.agentVisible || {};
  return {
    overallStatus: productReady && reviewReady && permissionReady
      ? "controlled_delegation_evidence_ready_live_completion_and_human_needed"
      : reviewReady && permissionReady
        ? "mechanism_ready_live_pairs_needed"
        : "partial_mechanism_evidence",
    A_taskCompletion: {
      status: "requires_paired_agent_runs",
      boundary: "completion non-inferiority must be measured under same agent/model/budget",
      source: "pair-run or formal-command-eval",
      controlledAblationBoundary: "C0-C3 controlled boundary pass is not live task completion",
      current: productWide.commandReported?.quality || productWide.quality || null
    },
    B_contextAndCallReduction: {
      status: productReady ? "paired_metric_ready" : "proxy_ready_pairs_needed",
      pairedObserved: {
        status: agentVisible.status || productWide.status,
        boundary: "live_observed_agent_visible_pairs_not_provider_billing",
        measuredRepos: agentVisible.measuredRepoCount || 0,
        measuredPairs: agentVisible.measuredPairCount || 0,
        savedPercent: agentVisible.weighted?.savedPercent ?? null
      },
      commandReported: {
        status: productWide.commandReported?.status || "not_measured",
        measuredRepos: productWide.commandReported?.measuredRepoCount || 0,
        measuredPairs: productWide.commandReported?.measuredPairCount || 0,
        savedPercent: productWide.commandReported?.weighted?.savedPercent ?? null
      },
      reviewFrontierProxy: {
        baselineFiles: review.baselineReviewFiles || 0,
        frontierFiles: review.reviewFrontierFiles || 0,
        fileReductionPercent: review.reviewScopeReductionPercent ?? null,
        roughFileReadTokenReductionPercent: review.roughFileReadTokens?.savedPercent ?? null,
        toolCallProxyReductionPercent: review.toolCallProxy?.savedPercent ?? null
      }
    },
    C_permissionDelegation: {
      status: permissionReady ? "fixture_ready" : "needs_permission_fixture_run",
      passed: latestPermission?.summary?.passed ?? null,
      total: latestPermission?.summary?.total ?? null,
      humanPrompts: latestPermission?.summary?.humanPrompts ?? null,
      denies: latestPermission?.summary?.denies ?? latestPermission?.summary?.denied ?? null,
      leaseHits: latestPermission?.summary?.leaseHits ?? null,
      confusion: latestPermission?.summary?.confusion || null,
      boundary: "fixture correctness and prompt-count proxy, not human cognitive fatigue"
    },
    D_reviewBoundaryQuality: {
      status: reviewReady
        ? "controlled_frontier_ready"
        : reviewMeasured
          ? "controlled_frontier_partial"
          : "needs_review_frontier_run",
      measuredTasks: review.measuredTasks || 0,
      passedTasks: review.passedTasks || 0,
      failedTasks: review.failedTasks || 0,
      criticalFileRecallPercent: review.criticalFileRecallPercent ?? null,
      criticalFilePrecisionPercent: review.criticalFilePrecisionPercent ?? null,
      criticalFileRankMetrics: review.criticalFileRankMetrics || null,
      leakageFailures: review.leakageFailures || 0,
      mergeFailures: review.mergeFailures || 0,
      intentFailures: review.intentFailures || 0,
      boundary: "candidate review surface reduction, not human review time"
    },
    E_silentFailureTrajectory: {
      status: silentFailures.summary?.overallStatus || "not_measured",
      eventCount: silentFailures.summary?.eventCount || 0,
      failures: silentFailures.summary?.silentFailures || {},
      boundary: silentFailures.boundary || "trajectory metrics"
    },
    F_humanSupervision: {
      status: "planned_not_claim_ready",
      boundary: "participant data required for workload, trust, fatigue, perceived control, and decision accuracy claims"
    },
    G_ablationDesign: {
      status: ablationReady
        ? "C0_C1_C2_C3_controlled_result_ready"
        : matrixReady
          ? "C0_C1_C2_C3_design_ready"
          : "needs_task_manifest",
      taskCount: conditionMatrix.taskCount || 0,
      conditionCount: conditionMatrix.conditionCount || 0,
      rowCount: conditionMatrix.rowCount || 0,
      controlledRows: controlledAblation?.rowCount || 0,
      boundary: controlledAblation?.boundary || conditionMatrix.boundary || "ablation_design_not_result_claim"
    }
  };
}

function buildEvidenceSources({
  root = "",
  tasksPath = "",
  productWide = {},
  frozenProductWide = null,
  reviewBench = null,
  latestPermission = null,
  controlledAblation = null
} = {}) {
  return {
    tasks: tasksPath ? { path: artifactPath(root, tasksPath) } : null,
    productWide: frozenProductWide
      ? {
        type: "frozen_product_wide_summary",
        path: artifactPath(root, frozenProductWide.path),
        generatedAt: productWide.generatedAt || null,
        status: productWide.commandReported?.status || productWide.status || null,
        commandReported: {
          measuredRepoCount: productWide.commandReported?.measuredRepoCount ?? null,
          measuredPairCount: productWide.commandReported?.measuredPairCount ?? null,
          savedPercent: productWide.commandReported?.weighted?.savedPercent ?? null
        }
      }
      : {
        type: "computed_from_repo_state",
        status: productWide.commandReported?.status || productWide.status || null,
        commandReported: {
          measuredRepoCount: productWide.commandReported?.measuredRepoCount ?? null,
          measuredPairCount: productWide.commandReported?.measuredPairCount ?? null,
          savedPercent: productWide.commandReported?.weighted?.savedPercent ?? null
        }
      },
    reviewFrontier: reviewBench?.summary
      ? {
        type: "fresh_review_bench",
        measuredTasks: reviewBench.summary.measuredTasks || 0,
        passedTasks: reviewBench.summary.passedTasks || 0,
        failedTasks: reviewBench.summary.failedTasks || 0
      }
      : null,
    permissionFixture: latestPermission?.summaryPath
      ? {
        type: "latest_permission_fixture",
        path: artifactPath(root, latestPermission.summaryPath),
        passed: latestPermission.summary?.passed ?? null,
        failed: latestPermission.summary?.failed ?? null
      }
      : null,
    controlledAblation: controlledAblation?.summary
      ? {
        type: "fresh_controlled_ablation",
        boundary: controlledAblation.boundary,
        taskCount: controlledAblation.taskCount || 0,
        rowCount: controlledAblation.rowCount || 0
      }
      : null
  };
}

function buildTokenSavingsSection({ productWide = {}, reviewBench = null, silentFailures = {} } = {}) {
  const review = reviewBench?.summary || {};
  const agentVisible = productWide.agentVisible || {};
  return {
    headlineBoundary: "Token/call savings are split by measurement source. Do not merge proxy file-read reductions with provider billing or natural Codex retrieval.",
    observedAgentVisiblePairs: {
      status: agentVisible.status || "insufficient_real_use_observed_pairs",
      boundary: "live_observed_agent_visible_pairs_not_provider_billing",
      measuredRepos: agentVisible.measuredRepoCount || 0,
      measuredPairs: agentVisible.measuredPairCount || 0,
      defaultTokens: agentVisible.weighted?.defaultTokens || 0,
      scopeleaseTokens: agentVisible.weighted?.scopeleaseTokens || 0,
      savedTokens: agentVisible.weighted?.savedTokens ?? null,
      savedPercent: agentVisible.weighted?.savedPercent ?? null
    },
    commandReportedTotalTokens: {
      status: productWide.commandReported?.status || "not_measured",
      boundary: "Codex/agent command-reported total tokens, not provider billing",
      measuredRepos: productWide.commandReported?.measuredRepoCount || 0,
      measuredPairs: productWide.commandReported?.measuredPairCount || 0,
      defaultTokens: productWide.commandReported?.weighted?.defaultTokens || 0,
      scopeleaseTokens: productWide.commandReported?.weighted?.scopeleaseTokens || 0,
      savedTokens: productWide.commandReported?.weighted?.savedTokens || 0,
      savedPercent: productWide.commandReported?.weighted?.savedPercent ?? null
    },
    reviewFrontierFileReadProxy: {
      status: review.measuredTasks ? "proxy_ready" : "not_measured",
      boundary: "file-read/tool-call candidate reduction, not actual agent token usage",
      measuredTasks: review.measuredTasks || 0,
      defaultTokens: review.roughFileReadTokens?.defaultTokens || 0,
      scopeleaseTokens: review.roughFileReadTokens?.scopeleaseTokens || 0,
      savedTokens: review.roughFileReadTokens?.savedTokens || 0,
      savedPercent: review.roughFileReadTokens?.savedPercent ?? null,
      defaultCalls: review.toolCallProxy?.defaultCalls || 0,
      scopeleaseCalls: review.toolCallProxy?.scopeleaseCalls || 0,
      callSavedPercent: review.toolCallProxy?.savedPercent ?? null
    },
    trajectoryTokenClaim: silentFailures.summary?.tokenClaim || {
      status: "needs_same_work_intent_pairs"
    }
  };
}

function buildClaimMetricBoundaries({ productWide = {}, reviewBench = null, latestPermission = null } = {}) {
  const commandReady = productWide.commandReported?.status === "claim_ready";
  const review = reviewBench?.summary || {};
  const permissionReady = Boolean(latestPermission?.summary?.failed === 0 && latestPermission?.summary?.total > 0);
  return {
    commandReportedTotalTokens: {
      status: productWide.commandReported?.status || "not_measured",
      canClaim: commandReady
        ? "named command-reported total token delta for the frozen same-workIntent protocol"
        : "not claim-ready",
      cannotClaim: [
        "provider/API billing reduction",
        "hidden prompt or reasoning token reduction",
        "natural Codex full-workspace baseline",
        "human workload or review-time reduction"
      ],
      evidence: {
        measuredRepos: productWide.commandReported?.measuredRepoCount || 0,
        measuredPairs: productWide.commandReported?.measuredPairCount || 0,
        savedPercent: productWide.commandReported?.weighted?.savedPercent ?? null
      }
    },
    observedAgentVisiblePairs: {
      status: productWide.agentVisible?.status || productWide.status || "not_measured",
      canClaim: productWide.agentVisible?.status === "claim_ready"
        ? "live observed agent-visible input token delta under strict independent lanes"
        : "insufficient for product-wide live average savings",
      cannotClaim: [
        "controlled prompt protocol as live default-agent behavior",
        "auto-promoted same-run pairs as independent lanes",
        "provider billing"
      ],
      evidence: {
        measuredRepos: productWide.agentVisible?.measuredRepoCount || 0,
        measuredPairs: productWide.agentVisible?.measuredPairCount || 0,
        savedPercent: productWide.agentVisible?.weighted?.savedPercent ?? null
      }
    },
    reviewFrontierProxy: {
      status: review.measuredTasks ? "proxy_ready" : "not_measured",
      canClaim: review.measuredTasks
        ? "controlled candidate file/tool-call surface reduction with recall, leakage, merge, and intent checks"
        : "not measured",
      cannotClaim: [
        "actual provider token savings",
        "human review-time reduction",
        "natural agent retrieval behavior"
      ],
      evidence: {
        measuredTasks: review.measuredTasks || 0,
        fileReductionPercent: review.reviewScopeReductionPercent ?? null,
        roughFileReadTokenReductionPercent: review.roughFileReadTokens?.savedPercent ?? null,
        toolCallProxyReductionPercent: review.toolCallProxy?.savedPercent ?? null,
        criticalRecallPercent: review.criticalFileRecallPercent ?? null,
        medianFirstCriticalRank: review.criticalFileRankMetrics?.medianFirstCriticalRank ?? null
      }
    },
    permissionFixture: {
      status: permissionReady ? "fixture_ready" : "not_claim_ready",
      canClaim: permissionReady
        ? "fixture-level guard/deny/ask, signed lease issuance, lease reuse, and false-allow/false-block accounting"
        : "not measured or failed",
      cannotClaim: [
        "human fatigue reduction",
        "real-world security guarantee",
        "universal sandboxing without host-routed enforcement"
      ],
      evidence: latestPermission?.summary || null
    },
    providerBilling: {
      status: productWide.providerBilling?.status || "not_measured",
      canClaim: productWide.providerBilling?.claimPolicy?.canClaimProviderBillingSavings
        ? "paired provider usage delta"
        : "no provider billing savings claim",
      cannotClaim: [
        "billing savings from command-reported or proxy token deltas"
      ]
    },
    humanOutcomes: {
      status: "planned_not_claim_ready",
      canClaim: "human-study protocol only",
      cannotClaim: [
        "fatigue reduction",
        "trust calibration improvement",
        "perceived control improvement",
        "review-time reduction"
      ]
    }
  };
}

function buildEvidenceManifest({
  root = "",
  outputDir = "",
  jsonPath = "",
  mdPath = "",
  manifestPath = "",
  tasksPath = "",
  frozenProductWide = null,
  latestPermission = null,
  report = {}
} = {}) {
  const sourceFiles = [
    tasksPath,
    frozenProductWide?.path,
    latestPermission?.summaryPath,
    path.join(root, "package.json"),
    path.join(root, "package-lock.json"),
    path.join(root, "src/core/delegation-report.js"),
    path.join(root, "src/core/review-bench.js"),
    path.join(root, "src/core/evidence-export.js"),
    path.join(root, "src/core/ablation-runner.js"),
    path.join(root, "src/core/approval-lease.js"),
    path.join(root, "src/core/enforcer.js"),
    path.join(root, "examples/evaluation/patent-paper-review-frontier-tasks.jsonl")
  ].filter(Boolean);
  return {
    kind: "scopelease.evidence_manifest",
    generatedAt: new Date().toISOString(),
    repo: artifactPath(root, root),
    outputDir: artifactPath(root, outputDir),
    invocation: invocationString(root),
    boundary: "frozen local evidence manifest; hashes identify inputs and generated report files for this run",
    evaluationConfig: report.evaluationConfig || {},
    evidenceSources: report.evidenceSources || {},
    claimMetricBoundaries: report.claimMetricBoundaries || {},
    sourceFiles: hashExistingFiles(sourceFiles, root),
    reportFiles: hashExistingFiles([jsonPath, mdPath], root),
    manifestPath: artifactPath(root, manifestPath),
    sourceOfTruthRules: [
      "Use this manifest with delegation-control-report.json for current local evidence.",
      "Do not mix older report directories or stale docs into current numeric claims.",
      "Token/call claims remain separated by command-reported, observed-agent-visible, review-proxy, and provider-billing sources.",
      "Human outcome claims remain planned until participant data exists."
    ]
  };
}

function hashExistingFiles(files = [], root = process.cwd()) {
  const seen = new Set();
  const rows = [];
  for (const file of files) {
    const resolved = path.resolve(String(file || ""));
    if (!fs.existsSync(resolved) || seen.has(resolved)) continue;
    seen.add(resolved);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) continue;
    rows.push({
      relativePath: artifactPath(root, resolved),
      sha256: sha256File(resolved),
      bytes: stat.size,
      mtime: stat.mtime.toISOString()
    });
  }
  return rows;
}

function sha256File(filePath = "") {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function invocationString(root = process.cwd()) {
  const argv = Array.isArray(process.argv) ? process.argv : [];
  if (!argv.length) return "";
  return [path.basename(process.execPath), ...argv.slice(1).map((item) => artifactPath(root, item))].join(" ");
}

function artifactPath(root = process.cwd(), value = "") {
  if (!value) return "";
  const text = String(value);
  const resolvedRoot = path.resolve(root || ".");
  if (!path.isAbsolute(text)) return normalizePath(text);
  const resolved = path.resolve(text);
  if (resolved === resolvedRoot) return "<repo-root>";
  const relative = path.relative(resolvedRoot, resolved);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return normalizePath(relative);
  }
  return `<external:${path.basename(resolved)}>`;
}

function normalizePath(value = "") {
  return String(value).split(path.sep).join("/");
}

function sanitizeReportPaths(root = process.cwd(), value = null) {
  if (typeof value === "string") return sanitizeReportString(root, value);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeReportPaths(root, item));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizeReportPaths(root, item)])
  );
}

function sanitizeReportString(root = process.cwd(), value = "") {
  const text = String(value);
  if (!text) return text;
  if (path.isAbsolute(text) && text.trim() === text) return artifactPath(root, text);
  const localRoot = path.resolve(root || ".");
  const normalizedRoot = normalizePath(localRoot);
  let sanitized = text.split(localRoot).join("<repo-root>");
  sanitized = sanitized.split(normalizedRoot).join("<repo-root>");
  return sanitized.replace(/\/Users\/[^"'\s,}\]]+/g, "<local-path>");
}

function compactPermissionRunForReport(root = process.cwd(), latestPermission = null) {
  if (!latestPermission) return null;
  return {
    name: latestPermission.name || null,
    summaryPath: latestPermission.summaryPath ? artifactPath(root, latestPermission.summaryPath) : null,
    summary: latestPermission.summary || null
  };
}

function compactProductWideForReport(productWide = {}) {
  const command = productWide.commandReported || {};
  return {
    kind: productWide.kind,
    generatedAt: productWide.generatedAt,
    boundary: productWide.boundary,
    metric: productWide.metric,
    claimMetric: productWide.claimMetric,
    runFilter: productWide.runFilter,
    commandPairSelection: productWide.commandPairSelection,
    observedPairScope: productWide.observedPairScope,
    status: productWide.status,
    minRepos: productWide.minRepos,
    minPairs: productWide.minPairs,
    minDefaultTokens: productWide.minDefaultTokens,
    repoCount: productWide.repoCount,
    measuredRepoCount: productWide.measuredRepoCount,
    measuredPairCount: productWide.measuredPairCount,
    weighted: productWide.weighted || null,
    byTaskType: productWide.byTaskType || [],
    agentVisible: compactAggregate(productWide.agentVisible),
    providerBilling: compactAggregate(productWide.providerBilling),
    costEstimate: productWide.costEstimate || null,
    controlledProtocol: productWide.controlledProtocol || null,
    commandReported: {
      status: command.status || "not_measured",
      source: command.source,
      boundary: command.boundary,
      measuredRepoCount: command.measuredRepoCount || 0,
      measuredPairCount: command.measuredPairCount || 0,
      tinyDefaultPairCount: command.tinyDefaultPairCount || 0,
      weighted: command.weighted || null,
      quality: command.quality || null,
      decisionProxy: command.decisionProxy || null,
      duration: command.duration || null,
      byTaskType: command.byTaskType || []
    },
    claimPolicy: productWide.claimPolicy || null,
    caveat: productWide.caveat || null,
    detailBoundary: "pair-level rows are kept in the referenced frozen product-wide summary, not duplicated in this delegation report"
  };
}

function compactAggregate(value = {}) {
  if (!value || typeof value !== "object") return null;
  return {
    status: value.status,
    boundary: value.boundary,
    source: value.source,
    measuredRepoCount: value.measuredRepoCount || 0,
    measuredPairCount: value.measuredPairCount || 0,
    weighted: value.weighted || null,
    byTaskType: value.byTaskType || []
  };
}

function buildDelegationClaimPolicy({ productWide = {}, reviewBench = null, latestPermission = null } = {}) {
  const review = reviewBench?.summary || {};
  const permissionReady = Boolean(latestPermission?.summary?.failed === 0 && latestPermission?.summary?.total > 0);
  const commandReady = productWide.commandReported?.status === "claim_ready";
  return {
    allowed: [
      "ScopeLease can be described as a graph-scoped delegation-control layer with read, review, permission, and stop frontiers.",
      permissionReady
        ? "Permission fixture evidence supports guard/deny/ask, signed scoped lease issuance, and lease reuse behavior."
        : "Permission behavior must be reported as pending until a current fixture run passes.",
      review.measuredTasks
        ? "Review-frontier reductions can be reported as controlled candidate-surface reductions with recall/leakage/merge/intent checks."
        : "Review-frontier claims require a current review-bench run.",
      commandReady
        ? "Named command-reported token deltas may be reported for that protocol, while excluding provider billing."
        : "Token/call savings should be reported as proxy or insufficient until same-workIntent pairs satisfy the configured threshold."
    ],
    forbidden: [
      "Do not claim provider/API billing reduction unless paired provider usage is explicitly ingested.",
      "Do not describe full repository tokens or readPlanFiles as the natural Codex default baseline.",
      "Do not claim human cognitive fatigue, trust, perceived control, or review-time reduction without participant data.",
      "Do not hide negative token deltas, overhead pairs, failed commands, false blocks, or false allows."
    ]
  };
}

function buildDelegationNextEvidence({ productWide = {}, reviewBench = null, latestPermission = null, controlledAblation = null } = {}) {
  const items = [];
  if (productWide.commandReported?.status !== "claim_ready") {
    items.push("Collect C0/C3 same-workIntent command-reported pairs with fixed agent/model/budget before average token-saving language.");
  }
  if (!reviewBench?.summary?.measuredTasks) {
    items.push("Run review-bench on a frozen task manifest to measure omission, leakage, merge, and intent boundaries.");
  }
  if (!(latestPermission?.summary?.failed === 0 && latestPermission?.summary?.total > 0)) {
    items.push("Run permission-fixtures --run after code changes to refresh guard/lease evidence.");
  }
  if (controlledAblation?.rowCount) {
    items.push("Run live or official C0/C1/C2/C3 agent ablations with the same model, scaffold, budget, verifier, timeout, and retry policy.");
  } else {
    items.push("Run C0/C1/C2/C3 controlled ablations to separate context retrieval from scopeleaserity control and signed lease reuse.");
  }
  items.push("Keep human-supervision claims planned until participant data is collected.");
  return items;
}

function renderDelegationMarkdown(report = {}) {
  const axes = report.axes || {};
  const token = report.tokenSavings || {};
  const sources = report.evidenceSources || {};
  const ablation = report.controlledAblation?.summary || {};
  const rank = axes.D_reviewBoundaryQuality?.criticalFileRankMetrics || {};
  const confusion = axes.C_permissionDelegation?.confusion || {};
  return `# ScopeLease Delegation-Control Evaluation Report

Generated: ${report.generatedAt}

Boundary: ${report.boundary}

Overall status: ${report.status}

Evidence manifest: ${report.evidenceManifestPath || "n/a"}

This report treats ScopeLease as a scoped-delegation layer. It does not claim provider billing savings or human fatigue reduction.

## Evidence Sources

| Source | Type | Path / Status |
| --- | --- | --- |
| Task manifest | ${sources.tasks ? "task_manifest" : "not_provided"} | ${sources.tasks?.path || "n/a"} |
| Product-wide token evidence | ${sources.productWide?.type || "not_measured"} | ${sources.productWide?.path || sources.productWide?.status || "n/a"} |
| Review frontier | ${sources.reviewFrontier?.type || "not_measured"} | ${sources.reviewFrontier ? `${sources.reviewFrontier.passedTasks}/${sources.reviewFrontier.measuredTasks} pass` : "n/a"} |
| Permission fixture | ${sources.permissionFixture?.type || "not_measured"} | ${sources.permissionFixture?.path || "n/a"} |
| Controlled C0-C3 ablation | ${sources.controlledAblation?.type || "not_measured"} | ${sources.controlledAblation ? `${sources.controlledAblation.rowCount} rows` : "n/a"} |

## Evaluation Configuration

| Setting | Value |
| --- | --- |
| budget | ${report.evaluationConfig?.budget ?? "n/a"} |
| baselineMode | ${report.evaluationConfig?.baselineMode || "default"} |
| maxReviewFiles | ${report.evaluationConfig?.maxReviewFiles ?? "default"} |
| maxFrontierFiles | ${report.evaluationConfig?.maxFrontierFiles ?? "default"} |
| maxTerms | ${report.evaluationConfig?.maxTerms ?? "default"} |
| boundary | ${report.evaluationConfig?.boundary || "n/a"} |

## Status

| Axis | Status | Boundary |
| --- | --- | --- |
| Task completion | ${axes.A_taskCompletion?.status} | ${axes.A_taskCompletion?.boundary} |
| Context/call reduction | ${axes.B_contextAndCallReduction?.status} | paired metrics and review proxy are separated |
| Permission delegation | ${axes.C_permissionDelegation?.status} | ${axes.C_permissionDelegation?.boundary} |
| Review boundary quality | ${axes.D_reviewBoundaryQuality?.status} | ${axes.D_reviewBoundaryQuality?.boundary} |
| Silent failure trajectory | ${axes.E_silentFailureTrajectory?.status} | ${axes.E_silentFailureTrajectory?.boundary} |
| Human supervision | ${axes.F_humanSupervision?.status} | ${axes.F_humanSupervision?.boundary} |
| Ablation | ${axes.G_ablationDesign?.status} | ${axes.G_ablationDesign?.boundary || "C0/C1/C2/C3"} |

## Token And Call Boundary

| Source | Status | Default | ScopeLease | Delta | Saved |
| --- | --- | ---: | ---: | ---: | ---: |
| Observed agent-visible pairs | ${token.observedAgentVisiblePairs?.status} | ${token.observedAgentVisiblePairs?.defaultTokens || 0} | ${token.observedAgentVisiblePairs?.scopeleaseTokens || 0} | ${token.observedAgentVisiblePairs?.savedTokens || 0} | ${token.observedAgentVisiblePairs?.savedPercent ?? "n/a"}% |
| Command-reported total tokens | ${token.commandReportedTotalTokens?.status} | ${token.commandReportedTotalTokens?.defaultTokens || 0} | ${token.commandReportedTotalTokens?.scopeleaseTokens || 0} | ${token.commandReportedTotalTokens?.savedTokens || 0} | ${token.commandReportedTotalTokens?.savedPercent ?? "n/a"}% |
| Review file-read proxy | ${token.reviewFrontierFileReadProxy?.status} | ${token.reviewFrontierFileReadProxy?.defaultTokens || 0} | ${token.reviewFrontierFileReadProxy?.scopeleaseTokens || 0} | ${token.reviewFrontierFileReadProxy?.savedTokens || 0} | ${token.reviewFrontierFileReadProxy?.savedPercent ?? "n/a"}% |

Review file-read proxy calls: ${token.reviewFrontierFileReadProxy?.defaultCalls || 0} -> ${token.reviewFrontierFileReadProxy?.scopeleaseCalls || 0}, saved ${token.reviewFrontierFileReadProxy?.callSavedPercent ?? "n/a"}%.

## Claim Metric Boundaries

| Metric | Status | Claimable Meaning | Not Claimable |
| --- | --- | --- | --- |
${renderClaimMetricBoundaryRows(report.claimMetricBoundaries)}

## Review Frontier Rank Quality

Boundary: ${rank.boundary || "not_measured"}

| Metric | Value |
| --- | ---: |
| measured tasks | ${rank.measuredTasks ?? "n/a"} |
| total critical files | ${rank.totalCriticalFiles ?? "n/a"} |
| missing critical files | ${rank.missingCriticalFiles ?? "n/a"} |
| median first critical rank | ${rank.medianFirstCriticalRank ?? "n/a"} |
| median critical-file rank | ${rank.medianCriticalFileRank ?? "n/a"} |
| median files above first critical | ${rank.medianFilesAboveFirstCritical ?? "n/a"} |
| task top-5 hit rate | ${rank.taskHitRatePercent?.top5 ?? "n/a"}% |
| critical-file recall@10 | ${rank.criticalFileRecallAtKPercent?.top10 ?? "n/a"}% |

## Permission Confusion Summary

Boundary: ${confusion.boundary || "not_measured"}

| Metric | Value |
| --- | ---: |
| expected allow | ${confusion.counts?.expectedAllow ?? "n/a"} |
| expected ask | ${confusion.counts?.expectedAsk ?? "n/a"} |
| expected deny | ${confusion.counts?.expectedDeny ?? "n/a"} |
| unsafe false allow | ${confusion.counts?.unsafeFalseAllow ?? "n/a"} |
| false block | ${confusion.counts?.falseBlock ?? "n/a"} |
| false deny | ${confusion.counts?.falseDeny ?? "n/a"} |
| mismatches | ${confusion.counts?.mismatches ?? "n/a"} |

## Controlled C0-C3 Ablation

Boundary: ${report.controlledAblation?.boundary || "not_measured"}

Controlled boundary pass is a mechanism-level pass/fail result. It is not live agent task completion.

| Condition | Boundary pass | Live completion | Files | Tokens | Unsafe | Escalation | Prompts | Lease hits | Silent failures |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${renderAblationRows(ablation.byCondition)}

C3 vs C0 file reduction: ${ablation.deltas?.C3_vs_C0?.visibleFileReductionPercent ?? "n/a"}%.
C3 vs C0 token proxy reduction: ${ablation.deltas?.C3_vs_C0?.visibleTokenReductionPercent ?? "n/a"}%.
C3 vs C0 unsafe-call reduction: ${ablation.deltas?.C3_vs_C0?.unsafeCallReductionPercent ?? "n/a"}%.

## Safe Claims

${report.claimPolicy.allowed.map((item) => `- ${item}`).join("\n")}

## Do Not Claim

${report.claimPolicy.forbidden.map((item) => `- ${item}`).join("\n")}

## Next Evidence

${report.nextEvidence.map((item) => `- ${item}`).join("\n")}
`;
}

function renderClaimMetricBoundaryRows(boundaries = {}) {
  return Object.entries(boundaries || {}).map(([name, value]) => {
    const cannot = Array.isArray(value.cannotClaim) ? value.cannotClaim.join("; ") : "";
    return `| ${name} | ${value.status || "n/a"} | ${value.canClaim || "n/a"} | ${cannot || "n/a"} |`;
  }).join("\n");
}

function renderAblationRows(byCondition = {}) {
  const order = ["C0", "C1", "C2", "C3"];
  return order.map((id) => {
    const row = byCondition?.[id] || {};
    return `| ${id} | ${row.controlledBoundaryPassed ?? row.passed ?? 0}/${row.rows || 0} | ${row.liveTaskCompletion || "not_measured"} | ${row.visibleFiles || 0} | ${row.visibleTokens || 0} | ${row.unsafeCalls || 0} | ${row.escalationErrors || 0} | ${row.humanPrompts || 0} | ${row.leaseHits || 0} | ${row.silentFailureCount || 0} |`;
  }).join("\n");
}

function findLatestPermissionFixtureRun(root) {
  const runsDir = path.join(root, ".scopelease", "fixtures", "runs");
  if (!fs.existsSync(runsDir)) return null;
  const candidates = [];
  for (const name of fs.readdirSync(runsDir)) {
    const summaryPath = path.join(runsDir, name, "summary.json");
    if (!fs.existsSync(summaryPath)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
      candidates.push({
        name,
        summaryPath,
        summary: raw.summary || raw,
        raw,
        mtimeMs: fs.statSync(summaryPath).mtimeMs
      });
    } catch {}
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0] || null;
}

function readPermissionRun(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  const raw = JSON.parse(fs.readFileSync(resolved, "utf8"));
  return {
    name: path.basename(path.dirname(resolved)),
    summaryPath: resolved,
    summary: raw.summary || raw,
    raw
  };
}

function resolveTasksPath(root, value = "") {
  if (!value) return "";
  const candidate = path.isAbsolute(value) ? value : path.resolve(root, value);
  if (fs.existsSync(candidate)) return candidate;
  return path.resolve(value);
}

function loadFrozenProductWideSummary(root, value = "") {
  if (!value) return null;
  const resolved = path.isAbsolute(value) ? value : path.resolve(root, value);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Product-wide summary file not found: ${resolved}`);
  }
  const summary = JSON.parse(fs.readFileSync(resolved, "utf8"));
  return {
    path: resolved,
    summary
  };
}

function timestampId() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}

function numericOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
