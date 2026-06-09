import fs from "node:fs";
import path from "node:path";
import { shouldIgnoreRelative } from "../fs-utils.js";
import { countTokensForTexts } from "./tokenizer.js";

const SMALL_DEFAULT_TOKENS = 2000;
const MICRO_DEFAULT_TOKENS = 6000;
const MIN_SAVED_TOKENS_FOR_FULL = 2000;
const FULL_RATIO = 1.5;
const OBSERVE_FIRST_PROMPT_TOKENS = 800;
const FILE_MENTION_PATTERN = /(?:^|[\s"'(<])((?:\/|~\/)?[A-Za-z0-9_.@/-]+\.(?:m?js|cjs|ts|tsx|jsx|json|md|toml|ya?ml|css|html|py|go|rs|java|kt|swift|c|cpp|h|hpp|sql|sh)(?::\d+)?)/g;

export function buildAdaptiveContext({ repoPath = ".", request = "", analysis = {}, payload = {}, mode = "auto" } = {}) {
  const root = path.resolve(repoPath || analysis.repo || ".");
  const fullText = payload.codexInput?.text || "";
  const encoding = analysis.contextPack?.tokenEconomy?.tokenizer?.encoding || analysis.repoStats?.tokenizer?.encoding;
  const explicitFiles = findExplicitFiles(root, request);
  const fileText = explicitFiles.map((file) => file.text).join("\n\n");
  const [promptTokens, explicitFileTokens, fullTokens] = countTokensForTexts([
    request,
    fileText,
    fullText
  ], { encoding }).counts;
  const estimatedDefaultTokens = (promptTokens || 0) + (explicitFileTokens || 0);
  const requestedMode = normalizeMode(mode);
  const decision = decideMode({
    requestedMode,
    promptTokens,
    explicitFileTokens,
    explicitFileCount: explicitFiles.length,
    estimatedDefaultTokens,
    fullTokens,
    request,
    analysis
  });
  const text = renderAdaptiveText({ request, analysis, payload, decision, fullText });
  const tokenResult = countTokensForTexts([text], { encoding });
  return {
    kind: "scopelease.adaptive_context",
    mode: decision.mode,
    requestedMode,
    text,
    tokens: tokenResult.counts[0] || 0,
    chars: text.length,
    tokenizer: tokenResult.tokenizer,
    decision: {
      ...decision,
      promptTokens: promptTokens || 0,
      explicitFileTokens: explicitFileTokens || 0,
      explicitFileCount: explicitFiles.length,
      explicitFiles: explicitFiles.map((file) => file.relativePath),
      estimatedDefaultTokens,
      scopeleaseFullEstimateTokens: fullTokens || 0,
      predictedSavedTokens: estimatedDefaultTokens - (fullTokens || 0),
      thresholds: {
        smallDefaultTokens: SMALL_DEFAULT_TOKENS,
        observeFirstPromptTokens: OBSERVE_FIRST_PROMPT_TOKENS,
        microDefaultTokens: MICRO_DEFAULT_TOKENS,
        minSavedTokensForFull: MIN_SAVED_TOKENS_FOR_FULL,
        fullRatio: FULL_RATIO
      }
    }
  };
}

export function shouldReturnFullContext(adaptive = {}) {
  return adaptive.mode === "full_context";
}

function decideMode({
  requestedMode = "auto",
  promptTokens = 0,
  explicitFileTokens = 0,
  explicitFileCount = 0,
  estimatedDefaultTokens = 0,
  fullTokens = 0,
  request = "",
  analysis = {}
}) {
  if (requestedMode === "full") return { mode: "full_context", reason: "forced by caller" };
  if (requestedMode === "micro") return { mode: "micro_context", reason: "forced by caller" };
  if (requestedMode === "observe") return { mode: "observe_only", reason: "forced by caller" };

  const lower = String(request || "").toLowerCase();
  const risk = String(analysis.risk || analysis.assessment?.risk || "low").toLowerCase();
  const highRisk = risk === "high" || /(auth|permission|approval|lease|권한|승인|인증|보안|security)/.test(lower);
  const explicitSmall = explicitFileCount > 0 && estimatedDefaultTokens < fullTokens;
  const promptOnly = explicitFileCount === 0 && promptTokens <= 240;
  const implementationIntent = /(implement|fix|refactor|patch|test|code|코드|구현|고치|수정|패치|테스트)/.test(lower);
  const likelyQuestion = /(what|why|how|explain|설명|정리|어때|뭐|왜|어떻게|말해)/.test(lower) && !implementationIntent;
  const fullHasClearSavings = fullTokens > 0 &&
    estimatedDefaultTokens >= Math.max(MICRO_DEFAULT_TOKENS, Math.ceil(fullTokens * FULL_RATIO)) &&
    estimatedDefaultTokens - fullTokens >= MIN_SAVED_TOKENS_FOR_FULL;

  if (fullHasClearSavings) {
    return { mode: "full_context", reason: "estimated default input is much larger than ScopeLease full context" };
  }
  if (promptOnly && likelyQuestion) {
    return { mode: "observe_only", reason: "prompt-only question is smaller than ScopeLease full context" };
  }
  if (promptOnly && promptTokens <= OBSERVE_FIRST_PROMPT_TOKENS) {
    return { mode: "observe_only", reason: "observe-first live prompt is smaller than ScopeLease context; wait for explicit file/tool demand" };
  }
  if (explicitSmall && !highRisk) {
    return { mode: "observe_only", reason: "explicit file payload is smaller than ScopeLease full context" };
  }
  if (estimatedDefaultTokens > 0 && estimatedDefaultTokens <= SMALL_DEFAULT_TOKENS && !highRisk) {
    return { mode: "observe_only", reason: "estimated default input is small" };
  }
  if (estimatedDefaultTokens > 0 && estimatedDefaultTokens <= MICRO_DEFAULT_TOKENS) {
    return { mode: "micro_context", reason: "risk or scopeleaserity signal exists, but full context is not token-efficient" };
  }
  if (promptOnly && !implementationIntent) {
    return { mode: "observe_only", reason: "no explicit repo context is needed yet" };
  }
  if (promptOnly && implementationIntent) {
    return { mode: "micro_context", reason: "implementation request needs routing, but default input size is not established" };
  }
  return { mode: "micro_context", reason: "full context has no clear predicted token advantage" };
}

function renderAdaptiveText({ request = "", analysis = {}, payload = {}, decision = {}, fullText = "" }) {
  if (decision.mode === "full_context") return fullText;
  const gate = payload.decisionGate || analysis.contextPack?.decisionGate || {};
  const readPlan = (payload.readPlan || analysis.contextPack?.agentContext?.readPlan || []).slice(0, decision.mode === "micro_context" ? 3 : 0);
  const policyHits = (analysis.policyHits || []).slice(0, decision.mode === "micro_context" ? 2 : 0);
  const body = {
    kind: "scopelease.context_decision",
    mode: decision.mode,
    reason: decision.reason,
    recommendation: decision.mode === "observe_only"
      ? "Do not inject full ScopeLease context for this turn; observe hooks and let the agent request files if needed."
      : "Inject only routing, risk, and a short read plan; do not include full KG context.",
    decisionGate: compactObject({
      status: gate.status,
      scopeleaserity: gate.scopeleaserity,
      canAutoApplyPatch: gate.canAutoApplyPatch,
      requiredApproval: gate.requiredApproval,
      nextAction: compactText(gate.nextAction || gate.summary || "", 90)
    }),
    readPlan: readPlan.map((item) => compactObject({
      path: item.path || item.id || item.label,
      reason: item.reason || item.kind || item.type
    })),
    policyHits: policyHits.map((hit) => compactObject({
      ruleId: hit.ruleId,
      risk: hit.risk,
      route: hit.route,
      files: (hit.files || []).slice(0, 3)
    }))
  };
  return [
    "User request:",
    request,
    "",
    "ScopeLease adaptive context:",
    "```json",
    JSON.stringify(body, null, 2),
    "```",
    "",
    "Boundary:",
    "- role: user",
    "- field: codexInput.text",
    "- provider/API billing usage is excluded",
    "- full ScopeLease context was intentionally withheld for token efficiency"
  ].join("\n") + "\n";
}

function compactText(value = "", limit = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trim()}…`;
}

function findExplicitFiles(root, request = "") {
  const matches = extractExplicitFileMentions(request);
  const unique = [...new Set(matches.map((item) => item.replace(/:\d+$/, "")))];
  return unique.map((file) => readExplicitFile(root, file)).filter((file) => file?.text);
}

function extractExplicitFileMentions(request = "") {
  const matches = [];
  const text = String(request || "");
  for (const match of text.matchAll(FILE_MENTION_PATTERN)) {
    if (match[1]) matches.push(match[1]);
  }
  return matches;
}

function readExplicitFile(root, file) {
  const raw = String(file || "").trim();
  if (!raw || raw.includes("\0")) return null;
  const expanded = expandHome(raw);
  let fullPath = "";
  if (path.isAbsolute(expanded)) {
    fullPath = path.resolve(expanded);
  } else {
    const normalized = path.normalize(expanded);
    if (!normalized || normalized === "." || normalized.startsWith("..") || path.isAbsolute(normalized)) return null;
    fullPath = path.resolve(root, normalized);
  }
  try {
    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(fullPath);
    if (!isSameOrInside(realFile, realRoot)) return null;
    const relativePath = path.relative(realRoot, realFile).split(path.sep).join("/");
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath) || shouldIgnoreRelative(relativePath)) return null;
    return { relativePath, text: fs.readFileSync(realFile, "utf8") };
  } catch {
    return null;
  }
}

function expandHome(value = "") {
  const text = String(value || "");
  if (text === "~") return process.env.HOME || text;
  if (text.startsWith("~/")) return path.join(process.env.HOME || "", text.slice(2));
  return text;
}

function isSameOrInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeMode(value = "auto") {
  const mode = String(value || "auto").trim().toLowerCase().replace(/[_\s-]+/g, "_");
  if (["full", "full_context", "force_full"].includes(mode)) return "full";
  if (["micro", "micro_context"].includes(mode)) return "micro";
  if (["observe", "observe_only", "off", "none"].includes(mode)) return "observe";
  return "auto";
}

function compactObject(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => {
    if (entry === undefined || entry === null || entry === "") return false;
    if (Array.isArray(entry) && !entry.length) return false;
    return true;
  }));
}
