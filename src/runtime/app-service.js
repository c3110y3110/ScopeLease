import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decisionPath, ensureDir } from "../fs-utils.js";
import { requireNodeExecutable } from "./node-runtime.js";
import { ensureLocalStateIgnored } from "../analyzer.js";

const DEFAULT_PORT = 3928;
const DEFAULT_HUB_PORT = 4030;
const PROJECT_PORT_RANGE = 20000;
const RESERVED_PROJECT_PORTS = new Set([DEFAULT_HUB_PORT]);
const DEFAULT_SCAN_INTERVAL = 30000;

export function projectPort(repoPath = ".") {
  const root = path.resolve(repoPath);
  const hash = createHash("sha1").update(root).digest();
  return avoidReservedProjectPort(DEFAULT_PORT + (hash.readUInt32BE(0) % PROJECT_PORT_RANGE));
}

export function attachScopeLeaseProject({
  repoPath,
  port = null,
  enableModelProxy = envEnablesModelProxy(),
  scopeleaseCliPath = cliPath(),
  nodePath = requireNodeExecutable()
}) {
  const root = path.resolve(repoPath);
  const resolvedPort = resolveProjectPort(port, root);
  const resolvedNodePath = requireNodeExecutable({ candidates: [nodePath] });
  ensureDir(decisionPath(root));
  ensureLocalStateIgnored(root);
  const config = ensureProjectCodexConfig(root, resolvedPort, { enableModelProxy, scopeleaseCliPath, nodePath: resolvedNodePath });
  const hooks = ensureProjectCodexHooks(root, resolvedPort, { scopeleaseCliPath, nodePath: resolvedNodePath });
  return {
    repo: root,
    port: resolvedPort,
    config,
    hooks,
    mcp: {
      command: resolvedNodePath,
      args: [path.resolve(scopeleaseCliPath), "mcp", root]
    },
    modelProxyEnabled: projectConfigHasScopeLeaseProxy(root)
  };
}

export function attachScopeLeaseClaudeProject({
  repoPath,
  scopeleaseCliPath = cliPath(),
  nodePath = requireNodeExecutable()
}) {
  const root = path.resolve(repoPath);
  const resolvedNodePath = requireNodeExecutable({ candidates: [nodePath] });
  ensureDir(decisionPath(root));
  ensureLocalStateIgnored(root);
  const mcpConfig = ensureProjectClaudeMcp(root, { scopeleaseCliPath, nodePath: resolvedNodePath });
  const settings = ensureProjectClaudeHooks(root, { scopeleaseCliPath, nodePath: resolvedNodePath });
  return {
    repo: root,
    agent: "claude",
    mcpConfig,
    settings,
    mcp: {
      command: resolvedNodePath,
      args: [path.resolve(scopeleaseCliPath), "mcp", root]
    }
  };
}

export function ensureProjectClaudeMcp(root, { scopeleaseCliPath = cliPath(), nodePath = requireNodeExecutable() } = {}) {
  const mcpPath = path.join(root, ".mcp.json");
  let current = {};
  if (fs.existsSync(mcpPath)) {
    try { current = JSON.parse(fs.readFileSync(mcpPath, "utf8")); } catch { current = {}; }
  }
  const servers = current.mcpServers && typeof current.mcpServers === "object" ? current.mcpServers : {};
  const command = path.isAbsolute(nodePath) ? path.resolve(nodePath) : String(nodePath || "node");
  servers.scopelease = {
    command,
    args: [path.resolve(scopeleaseCliPath), "mcp", path.resolve(root)]
  };
  const next = { ...current, mcpServers: servers };
  fs.writeFileSync(mcpPath, `${JSON.stringify(next, null, 2)}\n`);
  return mcpPath;
}

export function ensureProjectClaudeHooks(root, { scopeleaseCliPath = cliPath(), nodePath = requireNodeExecutable() } = {}) {
  const claudeDir = path.join(root, ".claude");
  const hooksDir = path.join(claudeDir, "hooks");
  const settingsPath = path.join(claudeDir, "settings.json");
  const hookScriptPath = path.join(hooksDir, "scopelease-claude-hook.js");
  ensureDir(hooksDir);
  const script = buildHookScript({ scopeleaseCliPath, port: projectPort(root), nodePath });
  if (!fs.existsSync(hookScriptPath) || fs.readFileSync(hookScriptPath, "utf8") !== script) {
    fs.writeFileSync(hookScriptPath, script, { mode: 0o755 });
  }
  fs.chmodSync(hookScriptPath, 0o755);
  writeMergedHooksFile(settingsPath, hookScriptPath, nodePath);
  return settingsPath;
}

