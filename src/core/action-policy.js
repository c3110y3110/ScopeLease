import os from "node:os";
import path from "node:path";

const SAFE_TEST_COMMANDS = [
  "npm test",
  "node --test",
  "npm run test",
  "npm run lint",
  "npm run desktop:check",
  "npm run paper:report",
  "npm run paper:report:controlled",
  "npm run paper:report:controlled:fixtures",
  "npm run paper:report:controlled:delegation",
  "npm run paper:report:full",
  "npm run paper:report:full:fixtures",
  "npm run paper:report:full:delegation",
  "npm run paper:tbench:scopelease-panel",
  "npm run paper:tbench:scopelease-panel:dry-run",
  "npm run paper:tbench:stop-scopelease-panel",
  "npm run paper:live-pilot",
  "npm run paper:live-pilot:dry-run",
  "npm run paper:live-pilot:codex",
  "npm run paper:live-pilot:codex:dry-run",
  "npm run paper:live-pilot:claude",
  "npm run paper:live-pilot:claude:dry-run",
  "npm run paper:formal:discover-repos",
  "npm run paper:formal:discover-repos:resource-bounded",
  "npm run paper:formal:stop-local-main",
  "npm run paper:formal:local-main",
  "npm run paper:formal:local-main:dry-run",
  "npm run paper:formal:local-main:resource-bounded",
  "npm run paper:formal:local-main:resource-bounded:dry-run",
  "npm run paper:formal:stop-local-main:claude",
  "npm run paper:formal:local-main:claude",
  "npm run paper:formal:local-main:claude:dry-run",
  "npm run paper:formal:local-main:claude:resource-bounded",
  "npm run paper:formal:local-main:claude:resource-bounded:dry-run",
  "npm run paper:formal:fresh:dry-run",
  "npm run paper:human-study",
  "npm run paper:permission-fixtures",
  "npm run paper:review-bench",
  "npm run paper:verify:frozen",
  "npm run paper:source-truth-check",
  "npm run paper:source-zip",
  "npm run paper:verify:source-zip",
  "npm run paper:verify:source-zip:test",
  "command -v codex",
  "command -v claude",
  "codex --version",
  "claude --version"
];

const SAFE_LOCAL_READ_COMMANDS = new Set([
  "cat",
  "grep",
  "head",
  "ls",
  "nl",
  "pwd",
  "rg",
  "tail",
  "wc"
]);

const SAFE_GIT_READ_SUBCOMMANDS = new Set([
  "branch",
  "diff",
  "grep",
  "log",
  "ls-files",
  "rev-parse",
  "show",
  "status"
]);

const GIT_READ_BLOCKED_OPTIONS = [
  "--exec-path",
  "--ext-diff",
  "--output"
];

const HARD_DENY_COMMAND_PATTERNS = [
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+merge\b/i,
  /\bgit\s+checkout\s+--\b/i,
  /\bcurl\b.*\|\s*(sh|bash)\b/i
];

const NETWORK_COMMAND_PATTERNS = [
  /\b(curl|wget)\b\s+.*\bhttps?:\/\//i,
  /\bgit\s+clone\b/i,
  /\bgh\s+repo\s+clone\b/i,
  /\b(npm|pnpm|yarn)\s+(install|i|add|ci)\b/i,
  /\b(pip|pip3)\s+install\b/i,
  /\bpython(?:3)?\s+-m\s+pip\s+install\b/i,
  /\buv\s+(?:pip\s+)?install\b/i,
  /\bbrew\s+install\b/i,
  /\bnpx\b/i,
  /\bssh\b/i,
  /\bscp\b/i,
  /\brsync\b.*:/i
];

