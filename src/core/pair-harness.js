import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildAgentInputPayload } from "./artifacts.js";
import { buildAdaptiveContext } from "./adaptive-context.js";
import { loadBenchTasks, normalizeBenchRequest, selectBenchBaselineFiles } from "./bench-evaluator.js";
import { approveDecisionBundle, evaluateAgentAction } from "./guard.js";
import { analyzeRepository, loadState, recordActualWork, saveState } from "./repository.js";
import { countTokensForTexts } from "./tokenizer.js";
import { buildTaskIntent, deriveWorkIntent, normalizeRequestKey, requestHash } from "./work-intent.js";

const AGENT_COMMAND_RUNNER_SOURCE = String.raw`
import fs from "node:fs";
import { spawn } from "node:child_process";

const command = process.env.SCOPELEASE_RUNNER_COMMAND || "";
const timeoutMs = Number.parseInt(process.env.SCOPELEASE_RUNNER_TIMEOUT_MS || "0", 10);
const metadataPath = process.env.SCOPELEASE_RUNNER_METADATA_PATH || "";
const cleanup = { status: "skipped", attempts: [] };
let timedOut = false;
let child = null;
let termTimer = null;

function killGroup(signal) {
  if (!child?.pid) {
    cleanup.attempts.push({ signal, status: "missing_child_pid" });
    return;
  }
  try {
    process.kill(-child.pid, signal);
    cleanup.attempts.push({ signal, status: "sent" });
    cleanup.status = "attempted";
  } catch (error) {
    cleanup.attempts.push({
      signal,
      status: error?.code === "ESRCH" ? "not_found" : "failed",
      error: error?.message || String(error)
    });
    if (cleanup.status === "skipped") cleanup.status = "attempted";
  }
}

function writeMetadata(extra = {}) {
  if (!metadataPath) return;
  try {
    fs.writeFileSync(metadataPath, JSON.stringify({
      pid: child?.pid || null,
      timedOut,
      cleanup,
      ...extra
    }, null, 2) + "\n");
  } catch {
    // Best-effort metadata only. The parent still sees stdout, stderr, and exit code.
  }
}

if (!command) {
  writeMetadata({ error: "missing command" });
  process.exit(127);
}

child = spawn(command, {
  shell: true,
  cwd: process.cwd(),
  env: process.env,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"]
});

const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
let timer = null;
if (timeout > 0) {
  timer = setTimeout(() => {
    timedOut = true;
    killGroup("SIGTERM");
    termTimer = setTimeout(() => killGroup("SIGKILL"), 1000);
    termTimer.unref?.();
  }, timeout);
}

child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.on("error", (error) => {
  if (timer) clearTimeout(timer);
  if (termTimer) clearTimeout(termTimer);
  writeMetadata({ error: error?.message || String(error) });
  process.stderr.write(String(error?.message || error));
  process.exit(1);
});
child.on("close", (code, signal) => {
  if (timer) clearTimeout(timer);
  if (termTimer) clearTimeout(termTimer);
  writeMetadata({ code, signal });
  if (timedOut) process.exit(124);
  if (Number.isInteger(code)) process.exit(code);
  process.exit(signal ? 128 : 1);
});
`;

export function runAgentPairHarness(repoPath, options = {}) {
  const root = path.resolve(repoPath || ".");
  const tasks = loadBenchTasks(options.tasksPath || options.tasks || "");
  const repetitions = normalizePositiveInt(options.repetitions || options.repeat || 1, 1);
  const runId = String(options.runId || `pair-${timestampId()}-${shortHash(`${root}:${Date.now()}`)}`).trim();
  const outputDir = path.resolve(root, options.outputDir || path.join(".scopelease", "experiments", runId));
  const rows = [];
  const events = [];
  const startedAt = new Date().toISOString();
  const liveObserved = Boolean(options.liveObserved || options["live-observed"]);

  fs.mkdirSync(outputDir, { recursive: true });

  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    tasks.forEach((task, index) => {
      const row = runPairTask(root, task, {
        ...options,
        budget: Number(options.budget || task.budget || 8000),
        baselineMode: options.baselineMode || options["baseline-mode"] || task.baselineMode || "explicit",
        index,
        outputDir,
        runId,
        repetition
      });
      rows.push(row);
      events.push(...row.events);
    });
  }

  const result = {
    kind: "scopelease.agent_pair_harness",
    boundary: "agent_visible_context_not_provider_billing",
    mode: hasAgentCommand(options) ? "command" : "token_only",
    observationKind: liveObserved
      ? "live_observed_agent_visible_pair"
      : hasAgentCommand(options)
      ? "controlled_agent_prompt_protocol"
      : "controlled_token_prompt_protocol",
    claimScope: liveObserved
      ? "live_observed_agent_visible_pair_not_provider_billing"
      : "controlled_prompt_protocol_not_live_codex_average",
    liveDefaultCodexObserved: liveObserved,
    repo: root,
    runId,
    generatedAt: new Date().toISOString(),
    startedAt,
    taskCount: tasks.length,
    repetitions,
    outputDir,
    agentAdapters: summarizeAgentAdapters(rows),
    summary: summarizePairRows(rows),
    rows
  };

  writeJsonl(path.join(outputDir, "events.jsonl"), events);
  writeJsonl(path.join(outputDir, "pairs.jsonl"), rows.map((row) => compactPairRow(row)));
  fs.writeFileSync(path.join(outputDir, "summary.json"), `${JSON.stringify(result, null, 2)}\n`);

  return result;
}

function runPairTask(root, task = {}, options = {}) {
  const request = normalizeBenchRequest(task);
  const taskId = String(task.id || task.taskId || `task-${options.index + 1}`);
  const category = String(task.category || task.taskType || task.type || "unclassified").trim() || "unclassified";
  const benchmarkFamily = String(task.benchmarkFamily || task.benchmark || "").trim();
  const basePairId = String(task.pairId || `${taskId}@${shortHash(`${request}:${options.repetition}`)}#r${options.repetition}`);
  const pairId = options.liveObserved && options.runId
    ? `${basePairId}@run-${shortHash(options.runId)}`
    : basePairId;
  const workIntent = String(task.workIntent || deriveWorkIntent({ request }));
  const analysis = analyzeRepository(root, { budget: options.budget, userRequest: request });
  const payload = buildAgentInputPayload(analysis.contextPack, { userRequest: request });
  const adaptiveContext = buildAdaptiveContext({
    repoPath: root,
    request,
    analysis,
    payload,
    mode: task.mode || task.contextMode || options.mode || options.contextMode || "auto"
  });
  const baselineFiles = selectBenchBaselineFiles({
    root,
    task,
    payload,
    baselineMode: options.baselineMode || "explicit"
  });
  const defaultInputMode = resolveDefaultInputMode({ task, options });
  const defaultInput = renderDefaultLaneInput({ request, baselineFiles, mode: defaultInputMode });
  const scopeleaseInput = adaptiveContext.text;
  const encoding = analysis.contextPack?.tokenEconomy?.tokenizer?.encoding || analysis.repoStats?.tokenizer?.encoding;
  const [defaultTokens, scopeleaseTokens] = countTokensForTexts([defaultInput, scopeleaseInput], { encoding }).counts;
  const taskDir = path.join(options.outputDir, safeName(taskId), `r${options.repetition}`);
  const defaultEvent = buildLaneEvent({
    lane: "default-codex",
    task,
    taskId,
    category,
    taskType: category,
    benchmarkFamily,
    pairId,
    workIntent,
    request,
    inputText: defaultInput,
    tokens: defaultTokens || 0,
    baselineFiles,
    analysis,
    adaptiveContext,
    taskDir,
    options: { ...options, repo: root }
  });
  const scopeleaseEvent = buildLaneEvent({
    lane: "scopelease-codex",
    task,
    taskId,
    category,
    taskType: category,
    benchmarkFamily,
    pairId,
    workIntent,
    request,
    inputText: scopeleaseInput,
    tokens: scopeleaseTokens || 0,
    baselineFiles,
    analysis,
    adaptiveContext,
    taskDir,
    options: { ...options, repo: root }
  });

  const savedTokens = (defaultTokens || 0) - (scopeleaseTokens || 0);
  const savedPercent = defaultTokens > 0 ? Math.round((savedTokens / defaultTokens) * 100) : null;
  const row = {
    kind: "scopelease.agent_pair_result",
    taskId,
    category,
    taskType: category,
    benchmarkFamily,
    pairId,
    runId: String(options.runId || "").trim(),
    repetition: options.repetition,
    title: String(task.title || task.name || ""),
    request,
    workIntent,
    boundary: "agent_visible_context_not_provider_billing",
    defaultTokens: defaultTokens || 0,
    scopeleaseTokens: scopeleaseTokens || 0,
    savedTokens,
    savedPercent,
    observationKind: options.liveObserved
      ? "live_observed_agent_visible_pair"
      : hasAgentCommand(options)
      ? "controlled_agent_prompt_protocol"
      : "controlled_token_prompt_protocol",
    claimScope: options.liveObserved
      ? "live_observed_agent_visible_pair_not_provider_billing"
      : "controlled_prompt_protocol_not_live_codex_average",
    liveDefaultCodexObserved: Boolean(options.liveObserved),
    scopeleaseMode: adaptiveContext.mode,
    baselineMode: options.baselineMode || "explicit",
    defaultInputMode,
    baselineFiles: baselineFiles.map((file) => file.relativePath),
    missingFiles: baselineFiles.filter((file) => file.missing).map((file) => file.relativePath),
    decisionMetrics: estimateDecisionMetrics({ analysis, payload, baselineFiles, task }),
    commandReportedTotalTokens: buildCommandReportedPairDelta(defaultEvent, scopeleaseEvent),
    taskCompletion: buildTaskCompletionPairDelta(defaultEvent, scopeleaseEvent),
    events: [defaultEvent, scopeleaseEvent],
    note:
      options.liveObserved && hasAgentCommand(options)
        ? "Commands were executed with lane-specific prompt files, and exact command prompt bytes are recorded as agent-command:prompt observations. This is prompt-observed agent-visible input, not provider billing; strict hook/MCP evidence is counted only when copied worktree events are actually imported."
        : hasAgentCommand(options)
        ? "Commands were executed with lane-specific prompt files. This is a controlled prompt protocol, not a claim about Codex's natural default retrieval behavior. Provider/API hidden prompts are still excluded."
        : "Token-only pair harness. It writes controlled visible lane inputs but does not invoke an external coding agent or observe Codex's natural default retrieval behavior."
  };

  if (recordHarnessState(options) && options.liveObserved && !hasAgentCommand(options)) {
    recordLiveObservedPair(root, row, {
      defaultInput,
      scopeleaseInput,
      adaptiveContext,
      analysis
    });
  } else if (recordHarnessState(options)) {
    recordPairInput(root, row, defaultEvent);
    recordPairInput(root, row, scopeleaseEvent);
  }

  return row;
}

