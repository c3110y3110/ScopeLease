#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  analyzeRepository,
  buildAgentInputPayload,
  checkpointRepository,
  emptyFatigueMetrics,
  initRepository,
  loadState,
  measurementModeForState,
  recordActualWork,
  recordDecisionFatigueEvent,
  recordGuardDecision,
  recordModelUsage,
  saveState,
  setMeasurementMode
} from "./analyzer.js";
import { startServer } from "./server.js";
import { approveDecisionBundle, evaluateAgentAction } from "./core/guard.js";
import { readText } from "./fs-utils.js";
import { evaluateBenchTokenSavings } from "./core/bench-evaluator.js";
import { evaluateGraphClaimBench } from "./core/graph-bench.js";
import { evaluateReviewFrontierBench } from "./core/review-bench.js";
import { enforceAgentAction, runGuardedCommand } from "./core/enforcer.js";
import {
  buildEvidenceSummary,
  buildProductWideTokenSummary,
  exportEvidenceBundle,
  exportPermissionFixtureSuite,
  renderPermissionResultsTable,
  renderSummaryTable,
  runPermissionFixtureSuite
} from "./core/evidence-export.js";
import { runAgentPairHarness } from "./core/pair-harness.js";
import { buildClaimReadyReport, exportHumanDecisionStudyProtocol } from "./core/study-report.js";
import { buildConditionMatrixForTasks, loadBenchmarkTaskSpecs } from "./core/benchmark-adapter.js";
import { buildDelegationControlReport } from "./core/delegation-report.js";
import { runControlledAblation } from "./core/ablation-runner.js";
import {
  containsUnsanitizedLocalPath,
  createSourceArchive,
  DEFAULT_SOURCE_ARCHIVE_MAX_BYTES,
  verifySourceArchive
} from "./core/source-archive.js";
import { compareTerminalBenchObservedRuns, summarizeTerminalBenchRun } from "./core/terminal-bench-summary.js";
import { attachScopeLeaseProject, attachScopeLeaseClaudeProject, ensureScopeLeaseApp, ensureScopeLeaseHub } from "./runtime/app-service.js";
import { detectAgentVisibleUsage } from "./runtime/codex-usage-detector.js";
import { startMcpServer } from "./runtime/mcp-server.js";
import { renderDotGraph, renderTerminalGraph, renderTerminalMap, renderTerminalRadial } from "./terminal/graph-renderer.js";
import { startTerminalLive } from "./terminal/live.js";

const [, , command = "help", ...args] = process.argv;
const DEFAULT_DELEGATION_REPORT_DIR = ".scopelease/reports/delegation-control-source-of-truth-20260528";
const DEFAULT_FROZEN_EVIDENCE_DIR = "examples/evaluation/frozen-evidence/delegation-control-source-of-truth-20260528";
const FROZEN_EVIDENCE_FILES = [
  "delegation-control-report.json",
  "delegation-control-report.md",
  "evidence-manifest.json"
];

