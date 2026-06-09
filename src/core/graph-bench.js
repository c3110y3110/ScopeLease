import fs from "node:fs";
import path from "node:path";
import { buildAgentInputPayload } from "./artifacts.js";
import { buildAdaptiveContext } from "./adaptive-context.js";
import { loadBenchTasks, normalizeBenchRequest, selectBenchBaselineFiles } from "./bench-evaluator.js";
import { analyzeRepository } from "./repository.js";
import { countTokensForTexts } from "./tokenizer.js";

const DEFAULT_MAX_GREP_FILES = 96;
const DEFAULT_MAX_TERMS = 8;
const STOP_WORDS = new Set([
  "about",
  "after",
  "agent",
  "scopelease",
  "before",
  "boundary",
  "change",
  "check",
  "code",
  "command",
  "context",
  "current",
  "does",
  "edit",
  "explain",
  "file",
  "files",
  "find",
  "from",
  "identify",
  "needed",
  "review",
  "safe",
  "should",
  "smallest",
  "test",
  "tests",
  "then",
  "this",
  "what",
  "where",
  "which",
  "with",
  "without"
]);

export function evaluateGraphClaimBench(repoPath, options = {}) {
  const root = path.resolve(repoPath || ".");
  const tasks = loadBenchTasks(options.tasksPath || options.tasks || "");
  const limit = normalizeLimit(options.limit, tasks.length);
  const selected = tasks.slice(0, limit);
  const rows = selected.map((task, index) => evaluateGraphClaimTask(root, task, {
    budget: Number(options.budget || task.budget || 8000),
    maxGrepFiles: normalizeLimit(options.maxGrepFiles || options["max-grep-files"], DEFAULT_MAX_GREP_FILES),
    maxTerms: normalizeLimit(options.maxTerms || options["max-terms"], DEFAULT_MAX_TERMS),
    index
  }));
  return {
    kind: "scopelease.graph_claim_bench",
    boundary: "controlled_graph_retrieval_protocol_not_provider_billing",
    repo: root,
    generatedAt: new Date().toISOString(),
    source: options.tasksPath || "inline",
    taskCount: rows.length,
    summary: summarizeGraphRows(rows),
    rows,
    caveat: "This mirrors CodeGraph-style benchmark boundaries: keyword/grep file exploration versus graph/frontier-selected context. It is controlled context retrieval evidence, not proof of provider billing or natural agent behavior."
  };
}

