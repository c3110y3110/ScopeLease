import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeRepository, loadState, recordGuardDecision } from "../analyzer.js";
import { actionGrant, normalizeAgentAction } from "./action-policy.js";
import { evaluateAgentAction } from "./guard.js";

const SCOPELEASE_SOURCE_CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../cli.js");

export function enforceAgentAction(repoPath, {
  action = null,
  hookEvent = null,
  request = "",
  budget = 8000,
  graphBackendPayload = null,
  graphBackendName = "",
  graphBackendSource = "",
  source = "cli:enforce",
  workIntent = "",
  pairId = "",
  runId = ""
} = {}) {
  const root = path.resolve(repoPath);
  const normalizedAction = normalizeAgentAction(action || actionFromHookEvent(hookEvent));
  const userRequest = String(request || hookEvent?.prompt || hookEvent?.userRequest || "").trim();
  const analysis = analyzeRepository(root, {
    budget: Number(budget || 8000),
    userRequest,
    graphBackendPayload,
    graphBackendName,
    graphBackendSource
  });
  const state = loadState(root) || {};
  const verdict = buildScopeLeaseControlVerdict(normalizedAction, root)
    || evaluateAgentAction({ action: normalizedAction, analysis, state });
  recordGuardDecision(root, {
    verdict,
    action: normalizedAction,
    request: userRequest,
    source,
    workIntent,
    pairId,
    runId
  });
  const allowed = enforcementAllows(verdict, normalizedAction);
  return {
    kind: "scopelease.enforcement_verdict",
    enforced: true,
    allowed,
    exitCode: allowed ? 0 : (verdict.verdict === "deny" ? 2 : 3),
    reason: allowed ? "action allowed by ScopeLease guard or signed approval lease" : enforcementBlockReason(verdict),
    action: normalizedAction,
    actionGrant: actionGrant(normalizedAction),
    graphScopeHash: verdict.graphScopeHash || verdict.decisionBundle?.scope?.graphScopeHash || null,
    reviewFrontierHash: verdict.reviewFrontierHash || verdict.decisionBundle?.scope?.reviewFrontierHash || null,
    permissionFrontierHash: verdict.permissionFrontierHash || verdict.decisionBundle?.scope?.permissionFrontierHash || null,
    verdict,
    hook: hookEvent ? {
      event: String(hookEvent.hook_event_name || ""),
      tool: String(hookEvent.tool_name || "")
    } : null
  };
}

export function runGuardedCommand(repoPath, {
  command = "",
  request = "",
  budget = 8000,
  graphBackendPayload = null,
  graphBackendName = "",
  graphBackendSource = "",
  source = "cli:guarded-exec",
  workIntent = "",
  pairId = "",
  runId = "",
  env = process.env,
  stdio = "inherit"
} = {}) {
  const commandText = String(command || "").trim();
  if (!commandText) throw new Error("guarded-exec command is required after --");
  const enforcement = enforceAgentAction(repoPath, {
    action: { kind: "bash", command: commandText },
    request,
    budget,
    graphBackendPayload,
    graphBackendName,
    graphBackendSource,
    source,
    workIntent,
    pairId,
    runId
  });
  if (!enforcement.allowed) {
    return { ...enforcement, command: { status: "blocked", command: commandText } };
  }
  const child = spawnSync(commandText, {
    cwd: path.resolve(repoPath),
    env,
    encoding: "utf8",
    shell: true,
    stdio
  });
  return {
    ...enforcement,
    command: {
      status: child.status ?? 1,
      signal: child.signal || null,
      error: child.error ? String(child.error.message || child.error) : "",
      stdout: typeof child.stdout === "string" ? child.stdout : "",
      stderr: typeof child.stderr === "string" ? child.stderr : "",
      command: commandText
    },
    exitCode: child.status ?? (child.signal ? 1 : 0)
  };
}

export function actionFromHookEvent(event = {}) {
  const toolName = String(event.tool_name || event.tool || "").trim();
  const input = event.tool_input || event.input || {};
  if (/^bash$/i.test(toolName)) {
    return {
      kind: "bash",
      command: String(input.command || input.cmd || input.script || "")
    };
  }
  if (/^(apply_patch|edit|write)$/i.test(toolName)) {
    return {
      kind: "edit",
      paths: extractHookEditPaths(input),
      apply: true
    };
  }
  if (/^(read|grep|glob|ls)$/i.test(toolName)) {
    return {
      kind: "read",
      paths: extractHookEditPaths(input)
    };
  }
  return {
    kind: String(toolName || "unknown"),
    paths: extractHookEditPaths(input)
  };
}

function enforcementAllows(verdict = {}, action = {}) {
  if (verdict.verdict === "allow_with_log") return true;
  return verdict.verdict === "prepare_only" && actionGrant(action) === "propose_patch";
}