async function main() {
  const { positionals, options } = parseArgs(args);
  const repo = path.resolve(positionals[0] || options.repo || ".");
  const analysisOptions = analysisOptionsFromCli(options);

  if (command === "help" || command === "--help" || command === "-h" || options.help || options.h) {
    printHelp();
    return;
  }

  if (command === "init") {
    const state = initRepository(repo);
    console.log(`Initialized ScopeLease baseline at ${state.repo}`);
    return;
  }

  if (command === "index") {
    const state = checkpointRepository(repo);
    console.log(`Indexed ${Object.keys(state.index.files).length} files and reset baseline.`);
    return;
  }

  if (command === "checkpoint") {
    const state = checkpointRepository(repo);
    console.log(`Checkpointed ${Object.keys(state.index.files).length} files as the new baseline.`);
    return;
  }

  if (command === "analyze") {
    const analysis = analyzeRepository(repo, analysisOptions);
    console.log(analysis.decisionCard);
    return;
  }

  if (command === "graph") {
    const analysis = analyzeRepository(repo, analysisOptions);
    const format = options.format || "text";
    if (format === "dot") console.log(renderDotGraph(analysis));
    else console.log(renderForView(analysis, options));
    return;
  }

  if (command === "live") {
    const view = options.view || "radial";
    startTerminalLive({
      repoPath: repo,
      interval: Number(options.interval || 1500),
      color: !options["no-color"],
      clear: !options["no-clear"],
      renderer: (analysis, renderOptions) => renderForView(analysis, { ...options, ...renderOptions, view })
    });
    return;
  }

  if (command === "context") {
    const analysis = analyzeRepository(repo, analysisOptions);
    console.log(JSON.stringify(analysis.contextPack, null, 2));
    return;
  }

  if (command === "input" || command === "agent-input") {
    const analysis = analyzeRepository(repo, analysisOptions);
    const payload = buildAgentInputPayload(analysis.contextPack, { userRequest: options.request });
    if (options.format === "prompt" || options.text) console.log(payload.codexInput?.text || "");
    else console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "prompt" || command === "codex-input") {
    const analysis = analyzeRepository(repo, analysisOptions);
    console.log(buildAgentInputPayload(analysis.contextPack, { userRequest: options.request }).codexInput?.text || "");
    return;
  }

  if (command === "guard") {
    const action = await readActionFromInput(options, "guard");
    const analysis = analyzeRepository(repo, analysisOptions);
    const state = loadState(repo) || {};
    const verdict = evaluateAgentAction({ action, analysis, state });
    recordGuardDecision(repo, {
      verdict,
      action,
      request: options.request || "",
      source: "cli:guard",
      workIntent: options["work-intent"] || options.workIntent || options.intent || "",
      pairId: options["pair-id"] || options.pairId || "",
      runId: options["run-id"] || options.runId || ""
    });
    console.log(JSON.stringify(verdict, null, 2));
    process.exitCode = verdict.verdict === "deny" ? 2 : 0;
    return;
  }

  if (command === "approve") {
    const action = await readActionFromInput(options, "approve");
    const analysis = analyzeRepository(repo, analysisOptions);
    const state = loadState(repo) || {};
    const guardVerdict = evaluateAgentAction({ action, analysis, state });
    if (guardVerdict.verdict !== "ask_once" || !guardVerdict.decisionBundle) {
      throw new Error("No current guard decision requires approval for this action.");
    }
    const bundle = guardVerdict.decisionBundle;
    const choiceId = options.choice || options["choice-id"] || options.choiceId || bundle.defaultVerdict;
    const lease = approveDecisionBundle({
      analysis,
      state,
      decisionBundle: bundle,
      choiceId,
      grantedBy: options.by || "human"
    });
    saveState(repo, addApprovalLease(state, lease));
    recordDecisionFatigueEvent(repo, {
      type: "approval_lease_created",
      request: options.request || "",
      source: "cli:approve",
      actor: options.by || "human",
      lease,
      decisionBundleId: bundle.id,
      verdict: guardVerdict.verdict,
      actionGrant: guardVerdict.actionGrant,
      action
    });
    console.log(JSON.stringify({ kind: "scopelease.approval_lease", lease, previousVerdict: guardVerdict }, null, 2));
    return;
  }

  if (command === "enforce" || command === "pretool" || command === "pep") {
    const input = await readEnforcementInput(options);
    const result = enforceAgentAction(repo, {
      ...input,
      budget: Number(options.budget || 8000),
      request: options.request || input.request || "",
      ...graphBackendOptionsFromCli(options),
      source: options.source || input.source || "cli:enforce",
      workIntent: options["work-intent"] || options.workIntent || input.workIntent || "",
      pairId: options["pair-id"] || options.pairId || input.pairId || "",
      runId: options["run-id"] || options.runId || input.runId || ""
    });
    if (options.format === "json") console.log(JSON.stringify(result, null, 2));
    else printEnforcementResult(result);
    process.exitCode = result.exitCode;
    return;
  }

  if (command === "guarded-exec" || command === "exec-guarded") {
    const parsed = parseGuardedExecArgs(args, options);
    const result = runGuardedCommand(parsed.repo || repo, {
      command: parsed.command,
      request: parsed.options.request || "",
      budget: Number(parsed.options.budget || 8000),
      ...graphBackendOptionsFromCli(parsed.options),
      source: "cli:guarded-exec",
      workIntent: parsed.options["work-intent"] || parsed.options.workIntent || "",
      pairId: parsed.options["pair-id"] || parsed.options.pairId || "",
      runId: parsed.options["run-id"] || parsed.options.runId || "",
      stdio: parsed.options.format === "json" ? "pipe" : "inherit"
    });
    if (parsed.options.format === "json") console.log(JSON.stringify(result, null, 2));
    else if (!result.allowed) printEnforcementResult(result);
    process.exitCode = result.exitCode;
    return;
  }

  if (command === "source-zip" || command === "source-archive" || command === "package-source") {
    const result = createSourceArchive(repo, {
      outputPath: options.output || options["output-path"] || options.outputPath || "scopelease_clean_source.zip",
      maxBytes: Number(options["max-bytes"] || options.maxBytes || DEFAULT_SOURCE_ARCHIVE_MAX_BYTES)
    });
    if (options.format === "json") console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`ScopeLease source archive`);
      console.log(`output ${result.output}`);
      console.log(`size ${result.sizeBytes} bytes`);
      console.log(`limit ${result.maxBytes} bytes`);
      console.log(`sanitized files ${result.sanitizedFiles}`);
    }
    return;
  }

  if (command === "verify-source-zip" || command === "source-zip-verify" || command === "verify-source-archive") {
    const result = verifySourceArchive(repo, {
      archivePath: options.output || options["output-path"] || options.outputPath || options.archive || options["archive-path"] || options.archivePath || "scopelease_clean_source.zip",
      maxBytes: Number(options["max-bytes"] || options.maxBytes || DEFAULT_SOURCE_ARCHIVE_MAX_BYTES)
    });
    if (options.format === "json") console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`ScopeLease source archive verify`);
      console.log(`archive ${result.archive}`);
      console.log(`size ${result.sizeBytes} bytes`);
      console.log(`entries ${result.entries}`);
      console.log(`text files checked ${result.textFilesChecked}`);
      console.log(`local path hygiene ${result.ok ? "pass" : "fail"}`);
      for (const leak of result.leaks) console.log(`leak ${leak.where}: ${leak.entry}`);
    }
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "freeze-evidence") {
    const result = freezeEvidenceSnapshot(repo, {
      sourceDir: options.source || options["source-dir"] || options.sourceDir || DEFAULT_DELEGATION_REPORT_DIR,
      targetDir: options.target || options["target-dir"] || options.targetDir || DEFAULT_FROZEN_EVIDENCE_DIR
    });
    if (options.format === "json") console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`ScopeLease frozen evidence update`);
      console.log(`source ${result.sourceDir}`);
      console.log(`target ${result.targetDir}`);
      console.log(`files ${result.copied.length}`);
    }
    return;
  }

  if (command === "verify-frozen" || command === "paper-verify-frozen" || command === "frozen-evidence-verify") {
    const result = verifyFrozenEvidenceSnapshot(repo, {
      targetDir: options.target || options["target-dir"] || options.targetDir || DEFAULT_FROZEN_EVIDENCE_DIR
    });
    if (options.format === "json") console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`ScopeLease frozen evidence verification`);
      console.log(`target ${result.targetDir}`);
      console.log(`status ${result.ok ? "ok" : "mismatch"}`);
      for (const row of result.rows) {
        console.log(`${row.name}: ${row.match ? "ok" : "mismatch"}`);
      }
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "source-truth-check" || command === "evidence-check") {
    const result = checkFrozenEvidenceSourceTruth(repo, {
      sourceDir: options.source || options["source-dir"] || options.sourceDir || DEFAULT_DELEGATION_REPORT_DIR,
      targetDir: options.target || options["target-dir"] || options.targetDir || DEFAULT_FROZEN_EVIDENCE_DIR
    });
    if (options.format === "json") console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`ScopeLease source-of-truth check`);
      console.log(`source ${result.sourceDir}`);
      console.log(`target ${result.targetDir}`);
      console.log(`status ${result.ok ? "ok" : "mismatch"}`);
      for (const row of result.rows) {
        console.log(`${row.name}: ${row.match ? "ok" : "mismatch"}`);
      }
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "digest") {
    const state = loadState(repo) || {};
    console.log(JSON.stringify({
      kind: "scopelease.guard_digest",
      approvalLeases: state.approvalLeases || [],
      fatigueMetrics: state.fatigueMetrics || emptyFatigueMetrics(),
      fatigueEvents: (state.fatigueEvents || []).slice(0, 20),
      actualWorkEvents: (state.actualWorkEvents || []).slice(0, 20),
      guardEvents: (state.guardEvents || []).slice(0, 20)
    }, null, 2));
    return;
  }

  if (command === "fatigue" || command === "record-fatigue") {
    const result = recordDecisionFatigueEvent(repo, {
      type: options.type || options.event || "human_decision_recorded",
      request: options.request || "",
      workIntent: options["work-intent"] || options.workIntent || options.intent || "",
      pairId: options["pair-id"] || options.pairId || "",
      runId: options["run-id"] || options.runId || "",
      actor: options.actor || options.by || "human",
      leaseId: options["lease-id"] || options.leaseId || "",
      label: options.label || "",
      durationMs: options["duration-ms"] || options.durationMs,
      note: options.note || "",
      source: "cli:fatigue"
    });
    console.log(JSON.stringify({ kind: "scopelease.decision_fatigue_recorded", event: result.event }, null, 2));
    return;
  }

  if (command === "measure") {
    const measurement = await readMeasurementFromInput(repo, options);
    const result = recordActualWork(repo, measurement);
    console.log(JSON.stringify({
      kind: "scopelease.actual_work_measurement",
      event: result.event
    }, null, 2));
    return;
  }

  if (command === "measure-mode" || command === "measurement-mode") {
    const action = String(positionals[1] || options.mode || options.action || (options.on ? "on" : options.off ? "off" : "status")).trim().toLowerCase();
    if (["on", "enable", "enabled", "true", "1"].includes(action)) {
      const result = setMeasurementMode(repo, {
        enabled: true,
        source: "cli:measure-mode",
        note: options.note || "Automatic Codex hook and ScopeLease MCP metering enabled."
      });
      console.log(JSON.stringify({ kind: "scopelease.measurement_mode", measurementMode: result.measurementMode }, null, 2));
      return;
    }
    if (["off", "disable", "disabled", "false", "0"].includes(action)) {
      const result = setMeasurementMode(repo, {
        enabled: false,
        source: "cli:measure-mode",
        note: options.note || "Automatic Codex hook and ScopeLease MCP metering disabled."
      });
      console.log(JSON.stringify({ kind: "scopelease.measurement_mode", measurementMode: result.measurementMode }, null, 2));
      return;
    }
    const state = loadState(repo) || {};
    console.log(JSON.stringify({
      kind: "scopelease.measurement_mode",
      measurementMode: measurementModeForState(state),
      actualWorkEvents: (state.actualWorkEvents || []).length,
      mcpContextEvents: (state.mcpContextEvents || []).length
    }, null, 2));
    return;
  }

  if (command === "usage" || command === "usage-ingest") {
    const usage = await readModelUsageFromInput(options);
    const result = recordModelUsage(repo, usage);
    console.log(JSON.stringify({
      kind: "scopelease.model_usage_ingest",
      event: result.event
    }, null, 2));
    return;
  }

  if (command === "agent-usage" || command === "detect-usage" || command === "codex-usage") {
    const state = loadState(repo) || {};
    console.log(JSON.stringify(detectAgentVisibleUsage({
      repoPath: repo,
      state,
      codexHome: options["codex-home"] || options.codexHome || ""
    }), null, 2));
    return;
  }

  if (command === "bench-tokens") {
    const result = evaluateBenchTokenSavings(repo, {
      tasksPath: options.tasks || options["tasks-path"],
      budget: Number(options.budget || 8000),
      baselineMode: options["baseline-mode"] || options.baselineMode || "explicit",
      limit: options.limit
    });
    if (options.format === "json") console.log(JSON.stringify(result, null, 2));
    else printBenchTokenTable(result);
    return;
  }

  if (command === "graph-bench" || command === "codegraph-bench") {
    const result = evaluateGraphClaimBench(repo, {
      tasksPath: options.tasks || options["tasks-path"],
      budget: Number(options.budget || 8000),
      limit: options.limit,
      maxGrepFiles: options["max-grep-files"] || options.maxGrepFiles,
      maxTerms: options["max-terms"] || options.maxTerms
    });
    if (options.format === "json") console.log(JSON.stringify(result, null, 2));
    else printGraphBenchTable(result);
    return;
  }

  if (command === "review-bench" || command === "review-frontier-bench") {
    const result = evaluateReviewFrontierBench(repo, {
      tasksPath: options.tasks || options["tasks-path"],
      budget: Number(options.budget || 8000),
      limit: options.limit,
      baselineMode: options["baseline-mode"] || options.baselineMode,
      maxReviewFiles: options["max-review-files"] || options.maxReviewFiles,
      maxFrontierFiles: options["max-frontier-files"] || options.maxFrontierFiles,
      maxTerms: options["max-terms"] || options.maxTerms
    });
    if (options.format === "json") console.log(JSON.stringify(result, null, 2));
    else printReviewBenchTable(result);
    return;
  }

  if (command === "condition-matrix" || command === "ablation-matrix") {
    const tasksPath = options.tasks || options["tasks-path"];
    const tasks = loadBenchmarkTaskSpecs(tasksPath);
    const result = buildConditionMatrixForTasks(tasks, {
      conditions: options.conditions || options.conditionIds
    });
    if (options.format === "json") console.log(JSON.stringify(result, null, 2));
    else printConditionMatrix(result);
    return;
  }

  if (command === "ablation-run" || command === "controlled-ablation") {
    const result = runControlledAblation(repo, {
      tasksPath: options.tasks || options["tasks-path"],
      budget: Number(options.budget || 8000),
      conditions: options.conditions || options.conditionIds,
      limit: options.limit,
      baselineMode: options["baseline-mode"] || options.baselineMode,
      maxReviewFiles: options["max-review-files"] || options.maxReviewFiles,
      maxFrontierFiles: options["max-frontier-files"] || options.maxFrontierFiles,
      maxTerms: options["max-terms"] || options.maxTerms
    });
    if (options.format === "json") console.log(JSON.stringify(result, null, 2));
    else printControlledAblation(result);
    return;
  }

  if (command === "delegation-report" || command === "trajectory-report") {
    const result = buildDelegationControlReport(repo, {
      cwd: process.cwd(),
      repos: options.repos || options.manifest || [repo],
      tasksPath: options.tasks || options["tasks-path"],
      outputDir: options.output || options["output-dir"],
      budget: Number(options.budget || 8000),
      limit: options.limit,
      minRepos: options["min-repos"] || options.minRepos,
      minPairs: options["min-pairs"] || options.minPairs,
      minDefaultTokens: options["min-default-tokens"] || options.minDefaultTokens,
      observedPairScope: options["observed-pair-scope"] || options.observedPairScope || options.scope,
      claimMetric: options["claim-metric"] || options.claimMetric || "command-reported",
      runId: options["run-id"] || options.runId,
      runIdPrefix: options["run-id-prefix"] || options.runIdPrefix,
      commandPairSelection: options["command-pair-scope"] || options.commandPairScope,
      productWideSummaryPath: options["product-wide-summary"] || options.productWideSummary || options["product-summary"],
      inputCostPerMillion: options["input-cost-per-1m"] || options.inputCostPer1M,
      baselineMode: options["baseline-mode"] || options.baselineMode,
      maxReviewFiles: options["max-review-files"] || options.maxReviewFiles,
      maxFrontierFiles: options["max-frontier-files"] || options.maxFrontierFiles,
      maxTerms: options["max-terms"] || options.maxTerms,
      permissionRunPath: options["permission-run"] || options.permissionRun,
      conditions: options.conditions || options.conditionIds,
      noReview: booleanFlag(options["no-review"])
    });
    if (options.format === "json") console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`ScopeLease delegation-control report`);
      console.log(`status ${result.report.status}`);
      console.log(`output ${result.outputDir}`);
      console.log(`files ${result.files.length}`);
      console.log(`token boundary ${result.report.tokenSavings.headlineBoundary}`);
    }
    return;
  }

  if (command === "terminal-bench-summary" || command === "tbench-summary") {
    const runDir = options.run || options["run-dir"] || options.runDir || args[1];
    if (!runDir) throw new Error("terminal-bench-summary requires --run <terminal-bench-run-dir>.");
    const summary = summarizeTerminalBenchRun(runDir, {
      conditionId: options.condition || options["condition-id"] || options.conditionId || "",
      boundary: options.boundary || "same_prompt_observed_run_not_scopelease_behavior_claim"
    });
    const baselineDir = options.baseline || options["baseline-run"] || options.baselineRun || "";
    const result = baselineDir
      ? {
        summary,
        comparison: compareTerminalBenchObservedRuns(
          summarizeTerminalBenchRun(baselineDir, { conditionId: options["baseline-condition"] || "C0" }),
          summary
        )
      }
      : summary;
    if (options.output) {
      fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
      fs.writeFileSync(path.resolve(options.output), `${JSON.stringify(result, null, 2)}\n`);
    }
    if (options.format === "json" || options.output) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Terminal-Bench observed summary (${summary.boundary})`);
      console.log(`run ${summary.runDir}`);
      console.log(`tasks ${summary.resolved}/${summary.taskCount} resolved`);
      console.log(`command-reported tokens ${formatNumber(summary.totalCommandReportedTokens)}`);
      if (result.comparison) {
        console.log(`delta vs baseline ${formatNumber(result.comparison.tokenDelta.savedTokens)} (${formatPercent(result.comparison.tokenDelta.savedPercent)})`);
      }
    }
    return;
  }

  if (command === "pair-run") {
    const pairOptions = {
      tasksPath: options.tasks || options["tasks-path"],
      budget: Number(options.budget || 8000),
      baselineMode: options["baseline-mode"] || options.baselineMode || "explicit",
      defaultInputMode: options["default-input-mode"] || options.defaultInputMode,
      repetitions: options.repetitions || options.repeat || 1,
      runId: options["run-id"] || options.runId,
      outputDir: options.output || options["output-dir"],
      mode: options.mode,
      contextMode: options["context-mode"] || options.contextMode,
      agentCommand: options["agent-command"] || options.agentCommand,
      defaultCommand: options["default-command"] || options.defaultCommand,
      scopeleaseCommand: options["scopelease-command"] || options.scopeleaseCommand,
      agent: options.agent || options["agent-adapter"],
      defaultAgent: options["default-agent"] || options.defaultAgent,
      scopeleaseAgent: options["scopelease-agent"] || options.scopeleaseAgent,
      agentTemplate: options["agent-template"] || options.agentTemplate,
      defaultAgentTemplate: options["default-agent-template"] || options.defaultAgentTemplate,
      scopeleaseAgentTemplate: options["scopelease-agent-template"] || options.scopeleaseAgentTemplate,
      workspaceMode: options["workspace-mode"] || options.workspaceMode,
      defaultWorkspaceMode: options["default-workspace-mode"] || options.defaultWorkspaceMode,
      scopeleaseWorkspaceMode: options["scopelease-workspace-mode"] || options.scopeleaseWorkspaceMode,
      workspaceScopeLimit: options["workspace-scope-limit"] || options.workspaceScopeLimit,
      workspaceScopeSource: options["workspace-scope-source"] || options.workspaceScopeSource,
      scopeleaseApprovalMode: options["scopelease-approval-mode"] || options.scopeleaseApprovalMode,
      scopeleasePreapprove: booleanFlag(options["scopelease-preapprove"] || options.scopeleasePreapprove),
      scopeleasePreapproveChoice: options["scopelease-preapprove-choice"] || options.scopeleasePreapproveChoice,
      liveObservedCommandMode: options["live-observed-command-mode"] || options.liveObservedCommandMode,
      agentModel: options["agent-model"] || options.agentModel,
      agentProfile: options["agent-profile"] || options.agentProfile,
      agentSandbox: options["agent-sandbox"] || options.agentSandbox,
      liveObserved: booleanFlag(options["live-observed"] || options.liveObserved)
    };
    const copyWorktree = optionalBooleanFlag(options["copy-worktree"]);
    if (copyWorktree !== undefined) pairOptions.copyWorktree = copyWorktree;
    const noCopyWorktree = optionalBooleanFlag(options["no-copy-worktree"]);
    if (noCopyWorktree !== undefined) pairOptions["no-copy-worktree"] = noCopyWorktree;
    const noRecordState = optionalBooleanFlag(options["no-record-state"]);
    if (noRecordState !== undefined) pairOptions["no-record-state"] = noRecordState;
    const result = runAgentPairHarness(repo, pairOptions);
    if (options.format === "json") console.log(JSON.stringify(result, null, 2));
    else printPairRunTable(result);
    return;
  }

  if (command === "evidence" || command === "export-evidence") {
    const result = exportEvidenceBundle(repo, {
      request: options.request || "",
      outputDir: options.output || options["output-dir"]
    });
    if (options.format === "json") console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`ScopeLease evidence export`);
      console.log(`output ${result.outputDir}`);
      console.log(`files ${result.files.length}`);
      console.log(`boundary ${result.summary.boundary}`);
    }
    return;
  }

  if (command === "evidence-summary" || command === "summary-table") {
    const summary = buildEvidenceSummary(repo, { request: options.request || "" });
    if (options.format === "json") console.log(JSON.stringify(summary, null, 2));
    else console.log(renderSummaryTable(summary.table));
    return;
  }

  if (command === "product-wide-summary" || command === "multi-repo-summary") {
    const summary = buildProductWideTokenSummary(options.repos || options.manifest || [repo], {
      cwd: process.cwd(),
      minRepos: options["min-repos"] || options.minRepos || 3,
      minPairs: options["min-pairs"] || options.minPairs || 10,
      minDefaultTokens: options["min-default-tokens"] || options.minDefaultTokens,
      observedPairScope: options["observed-pair-scope"] || options.observedPairScope || options.scope,
      inputCostPerMillion: options["input-cost-per-1m"] ||
        options.inputCostPer1M ||
        options.inputCostPerMillion ||
        options["cost-per-1m"],
      claimMetric: options["claim-metric"] || options.claimMetric || options.metric,
      runId: options["run-id"] || options.runId,
      runIdPrefix: options["run-id-prefix"] || options.runIdPrefix,
      commandPairSelection: options["command-pair-scope"] || options.commandPairScope || options["command-pair-selection"] || options.commandPairSelection,
      currency: options.currency || "USD"
    });
    if (options.format === "json") console.log(JSON.stringify(summary, null, 2));
    else printProductWideSummary(summary);
    return;
  }

  if (command === "claim-report" || command === "claim-ready-report") {
    const result = buildClaimReadyReport(repo, {
      cwd: process.cwd(),
      repos: options.repos || options.manifest || [repo],
      outputDir: options.output || options["output-dir"],
      minRepos: options["min-repos"] || options.minRepos,
      minPairs: options["min-pairs"] || options.minPairs,
      minDefaultTokens: options["min-default-tokens"] || options.minDefaultTokens,
      observedPairScope: options["observed-pair-scope"] || options.observedPairScope || options.scope,
      claimMetric: options["claim-metric"] || options.claimMetric || "command-reported",
      runId: options["run-id"] || options.runId,
      runIdPrefix: options["run-id-prefix"] || options.runIdPrefix,
      commandPairSelection: options["command-pair-scope"] || options.commandPairScope,
      inputCostPerMillion: options["input-cost-per-1m"] || options.inputCostPer1M,
      request: options.request || ""
    });
    if (options.format === "json") console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`ScopeLease claim-ready report`);
      console.log(`status ${result.report.status}`);
      console.log(`output ${result.outputDir}`);
      console.log(`files ${result.files.length}`);
    }
    return;
  }

  if (command === "human-study" || command === "decision-study" || command === "fatigue-study") {
    const result = exportHumanDecisionStudyProtocol(repo, {
      outputDir: options.output || options["output-dir"]
    });
    if (options.format === "json") console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`ScopeLease human decision study protocol`);
      console.log(`output ${result.outputDir}`);
      console.log(`tasks ${result.protocol.tasks.length}`);
      console.log(`files ${result.files.length}`);
    }
    return;
  }

  if (command === "permission-fixtures") {
    if (options.run) {
      const result = runPermissionFixtureSuite(repo, {
        fixturesPath: options.fixtures || options["fixtures-path"],
        outputDir: options.output || options["output-dir"],
        runId: options["run-id"] || options.runId,
        useExistingState: optionalBooleanFlag(options["use-existing-state"]) === true,
        "no-record-state": optionalBooleanFlag(options["no-record-state"]) === true
      });
      if (options.format === "json") console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`ScopeLease permission fixture run`);
        console.log(`fixtures ${result.summary.passed}/${result.summary.total} passed (${formatPercent(result.summary.passRate)})`);
        console.log(`output ${result.outputDir}`);
        console.log("");
        console.log(renderPermissionResultsTable(result.results));
      }
      process.exitCode = result.summary.failed ? 2 : 0;
      return;
    }
    const result = exportPermissionFixtureSuite(repo, {
      output: options.output || options["output-path"]
    });
    if (options.format === "json") console.log(JSON.stringify(result, null, 2));
    else console.log(`Wrote ${result.count} permission fixtures to ${result.outputPath}`);
    return;
  }

  if (command === "card") {
    const analysis = analyzeRepository(repo, analysisOptions);
    console.log(analysis.decisionCard);
    return;
  }

  if (command === "mcp") {
    const mcpWorkIntent = options["work-intent"] || options.workIntent || options.intent || "";
    const mcpPairId = options["pair-id"] || options.pairId || options.pair || "";
    const mcpRunId = options["run-id"] || options.runId || "";
    if (mcpWorkIntent && !process.env.SCOPELEASE_WORK_INTENT) process.env.SCOPELEASE_WORK_INTENT = String(mcpWorkIntent);
    if (mcpPairId && !process.env.SCOPELEASE_PAIR_ID) process.env.SCOPELEASE_PAIR_ID = String(mcpPairId);
    if (mcpRunId && !process.env.SCOPELEASE_RUN_ID) process.env.SCOPELEASE_RUN_ID = String(mcpRunId);
    startMcpServer({ repoPath: repo });
    return;
  }

  if (command === "attach") {
    const agent = String(options.agent || options.preset || "codex").trim().toLowerCase();
    if (["claude", "claude-code", "anthropic-claude"].includes(agent)) {
      const result = attachScopeLeaseClaudeProject({ repoPath: repo });
      console.log(JSON.stringify({
        kind: "scopelease.attach",
        ...result
      }, null, 2));
      return;
    }
    const result = attachScopeLeaseProject({
      repoPath: repo,
      port: options.port,
      enableModelProxy: booleanFlag(options["enable-model-proxy"])
    });
    console.log(JSON.stringify({
      kind: "scopelease.attach",
      ...result
    }, null, 2));
    return;
  }

  if (command === "app" || command === "connect") {
    const result = await ensureScopeLeaseApp({
      repoPath: repo,
      port: options.port,
      scanInterval: Number(options["scan-interval"] || 30000),
      request: options.request || "",
      openBrowser: Boolean(options.open),
      enableModelProxy: booleanFlag(options["enable-model-proxy"])
    });
    console.log(JSON.stringify({
      kind: "scopelease.app",
      ...result
    }, null, 2));
    return;
  }

  if (command === "hub") {
    const result = await ensureScopeLeaseHub({
      repoPath: repo,
      port: Number(options.port || 4030),
      scanInterval: Number(options["scan-interval"] || 30000),
      openBrowser: Boolean(options.open)
    });
    console.log(JSON.stringify({
      kind: "scopelease.hub",
      ...result
    }, null, 2));
    return;
  }

  if (command === "hub-server") {
    startServer({
      repoPath: repo,
      port: Number(options.port || 4030),
      scanInterval: Number(options["scan-interval"] || 30000),
      entry: "graph.html",
      label: "ScopeLease hub",
      userRequest: options.request || "",
      hubMode: true
    });
    return;
  }

  if (command === "view" || command === "visual" || command === "proxy") {
    startServer({
      repoPath: repo,
      port: Number(options.port || 3927),
      scanInterval: Number(options["scan-interval"] || 2500),
      entry: "graph.html",
      label: "ScopeLease graph view",
      userRequest: options.request || "",
      lockRoot: command === "proxy",
      enableModelProxy: booleanFlag(options["enable-model-proxy"])
    });
    return;
  }

  if (command === "dashboard" || command === "watch") {
    startServer({
      repoPath: repo,
      port: Number(options.port || 3927),
      scanInterval: Number(options["scan-interval"] || 2500),
      userRequest: options.request || "",
      enableModelProxy: booleanFlag(options["enable-model-proxy"])
    });
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

function parseArgs(values) {
  const positionals = [];
  const options = {};

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }

    const key = value.replace(/^--/, "");
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }

  return { positionals, options };
}

function analysisOptionsFromCli(options = {}) {
  return {
    budget: Number(options.budget || 8000),
    userRequest: options.request,
    ...graphBackendOptionsFromCli(options)
  };
}

function graphBackendOptionsFromCli(options = {}) {
  const file = options["graph-backend-file"] || options.graphBackendFile || "";
  const name = options["graph-backend"] || options.graphBackend || options.graphBackendName || "";
  const result = {};
  if (name) result.graphBackendName = String(name);
  if (file) {
    if (file === true) throw new Error("--graph-backend-file requires a JSON file path");
    const resolved = path.resolve(String(file));
    result.graphBackendPayload = JSON.parse(fs.readFileSync(resolved, "utf8"));
    result.graphBackendSource = resolved;
    if (!result.graphBackendName) {
      const base = path.basename(resolved, path.extname(resolved)) || path.basename(resolved);
      result.graphBackendName = base || "external_graph";
    }
  }
  return result;
}

function booleanFlag(value) {
  return optionalBooleanFlag(value);
}

function optionalBooleanFlag(value) {
  if (value === undefined) return undefined;
  if (value === true || value === false) return value;
  const text = String(value || "").trim().toLowerCase();
  if (!text) return true;
  if (["1", "true", "yes", "on", "enable", "enabled"].includes(text)) return true;
  if (["0", "false", "no", "off", "disable", "disabled"].includes(text)) return false;
  return true;
}

function printHelp() {
  console.log(`ScopeLease 로컬 결정 레이어

Usage:
  scopelease init <repo>
  scopelease index <repo>
  scopelease analyze <repo> [--budget 8000] [--request "사용자 요청"]
  scopelease graph <repo> [--view radial|map|list] [--format text|dot] [--graph-backend-file graph.json] [--graph-backend codegraph] [--no-color]
  scopelease live <repo> [--view radial|map|list] [--interval 1500] [--no-clear] [--no-color]
  scopelease attach <repo> [--port auto] [--enable-model-proxy]
  scopelease app <repo> [--port auto] [--open] [--enable-model-proxy] [--request "사용자 요청"]
  scopelease hub <repo> [--port 4030] [--open]
  scopelease mcp <repo>
  scopelease context <repo> [--graph-backend-file graph.json] [--graph-backend codegraph]
  scopelease input <repo> [--format prompt] [--request "사용자 요청"]
  scopelease prompt <repo> [--request "사용자 요청"]
  scopelease guard <repo> --action-json '{"kind":"read","path":"src/app.js"}'
  scopelease approve <repo> --action-json '{"kind":"edit","path":"src/app.js"}' [--choice allow_scoped_patch|--choice-id allow_scoped_patch]
  scopelease enforce <repo> --action-json '{"kind":"bash","command":"npm test"}'
  scopelease enforce <repo> --hook-json '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"npm test"}}'
  scopelease guarded-exec <repo> [--request "..."] -- npm test
  scopelease guarded-exec <repo> [--request "..."] --command "node -e \"console.log('quoted arg')\""
  scopelease source-zip <repo> [--output scopelease_clean_source.zip] [--max-bytes 536870912] [--format json]
  scopelease verify-source-zip <repo> [--output scopelease_clean_source.zip] [--max-bytes 536870912] [--format json]
  scopelease freeze-evidence <repo> [--source .scopelease/reports/delegation-control-source-of-truth-20260528] [--target examples/evaluation/frozen-evidence/delegation-control-source-of-truth-20260528] [--format json]
  scopelease verify-frozen <repo> [--target examples/evaluation/frozen-evidence/delegation-control-source-of-truth-20260528] [--format json]
  scopelease source-truth-check <repo> [--source .scopelease/reports/delegation-control-source-of-truth-20260528] [--target examples/evaluation/frozen-evidence/delegation-control-source-of-truth-20260528] [--format json]
  scopelease fatigue <repo> --type human_prompt_shown|approval_lease_hit [--request "..."]
  scopelease measure <repo> --phase explore|edit|output --lane default-codex|scopelease-codex [--path file | --text "..."] [--tool-name Bash]
  scopelease measure-mode <repo> on|off|status
  scopelease usage <repo> --usage-json '{"input_tokens":1000,"output_tokens":500,"total_tokens":1500}'
  scopelease usage <repo> --usage-path output/run-id/cost_summary.json --lane default-codex --pair-id pair-1 --work-intent "same task"
  scopelease agent-usage <repo> [--codex-home ~/.codex]
  scopelease bench-tokens <repo> --tasks tasks.jsonl [--format json] [--baseline-mode explicit|readPlanFiles]
  scopelease graph-bench <repo> --tasks tasks.jsonl [--format json] [--max-grep-files 96] [--max-terms 8]
  scopelease review-bench <repo> --tasks tasks.jsonl [--format json] [--baseline-mode grep|manifest|critical] [--max-frontier-files 48]
  scopelease condition-matrix <repo> --tasks tasks.jsonl [--conditions C0,C1,C2,C3] [--format json]
  scopelease ablation-run <repo> --tasks tasks.jsonl [--conditions C0,C1,C2,C3] [--format json]
  scopelease delegation-report <repo> --tasks tasks.jsonl [--repos repoA,repoB] [--product-wide-summary summary.json] [--min-repos 10] [--min-pairs 100] [--output .scopelease/reports/run-1] [--format json]
  scopelease terminal-bench-summary --run .scopelease/reports/tb-run/run-id [--baseline-run .scopelease/reports/tb-run/baseline-id] [--format json]
  scopelease pair-run <repo> --tasks tasks.jsonl [--repeat 3] [--agent codex|claude|custom] [--agent-command "codex ..."] [--default-input-mode explicit-files|natural] [--live-observed] [--live-observed-command-mode prompt|minimal|lean|mcp] [--copy-worktree|--no-copy-worktree] [--scopelease-workspace-mode full|scoped] [--workspace-scope-source mixed|task|auto] [--scopelease-preapprove|--scopelease-approval-mode lease] [--format json]
  scopelease export-evidence <repo> [--output .scopelease/evidence/run-1] [--format json]
  scopelease evidence-summary <repo> [--format json]
  scopelease product-wide-summary <repo> [--repos repoA,repoB] [--min-repos 3] [--min-pairs 10] [--min-default-tokens 100] [--observed-pair-scope strict|all|auto] [--claim-metric agent-visible|command-reported] [--run-id-prefix prefix] [--command-pair-scope latest|all] [--input-cost-per-1m 1.25] [--format json]
  scopelease claim-report <repo> [--repos repoA,repoB] [--min-repos 3] [--min-pairs 10] [--claim-metric agent-visible|command-reported] [--run-id-prefix prefix] [--command-pair-scope latest|all] [--input-cost-per-1m 1.25] [--output .scopelease/reports/run-1] [--format json]
  scopelease human-study <repo> [--output .scopelease/studies/decision-fatigue-run]
  scopelease permission-fixtures <repo> [--output .scopelease/fixtures/permission-fixtures.jsonl]
  scopelease permission-fixtures <repo> --run [--fixtures .scopelease/fixtures/permission-fixtures.jsonl] [--format json]
  scopelease digest <repo>
  scopelease card <repo>
  scopelease checkpoint <repo>

Notes:
  analyze/card  사람이 읽는 결정 카드, 권한, k 단위 입력 후보를 출력합니다.
  context       화면과 파일 산출물까지 포함한 전체 context pack을 출력합니다.
  input         Codex/Claude Code-style agent에 넣을 role=user 입력 후보와 KG 근거를 출력합니다.
  prompt        userRequest.text를 포함해 coding agent에 붙여 넣는 프롬프트 텍스트만 출력합니다.
  guard         agent action을 approval lease와 decision gate 기준으로 allow/ask/deny 판정합니다.
  approve       같은 action의 guard 판정이 ask_once일 때만 approval lease를 발급해 반복 질문을 줄입니다.
  enforce      PreToolUse/PEP용 실행 전 집행 판정입니다. allow_with_log만 통과시키고 ask_once/deny는 실패 코드로 차단합니다.
  guarded-exec  shell 명령을 실행하기 전에 ScopeLease guard/approval lease를 통과시킨 뒤 실제 명령을 실행합니다.
  source-zip    source/docs/frozen evidence와 현재 논문용 .scopelease evidence subset만 고정 목록으로 묶고 node_modules, dist, .scopelease/benchmarks, .decision, .codex, 기존 zip은 제외합니다. 공유 zip의 텍스트 파일에서는 로컬 절대경로와 사용자명 변형을 sanitize합니다.
  verify-source-zip source zip 크기와 zip 내부 텍스트/entry name의 로컬 경로 및 사용자명 누출 여부를 확인합니다.
  freeze-evidence fresh delegation-control source-of-truth report를 frozen evidence package에 repo-local bounded copy로 반영합니다.
  verify-frozen frozen evidence package가 현재 논문 headline 지표와 로컬 경로 위생을 만족하는지 독립 확인합니다.
  source-truth-check source-of-truth report와 frozen evidence copy의 핵심 논문 지표가 같은지 확인합니다.
  fatigue       human evaluation용 decision fatigue 이벤트를 state.fatigueEvents에 기록합니다.
  measure       같은 work intent의 default-codex/scopelease-codex 입력 payload를 state.actualWorkEvents에 기록합니다.
  measure-mode  Codex hook과 scopelease_get_context 자동 계측 기록을 켜고 끕니다. 수동 scopelease measure는 계속 기록됩니다.
  usage         provider/client/proxy가 명시적으로 반환한 model usage만 state.modelUsageEvents에 기록합니다.
  agent-usage   과금 없이 Codex/ScopeLease agent-visible context 사용량 신호를 감지합니다. provider/API usage는 제외합니다.
  bench-tokens  MLE-bench류 task manifest에서 default 파일 payload와 ScopeLease context 입력 후보의 토큰 차이를 계산합니다.
  graph-bench   CodeGraph류 공개 claim 방식처럼 grep/keyword 파일 탐색 baseline과 ScopeLease graph frontier를 같은 task 단위에서 비교합니다.
  review-bench  검토 범위를 줄여도 되는지 누락/누수/병합/의도 일관성 기준으로 review frontier를 평가합니다.
  condition-matrix C0 baseline, C1 context-only, C2 guard-only, C3 full ScopeLease 조건을 같은 task/workIntent 기준으로 펼칩니다. 이 명령은 설계 산출물이며 결과 claim은 아닙니다.
  ablation-run  C0-C3 조건을 controlled task manifest 위에서 실제 집계합니다. live agent run은 아니며 context/review/permission/lease/stop frontier의 기계적 분해 결과입니다.
  delegation-report condition matrix, review frontier, permission fixture, product-wide pair/token boundary를 묶어 특허/CHI용 delegation-control evidence 보고서를 생성합니다. --product-wide-summary를 주면 102-pair formal summary 같은 frozen evidence를 source-of-truth로 사용하고 report에 출처를 남깁니다. 토큰 절감은 observed/command/proxy source별로 분리합니다.
  terminal-bench-summary Terminal-Bench results.json과 agent.cast의 Codex CLI "tokens used"를 파싱합니다. task prompt를 바꾼 ScopeLease 조건 효과로 해석하지 않고 same-prompt observed run 증거로만 표시합니다.
  pair-run      같은 task를 default/scopelease lane 입력으로 나눠 실험 로그, prompt 파일, token delta/결정 피로 지표를 남깁니다. --default-input-mode natural은 default lane에 파일 본문을 미리 붙이지 않고 request-only full-workspace Codex baseline을 만듭니다. --live-observed는 같은 pairId/workIntent의 default input, scopelease input, scopelease_get_context를 실제 observed state에도 기록합니다. --scopelease-preapprove는 ScopeLease lane에 scoped approval lease를 미리 발급해 no-lease permission stop과 context efficiency를 분리합니다.
                --agent codex는 codex exec stdin, --agent claude는 claude -p stdin, --agent-template은 임의 shell template을 사용합니다.
                --scopelease-workspace-mode scoped는 ScopeLease lane을 readPlan/baseline 파일만 있는 물리적 scoped worktree에서 실행해 broad search와 총 Codex tokens used 감소를 실험합니다.
  export-evidence decision card, context pack, guard/fatigue/token event JSONL, summary TSV를 한 폴더에 내보냅니다.
  evidence-summary 논문 표에 넣을 수 있는 정량 지표 TSV/JSON을 출력합니다.
  product-wide-summary 여러 repo의 실제 observed pair를 집계합니다. 기본 scope는 default/scopelease/scopelease_get_context가 모두 있는 strict이며, auto-promoted same-run pair와 tiny default baseline은 별도 보고합니다. --claim-metric command-reported는 live pair-run의 Codex CLI "tokens used" 합계를 별도 평균 claim metric으로 집계합니다. 비용은 --input-cost-per-1m이 있을 때만 추정합니다.
  claim-report  product-wide-summary, evidence-summary, permission fixture 상태를 특허/보고서용 claim boundary로 묶어 Markdown/JSON으로 저장합니다. command-reported formal protocol은 --claim-metric command-reported, --run-id-prefix, --command-pair-scope all, 충분한 --repos/--min-pairs를 함께 지정해야 합니다.
  human-study   결정 피로를 실제 사람 평가로 검증하기 위한 counterbalanced protocol, task sheet, rating sheet를 생성합니다.
  permission-fixtures 권한/lease 평가용 fixture manifest 생성 또는 --run으로 expected verdict 비교 결과를 남깁니다.
  mcp           Codex MCP에서 ScopeLease context/guard/measurement tools를 stdio로 제공합니다.
  attach        프로젝트 로컬 Codex MCP/hooks를 설치합니다. 실제 영향은 해당 repo의 .decision에만 기록됩니다.
  app           repo별 안정 포트로 ScopeLease 서버와 hooks를 보장합니다. 모델 프록시는 --enable-model-proxy일 때만 Codex config에 연결합니다.
  hub           전역 Codex workspace inventory를 한 화면에 띄우고, 각 프로젝트는 repo-local app으로 시작/열기만 위임합니다.
  digest        guard 이벤트와 fatigue metric을 출력합니다.
  graph/live    같은 work intent의 관측 입력, 권한 경계를 터미널 그래프 상단에 표시합니다.
  --graph-backend-file JSON은 CodeGraph/Codebase-Memory/CPG류 graph-shaped payload를 ScopeLease operational graph로 정규화해 context/review/permission/stop frontier와 approval lease hash에 반영합니다. MCP에서는 graphBackendPayload와 graphBackendName 인자를 사용합니다.
`);
}

function printBenchTokenTable(result = {}) {
  const rows = result.rows || [];
  console.log(`ScopeLease bench token delta (${result.boundary}; positive values are savings)`);
  console.log(`tasks ${result.summary?.measuredTasks || 0}/${result.taskCount || 0} · default ${formatNumber(result.summary?.defaultTokens)} · scopelease ${formatNumber(result.summary?.scopeleaseTokens)} · delta ${formatNumber(result.summary?.savedTokens)} (${formatPercent(result.summary?.savedPercent)})`);
  console.log("");
  console.log(["id", "mode", "default", "scopelease", "delta", "%", "files"].join("\t"));
  for (const row of rows) {
    console.log([
      row.id,
      row.scopeleaseMode || "-",
      formatNumber(row.defaultTokens),
      formatNumber(row.scopeleaseTokens),
      formatNumber(row.savedTokens),
      formatPercent(row.savedPercent),
      row.baselineFiles.length
    ].join("\t"));
  }
}

function printGraphBenchTable(result = {}) {
  const rows = result.rows || [];
  const summary = result.summary || {};
  console.log(`ScopeLease graph-claim bench (${result.boundary})`);
  console.log(`tasks ${summary.measuredTasks || 0}/${result.taskCount || 0} · grep ${formatNumber(summary.grepBaselineTokens)} · codegraph-min ${formatNumber(summary.codeGraphMinimalFileTokens)} · ScopeLease frontier files ${formatNumber(summary.graphFrontierFileTokens)} · ScopeLease prompt ${formatNumber(summary.scopeleasePromptTokens)}`);
  console.log(`grep->codegraph-min ${formatNumber(summary.grepToCodeGraphMinimal?.savedTokens)} (${formatPercent(summary.grepToCodeGraphMinimal?.savedPercent)}) · grep->ScopeLease frontier files ${formatNumber(summary.grepToGraphFiles?.savedTokens)} (${formatPercent(summary.grepToGraphFiles?.savedPercent)}) · grep->ScopeLease prompt ${formatNumber(summary.grepToScopeLeasePrompt?.savedTokens)} (${formatPercent(summary.grepToScopeLeasePrompt?.savedPercent)})`);
  console.log(`tool calls grep->graph ${formatNumber(summary.toolCallsGrepToGraphFiles?.defaultCalls)} -> ${formatNumber(summary.toolCallsGrepToGraphFiles?.scopeleaseCalls)} (${formatPercent(summary.toolCallsGrepToGraphFiles?.savedPercent)}) · prompt-only ${formatNumber(summary.toolCallsGrepToScopeLeasePromptOnly?.defaultCalls)} -> ${formatNumber(summary.toolCallsGrepToScopeLeasePromptOnly?.scopeleaseCalls)} (${formatPercent(summary.toolCallsGrepToScopeLeasePromptOnly?.savedPercent)})`);
  console.log("");
  console.log(["id", "grep", "codegraphMin", "scopeleaseFrontier", "scopeleasePrompt", "g->min%", "g->frontier%", "g->prompt%", "calls", "recall/precision"].join("\t"));
  for (const row of rows) {
    console.log([
      row.id,
      formatNumber(row.baseline?.grep?.tokens),
      formatNumber(row.baseline?.codeGraphMinimalFiles?.tokens),
      formatNumber(row.baseline?.graphFrontierFiles?.tokens),
      formatNumber(row.scopelease?.promptTokens),
      formatPercent(row.tokenDelta?.grepToCodeGraphMinimal?.savedPercent),
      formatPercent(row.tokenDelta?.grepToGraphFiles?.savedPercent),
      formatPercent(row.tokenDelta?.grepToScopeLeasePrompt?.savedPercent),
      `${formatNumber(row.toolCallDelta?.grepToGraphFiles?.defaultCalls)}->${formatNumber(row.toolCallDelta?.grepToGraphFiles?.scopeleaseCalls)}`,
      `${formatPercent(row.recallPrecision?.graphFrontierFiles?.recallPercent)}/${formatPercent(row.recallPrecision?.graphFrontierFiles?.precisionPercent)}`
    ].join("\t"));
  }
}

function printReviewBenchTable(result = {}) {
  const rows = result.rows || [];
  const summary = result.summary || {};
  console.log(`ScopeLease review-frontier bench (${result.boundary})`);
  console.log(`tasks ${formatNumber(summary.passedTasks)}/${formatNumber(summary.measuredTasks)} pass · baseline files ${formatNumber(summary.baselineReviewFiles)} · review frontier ${formatNumber(summary.reviewFrontierFiles)} · reduction ${formatPercent(summary.reviewScopeReductionPercent)}`);
  console.log(`critical recall ${formatPercent(summary.criticalFileRecallPercent)} · precision ${formatPercent(summary.criticalFilePrecisionPercent)} · leaks ${formatNumber(summary.leakageFailures)} · merge failures ${formatNumber(summary.mergeFailures)} · intent failures ${formatNumber(summary.intentFailures)}`);
  if (summary.toolCallProxy) {
    console.log(`tool-call proxy ${formatNumber(summary.toolCallProxy.defaultCalls)} -> ${formatNumber(summary.toolCallProxy.scopeleaseCalls)} (${formatPercent(summary.toolCallProxy.savedPercent)}) · rough file tokens ${formatNumber(summary.roughFileReadTokens?.defaultTokens)} -> ${formatNumber(summary.roughFileReadTokens?.scopeleaseTokens)} (${formatPercent(summary.roughFileReadTokens?.savedPercent)})`);
  }
  if (summary.qualityAxisPassRates) {
    const axes = Object.entries(summary.qualityAxisPassRates)
      .map(([name, rate]) => `${name}:${formatPercent(rate)}`)
      .join(" ");
    console.log(`quality axes ${axes}`);
  }
  console.log("");
  console.log(["id", "pass", "baseline", "frontier", "red%", "recall", "precision", "leaks", "merge", "intent", "axisFail"].join("\t"));
  for (const row of rows) {
    console.log([
      row.id,
      row.pass?.status || "-",
      formatNumber(row.baseline?.files),
      formatNumber(row.reviewFrontier?.files),
      formatPercent(row.reduction?.percent),
      formatPercent(row.omission?.files?.recallPercent),
      formatPercent(row.precision?.files),
      row.leakage?.status || "-",
      row.merge?.status || "-",
      row.intent?.status || "-",
      (row.pass?.failures || []).filter((item) => item.startsWith("axis_")).join(",") || "-"
    ].join("\t"));
  }
}

function printConditionMatrix(result = {}) {
  const summary = result.summary || {};
  console.log(`ScopeLease C0-C3 condition matrix (${result.boundary})`);
  console.log(`tasks ${formatNumber(result.taskCount)} · conditions ${formatNumber(result.conditionCount)} · rows ${formatNumber(result.rowCount)} · families ${formatNumber(summary.taskFamilies)}`);
  console.log(`required pairing ${summary.requiredPairing || "-"}`);
  console.log("");
  console.log(["condition", "rows", "purpose"].join("\t"));
  for (const condition of result.conditions || []) {
    console.log([
      condition.id,
      summary.byCondition?.[condition.id] || 0,
      condition.description
    ].join("\t"));
  }
}

function printControlledAblation(result = {}) {
  const summary = result.summary || {};
  const byCondition = summary.byCondition || {};
  console.log(`ScopeLease controlled C0-C3 ablation (${result.boundary})`);
  console.log(`tasks ${formatNumber(result.taskCount)} · conditions ${formatNumber(result.conditionCount)} · rows ${formatNumber(result.rowCount)}`);
  console.log(`caveat ${result.caveat || "controlled manifest-level evidence, not live agent execution"}`);
  console.log("");
  console.log(["condition", "pass", "files", "tokens", "unsafe", "scope", "escalation", "prompts", "lease", "silent"].join("\t"));
  for (const id of ["C0", "C1", "C2", "C3"]) {
    const row = byCondition[id] || {};
    console.log([
      id,
      `${formatNumber(row.passed)}/${formatNumber(row.rows)}`,
      formatNumber(row.visibleFiles),
      formatNumber(row.visibleTokens),
      formatNumber(row.unsafeCalls),
      formatNumber(row.scopeDrifts),
      formatNumber(row.escalationErrors),
      formatNumber(row.humanPrompts),
      formatNumber(row.leaseHits),
      formatNumber(row.silentFailureCount)
    ].join("\t"));
  }
  const c3c0 = summary.deltas?.C3_vs_C0 || {};
  console.log("");
  console.log(`C3 vs C0 files ${formatNumber(c3c0.visibleFilesDelta)} (${formatPercent(c3c0.visibleFileReductionPercent)}) · tokens ${formatNumber(c3c0.visibleTokensDelta)} (${formatPercent(c3c0.visibleTokenReductionPercent)}) · unsafe ${formatNumber(c3c0.unsafeCallDelta)} (${formatPercent(c3c0.unsafeCallReductionPercent)})`);
}

function printPairRunTable(result = {}) {
  const rows = result.rows || [];
  console.log(`ScopeLease pair-run (${result.boundary}, ${result.mode}; positive token delta is savings)`);
  console.log(`pairs ${result.summary?.measuredPairs || 0} · default ${formatNumber(result.summary?.defaultTokens)} · scopelease ${formatNumber(result.summary?.scopeleaseTokens)} · delta ${formatNumber(result.summary?.savedTokens)} (${formatPercent(result.summary?.savedPercent)})`);
  console.log(`decision prompts ${formatNumber(result.summary?.defaultDecisionPrompts)} -> ${formatNumber(result.summary?.scopeleaseDecisionPrompts)} (${formatPercent(result.summary?.decisionPromptReductionPercent)} proxy)`);
  if (result.summary?.taskCompletion?.measuredPairs) {
    const completion = result.summary.taskCompletion;
    console.log(`task completion ${formatNumber(completion.bothCompletedPairs)}/${formatNumber(completion.measuredPairs)} both valid · tokens-to-completion delta ${formatNumber(completion.tokensToCompletion?.savedTokens)} (${formatPercent(completion.tokensToCompletion?.savedPercent)}) · attempts delta ${formatNumber(completion.attemptsToCompletion?.savedAttempts)} (${formatPercent(completion.attemptsToCompletion?.savedPercent)})`);
  }
  console.log(`artifacts ${result.outputDir}`);
  console.log("");
  console.log(["id", "mode", "default", "scopelease", "delta", "%", "decision", "command"].join("\t"));
  for (const row of rows) {
    const commandStatuses = (row.events || []).map((event) => event.command?.status || "not_run").join("/");
    console.log([
      row.taskId,
      row.scopeleaseMode || "-",
      formatNumber(row.defaultTokens),
      formatNumber(row.scopeleaseTokens),
      formatNumber(row.savedTokens),
      formatPercent(row.savedPercent),
      `${formatNumber(row.decisionMetrics?.defaultDecisionPrompts)}->${formatNumber(row.decisionMetrics?.scopeleaseDecisionPrompts)}`,
      commandStatuses
    ].join("\t"));
  }
}

function printProductWideSummary(result = {}) {
  console.log(`ScopeLease product-wide observed token summary (${result.boundary})`);
  console.log(`status ${result.status} · metric ${result.claimMetric || "agent_visible"} · scope ${result.observedPairScope || "strict_independent_lanes"} · measured repos ${result.measuredRepoCount}/${result.repoCount} · min repos ${result.minRepos} · eligible pairs ${result.measuredPairCount}/${result.minPairs}`);
  console.log(`observed pairs ${result.observedPairCount || 0} · live candidates ${result.liveObservedCandidateCount || 0} · incomplete ${result.incompleteObservedPairCount || 0} · all live ${result.allLiveObservedPairCount || 0} · strict ${result.strictLiveObservedPairCount || 0} · auto-promoted ${result.autoPromotedPairCount || 0} · tiny default excluded ${result.tinyDefaultPairCount || 0} · min default ${formatNumber(result.minDefaultTokens)} tokens`);
  console.log(`observed default ${formatNumber(result.weighted?.defaultTokens)} · scopelease ${formatNumber(result.weighted?.scopeleaseTokens)} · delta ${formatNumber(result.weighted?.savedTokens)} (${formatPercent(result.weighted?.savedPercent)})`);
  if (result.costEstimate?.status === "estimated") {
    console.log(`estimated input cost ${formatMoney(result.costEstimate.defaultCost, result.costEstimate.currency)} -> ${formatMoney(result.costEstimate.scopeleaseCost, result.costEstimate.currency)} · delta ${formatMoney(result.costEstimate.savedCost, result.costEstimate.currency)} (${formatPercent(result.costEstimate.savedPercent)})`);
  }
  const providerBilling = result.providerBilling || {};
  if (providerBilling.status && Number(providerBilling.measuredPairCount || 0) > 0) {
    console.log(`provider usage ${providerBilling.status} · measured repos ${providerBilling.measuredRepoCount || 0}/${result.minRepos} · eligible pairs ${providerBilling.measuredPairCount || 0}/${result.minPairs}`);
    console.log(`provider default ${formatNumber(providerBilling.weighted?.defaultTokens)} · scopelease ${formatNumber(providerBilling.weighted?.scopeleaseTokens)} · delta ${formatNumber(providerBilling.weighted?.savedTokens)} (${formatPercent(providerBilling.weighted?.savedPercent)})`);
  }
  console.log(`controlled protocol repos ${result.controlledProtocol?.reposWithControlledProtocol || 0} · not used for live-agent average`);
  const commandReported = result.commandReported || {};
  if (commandReported.status) {
    console.log(`command-reported ${commandReported.status} · measured repos ${commandReported.measuredRepoCount || 0}/${result.minRepos} · eligible pairs ${commandReported.measuredPairCount || 0}/${result.minPairs}`);
    console.log(`command default ${formatNumber(commandReported.weighted?.defaultTokens)} · scopelease ${formatNumber(commandReported.weighted?.scopeleaseTokens)} · delta ${formatNumber(commandReported.weighted?.savedTokens)} (${formatPercent(commandReported.weighted?.savedPercent)})`);
    if (commandReported.quality?.measuredPairs) {
      console.log(`command quality pass ${commandReported.quality.commandPassedPairs}/${commandReported.quality.measuredPairs} · completion quality ${commandReported.quality.completionQualityPassedPairs}/${commandReported.quality.measuredPairs} · strict heuristic ${commandReported.quality.heuristicQualityPassedPairs}/${commandReported.quality.measuredPairs} · avg score ${formatPercent(commandReported.quality.averageScorePercent)}`);
    }
  }
  if (Array.isArray(result.byTaskType) && result.byTaskType.length) {
    console.log("");
    console.log(["task_type", "pairs", "default", "scopelease", "delta", "%", "positive", "overhead"].join("\t"));
    for (const row of result.byTaskType) {
      console.log([
        row.taskType || "unclassified",
        row.measuredPairs || 0,
        formatNumber(row.defaultTokens),
        formatNumber(row.scopeleaseTokens),
        formatNumber(row.savedTokens),
        formatPercent(row.savedPercent),
        row.positivePairs || 0,
        row.overheadPairs || 0
      ].join("\t"));
    }
  }
  console.log("");
  console.log(["repo", "status", "pairs", "candidates", "incomplete", "all_live", "auto", "default", "scopelease", "delta", "%", "claim"].join("\t"));
  for (const row of result.rows || []) {
    const aggregate = row.observedAggregate || {};
    console.log([
      row.repo,
      aggregate.measuredPairs ? "measured" : (row.observed?.status || "unknown"),
      aggregate.measuredPairs || 0,
      (row.allObservedPairCandidates || []).length,
      (row.incompleteObservedPairs || []).length,
      (row.allLiveObservedPairs || []).length,
      (row.allLiveObservedPairs || []).filter((pair) => pair.pairEvidenceKind === "auto_promoted_same_run").length,
      formatNumber(aggregate.defaultTokens),
      formatNumber(aggregate.scopeleaseTokens),
      formatNumber(aggregate.savedTokens),
      formatPercent(aggregate.savedPercent),
      aggregate.measuredPairs ? "actual_observed_same_work_intent_pairs" : (row.observed?.claimScope || "-")
    ].join("\t"));
  }
}

function formatNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toLocaleString("en-US") : "0";
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${value}%` : "n/a";
}