function evaluateGraphClaimTask(root, task = {}, { budget = 8000, maxGrepFiles = DEFAULT_MAX_GREP_FILES, maxTerms = DEFAULT_MAX_TERMS, index = 0 } = {}) {
  const request = normalizeBenchRequest(task);
  const explicitFiles = selectBenchBaselineFiles({ root, task, payload: {}, baselineMode: "explicit" });
  const searchTerms = deriveSearchTerms(task, request, explicitFiles, { maxTerms });
  const analysisRequest = searchTerms.length
    ? `${request}\nSearch terms: ${searchTerms.join(", ")}`
    : request;
  const analysis = analyzeRepository(root, { budget, userRequest: analysisRequest });
  const payload = buildAgentInputPayload(analysis.contextPack, { userRequest: request });
  const adaptiveContext = buildAdaptiveContext({
    repoPath: root,
    request,
    analysis,
    payload,
    mode: task.mode || task.contextMode || "auto"
  });
  const repoFiles = listBenchmarkFiles(root);
  const grepFiles = selectGrepFiles(root, repoFiles, searchTerms, { maxFiles: maxGrepFiles });
  const graphFiles = readGraphFrontierFiles(root, graphFrontierPaths(analysis, payload, task));
  const assertedMinimalFiles = readGraphFrontierFiles(root, graphMinimalPaths(task, explicitFiles));
  const encoding = analysis.contextPack?.tokenEconomy?.tokenizer?.encoding || analysis.repoStats?.tokenizer?.encoding;
  const [
    explicitTokens,
    grepTokens,
    graphFileTokens,
    scopeleasePromptTokens,
    assertedMinimalTokens
  ] = countTokensForTexts([
    renderFilesInput(request, explicitFiles),
    renderFilesInput(request, grepFiles),
    renderFilesInput(request, graphFiles),
    adaptiveContext.text || "",
    renderFilesInput(request, assertedMinimalFiles)
  ], { encoding }).counts;
  const gold = new Set(explicitFiles.filter((file) => !file.missing).map((file) => normalizePath(file.relativePath)));
  const grepSet = new Set(grepFiles.map((file) => normalizePath(file.relativePath)));
  const graphSet = new Set(graphFiles.map((file) => normalizePath(file.relativePath)));
  const assertedMinimalSet = new Set(assertedMinimalFiles.map((file) => normalizePath(file.relativePath)));
  const grepRecallPrecision = recallPrecision(grepSet, gold);
  const graphRecallPrecision = recallPrecision(graphSet, gold);
  const assertedMinimalRecallPrecision = recallPrecision(assertedMinimalSet, gold);
  const grepToolCalls = searchTerms.length + grepFiles.length;
  const graphToolCallsWithReads = 1 + graphFiles.length;
  const assertedMinimalToolCallsWithReads = 1 + assertedMinimalFiles.length;
  const graphToolCallsPromptOnly = 1;
  return {
    id: String(task.id || task.taskId || `task-${index + 1}`),
    title: String(task.title || task.name || ""),
    category: String(task.category || task.taskType || task.type || "unclassified"),
    benchmarkFamily: String(task.benchmarkFamily || task.benchmark || ""),
    request,
    searchTerms,
    boundary: "controlled_graph_retrieval_protocol_not_provider_billing",
    baseline: {
      explicit: summarizeFileSet(explicitFiles, explicitTokens || 0, gold),
      grep: summarizeFileSet(grepFiles, grepTokens || 0, gold),
      graphFrontierFiles: summarizeFileSet(graphFiles, graphFileTokens || 0, gold),
      codeGraphMinimalFiles: summarizeFileSet(assertedMinimalFiles, assertedMinimalTokens || 0, gold)
    },
    scopelease: {
      mode: adaptiveContext.mode,
      promptTokens: scopeleasePromptTokens || 0,
      promptField: payload.field || "codexInput.text",
      contextNodes: analysis.contextPack?.agentContext?.frontierSummary?.contextNodes || 0,
      reviewNodes: analysis.contextPack?.agentContext?.frontierSummary?.reviewNodes || 0,
      permissionNodes: analysis.contextPack?.agentContext?.frontierSummary?.permissionNodes || 0,
      stopNodes: analysis.contextPack?.agentContext?.frontierSummary?.stopNodes || 0,
      graphScopeHash: analysis.contextPack?.agentContext?.frontierSummary?.graphScopeHash || ""
    },
    tokenDelta: {
      grepToGraphFiles: delta(grepTokens || 0, graphFileTokens || 0),
      grepToCodeGraphMinimal: delta(grepTokens || 0, assertedMinimalTokens || 0),
      grepToScopeLeasePrompt: delta(grepTokens || 0, scopeleasePromptTokens || 0),
      explicitToScopeLeasePrompt: delta(explicitTokens || 0, scopeleasePromptTokens || 0)
    },
    toolCallDelta: {
      grepToGraphFiles: toolDelta(grepToolCalls, graphToolCallsWithReads),
      grepToCodeGraphMinimal: toolDelta(grepToolCalls, assertedMinimalToolCallsWithReads),
      grepToScopeLeasePromptOnly: toolDelta(grepToolCalls, graphToolCallsPromptOnly)
    },
    recallPrecision: {
      grep: grepRecallPrecision,
      graphFrontierFiles: graphRecallPrecision,
      codeGraphMinimalFiles: assertedMinimalRecallPrecision
    },
    precisionToken: {
      grep: precisionTokenSummary({ tokens: grepTokens || 0, recallPrecision: grepRecallPrecision }),
      graphFrontierFiles: precisionTokenSummary({ tokens: graphFileTokens || 0, recallPrecision: graphRecallPrecision }),
      codeGraphMinimalFiles: precisionTokenSummary({ tokens: assertedMinimalTokens || 0, recallPrecision: assertedMinimalRecallPrecision }),
      scopeleasePrompt: precisionTokenSummary({ tokens: scopeleasePromptTokens || 0, recallPrecision: graphRecallPrecision })
    },
    claimScope: "CodeGraph-style keyword exploration vs graph/frontier retrieval; not a natural Codex default average",
    measured: Boolean(request && (grepTokens || graphFileTokens || scopeleasePromptTokens))
  };
}