function enforcementBlockReason(verdict = {}) {
  if (verdict.verdict === "ask_once") {
    return "action requires an approval lease before execution";
  }
  return verdict.reason || "action blocked by ScopeLease enforcement";
}

const SCOPELEASE_CONTROL_SUBCOMMANDS = new Set([
  "guard",
  "approve",
  "enforce",
  "pretool",
  "pep",
  "digest",
  "freeze-evidence",
  "verify-frozen",
  "paper-verify-frozen",
  "frozen-evidence-verify",
  "source-truth-check",
  "evidence-check",
  "source-zip",
  "source-archive",
  "package-source",
  "verify-source-zip",
  "source-zip-verify",
  "verify-source-archive"
]);

function buildScopeLeaseControlVerdict(action = {}, repoRoot = "") {
  const control = scopeleaseControlCommand(action, repoRoot);
  if (!control) return null;
  return {
    kind: "scopelease.guard_verdict",
    actionGrant: actionGrant(action),
    verdict: "allow_with_log",
    reason: "ScopeLease control command is allowed to avoid enforcement approval deadlock",
    action,
    shouldAskHuman: false,
    controlCommand: control
  };
}

function scopeleaseControlCommand(action = {}, repoRoot = "") {
  const normalized = normalizeAgentAction(action);
  if (normalized.kind !== "bash") return null;
  const command = String(normalized.command || "").trim();
  if (!command || hasUnquotedShellControl(command)) return null;
  const tokens = splitShellTokens(command).map(stripShellQuotes).filter(Boolean);
  if (!tokens.length) return null;

  const directCli = cliCommandToken(tokens[0], repoRoot);
  if (directCli && SCOPELEASE_CONTROL_SUBCOMMANDS.has(tokens[1])) {
    return { command: "scopelease-cli", subcommand: tokens[1], via: directCli };
  }

  const first = path.basename(tokens[0]);
  if (first === "scopelease" && SCOPELEASE_CONTROL_SUBCOMMANDS.has(tokens[1])) {
    return { command: "scopelease", subcommand: tokens[1], via: "bin" };
  }

  if (isNodeCommand(first) && cliCommandToken(tokens[1], repoRoot) && SCOPELEASE_CONTROL_SUBCOMMANDS.has(tokens[2])) {
    return { command: "node-scopelease-cli", subcommand: tokens[2], via: cliCommandToken(tokens[1], repoRoot) };
  }

  return null;
}

function cliCommandToken(token = "", repoRoot = "") {
  const value = stripShellQuotes(token);
  if (!value) return "";
  const resolved = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(repoRoot || process.cwd(), value);
  const expected = path.resolve(repoRoot || process.cwd(), "src/cli.js");
  if (resolved === expected) return "repo:src/cli.js";
  if (resolved === SCOPELEASE_SOURCE_CLI_PATH) return "scopelease:src/cli.js";
  return "";
}

function isNodeCommand(value = "") {
  const name = String(value || "").toLowerCase();
  return name === "node" || /^node\d+(?:\.\d+)?$/.test(name);
}

function splitShellTokens(command = "") {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(command || "")))) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

function stripShellQuotes(text = "") {
  const value = String(text || "").trim();
  if (value.length >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function hasUnquotedShellControl(command = "") {
  const text = String(command || "");
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1] || "";
    if (quote) {
      if (char === quote && text[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "\n" || char === "\r" || char === ";" || char === "|" || char === "`" || char === "<" || char === ">") return true;
    if (char === "$" && next === "(") return true;
    if (char === "&") return true;
  }
  return false;
}

function extractHookEditPaths(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const candidates = [
    source.path,
    source.file,
    source.file_path,
    source.filePath,
    source.target_file,
    source.targetFile,
    ...(Array.isArray(source.paths) ? source.paths : []),
    ...(Array.isArray(source.files) ? source.files : []),
    ...pathsFromPatchText(hookPatchText(input, source))
  ].filter(Boolean);
  const rawPaths = [];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim().replace(/^\/?repo\//, "");
    if (value) rawPaths.push(value);
  }
  return [...new Set(rawPaths)];
}

function hookPatchText(input = {}, source = {}) {
  return [
    typeof input === "string" ? input : "",
    source.patch,
    source.diff,
    source.input,
    source.content,
    source.command,
    source.cmd,
    source.script,
    source.stdin,
    source.text,
    source.data
  ].filter(Boolean).join("\n");
}

function pathsFromPatchText(text = "") {
  const value = String(text || "");
  if (!value) return [];
  const paths = [];
  for (const line of value.split(/\r?\n/)) {
    const direct = line.match(/^\*\*\* (?:Add|Update|Delete) File:\s+(.+)$/);
    if (direct) paths.push(direct[1].trim());
    const git = line.match(/^(?:---|\+\+\+) [ab]\/(.+)$/);
    if (git && git[1] !== "/dev/null") paths.push(git[1].trim());
  }
  return paths;
}