function formatMoney(value, currency = "USD") {
  const number = Number(value);
  if (!Number.isFinite(number)) return "n/a";
  return `${currency} ${number.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6
  })}`;
}

async function readActionFromInput(options = {}, label = "guard") {
  const raw = options["action-json"] || options.action || await readStdin();
  if (!raw.trim()) throw new Error(`${label} action JSON is required`);
  return JSON.parse(raw);
}

async function readEnforcementInput(options = {}) {
  if (options["hook-json"] || options.hook) {
    return {
      hookEvent: JSON.parse(String(options["hook-json"] || options.hook || "{}")),
      source: "cli:enforce-hook"
    };
  }
  if (options["hook-path"] || options.hookPath) {
    return {
      hookEvent: JSON.parse(fs.readFileSync(path.resolve(String(options["hook-path"] || options.hookPath)), "utf8")),
      source: "cli:enforce-hook"
    };
  }
  return {
    action: await readActionFromInput(options, "enforce"),
    source: "cli:enforce"
  };
}

function parseGuardedExecArgs(rawArgs = [], fallbackOptions = {}) {
  const separator = rawArgs.indexOf("--");
  const before = separator < 0 ? rawArgs : rawArgs.slice(0, separator);
  const after = separator < 0 ? [] : rawArgs.slice(separator + 1);
  const parsed = parseArgs(before);
  const commandOption = parsed.options.command || parsed.options.cmd;
  if (commandOption === true) throw new Error("guarded-exec --command requires a command string");
  if (separator < 0 && !commandOption) throw new Error("guarded-exec requires --command or a command after --");
  const commandText = commandOption
    ? String(commandOption)
    : after.join(" ").trim();
  const repoPath = path.resolve(parsed.positionals[0] || parsed.options.repo || ".");
  if (!commandText) throw new Error("guarded-exec command is empty");
  return {
    repo: repoPath,
    options: { ...fallbackOptions, ...parsed.options },
    command: commandText
  };
}