export async function ensureScopeLeaseApp({
  repoPath,
  port = null,
  scanInterval = DEFAULT_SCAN_INTERVAL,
  request = "",
  openBrowser = false,
  enableModelProxy = envEnablesModelProxy(),
  nodePath = requireNodeExecutable()
}) {
  const root = path.resolve(repoPath);
  const resolvedPort = resolveProjectPort(port, root);
  const resolvedNodePath = requireNodeExecutable({ candidates: [nodePath] });
  const requestText = normalizeRequestText(request);
  const health = await fetchHealth(resolvedPort);
  if (health?.ok) {
    if (isHubHealth(health)) {
      throw new Error(`Port ${resolvedPort} is serving ScopeLease hub and is reserved for global project inventory.`);
    }
    if (path.resolve(health.repo || "") !== root) {
      throw new Error(`Port ${resolvedPort} is already serving another repo: ${health.repo}`);
    }
    const attachment = attachScopeLeaseProject({ repoPath: root, port: resolvedPort, enableModelProxy, nodePath: resolvedNodePath });
    if (requestText) await updateRequest(resolvedPort, requestText);
    if (openBrowser) openUrl(appUrl(resolvedPort));
    return {
      started: false,
      pid: null,
      repo: root,
      port: resolvedPort,
      url: appUrl(resolvedPort),
      proxyBaseUrl: health.runtime?.proxyBaseUrl || proxyUrl(resolvedPort),
      usageEndpoint: health.runtime?.usageEndpoint || usageUrl(resolvedPort),
      modelProxyEnabled: attachment.modelProxyEnabled,
      config: attachment.config,
      hooks: attachment.hooks,
      mcp: attachment.mcp
    };
  }

  const attachment = attachScopeLeaseProject({ repoPath: root, port: resolvedPort, enableModelProxy, nodePath: resolvedNodePath });
  const serverArgs = [
    cliPath(),
    "proxy",
    root,
    "--port",
    String(resolvedPort),
    "--scan-interval",
    String(scanInterval)
  ];
  if (requestText) serverArgs.push("--request", requestText);
  if (enableModelProxy) serverArgs.push("--enable-model-proxy");

  const child = spawn(resolvedNodePath, serverArgs, {
    cwd: root,
    detached: true,
    stdio: ["ignore", logFd(root), logFd(root)]
  });
  child.unref();

  const ready = await waitForHealth(resolvedPort, root);
  if (openBrowser) openUrl(appUrl(resolvedPort));
  return {
    started: true,
    pid: child.pid,
    repo: root,
    port: resolvedPort,
    url: appUrl(resolvedPort),
    proxyBaseUrl: ready.runtime?.proxyBaseUrl || proxyUrl(resolvedPort),
    usageEndpoint: ready.runtime?.usageEndpoint || usageUrl(resolvedPort),
    modelProxyEnabled: attachment.modelProxyEnabled,
    config: attachment.config,
    hooks: attachment.hooks,
    mcp: attachment.mcp
  };
}

export async function ensureScopeLeaseHub({
  repoPath = ".",
  port = DEFAULT_HUB_PORT,
  scanInterval = DEFAULT_SCAN_INTERVAL,
  openBrowser = false,
  nodePath = requireNodeExecutable()
} = {}) {
  const root = path.resolve(repoPath || ".");
  const resolvedPort = Number(port || DEFAULT_HUB_PORT);
  const resolvedNodePath = requireNodeExecutable({ candidates: [nodePath] });
  ensureDir(decisionPath(root));

  const health = await fetchHealth(resolvedPort, { timeoutMs: 1000 });
  if (health?.ok) {
    if (health.runtime?.mode !== "hub") {
      throw new Error(`Port ${resolvedPort} is already serving ${health.runtime?.mode || "scopelease"} for ${health.repo || "unknown repo"}.`);
    }
    if (openBrowser) openUrl(appUrl(resolvedPort));
    return {
      started: false,
      pid: null,
      repo: root,
      port: resolvedPort,
      url: appUrl(resolvedPort),
      runtime: health.runtime
    };
  }

  const serverArgs = [
    cliPath(),
    "hub-server",
    root,
    "--port",
    String(resolvedPort),
    "--scan-interval",
    String(scanInterval)
  ];

  const child = spawn(resolvedNodePath, serverArgs, {
    cwd: root,
    detached: true,
    stdio: ["ignore", logFd(root), logFd(root)]
  });
  child.unref();

  const ready = await waitForRuntime(resolvedPort, (next) => next?.ok && next.runtime?.mode === "hub", "ScopeLease hub");
  if (openBrowser) openUrl(appUrl(resolvedPort));
  return {
    started: true,
    pid: child.pid,
    repo: root,
    port: resolvedPort,
    url: appUrl(resolvedPort),
    runtime: ready.runtime
  };
}

