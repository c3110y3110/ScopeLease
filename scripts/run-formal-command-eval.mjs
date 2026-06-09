#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const cliPath = path.join(repoRoot, "src", "cli.js");

const args = parseArgs(process.argv.slice(2));
const runIdPrefix = String(args["run-id-prefix"] || args.runIdPrefix || `formal-command-eval-${timestampId()}`);
const tasksPath = path.resolve(repoRoot, String(args.tasks || "examples/evaluation/claim-ready-cli-observation-tasks.jsonl"));
const repetitions = positiveInt(args.repeat || args.repetitions || 2, 2);
const minRepos = positiveInt(args["min-repos"] || args.minRepos || 10, 10);
const minPairs = positiveInt(args["min-pairs"] || args.minPairs || 100, 100);
const outputDir = path.resolve(repoRoot, String(args.output || path.join(".scopelease", "experiments", runIdPrefix)));
const dryRun = Boolean(args["dry-run"] || args.dryRun);
const skipExisting = booleanOption(args["skip-existing"] ?? args.skipExisting, true);
const maxRepos = args["max-repos"] || args.maxRepos ? positiveInt(args["max-repos"] || args.maxRepos, 0) : 0;
const commandPairScope = String(args["command-pair-scope"] || args.commandPairScope || "all");
const repoTimeoutMs = nonNegativeInt(args["repo-timeout-ms"] || args.repoTimeoutMs || 0, 0);
const commandTimeoutMs = nonNegativeInt(args["command-timeout-ms"] || args.commandTimeoutMs || process.env.SCOPELEASE_RUNNER_TIMEOUT_MS || 0, 0);
const repos = loadRepos(args).slice(0, maxRepos || undefined);
const explicitAgentPreset = String(args["agent-preset"] || args.agentPreset || args.agent || "");
const defaultAgent = String(args["default-agent"] || args.defaultAgent || explicitAgentPreset || "codex");
const scopeleaseAgent = String(args["scopelease-agent"] || args.scopeleaseAgent || explicitAgentPreset || "codex");
const agentPreset = explicitAgentPreset || (defaultAgent === scopeleaseAgent ? defaultAgent : `${defaultAgent}+${scopeleaseAgent}`);

if (!repos.length) {
  fail("No repositories were provided. Use --repos-file path.json or --repos repoA,repoB.");
}
if (!fs.existsSync(tasksPath)) fail(`Tasks file does not exist: ${tasksPath}`);

fs.mkdirSync(outputDir, { recursive: true });
const logDir = path.join(outputDir, "logs");
fs.mkdirSync(logDir, { recursive: true });

const commands = [];
const runRows = [];
for (const repo of repos) {
  const repoPath = path.resolve(repo.path || repo);
  const label = safeSlug(repo.label || path.basename(repoPath));
  const runId = `${runIdPrefix}-${label}`;
  const repoOutput = path.join(repoPath, ".scopelease", "experiments", runId);
  const pairArgs = [
    cliPath,
    "pair-run",
    repoPath,
    "--tasks",
    tasksPath,
    "--repeat",
    String(repetitions),
    "--live-observed",
    "--default-agent",
    defaultAgent,
    "--scopelease-agent",
    scopeleaseAgent,
    "--copy-worktree",
    "--scopelease-workspace-mode",
    String(args["scopelease-workspace-mode"] || args.scopeleaseWorkspaceMode || "scoped"),
    "--workspace-scope-source",
    String(args["workspace-scope-source"] || args.workspaceScopeSource || "auto"),
    "--scopelease-preapprove",
    "--live-observed-command-mode",
    String(args["live-observed-command-mode"] || args.liveObservedCommandMode || "lean"),
    "--run-id",
    runId,
    "--output",
    repoOutput,
    "--format",
    "json"
  ];
  addOptional(pairArgs, "--agent-model", args["agent-model"] || args.agentModel);
  addOptional(pairArgs, "--agent-profile", args["agent-profile"] || args.agentProfile);
  addOptional(pairArgs, "--agent-sandbox", args["agent-sandbox"] || args.agentSandbox);
  commands.push({ kind: "pair-run", repoPath, label, runId, repoOutput, args: pairArgs });
}

