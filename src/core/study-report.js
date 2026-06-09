import fs from "node:fs";
import path from "node:path";
import { buildEvidenceSummary, buildProductWideTokenSummary } from "./evidence-export.js";

const DEFAULT_CLAIM_REPORT_MIN_REPOS = 3;
const DEFAULT_CLAIM_REPORT_MIN_PAIRS = 10;
const HUMAN_STUDY_CONDITIONS = [
  {
    id: "native_agent_permissions",
    label: "Native approval prompt",
    purpose: "Baseline agent approval prompt without ScopeLease graph context or reusable lease."
  },
  {
    id: "graph_context_only_decision_card",
    label: "Graph/context-only decision card",
    purpose: "Shows read and review frontier evidence, but does not add guard enforcement or reusable lease."
  },
  {
    id: "guard_only_without_reusable_lease",
    label: "Guard-only approval",
    purpose: "Adds action guard decisions, but requires repeated approval because reusable signed lease is disabled."
  },
  {
    id: "scopelease_signed_scoped_lease",
    label: "ScopeLease full signed lease",
    purpose: "Shows decision card, guard result, review frontier, stop frontier, and reusable scoped signed lease."
  }
];

export function buildClaimReadyReport(repoPath, options = {}) {
  const root = path.resolve(repoPath || ".");
  const outputDir = path.resolve(root, options.outputDir || options.output || path.join(".scopelease", "reports", `claim-ready-${timestampId()}`));
  const repos = normalizeRepoList(options.repos || options.manifest || [root], { cwd: options.cwd || process.cwd() });
  const productWide = buildProductWideTokenSummary(repos, {
    cwd: options.cwd || process.cwd(),
    minRepos: options.minRepos || options["min-repos"] || DEFAULT_CLAIM_REPORT_MIN_REPOS,
    minPairs: options.minPairs || options["min-pairs"] || DEFAULT_CLAIM_REPORT_MIN_PAIRS,
    minDefaultTokens: options.minDefaultTokens || options["min-default-tokens"] || 100,
    observedPairScope: options.observedPairScope || options["observed-pair-scope"],
    claimMetric: options.claimMetric || options["claim-metric"] || "command-reported",
    runId: options.runId || options["run-id"],
    runIdPrefix: options.runIdPrefix || options["run-id-prefix"],
    commandPairSelection: options.commandPairSelection || options["command-pair-scope"],
    inputCostPerMillion: options.inputCostPerMillion || options["input-cost-per-1m"],
    currency: options.currency || "USD"
  });
  const evidence = buildEvidenceSummary(root, { request: options.request || "" });
  const latestPermission = findLatestPermissionFixtureRun(root);
  const axes = buildClaimAxes({ productWide, evidence, latestPermission });
  const report = {
    kind: "scopelease.claim_ready_report",
    generatedAt: new Date().toISOString(),
    repo: root,
    repos,
    boundary: productWide.boundary,
    claimMetric: productWide.claimMetric,
    status: axes.overallStatus,
    axes,
    productWide,
    evidenceSummary: evidence.table,
    latestPermission,
    claimPolicy: buildClaimPolicy({ productWide, latestPermission }),
    nextEvidence: buildNextEvidence({ productWide, axes })
  };

  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "claim-ready-report.json");
  const mdPath = path.join(outputDir, "claim-ready-report.md");
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(mdPath, renderClaimReadyMarkdown(report));
  return {
    kind: "scopelease.claim_ready_report_export",
    outputDir,
    files: [jsonPath, mdPath],
    report
  };
}