function deriveSearchTerms(task = {}, request = "", explicitFiles = [], { maxTerms = DEFAULT_MAX_TERMS } = {}) {
  const explicit = arrayFrom(task.searchTerms || task.keywords || task.symbols)
    .flatMap((term) => String(term || "").split(/[,\s]+/))
    .map((term) => term.trim())
    .filter(Boolean);
  const codeLike = [...String(request || "").matchAll(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g)]
    .map((match) => match[0])
    .filter((term) => !STOP_WORDS.has(term.toLowerCase()));
  const pathTerms = explicitFiles
    .map((file) => path.basename(file.relativePath || "", path.extname(file.relativePath || "")))
    .filter((term) => term && term.length >= 3 && !["index", "main", "test", "spec"].includes(term.toLowerCase()));
  return uniqueStrings([...explicit, ...codeLike, ...pathTerms])
    .sort((left, right) => scoreSearchTerm(right) - scoreSearchTerm(left) || left.localeCompare(right))
    .slice(0, maxTerms);
}

function scoreSearchTerm(term = "") {
  let score = Math.min(12, String(term).length);
  if (/[A-Z]/.test(term) && /[a-z]/.test(term)) score += 6;
  if (term.includes("_") || term.includes("-")) score += 3;
  return score;
}

function selectGrepFiles(root, repoFiles = [], terms = [], { maxFiles = DEFAULT_MAX_GREP_FILES } = {}) {
  if (!terms.length) return [];
  const lowered = terms.map((term) => term.toLowerCase());
  const rows = [];
  for (const file of repoFiles) {
    const text = readSafe(path.join(root, file));
    if (!text) continue;
    const lower = text.toLowerCase();
    const hits = lowered.reduce((sum, term) => sum + countIncludes(lower, term), 0);
    if (hits > 0) rows.push({ relativePath: file, text, missing: false, scopeDenied: false, hits });
  }
  return rows
    .sort((left, right) => right.hits - left.hits || left.relativePath.localeCompare(right.relativePath))
    .slice(0, maxFiles);
}

function graphFrontierPaths(analysis = {}, payload = {}, task = {}) {
  const frontiers = analysis.contextPack?.agentContext?.frontiers || payload.promptContext?.frontiers || {};
  const readPlan = analysis.contextPack?.agentContext?.readPlan || payload.readPlan || [];
  const symbolProbePlan = analysis.contextPack?.agentContext?.symbolProbePlan || payload.symbolProbePlan || [];
  const graphQueryHints = analysis.contextPack?.agentContext?.graphQueryHints || payload.codexInput?.promptContext?.graphQueryHints || {};
  const items = [
    ...arrayFrom(analysis.taskContext).map((item) => item.path),
    ...readPlan.map((item) => item.path || item.id || item.label),
    ...symbolProbePlan.map((item) => item.path || item.id || item.label),
    ...graphHintPaths(graphQueryHints),
    ...arrayFrom(frontiers.contextFrontier?.items).map((item) => item.path),
    ...arrayFrom(frontiers.symbolFrontier?.items).map((item) => item.path),
    ...arrayFrom(frontiers.reviewFrontier?.items).map((item) => item.path),
    ...arrayFrom(task.graphFiles || task.minimalGraphFiles || task.expectedGraphFiles)
  ];
  return uniqueStrings(items.map(pathFromNodeOrPath).filter(Boolean))
    .filter((file) => !isBenchmarkArtifactPath(file))
    .slice(0, 18);
}

function graphMinimalPaths(task = {}, explicitFiles = []) {
  const explicitMinimal = arrayFrom(task.graphFiles || task.minimalGraphFiles || task.expectedGraphFiles);
  if (explicitMinimal.length) return uniqueStrings(explicitMinimal.map(pathFromNodeOrPath).filter(Boolean));
  return explicitFiles.map((file) => file.relativePath).filter(Boolean);
}

function readGraphFrontierFiles(root, files = []) {
  return files
    .map((file) => readTaskFileLike(root, file))
    .filter((file) => !file.missing && !file.scopeDenied);
}

function listBenchmarkFiles(root) {
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
    if (entry.isDirectory()) {
      walk(root, relative, out);
    } else if (entry.isFile() && isBenchmarkTextFile(relative, full)) {
      out.push(relative);
    }
  }
}