const repoList = repos.map((repo) => path.resolve(repo.path || repo));
const summaryArgs = [
  cliPath,
  "product-wide-summary",
  repoRoot,
  "--repos",
  repoList.join(","),
  "--min-repos",
  String(minRepos),
  "--min-pairs",
  String(minPairs),
  "--claim-metric",
  "command-reported",
  "--run-id-prefix",
  runIdPrefix,
  "--command-pair-scope",
  commandPairScope,
  "--format",
  "json"
];
const reportDir = path.join(repoRoot, ".scopelease", "reports", runIdPrefix);
const reportArgs = [
  cliPath,
  "claim-report",
  repoRoot,
  "--repos",
  repoList.join(","),
  "--run-id-prefix",
  runIdPrefix,
  "--min-repos",
  String(minRepos),
  "--min-pairs",
  String(minPairs),
  "--claim-metric",
  "command-reported",
  "--command-pair-scope",
  commandPairScope,
  "--output",
  reportDir,
  "--format",
  "json"
];

const repoRows = repos.map((repo) => ({
  label: repo.label || path.basename(path.resolve(repo.path || repo)),
  path: path.resolve(repo.path || repo),
  ...repoMeta(path.resolve(repo.path || repo))
}));
const missingRepoRows = repoRows.filter((repo) => !repo.exists);
const runnableInCurrentPackage = missingRepoRows.length === 0;
const dryRunStatus = runnableInCurrentPackage ? "runnable" : "not_runnable_in_current_package";
const manifest = {
  kind: "scopelease.formal_command_eval_manifest",
  runIdPrefix,
  generatedAt: new Date().toISOString(),
  tasksPath,
  repetitions,
  minRepos,
  minPairs,
  agentPreset,
  defaultAgent,
  scopeleaseAgent,
  dryRun,
  skipExisting,
  repoTimeoutMs,
  commandTimeoutMs,
  repoCount: repos.length,
  expectedPairs: repos.length * countJsonlRows(tasksPath) * repetitions,
  runnableInCurrentPackage,
  dryRunStatus,
  missingRepoCount: missingRepoRows.length,
  dryRunReason: runnableInCurrentPackage
    ? "all configured repository paths exist in this environment"
    : "one or more configured repository paths are unavailable; regenerate the local repo manifest before running this protocol",
  repos: repoRows,
  commands: commands.map((command) => ({
    kind: command.kind,
    label: command.label,
    runId: command.runId,
    repo: command.repoPath,
    output: command.repoOutput,
    argv: [process.execPath, ...command.args]
  })),
  summary: {
    argv: [process.execPath, ...summaryArgs],
    output: path.join(outputDir, "product-wide-summary.json")
  },
  claimReport: {
    argv: [process.execPath, ...reportArgs],
    outputDir: reportDir
  }
};
writeJson(path.join(outputDir, "manifest.json"), manifest);
const runLogPath = path.join(outputDir, "run-log.json");
const finalStatusPath = path.join(outputDir, "final-status.json");

if (dryRun) {
  console.log(JSON.stringify(manifest, null, 2));
  process.exit(runnableInCurrentPackage ? 0 : 1);
}

writeRunLog("running");
process.once("SIGTERM", () => handleTermination("SIGTERM"));
process.once("SIGINT", () => handleTermination("SIGINT"));

for (const command of commands) {
  const summaryPath = path.join(command.repoOutput, "summary.json");
  if (!fs.existsSync(command.repoPath)) {
    runRows.push({
      ...rowBase(command),
      status: "missing_repo",
      summaryPath,
      completedAt: new Date().toISOString()
    });
    writeRunLog("running");
    console.log(`[missing] ${command.label} ${command.repoPath}`);
    continue;
  }
  if (skipExisting && fs.existsSync(summaryPath)) {
    runRows.push({
      ...rowBase(command),
      status: "skipped_existing",
      summaryPath,
      completedAt: new Date().toISOString()
    });
    writeRunLog("running");
    console.log(`[skip] ${command.label} existing ${summaryPath}`);
    continue;
  }
  console.log(`[run] ${command.label} ${command.runId}`);
  const row = {
    ...rowBase(command),
    status: "running",
    startedAt: new Date().toISOString(),
    summaryPath
  };
  runRows.push(row);
  writeRunLog("running");
  const result = runNode(command.args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      SCOPELEASE_DISABLE_TIKTOKEN: "1",
      ...(commandTimeoutMs > 0 ? { SCOPELEASE_RUNNER_TIMEOUT_MS: String(commandTimeoutMs) } : {})
    },
    timeoutMs: repoTimeoutMs,
    stdoutPath: path.join(logDir, `${command.runId}.stdout.json`),
    stderrPath: path.join(logDir, `${command.runId}.stderr.log`)
  });
  console.log(`[${result.status}] ${command.label} ${Math.round(result.durationMs / 1000)}s`);
  Object.assign(row, {
    status: result.status,
    exitCode: result.exitCode,
    signal: result.signal,
    errorCode: result.errorCode,
    durationMs: result.durationMs,
    stdoutPath: result.stdoutPath,
    stderrPath: result.stderrPath,
    completedAt: new Date().toISOString()
  });
  writeRunLog("running");
}