function printEnforcementResult(result = {}) {
  const status = result.allowed ? "allow" : "block";
  const verdict = result.verdict?.verdict || "unknown";
  const grant = result.actionGrant || result.verdict?.actionGrant || "unknown";
  console.log(`ScopeLease enforcement ${status}: ${verdict} (${grant})`);
  console.log(result.reason || result.verdict?.reason || "");
  if (!result.allowed && result.verdict?.decisionBundle?.id) {
    console.log(`approval required: ${result.verdict.decisionBundle.id}`);
  }
}

function freezeEvidenceSnapshot(repo, { sourceDir = DEFAULT_DELEGATION_REPORT_DIR, targetDir = DEFAULT_FROZEN_EVIDENCE_DIR } = {}) {
  const root = path.resolve(repo || ".");
  const sourceRoot = resolveRepoLocalDirectory(root, sourceDir, "freeze-evidence source");
  const targetRoot = resolveRepoLocalDirectory(root, targetDir, "freeze-evidence target");
  fs.mkdirSync(targetRoot, { recursive: true });

  const copied = FROZEN_EVIDENCE_FILES.map((file) => {
    const from = path.join(sourceRoot, file);
    if (!fs.existsSync(from)) {
      throw new Error(`missing generated evidence file: ${path.relative(root, from)}`);
    }
    const to = path.join(targetRoot, file);
    fs.copyFileSync(from, to);
    return {
      file,
      from: path.relative(root, from),
      to: path.relative(root, to),
      sizeBytes: fs.statSync(to).size
    };
  });

  return {
    kind: "scopelease.frozen_evidence_update",
    sourceDir: path.relative(root, sourceRoot) || ".",
    targetDir: path.relative(root, targetRoot) || ".",
    copied
  };
}