const URL_PATTERN = /\bhttps?:\/\/[^\s"'`<>\\)]+/gi;

export function normalizeAgentAction(action = {}) {
  const originalKind = String(action.kind || action.type || "").trim();
  const kind = normalizeKind(originalKind);
  const normalized = {
    ...action,
    kind
  };
  const paths = [
    ...(Array.isArray(action.paths) ? action.paths : []),
    ...(Array.isArray(action.files) ? action.files : []),
    action.path,
    action.file
  ].filter(Boolean);
  if (paths.length) {
    const normalizedPaths = [];
    const invalidPaths = [];
    for (const item of paths) {
      const normalizedPath = normalizeActionPath(item);
      if (normalizedPath) normalizedPaths.push(normalizedPath);
      else invalidPaths.push(String(item || ""));
    }
    if (normalizedPaths.length) normalized.paths = [...new Set(normalizedPaths)];
    if (invalidPaths.length) normalized.invalidPaths = [...new Set(invalidPaths)];
  }
  if (kind === "edit" && normalized.apply === undefined && originalKind === "propose_patch") normalized.apply = false;
  if (action.command) normalized.command = String(action.command).trim();
  if (action.target) normalized.target = String(action.target).trim();
  return normalized;
}

export function actionGrant(action = {}) {
  const normalized = normalizeAgentAction(action);
  if (normalized.kind === "read") return "read";
  if (normalized.kind === "edit") return normalized.apply === false ? "propose_patch" : "apply_patch";
  if (normalized.kind === "bash" && isNetworkCommand(normalized.command)) return "network";
  if (normalized.kind === "bash" && isSafeLocalReadCommand(normalized.command)) return "read";
  if (normalized.kind === "bash") return isSafeTestCommand(normalized.command) ? "run_tests" : "run_command";
  if (normalized.kind === "checkpoint") return "checkpoint";
  if (normalized.kind === "network") return "network";
  if (normalized.kind === "external_write") return "external_write";
  return normalized.kind || "unknown";
}

export function isHardDenyAction(action = {}, { networkScopes = [] } = {}) {
  const normalized = normalizeAgentAction(action);
  if (normalized.kind === "external_write") return true;
  if (normalized.kind === "network") return !networkWithinScope(normalized, networkScopes);
  if (normalized.kind !== "bash") return false;
  if (
    isDangerousRmCommand(normalized.command)
    || isDangerousChmodCommand(normalized.command)
    || HARD_DENY_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized.command || ""))
  ) return true;
  if (isNetworkCommand(normalized.command)) {
    if (hasUnsafeShellControl(normalized.command)) return true;
    return !networkWithinScope(normalized, networkScopes);
  }
  return false;
}

export function isSafeLocalRead(action = {}) {
  const normalized = normalizeAgentAction(action);
  return normalized.kind === "read"
    || (normalized.kind === "bash" && isSafeLocalReadCommand(normalized.command));
}

export function hasUnsafeShellControl(command = "", { allowPipes = false } = {}) {
  const text = String(command || "").trim();
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1] || "";
    if (quote) {
      if (quote === "\"" && char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "$" && next === "(") return true;
    if (char === "`" || char === ";" || char === "<" || char === ">" || char === "\n" || char === "\r") return true;
    if (char === "&") return true;
    if (char === "|") {
      if (next === "|") return true;
      if (!allowPipes) return true;
    }
  }
  return quote !== "";
}

export function isSafeTestCommand(command = "") {
  const text = String(command || "").trim();
  if (!text) return false;
  if (hasUnsafeShellControl(text)) return false;
  if (hasUnsafeCommandPathEscape(text, { allowCodexAttachments: true })) return false;
  return SAFE_TEST_COMMANDS.some((safe) => text === safe || text.startsWith(`${safe} `));
}

export function isSafeLocalReadCommand(command = "") {
  const text = String(command || "").trim();
  if (!text) return false;
  if (hasUnsafeShellControl(text, { allowPipes: true })) return false;
  if (hasUnsafeCommandPathEscape(text, { allowCodexAttachments: true })) return false;
  const pipeline = splitShellPipeline(text);
  if (pipeline.length > 1) {
    return pipeline.every((segment, index) => (
      segment && isSafeSimpleLocalReadCommand(segment, { allowStdin: index > 0 })
    ));
  }
  return isSafeSimpleLocalReadCommand(text);
}

function isSafeSimpleLocalReadCommand(command = "", { allowStdin = false } = {}) {
  const tokens = splitCommandTokens(command).map(stripShellQuotes).filter(Boolean);
  if (!tokens.length) return false;
  const executable = path.basename(tokens[0]).toLowerCase();
  if (executable === "git") return isSafeGitReadCommand(tokens);
  if (executable === "sed") return isSafeSedReadCommand(tokens, { allowStdin });
  if (!SAFE_LOCAL_READ_COMMANDS.has(executable)) return false;
  if (executable === "pwd") return tokens.slice(1).every((token) => ["-L", "-P"].includes(token));
  return true;
}

export function hasUnsafeCommandPathEscape(command = "", { allowCodexAttachments = false } = {}) {
  return splitCommandTokens(command).some((token) => isUnsafePathLikeArgument(token, { allowCodexAttachments }));
}