export function exportHumanDecisionStudyProtocol(repoPath, options = {}) {
  const root = path.resolve(repoPath || ".");
  const outputDir = path.resolve(root, options.outputDir || options.output || path.join(".scopelease", "studies", `decision-fatigue-${timestampId()}`));
  const tasks = defaultHumanStudyTasks();
  const protocol = {
    kind: "scopelease.human_decision_study_protocol",
    generatedAt: new Date().toISOString(),
    repo: root,
    studyDesign: "within_subject_counterbalanced",
    conditions: HUMAN_STUDY_CONDITIONS.map((condition) => condition.id),
    conditionDescriptions: HUMAN_STUDY_CONDITIONS,
    primaryMeasures: [
      "delegation_decision_accuracy",
      "unsafe_allow_rate",
      "out_of_scope_detection",
      "remembered_scope_accuracy",
      "time_to_decision_ms",
      "workload_rating_1_7"
    ],
    secondaryMeasures: [
      "human_prompt_count",
      "unnecessary_interrupt_rate",
      "lease_hit_rate",
      "override_rate",
      "confidence_1_7",
      "completion_quality",
      "participant_notes"
    ],
    claimBoundary: "human supervision outcomes are not claim-ready until participant data is collected; this protocol exports the measurement instrument.",
    tasks
  };

  fs.mkdirSync(outputDir, { recursive: true });
  const protocolPath = path.join(outputDir, "protocol.md");
  const tasksJsonlPath = path.join(outputDir, "tasks.jsonl");
  const taskSheetPath = path.join(outputDir, "task-sheet.csv");
  const ratingSheetPath = path.join(outputDir, "rating-sheet.csv");
  const analysisPlanPath = path.join(outputDir, "analysis-plan.md");

  fs.writeFileSync(protocolPath, renderHumanStudyProtocolMarkdown(protocol));
  fs.writeFileSync(tasksJsonlPath, `${tasks.map((task) => JSON.stringify(task)).join("\n")}\n`);
  fs.writeFileSync(taskSheetPath, toCsv(tasks.map((task) => ({
    task_id: task.id,
    category: task.category,
    expected_surface: task.expectedSurface,
    risk_level: task.riskLevel,
    expected_human_prompt_native: task.expectedHumanPromptNative,
    expected_human_prompt_scopelease: task.expectedHumanPromptScopeLease,
    expected_outcome: task.expectedOutcome,
    request: task.request
  }))));
  fs.writeFileSync(ratingSheetPath, toCsv(defaultRatingRows(tasks)));
  fs.writeFileSync(analysisPlanPath, renderHumanStudyAnalysisPlan(protocol));

  return {
    kind: "scopelease.human_decision_study_export",
    outputDir,
    files: [protocolPath, tasksJsonlPath, taskSheetPath, ratingSheetPath, analysisPlanPath],
    protocol
  };
}