writeRunLog("pair_runs_finished");

console.log("[summary] product-wide-summary");
const summary = runNode(summaryArgs, {
  cwd: repoRoot,
  env: { ...process.env, SCOPELEASE_DISABLE_TIKTOKEN: "1" },
  stdoutPath: path.join(outputDir, "product-wide-summary.json"),
  stderrPath: path.join(outputDir, "product-wide-summary.stderr.log")
});
console.log(`[summary:${summary.status}] ${Math.round(summary.durationMs / 1000)}s`);
console.log("[report] claim-report");
const report = runNode(reportArgs, {
  cwd: repoRoot,
  env: { ...process.env, SCOPELEASE_DISABLE_TIKTOKEN: "1" },
  stdoutPath: path.join(outputDir, "claim-report.stdout.json"),
  stderrPath: path.join(outputDir, "claim-report.stderr.log")
});
console.log(`[report:${report.status}] ${Math.round(report.durationMs / 1000)}s`);

const finalStatus = {
  kind: "scopelease.formal_command_eval_status",
  runIdPrefix,
  generatedAt: new Date().toISOString(),
  pairRuns: runRows,
  productWideSummary: {
    status: summary.status,
    exitCode: summary.exitCode,
    stdoutPath: summary.stdoutPath,
    stderrPath: summary.stderrPath
  },
  claimReport: {
    status: report.status,
    exitCode: report.exitCode,
    stdoutPath: report.stdoutPath,
    stderrPath: report.stderrPath,
    outputDir: reportDir
  }
};
writeJson(finalStatusPath, finalStatus);
writeJson(path.join(outputDir, "fresh-run-snapshot.json"), buildFreshRunSnapshot({
  manifest,
  runRows,
  finalStatus,
  tasksPath,
  defaultAgent,
  scopeleaseAgent,
  outputDir
}));
writeRunLog("finished");

console.log(`Formal command eval finished: ${outputDir}`);

function writeRunLog(status = "running", extra = {}) {
  writeJson(runLogPath, {
    kind: "scopelease.formal_command_eval_run_log",
    runIdPrefix,
    generatedAt: new Date().toISOString(),
    status,
    rows: runRows,
    ...extra
  });
}

function handleTermination(signal) {
  const generatedAt = new Date().toISOString();
  writeRunLog("interrupted", { signal, interruptedAt: generatedAt });
  writeJson(finalStatusPath, {
    kind: "scopelease.formal_command_eval_status",
    runIdPrefix,
    generatedAt,
    status: "interrupted",
    signal,
    pairRuns: runRows,
    productWideSummary: {
      status: "not_run"
    },
    claimReport: {
      status: "not_run",
      outputDir: reportDir
    }
  });
  process.exit(signal === "SIGINT" ? 130 : 143);
}

function loadRepos(options) {
  if (options["repos-file"] || options.reposFile) {
    const filePath = path.resolve(repoRoot, String(options["repos-file"] || options.reposFile));
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const rows = Array.isArray(parsed) ? parsed : parsed.repos;
    if (!Array.isArray(rows)) fail(`Repos file must be an array or { "repos": [] }: ${filePath}`);
    return rows
      .filter((row) => row && row.include !== false)
      .map((row) => typeof row === "string" ? { path: row } : row);
  }
  if (options.repos) {
    return String(options.repos)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => ({ path: item }));
  }
  return [];
}

function runNode(argv, options = {}) {
  const started = Date.now();
  const result = spawnSync(process.execPath, argv, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    ...(options.timeoutMs > 0 ? { timeout: options.timeoutMs } : {})
  });
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || result.error?.message || "");
  fs.writeFileSync(options.stdoutPath, stdout);
  fs.writeFileSync(options.stderrPath, stderr);
  const exitCode = Number.isInteger(result.status) ? result.status : 1;
  const timedOut = result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM";
  return {
    status: timedOut ? "timeout" : exitCode === 0 ? "passed" : "failed",
    exitCode,
    signal: result.signal || null,
    errorCode: result.error?.code || null,
    durationMs: Date.now() - started,
    stdoutPath: options.stdoutPath,
    stderrPath: options.stderrPath
  };
}