export function ensureProjectCodexConfig(root, port = projectPort(root), { enableModelProxy = envEnablesModelProxy(), scopeleaseCliPath = cliPath(), nodePath = requireNodeExecutable() } = {}) {
  const configDir = path.join(root, ".codex");
  const configPath = path.join(configDir, "config.toml");
  ensureDir(configDir);
  const current = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const line = `openai_base_url = "${proxyUrl(port)}"`;
  const shouldUseModelProxy = enableModelProxy || hasScopeLeaseProxyConfig(current);
  const withoutMcp = normalizeProjectConfigComments(removeScopeLeaseMcpServer(current));
  const withoutBaseUrl = removeBaseUrlLines(withoutMcp, { all: shouldUseModelProxy });
  const base = withoutBaseUrl.trim() ? withoutBaseUrl : defaultProjectCodexConfig();
  const config = shouldUseModelProxy ? ensureTopLevelBaseUrl(base, line) : base;
  const desired = ensureScopeLeaseMcpServer(ensureHooksFeature(config), { scopeleaseCliPath, root, nodePath })
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd() + "\n";
  if (current !== desired) fs.writeFileSync(configPath, desired);
  return configPath;
}

function projectConfigHasScopeLeaseProxy(root) {
  const configPath = path.join(root, ".codex", "config.toml");
  return fs.existsSync(configPath) && hasScopeLeaseProxyConfig(fs.readFileSync(configPath, "utf8"));
}

function hasScopeLeaseProxyConfig(content = "") {
  return /^\s*openai_base_url\s*=\s*"http:\/\/localhost:\d+\/proxy\/v1"\s*$/m.test(content);
}

function defaultProjectCodexConfig() {
  return [
    "# Project-local ScopeLease attachment.",
    "# Codex loads this only for trusted projects; ScopeLease effects stay scoped to this repo.",
    "# Exact model usage proxying remains opt-in because it requires an OpenAI API key with Responses API write scope.",
    "",
    "[features]",
    "hooks = true",
    ""
  ].join("\n");
}

function removeBaseUrlLines(content, { all = false } = {}) {
  if (all) {
    return content
      .replace(/^\s*# ScopeLease usage proxy\s*\n\s*openai_base_url\s*=.*(?:\n|$)/gm, "")
      .replace(/^\s*openai_base_url\s*=.*(?:\n|$)/gm, "");
  }
  return content
    .replace(/^\s*# ScopeLease usage proxy\s*\n\s*openai_base_url\s*=\s*"http:\/\/localhost:\d+\/proxy\/v1".*(?:\n|$)/gm, "")
    .replace(/^\s*openai_base_url\s*=\s*"http:\/\/localhost:\d+\/proxy\/v1".*(?:\n|$)/gm, "");
}

function ensureTopLevelBaseUrl(content, line) {
  if (!content.trim()) {
    return [
      "# Project-local ScopeLease usage metering.",
      "# Codex loads project-scoped config only for trusted projects.",
      "# Keep ScopeLease running before opening a Codex session in this repo.",
      "",
      line,
      "",
      "[features]",
      "hooks = true",
      ""
    ].join("\n");
  }

  const tableMatch = content.match(/^\s*\[[^\]]+\]\s*$/m);
  if (!tableMatch || tableMatch.index === undefined) {
    return `${content.replace(/\s*$/, "")}\n\n# ScopeLease usage proxy\n${line}\n`;
  }

  const beforeTables = content.slice(0, tableMatch.index).replace(/\s*$/, "");
  const fromFirstTable = content.slice(tableMatch.index).replace(/^\s*/, "");
  const prefix = beforeTables ? `${beforeTables}\n\n` : "";
  return `${prefix}# ScopeLease usage proxy\n${line}\n\n${fromFirstTable}`;
}

function ensureScopeLeaseMcpServer(content = "", { scopeleaseCliPath, root, nodePath = requireNodeExecutable() }) {
  const base = removeScopeLeaseMcpServer(content).replace(/\s*$/, "");
  const command = path.isAbsolute(nodePath) ? path.resolve(nodePath) : String(nodePath || "node");
  const block = [
    "[mcp_servers.scopelease]",
    `command = ${JSON.stringify(command)}`,
    `args = ${tomlArray([path.resolve(scopeleaseCliPath), "mcp", path.resolve(root)])}`,
    ""
  ].join("\n");
  return base ? `${base}\n\n${block}` : block;
}

function removeScopeLeaseMcpServer(content = "") {
  const lines = String(content || "").split("\n");
  const output = [];
  let skipping = false;

  for (const line of lines) {
    if (/^\s*\[mcp_servers\.scopelease\]\s*$/.test(line)) {
      skipping = true;
      continue;
    }

    if (skipping && /^\s*\[[^\]]+\]\s*$/.test(line)) {
      skipping = false;
    }

    if (!skipping) output.push(line);
  }

  return output.join("\n").replace(/\n{3,}/g, "\n\n");
}