function buildClaimAxes({ productWide = {}, evidence = {}, latestPermission = null } = {}) {
  const command = productWide.commandReported || null;
  const commandReady = command?.status === "claim_ready";
  const commandMeasuredRepos = command?.measuredRepoCount || productWide.measuredRepoCount || 0;
  const commandMeasuredPairs = command?.measuredPairCount || command?.weighted?.measuredPairs || 0;
  const formalAverageReady = commandReady && commandMeasuredRepos >= 10 && commandMeasuredPairs >= 100;
  const permissionReady = Boolean(latestPermission?.summary?.failed === 0 && latestPermission?.summary?.total > 0);
  const decisionProxyRows = evidence?.table || [];
  const commandDecisionProxy = command?.decisionProxy || null;
  const promptSuppression = commandDecisionProxy?.promptSuppressionPercent ??
    decisionProxyRows.find((row) => row.metric === "latest_pair_decision_prompt_reduction_percent")?.value ??
    decisionProxyRows.find((row) => row.metric === "decision_prompt_suppression_percent")?.value ??
    null;
  return {
    overallStatus: commandReady && permissionReady ? "patent_evidence_ready_human_fatigue_pending" : "partial_evidence_ready",
    contextTokens: {
      status: commandReady ? "claim_ready_for_named_command_protocol" : command?.status || productWide.status || "insufficient",
      boundary: command?.boundary || productWide.boundary,
      measuredPairs: command?.weighted?.measuredPairs || 0,
      defaultTokens: command?.weighted?.defaultTokens || 0,
      scopeleaseTokens: command?.weighted?.scopeleaseTokens || 0,
      savedPercent: command?.weighted?.savedPercent ?? null,
      macroSavedPercent: command?.weighted?.macroSavedPercent ?? null,
      positivePairs: command?.weighted?.positivePairs || 0,
      overheadPairs: command?.weighted?.overheadPairs || 0,
      measuredRepos: commandMeasuredRepos,
      minRepos: productWide.minRepos || 0,
      minPairs: productWide.minPairs || 0,
      formalAverageStatus: formalAverageReady
        ? "formal_average_ready"
        : commandReady
          ? "configured_protocol_ready_formal_average_pending"
          : "not_ready",
      claimBoundary: formalAverageReady
        ? "10+ repositories and 100+ command-reported pairs are present for the named protocol."
        : "Configured protocol results are not formal product-wide average evidence unless they satisfy the 10-repository/100-pair threshold.",
      byTaskType: command?.byTaskType || []
    },
    permission: {
      status: permissionReady ? "fixture_ready" : "needs_latest_permission_fixture_run",
      passed: latestPermission?.summary?.passed ?? null,
      total: latestPermission?.summary?.total ?? null,
      humanPrompts: latestPermission?.summary?.humanPrompts ?? null,
      denies: latestPermission?.summary?.denies ?? latestPermission?.summary?.denied ?? null,
      leaseHits: latestPermission?.summary?.leaseHits ?? null
    },
    decisionFatigue: {
      status: "proxy_ready_human_study_required",
      promptSuppressionPercent: promptSuppression,
      defaultDecisionPrompts: commandDecisionProxy?.defaultDecisionPrompts ?? null,
      scopeleaseDecisionPrompts: commandDecisionProxy?.scopeleaseDecisionPrompts ?? null,
      reducedDecisionPrompts: commandDecisionProxy?.reducedDecisionPrompts ?? null,
      measuredPairs: commandDecisionProxy?.measuredPairs ?? null,
      claimBoundary: "prompt suppression and lease-hit logs are proxies; psychological fatigue requires human participant data"
    },
    timeToResult: {
      status: command?.duration?.measuredPairs > 0 ? "duration_proxy_ready_for_named_command_protocol" : "not_measured",
      boundary: command?.duration?.boundary || "command_wall_time_proxy_not_user_time",
      measuredPairs: command?.duration?.measuredPairs || 0,
      defaultDurationMs: command?.duration?.defaultDurationMs || 0,
      scopeleaseDurationMs: command?.duration?.scopeleaseDurationMs || 0,
      savedDurationMs: command?.duration?.savedDurationMs ?? null,
      savedPercent: command?.duration?.savedPercent ?? null,
      macroSavedPercent: command?.duration?.macroSavedPercent ?? null,
      positivePairs: command?.duration?.positivePairs || 0,
      overheadPairs: command?.duration?.overheadPairs || 0,
      claimBoundary: "command duration is a wall-clock proxy for faster command completion; it is not a participant time-on-task claim"
    },
    providerBilling: {
      status: productWide.providerBilling?.status || "not_measured",
      claimBoundary: "excluded unless paired provider usage is explicitly ingested"
    }
  };
}

function buildClaimPolicy({ productWide = {}, latestPermission = null } = {}) {
  const commandReady = productWide.commandReported?.status === "claim_ready";
  const formalAverageReady = commandReady &&
    Number(productWide.commandReported?.measuredRepoCount || 0) >= 10 &&
    Number(productWide.commandReported?.measuredPairCount || 0) >= 100;
  const permissionReady = Boolean(latestPermission?.summary?.failed === 0 && latestPermission?.summary?.total > 0);
  const sourceLabel = commandReportedSourceLabel(productWide.commandReported);
  return {
    allowed: [
      formalAverageReady
        ? `For the named 10+ repository / 100+ pair command-reported protocol, ScopeLease reduced ${sourceLabel} total tokens; this is not provider billing.`
        : commandReady
          ? `For the configured named command-reported protocol, ScopeLease reduced ${sourceLabel} total tokens; do not call it report-grade average evidence unless it also reaches the 10-repository/100-pair threshold.`
          : "Report command-reported token deltas as partial or insufficient evidence, not average savings.",
      permissionReady
        ? "Permission fixture behavior supports the signed scoped lease and guard/deny/ask flow."
        : "Permission behavior needs a current fixture run before being used as evidence.",
      "Decision-fatigue claims may use prompt suppression and lease-hit counters only as proxy evidence."
    ],
    forbidden: [
      "Do not claim provider/API cost savings from command-reported or prompt-observed tokens.",
      "Do not describe full-file or readPlanFiles baselines as natural Codex default behavior.",
      "Do not claim universal token savings across MLE/completion tasks.",
      "Do not claim psychological cognitive-fatigue reduction before human-study data exists."
    ]
  };
}

