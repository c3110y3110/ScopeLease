import fs from "node:fs";
import path from "node:path";
import { buildAgentInputPayload } from "./artifacts.js";
import { buildAdaptiveContext } from "./adaptive-context.js";
import { analyzeRepository } from "./repository.js";
import { countTokensForTexts } from "./tokenizer.js";

export function evaluateBenchTokenSavings(repoPath, options = {}) {
  const root = path.resolve(repoPath || ".");
  const tasks = loadBenchTasks(options.tasksPath || options.tasks || "");
  const limit = normalizeLimit(options.limit, tasks.length);
  const selected = tasks.slice(0, limit);
  const rows = selected.map((task, index) => evaluateBenchTask(root, task, {
    budget: Number(options.budget || task.budget || 8000),
    baselineMode: options.baselineMode || task.baselineMode || "explicit",
    index
  }));
  return {
    kind: "scopelease.bench_token_savings",
    boundary: "agent_visible_context_not_provider_billing",
    repo: root,
    generatedAt: new Date().toISOString(),
    source: options.tasksPath || "inline",
    taskCount: rows.length,
    summary: summarizeRows(rows),
    rows
  };
}

export function loadBenchTasks(tasksPath) {
  if (!tasksPath) throw new Error("bench-tokens requires --tasks <json|jsonl>");
  const fullPath = path.resolve(tasksPath);
  const text = fs.readFileSync(fullPath, "utf8").trim();
  if (!text) return [];
  if (text.startsWith("[")) return JSON.parse(text);
  return text.split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function evaluateBenchTask(root, task = {}, { budget = 8000, baselineMode = "explicit", index = 0 } = {}) {
  const request = normalizeBenchRequest(task);
  const analysis = analyzeRepository(root, { budget, userRequest: request });
  const payload = buildAgentInputPayload(analysis.contextPack, { userRequest: request });
  const adaptiveContext = buildAdaptiveContext({
    repoPath: root,
    request,
    analysis,
    payload,
    mode: task.mode || task.contextMode || "auto"
  });
  const baselineFiles = selectBenchBaselineFiles({ root, task, payload, baselineMode });
  const baselineText = [
    request,
    ...baselineFiles.map((file) => file.text)
  ].filter(Boolean).join("\n\n");
  const tokenResult = countTokensForTexts([
    baselineText
  ], {
    encoding: analysis.contextPack?.tokenEconomy?.tokenizer?.encoding || analysis.repoStats?.tokenizer?.encoding
  });
  const defaultTokens = tokenResult.counts[0] || 0;
  const scopeleaseTokens = adaptiveContext.tokens || 0;
  const savedTokens = defaultTokens - scopeleaseTokens;
  const savedPercent = defaultTokens > 0 ? Math.round((savedTokens / defaultTokens) * 100) : null;
  return {
    id: String(task.id || task.taskId || task.competition_id || task.competitionId || `task-${index + 1}`),
    title: String(task.title || task.competition || task.name || ""),
    request,
    baselineMode,
    baselineFiles: baselineFiles.map((file) => file.relativePath),
    missingFiles: baselineFiles.filter((file) => file.missing).map((file) => file.relativePath),
    scopeDeniedFiles: baselineFiles.filter((file) => file.scopeDenied).map((file) => file.relativePath),
    defaultTokens,
    scopeleaseTokens,
    scopeleaseMode: adaptiveContext.mode,
    scopeleaseDecision: adaptiveContext.decision,
    savedTokens,
    savedPercent,
    repoScopeTokens: analysis.contextPack?.tokenEconomy?.fullRepoTokens || 0,
    scopeleaseContextField: payload.field || "codexInput.text",
    observationKind: "controlled_context_baseline",
    claimScope: "controlled_context_protocol_not_live_codex_average",
    liveDefaultCodexObserved: false,
    measured: defaultTokens > 0 && scopeleaseTokens > 0,
    note: adaptiveContext.mode === "observe_only"
      ? "ScopeLease intentionally withholds full context here. This avoids ScopeLease overhead but is not a success-equivalent replacement for a full agent run."
      : "Controlled agent-visible input token estimate only; this does not observe Codex's natural default retrieval behavior, MLE-bench agents, Kaggle containers, or provider billing."
  };
}

export function selectBenchBaselineFiles({ root, task = {}, payload = {}, baselineMode = "explicit" }) {
  const explicit = arrayFrom(task.baselineFiles || task.files || task.contextFiles);
  const files = explicit.length
    ? explicit
    : baselineMode === "readPlanFiles"
      ? arrayFrom(payload.readPlan).map((item) => item.path || item.id || item.label).filter(Boolean)
      : [];
  return files.map((file) => readTaskFile(root, task, file));
}

function readTaskFile(root, task = {}, file = "") {
  const resolvedRoot = safeRealpath(root) || path.resolve(root);
  const baseDir = String(task.baseDir || task.workspace || "").trim();
  const filePath = path.isAbsolute(file)
    ? path.resolve(file)
    : path.resolve(resolvedRoot, baseDir, file);
  const scopePath = safeRealpath(filePath) || filePath;
  const relativePath = path.relative(resolvedRoot, scopePath).split(path.sep).join("/");
  if (!pathInside(resolvedRoot, scopePath)) {
    return {
      relativePath,
      text: "",
      missing: true,
      scopeDenied: true
    };
  }
  try {
    const realFilePath = fs.realpathSync(filePath);
    if (!pathInside(resolvedRoot, realFilePath)) {
      return {
        relativePath,
        text: "",
        missing: true,
        scopeDenied: true
      };
    }
    return {
      relativePath,
      text: fs.readFileSync(realFilePath, "utf8"),
      missing: false,
      scopeDenied: false
    };
  } catch {
    return {
      relativePath,
      text: "",
      missing: true,
      scopeDenied: false
    };
  }
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

export function normalizeBenchRequest(task = {}) {
  return String(
    task.request ||
    task.prompt ||
    task.instructions ||
    task.description ||
    task.objective ||
    task.title ||
    ""
  ).trim();
}

function summarizeRows(rows = []) {
  const measured = rows.filter((row) => row.measured);
  const savedPercents = measured
    .map((row) => row.savedPercent)
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  const defaultTokens = measured.reduce((sum, row) => sum + row.defaultTokens, 0);
  const scopeleaseTokens = measured.reduce((sum, row) => sum + row.scopeleaseTokens, 0);
  const savedTokens = defaultTokens - scopeleaseTokens;
  return {
    measuredTasks: measured.length,
    defaultTokens,
    scopeleaseTokens,
    savedTokens,
    savedPercent: defaultTokens > 0 ? Math.round((savedTokens / defaultTokens) * 100) : null,
    medianSavedPercent: median(savedPercents),
    minSavedPercent: savedPercents.length ? savedPercents[0] : null,
    maxSavedPercent: savedPercents.length ? savedPercents[savedPercents.length - 1] : null
  };
}

function median(values = []) {
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2
    ? values[middle]
    : Math.round((values[middle - 1] + values[middle]) / 2);
}

function normalizeLimit(value, fallback) {
  const limit = Number(value || fallback || 0);
  if (!Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(Math.floor(limit), fallback);
}

function arrayFrom(value) {
  return Array.isArray(value) ? value : [];
}