function rowBase(command) {
  return {
    label: command.label,
    repo: command.repoPath,
    runId: command.runId,
    output: command.repoOutput
  };
}

function repoMeta(repoPath) {
  const exists = fs.existsSync(repoPath);
  if (!exists) return { exists: false };
  const gitHead = spawnSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 5000
  });
  const files = countFiles(repoPath, 3, 5000);
  return {
    exists: true,
    gitHead: gitHead.status === 0 ? String(gitHead.stdout || "").trim() : null,
    shallowFileCountMaxDepth3: files
  };
}

function buildFreshRunSnapshot({
  manifest,
  runRows,
  finalStatus,
  tasksPath,
  defaultAgent,
  scopeleaseAgent,
  outputDir
}) {
  const taskRows = loadTaskRows(tasksPath);
  const taskById = new Map(taskRows.map((task, index) => [String(task.taskId || task.id || `task-${index + 1}`), task]));
  const repoRows = manifest.repos.map((repo) => ({
    repoId: repo.label,
    pathOrRevision: repo.gitHead || repo.path,
    role: "target",
    language: repo.language || "",
    sizeClass: repo.shallowFileCountMaxDepth3 ? `files<=${repo.shallowFileCountMaxDepth3}` : "",
    notes: repo.path
  }));
  const tasks = taskRows.map((task, index) => ({
    taskId: String(task.taskId || task.id || `task-${index + 1}`),
    benchmarkFamily: String(task.benchmarkFamily || task.benchmarkName || task.benchmark || "fresh-run"),
    category: String(task.category || task.taskType || task.type || "unclassified"),
    persona: String(task.persona || task.userGroup || "professional_developer"),
    request: String(task.request || task.prompt || ""),
    claimAxes: normalizeClaimAxes(task.claimAxes)
  }));
  const runs = [];
  for (const row of runRows) {
    const repoId = row.label;
    const pairRows = loadPairRows(row.summaryPath);
    if (pairRows.length) {
      for (const pairRow of pairRows) {
        const taskId = String(pairRow.taskId || "");
        const task = taskById.get(taskId);
        runs.push(buildSnapshotRun({ commandRow: row, pairRow, task, repoId, condition: "C0" }));
        runs.push(buildSnapshotRun({ commandRow: row, pairRow, task, repoId, condition: "C3" }));
      }
      continue;
    }
    for (const task of tasks) {
      const pairId = `${row.runId}:${task.taskId}`;
      const fallbackMetrics = row.durationMs ? { durationMs: row.durationMs } : {};
      runs.push({
        runId: `${pairId}:C0`,
        agentId: "default-agent",
        repoId,
        taskId: task.taskId,
        condition: "C0",
        pairId,
        status: mapRunStatus(row.status),
        metrics: fallbackMetrics,
        statusBoundary: "repo_level_runner_status_no_pair_summary"
      });
      runs.push({
        runId: `${pairId}:C3`,
        agentId: "scopelease-agent",
        repoId,
        taskId: task.taskId,
        condition: "C3",
        pairId,
        status: mapRunStatus(row.status),
        metrics: fallbackMetrics,
        statusBoundary: "repo_level_runner_status_no_pair_summary"
      });
    }
  }
  return {
    kind: "scopelease.fresh_run_snapshot",
    snapshotId: manifest.runIdPrefix,
    generatedAt: new Date().toISOString(),
    scopeleaseSource: {
      commitOrArchive: repoMeta(repoRoot).gitHead || path.basename(repoRoot),
      dirtyState: gitDirtyState(repoRoot),
      notes: "Snapshot generated by scripts/run-formal-command-eval.mjs"
    },
    environment: {
      os: `${process.platform}/${process.arch}`,
      node: process.version,
      machineClass: "local_command_runner",
      networkPolicy: "agent commands inherit the caller environment; ScopeLease metering does not require a provider proxy",
      tokenizer: "SCOPELEASE_DISABLE_TIKTOKEN=1 for runner-local ScopeLease token counts",
      notes: `outputDir=${outputDir}`
    },
    agents: [
      {
        agentId: "default-agent",
        name: defaultAgent,
        interface: agentInterface(defaultAgent),
        versionCommand: `${defaultAgent} --version`,
        plan: String(args["agent-profile"] || args.agentProfile || args["agent-model"] || args.agentModel || "not_recorded")
      },
      {
        agentId: "scopelease-agent",
        name: scopeleaseAgent,
        interface: agentInterface(scopeleaseAgent),
        versionCommand: `${scopeleaseAgent} --version`,
        plan: String(args["agent-profile"] || args.agentProfile || args["agent-model"] || args.agentModel || "not_recorded")
      }
    ],
    benchmarkFamilies: [...new Set(tasks.map((task) => task.benchmarkFamily).filter(Boolean))],
    repos: repoRows,
    tasks,
    metricsBoundary: {
      primaryUnit: "same_work_intent_pair",
      included: [
        "task-level pair rows from pair-run summary.json when available",
        "prompt-observed command input",
        "command-reported total tokens when emitted by the agent command",
        "hook/MCP observed payloads when present",
        "permission and review frontier metrics generated by ScopeLease"
      ],
      excluded: [
        "repo-level runner status as task completion when pair rows are available",
        "provider billing unless separately ingested",
        "hidden prompts",
        "hidden reasoning tokens",
        "unmatched historical lane records"
      ],
      claimRule: "Use an average effect claim only when thresholded same-work-intent pairs exist and all invalid, failed, timeout, negative, and overhead rows remain visible."
    },
    runs,
    formalStatus: finalStatus
  };
}