function normalizeProjectConfigComments(content = "") {
  const replacement = [
    "# Project-local ScopeLease attachment.",
    "# Codex loads this only for trusted projects; ScopeLease effects stay scoped to this repo.",
    "# Exact model usage proxying remains opt-in because it requires an OpenAI API key with Responses API write scope.",
    "",
    ""
  ].join("\n");
  return String(content || "")
    .replace(
    /^# Project-local ScopeLease usage metering\.\n# Codex loads project-scoped config only for trusted projects\.\n# Keep ScopeLease running on port \d+ before opening a Codex session in this repo\.\n+/,
    replacement
    )
    .replace(
      /^(# Project-local ScopeLease attachment\.\n# Codex loads this only for trusted projects; ScopeLease effects stay scoped to this repo\.\n# Exact model usage proxying remains opt-in because it requires an OpenAI API key with Responses API write scope\.\n)(?=\[features\])/,
      "$1\n"
    );
}

function tomlArray(values = []) {
  return `[${values.map((value) => JSON.stringify(String(value))).join(", ")}]`;
}

function envEnablesModelProxy() {
  return /^(1|true|yes)$/i.test(String(process.env.SCOPELEASE_ENABLE_MODEL_PROXY || ""));
}

export function ensureProjectCodexHooks(root, port = projectPort(root), { scopeleaseCliPath = cliPath(), nodePath = requireNodeExecutable() } = {}) {
  const hooksDir = path.join(root, ".codex", "hooks");
  const hooksPath = path.join(root, ".codex", "hooks.json");
  const hookScriptPath = path.join(hooksDir, "scopelease-codex-hook.js");
  ensureDir(hooksDir);

  const script = buildHookScript({ scopeleaseCliPath, port, nodePath });
  if (!fs.existsSync(hookScriptPath) || fs.readFileSync(hookScriptPath, "utf8") !== script) {
    fs.writeFileSync(hookScriptPath, script, { mode: 0o755 });
  }
  fs.chmodSync(hookScriptPath, 0o755);
  writeMergedHooksFile(hooksPath, hookScriptPath, nodePath);
  return hooksPath;
}

function ensureHooksFeature(content = "") {
  const normalized = String(content || "").replace(/^\s*codex_hooks\s*=\s*true\s*$/gm, "hooks = true");
  if (/^\s*hooks\s*=\s*true\s*$/m.test(normalized)) return normalized;
  if (/^\s*\[features\]\s*$/m.test(normalized)) {
    return normalized.replace(/^(\s*\[features\]\s*)$/m, `$1\nhooks = true`);
  }
  return normalized.trim()
    ? `${normalized.replace(/\s*$/, "")}\n\n[features]\nhooks = true\n`
    : normalized;
}

function writeMergedHooksFile(hooksPath, hookScriptPath, nodePath) {
  const current = readHooksJson(hooksPath);
  const hooks = current.hooks && typeof current.hooks === "object" ? current.hooks : {};
  const command = `${JSON.stringify(nodePath)} ${JSON.stringify(hookScriptPath)}`;
  const definitions = {
    SessionStart: {
      matcher: "startup|resume|clear",
      hooks: [{ type: "command", command, timeout: 10, statusMessage: "ScopeLease 연결 확인" }]
    },
    UserPromptSubmit: {
      hooks: [{ type: "command", command, timeout: 10, statusMessage: "ScopeLease 입력 기록" }]
    },
    PreToolUse: {
      matcher: "Bash|apply_patch|Edit|Write",
      hooks: [{ type: "command", command, timeout: 15, statusMessage: "ScopeLease 권한 검사" }]
    },
    PostToolUse: {
      matcher: "Bash|apply_patch|Edit|Write",
      hooks: [{ type: "command", command, timeout: 15, statusMessage: "ScopeLease 작업 기록" }]
    },
    Stop: {
      hooks: [{ type: "command", command, timeout: 10 }]
    }
  };
  const next = { ...current, hooks: { ...hooks } };
  for (const [event, definition] of Object.entries(definitions)) {
    const existing = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    next.hooks[event] = [
      ...existing.filter((item) => !hookGroupUsesScopeLease(item)),
      definition
    ];
  }
  fs.writeFileSync(hooksPath, `${JSON.stringify(next, null, 2)}\n`);
}

function readHooksJson(hooksPath) {
  if (!fs.existsSync(hooksPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  } catch {
    return {};
  }
}

function hookGroupUsesScopeLease(group = {}) {
  return (group.hooks || []).some((hook) => String(hook.command || "").includes("scopelease-codex-hook.js"));
}

function buildHookScript({ scopeleaseCliPath, port, nodePath }) {
  return `#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SCOPELEASE_CLI_PATH = ${JSON.stringify(scopeleaseCliPath)};
const SCOPELEASE_NODE_PATH = ${JSON.stringify(nodePath)};
const SCOPELEASE_PORT = Number(process.env.SCOPELEASE_PORT || ${JSON.stringify(String(port))});
const MAX_TEXT_CHARS = Number(process.env.SCOPELEASE_HOOK_MAX_CHARS || 80000);
const MEASURE_LANE = normalizeLane(process.env.SCOPELEASE_MEASURE_LANE || process.env.SCOPELEASE_LANE || "auto");
const EXPLICIT_PAIR_ID = normalizeRequestText(process.env.SCOPELEASE_PAIR_ID || process.env.SCOPELEASE_PAIR || "");
const EXPLICIT_WORK_INTENT = normalizeRequestText(process.env.SCOPELEASE_WORK_INTENT || process.env.SCOPELEASE_PAIR_WORK_INTENT || "");
const EXPLICIT_RUN_ID = normalizeRequestText(process.env.SCOPELEASE_RUN_ID || process.env.SCOPELEASE_PAIR_RUN_ID || "");

const event = await readHookEvent();
const root = path.resolve(event.cwd || process.cwd());

try {
  const startupRequest = event.hook_event_name === "UserPromptSubmit" ? event.prompt || "" : "";
  if (event.hook_event_name === "PreToolUse") {
    await enforceToolUse(root, event);
    await ensureApp(root, startupRequest).catch((error) => writeHookLog(root, error));
    process.exit(0);
  }
  await ensureApp(root, startupRequest);
  await recordHookEvent(root, event);
} catch (error) {
  writeHookLog(root, error);
  if (event.hook_event_name === "PreToolUse") {
    console.error(error?.message || error);
    process.exit(2);
  }
}

async function readHookEvent() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function ensureApp(root, request) {
  const health = await fetchJson(\`http://127.0.0.1:\${SCOPELEASE_PORT}/api/health\`).catch(() => null);
  if (health?.ok && path.resolve(health.repo || "") === root) return;
  if (health?.ok) {
    throw new Error(\`ScopeLease port \${SCOPELEASE_PORT} is serving \${health.repo}; expected \${root}\`);
  }

  const requestText = normalizeRequestText(request);
  const args = [
    SCOPELEASE_CLI_PATH,
    "app",
    root,
    "--port",
    String(SCOPELEASE_PORT)
  ];
  if (requestText) args.push("--request", requestText);
  spawnSync(SCOPELEASE_NODE_PATH || process.execPath, args, {
    cwd: root,
    stdio: "ignore",
    timeout: 10000
  });

  const nextHealth = await fetchJson(\`http://127.0.0.1:\${SCOPELEASE_PORT}/api/health\`).catch(() => null);
  if (!nextHealth?.ok || path.resolve(nextHealth.repo || "") !== root) {
    throw new Error(\`ScopeLease app is not serving \${root} on port \${SCOPELEASE_PORT}\`);
  }
}

async function recordHookEvent(root, value) {
  const eventName = String(value.hook_event_name || "");
  if (eventName === "PreToolUse") return;

  if (eventName === "UserPromptSubmit") {
    const prompt = String(value.prompt || "").trim();
    if (prompt) {
      const previousState = readCurrentRequest(root);
      const requestState = buildRequestState(prompt, value, previousState);
      writeCurrentRequest(root, requestState);
      await postJson(root, "/api/request", requestState);
      await postJson(root, "/api/measure", {
        phase: "input",
        text: truncate(prompt),
        source: "codex-hook:user-prompt",
        lane: requestState.lane,
        label: "Codex user prompt",
        request: requestState.userRequest,
        workIntent: requestState.workIntent,
        requestHash: requestState.requestHash,
        pairId: requestState.pairId,
        runId: requestState.runId
      });
    }
    return;
  }

  if (eventName === "PostToolUse") {
    const measurement = toolMeasurement(root, value);
    if (measurement?.text) await postJson(root, "/api/measure", measurement);
    return;
  }

  if (eventName === "Stop") {
    const text = String(value.last_assistant_message || "").trim();
    if (text) {
      const requestState = readCurrentRequest(root);
      await postJson(root, "/api/measure", {
        phase: "output",
        text: truncate(text),
        source: "codex-hook:stop",
        lane: requestState.lane,
        label: "Codex final response",
        request: requestState.userRequest,
        workIntent: requestState.workIntent,
        requestHash: requestState.requestHash,
        pairId: requestState.pairId,
        runId: requestState.runId
      });
    }
  }
}

async function enforceToolUse(root, value) {
  const requestState = readCurrentRequest(root);
  const args = [
    SCOPELEASE_CLI_PATH,
    "enforce",
    root,
    "--hook-json",
    JSON.stringify(value || {}),
    "--request",
    requestState.userRequest || "",
    "--work-intent",
    requestState.workIntent || "",
    "--pair-id",
    requestState.pairId || "",
    "--run-id",
    requestState.runId || "",
    "--source",
    "codex-hook:pre-tool-use",
    "--format",
    "json"
  ];
  const result = spawnSync(SCOPELEASE_NODE_PATH || process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 15000
  });
  if (result.status === 0) return;
  const message = [result.stdout, result.stderr].filter(Boolean).join("\\n").trim();
  throw new Error(message || \`ScopeLease blocked \${value.tool_name || "tool"} before execution\`);
}

function toolMeasurement(root, value) {
  const toolName = String(value.tool_name || "tool");
  const phase = /apply_patch|edit|write/i.test(toolName) ? "edit" : "explore";
  const text = truncate(JSON.stringify({
    tool: toolName,
    input: value.tool_input || {},
    response: value.tool_response || {}
  }, null, 2));
  if (!text || text === "{}") return null;
  const requestState = readCurrentRequest(root);
  return {
    phase,
    text,
    source: \`codex-hook:\${toolName}\`,
    callType: "tool_call",
    toolName,
    hookEventName: String(value.hook_event_name || "PostToolUse"),
    lane: requestState.lane,
    label: phase === "edit" ? \`Codex edit: \${toolName}\` : \`Codex tool: \${toolName}\`,
    request: requestState.userRequest,
    workIntent: requestState.workIntent,
    requestHash: requestState.requestHash,
    pairId: requestState.pairId,
    runId: requestState.runId
  };
}

function writeCurrentRequest(root, state) {
  try {
    const dir = path.join(root, ".decision");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "hook-current-request.txt"), state.userRequest || "");
    fs.writeFileSync(path.join(dir, "hook-current-request.json"), \`\${JSON.stringify(state, null, 2)}\\n\`);
  } catch {}
}

function readCurrentRequest(root) {
  const jsonPath = path.join(root, ".decision", "hook-current-request.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    if (parsed?.userRequest) return parsed;
  } catch {}
  try {
    const userRequest = fs.readFileSync(path.join(root, ".decision", "hook-current-request.txt"), "utf8").trim();
    return buildRequestState(userRequest, {});
  } catch {
    return buildRequestState("", {});
  }
}

function buildRequestState(prompt, value = {}, previousState = {}) {
  const userRequest = normalizeRequestText(prompt);
  const sessionKey = String(value.session_id || value.sessionId || value.conversation_id || value.transcript_path || "").trim();
  const promptTurnKey = String(value.prompt_id || value.promptId || value.message_id || value.messageId || value.turn_id || value.turnId || value.timestamp || value.created_at || value.createdAt || Date.now()).trim();
  const requestKey = requestHash(userRequest);
  const inheritedIntent = isContinuationPrompt(userRequest) ? normalizeRequestText(previousState.workIntent) : "";
  const workIntent = EXPLICIT_WORK_INTENT || inheritedIntent || deriveWorkIntent(userRequest);
  const inheritedPairId = isContinuationPrompt(userRequest) ? normalizeRequestText(previousState.pairId) : "";
  const pairSeed = workIntent || requestKey || userRequest;
  const pairId = EXPLICIT_PAIR_ID || inheritedPairId || (pairSeed ? \`pair:\${hashText(pairSeed).slice(0, 12)}\` : "");
  const taskIntent = buildTaskIntent(userRequest, { pairingKey: workIntent, pairId });
  const runSeed = [sessionKey || "no-session", requestKey, promptTurnKey].filter(Boolean).join(":");
  const inheritedLane = isContinuationPrompt(userRequest) ? normalizeLane(previousState.lane || "") : "";
  const lane = MEASURE_LANE === "auto"
    ? (inheritedLane && inheritedLane !== "auto" ? inheritedLane : "default-codex")
    : MEASURE_LANE;
  return {
    userRequest,
    workIntent,
    pairingKey: workIntent,
    taskIntent,
    requestHash: requestKey,
    pairId,
    runId: userRequest ? (EXPLICIT_RUN_ID || \`codex:\${hashText(runSeed).slice(0, 12)}\`) : "",
    lane,
    intentSource: inheritedIntent ? "previous_continuation" : "current_prompt"
  };
}

function isContinuationPrompt(value = "") {
  const text = normalizeRequestText(value).replace(/\\s+/g, " ").toLowerCase();
  if (!text || text.length > 120) return false;
  if (/^(ok|okay|yes|yep|go ahead|proceed|continue)\\b/.test(text)) return true;
  if (/^(응|ㅇㅇ|그래|좋아|진행|계속|해봐|고쳐|수정|적용|다 고치자|전부 고쳐|모두 고쳐)/.test(text)) return true;
  return /(고치자|진행해|해봐|적용해|수정해)/.test(text) && /(그|다|전부|모두|그렇게|그럼)/.test(text);
}

function truncate(text) {
  const value = String(text || "");
  if (value.length <= MAX_TEXT_CHARS) return value;
  return \`\${value.slice(0, MAX_TEXT_CHARS)}\\n...[scopelease truncated \${value.length - MAX_TEXT_CHARS} chars]\`;
}

function normalizeRequestText(value) {
  if (value === true || value === false || value == null) return "";
  const text = String(value).trim();
  return text === "true" || text === "false" ? "" : text;
}

function normalizeLane(value = "") {
  const lane = normalizeRequestText(value).toLowerCase().replace(/[_\\s]+/g, "-");
  if (!lane || lane === "auto") return "auto";
  if (/(default|baseline|without-scopelease|no-scopelease|plain-codex)/.test(lane)) return "default-codex";
  return "scopelease-codex";
}

function deriveWorkIntent(value = "") {
  const normalized = normalizeRequestText(extractUserRequestText(value)).replace(/\\s+/g, " ");
  if (!normalized) return "";
  const paths = unique((normalized.match(/\\b[A-Za-z0-9_.@/-]+\\.(?:m?js|cjs|ts|tsx|jsx|json|md|toml|ya?ml|css|html|py|go|rs|java|kt|swift|c|cpp|h|hpp|sql|sh)(?::\\d+)?\\b/g) || []).map((item) => item.toLowerCase().replace(/:\\d+$/, "")));
  const findings = [];
  for (const match of normalized.matchAll(/\\bfinding\\s*#?\\s*(\\d+)\\b/gi)) findings.push(\`finding-\${match[1]}\`);
  for (const match of normalized.matchAll(/\\[p([0-3])\\]/gi)) findings.push(\`p\${match[1]}\`);
  const stop = new Set(["the", "and", "for", "with", "from", "this", "that", "request", "user", "input", "지금", "실제", "내용", "기준", "하면", "해서", "하고", "한다", "있는", "없는", "으로", "에서", "이걸", "그걸", "보자", "해봐", "해야", "하는", "하게", "같은", "이번", "요청"]);
  const terms = [];
  for (const token of normalized.toLowerCase().match(/[\\p{L}\\p{N}_@./:-]{2,}/gu) || []) {
    const cleaned = token.replace(/^[^\\p{L}\\p{N}_]+|[^\\p{L}\\p{N}_]+$/gu, "");
    if (!cleaned || /^\\d+$/.test(cleaned) || stop.has(cleaned) || paths.includes(cleaned.replace(/:\\d+$/, ""))) continue;
    terms.push(cleaned);
  }
  return unique([...paths, ...findings, ...terms]).slice(0, 24).join(" ").slice(0, 240) || normalized.slice(0, 240);
}

function buildTaskIntent(value = "", options = {}) {
  const userRequest = normalizeRequestText(extractUserRequestText(value));
  const pairingKey = normalizeRequestText(options.pairingKey || deriveWorkIntent(userRequest));
  const paths = unique((userRequest.match(/\\b[A-Za-z0-9_.@/-]+\\.(?:m?js|cjs|ts|tsx|jsx|json|md|toml|ya?ml|css|html|py|go|rs|java|kt|swift|c|cpp|h|hpp|sql|sh)(?::\\d+)?\\b/g) || []).map((item) => item.toLowerCase().replace(/:\\d+$/, ""))).slice(0, 16);
  const lower = userRequest.toLowerCase();
  const riskHypotheses = [];
  if (/(approval|lease|승인|권한|scope)/.test(lower)) riskHypotheses.push("approval lease scope may be broader than intended");
  if (/(token|절감|saving|baseline|pair)/.test(lower)) riskHypotheses.push("token savings may be overstated without paired baseline evidence");
  if (/(auth|session|permission|role|인증|세션|권한)/.test(lower)) riskHypotheses.push("auth or permission path may require senior review");
  return {
    kind: "scopelease.semantic_task_intent",
    taskType: inferTaskType(userRequest),
    objective: userRequest.slice(0, 360),
    targetArtifacts: paths,
    nonGoals: /(provider|billing|과금|full repo|전체 저장소)/.test(lower)
      ? ["provider/full-repo savings as exact paired savings"]
      : [],
    decisionNeeded: riskHypotheses.length > 0,
    riskHypotheses,
    successCriteria: inferTaskSuccessCriteria(userRequest),
    pairing: {
      taskId: pairingKey ? \`task:\${hashText(pairingKey).slice(0, 12)}\` : "",
      pairingKey,
      pairId: normalizeRequestText(options.pairId || "")
    },
    confidence: Math.min(0.95, Math.round((0.45 + (pairingKey ? 0.2 : 0) + (paths.length ? 0.15 : 0) + (riskHypotheses.length ? 0.15 : 0)) * 100) / 100)
  };
}

function inferTaskType(value = "") {
  const lower = normalizeRequestText(value).toLowerCase();
  if (/(논문|paper|research|experiment|calibration|검증|계측|benchmark)/.test(lower)) return "research_design";
  if (/(review|검토|찾아|문제|risk|bug|finding)/.test(lower)) return "review";
  if (/(fix|고쳐|수정|패치|patch|implement|구현|추가)/.test(lower)) return "code_change";
  if (/(document|docs|문서|정리|readme)/.test(lower)) return "documentation";
  return "general_coding_task";
}

function inferTaskSuccessCriteria(value = "") {
  const lower = normalizeRequestText(value).toLowerCase();
  const criteria = [];
  if (/(논문|paper|research|calibration|계측)/.test(lower)) criteria.push("separate product telemetry from research calibration evidence");
  if (/(token|절감|saving|baseline|pair)/.test(lower)) criteria.push("only claim exact savings when paired default/scopelease evidence exists and scopelease input is lower");
  if (/(approval|lease|승인|권한|scope)/.test(lower)) criteria.push("enforce scoped approval by action, path, command, risk, and time");
  return criteria.length ? criteria : ["record the task objective and verification result"];
}

function extractUserRequestText(value = "") {
  const text = normalizeRequestText(value);
  const match = text.match(/User request:\\s*([\\s\\S]*?)(?:\\n\\s*ScopeLease context:|\\n\\s*Boundary:|\\n\\s*\`\`\`json|$)/i);
  return normalizeRequestText(match?.[1] || text);
}

function requestHash(value = "") {
  const normalized = normalizeRequestText(extractUserRequestText(value)).replace(/\\s+/g, " ");
  return normalized ? \`sha1:\${hashText(normalized)}\` : "";
}

function hashText(value = "") {
  return createHash("sha1").update(String(value || "")).digest("hex");
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

async function postJson(root, pathname, body) {
  try {
    const response = await fetch(\`http://127.0.0.1:\${SCOPELEASE_PORT}\${pathname}\`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) writeHookLog(root, new Error(\`ScopeLease POST \${pathname} failed with HTTP \${response.status}\`));
  } catch (error) {
    writeHookLog(root, new Error(\`ScopeLease POST \${pathname} failed: \${error?.message || error}\`));
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
  return response.json();
}

function writeHookLog(root, error) {
  try {
    const dir = path.join(root, ".decision");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "hook.log"), \`[\${new Date().toISOString()}] \${error?.stack || error?.message || error}\\n\`);
  } catch {}
}
`;
}

async function waitForHealth(port, root) {
  return waitForRuntime(port, (health) => health?.ok && !isHubHealth(health) && path.resolve(health.repo || "") === root, "ScopeLease app");
}

async function waitForRuntime(port, predicate, label = "ScopeLease runtime") {
  const deadline = Date.now() + 30000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const health = await fetchHealth(port);
      if (predicate(health)) return health;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become healthy on port ${port}${lastError ? `: ${lastError.message}` : ""}`);
}

export async function fetchHealth(port, { timeoutMs = 3000 } = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function updateRequest(port, request) {
  await fetch(`http://127.0.0.1:${port}/api/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userRequest: request }),
    signal: AbortSignal.timeout(3000)
  }).catch(() => {});
}