function checkFrozenEvidenceSourceTruth(repo, { sourceDir = DEFAULT_DELEGATION_REPORT_DIR, targetDir = DEFAULT_FROZEN_EVIDENCE_DIR } = {}) {
  const root = path.resolve(repo || ".");
  const sourceRoot = resolveRepoLocalDirectory(root, sourceDir, "source-truth-check source");
  const targetRoot = resolveRepoLocalDirectory(root, targetDir, "source-truth-check target");
  const sourceReport = readEvidenceReport(sourceRoot);
  const targetReport = readEvidenceReport(targetRoot);
  const sourceManifest = readOptionalJson(path.join(sourceRoot, "evidence-manifest.json"));
  const targetManifest = readOptionalJson(path.join(targetRoot, "evidence-manifest.json"));
  const rows = sourceTruthRows(sourceReport, targetReport);
  const hygieneRows = [
    localPathHygieneRow("source manifest local paths", sourceManifest, root),
    localPathHygieneRow("target manifest local paths", targetManifest, root),
    localPathHygieneRow("source report local paths", sourceReport, root),
    localPathHygieneRow("target report local paths", targetReport, root)
  ];
  const allRows = [...rows, ...hygieneRows];
  return {
    kind: "scopelease.source_truth_check",
    sourceDir: path.relative(root, sourceRoot) || ".",
    targetDir: path.relative(root, targetRoot) || ".",
    ok: allRows.every((row) => row.match),
    rows: allRows
  };
}