export function isNetworkCommand(command = "") {
  const text = String(command || "").trim();
  return NETWORK_COMMAND_PATTERNS.some((pattern) => pattern.test(text));
}

export function networkTargets(action = {}) {
  const normalized = normalizeAgentAction(action);
  const texts = [
    normalized.target,
    normalized.url,
    normalized.command
  ].filter(Boolean);
  return [...new Set(texts.flatMap(extractNetworkUrls).map(canonicalNetworkUrl).filter(Boolean))];
}

export function taskScopedNetworkScopes(analysis = {}) {
  const texts = [
    analysis.userRequest,
    analysis.contextPack?.userRequest?.text,
    analysis.contextPack?.agentContext?.taskIntent?.objective,
    analysis.contextPack?.taskIntent?.objective
  ].filter(Boolean);
  return [...new Set(texts
    .flatMap(extractNetworkUrls)
    .map(networkOriginScope)
    .filter(Boolean))];
}

export function networkWithinScope(action = {}, scopes = []) {
  const targets = networkTargets(action);
  const normalizedScopes = [...new Set((scopes || []).map(normalizeNetworkScope).filter(Boolean))];
  if (!targets.length || !normalizedScopes.length) return false;
  return targets.every((target) => normalizedScopes.some((scope) => networkTargetMatchesScope(target, scope)));
}

export function isTaskScopedNetworkAction(action = {}, analysis = {}) {
  return networkWithinScope(action, taskScopedNetworkScopes(analysis));
}

function splitCommandTokens(command = "") {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(command || "")))) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

function splitShellPipeline(command = "") {
  const text = String(command || "").trim();
  const parts = [];
  let current = "";
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1] || "";
    if (quote) {
      current += char;
      if (quote === "\"" && char === "\\" && next) {
        current += next;
        index += 1;
        continue;
      }
      if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "\\" && next) {
      current += char + next;
      index += 1;
      continue;
    }
    if (char === "|" && next !== "|") {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (quote) return [];
  parts.push(current.trim());
  return parts;
}

function isDangerousRmCommand(command = "") {
  const tokens = splitCommandTokens(command).map((token) => stripShellQuotes(token).toLowerCase());
  const rmIndex = tokens.findIndex((token) => token === "rm" || token.endsWith("/rm"));
  if (rmIndex < 0) return false;
  const args = tokens.slice(rmIndex + 1);
  const hasRecursive = args.some((token) => token === "--recursive" || /^-[a-z]*r[a-z]*$/.test(token));
  const hasForce = args.some((token) => token === "--force" || /^-[a-z]*f[a-z]*$/.test(token));
  return hasRecursive && hasForce;
}

function isDangerousChmodCommand(command = "") {
  const tokens = splitCommandTokens(command).map((token) => stripShellQuotes(token));
  const commandIndex = tokens.findIndex((token) => {
    const commandName = token.toLowerCase();
    return commandName === "chmod" || commandName.endsWith("/chmod");
  });
  if (commandIndex < 0) return false;
  return tokens.slice(commandIndex + 1).some((token) => token === "--recursive" || /^-[A-Za-z]*R[A-Za-z]*$/.test(token));
}

function isUnsafePathLikeArgument(token = "", { allowCodexAttachments = false } = {}) {
  let text = String(token || "").trim();
  if (!text || text === "--") return false;
  if (text.startsWith("-") && !text.includes("=")) return false;
  if (text.startsWith("-") && text.includes("=")) {
    text = text.slice(text.indexOf("=") + 1);
  }
  text = stripShellQuotes(text);
  if (!looksLikePathArgument(text)) return false;
  if (allowCodexAttachments && isCodexAttachmentPath(text)) return false;
  return !normalizeActionPath(text);
}

function isCodexAttachmentPath(value = "") {
  const text = String(value || "").trim();
  if (!text || text.includes("\0")) return false;
  const home = os.homedir();
  if (!home) return false;
  const resolved = path.resolve(text);
  const attachmentRoot = path.resolve(home, ".codex", "attachments");
  return resolved === attachmentRoot || resolved.startsWith(attachmentRoot + path.sep);
}