function buildSnapshotRun({ commandRow = {}, pairRow = {}, task = null, repoId = "", condition = "C0" } = {}) {
  const lane = condition === "C3" ? "scopelease-codex" : "default-codex";
  const agentId = condition === "C3" ? "scopelease-agent" : "default-agent";
  const event = findLaneEvent(pairRow, lane);
  const taskId = String(pairRow.taskId || task?.taskId || task?.id || "unknown-task");
  const pairId = String(pairRow.pairId || `${commandRow.runId}:${taskId}`);
  return {
    runId: `${pairId}:${condition}`,
    agentId,
    repoId,
    taskId,
    condition,
    pairId,
    status: mapPairRunStatus({ commandRow, pairRow, event, condition }),
    metrics: buildSnapshotMetrics({ commandRow, pairRow, event, condition }),
    statusBoundary: pairRow.taskCompletion?.measured
      ? "task_specific_completion_status"
      : event?.command?.status
        ? "lane_command_execution_status_not_task_completion"
        : "repo_level_runner_status_fallback"
  };
}

function buildSnapshotMetrics({ commandRow = {}, pairRow = {}, event = {}, condition = "C0" } = {}) {
  const isScopeLease = condition === "C3";
  const completion = pairRow.taskCompletion || {};
  const completionTokens = completion.tokensToCompletion || {};
  const completionAttempts = completion.attemptsToCompletion || {};
  const commandDelta = pairRow.commandReportedTotalTokens || {};
  const metrics = {
    promptTokens: isScopeLease ? Number(pairRow.scopeleaseTokens || 0) : Number(pairRow.defaultTokens || 0),
    durationMs: Number(event?.command?.durationMs || commandRow.durationMs || 0) || undefined,
    permissionPromptCount: isScopeLease
      ? Number(pairRow.decisionMetrics?.scopeleaseDecisionPrompts || 0)
      : Number(pairRow.decisionMetrics?.defaultDecisionPrompts || 0)
  };
  const commandTokens = isScopeLease ? commandDelta.scopeleaseTokens : commandDelta.defaultTokens;
  if (Number.isFinite(Number(commandTokens)) && Number(commandTokens) > 0) {
    metrics.commandReportedTotalTokens = Number(commandTokens);
  }
  const completionLaneTokens = isScopeLease ? completionTokens.scopeleaseTokens : completionTokens.defaultTokens;
  if (Number.isFinite(Number(completionLaneTokens)) && Number(completionLaneTokens) > 0) {
    metrics.tokensToCompletion = Number(completionLaneTokens);
  }
  const attempts = isScopeLease ? completionAttempts.scopeleaseAttempts : completionAttempts.defaultAttempts;
  if (Number.isFinite(Number(attempts))) {
    metrics.attemptsToPass = Number(attempts);
  }
  return Object.fromEntries(Object.entries(metrics).filter(([, value]) => value !== undefined));
}