function buildLaneEvent({
  lane,
  task = {},
  taskId,
  pairId,
  workIntent,
  request,
  inputText,
  tokens,
  baselineFiles,
  analysis = {},
  adaptiveContext,
  taskDir,
  options = {}
}) {
  const laneDir = path.join(taskDir, lane);
  fs.mkdirSync(laneDir, { recursive: true });
  const promptPath = path.join(laneDir, "prompt.md");
  fs.writeFileSync(promptPath, inputText);
  const commandConfigured = laneHasCommandConfig({ lane, task, options });
  const copyWorktree = resolveCopyWorktree({ options, commandConfigured });
  const workspaceMode = resolveLaneWorkspaceMode({ lane, task, options });
  const workspaceScopeFiles = buildWorkspaceScopeFiles({
    lane,
    task,
    baselineFiles,
    analysis,
    adaptiveContext,
    workspaceMode,
    options
  });
  const preapproval = buildLanePreapprovalSpec({
    lane,
    task,
    taskId,
    request,
    baselineFiles,
    workspaceScopeFiles,
    options
  });
  const workspacePath = copyWorktree
    ? pairWorkspacePath({ laneDir, lane, pairId, taskId })
    : options.repo || "";
  const laneRunId = [String(options.runId || "pair-run").trim(), pairId, lane, `r${options.repetition || 1}`]
    .filter(Boolean)
    .join(":");
  const commandSpec = resolveLaneCommand({
    lane,
    task,
    taskId,
    pairId,
    runId: laneRunId,
    workIntent,
    request,
    promptPath,
    workspace: workspacePath,
    options
  });
  const command = commandSpec.command;
  const liveObservedCommandMode = normalizeLiveObservedCommandMode(options);
  const promptText = command && options.liveObserved && lane === "scopelease-codex"
    ? renderScopeLeaseLiveAgentPrompt({
      request,
      scopeleaseInput: inputText,
      mode: liveObservedCommandMode,
      workspaceMode,
      workspaceScopeFiles,
      preapproval
    })
    : inputText;
  if (promptText !== inputText) fs.writeFileSync(promptPath, promptText);
  const promptTokens = promptText === inputText ? tokens : countTokensForTexts([promptText]).counts[0] || 0;
  const context = {
    kind: "scopelease.agent_pair_lane_context",
    lane,
    taskId,
    pairId,
    runId: laneRunId,
    workIntent,
    request,
    boundary: "agent_visible_context_not_provider_billing",
    inputTokens: tokens,
    inputChars: inputText.length,
    promptTokens,
    promptChars: promptText.length,
    promptPath,
    baselineFiles: baselineFiles.map((file) => ({
      path: file.relativePath,
      missing: Boolean(file.missing),
      tokens: file.tokens || null,
      chars: file.text?.length || 0
    })),
    scopelease: lane === "scopelease-codex" ? summarizeAdaptiveContext(adaptiveContext) : null,
    command: {
      configured: Boolean(command),
      shell: command || null,
      adapter: commandSpec.adapter,
      template: commandSpec.template,
      copyWorktree,
      workspace: workspacePath || null,
      workspaceMode,
      workspaceScopeFiles,
      liveObservedCommandMode: command && options.liveObserved ? liveObservedCommandMode : null,
      preapproval: summarizeLanePreapproval(preapproval)
    }
  };
  const contextPath = path.join(laneDir, "context.json");
  fs.writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`);
  const scopeleaseContextEmbedded = Boolean(
    command &&
      options.liveObserved &&
      lane === "scopelease-codex" &&
      liveObservedCommandMode === "prompt"
  );
  const run = runAgentCommand({
    command,
    lane,
    promptPath,
    taskId,
    pairId,
    request,
    root: options.repo || "",
    laneDir,
    copyWorktree,
    workspacePath,
    workspaceMode,
    workspaceScopeFiles,
    baselineFiles: baselineFiles.map((file) => file.relativePath),
    promptTokens,
    promptChars: promptText.length,
    scopeleaseContextEmbedded,
    scopeleaseContextTokens: scopeleaseContextEmbedded ? tokens : 0,
    completionSpec: task.completion || task.completionSpec || task.completion_spec || null,
    preapproval,
    adapter: {
      ...commandSpec.adapter,
      workIntent,
      runId: laneRunId,
      liveObserved: Boolean(options.liveObserved),
      sourceRoot: options.repo || ""
    }
  });
  return {
    kind: "scopelease.agent_pair_event",
    id: `${pairId}:${lane}`,
    timestamp: new Date().toISOString(),
    lane,
    taskId,
    pairId,
    runId: laneRunId,
    workIntent,
    request,
    inputTokens: tokens,
    inputChars: inputText.length,
    promptTokens,
    promptChars: promptText.length,
    promptPath,
    contextPath,
    baselineFiles: baselineFiles.map((file) => file.relativePath),
    scopeleaseMode: adaptiveContext.mode,
    commandReportedTotalTokens: run.reportedTotalTokens ?? null,
    commandReportedTotalTokenSource: run.reportedTotalTokenSource || null,
    command: run
  };
}

function resolveCopyWorktree({ options = {}, commandConfigured = false } = {}) {
  if (options.copyWorktree === false || options["copy-worktree"] === false || options["no-copy-worktree"]) return false;
  if (options.copyWorktree === true || options["copy-worktree"] === true) return true;
  return Boolean(commandConfigured);
}

function resolveLaneWorkspaceMode({ lane, task = {}, options = {} } = {}) {
  const raw = lane === "scopelease-codex"
    ? options.scopeleaseWorkspaceMode || options["scopelease-workspace-mode"] || task.scopeleaseWorkspaceMode || task.scopelease_workspace_mode || options.workspaceMode || options["workspace-mode"] || task.workspaceMode || task.workspace_mode
    : options.defaultWorkspaceMode || options["default-workspace-mode"] || task.defaultWorkspaceMode || task.default_workspace_mode || options.workspaceMode || options["workspace-mode"] || task.workspaceMode || task.workspace_mode;
  const mode = String(raw || "full").trim().toLowerCase().replace(/[\s_-]+/g, "_");
  if (["scoped", "scope", "readplan", "read_plan", "scoped_readplan", "bounded", "bounded_readplan"].includes(mode)) {
    return "scoped_readplan";
  }
  return "full";
}

function buildWorkspaceScopeFiles({
  lane,
  task = {},
  baselineFiles = [],
  analysis = {},
  adaptiveContext = {},
  workspaceMode = "full",
  options = {}
} = {}) {
  if (workspaceMode !== "scoped_readplan") return [];
  const limit = normalizePositiveInt(options.workspaceScopeLimit || options["workspace-scope-limit"] || task.workspaceScopeLimit || task.workspace_scope_limit || 64, 64);
  const requestedSourceMode = normalizeWorkspaceScopeSource(options.workspaceScopeSource || options["workspace-scope-source"] || task.workspaceScopeSource || task.workspace_scope_source || "");
  const sourceMode = requestedSourceMode === "auto"
    ? chooseAutoWorkspaceScopeSource({ task, baselineFiles, analysis, adaptiveContext })
    : requestedSourceMode;
  const files = new Set();

  for (const file of baselineFiles || []) addWorkspaceScopePath(files, file?.relativePath);
  for (const file of adaptiveContext?.decision?.explicitFiles || []) addWorkspaceScopePath(files, file);
  for (const file of task.workspaceFiles || task.workspace_files || []) addWorkspaceScopePath(files, file);
  for (const file of completionOutputPaths(task.completion || task.completionSpec || task.completion_spec || {})) addWorkspaceScopePath(files, file);

  if (sourceMode !== "task_only") {
    const readPlan = analysis.contextPack?.agentContext?.readPlan || analysis.contextPack?.readPlan || [];
    for (const item of readPlan) {
      if (files.size >= limit) break;
      addWorkspaceScopePath(files, item?.path || item?.id || item?.label);
    }

    for (const file of ["AGENTS.md", "package.json"]) {
      if (files.size >= limit) break;
      addWorkspaceScopePath(files, file);
    }
  }

  return [...files].slice(0, limit);
}

function normalizeWorkspaceScopeSource(value = "") {
  const text = String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, "_");
  if (["auto", "adaptive", "automatic"].includes(text)) return "auto";
  if (["task", "task_only", "fixture", "benchmark", "baseline_only"].includes(text)) return "task_only";
  return "mixed";
}

function chooseAutoWorkspaceScopeSource({ task = {}, baselineFiles = [], analysis = {}, adaptiveContext = {} } = {}) {
  const category = String(task.category || task.taskType || task.type || "").trim().toLowerCase().replace(/[\s_-]+/g, "_");
  const request = normalizeBenchRequest(task).toLowerCase();
  const decision = adaptiveContext?.decision || {};
  const explicitFiles = decision.explicitFiles || [];
  const readPlan = analysis.contextPack?.agentContext?.readPlan || analysis.contextPack?.readPlan || [];
  const taskFileCount = [
    ...baselineFiles.map((file) => file?.relativePath),
    ...arrayFrom(task.workspaceFiles || task.workspace_files),
    ...completionOutputPaths(task.completion || task.completionSpec || task.completion_spec || {})
  ].filter(Boolean).length;
  const broadCategory = [
    "architecture",
    "architecture_review",
    "onboarding",
    "impact_analysis",
    "bug_fix",
    "debugging",
    "ml_pipeline",
    "mle_benchmark_like"
  ].some((item) => category.includes(item));
  const broadRequest = [
    "architecture",
    "entry point",
    "entrypoint",
    "onboarding",
    "impact",
    "call graph",
    "cross-file",
    "cross file",
    "debug",
    "bug",
    "pipeline",
    "training",
    "benchmark",
    "end-to-end",
    "end to end"
  ].some((needle) => request.includes(needle));
  if (broadCategory || broadRequest) return "mixed";
  if (taskFileCount === 0 && explicitFiles.length === 0 && readPlan.length > 0) return "mixed";
  return "task_only";
}

function buildLanePreapprovalSpec({
  lane,
  task = {},
  taskId = "",
  request = "",
  baselineFiles = [],
  workspaceScopeFiles = [],
  options = {}
} = {}) {
  if (lane !== "scopelease-codex") return { enabled: false, reason: "not_scopelease_lane" };
  const mode = normalizeScopeLeaseApprovalMode(
    options.scopeleaseApprovalMode
      || options["scopelease-approval-mode"]
      || task.scopeleaseApprovalMode
      || task.scopelease_approval_mode
      || (truthyOption(options.scopeleasePreapprove ?? options["scopelease-preapprove"] ?? task.scopeleasePreapprove ?? task.scopelease_preapprove) ? "lease" : "")
  );
  if (mode !== "lease") return { enabled: false, reason: "disabled" };
  const paths = resolvePreapprovalPaths({ task, baselineFiles, workspaceScopeFiles });
  if (!paths.length) return { enabled: false, mode: "approval_lease_available", reason: "no_approval_paths" };
  const choiceId = String(options.scopeleasePreapproveChoice || options["scopelease-preapprove-choice"] || task.scopeleasePreapproveChoice || task.scopelease_preapprove_choice || "allow_scoped_patch").trim();
  return {
    enabled: true,
    mode: "approval_lease_available",
    boundary: "precreated_scoped_approval_lease_for_scopelease_lane",
    choiceId,
    action: {
      kind: "apply_patch",
      paths,
      summary: `Preapprove scoped patch for pair-run task ${taskId || task.id || "task"}`
    },
    request
  };
}

function normalizeScopeLeaseApprovalMode(value = "") {
  const text = String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, "_");
  if (["lease", "preapprove", "preapproved", "approval_lease", "approval_lease_available", "scoped_lease"].includes(text)) return "lease";
  return "";
}

function truthyOption(value) {
  if (value === undefined || value === null) return false;
  if (value === true) return true;
  if (value === false) return false;
  const text = String(value || "").trim().toLowerCase();
  return ["1", "true", "yes", "on", "enable", "enabled", "lease"].includes(text);
}

function resolvePreapprovalPaths({ task = {}, baselineFiles = [], workspaceScopeFiles = [] } = {}) {
  const explicit = [
    ...arrayFrom(task.approvalFiles || task.approval_files),
    ...arrayFrom(task.editFiles || task.edit_files),
    ...arrayFrom(task.patchFiles || task.patch_files),
    ...completionOutputPaths(task.completion || task.completionSpec || task.completion_spec || {})
  ];
  const candidates = explicit.length
    ? explicit
    : [
      ...baselineFiles.map((file) => file?.relativePath),
      ...workspaceScopeFiles
    ].filter(isCodeLikeApprovalPath);
  const seen = new Set();
  const output = [];
  for (const candidate of candidates) {
    const normalized = normalizeWorkspaceScopePath(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output.slice(0, 16);
}

function isCodeLikeApprovalPath(value = "") {
  const normalized = normalizeWorkspaceScopePath(value);
  return /\.(js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|sql|json|toml|yaml|yml)$/i.test(normalized);
}

function completionOutputPaths(completion = {}) {
  if (!completion || typeof completion !== "object") return [];
  return [
    ...arrayFrom(completion.requiredFiles || completion.required_files),
    ...completionCsvSpecs(completion).map((item) => item.path || item.file || item.relativePath || "")
  ];
}

function summarizeLanePreapproval(preapproval = {}) {
  if (!preapproval?.enabled) return { enabled: false, reason: preapproval?.reason || "disabled" };
  return {
    enabled: true,
    mode: preapproval.mode,
    boundary: preapproval.boundary,
    choiceId: preapproval.choiceId,
    action: preapproval.action
  };
}

function addWorkspaceScopePath(files, value) {
  const normalized = normalizeWorkspaceScopePath(value);
  if (normalized) files.add(normalized);
}

function normalizeWorkspaceScopePath(value = "") {
  const raw = String(value || "").trim().replace(/:\d+$/, "");
  if (!raw || raw.includes("\0")) return "";
  if (raw.startsWith("~/") || path.isAbsolute(raw)) return "";
  const normalized = path.normalize(raw).split(path.sep).join("/");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === "..") return "";
  if (shouldIgnorePairSnapshotPath(normalized)) return "";
  return normalized;
}

function laneHasCommandConfig({ lane, task = {}, options = {} }) {
  const explicitCommand = lane === "default-codex"
    ? options.defaultCommand || options["default-command"] || task.defaultCommand || task.default_command
    : options.scopeleaseCommand || options["scopelease-command"] || task.scopeleaseCommand || task.scopelease_command;
  if (explicitCommand) return true;
  if (options.agentCommand || options["agent-command"] || task.agentCommand || task.agent_command) return true;
  const preset = lane === "default-codex"
    ? options.defaultAgent || options["default-agent"] || task.defaultAgent || task.default_agent || options.agent || task.agent
    : options.scopeleaseAgent || options["scopelease-agent"] || task.scopeleaseAgent || task.scopelease_agent || options.agent || task.agent;
  const template = lane === "default-codex"
    ? options.defaultAgentTemplate || options["default-agent-template"] || task.defaultAgentTemplate || task.default_agent_template || options.agentTemplate || options["agent-template"] || task.agentTemplate || task.agent_template
    : options.scopeleaseAgentTemplate || options["scopelease-agent-template"] || task.scopeleaseAgentTemplate || task.scopelease_agent_template || options.agentTemplate || options["agent-template"] || task.agentTemplate || task.agent_template;
  return Boolean(preset || template);
}

function summarizeAdaptiveContext(adaptiveContext = {}) {
  return {
    mode: adaptiveContext.mode,
    requestedMode: adaptiveContext.requestedMode,
    tokens: adaptiveContext.tokens,
    chars: adaptiveContext.chars,
    decision: adaptiveContext.decision || null
  };
}

export function resolveLaneCommand({
  lane,
  task = {},
  taskId,
  pairId,
  runId,
  workIntent,
  request,
  promptPath,
  workspace,
  options = {}
}) {
  const explicitCommand = lane === "default-codex"
    ? options.defaultCommand || options["default-command"] || task.defaultCommand || task.default_command || ""
    : options.scopeleaseCommand || options["scopelease-command"] || task.scopeleaseCommand || task.scopelease_command || "";
  if (explicitCommand) {
    return {
      command: explicitCommand,
      adapter: { name: "explicit-command", lane },
      template: null
    };
  }

  const sharedCommand = options.agentCommand || options["agent-command"] || task.agentCommand || task.agent_command || "";
  if (sharedCommand) {
    return {
      command: sharedCommand,
      adapter: { name: "shared-command", lane },
      template: null
    };
  }

  const preset = normalizeAgentPreset(lane === "default-codex"
    ? options.defaultAgent || options["default-agent"] || task.defaultAgent || task.default_agent || options.agent || task.agent
    : options.scopeleaseAgent || options["scopelease-agent"] || task.scopeleaseAgent || task.scopelease_agent || options.agent || task.agent);
  const template = lane === "default-codex"
    ? options.defaultAgentTemplate || options["default-agent-template"] || task.defaultAgentTemplate || task.default_agent_template || options.agentTemplate || options["agent-template"] || task.agentTemplate || task.agent_template || ""
    : options.scopeleaseAgentTemplate || options["scopelease-agent-template"] || task.scopeleaseAgentTemplate || task.scopelease_agent_template || options.agentTemplate || options["agent-template"] || task.agentTemplate || task.agent_template || "";

  if (!preset && !template) {
    return {
      command: "",
      adapter: { name: "none", lane },
      template: null
    };
  }

  const selectedTemplate = template || defaultAgentTemplate(preset, options, lane);
  if (!selectedTemplate) {
    return {
      command: "",
      adapter: { name: preset || "unknown", lane, missingTemplate: true },
      template: null
    };
  }

  const command = renderCommandTemplate(selectedTemplate, {
    lane,
    taskId,
    pairId,
    runId,
    workIntent,
    request,
    promptPath,
    workspace: workspace || process.cwd(),
    sandbox: options.agentSandbox || options["agent-sandbox"] || options.codexSandbox || options["codex-sandbox"] || "workspace-write",
    model: options.agentModel || options["agent-model"] || "",
    profile: options.agentProfile || options["agent-profile"] || "",
    scopeleaseCliPath: pairHarnessCliPath(),
    nodePath: process.execPath
  });

  return {
    command,
    adapter: {
      name: preset || "custom",
      lane,
      model: options.agentModel || options["agent-model"] || "",
      profile: options.agentProfile || options["agent-profile"] || ""
    },
    template: selectedTemplate
  };
}

function normalizeAgentPreset(value = "") {
  const preset = String(value || "").trim().toLowerCase();
  if (!preset || preset === "none" || preset === "off" || preset === "false") return "";
  if (["codex", "codex-cli", "openai-codex"].includes(preset)) return "codex";
  if (["claude", "claude-code", "anthropic-claude"].includes(preset)) return "claude";
  if (["custom", "shell", "template"].includes(preset)) return "custom";
  return preset;
}

function resolveAgentExecutable(envName, fallback, candidates = []) {
  const configured = String(process.env[envName] || "").trim();
  if (configured) return JSON.stringify(configured);
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return JSON.stringify(candidate);
  }
  return fallback;
}

function isExecutableFile(candidate = "") {
  const filePath = String(candidate || "").trim();
  if (!filePath) return false;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function claudeExecutableCandidates() {
  const home = os.homedir();
  return [
    path.join(home, ".claude", "local", "bin", "claude"),
    path.join(home, ".claude", "local", "claude"),
    path.join(home, ".claude", "local", "node_modules", ".bin", "claude"),
    path.join(home, ".local", "bin", "claude"),
    path.join(home, ".npm-global", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude"
  ];
}

function defaultAgentTemplate(preset = "", options = {}, lane = "") {
  if (preset === "codex") {
    const bin = process.env.SCOPELEASE_CODEX_BIN ? JSON.stringify(process.env.SCOPELEASE_CODEX_BIN) : "codex";
    const model = options.agentModel || options["agent-model"] ? " --model {{model}}" : "";
    const profile = options.agentProfile || options["agent-profile"] ? " --profile {{profile}}" : "";
    const isolated = options.liveObserved || options["live-observed"] ? " --ignore-user-config" : "";
    const scopelease = (options.liveObserved || options["live-observed"]) && lane === "scopelease-codex"
      ? " --enable hooks -c {{scopeleaseMcpCommandConfig}} -c {{scopeleaseMcpArgsConfig}} -c 'mcp_servers.scopelease.enabled=true' -c 'mcp_servers.scopelease.enabled_tools=[\"scopelease_get_context\",\"scopelease_guard\",\"scopelease_approve\",\"scopelease_measure\",\"scopelease_explain_delta\"]' -c 'mcp_servers.scopelease.default_tools_approval_mode=\"approve\"'"
        + " -c 'shell_environment_policy.inherit=\"all\"'"
      : "";
    return `${bin} exec --cd {{workspace}} --skip-git-repo-check${isolated}${scopelease} -c 'approval_policy="never"' --sandbox {{sandbox}}${model}${profile} - < {{promptPath}}`;
  }
  if (preset === "claude") {
    const bin = resolveAgentExecutable("SCOPELEASE_CLAUDE_BIN", "claude", claudeExecutableCandidates());
    const model = options.agentModel || options["agent-model"] ? " --model {{model}}" : "";
    const scopelease = (options.liveObserved || options["live-observed"]) && lane === "scopelease-codex"
      ? " --mcp-config {{scopeleaseClaudeMcpConfig}} --allowedTools {{scopeleaseClaudeAllowedTools}} --append-system-prompt {{scopeleaseClaudeSystemPrompt}}"
      : "";
    // --output-format json makes Claude Code emit a final result object with `usage`
    // token counts, which the harness parses as command-reported total tokens.
    return `${bin} -p --output-format json${model}${scopelease} < {{promptPath}}`;
  }
  return "";
}

function renderCommandTemplate(template = "", values = {}) {
  const replacements = {
    lane: shellQuote(values.lane),
    laneRaw: values.lane,
    taskId: shellQuote(values.taskId),
    taskIdRaw: values.taskId,
    pairId: shellQuote(values.pairId),
    pairIdRaw: values.pairId,
    runId: shellQuote(values.runId),
    runIdRaw: values.runId,
    workIntent: shellQuote(values.workIntent),
    workIntentRaw: values.workIntent,
    request: shellQuote(values.request),
    requestRaw: values.request,
    requestJson: shellQuote(JSON.stringify(values.request || "")),
    promptPath: shellQuote(values.promptPath),
    promptPathRaw: values.promptPath,
    workspace: shellQuote(values.workspace),
    workspaceRaw: values.workspace,
    sandbox: shellQuote(values.sandbox),
    sandboxRaw: values.sandbox,
    model: shellQuote(values.model),
    modelRaw: values.model,
    profile: shellQuote(values.profile),
    profileRaw: values.profile,
    scopeleaseCliPath: shellQuote(values.scopeleaseCliPath),
    scopeleaseCliPathRaw: values.scopeleaseCliPath,
    nodePath: shellQuote(values.nodePath),
    nodePathRaw: values.nodePath,
    scopeleaseMcpCommandConfig: shellQuote(`mcp_servers.scopelease.command=${JSON.stringify(String(values.nodePath || process.execPath))}`),
    scopeleaseMcpArgsConfig: shellQuote(`mcp_servers.scopelease.args=${tomlArray([
      String(values.scopeleaseCliPath || pairHarnessCliPath()),
      "mcp",
      String(values.workspace || process.cwd()),
      "--work-intent",
      String(values.workIntent || ""),
      "--pair-id",
      String(values.pairId || ""),
      "--run-id",
      String(values.runId || "")
    ])}`),
    scopeleaseClaudeMcpConfig: shellQuote(JSON.stringify({
      mcpServers: {
        scopelease: {
          command: String(values.nodePath || process.execPath),
          args: [
            String(values.scopeleaseCliPath || pairHarnessCliPath()),
            "mcp",
            String(values.workspace || process.cwd()),
            "--work-intent",
            String(values.workIntent || ""),
            "--pair-id",
            String(values.pairId || ""),
            "--run-id",
            String(values.runId || "")
          ]
        }
      }
    })),
    scopeleaseClaudeAllowedTools: shellQuote([
      "mcp__scopelease__scopelease_get_context",
      "mcp__scopelease__scopelease_guard",
      "mcp__scopelease__scopelease_approve",
      "mcp__scopelease__scopelease_measure",
      "mcp__scopelease__scopelease_explain_delta"
    ].join(",")),
    scopeleaseClaudeSystemPrompt: shellQuote(
      "Before broad repository reads or edits, call the ScopeLease MCP tool scopelease_get_context with the user request and prefer its readPlan. Before applying edits or running commands, call scopelease_guard for that action."
    )
  };
  return String(template || "").replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, key) => {
    if (Object.hasOwn(replacements, key)) return replacements[key] ?? "";
    return "";
  });
}

function shellQuote(value = "") {
  const text = String(value || "");
  if (!text) return "''";
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function tomlArray(values = []) {
  return `[${values.map((value) => JSON.stringify(String(value))).join(", ")}]`;
}

function recordPairInput(root, row, event) {
  try {
    const harnessRunId = String(row.runId || row.harnessRunId || "").trim();
    recordActualWork(root, {
      phase: "input",
      text: fs.readFileSync(event.promptPath, "utf8"),
      request: row.request,
      workIntent: row.workIntent,
      pairId: row.pairId,
      runId: [harnessRunId || "pair-run", row.pairId, event.lane, `r${row.repetition}`].filter(Boolean).join(":"),
      lane: event.lane,
      source: "pair-harness",
      label: `${event.lane} visible input`
    });
  } catch (error) {
    event.recordStateError = error.message;
  }
}

function recordLiveObservedPair(root, row, { defaultInput = "", scopeleaseInput = "", adaptiveContext = {}, analysis = {} } = {}) {
  try {
    recordActualWork(root, {
      phase: "input",
      text: defaultInput,
      request: row.request,
      workIntent: row.workIntent,
      pairId: row.pairId,
      runId: liveObservedRunId(row, "default-codex"),
      lane: "default-codex",
      source: "live-observed-pair-run:default-input",
      label: "Live observed default-codex visible input"
    });
  } catch (error) {
    row.liveObservedDefaultError = error.message;
  }
  try {
    recordActualWork(root, {
      phase: "input",
      text: renderScopeLeaseObservedUserInput(row.request),
      request: row.request,
      workIntent: row.workIntent,
      pairId: row.pairId,
      runId: liveObservedRunId(row, "scopelease-codex"),
      lane: "scopelease-codex",
      source: "live-observed-pair-run:scopelease-user-input",
      label: "Live observed scopelease-codex user input"
    });
  } catch (error) {
    row.liveObservedScopeLeaseWorkError = error.message;
  }
  try {
    recordLiveObservedContext(root, {
      request: row.request,
      workIntent: row.workIntent,
      pairId: row.pairId,
      runId: liveObservedRunId(row, "scopelease-codex"),
      text: renderScopeLeaseObservedContextInput(scopeleaseInput, row.request),
      adaptiveContext,
      analysis
    });
  } catch (error) {
    row.liveObservedContextError = error.message;
  }
}

function renderScopeLeaseObservedUserInput(request = "") {
  return [
    "User request:",
    String(request || "").trim(),
    "",
    "Measurement boundary:",
    "- lane: scopelease-codex",
    "- phase: input",
    "- ScopeLease context is recorded separately as scopelease_get_context evidence"
  ].join("\n") + "\n";
}

function normalizeLiveObservedCommandMode(options = {}) {
  const value = String(options.liveObservedCommandMode || options["live-observed-command-mode"] || options.commandObservedMode || "").trim().toLowerCase();
  if (["mcp", "mcp-only", "strict-mcp"].includes(value)) return "mcp";
  if (["lean", "lean-prompt", "short", "terse", "compact-minimal"].includes(value)) return "lean";
  if (["minimal", "minimal-prompt", "task", "task-scope", "task-scoped", "scoped-minimal"].includes(value)) return "minimal";
  return "prompt";
}

function renderScopeLeaseLiveAgentPrompt({
  request = "",
  scopeleaseInput = "",
  mode = "prompt",
  workspaceMode = "full",
  workspaceScopeFiles = [],
  preapproval = {}
} = {}) {
  const workspaceBoundary = renderWorkspaceBoundaryInstruction({ workspaceMode, workspaceScopeFiles });
  const approvalInstruction = renderPreapprovalInstruction({ request, preapproval });
  if (mode === "lean") {
    return [
      "User request:",
      String(request || "").trim(),
      "",
      "ScopeLease lean scope:",
      "- Work inside the visible scoped workspace.",
      "- Do not call scopelease_get_context in this token-efficiency run; evidence is recorded separately.",
      renderLeanPreapprovalInstruction({ preapproval }),
      renderLeanWorkspaceBoundaryInstruction({ workspaceMode }),
      "- Stop and report the missing path if a required file is absent.",
      "- Keep the final answer concise."
    ].filter((line) => line !== "").join("\n") + "\n";
  }
  if (mode === "minimal") {
    return [
      "User request:",
      String(request || "").trim(),
      "",
      "ScopeLease minimal task-scope instruction:",
      "- Use only the visible task-scoped workspace files unless the task is impossible without another file.",
      "- Do not call scopelease_get_context in this token-efficiency run; context/lease evidence is recorded separately by the harness.",
      approvalInstruction,
      "- Keep the final answer concise and report only task-relevant evidence.",
      "",
      "Measurement boundary:",
      "- no compact KG context is embedded in this prompt",
      "- precreated approval lease evidence is recorded in the command result",
      "- provider/API billing usage is excluded",
      workspaceBoundary
    ].filter((line) => line !== "").join("\n") + "\n";
  }
  if (mode === "mcp") {
    return [
      "User request:",
      String(request || "").trim(),
      "",
      "ScopeLease measurement instruction:",
      "- At the start of this ScopeLease lane, call the project MCP tool scopelease_get_context for this request.",
      "- Use the returned readPlan, avoidPlan, decisionGate, and traceLedger as the context boundary before reading or changing files.",
      approvalInstruction,
      "- Keep the final answer concise and do not claim token savings from this run unless paired evidence is measured.",
      workspaceBoundary
    ].filter((line) => line !== "").join("\n") + "\n";
  }
  const compactContext = renderScopeLeaseObservedContextInput(scopeleaseInput, request).trim();
  return [
    "User request:",
    String(request || "").trim(),
    "",
    "ScopeLease compact context (agent-visible):",
    compactContext || "(empty)",
    "",
    "ScopeLease measurement instruction:",
    "- Use the compact context above as the context boundary.",
    "- If the project MCP tool scopelease_get_context is available, you may call it to refresh the same context; otherwise continue from the visible compact context.",
    approvalInstruction,
    "- Keep the final answer concise and do not claim token savings from this run unless paired evidence is measured.",
    workspaceBoundary
  ].filter((line) => line !== "").join("\n") + "\n";
}

function renderWorkspaceBoundaryInstruction({ workspaceMode = "full", workspaceScopeFiles = [] } = {}) {
  if (workspaceMode !== "scoped_readplan") return "";
  const visible = workspaceScopeFiles.slice(0, 24);
  return [
    "",
    "ScopeLease workspace boundary:",
    "- This command is running in an ScopeLease scoped worktree, not the full repository.",
    "- Only readPlan/baseline support files are physically present to reduce broad exploration.",
    "- Do not run broad repository searches to compensate for missing files.",
    "- If a required file is absent, state the missing path instead of scanning outside scope.",
    "- Scope manifest: .scopelease-workspace-scope.json",
    "- Visible files:",
    ...visible.map((file) => `  - ${file}`),
    workspaceScopeFiles.length > visible.length ? `  - ... ${workspaceScopeFiles.length - visible.length} more` : ""
  ].filter((line) => line !== "").join("\n");
}

function renderLeanWorkspaceBoundaryInstruction({ workspaceMode = "full" } = {}) {
  if (workspaceMode !== "scoped_readplan") return "";
  return "- Scoped worktree: only task/readPlan files are visible; manifest is .scopelease-workspace-scope.json.";
}

function renderLeanPreapprovalInstruction({ preapproval = {} } = {}) {
  if (!preapproval?.enabled) return "";
  const count = (preapproval.action?.paths || []).length;
  const pathLabel = count === 1 ? "path" : "paths";
  return `- Signed scoped approval lease is precreated for ${count} ${pathLabel}; continue inside it, stop if scope expands.`;
}

function renderPreapprovalInstruction({ request = "", preapproval = {} } = {}) {
  if (!preapproval?.enabled) return "";
  const paths = (preapproval.action?.paths || []).slice(0, 12);
  return [
    "- Approval mode: a scoped ScopeLease approval lease has been pre-created for this ScopeLease lane.",
    "- For this non-interactive pair-run, the harness already evaluated scopelease_guard and stored the signed lease before this command started.",
    "- Continue for the listed paths without asking the human again; call scopelease_guard only if you need to leave this scope.",
    `- If you do call scopelease_guard, pass this exact request string: ${JSON.stringify(String(request || ""))}.`,
    "- If a guard call returns ask_once, deny, or is cancelled, stop only for the action outside the listed preapproved paths.",
    paths.length ? `- Preapproved edit/write paths: ${paths.join(", ")}${preapproval.action?.paths?.length > paths.length ? ", ..." : ""}` : ""
  ].filter(Boolean).join("\n");
}

function renderScopeLeaseObservedContextInput(scopeleaseInput = "", request = "") {
  const text = String(scopeleaseInput || "");
  const marker = "\n\nScopeLease adaptive context:";
  if (text.startsWith("User request:\n") && text.includes(marker)) {
    return `ScopeLease adaptive context:${text.split(marker).slice(1).join(marker)}`;
  }
  const trimmedRequest = String(request || "").trim();
  if (trimmedRequest && text.includes(trimmedRequest)) {
    return text.replace(trimmedRequest, "").replace(/^User request:\s*/i, "").trimStart();
  }
  return text;
}

function recordLiveObservedContext(root, { request = "", workIntent = "", pairId = "", runId = "", text = "", adaptiveContext = {}, analysis = {} } = {}) {
  const state = loadState(root) || {};
  const tokenResult = countTokensForTexts([text], {
    encoding: analysis.contextPack?.tokenEconomy?.tokenizer?.encoding || analysis.repoStats?.tokenizer?.encoding
  });
  const tokens = tokenResult.counts[0] || 0;
  const event = {
    kind: "scopelease.mcp_context_event",
    id: `mcp_context_${shortHash(`${Date.now()}:${pairId}:${runId}:${shortHash(text)}`)}`,
    timestamp: new Date().toISOString(),
    userRequest: request,
    requestKey: normalizeRequestKey(request),
    requestHash: requestHash(request),
    workIntent,
    pairingKey: workIntent,
    taskIntent: buildTaskIntent({ request, workIntent }, {
      pairId,
      paths: analysis.contextPack?.readPlan?.map((item) => item.path || item.id || item.label).filter(Boolean) || []
    }),
    lane: "scopelease-codex",
    pairId,
    runId,
    tool: "scopelease_get_context",
    source: "live-observed-pair-run:scopelease_get_context",
    tokens,
    chars: text.length,
    baselineTokens: 0,
    savedTokens: null,
    savedPercent: null,
    tokenCounter: tokenResult.tokenizer?.exact
      ? `${tokenResult.tokenizer.method || "tiktoken"}:${tokenResult.tokenizer.encoding || ""}`
      : "fallback",
    meta: {
      mode: adaptiveContext.mode,
      requestedMode: adaptiveContext.requestedMode,
      runId,
      pairId,
      workIntent,
      observationKind: "live_observed_agent_visible_pair",
      adaptiveContext: {
        mode: adaptiveContext.mode,
        requestedMode: adaptiveContext.requestedMode,
        tokens: adaptiveContext.tokens,
        chars: adaptiveContext.chars,
        decision: adaptiveContext.decision
      }
    },
    note: "Live observed pair-run records the ScopeLease context payload as scopelease_get_context-equivalent evidence. Savings require a matching default-codex observed input for the same workIntent and pairId."
  };
  saveState(root, {
    ...state,
    mcpContextEvents: compactLiveObservedContextEvents([event, ...(state.mcpContextEvents || [])])
  });
  return event;
}

function liveObservedRunId(row, lane) {
  return [row.runId || "live-pair-run", row.pairId, lane, `r${row.repetition}`].filter(Boolean).join(":");
}

function compactLiveObservedContextEvents(events = []) {
  const seen = new Set();
  const output = [];
  for (const event of events) {
    if (!event?.id || seen.has(event.id)) continue;
    seen.add(event.id);
    output.push(event);
    if (output.length >= 120) break;
  }
  return output;
}

function resolveDefaultInputMode({ task = {}, options = {} } = {}) {
  const raw = options.defaultInputMode || options["default-input-mode"] || task.defaultInputMode || task.default_input_mode || "explicit-files";
  const value = String(raw || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (["natural", "request-only", "request", "natural-codex", "natural-default"].includes(value)) {
    return "natural_request";
  }
  return "explicit_files";
}

function renderDefaultLaneInput({ request = "", baselineFiles = [], mode = "explicit_files" } = {}) {
  if (mode === "natural_request") {
    return [
      "User request:",
      request,
      "",
      "Default Codex baseline:",
      "- No baseline file bodies are preloaded in this prompt.",
      "- Use the repository workspace normally, as a coding agent would in a natural request-only run.",
      "- Cite relative file paths used in the final answer."
    ].join("\n") + "\n";
  }
  const sections = [
    "User request:",
    request,
    "",
    "Default Codex visible context:"
  ];
  for (const file of baselineFiles) {
    sections.push("", `## ${file.relativePath}`, "```text", file.text || "", "```");
  }
  return `${sections.join("\n")}\n`;
}

