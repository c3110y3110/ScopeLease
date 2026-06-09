import { hashText } from "../fs-utils.js";

const MAX_KEY_LENGTH = 240;
const PATH_PATTERN = /\b[A-Za-z0-9_.@/-]+\.(?:m?js|cjs|ts|tsx|jsx|json|md|toml|ya?ml|css|html|py|go|rs|java|kt|swift|c|cpp|h|hpp|sql|sh)(?::\d+)?\b/g;
const TOKEN_PATTERN = /[\p{L}\p{N}_@./:-]{2,}/gu;
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "into", "then", "than", "are", "was", "were",
  "have", "has", "had", "will", "would", "could", "should", "please", "request", "user", "input",
  "지금", "실제", "내용", "기준", "하면", "해서", "하고", "한다", "있는", "없는", "으로", "에서",
  "이걸", "그걸", "이거", "그거", "보자", "해봐", "해야", "하는", "하게", "같은", "이번", "요청"
]);

export function deriveWorkIntent(input = "", options = {}) {
  const explicit = normalizeRequestKey(
    options.workIntent ||
    options.work_intent ||
    options.intent ||
    (isObject(input) ? input.workIntent || input.work_intent || input.intent : "")
  );
  if (explicit) return explicit;

  const source = resolveRequestText(input, options);
  const userRequest = extractUserRequestText(source);
  const normalized = normalizeRequestKey(userRequest);
  if (!normalized) return "";

  const paths = extractPaths(normalized);
  const findings = extractFindings(normalized);
  const terms = extractTerms(normalized, new Set(paths));
  const parts = unique([...paths, ...findings, ...terms]).slice(0, 24);
  const canonical = parts.join(" ");
  return (canonical || normalized).slice(0, MAX_KEY_LENGTH);
}

export function buildTaskIntent(input = "", options = {}) {
  const source = resolveRequestText(input, options);
  const userRequest = extractUserRequestText(source);
  const pairingKey = deriveWorkIntent(input, options);
  const targetArtifacts = unique([
    ...extractPaths(normalizeRequestKey(userRequest)),
    ...asArray(options.targetArtifacts),
    ...asArray(options.paths)
  ]).slice(0, 10);
  const taskType = inferTaskType(userRequest);
  const riskHypotheses = inferRiskHypotheses(userRequest, options);
  return {
    kind: "scopelease.semantic_task_intent",
    taskType,
    objective: summarizeObjective(userRequest),
    targetArtifacts,
    nonGoals: inferNonGoals(userRequest, options),
    decisionNeeded: Boolean(options.decisionNeeded ?? riskHypotheses.length),
    riskHypotheses,
    permissionNeed: inferPermissionNeed(taskType, userRequest, {
      decisionNeeded: Boolean(options.decisionNeeded ?? riskHypotheses.length),
      riskHypotheses
    }),
    successCriteria: inferSuccessCriteria(taskType, userRequest, options),
    pairing: {
      taskId: options.taskId || (pairingKey ? `task:${hashText(pairingKey).slice(0, 12)}` : ""),
      pairingKey,
      pairId: options.pairId || options.pair_id || ""
    },
    confidence: intentConfidence({ userRequest, pairingKey, targetArtifacts, riskHypotheses })
  };
}

export function requestHash(input = "", options = {}) {
  const source = resolveRequestText(input, options);
  const userRequest = extractUserRequestText(source);
  const normalized = normalizeRequestKey(userRequest);
  return normalized ? `sha1:${hashText(normalized)}` : "";
}