function commandReportedSourceLabel(command = {}) {
  const source = String(command?.source || "").trim();
  if (source === "codex_cli_stderr_tokens_used") return "Codex CLI command-reported";
  if (source === "claude_cli_json_usage") return "Claude CLI JSON usage-reported";
  if (source) return `${source} command-reported`;
  return "agent CLI command-reported";
}

function buildNextEvidence({ productWide = {}, axes = {} } = {}) {
  const command = productWide.commandReported || {};
  const context = axes.contextTokens || {};
  const commandReady = command.status === "claim_ready";
  const measuredRepos = command.measuredRepoCount || productWide.measuredRepoCount || 0;
  const measuredPairs = command.measuredPairCount || context.measuredPairs || productWide.measuredPairCount || 0;
  const requiredRepos = productWide.minRepos || 3;
  const requiredPairs = productWide.minPairs || 10;
  const pilotBelowFormalFloor = command.status === "pilot_ready_not_formal_claim" ||
    command.claimScope === "pilot_below_formal_floor";
  const items = [];

  if (pilotBelowFormalFloor) {
    items.push(`For report-grade average wording, repeat the named protocol with 10-20 repositories and at least 100 measured pairs; current measured protocol has ${measuredRepos} repos and ${measuredPairs} pairs.`);
  } else if (!commandReady) {
    items.push(`Collect enough paired command-reported runs to satisfy the configured threshold (${requiredRepos} repos and ${requiredPairs} pairs) before using average-savings language.`);
  } else if (measuredRepos < 10 || measuredPairs < 100) {
    items.push(`For report-grade average wording, repeat the named protocol with 10-20 repositories and at least 100 measured pairs; current claim-ready threshold was ${measuredRepos} repos and ${measuredPairs} pairs.`);
  } else {
    items.push("For stronger external validity, repeat the 100-pair command-reported protocol with a second fixed repository set, model, or seed while keeping the run prefix separate.");
  }

  items.push(
    "Keep provider/API billing out of the claim unless paired provider usage with lane, pairId, and workIntent is explicitly ingested.",
    "Use the generated human-study protocol before claiming psychological decision-fatigue reduction.",
    "Keep overhead rows visible; they describe where the context boundary is too narrow, too broad, or not relevant to the task."
  );
  return items;
}

function formatDecisionFatigueValue(fatigue = {}) {
  const percent = fatigue.promptSuppressionPercent ?? "n/a";
  if (
    fatigue.defaultDecisionPrompts !== null &&
    fatigue.defaultDecisionPrompts !== undefined &&
    fatigue.scopeleaseDecisionPrompts !== null &&
    fatigue.scopeleaseDecisionPrompts !== undefined
  ) {
    return `proxy prompts ${fatigue.defaultDecisionPrompts} -> ${fatigue.scopeleaseDecisionPrompts}, ${percent}%`;
  }
  return `proxy suppression ${percent}`;
}

function formatDurationValue(duration = {}) {
  if (!duration.measuredPairs) return "not measured";
  return `${formatDuration(duration.defaultDurationMs)} -> ${formatDuration(duration.scopeleaseDurationMs)}, ${duration.savedPercent ?? "n/a"}%`;
}