function estimateDecisionMetrics({ analysis = {}, payload = {}, baselineFiles = [], task = {} } = {}) {
  const fatiguePlan = payload.fatiguePlan || analysis.contextPack?.agentContext?.fatiguePlan || {};
  const decisionAssistance = fatiguePlan.decisionBundle?.decisionAssistance || {};
  const processDelta = payload.processDelta || analysis.contextPack?.agentContext?.processDelta || {};
  const decisionQuestions = processDelta.decisionQuestions || {};
  const policyHits = analysis.policyHits || [];
  const defaultPrompts = finiteOr(
    task.defaultDecisionPrompts,
    finiteOr(decisionQuestions.baseline, Math.max(1, baselineFiles.length + policyHits.length + 1))
  );
  const scopeleaseCandidate = finiteOr(
    task.scopeleaseDecisionPrompts,
    finiteOr(decisionQuestions.kept, fatiguePlan.decisionBudget?.maxQuestions || 1)
  );
  const scopeleasePrompts = Math.min(defaultPrompts, scopeleaseCandidate);
  const reduced = Math.max(0, defaultPrompts - scopeleasePrompts);
  return {
    kind: "scopelease.decision_fatigue_metric",
    measurement: "proxy_until_ui_or_guard_events_are_observed",
    defaultDecisionPrompts: defaultPrompts,
    scopeleaseDecisionPrompts: scopeleasePrompts,
    reducedDecisionPrompts: reduced,
    reductionPercent: defaultPrompts > 0 ? Math.round((reduced / defaultPrompts) * 100) : null,
    approvalPromptBudget: fatiguePlan.decisionBudget?.maxQuestions || 1,
    approvalLeaseReusable: Boolean(fatiguePlan.reusableApproval?.enabled),
    decisionAssistance: {
      surface: decisionAssistance.surface || "unknown",
      interruptHuman: Boolean(decisionAssistance.interruptHuman),
      userDecisionKind: decisionAssistance.userDecisionKind || "unknown",
      recommendedChoice: decisionAssistance.recommendedChoice || "",
      riskReasons: decisionAssistance.riskReasons || [],
      expectedCognitiveLoad: decisionAssistance.evaluationSignals?.expectedCognitiveLoad || "",
      humanEvaluationTarget: decisionAssistance.evaluationSignals?.humanTarget || ""
    },
    surfaceCounts: {
      interrupt: decisionAssistance.surface === "interrupt" ? 1 : 0,
      review: decisionAssistance.surface === "review" ? 1 : 0,
      silent: decisionAssistance.surface === "silent" ? 1 : 0
    },
    observedCountersToUseInProduct: [
      "approval_prompt_count",
      "human_decision_count",
      "clarification_count",
      "override_count",
      "lease_hit_count",
      "repeated_question_suppressed_count",
      "flow_break_count",
      "time_to_first_decision_ms",
      "decision_surface",
      "recommended_choice",
      "human_choice",
      "override_reason",
      "post_lease_stop_condition"
    ],
    note: "초기 사용자 요청 1회는 별도 input으로 보고, 피로도는 추가 승인/확인/되물음처럼 흐름을 끊는 사람 개입을 셉니다."
  };
}