function verifyFrozenEvidenceSnapshot(repo, { targetDir = DEFAULT_FROZEN_EVIDENCE_DIR } = {}) {
  const root = path.resolve(repo || ".");
  const targetRoot = resolveRepoLocalDirectory(root, targetDir, "verify-frozen target");
  const report = readEvidenceReport(targetRoot);
  const manifest = readOptionalJson(path.join(targetRoot, "evidence-manifest.json"));
  const rows = [
    ...frozenEvidenceExpectationRows(report),
    localPathHygieneRow("frozen manifest local paths", manifest, root),
    localPathHygieneRow("frozen report local paths", report, root)
  ];
  return {
    kind: "scopelease.frozen_evidence_verify",
    targetDir: path.relative(root, targetRoot) || ".",
    ok: rows.every((row) => row.match),
    rows
  };
}

function readEvidenceReport(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "delegation-control-report.json"), "utf8"));
}

function readOptionalJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sourceTruthRows(sourceReport, targetReport) {
  const fields = [
    ["status", (report) => report.status],
    ["generatedAt", (report) => report.generatedAt],
    ["command-reported token saving", (report) => report.tokenSavings?.commandReportedTotalTokens?.savedPercent],
    ["command-reported default tokens", (report) => report.tokenSavings?.commandReportedTotalTokens?.defaultTokens],
    ["command-reported scopelease tokens", (report) => report.tokenSavings?.commandReportedTotalTokens?.scopeleaseTokens],
    ["review proxy reduction", (report) => report.tokenSavings?.reviewFrontierFileReadProxy?.savedPercent],
    ["review baseline files", (report) => report.axes?.B_contextAndCallReduction?.reviewFrontierProxy?.baselineFiles],
    ["review frontier files", (report) => report.axes?.B_contextAndCallReduction?.reviewFrontierProxy?.frontierFiles],
    ["critical-file recall@10", (report) => report.axes?.D_reviewBoundaryQuality?.criticalFileRankMetrics?.criticalFileRecallAtKPercent?.top10],
    ["permission fixture passed", (report) => report.axes?.C_permissionDelegation?.passed],
    ["permission fixture total", (report) => report.axes?.C_permissionDelegation?.total],
    ["controlled ablation row count", (report) => report.controlledAblation?.rowCount],
    ["C3 silent failures", (report) => report.controlledAblation?.summary?.byCondition?.C3?.silentFailureCount]
  ];
  return fields.map(([name, getter]) => {
    const source = getter(sourceReport);
    const target = getter(targetReport);
    return {
      name,
      source,
      target,
      match: source === target
    };
  });
}