function isBenchmarkTextFile(relative, full) {
  if (isBenchmarkArtifactPath(relative)) return false;
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

function isBenchmarkArtifactPath(relative = "") {
  const file = normalizePath(relative);
  return /^examples\/evaluation\/.*\.(jsonl|json)$/i.test(file) ||
    /^\.scopelease\/experiments\//i.test(file) ||
    /^\.scopelease\/reports\//i.test(file);
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

function readTaskFileLike(root, file = "") {
  const resolvedRoot = safeRealpath(root) || path.resolve(root);
  const filePath = path.resolve(resolvedRoot, file);
  const scopePath = safeRealpath(filePath) || filePath;
  const relativePath = normalizePath(path.relative(resolvedRoot, scopePath));
  if (!pathInside(resolvedRoot, scopePath)) {
    return { relativePath, text: "", missing: true, scopeDenied: true };
  }
  const text = readSafe(scopePath);
  return {
    relativePath,
    text,
    missing: text === "",
    scopeDenied: false
  };
}

function renderFilesInput(request = "", files = []) {
  return [
    request,
    ...files.map((file) => `# ${file.relativePath}\n${file.text || ""}`)
  ].filter(Boolean).join("\n\n");
}

function summarizeFileSet(files = [], tokens = 0, gold = new Set()) {
  const paths = files.map((file) => normalizePath(file.relativePath));
  return {
    files: paths.length,
    tokens,
    chars: files.reduce((sum, file) => sum + String(file.text || "").length, 0),
    paths,
    goldOverlap: paths.filter((file) => gold.has(file)).length
  };
}

function summarizeGraphRows(rows = []) {
  const measured = rows.filter((row) => row.measured);
  const grepTokens = sum(measured, (row) => row.baseline.grep.tokens);
  const graphFileTokens = sum(measured, (row) => row.baseline.graphFrontierFiles.tokens);
  const codeGraphMinimalTokens = sum(measured, (row) => row.baseline.codeGraphMinimalFiles.tokens);
  const scopeleasePromptTokens = sum(measured, (row) => row.scopelease.promptTokens);
  const explicitTokens = sum(measured, (row) => row.baseline.explicit.tokens);
  const grepToolCalls = sum(measured, (row) => row.toolCallDelta.grepToGraphFiles.defaultCalls);
  const graphToolCalls = sum(measured, (row) => row.toolCallDelta.grepToGraphFiles.scopeleaseCalls);
  const codeGraphMinimalToolCalls = sum(measured, (row) => row.toolCallDelta.grepToCodeGraphMinimal.scopeleaseCalls);
  const promptOnlyToolCalls = sum(measured, (row) => row.toolCallDelta.grepToScopeLeasePromptOnly.scopeleaseCalls);
  return {
    measuredTasks: measured.length,
    grepBaselineTokens: grepTokens,
    graphFrontierFileTokens: graphFileTokens,
    codeGraphMinimalFileTokens: codeGraphMinimalTokens,
    scopeleasePromptTokens,
    explicitBaselineTokens: explicitTokens,
    grepToGraphFiles: delta(grepTokens, graphFileTokens),
    grepToCodeGraphMinimal: delta(grepTokens, codeGraphMinimalTokens),
    grepToScopeLeasePrompt: delta(grepTokens, scopeleasePromptTokens),
    explicitToScopeLeasePrompt: delta(explicitTokens, scopeleasePromptTokens),
    toolCallsGrepToGraphFiles: toolDelta(grepToolCalls, graphToolCalls),
    toolCallsGrepToCodeGraphMinimal: toolDelta(grepToolCalls, codeGraphMinimalToolCalls),
    toolCallsGrepToScopeLeasePromptOnly: toolDelta(grepToolCalls, promptOnlyToolCalls),
    macroGrepToGraphFilesSavedPercent: meanPercent(measured.map((row) => row.tokenDelta.grepToGraphFiles.savedPercent)),
    macroGrepToCodeGraphMinimalSavedPercent: meanPercent(measured.map((row) => row.tokenDelta.grepToCodeGraphMinimal.savedPercent)),
    macroGrepToScopeLeasePromptSavedPercent: meanPercent(measured.map((row) => row.tokenDelta.grepToScopeLeasePrompt.savedPercent)),
    medianGrepToScopeLeasePromptSavedPercent: medianPercent(measured.map((row) => row.tokenDelta.grepToScopeLeasePrompt.savedPercent)),
    positivePromptRows: measured.filter((row) => Number(row.tokenDelta.grepToScopeLeasePrompt.savedTokens || 0) > 0).length,
    overheadPromptRows: measured.filter((row) => Number(row.tokenDelta.grepToScopeLeasePrompt.savedTokens || 0) < 0).length,
    averageGraphRecall: meanPercent(measured.map((row) => row.recallPrecision.graphFrontierFiles.recallPercent)),
    averageGraphPrecision: meanPercent(measured.map((row) => row.recallPrecision.graphFrontierFiles.precisionPercent)),
    precisionTokenProxy: {
      boundary: "gold overlap per 1k local input tokens; not provider billing",
      grepRelevantPerKTokens: meanNumber(measured.map((row) => row.precisionToken?.grep?.relevantPerKTokens)),
      graphRelevantPerKTokens: meanNumber(measured.map((row) => row.precisionToken?.graphFrontierFiles?.relevantPerKTokens)),
      codeGraphMinimalRelevantPerKTokens: meanNumber(measured.map((row) => row.precisionToken?.codeGraphMinimalFiles?.relevantPerKTokens)),
      scopeleasePromptRelevantPerKTokens: meanNumber(measured.map((row) => row.precisionToken?.scopeleasePrompt?.relevantPerKTokens))
    }
  };
}

function delta(defaultTokens = 0, scopeleaseTokens = 0) {
  const savedTokens = Number(defaultTokens || 0) - Number(scopeleaseTokens || 0);
  return {
    defaultTokens: Number(defaultTokens || 0),
    scopeleaseTokens: Number(scopeleaseTokens || 0),
    savedTokens,
    savedPercent: defaultTokens > 0 ? Math.round((savedTokens / defaultTokens) * 100) : null
  };
}

function toolDelta(defaultCalls = 0, scopeleaseCalls = 0) {
  const savedCalls = Number(defaultCalls || 0) - Number(scopeleaseCalls || 0);
  return {
    defaultCalls: Number(defaultCalls || 0),
    scopeleaseCalls: Number(scopeleaseCalls || 0),
    savedCalls,
    savedPercent: defaultCalls > 0 ? Math.round((savedCalls / defaultCalls) * 100) : null
  };
}

function recallPrecision(retrieved = new Set(), gold = new Set()) {
  if (!gold.size && !retrieved.size) {
    return { recallPercent: null, precisionPercent: null, overlap: 0, gold: 0, retrieved: 0 };
  }
  const overlap = [...retrieved].filter((file) => gold.has(file)).length;
  return {
    overlap,
    gold: gold.size,
    retrieved: retrieved.size,
    recallPercent: gold.size ? Math.round((overlap / gold.size) * 100) : null,
    precisionPercent: retrieved.size ? Math.round((overlap / retrieved.size) * 100) : null
  };
}

function pathFromNodeOrPath(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("file:")) return text.slice("file:".length);
  if (text.startsWith("symbol:")) {
    const rest = text.slice("symbol:".length);
    const marker = rest.indexOf(":");
    return marker >= 0 ? rest.slice(0, marker) : rest;
  }
  return text;
}

function graphHintPaths(graphQueryHints = {}) {
  return arrayFrom(graphQueryHints.hints).flatMap((hint) => [
    ...arrayFrom(hint.paths),
    ...arrayFrom(hint.symbols).map((item) => item.path),
    ...arrayFrom(hint.probes).flatMap((item) => [item.path, ...arrayFrom(item.paths)])
  ]);
}

function precisionTokenSummary({ tokens = 0, recallPrecision: rp = {} } = {}) {
  const tokenCount = Number(tokens || 0);
  const relevant = Number(rp.overlap || 0);
  return {
    boundary: "local_prompt_or_file_tokens_not_provider_billing",
    tokens: tokenCount,
    relevant,
    retrieved: Number(rp.retrieved || 0),
    precisionPercent: rp.precisionPercent ?? null,
    recallPercent: rp.recallPercent ?? null,
    relevantPerKTokens: tokenCount > 0 ? Math.round((relevant / tokenCount) * 1000 * 100) / 100 : null
  };
}

function readSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
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
  return Math.round(finite.reduce((sumValue, value) => sumValue + value, 0) / finite.length);
}

function meanNumber(values = []) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) return null;
  return Math.round((finite.reduce((sumValue, value) => sumValue + value, 0) / finite.length) * 100) / 100;
}

function medianPercent(values = []) {
  const finite = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!finite.length) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2
    ? finite[middle]
    : Math.round((finite[middle - 1] + finite[middle]) / 2);
}