function runAgentCommand({
  command = "",
  lane,
  promptPath,
  taskId,
  pairId,
  request = "",
  root,
  laneDir,
  copyWorktree = false,
  workspacePath = "",
  workspaceMode = "full",
  workspaceScopeFiles = [],
  baselineFiles = [],
  promptTokens = null,
  promptChars = null,
  scopeleaseContextEmbedded = false,
  scopeleaseContextTokens = 0,
  completionSpec = null,
  preapproval = {},
  adapter = {}
} = {}) {
  const stdoutPath = path.join(laneDir, "stdout.log");
  const stderrPath = path.join(laneDir, "stderr.log");
  const patchPath = path.join(laneDir, "patch.diff");
  const resultPath = path.join(laneDir, "result.json");
  if (!command) {
    fs.writeFileSync(stdoutPath, "");
    fs.writeFileSync(stderrPath, "");
    fs.writeFileSync(patchPath, "");
    const result = {
      status: "not_run",
      exitCode: null,
      durationMs: 0,
      cwd: null,
      stdoutPath,
      stderrPath,
      patchPath,
      resultPath,
      preapproval: { status: "skipped", reason: "command not run" },
      completion: evaluateTaskCompletion({
        completionSpec,
        cwd: null,
        stdout: "",
        stderr: "",
        commandStatus: "not_run",
        reportedTotalTokens: null,
        durationMs: 0
      }),
      adapter
    };
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  const cwd = copyWorktree && root
    ? copyWorkspace(root, workspacePath || pairWorkspacePath({ laneDir, lane, pairId, taskId }), {
      mode: workspaceMode,
      allowedPaths: workspaceScopeFiles,
      lane,
      pairId,
      taskId,
      request
    })
    : root || process.cwd();
  const attach = adapter?.liveObserved ? attachMeasuredWorkspace(cwd) : { status: "skipped" };
  const approval = prepareLanePreapproval({
    cwd,
    lane,
    request,
    preapproval,
    adapter
  });
  const before = captureWorkspaceSnapshot(cwd);
  const started = Date.now();
  const commandTimeoutMs = normalizePositiveInt(
    process.env.SCOPELEASE_PAIR_COMMAND_TIMEOUT_MS || adapter?.commandTimeoutMs,
    0
  );
  const commandMetaPath = path.join(laneDir, "command-runner.json");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", AGENT_COMMAND_RUNNER_SOURCE], {
    cwd,
    env: {
      ...process.env,
      SCOPELEASE_PAIR_LANE: lane,
      SCOPELEASE_MEASURE_LANE: lane,
      SCOPELEASE_PAIR_ID: pairId,
      SCOPELEASE_WORK_INTENT: adapter?.workIntent || "",
      SCOPELEASE_RUN_ID: adapter?.runId || "",
      SCOPELEASE_TASK_ID: taskId,
      SCOPELEASE_PAIR_PROMPT_FILE: promptPath,
      SCOPELEASE_PAIR_WORKSPACE: cwd,
      SCOPELEASE_RUNNER_COMMAND: command,
      SCOPELEASE_RUNNER_TIMEOUT_MS: String(commandTimeoutMs),
      SCOPELEASE_RUNNER_METADATA_PATH: commandMetaPath
    },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...(commandTimeoutMs > 0 ? { timeout: commandTimeoutMs + 5000 } : {}),
    killSignal: "SIGKILL"
  });
  const durationMs = Date.now() - started;
  const commandMeta = readJsonIfExists(commandMetaPath) || {};
  const timedOut = Boolean(commandMeta.timedOut) || result.status === 124 || result.error?.code === "ETIMEDOUT";
  const processCleanup = commandMeta.cleanup || (
    timedOut ? { status: "unknown", reason: "runner timeout metadata missing" } : { status: "skipped", reason: "command did not time out" }
  );
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || result.error?.message || "");
  const reportedTokenPreset = String(adapter?.name || "").toLowerCase();
  const reportedTotalTokens = reportedTokenPreset === "claude"
    ? parseClaudeReportedTotalTokens(stdout)
    : parseCommandReportedTotalTokens(stderr);
  const reportedTotalTokenSource = reportedTotalTokens === null
    ? null
    : (reportedTokenPreset === "claude" ? "claude_cli_json_usage" : "codex_cli_stderr_tokens_used");
  const status = timedOut ? "timeout" : result.status === 0 ? "passed" : "failed";
  fs.writeFileSync(stdoutPath, stdout);
  fs.writeFileSync(stderrPath, stderr);
  const after = captureWorkspaceSnapshot(cwd);
  fs.writeFileSync(patchPath, renderSnapshotDiff(before, after));
  const observedImport = adapter?.liveObserved
    ? importObservedWorkspaceEvents({
      root,
      workspacePath: cwd,
      lane,
      pairId,
      workIntent: adapter?.workIntent || "",
      runId: adapter?.runId || "",
      taskId
    })
    : { status: "skipped" };
  const promptObservation = adapter?.liveObserved
    ? recordAgentCommandPromptObservation({
      root,
      lane,
      promptPath,
      request,
      pairId,
      workIntent: adapter?.workIntent || "",
      runId: adapter?.runId || "",
      taskId,
      promptTokens,
      promptChars,
      scopeleaseContextEmbedded,
      scopeleaseContextTokens,
      commandStatus: status
    })
    : { status: "skipped" };
  const quality = scoreCommandOutput({
    status,
    stdout,
    stderr,
    baselineFiles,
    workspaceMode
  });
  const completion = evaluateTaskCompletion({
    completionSpec,
    cwd,
    stdout,
    stderr,
    commandStatus: status,
    reportedTotalTokens,
    durationMs
  });
  const commandResult = {
    status,
    exitCode: result.status,
    signal: result.signal || null,
    durationMs,
    timeoutMs: commandTimeoutMs,
    processCleanup,
    runner: {
      status: result.status,
      signal: result.signal || null,
      metadataPath: commandMetaPath,
      timedOut: Boolean(commandMeta.timedOut),
      childPid: commandMeta.pid || null
    },
    cwd,
    stdoutPath,
    stderrPath,
    patchPath,
    resultPath,
    adapter,
    workspaceMode,
    workspaceScopeFiles: workspaceMode === "scoped_readplan" ? workspaceScopeFiles : [],
    reportedTotalTokens,
    reportedTotalTokenSource,
    quality,
    completion,
    attach,
    preapproval: approval,
    observedImport,
    promptObservation,
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr)
  };
  fs.writeFileSync(resultPath, `${JSON.stringify(commandResult, null, 2)}\n`);
  return commandResult;
}