function frozenEvidenceExpectationRows(report) {
  const fields = [
    ["status", (item) => item.status, "controlled_delegation_evidence_ready_live_completion_and_human_needed"],
    ["command-reported token saving", (item) => item.tokenSavings?.commandReportedTotalTokens?.savedPercent, 64],
    ["command-reported default tokens", (item) => item.tokenSavings?.commandReportedTotalTokens?.defaultTokens, 3560061],
    ["command-reported scopelease tokens", (item) => item.tokenSavings?.commandReportedTotalTokens?.scopeleaseTokens, 1280323],
    ["review proxy reduction", (item) => item.tokenSavings?.reviewFrontierFileReadProxy?.savedPercent, 61],
    ["review tool-call proxy reduction", (item) => item.axes?.B_contextAndCallReduction?.reviewFrontierProxy?.toolCallProxyReductionPercent, 69],
    ["review baseline files", (item) => item.axes?.B_contextAndCallReduction?.reviewFrontierProxy?.baselineFiles, 1771],
    ["review frontier files", (item) => item.axes?.B_contextAndCallReduction?.reviewFrontierProxy?.frontierFiles, 552],
    ["review passed tasks", (item) => item.axes?.D_reviewBoundaryQuality?.passedTasks, 23],
    ["critical-file recall", (item) => item.axes?.D_reviewBoundaryQuality?.criticalFileRecallPercent, 100],
    ["critical-file recall@10", (item) => item.axes?.D_reviewBoundaryQuality?.criticalFileRankMetrics?.criticalFileRecallAtKPercent?.top10, 93],
    ["permission fixture passed", (item) => item.axes?.C_permissionDelegation?.passed, 12],
    ["permission fixture total", (item) => item.axes?.C_permissionDelegation?.total, 12],
    ["controlled ablation row count", (item) => item.controlledAblation?.rowCount, 92],
    ["C3 silent failures", (item) => item.controlledAblation?.summary?.byCondition?.C3?.silentFailureCount, 0]
  ];
  return fields.map(([name, getter, target]) => {
    const source = getter(report);
    return {
      name,
      source,
      target,
      match: source === target
    };
  });
}