export function extractUserRequestText(value = "") {
  const text = normalizeRequestText(value);
  if (!text) return "";
  const match = text.match(/User request:\s*([\s\S]*?)(?:\n\s*ScopeLease context:|\n\s*Boundary:|\n\s*```json|$)/i);
  return normalizeRequestText(match?.[1] || text);
}

export function normalizeRequestKey(value = "") {
  return normalizeRequestText(value).replace(/\s+/g, " ").slice(0, MAX_KEY_LENGTH);
}

function resolveRequestText(input = "", options = {}) {
  if (isObject(input)) {
    return input.request ||
      input.userRequest?.text ||
      input.userRequest ||
      input.prompt ||
      input.text ||
      input.codexInput?.text ||
      "";
  }
  return options.request || options.userRequest || options.prompt || options.text || input || "";
}

function extractPaths(text = "") {
  return unique((text.match(PATH_PATTERN) || []).map((path) => path.toLowerCase().replace(/:\d+$/, ""))).slice(0, 8);
}

function extractFindings(text = "") {
  const values = [];
  for (const match of text.matchAll(/\bfinding\s*#?\s*(\d+)\b/gi)) values.push(`finding-${match[1]}`);
  for (const match of text.matchAll(/\[p([0-3])\]/gi)) values.push(`p${match[1]}`);
  return unique(values).slice(0, 6);
}

function extractTerms(text = "", pathSet = new Set()) {
  const terms = [];
  for (const token of text.toLowerCase().match(TOKEN_PATTERN) || []) {
    const cleaned = token.replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, "");
    if (!cleaned || cleaned.length < 2) continue;
    if (STOP_WORDS.has(cleaned)) continue;
    if (/^\d+$/.test(cleaned)) continue;
    if (pathSet.has(cleaned.replace(/:\d+$/, ""))) continue;
    terms.push(cleaned);
  }
  return unique(terms).slice(0, 18);
}

function inferTaskType(text = "") {
  const value = normalizeRequestKey(text).toLowerCase();
  if (/(논문|paper|research|experiment|calibration|검증|계측|metric|benchmark)/.test(value)) return "research_design";
  if (/(review|검토|찾아|문제|risk|bug|finding)/.test(value)) return "review";
  if (/(fix|고쳐|수정|패치|patch|implement|구현|추가)/.test(value)) return "code_change";
  if (/(document|docs|문서|정리|readme)/.test(value)) return "documentation";
  if (/(test|검사|검증|verify)/.test(value)) return "verification";
  return "general_coding_task";
}

function summarizeObjective(text = "") {
  const normalized = normalizeRequestKey(extractUserRequestText(text));
  return normalized ? normalized.slice(0, 360) : "";
}

function inferNonGoals(text = "", options = {}) {
  const values = [...asArray(options.nonGoals)];
  const value = normalizeRequestKey(text).toLowerCase();
  if (/(provider|billing|api usage|과금)/.test(value)) values.push("provider billing token savings claim");
  if (/(full repo|전체 저장소|repo compression)/.test(value)) values.push("full repository size as actual savings baseline");
  if (/(무제한|unbounded|global)/.test(value)) values.push("unbounded agent scopeleaserity");
  return unique(values).slice(0, 10);
}

function inferRiskHypotheses(text = "", options = {}) {
  const values = [...asArray(options.riskHypotheses)];
  const value = normalizeRequestKey(text).toLowerCase();
  if (/(approval|lease|승인|권한|scope)/.test(value)) values.push("approval lease scope may be broader than intended");
  if (/(token|절감|saving|baseline|pair)/.test(value)) values.push("token savings may be overstated without paired baseline evidence");
  if (/(auth|session|permission|role|인증|세션|권한)/.test(value)) values.push("auth or permission path may require senior review");
  if (/(policy|stop_when|risk|deny)/.test(value)) values.push("policy settings must be enforced, not only displayed");
  return unique(values).slice(0, 10);
}

function inferSuccessCriteria(taskType = "", text = "", options = {}) {
  const explicit = asArray(options.successCriteria);
  if (explicit.length) return unique(explicit).slice(0, 10);
  const criteria = [];
  if (taskType === "research_design") {
    criteria.push("separate product telemetry from research calibration evidence");
    criteria.push("only claim exact savings when paired default/scopelease evidence exists and scopelease input is lower");
  } else if (taskType === "review") {
    criteria.push("identify concrete risks with file-level evidence");
    criteria.push("avoid ungrounded savings or safety claims");
  } else if (taskType === "code_change") {
    criteria.push("apply scoped patch only within approved files");
    criteria.push("run relevant tests or syntax checks");
  } else if (taskType === "documentation") {
    criteria.push("document product behavior without overstating claims");
  }
  if (/(test|검증|verify)/i.test(text)) criteria.push("verification result is recorded");
  return unique(criteria).slice(0, 10);
}

function inferPermissionNeed(taskType = "", text = "", { decisionNeeded = false, riskHypotheses = [] } = {}) {
  const value = normalizeRequestKey(text).toLowerCase();
  const docsOnly = taskType === "documentation" || /(docs|document|readme|문서|정리)/.test(value);
  const codeWork = ["code_change", "verification"].includes(taskType) || /(fix|고쳐|수정|패치|patch|implement|구현|test|검증)/.test(value);
  const highRiskHypothesis = riskHypotheses.some((item) => /(high|critical|senior|approval|required|auth|permission|session|token|policy)/i.test(String(item || "")));
  const highRisk = decisionNeeded || highRiskHypothesis || /(auth|session|permission|role|token|policy|config|db|payment|인증|세션|권한)/.test(value);
  const canApplyWithoutHuman = docsOnly && !highRisk;
  return {
    read: true,
    proposePatch: codeWork || docsOnly || taskType === "review",
    applyPatch: canApplyWithoutHuman,
    runTests: codeWork || /(test|검증|verify)/.test(value),
    checkpoint: false,
    network: false,
    externalWrite: false,
    humanApprovalBeforeApply: !canApplyWithoutHuman,
    reason: unique([
      docsOnly ? "documentation scope can usually be logged or applied with low risk" : "",
      highRisk ? "risk or scopeleaserity signal requires scoped approval before apply" : "",
      codeWork ? "code or verification work should run relevant checks" : ""
    ])
  };
}

function intentConfidence({ userRequest = "", pairingKey = "", targetArtifacts = [], riskHypotheses = [] } = {}) {
  let score = 0.45;
  if (normalizeRequestKey(userRequest).length > 40) score += 0.15;
  if (pairingKey) score += 0.15;
  if (targetArtifacts.length) score += 0.15;
  if (riskHypotheses.length) score += 0.1;
  return Math.min(0.95, Math.round(score * 100) / 100);
}

function normalizeRequestText(value = "") {
  if (value === true || value === false || value == null) return "";
  const text = String(value || "").trim();
  return text === "true" || text === "false" ? "" : text;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function unique(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = String(value || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}