function parseCommandReportedTotalTokens(stderr = "") {
  const matches = [...String(stderr || "").matchAll(/tokens used\s*\n\s*([0-9][0-9,]*)/gi)];
  if (!matches.length) return null;
  const value = Number(String(matches[matches.length - 1][1] || "").replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

// Claude Code with `--output-format json` (or stream-json) emits a final result
// object carrying a `usage` block. The command-reported total is the sum of the
// input, output, and cache token fields, analogous to the Codex "tokens used" total.
function parseClaudeReportedTotalTokens(stdout = "") {
  const text = String(stdout || "").trim();
  if (!text) return null;
  const sumUsage = (usage) => {
    if (!usage || typeof usage !== "object") return null;
    const total = [
      "input_tokens",
      "output_tokens",
      "cache_creation_input_tokens",
      "cache_read_input_tokens"
    ].reduce((sum, key) => sum + (Number(usage[key]) || 0), 0);
    return Number.isFinite(total) && total > 0 ? total : null;
  };
  const fromObject = (obj) => {
    if (!obj || typeof obj !== "object") return null;
    return sumUsage(obj.usage) ?? sumUsage(obj.result && obj.result.usage) ?? null;
  };
  // Whole-stdout JSON (--output-format json)
  try {
    const total = fromObject(JSON.parse(text));
    if (total !== null) return total;
  } catch {
    // fall through to line scan (stream-json)
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const total = fromObject(JSON.parse(lines[i]));
      if (total !== null) return total;
    } catch {
      // ignore non-JSON lines
    }
  }
  return null;
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function terminateDetachedCommandGroup(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { status: "unavailable", reason: "missing child pid" };
  }
  const groupPid = -pid;
  const attempts = [];
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    try {
      process.kill(groupPid, signal);
      attempts.push({ signal, status: "sent" });
    } catch (error) {
      if (error?.code === "ESRCH") attempts.push({ signal, status: "not_found" });
      else attempts.push({ signal, status: "failed", error: error?.message || String(error) });
    }
  }
  return { status: "attempted", pid, groupPid, attempts };
}

function scoreCommandOutput({
  status = "not_run",
  stdout = "",
  stderr = "",
  baselineFiles = [],
  workspaceMode = "full"
} = {}) {
  if (status === "not_run") {
    return {
      status: "not_run",
      score: 0,
      maxScore: 4,
      passed: false,
      signals: [],
      referencedFiles: [],
      missingSignals: [],
      boundary: "heuristic_command_output_quality_not_human_correctness"
    };
  }

  const output = `${stdout}\n${stderr}`;
  const referencedFiles = referencedBaselineFiles(output, baselineFiles);
  const missingSignals = missingContextSignals(output);
  const hasOutput = Boolean(String(stdout || "").trim() || String(stderr || "").trim());
  const signals = [];
  if (status === "passed") signals.push("command_passed");
  if (hasOutput) signals.push("non_empty_output");
  if (referencedFiles.length) signals.push("references_baseline_or_scope");
  if (!missingSignals.length) signals.push("no_missing_context_signal");
  if (workspaceMode === "scoped_readplan") signals.push("scoped_worktree");

  const score = [
    status === "passed",
    hasOutput,
    referencedFiles.length > 0,
    missingSignals.length === 0
  ].filter(Boolean).length;
  const passed = status === "passed" && score >= 3 && missingSignals.length === 0;

  return {
    status: passed ? "quality_pass" : "quality_review",
    score,
    maxScore: 4,
    passed,
    signals,
    referencedFiles,
    missingSignals,
    boundary: "heuristic_command_output_quality_not_human_correctness"
  };
}

function referencedBaselineFiles(output = "", baselineFiles = []) {
  const text = String(output || "").toLowerCase();
  const matched = [];
  const seen = new Set();
  for (const file of baselineFiles || []) {
    const normalized = normalizeWorkspaceScopePath(file);
    if (!normalized) continue;
    const candidates = [
      normalized.toLowerCase(),
      path.basename(normalized).toLowerCase()
    ].filter(Boolean);
    if (!candidates.some((candidate) => text.includes(candidate))) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    matched.push(normalized);
  }
  return matched.slice(0, 20);
}

function missingContextSignals(output = "") {
  const text = String(output || "");
  const patterns = [
    { signal: "missing_support_files", pattern: /missing support files/i },
    { signal: "cannot_find_module", pattern: /cannot find module/i },
    { signal: "enoent", pattern: /\bENOENT\b/i },
    { signal: "no_such_file", pattern: /no such file/i },
    { signal: "missing_context", pattern: /missing context/i },
    { signal: "context_cancelled", pattern: /context.*cancelled/i },
    { signal: "mcp_cancelled", pattern: /mcp.*cancelled/i }
  ];
  return patterns
    .filter(({ pattern }) => pattern.test(text))
    .map(({ signal }) => signal);
}