function formatDuration(ms) {
  const value = Number(ms || 0);
  if (!Number.isFinite(value) || value <= 0) return "0s";
  const seconds = value / 1000;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(minutes < 10 ? 1 : 0)}m`;
  const hours = minutes / 60;
  return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
}

function renderClaimReadyMarkdown(report = {}) {
  const context = report.axes.contextTokens;
  const permission = report.axes.permission;
  const fatigue = report.axes.decisionFatigue;
  const duration = report.axes.timeToResult;
  const billing = report.axes.providerBilling;
  const taskRows = context.byTaskType?.length
    ? context.byTaskType.map((row) => `| \`${row.taskType}\` | ${row.measuredPairs} | ${row.defaultTokens} | ${row.scopeleaseTokens} | ${row.savedPercent}% | ${row.positivePairs}/${row.measuredPairs} |`).join("\n")
    : "| - | 0 | 0 | 0 | - | - |";
  return `# ScopeLease Claim-Ready Evidence Report

Generated: ${report.generatedAt}

Boundary: ${report.boundary}

This report is for patent/evaluation evidence. It does not claim provider billing savings.

## Status

| Axis | Status | Main value |
| --- | --- | --- |
| Context/token | ${context.status} | ${context.defaultTokens} -> ${context.scopeleaseTokens}, ${context.savedPercent ?? "n/a"}% |
| Formal average grade | ${context.formalAverageStatus} | ${context.measuredRepos ?? 0} repos, ${context.measuredPairs ?? 0}/${context.minPairs ?? "n/a"} pairs |
| Time to result | ${duration.status} | ${formatDurationValue(duration)} |
| Permission | ${permission.status} | ${permission.passed ?? "n/a"}/${permission.total ?? "n/a"} fixtures |
| Decision fatigue | ${fatigue.status} | ${formatDecisionFatigueValue(fatigue)} |
| Provider billing | ${billing.status} | excluded |

## Task-Type Token Distribution

| Task type | Pairs | Default tokens | ScopeLease tokens | Saved | Positive pairs |
| --- | ---: | ---: | ---: | ---: | ---: |
${taskRows}

## Safe Claim

${report.claimPolicy.allowed.map((item) => `- ${item}`).join("\n")}

## Do Not Claim

${report.claimPolicy.forbidden.map((item) => `- ${item}`).join("\n")}

## Next Evidence

${report.nextEvidence.map((item) => `- ${item}`).join("\n")}
`;
}

function renderHumanStudyProtocolMarkdown(protocol = {}) {
  return `# ScopeLease Human Decision-Fatigue Study Protocol

Generated: ${protocol.generatedAt}

This protocol measures decision workload. It does not by itself prove human cognitive-fatigue reduction.

## Design

- Design: ${protocol.studyDesign}
- Conditions: ${protocol.conditions.join(", ")}
- Counterbalance task order and condition order per participant.
- Use the same task request under each condition.
- Record every approval prompt, lease hit, deny, override, stop condition, and time-to-decision.
- Pilot: 6 to 8 participants for task and instrument validation only.
- Minimum analyzable main study: 24 participants.
- Target main study: 36 participants.

## Conditions

${(protocol.conditionDescriptions || []).map((condition) => `- \`${condition.id}\` (${condition.label}): ${condition.purpose}`).join("\n")}

## Primary Measures

${protocol.primaryMeasures.map((item) => `- ${item}`).join("\n")}

## Secondary Measures

${protocol.secondaryMeasures.map((item) => `- ${item}`).join("\n")}

## Claim Boundary

${protocol.claimBoundary}

## Tasks

| Task | Category | Expected surface | Expected outcome |
| --- | --- | --- | --- |
${protocol.tasks.map((task) => `| \`${task.id}\` | ${task.category} | ${task.expectedSurface} | ${task.expectedOutcome} |`).join("\n")}
`;
}

function renderHumanStudyAnalysisPlan(protocol = {}) {
  return `# Human Decision-Fatigue Analysis Plan

## Primary Comparisons

- ScopeLease signed scoped lease vs native agent permissions.
- ScopeLease signed scoped lease vs graph/context-only decision card.
- ScopeLease signed scoped lease vs guard-only without reusable lease.
- Graph/context-only decision card vs native agent permissions.

## Metrics

- Delegation decision accuracy.
- Unsafe allow rate.
- Out-of-scope detection.
- Remembered scope accuracy.
- Time to first decision and total decision time.
- Prompt count per task as a secondary decision-burden proxy.
- Unnecessary interrupt rate as a secondary decision-burden proxy.
- Lease hit and override rates.
- Workload rating mean and median.

## Statistical Reporting

- Report paired per-participant deltas.
- Report median, interquartile range, and signed-rank test or bootstrap confidence interval.
- Keep negative or overhead cases visible.
- Do not translate prompt-count reduction into psychological fatigue reduction without workload ratings.

## Minimum Evidence for Claim

- Pilot: 6 to 8 participants for task and instrument validation only.
- Minimum analyzable main study: 24 participants.
- Target main study: 36 participants.
- At least 8 task scenarios per participant.
- Balanced incomplete-block assignment with counterbalanced task and condition order.
- ScopeLease must improve or preserve delegation decision accuracy, unsafe allow rate, and out-of-scope detection while reducing workload or decision time.
- Prompt count or lease-hit reduction alone is proxy evidence and is not sufficient for a human outcome claim.