function localPathHygieneRow(name, value, root) {
  const hasLocalPath = containsUnsanitizedLocalPath(value, { root });
  return {
    name,
    source: hasLocalPath ? "local path present" : "clean",
    target: "clean",
    match: !hasLocalPath
  };
}

function resolveRepoLocalDirectory(repoRoot, requestedPath, label) {
  if (!requestedPath || requestedPath === true) throw new Error(`${label} requires a repository-local directory`);
  const fullPath = path.resolve(repoRoot, String(requestedPath));
  const relative = path.relative(repoRoot, fullPath);
  if (!pathInside(repoRoot, fullPath)) {
    throw new Error(`${label} must stay inside the repository: ${requestedPath}`);
  }
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the repository: ${requestedPath}`);
  }
  const realRoot = safeRealpath(repoRoot) || repoRoot;
  const existingParent = nearestExistingParent(fullPath);
  const realExistingParent = safeRealpath(existingParent) || existingParent;
  if (!pathInside(realRoot, realExistingParent)) {
    throw new Error(`${label} must not resolve outside the repository: ${requestedPath}`);
  }
  return fullPath;
}

function nearestExistingParent(targetPath) {
  let current = path.resolve(targetPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

async function readMeasurementFromInput(repo, options = {}) {
  let text = "";
  let source = options.source || "stdin";
  let label = options.label || "";
  let measuredPath = options.path || "";
  if (options.path) {
    const fullPath = resolveRepoLocalMeasurementPath(repo, options.path);
    text = readText(fullPath);
    source = options.source || "file";
    label = label || path.relative(path.resolve(repo), fullPath);
    measuredPath = path.relative(path.resolve(repo), fullPath);
  } else if (typeof options.text === "string") {
    text = options.text;
    source = options.source || "text";
    label = label || "inline text";
  } else {
    text = await readStdin();
    label = label || "stdin";
  }
  if (!String(text || "").length) throw new Error("measure requires --path, --text, or stdin content");
  return {
    phase: options.phase || "explore",
    text,
    source,
    label,
    path: measuredPath,
    request: options.request || "",
    workIntent: options["work-intent"] || options.workIntent || options.intent || "",
    lane: options.lane || options.mode || options.source || "",
    pairId: options["pair-id"] || options.pairId || options.pair || "",
    runId: options["run-id"] || options.runId || "",
    callType: options["call-type"] || options.callType || "",
    toolName: options["tool-name"] || options.toolName || options.tool || "",
    hookEventName: options["hook-event-name"] || options.hookEventName || "",
    baseline: options.baseline || "",
    baselineTokens: Number(options["baseline-tokens"] || options.baselineTokens || 0)
  };
}

function resolveRepoLocalMeasurementPath(repo, requestedPath) {
  if (!requestedPath || requestedPath === true) throw new Error("measure --path requires a repository-local file path");
  const root = path.resolve(repo || ".");
  const fullPath = path.resolve(root, String(requestedPath));
  const realRoot = safeRealpath(root) || root;
  const realPath = safeRealpath(fullPath) || fullPath;
  if (!pathInside(realRoot, realPath)) {
    throw new Error(`measure --path must stay inside the repository: ${requestedPath}`);
  }
  return fullPath;
}

function safeRealpath(targetPath) {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return "";
  }
}

function pathInside(root, targetPath) {
  const relative = path.relative(root, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readModelUsageFromInput(options = {}) {
  let raw = options["usage-json"] || options.usage || "";
  if (!raw && (options["usage-path"] || options.usagePath || options.path)) {
    raw = fs.readFileSync(path.resolve(String(options["usage-path"] || options.usagePath || options.path)), "utf8");
  }
  if (!raw) raw = await readStdin();
  const body = String(raw || "").trim() ? JSON.parse(raw) : {};
  const usage = { ...(body.usage || body) };
  applyUsageOption(usage, "inputTokens", options["input-tokens"] || options.inputTokens);
  applyUsageOption(usage, "outputTokens", options["output-tokens"] || options.outputTokens);
  applyUsageOption(usage, "reasoningTokens", options["reasoning-tokens"] || options.reasoningTokens);
  applyUsageOption(usage, "cachedInputTokens", options["cached-input-tokens"] || options.cachedInputTokens);
  applyUsageOption(usage, "totalTokens", options["total-tokens"] || options.totalTokens);
  applyUsageOption(usage, "totalCostUsd", options["total-cost-usd"] || options.totalCostUsd || options.costUsd);
  applyUsageOption(usage, "totalCalls", options["total-calls"] || options.totalCalls || options.calls);
  const hasAnyToken = ["inputTokens", "input_tokens", "prompt_tokens", "totalInputTokens", "total_input_tokens", "outputTokens", "output_tokens", "completion_tokens", "totalOutputTokens", "total_output_tokens", "reasoningTokens", "reasoning_tokens", "totalTokens", "total_tokens"]
    .some((key) => Number(usage[key] || 0) > 0);
  if (!hasAnyToken) throw new Error("usage requires token fields from Codex/API/proxy usage output");
  return {
    ...body,
    usage,
    source: options.source || body.source || "stdin",
    provider: options.provider || body.provider || "codex",
    model: options.model || body.model || "",
    lane: options.lane || body.lane || body.runLane || "",
    pairId: options["pair-id"] || options.pairId || body.pairId || body.pair_id || "",
    runId: options["run-id"] || options.runId || body.runId || body.run_id || "",
    workIntent: options["work-intent"] || options.workIntent || body.workIntent || body.work_intent || "",
    requestId: options["request-id"] || options.requestId || body.requestId || body.responseId || body.id || "",
    request: options.request || body.request || body.userRequest || ""
  };
}

function applyUsageOption(target, key, value) {
  if (value === undefined || value === true || value === "") return;
  target[key] = Number(value);
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function addApprovalLease(state = {}, lease = {}) {
  return {
    ...state,
    approvalLeases: compactLeases([lease, ...(state.approvalLeases || [])])
  };
}

function compactLeases(leases = []) {
  const seen = new Set();
  const now = Date.now();
  const output = [];
  for (const lease of leases) {
    if (!lease?.id || seen.has(lease.id)) continue;
    if (lease.expiresAt && Date.parse(lease.expiresAt) < now) continue;
    seen.add(lease.id);
    output.push(lease);
  }
  return output.slice(0, 40);
}

function renderForView(analysis, options = {}) {
  const view = options.view || "radial";
  const color = !options["no-color"] && options.color !== false;
  if (view === "list" || view === "tree") return renderTerminalGraph(analysis, { color });
  if (view === "map") return renderTerminalMap(analysis, { color });
  return renderTerminalRadial(analysis, { color });
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