function evaluateTaskCompletion({
  completionSpec = null,
  cwd = null,
  stdout = "",
  stderr = "",
  commandStatus = "not_run",
  reportedTotalTokens = null,
  durationMs = 0
} = {}) {
  const spec = normalizeCompletionSpec(completionSpec);
  if (!spec) {
    return {
      configured: false,
      status: "not_configured",
      validSubmission: null,
      attempts: 0,
      tokensToCompletion: null,
      durationMs,
      checks: [],
      score: null,
      boundary: "no_task_specific_completion_rubric"
    };
  }

  const checks = [];
  const output = `${stdout}\n${stderr}`;
  if (spec.requireCommandPass !== false) {
    checks.push({
      id: "command_passed",
      ok: commandStatus === "passed",
      detail: commandStatus
    });
  }

  for (const relativePath of arrayFrom(spec.requiredFiles || spec.required_files)) {
    const filePath = resolveCompletionPath(cwd, relativePath);
    checks.push({
      id: `file_exists:${relativePath}`,
      ok: Boolean(filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()),
      path: relativePath
    });
  }

  for (const csvSpec of completionCsvSpecs(spec)) {
    checks.push(...evaluateCsvCompletion({ cwd, csvSpec }));
  }

  const score = evaluateScoreCompletion({ output, spec });
  if (score.configured) {
    checks.push({
      id: "score",
      ok: score.ok,
      value: score.value,
      target: score.target,
      operator: score.operator,
      pattern: score.pattern
    });
  }

  for (const requiredText of arrayFrom(spec.stdoutIncludes || spec.stdout_includes)) {
    checks.push({
      id: `stdout_includes:${String(requiredText).slice(0, 48)}`,
      ok: output.includes(String(requiredText)),
      value: requiredText
    });
  }

  const passed = checks.length > 0 && checks.every((check) => check.ok);
  const attempts = parseCompletionAttempts({ output, spec, commandStatus });
  const tokens = finiteOrNull(reportedTotalTokens);
  return {
    configured: true,
    status: passed ? "passed" : "failed",
    validSubmission: passed,
    attempts,
    tokensToCompletion: passed && tokens !== null ? tokens : null,
    durationMs,
    checks,
    score: score.configured ? {
      value: score.value,
      target: score.target,
      operator: score.operator,
      ok: score.ok
    } : null,
    boundary: "task_specific_completion_rubric_not_human_grade"
  };
}

function normalizeCompletionSpec(value = null) {
  if (!value || typeof value !== "object") return null;
  const hasSignal = [
    "requiredFiles",
    "required_files",
    "csv",
    "csvFiles",
    "csv_files",
    "score",
    "stdoutRegex",
    "stdout_regex",
    "stdoutIncludes",
    "stdout_includes"
  ].some((key) => value[key] !== undefined);
  return hasSignal ? value : null;
}

function completionCsvSpecs(spec = {}) {
  return [
    ...arrayFrom(spec.csv),
    ...arrayFrom(spec.csvFiles || spec.csv_files)
  ].filter((item) => item && typeof item === "object");
}

function evaluateCsvCompletion({ cwd = null, csvSpec = {} } = {}) {
  const checks = [];
  const relativePath = csvSpec.path || csvSpec.file || csvSpec.relativePath || "";
  const filePath = resolveCompletionPath(cwd, relativePath);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return [{
      id: `csv_exists:${relativePath}`,
      ok: false,
      path: relativePath,
      detail: "missing"
    }];
  }

  let parsed;
  try {
    parsed = parseSimpleCsv(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return [{
      id: `csv_parse:${relativePath}`,
      ok: false,
      path: relativePath,
      detail: error.message
    }];
  }

  checks.push({
    id: `csv_exists:${relativePath}`,
    ok: true,
    path: relativePath
  });
  const requiredColumns = arrayFrom(csvSpec.requiredColumns || csvSpec.columns || csvSpec.required_columns);
  for (const column of requiredColumns) {
    checks.push({
      id: `csv_column:${relativePath}:${column}`,
      ok: parsed.header.includes(String(column)),
      path: relativePath,
      column
    });
  }
  const minRows = finiteOrNull(csvSpec.minRows || csvSpec.min_rows);
  if (minRows !== null) {
    checks.push({
      id: `csv_min_rows:${relativePath}`,
      ok: parsed.rows.length >= minRows,
      path: relativePath,
      rows: parsed.rows.length,
      minRows
    });
  }
  return checks;
}

function parseSimpleCsv(text = "") {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return { header: [], rows: [] };
  const header = splitSimpleCsvLine(lines[0]).map((item) => item.trim());
  return {
    header,
    rows: lines.slice(1).map(splitSimpleCsvLine)
  };
}