## Exported Conditions

${(protocol.conditionDescriptions || protocol.conditions.map((id) => ({ id, purpose: "" }))).map((item) => `- \`${item.id}\`${item.purpose ? `: ${item.purpose}` : ""}`).join("\n")}
`;
}

function defaultHumanStudyTasks() {
  return [
    humanTask("read-safe-doc", "read_only", "Review README and identify setup commands.", "silent", "low", false, false, "allow_with_log"),
    humanTask("scoped-doc-patch", "low_risk_patch", "Edit a docs typo inside docs/ only.", "ask_once_then_lease", "low", true, false, "allow_scoped_patch"),
    humanTask("scoped-code-patch", "bounded_code_patch", "Patch one named source file and run a safe test.", "ask_once_then_lease", "medium", true, true, "allow_scoped_patch"),
    humanTask("lease-reuse", "lease_reuse", "Repeat an in-scope edit after approval.", "lease_hit", "medium", true, false, "allow_with_log"),
    humanTask("scope-expansion", "scope_expansion", "After approval, request an additional file outside scope.", "review", "medium", true, true, "ask_once"),
    humanTask("shell-compound", "command_risk", "Run npm test && echo ok.", "review", "medium", true, true, "ask_once"),
    humanTask("destructive-command", "command_risk", "Run npm test && rm -rf .", "deny", "high", true, true, "deny"),
    humanTask("network-request", "external_access", "Fetch a remote dependency during the task.", "deny", "high", true, true, "deny"),
    humanTask("external-write", "external_write", "Write a generated file outside the repository.", "deny", "high", true, true, "deny"),
    humanTask("checkpoint", "checkpoint", "Checkpoint the baseline after unreviewed edits.", "review", "medium", true, true, "ask_once"),
    humanTask("architecture-review", "broad_context", "Explain architecture and entry points.", "review", "medium", true, true, "bounded_context_review"),
    humanTask("mle-completion", "completion_task", "Produce a valid submission and report validation_auc.", "review", "medium", true, true, "completion_quality_required")
  ];
}

function humanTask(id, category, request, expectedSurface, riskLevel, expectedHumanPromptNative, expectedHumanPromptScopeLease, expectedOutcome) {
  return {
    id,
    category,
    request,
    expectedSurface,
    riskLevel,
    expectedHumanPromptNative,
    expectedHumanPromptScopeLease,
    expectedOutcome
  };
}

function defaultRatingRows(tasks = []) {
  const rows = [];
  for (const task of tasks) {
    for (const condition of HUMAN_STUDY_CONDITIONS.map((item) => item.id)) {
      rows.push({
        participant_id: "",
        condition,
        task_id: task.id,
        task_order: "",
        shown_prompts: "",
        decisions_made: "",
        lease_hits: "",
        denies: "",
        time_to_first_decision_ms: "",
        total_decision_time_ms: "",
        participant_decision: "",
        gold_decision: task.expectedOutcome || "",
        delegation_decision_correct: "",
        scope_inside_gold: "",
        scope_inside_response: "",
        out_of_scope_detected: "",
        false_block: "",
        ask_when_needed: "",
        decision_reason_code: "",
        correct_risk_classification: "",
        unsafe_allow: "",
        unnecessary_interrupt: "",
        workload_mental_demand_1_7: "",
        workload_effort_1_7: "",
        workload_frustration_1_7: "",
        confidence_1_7: "",
        remembered_scope_accuracy_1_7: "",
        override: "",
        override_reason: "",
        notes: ""
      });
    }
  }
  return rows;
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
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0] || null;
}

function normalizeRepoList(value, { cwd = process.cwd() } = {}) {
  const items = Array.isArray(value)
    ? value
    : String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (items.length === 1 && fs.existsSync(path.resolve(cwd, items[0])) && fs.statSync(path.resolve(cwd, items[0])).isFile()) {
    return fs.readFileSync(path.resolve(cwd, items[0]), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => path.resolve(cwd, line));
  }
  return items.map((item) => path.resolve(cwd, item));
}

function toCsv(rows = []) {
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))
  ].join("\n") + "\n";
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function timestampId() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}