function openUrl(url) {
  if (process.platform !== "darwin") return;
  const child = spawn("open", [url], { detached: true, stdio: "ignore" });
  child.unref();
}

function cliPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../cli.js");
}

function logFd(root) {
  const logPath = decisionPath(root, "view.log");
  rotateLog(logPath);
  return fs.openSync(logPath, "a");
}

function rotateLog(logPath, maxBytes = 1_000_000) {
  try {
    if (!fs.existsSync(logPath)) return;
    if (fs.statSync(logPath).size < maxBytes) return;
    const archived = `${logPath}.1`;
    if (fs.existsSync(archived)) fs.rmSync(archived);
    fs.renameSync(logPath, archived);
  } catch {}
}

export function appUrl(port) {
  return `http://localhost:${port}/graph.html?v=scopelease-local-kg-v1`;
}

export function proxyUrl(port) {
  return `http://localhost:${port}/proxy/v1`;
}

function usageUrl(port) {
  return `http://localhost:${port}/api/usage`;
}

function normalizeRequestText(value) {
  if (value === true || value === false || value == null) return "";
  const text = String(value).trim();
  return text === "true" || text === "false" ? "" : text;
}

function resolveProjectPort(value, root) {
  if (value === true || value === false || value == null || value === "") return projectPort(root);
  if (String(value).toLowerCase() === "auto") return projectPort(root);
  const port = Number(value);
  if (RESERVED_PROJECT_PORTS.has(port)) {
    throw new Error(`Port ${port} is reserved for ScopeLease hub. Use the project stable port or choose another repo-local port.`);
  }
  return Number.isFinite(port) && port > 0 ? port : projectPort(root);
}

function avoidReservedProjectPort(port) {
  let next = Number(port || DEFAULT_PORT);
  while (RESERVED_PROJECT_PORTS.has(next)) next += 1;
  return next;
}

function isHubHealth(health = {}) {
  return health?.runtime?.mode === "hub" || health?.runtime?.hubMode === true;
}