function splitSimpleCsvLine(line = "") {
  const cells = [];
  let current = "";
  let quoted = false;
  const text = String(line || "");
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' && text[index + 1] === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

function evaluateScoreCompletion({ output = "", spec = {} } = {}) {
  const scoreSpec = spec.score && typeof spec.score === "object" ? spec.score : {};
  const pattern = scoreSpec.pattern || scoreSpec.stdoutRegex || scoreSpec.stdout_regex || spec.stdoutRegex || spec.stdout_regex || "";
  if (!pattern) return { configured: false };
  let regex;
  try {
    regex = new RegExp(pattern, scoreSpec.flags || "");
  } catch (error) {
    return {
      configured: true,
      ok: false,
      value: null,
      target: null,
      operator: "invalid_regex",
      pattern,
      error: error.message
    };
  }
  const match = String(output || "").match(regex);
  const value = match ? finiteOrNull(match[1] || match[0]) : null;
  const target = finiteOrNull(scoreSpec.target ?? scoreSpec.min ?? spec.minScore ?? spec.min_score);
  const max = finiteOrNull(scoreSpec.max ?? spec.maxScore ?? spec.max_score);
  const higherIsBetter = scoreSpec.higherIsBetter !== false && spec.higherIsBetter !== false;
  let ok = value !== null;
  let operator = "exists";
  if (ok && target !== null) {
    operator = higherIsBetter ? ">=" : "<=";
    ok = higherIsBetter ? value >= target : value <= target;
  }
  if (ok && max !== null) {
    operator = operator === "exists" ? "<=" : `${operator} and <=`;
    ok = value <= max;
  }
  return {
    configured: true,
    ok,
    value,
    target: target ?? max,
    operator,
    pattern
  };
}

function parseCompletionAttempts({ output = "", spec = {}, commandStatus = "" } = {}) {
  const patterns = arrayFrom(spec.attemptsPattern || spec.attemptsRegex || spec.attempt_pattern || spec.attempts_regex);
  const effectivePatterns = [
    ...patterns,
    "attempts?\\s*(?:used)?\\s*[:=]\\s*`?([0-9]+)`?",
    "attempts?\\s+used\\s*[:=]?\\s*`?([0-9]+)`?"
  ];
  for (const pattern of effectivePatterns) {
    try {
      const match = String(output || "").match(new RegExp(pattern, "i"));
      const attempts = match ? numericCapture(match[1] || match[0]) : null;
      if (attempts !== null) return attempts;
    } catch {}
  }
  return commandStatus === "not_run" ? 0 : 1;
}

function numericCapture(value = "") {
  const direct = finiteOrNull(value);
  if (direct !== null) return direct;
  const match = String(value || "").match(/([0-9]+(?:\.[0-9]+)?)/);
  return match ? finiteOrNull(match[1]) : null;
}

function resolveCompletionPath(cwd = null, relativePath = "") {
  const normalized = normalizeWorkspaceScopePath(relativePath);
  if (!cwd || !normalized) return "";
  const resolved = path.resolve(cwd, normalized);
  return isSameOrInsidePath(resolved, cwd) ? resolved : "";
}

function arrayFrom(value) {
  if (value === undefined || value === null || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function copyWorkspace(root, target, options = {}) {
  if (!target || isInsidePath(root, target)) {
    target = pairWorkspacePath({ laneDir: path.join(os.tmpdir(), "scopelease-pair-worktrees"), lane: "safe", pairId: shortHash(`${root}:${Date.now()}`), taskId: "workspace" });
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  if (options.mode === "scoped_readplan") {
    copyScopedWorkspace(root, target, options);
    return target;
  }
  fs.cpSync(root, target, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(root, source).split(path.sep).join("/");
      if (!relative) return true;
      if (shouldStripDefaultBaselineInstruction(relative, options)) return false;
      return !shouldIgnorePairSnapshotPath(relative);
    }
  });
  return target;
}

function copyScopedWorkspace(root, target, {
  allowedPaths = [],
  lane = "",
  pairId = "",
  taskId = "",
  request = ""
} = {}) {
  const copied = [];
  const missing = [];
  const skipped = [];
  for (const relativePath of allowedPaths || []) {
    const normalized = normalizeWorkspaceScopePath(relativePath);
    if (!normalized) continue;
    const source = path.resolve(root, normalized);
    if (!isSameOrInsidePath(source, root)) {
      skipped.push(normalized);
      continue;
    }
    if (!fs.existsSync(source)) {
      missing.push(normalized);
      continue;
    }
    const stat = fs.statSync(source);
    if (stat.isDirectory()) {
      copyScopedDirectory(root, target, normalized, copied, skipped);
      continue;
    }
    if (!stat.isFile()) {
      skipped.push(normalized);
      continue;
    }
    copyScopedFile(root, target, normalized, copied);
  }
  const manifest = {
    kind: "scopelease.scoped_worktree",
    mode: "scoped_readplan",
    generatedAt: new Date().toISOString(),
    lane,
    pairId,
    taskId,
    request,
    files: copied,
    missing,
    skipped,
    note: "Only listed files were copied from the source repository. Missing files must be requested explicitly instead of broad-scanning outside scope."
  };
  fs.writeFileSync(path.join(target, ".scopelease-workspace-scope.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function copyScopedDirectory(root, target, relativeDir, copied, skipped) {
  const sourceDir = path.resolve(root, relativeDir);
  for (const entry of walkScopedFiles(sourceDir)) {
    const relativePath = path.relative(root, entry).split(path.sep).join("/");
    if (!relativePath || shouldIgnorePairSnapshotPath(relativePath)) {
      skipped.push(relativePath);
      continue;
    }
    copyScopedFile(root, target, relativePath, copied);
  }
}

function walkScopedFiles(dir) {
  const output = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...walkScopedFiles(fullPath));
    else if (entry.isFile()) output.push(fullPath);
  }
  return output;
}

function copyScopedFile(root, target, relativePath, copied) {
  if (shouldIgnorePairSnapshotPath(relativePath)) return;
  const source = path.resolve(root, relativePath);
  const destination = path.resolve(target, relativePath);
  if (!isSameOrInsidePath(source, root) || !isSameOrInsidePath(destination, target)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  copied.push(relativePath);
}

function attachMeasuredWorkspace(workspacePath = "") {
  if (!workspacePath) return { status: "skipped", reason: "missing workspace" };
  const cli = pairHarnessCliPath();
  const result = spawnSync(process.execPath, [cli, "attach", workspacePath], {
    cwd: workspacePath,
    env: {
      ...process.env,
      SCOPELEASE_DISABLE_TIKTOKEN: process.env.SCOPELEASE_DISABLE_TIKTOKEN || "1"
    },
    encoding: "utf8",
    timeout: 30000
  });
  return {
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status,
    signal: result.signal || null,
    error: result.error?.message || "",
    stdoutTail: tail(result.stdout || ""),
    stderrTail: tail(result.stderr || "")
  };
}

function prepareLanePreapproval({
  cwd = "",
  lane = "",
  request = "",
  preapproval = {},
  adapter = {}
} = {}) {
  if (!preapproval?.enabled) return { status: "skipped", reason: preapproval?.reason || "disabled" };
  if (lane !== "scopelease-codex") return { status: "skipped", reason: "not_scopelease_lane" };
  if (!cwd) return { status: "failed", reason: "missing workspace" };
  const action = preapproval.action || {};
  if (!Array.isArray(action.paths) || !action.paths.length) {
    return { status: "failed", reason: "missing scoped action paths", action };
  }

  try {
    const analysis = analyzeRepository(cwd, {
      budget: Number(preapproval.budget || 8000),
      userRequest: request || preapproval.request || ""
    });
    const state = loadState(cwd) || {};
    const guardVerdict = evaluateAgentAction({ action, analysis, state });
    if (guardVerdict.verdict === "allow_with_log") {
      return {
        status: "already_allowed",
        verdict: guardVerdict.verdict,
        reason: guardVerdict.reason,
        leaseId: guardVerdict.leaseId || null,
        action
      };
    }
    if (guardVerdict.verdict !== "ask_once" || !guardVerdict.decisionBundle) {
      return {
        status: "not_created",
        verdict: guardVerdict.verdict,
        reason: guardVerdict.reason || "guard did not request approval",
        action
      };
    }
    const lease = approveDecisionBundle({
      analysis,
      state,
      decisionBundle: guardVerdict.decisionBundle,
      choiceId: preapproval.choiceId || guardVerdict.decisionBundle.defaultVerdict || "allow_scoped_patch",
      grantedBy: "pair-harness-preapproval"
    });
    saveState(cwd, {
      ...state,
      approvalLeases: compactApprovalLeases([lease, ...(state.approvalLeases || [])])
    });
    return {
      status: "created",
      mode: preapproval.mode || "approval_lease_available",
      boundary: preapproval.boundary || "precreated_scoped_approval_lease_for_scopelease_lane",
      leaseId: lease.id,
      choiceId: lease.choiceId,
      verdict: guardVerdict.verdict,
      requestHash: lease.requestHash,
      baselineHash: lease.baselineHash,
      fileScopes: lease.fileScopes || [],
      commandScopes: lease.commandScopes || [],
      action,
      runId: adapter?.runId || ""
    };
  } catch (error) {
    return {
      status: "failed",
      reason: error.message,
      action
    };
  }
}

function compactApprovalLeases(leases = []) {
  const seen = new Set();
  const now = Date.now();
  const output = [];
  for (const lease of leases || []) {
    if (!lease?.id || seen.has(lease.id)) continue;
    if (lease.expiresAt && Date.parse(lease.expiresAt) < now) continue;
    seen.add(lease.id);
    output.push(lease);
    if (output.length >= 40) break;
  }
  return output;
}

function importObservedWorkspaceEvents({ root = "", workspacePath = "", lane = "", pairId = "", workIntent = "", runId = "", taskId = "" } = {}) {
  if (!root || !workspacePath || path.resolve(root) === path.resolve(workspacePath)) {
    return { status: "skipped", reason: "not a copied workspace" };
  }
  const sourceState = loadState(workspacePath) || {};
  const actual = (sourceState.actualWorkEvents || [])
    .filter((event) => observedEventMatches(event, { lane, pairId, workIntent, runId }))
    .map((event) => importedObservedEvent(event, { workspacePath, taskId, kind: "actual" }));
  const mcp = (sourceState.mcpContextEvents || [])
    .filter((event) => observedEventMatches(event, { lane: "scopelease-codex", pairId, workIntent, runId }))
    .map((event) => importedObservedEvent(event, { workspacePath, taskId, kind: "mcp" }));

  if (!actual.length && !mcp.length) {
    return {
      status: "empty",
      actualWorkEvents: 0,
      mcpContextEvents: 0,
      statePath: path.join(workspacePath, ".decision", "state.json")
    };
  }

  const state = loadState(root) || {};
  saveState(root, {
    ...state,
    actualWorkEvents: mergeImportedEvents(actual, state.actualWorkEvents || [], 2000),
    mcpContextEvents: mergeImportedEvents(mcp, state.mcpContextEvents || [], 500)
  });
  return {
    status: "imported",
    actualWorkEvents: actual.length,
    mcpContextEvents: mcp.length,
    statePath: path.join(workspacePath, ".decision", "state.json")
  };
}

function recordAgentCommandPromptObservation({
  root = "",
  lane = "",
  promptPath = "",
  request = "",
  pairId = "",
  workIntent = "",
  runId = "",
  taskId = "",
  promptTokens = null,
  promptChars = null,
  scopeleaseContextEmbedded = false,
  scopeleaseContextTokens = 0,
  commandStatus = ""
} = {}) {
  if (!root || !promptPath) return { status: "skipped", reason: "missing root or prompt" };
  let text = "";
  try {
    text = fs.readFileSync(promptPath, "utf8");
  } catch (error) {
    return { status: "failed", error: error.message };
  }
  const tokenResult = Number.isFinite(Number(promptTokens))
    ? { counts: [Number(promptTokens)], tokenizer: { exact: false, method: "pair-harness", encoding: "observed_prompt_tokens" } }
    : countTokensForTexts([text]);
  const tokens = tokenResult.counts[0] || 0;
  const event = {
    kind: "scopelease.actual_work_event",
    id: `agent_prompt_${shortHash(`${promptPath}:${lane}:${pairId}:${runId}:${hashText(text)}`)}`,
    timestamp: new Date().toISOString(),
    userRequest: request,
    requestKey: normalizeRequestKey(request),
    requestHash: requestHash(request),
    workIntent,
    pairingKey: workIntent,
    taskIntent: buildTaskIntent({ request, text, workIntent }, { pairId }),
    lane,
    pairId,
    runId,
    phase: "input",
    source: "agent-command:prompt",
    label: `${lane} actual command prompt`,
    promptPath,
    promptHash: `sha1:${hashText(text)}`,
    tokenCounter: tokenResult.tokenizer?.exact
      ? `${tokenResult.tokenizer.method || "tiktoken"}:${tokenResult.tokenizer.encoding || ""}`
      : "fallback",
    tokenizer: {
      exact: tokenResult.tokenizer?.exact === true,
      method: tokenResult.tokenizer?.method || "unknown",
      encoding: tokenResult.tokenizer?.encoding || "",
      source: tokenResult.tokenizer?.source || ""
    },
    tokens,
    chars: Number.isFinite(Number(promptChars)) ? Number(promptChars) : text.length,
    baselineTokens: 0,
    baselineDeltaTokens: 0,
    baselineDeltaPercent: null,
    baselineComparisonMeasured: false,
    scopeleaseContextEmbedded: Boolean(scopeleaseContextEmbedded),
    scopeleaseContextTokens: Math.max(0, Number(scopeleaseContextTokens || 0)),
    pairTaskId: taskId,
    commandStatus,
    note: scopeleaseContextEmbedded
      ? "Actual command prompt included ScopeLease compact context. This is prompt-observed agent input, not an MCP tool-call event."
      : "Actual command prompt sent to the agent command. This is prompt-observed agent input, not hidden provider billing."
  };
  const state = loadState(root) || {};
  saveState(root, {
    ...state,
    actualWorkEvents: mergeImportedEvents([event], state.actualWorkEvents || [], 2000)
  });
  return {
    status: "recorded",
    source: event.source,
    tokens,
    chars: event.chars,
    scopeleaseContextEmbedded: event.scopeleaseContextEmbedded,
    scopeleaseContextTokens: event.scopeleaseContextTokens
  };
}

function observedEventMatches(event = {}, { lane = "", pairId = "", workIntent = "", runId = "" } = {}) {
  if (!event || typeof event !== "object") return false;
  const eventLane = String(event.lane || "").trim();
  if (lane && eventLane !== lane) return false;
  const expectedPairId = String(pairId || "").trim();
  const eventPairId = String(event.pairId || event.meta?.pairId || "").trim();
  if (expectedPairId) {
    if (eventPairId !== expectedPairId) return false;
    return true;
  }
  const eventIntent = String(event.workIntent || event.pairingKey || event.meta?.workIntent || "").trim();
  if (workIntent && eventIntent !== workIntent) return false;
  const eventRunId = String(event.runId || event.meta?.runId || "").trim();
  if (runId && eventRunId && eventRunId !== runId) return false;
  return true;
}

function importedObservedEvent(event = {}, { workspacePath = "", taskId = "", kind = "actual" } = {}) {
  const sourceId = String(event.id || hashText(JSON.stringify(event))).trim();
  return {
    ...event,
    id: `imported_${kind}_${shortHash(`${workspacePath}:${sourceId}`)}`,
    importedFromWorkspace: workspacePath,
    importedAt: new Date().toISOString(),
    pairTaskId: taskId,
    importSourceId: sourceId
  };
}

function mergeImportedEvents(incoming = [], existing = [], limit = 1000) {
  const rows = [...incoming, ...existing];
  const seen = new Set();
  const output = [];
  for (const row of rows) {
    const key = row.id || hashText(JSON.stringify({
      source: row.source,
      lane: row.lane,
      pairId: row.pairId,
      runId: row.runId,
      phase: row.phase,
      timestamp: row.timestamp,
      tokens: row.tokens
    }));
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(row);
    if (output.length >= limit) break;
  }
  return output;
}

function pairHarnessCliPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../cli.js");
}

function pairWorkspacePath({ laneDir = "", lane = "", pairId = "", taskId = "" } = {}) {
  const seed = shortHash(`${laneDir}:${lane}:${pairId}:${taskId}`);
  return path.join(os.tmpdir(), "scopelease-pair-worktrees", `${safeName(taskId)}-${safeName(lane)}-${seed}`);
}

function isInsidePath(parent = "", child = "") {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isSameOrInsidePath(candidate = "", parent = "") {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function summarizePairRows(rows = []) {
  const defaultTokens = rows.reduce((sum, row) => sum + row.defaultTokens, 0);
  const scopeleaseTokens = rows.reduce((sum, row) => sum + row.scopeleaseTokens, 0);
  const savedTokens = defaultTokens - scopeleaseTokens;
  const percents = rows
    .map((row) => row.savedPercent)
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  const defaultDecisionPrompts = rows.reduce((sum, row) => sum + (row.decisionMetrics?.defaultDecisionPrompts || 0), 0);
  const scopeleaseDecisionPrompts = rows.reduce((sum, row) => sum + (row.decisionMetrics?.scopeleaseDecisionPrompts || 0), 0);
  const reducedDecisionPrompts = Math.max(0, defaultDecisionPrompts - scopeleaseDecisionPrompts);
  const commandReportedTotalTokens = summarizeCommandReportedPairDeltas(rows);
  const commandQuality = summarizeCommandQuality(rows);
  const taskCompletion = summarizeTaskCompletionPairDeltas(rows);
  const promptSavedPercentDistribution = summarizePercentDistribution(percents);
  return {
    measuredPairs: rows.length,
    defaultTokens,
    scopeleaseTokens,
    savedTokens,
    savedPercent: defaultTokens > 0 ? Math.round((savedTokens / defaultTokens) * 100) : null,
    medianSavedPercent: median(percents),
    promptSavedPercentDistribution,
    defaultDecisionPrompts,
    scopeleaseDecisionPrompts,
    reducedDecisionPrompts,
    decisionPromptReductionPercent: defaultDecisionPrompts > 0
      ? Math.round((reducedDecisionPrompts / defaultDecisionPrompts) * 100)
      : null,
    commandReportedTotalTokens,
    commandQuality,
    taskCompletion
  };
}

function reportedTokenSourceFor(defaultEvent = {}, scopeleaseEvent = {}) {
  const sources = [defaultEvent.command?.reportedTotalTokenSource, scopeleaseEvent.command?.reportedTotalTokenSource]
    .filter(Boolean);
  if (!sources.length) return "unavailable";
  const unique = [...new Set(sources)];
  return unique.length === 1 ? unique[0] : unique.join("+");
}

function buildCommandReportedPairDelta(defaultEvent = {}, scopeleaseEvent = {}) {
  const defaultTokens = finiteOrNull(defaultEvent.command?.reportedTotalTokens);
  const scopeleaseTokens = finiteOrNull(scopeleaseEvent.command?.reportedTotalTokens);
  const measured = defaultTokens !== null && scopeleaseTokens !== null && defaultTokens > 0 && scopeleaseTokens > 0;
  const savedTokens = measured ? defaultTokens - scopeleaseTokens : null;
  return {
    kind: "scopelease.command_reported_total_token_delta",
    boundary: "command_reported_total_tokens_not_provider_billing",
    source: measured ? reportedTokenSourceFor(defaultEvent, scopeleaseEvent) : "unavailable",
    status: measured ? "measured" : "incomplete",
    defaultTokens,
    scopeleaseTokens,
    savedTokens,
    savedPercent: measured && defaultTokens > 0 ? roundPercent(savedTokens / defaultTokens) : null,
    deltaDirection: deltaDirection(savedTokens),
    canClaimCommandReportedSavings: measured && savedTokens > 0,
    incompleteReason: measured ? "" : "both lanes must report positive command total tokens"
  };
}

function buildTaskCompletionPairDelta(defaultEvent = {}, scopeleaseEvent = {}) {
  const defaultCompletion = defaultEvent.command?.completion || {};
  const scopeleaseCompletion = scopeleaseEvent.command?.completion || {};
  const configured = Boolean(defaultCompletion.configured || scopeleaseCompletion.configured);
  if (!configured) {
    return {
      kind: "scopelease.task_completion_delta",
      boundary: "task_specific_completion_rubric_not_human_grade",
      status: "not_configured",
      measured: false,
      defaultCompleted: null,
      scopeleaseCompleted: null,
      bothCompleted: false,
      tokensToCompletion: null,
      attemptsToCompletion: null
    };
  }

  const defaultCompleted = defaultCompletion.status === "passed";
  const scopeleaseCompleted = scopeleaseCompletion.status === "passed";
  const defaultTokens = finiteOrNull(defaultCompletion.tokensToCompletion);
  const scopeleaseTokens = finiteOrNull(scopeleaseCompletion.tokensToCompletion);
  const bothCompleted = defaultCompleted && scopeleaseCompleted;
  const tokenMeasured = bothCompleted && defaultTokens !== null && scopeleaseTokens !== null && defaultTokens > 0 && scopeleaseTokens > 0;
  const savedTokens = tokenMeasured ? defaultTokens - scopeleaseTokens : null;
  const defaultAttempts = finiteOrNull(defaultCompletion.attempts);
  const scopeleaseAttempts = finiteOrNull(scopeleaseCompletion.attempts);
  const attemptMeasured = bothCompleted && defaultAttempts !== null && scopeleaseAttempts !== null;
  const savedAttempts = attemptMeasured ? defaultAttempts - scopeleaseAttempts : null;
  return {
    kind: "scopelease.task_completion_delta",
    boundary: "task_specific_completion_rubric_not_human_grade",
    status: bothCompleted ? "both_completed" : defaultCompleted || scopeleaseCompleted ? "partial_completion" : "failed_completion",
    measured: true,
    defaultCompleted,
    scopeleaseCompleted,
    bothCompleted,
    defaultStatus: defaultCompletion.status || "unknown",
    scopeleaseStatus: scopeleaseCompletion.status || "unknown",
    tokensToCompletion: tokenMeasured ? {
      defaultTokens,
      scopeleaseTokens,
      savedTokens,
      savedPercent: roundPercent(savedTokens / defaultTokens),
      deltaDirection: deltaDirection(savedTokens),
      canClaimCompletionTokenSavings: savedTokens > 0
    } : null,
    attemptsToCompletion: attemptMeasured ? {
      defaultAttempts,
      scopeleaseAttempts,
      savedAttempts,
      savedPercent: defaultAttempts > 0 ? roundPercent(savedAttempts / defaultAttempts) : null,
      deltaDirection: deltaDirection(savedAttempts)
    } : null,
    defaultScore: defaultCompletion.score || null,
    scopeleaseScore: scopeleaseCompletion.score || null,
    defaultChecks: defaultCompletion.checks || [],
    scopeleaseChecks: scopeleaseCompletion.checks || []
  };
}

function summarizeTaskCompletionPairDeltas(rows = []) {
  const measured = rows
    .map((row) => row.taskCompletion)
    .filter((item) => item?.measured);
  const tokenPairs = measured
    .map((item) => item.tokensToCompletion)
    .filter(Boolean);
  const attemptPairs = measured
    .map((item) => item.attemptsToCompletion)
    .filter(Boolean);
  const defaultTokens = tokenPairs.reduce((sum, item) => sum + Number(item.defaultTokens || 0), 0);
  const scopeleaseTokens = tokenPairs.reduce((sum, item) => sum + Number(item.scopeleaseTokens || 0), 0);
  const savedTokens = defaultTokens - scopeleaseTokens;
  const defaultAttempts = attemptPairs.reduce((sum, item) => sum + Number(item.defaultAttempts || 0), 0);
  const scopeleaseAttempts = attemptPairs.reduce((sum, item) => sum + Number(item.scopeleaseAttempts || 0), 0);
  const savedAttempts = defaultAttempts - scopeleaseAttempts;
  const percents = tokenPairs
    .map((item) => item.savedPercent)
    .filter((value) => Number.isFinite(value));
  return {
    boundary: "task_specific_completion_rubric_not_human_grade",
    measuredPairs: measured.length,
    bothCompletedPairs: measured.filter((item) => item.bothCompleted).length,
    defaultCompletedPairs: measured.filter((item) => item.defaultCompleted).length,
    scopeleaseCompletedPairs: measured.filter((item) => item.scopeleaseCompleted).length,
    scopeleaseOnlyCompletedPairs: measured.filter((item) => item.scopeleaseCompleted && !item.defaultCompleted).length,
    defaultOnlyCompletedPairs: measured.filter((item) => item.defaultCompleted && !item.scopeleaseCompleted).length,
    failedBothPairs: measured.filter((item) => !item.defaultCompleted && !item.scopeleaseCompleted).length,
    completionTokenPairs: tokenPairs.length,
    tokensToCompletion: {
      defaultTokens,
      scopeleaseTokens,
      savedTokens: tokenPairs.length ? savedTokens : null,
      savedPercent: tokenPairs.length && defaultTokens > 0 ? roundPercent(savedTokens / defaultTokens) : null,
      macroMeanSavedPercent: summarizePercentDistribution(percents).mean,
      positivePairs: tokenPairs.filter((item) => Number(item.savedTokens || 0) > 0).length,
      overheadPairs: tokenPairs.filter((item) => Number(item.savedTokens || 0) < 0).length
    },
    attemptPairs: attemptPairs.length,
    attemptsToCompletion: {
      defaultAttempts,
      scopeleaseAttempts,
      savedAttempts: attemptPairs.length ? savedAttempts : null,
      savedPercent: attemptPairs.length && defaultAttempts > 0 ? roundPercent(savedAttempts / defaultAttempts) : null,
      positivePairs: attemptPairs.filter((item) => Number(item.savedAttempts || 0) > 0).length,
      overheadPairs: attemptPairs.filter((item) => Number(item.savedAttempts || 0) < 0).length
    },
    claimCaution: "completion-token savings are claimable only for pairs where both lanes satisfy the same task-specific completion rubric"
  };
}

function summarizeCommandReportedPairDeltas(rows = []) {
  const measured = rows
    .map((row) => row.commandReportedTotalTokens)
    .filter((item) => item?.status === "measured");
  const defaultTokens = measured.reduce((sum, item) => sum + Number(item.defaultTokens || 0), 0);
  const scopeleaseTokens = measured.reduce((sum, item) => sum + Number(item.scopeleaseTokens || 0), 0);
  const savedTokens = defaultTokens - scopeleaseTokens;
  const percents = measured
    .map((item) => item.savedPercent)
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  const distribution = summarizePercentDistribution(percents);
  const measuredSources = [...new Set(measured.map((item) => item.source).filter(Boolean))];
  return {
    boundary: "command_reported_total_tokens_not_provider_billing",
    source: measured.length ? (measuredSources.length ? measuredSources.join("+") : "command_reported_total_tokens") : "unavailable",
    measuredPairs: measured.length,
    defaultTokens,
    scopeleaseTokens,
    savedTokens: measured.length ? savedTokens : null,
    savedPercent: measured.length && defaultTokens > 0 ? roundPercent(savedTokens / defaultTokens) : null,
    medianSavedPercent: median(percents),
    macroMeanSavedPercent: distribution.mean,
    q1SavedPercent: distribution.q1,
    q3SavedPercent: distribution.q3,
    minSavedPercent: distribution.min,
    maxSavedPercent: distribution.max,
    distribution,
    positivePairs: measured.filter((item) => Number(item.savedTokens || 0) > 0).length,
    overheadPairs: measured.filter((item) => Number(item.savedTokens || 0) < 0).length,
    claimCaution: "weighted aggregate savings can be positive while median or macro mean is negative; report both before claiming general savings"
  };
}

function summarizeCommandQuality(rows = []) {
  const qualities = [];
  for (const row of rows || []) {
    for (const event of row.events || []) {
      const quality = event.command?.quality;
      if (!quality || quality.status === "not_run") continue;
      qualities.push({
        lane: event.lane,
        taskId: event.taskId,
        status: quality.status,
        passed: Boolean(quality.passed),
        score: Number(quality.score || 0),
        maxScore: Number(quality.maxScore || 4),
        missingSignals: quality.missingSignals || []
      });
    }
  }
  const totalScore = qualities.reduce((sum, item) => sum + item.score, 0);
  const totalMaxScore = qualities.reduce((sum, item) => sum + item.maxScore, 0);
  return {
    boundary: "heuristic_command_output_quality_not_human_correctness",
    measuredLanes: qualities.length,
    passedLanes: qualities.filter((item) => item.passed).length,
    reviewNeededLanes: qualities.filter((item) => !item.passed).length,
    passRate: qualities.length ? roundPercent(qualities.filter((item) => item.passed).length / qualities.length) : null,
    scorePercent: totalMaxScore > 0 ? roundPercent(totalScore / totalMaxScore) : null,
    missingContextSignalLanes: qualities.filter((item) => item.missingSignals.length > 0).length
  };
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundPercent(value) {
  return Math.round(value * 10000) / 100;
}

function roundNumber(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const scale = 10 ** digits;
  return Math.round(number * scale) / scale;
}

function summarizePercentDistribution(values = []) {
  const sorted = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (!sorted.length) {
    return {
      count: 0,
      mean: null,
      median: null,
      q1: null,
      q3: null,
      min: null,
      max: null
    };
  }
  return {
    count: sorted.length,
    mean: roundNumber(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    median: roundNumber(quantile(sorted, 0.5)),
    q1: roundNumber(quantile(sorted, 0.25)),
    q3: roundNumber(quantile(sorted, 0.75)),
    min: roundNumber(sorted[0]),
    max: roundNumber(sorted[sorted.length - 1])
  };
}

function quantile(sortedValues = [], p = 0.5) {
  if (!sortedValues.length) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const position = (sortedValues.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  const weight = position - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function deltaDirection(deltaTokens) {
  if (!Number.isFinite(Number(deltaTokens))) return "unmeasured";
  if (deltaTokens > 0) return "savings";
  if (deltaTokens < 0) return "overhead";
  return "flat";
}

function summarizeAgentAdapters(rows = []) {
  const adapters = new Map();
  for (const row of rows) {
    for (const event of row.events || []) {
      const adapter = event.command?.adapter || {};
      const key = `${event.lane}:${adapter.name || "none"}`;
      const current = adapters.get(key) || {
        lane: event.lane,
        name: adapter.name || "none",
        configured: 0,
        passed: 0,
        failed: 0,
        timeout: 0,
        notRun: 0
      };
      const status = event.command?.status || "not_run";
      if (status === "not_run") current.notRun += 1;
      else {
        current.configured += 1;
        if (status === "passed") current.passed += 1;
        else if (status === "timeout") current.timeout += 1;
        else current.failed += 1;
      }
      adapters.set(key, current);
    }
  }
  return [...adapters.values()];
}

function compactPairRow(row = {}) {
  const { events, ...rest } = row;
  return {
    ...rest,
    eventCount: events?.length || 0
  };
}

function hasAgentCommand(options = {}) {
  return Boolean(
    options.agentCommand ||
    options["agent-command"] ||
    options.defaultCommand ||
    options["default-command"] ||
    options.scopeleaseCommand ||
    options["scopelease-command"] ||
    options.agent ||
    options["agent-adapter"] ||
    options.defaultAgent ||
    options["default-agent"] ||
    options.scopeleaseAgent ||
    options["scopelease-agent"] ||
    options.agentTemplate ||
    options["agent-template"] ||
    options.defaultAgentTemplate ||
    options["default-agent-template"] ||
    options.scopeleaseAgentTemplate ||
    options["scopelease-agent-template"]
  );
}

function recordHarnessState(options = {}) {
  return options.recordState !== false && options["no-record-state"] !== true;
}

function writeJsonl(filePath, rows = []) {
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
}

function captureWorkspaceSnapshot(root) {
  const files = {};
  const maxFileBytes = 256 * 1024;
  const maxTotalBytes = 4 * 1024 * 1024;
  let totalBytes = 0;

  function visit(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(root, fullPath).split(path.sep).join("/");
      if (!relativePath || shouldIgnorePairSnapshotPath(relativePath)) continue;
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.size > maxFileBytes || totalBytes + stat.size > maxTotalBytes || !isTextFile(fullPath)) continue;
      const text = fs.readFileSync(fullPath, "utf8");
      files[relativePath] = text;
      totalBytes += Buffer.byteLength(text);
    }
  }

  visit(root);
  return files;
}

function renderSnapshotDiff(before = {}, after = {}) {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const sections = [];
  for (const filePath of paths) {
    if (before[filePath] === after[filePath]) continue;
    const status = before[filePath] === undefined ? "added" : after[filePath] === undefined ? "deleted" : "modified";
    sections.push(`diff --scopelease ${filePath}`);
    sections.push(`status: ${status}`);
    sections.push("--- before");
    sections.push(truncateDiffContent(before[filePath] || ""));
    sections.push("+++ after");
    sections.push(truncateDiffContent(after[filePath] || ""));
    sections.push("");
  }
  return sections.length ? `${sections.join("\n")}\n` : "";
}

function shouldIgnorePairSnapshotPath(relativePath = "") {
  return /^(?:\.git|\.scopelease|\.decision|\.codex|\.claude|node_modules|dist|build|coverage|__MACOSX)(?:\/|$)/.test(relativePath) ||
    /^(?:\.venv[^/]*|venv|\.tox|\.pytest_cache|\.mypy_cache|\.ruff_cache|__pycache__)(?:\/|$)/.test(relativePath) ||
    /^(?:\.ai_os_queue|\.ai_research_os_cache|\.tmp|tmp|output|outputs|artifacts|archive)(?:\/|$)/.test(relativePath) ||
    /(?:^|\/)__pycache__(?:\/|$)/.test(relativePath) ||
    /(?:^|\/)\.DS_Store$/.test(relativePath);
}

function shouldStripDefaultBaselineInstruction(relativePath = "", options = {}) {
  if (options.lane !== "default-codex") return false;
  const value = String(relativePath || "").replace(/\\/g, "/");
  return value === "AGENTS.md";
}

function isTextFile(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    return !buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0);
  } catch {
    return false;
  }
}

function truncateDiffContent(text = "", max = 12000) {
  const value = String(text || "");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n[scopelease truncated ${value.length - max} chars]\n`;
}

function normalizePositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function median(values = []) {
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : Math.round((values[middle - 1] + values[middle]) / 2);
}

function shortHash(value = "") {
  return createHash("sha1").update(String(value)).digest("hex").slice(0, 10);
}

function hashText(value = "") {
  return createHash("sha1").update(String(value)).digest("hex");
}

function timestampId() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}

function safeName(value = "") {
  return String(value || "task").replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80) || "task";
}

function tail(value = "", max = 2400) {
  const text = String(value || "");
  return text.length > max ? text.slice(-max) : text;
}