function stripShellQuotes(text = "") {
  const value = String(text || "").trim();
  if (value.length >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function extractNetworkUrls(text = "") {
  const matches = String(text || "").match(URL_PATTERN) || [];
  return matches.map((item) => item.replace(/[.,;:!?]+$/g, ""));
}

function canonicalNetworkUrl(value = "") {
  try {
    const parsed = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.href.replace(/\/$/, "");
  } catch {
    return "";
  }
}

function networkOriginScope(value = "") {
  try {
    const parsed = new URL(String(value || "").trim());
    if (!isInternalNetworkHost(parsed.hostname)) return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function normalizeNetworkScope(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const parsed = new URL(text);
    if (!isInternalNetworkHost(parsed.hostname)) return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function networkTargetMatchesScope(target = "", scope = "") {
  try {
    const parsed = new URL(target);
    const scoped = new URL(scope);
    return isInternalNetworkHost(parsed.hostname)
      && parsed.protocol === scoped.protocol
      && parsed.host === scoped.host;
  } catch {
    return false;
  }
}

function isInternalNetworkHost(hostname = "") {
  const host = String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (["localhost", "0.0.0.0", "::1"].includes(host)) return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (/^10(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}$/.test(host)) return true;
  return /^[a-z][a-z0-9-]*$/.test(host);
}

function looksLikePathArgument(text = "") {
  const value = String(text || "").trim().replace(/\\/g, "/");
  return value === ".."
    || value.startsWith("../")
    || value.includes("/../")
    || value.startsWith("/")
    || value.startsWith("~")
    || value.startsWith("./")
    || value.includes("/")
    || /^[A-Za-z]:\//.test(value);
}

export function isPatchPreparation(action = {}) {
  const normalized = normalizeAgentAction(action);
  return normalized.kind === "edit" && normalized.apply === false;
}

export function isLowRiskLocalAction(action = {}, analysis = {}) {
  const normalized = normalizeAgentAction(action);
  if (analysis.risk && !["low"].includes(analysis.risk)) return false;
  if (normalized.kind === "read") return true;
  if (normalized.kind === "bash") return isSafeTestCommand(normalized.command) || isSafeLocalReadCommand(normalized.command);
  if (normalized.kind === "edit") return pathsAreDocs(normalized.paths || []);
  return false;
}

export function actionPaths(action = {}) {
  const normalized = normalizeAgentAction(action);
  if (Array.isArray(normalized.paths)) return normalized.paths;
  const normalizedPath = normalizeActionPath(normalized.path);
  return normalizedPath ? [normalizedPath] : [];
}

export function actionInvalidPaths(action = {}) {
  const normalized = normalizeAgentAction(action);
  return Array.isArray(normalized.invalidPaths) ? normalized.invalidPaths : [];
}

export function pathsAreDocs(paths = []) {
  const normalized = paths.map((item) => normalizeActionPath(item));
  return normalized.length > 0
    && normalized.every(Boolean)
    && normalized.every((item) => /\.(md|mdx|txt|rst|adoc)$/i.test(item));
}

export function normalizeKind(kind = "") {
  const text = String(kind || "").trim();
  if (["write", "patch", "apply_patch", "propose_patch"].includes(text)) return "edit";
  if (["shell", "command", "run_command", "run_tests"].includes(text)) return "bash";
  return text;
}

export function defaultCommandScopes() {
  return [...SAFE_TEST_COMMANDS];
}

function isSafeGitReadCommand(tokens = []) {
  if (tokens.some((token) => GIT_READ_BLOCKED_OPTIONS.some((blocked) => token === blocked || token.startsWith(`${blocked}=`)))) {
    return false;
  }
  const subcommand = gitSubcommand(tokens);
  return SAFE_GIT_READ_SUBCOMMANDS.has(subcommand);
}

function isSafeSedReadCommand(tokens = [], { allowStdin = false } = {}) {
  let index = 1;
  if (tokens[index] !== "-n") return false;
  index += 1;
  const script = tokens[index] || "";
  index += 1;
  if (!/^\d{1,7}(?:,\d{1,7})?p$/.test(script)) return false;
  const files = tokens.slice(index);
  return (allowStdin || files.length > 0) && files.every((token) => token && !token.startsWith("-"));
}

function gitSubcommand(tokens = []) {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") return "";
    if (token === "-C") {
      index += 1;
      continue;
    }
    if (token === "--no-pager") continue;
    if (token.startsWith("-")) continue;
    return token.toLowerCase();
  }
  return "";
}

export function normalizeActionPath(value = "") {
  const raw = String(value || "").trim().replace(/\\/g, "/");
  if (!raw || raw.includes("\0")) return "";
  if (raw.startsWith("/") || raw.startsWith("~") || /^[A-Za-z]:\//.test(raw)) return "";
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) return "";
  return normalized.replace(/^\.\//, "");
}