function mapPairRunStatus({ commandRow = {}, pairRow = {}, event = {}, condition = "C0" } = {}) {
  const completion = pairRow.taskCompletion || {};
  if (completion.measured) {
    const laneStatus = condition === "C3" ? completion.scopeleaseStatus : completion.defaultStatus;
    const mapped = mapStatusValue(laneStatus);
    if (mapped !== "incomplete") return mapped;
  }
  const commandStatus = mapStatusValue(event?.command?.status);
  if (commandStatus !== "incomplete") return commandStatus;
  return mapRunStatus(commandRow.status);
}

function findLaneEvent(pairRow = {}, lane = "") {
  return (pairRow.events || []).find((event) => event?.lane === lane) || null;
}

function loadPairRows(summaryPath = "") {
  if (!summaryPath || !fs.existsSync(summaryPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    return Array.isArray(parsed.rows) ? parsed.rows : [];
  } catch {
    return [];
  }
}

function loadTaskRows(filePath) {
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        fail(`Invalid JSONL task at ${filePath}:${index + 1}: ${error.message}`);
      }
    });
}

function normalizeClaimAxes(value) {
  const canonicalOrder = [
    "A_task_completion",
    "B_context_call",
    "C_permission_delegation",
    "D_review_boundary",
    "E_silent_failure",
    "F_human_supervision",
    "G_ablation"
  ];
  const aliases = new Map([
    ["completion", "A_task_completion"],
    ["context_efficiency", "B_context_call"],
    ["call_efficiency", "B_context_call"],
    ["context_call", "B_context_call"],
    ["context_token", "B_context_call"],
    ["A_context_call", "B_context_call"],
    ["metric_boundary", "B_context_call"],
    ["permission", "C_permission_delegation"],
    ["permission_decision", "C_permission_delegation"],
    ["B_permission", "C_permission_delegation"],
    ["review_frontier", "D_review_boundary"],
    ["review_quality", "D_review_boundary"],
    ["quality", "D_review_boundary"],
    ["D_review_quality", "D_review_boundary"],
    ["boundary_safety", "E_silent_failure"],
    ["decision_fatigue", "F_human_supervision"],
    ["decision_proxy", "F_human_supervision"],
    ["C_decision_proxy", "F_human_supervision"],
    ["human_supervision", "F_human_supervision"],
    ["E_human_plan", "F_human_supervision"],
    ["ablation", "G_ablation"],
    ["patent_mapping", "G_ablation"]
  ]);
  const allowed = new Set(canonicalOrder);
  const rows = Array.isArray(value) ? value : [];
  const normalized = [];
  for (const row of rows) {
    const item = String(row || "").trim();
    const axis = aliases.get(item) || item;
    if (allowed.has(axis) && !normalized.includes(axis)) normalized.push(axis);
  }
  normalized.sort((a, b) => canonicalOrder.indexOf(a) - canonicalOrder.indexOf(b));
  return normalized.length ? normalized : ["A_task_completion", "B_context_call"];
}

function mapRunStatus(status) {
  return mapStatusValue(status);
}

function mapStatusValue(status) {
  if (status === "passed" || status === "pass" || status === "skipped_existing") return "pass";
  if (status === "failed" || status === "fail") return "fail";
  if (status === "timeout" || status === "timed_out") return "timeout";
  if (status === "missing_repo" || status === "invalid") return "invalid";
  return "incomplete";
}

function agentInterface(agent) {
  const value = String(agent || "").toLowerCase();
  if (value.includes("claude")) return "claude_cli";
  if (value.includes("codex")) return "codex_cli";
  return "other";
}

function gitDirtyState(repoPath) {
  const result = spawnSync("git", ["-C", repoPath, "status", "--short"], {
    encoding: "utf8",
    timeout: 5000
  });
  if (result.status !== 0) return "not_git_repository";
  return String(result.stdout || "").trim() ? "dirty" : "clean";
}

function countFiles(rootPath, maxDepth, limit) {
  let count = 0;
  const walk = (dir, depth) => {
    if (count >= limit || depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= limit) return;
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist" || entry.name === ".scopelease") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile()) count += 1;
    }
  };
  walk(rootPath, 0);
  return count;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function addOptional(argv, flag, value) {
  if (value === undefined || value === null || value === "") return;
  argv.push(flag, String(value));
}

function positiveInt(value, fallback) {
  const number = Number.parseInt(String(value), 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegativeInt(value, fallback) {
  const number = Number.parseInt(String(value), 10);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function booleanOption(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  return fallback;
}

function countJsonlRows(filePath) {
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter((line) => line.trim()).length;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function safeSlug(value) {
  return String(value || "repo")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "repo";
}

function timestampId() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
