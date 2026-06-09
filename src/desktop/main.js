import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { attachScopeLeaseProject, ensureScopeLeaseApp, fetchHealth } from "../runtime/app-service.js";
import { getMeasurementMode, setMeasurementMode } from "../analyzer.js";
import { commandStatus, nodeRuntimeStatus, resolveNodeExecutable, runtimeEnv } from "../runtime/node-runtime.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.resolve(__dirname, "../..");
const cliPath = path.join(appRoot, "src", "cli.js");

const windows = new Set();
const projectState = {
  appRoot,
  cliPath,
  repoPath: initialRepoPath(),
  autoStart: !app.isPackaged,
  port: null,
  url: null,
  health: null,
  measurementMode: null,
  attached: false,
  lastCommand: null,
  preflight: null,
};

let runningCommand = null;

const defaultRequest =
  "ScopeLease sidecar evidence view for context reduction, approval leases, and paired metering.";

function initialRepoPath() {
  if (process.env.SCOPELEASE_REPO) return path.resolve(process.env.SCOPELEASE_REPO);
  if (!app.isPackaged) return process.cwd();
  return "";
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sendMenuAction(action) {
  for (const win of windows) {
    if (!win.isDestroyed()) win.webContents.send("menu:action", action);
  }
}

function sendCommandEvent(event) {
  for (const win of windows) {
    if (!win.isDestroyed()) win.webContents.send("command:event", event);
  }
}

function createMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "File",
        submenu: [
          { label: "Open Repository...", accelerator: "CmdOrCtrl+O", click: () => sendMenuAction("selectRepo") },
          { label: "Reload ScopeLease View", accelerator: "CmdOrCtrl+R", click: () => sendMenuAction("reloadFrame") },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "ScopeLease Sidecar",
        submenu: [
          { label: "Attach MCP and Hooks", click: () => sendMenuAction("attachProject") },
          { label: "Export Evidence Bundle", click: () => sendMenuAction("exportEvidence") },
          { label: "Run Permission Lease Fixtures", click: () => sendMenuAction("permissionFixtures") },
          { type: "separator" },
          { label: "Run Token Pair Evidence", click: () => sendMenuAction("pairToken") },
          { label: "Run Codex Pair Evidence", click: () => sendMenuAction("pairCodex") },
          { label: "Run Claude Pair Evidence", click: () => sendMenuAction("pairClaude") },
          { type: "separator" },
          { label: "Cancel Running Command", click: () => sendMenuAction("cancelCommand") },
        ],
      },
      {
        label: "View",
        submenu: [{ role: "toggleDevTools" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }],
      },
    ])
  );
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    title: "ScopeLease Sidecar",
    backgroundColor: "#070b12",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  windows.add(win);
  win.on("closed", () => windows.delete(win));
  win.loadFile(path.join(__dirname, "desktop.html"));
}

function buildPreflight(repoPath = projectState.repoPath) {
  const resolvedRepo = repoPath ? path.resolve(repoPath) : "";
  const node = nodeRuntimeStatus();
  const env = runtimeEnv({
    SCOPELEASE_NODE_PATH: node.path || process.env.SCOPELEASE_NODE_PATH || ""
  });
  const tasksPath = path.join(resolvedRepo, "examples", "mle-bench-like", "tasks.jsonl");
  const fixturesPath = path.join(resolvedRepo, ".scopelease", "fixtures", "permission-fixtures.jsonl");
  return {
    kind: "scopelease.desktop_preflight",
    generatedAt: new Date().toISOString(),
    app: {
      packaged: app.isPackaged,
      root: appRoot,
      cliPath,
      cliExists: fs.existsSync(cliPath),
    },
    repo: {
      path: resolvedRepo,
      exists: Boolean(resolvedRepo && fs.existsSync(resolvedRepo)),
      selected: Boolean(resolvedRepo),
    },
    node,
    agents: {
      codex: commandStatus("codex", { env }),
      claude: commandStatus("claude", { env }),
    },
    evidence: {
      tasksPath,
      tasksExists: fs.existsSync(tasksPath),
      fixturesPath,
      fixturesExists: fs.existsSync(fixturesPath),
    },
    runtime: {
      port: projectState.port,
      url: projectState.url,
      runningCommand: runningCommand
        ? { id: runningCommand.id, kind: runningCommand.kind, startedAt: runningCommand.startedAt }
        : null,
    },
  };
}

function refreshPreflight(repoPath = projectState.repoPath) {
  projectState.preflight = buildPreflight(repoPath);
  return projectState.preflight;
}

async function startProject({ repoPath = projectState.repoPath, request = defaultRequest } = {}) {
  const resolvedRepo = repoPath ? path.resolve(repoPath) : "";
  const preflight = refreshPreflight(resolvedRepo);
  if (!resolvedRepo) throw new Error("Choose a repository before starting ScopeLease.");
  if (!preflight.repo.exists) throw new Error(`Repository path does not exist: ${resolvedRepo}`);
  if (!preflight.app.cliExists) throw new Error(`ScopeLease CLI was not found: ${cliPath}`);
  if (!preflight.node.ok) throw new Error(preflight.node.message);

  const project = await ensureScopeLeaseApp({
    repoPath: resolvedRepo,
    request,
    openBrowser: false,
    scanInterval: 2500,
    nodePath: preflight.node.path,
  });
  const health = await fetchHealth(project.port).catch(() => null);
  const measurementMode = getMeasurementMode(resolvedRepo);

  Object.assign(projectState, {
    repoPath: resolvedRepo,
    port: project.port,
    url: project.url,
    health,
    measurementMode,
  });
  refreshPreflight(resolvedRepo);

  return { ...projectState };
}

async function attachProject({ repoPath = projectState.repoPath } = {}) {
  const resolvedRepo = repoPath ? path.resolve(repoPath) : "";
  const preflight = refreshPreflight(resolvedRepo);
  if (!resolvedRepo) throw new Error("Choose a repository before attaching MCP/hooks.");
  if (!preflight.node.ok) throw new Error(preflight.node.message);

  await attachScopeLeaseProject({ repoPath: resolvedRepo, nodePath: preflight.node.path });
  projectState.attached = true;
  refreshPreflight(resolvedRepo);
  return { ...projectState };
}

async function checkProjectHealth({ repoPath = projectState.repoPath } = {}) {
  if (repoPath) projectState.repoPath = path.resolve(repoPath);
  if (!projectState.port) {
    projectState.health = null;
    refreshPreflight(projectState.repoPath);
    return { ok: false, reason: "no_runtime", health: null, state: { ...projectState } };
  }

  const health = await fetchHealth(projectState.port, { timeoutMs: 1000 });
  projectState.health = health;
  projectState.measurementMode = health?.measurementMode || getMeasurementMode(projectState.repoPath);
  refreshPreflight(projectState.repoPath);
  return {
    ok: Boolean(health?.ok),
    reason: health?.ok ? "connected" : "offline",
    health,
    state: { ...projectState },
  };
}

function measurementModeStatus({ repoPath = projectState.repoPath } = {}) {
  const resolvedRepo = repoPath ? path.resolve(repoPath) : "";
  if (!resolvedRepo) throw new Error("Choose a repository before changing measurement mode.");
  projectState.measurementMode = getMeasurementMode(resolvedRepo);
  return { measurementMode: projectState.measurementMode, state: { ...projectState } };
}

function updateMeasurementMode({ repoPath = projectState.repoPath, enabled } = {}) {
  const resolvedRepo = repoPath ? path.resolve(repoPath) : "";
  if (!resolvedRepo) throw new Error("Choose a repository before changing measurement mode.");
  const result = setMeasurementMode(resolvedRepo, {
    enabled,
    source: "desktop:measurement-mode",
    note: enabled
      ? "Automatic Codex hook and ScopeLease MCP metering enabled from desktop."
      : "Automatic Codex hook and ScopeLease MCP metering disabled from desktop."
  });
  projectState.measurementMode = result.measurementMode;
  if (projectState.health) {
    projectState.health = { ...projectState.health, measurementMode: result.measurementMode };
  }
  return { measurementMode: result.measurementMode, state: { ...projectState } };
}

function runNodeCommand(args, cwd, { kind }) {
  return new Promise((resolve, reject) => {
    if (runningCommand) {
      reject(new Error(`A command is already running: ${runningCommand.kind}`));
      return;
    }

    const preflight = refreshPreflight(cwd);
    if (!preflight.node.ok) {
      reject(new Error(preflight.node.message));
      return;
    }

    const id = `${kind}-${stamp()}`;
    const startedAt = new Date().toISOString();
    const child = spawn(preflight.node.path, [cliPath, ...args], {
      cwd,
      env: runtimeEnv({
        SCOPELEASE_NODE_PATH: preflight.node.path,
        FORCE_COLOR: "0"
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });

    runningCommand = { id, kind, child, startedAt };
    refreshPreflight(cwd);
    sendCommandEvent({ type: "start", id, kind, args, cwd, startedAt });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      sendCommandEvent({ type: "stdout", id, kind, text });
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      sendCommandEvent({ type: "stderr", id, kind, text });
    });
    child.on("error", (error) => {
      runningCommand = null;
      refreshPreflight(cwd);
      sendCommandEvent({ type: "error", id, kind, message: error.message });
      reject(error);
    });
    child.on("close", (code, signal) => {
      runningCommand = null;
      refreshPreflight(cwd);
      let parsed = null;
      try {
        parsed = stdout.trim() ? JSON.parse(stdout) : null;
      } catch {
        parsed = null;
      }
      const result = { code, signal, stdout, stderr, parsed };
      sendCommandEvent({ type: "close", id, kind, code, signal });
      resolve(result);
    });
  });
}

async function runAction({ kind, repoPath = projectState.repoPath }) {
  const resolvedRepo = repoPath ? path.resolve(repoPath) : "";
  const preflight = refreshPreflight(resolvedRepo);
  if (!resolvedRepo) throw new Error("Choose a repository before running evidence commands.");
  if (!preflight.repo.exists) throw new Error(`Repository path does not exist: ${resolvedRepo}`);
  if (!preflight.node.ok) throw new Error(preflight.node.message);
  if (["pairToken", "pairCodex", "pairClaude"].includes(kind) && !preflight.evidence.tasksExists) {
    throw new Error(`Pair tasks file was not found: ${preflight.evidence.tasksPath}`);
  }
  if (kind === "pairCodex" && !preflight.agents.codex.ok) {
    throw new Error(preflight.agents.codex.message);
  }
  if (kind === "pairClaude" && !preflight.agents.claude.ok) {
    throw new Error(preflight.agents.claude.message);
  }

  const runStamp = stamp();
  const tasksPath = preflight.evidence.tasksPath;
  const fixturesPath = preflight.evidence.fixturesPath;

  const commands = {
    exportEvidence: [
      "export-evidence",
      resolvedRepo,
      "--output",
      path.join(resolvedRepo, ".scopelease", "evidence", `desktop-${runStamp}`),
      "--format",
      "json",
    ],
    permissionFixtures: [
      "permission-fixtures",
      resolvedRepo,
      "--run",
      "--fixtures",
      fixturesPath,
      "--output",
      path.join(resolvedRepo, ".scopelease", "fixtures", "runs", `desktop-${runStamp}`),
      "--format",
      "json",
    ],
    pairToken: [
      "pair-run",
      resolvedRepo,
      "--tasks",
      tasksPath,
      "--output",
      path.join(resolvedRepo, ".scopelease", "experiments", `desktop-token-${runStamp}`),
      "--format",
      "json",
    ],
    pairCodex: [
      "pair-run",
      resolvedRepo,
      "--tasks",
      tasksPath,
      "--output",
      path.join(resolvedRepo, ".scopelease", "experiments", `desktop-codex-${runStamp}`),
      "--agent",
      "codex",
      "--copy-worktree",
      "--format",
      "json",
    ],
    pairClaude: [
      "pair-run",
      resolvedRepo,
      "--tasks",
      tasksPath,
      "--output",
      path.join(resolvedRepo, ".scopelease", "experiments", `desktop-claude-${runStamp}`),
      "--agent",
      "claude",
      "--copy-worktree",
      "--format",
      "json",
    ],
  };

  const args = commands[kind];
  if (!args) throw new Error(`Unknown ScopeLease action: ${kind}`);

  const result = await runNodeCommand(args, resolvedRepo, { kind });
  const outputDir = args[args.indexOf("--output") + 1] || null;
  projectState.lastCommand = {
    kind,
    code: result.code,
    signal: result.signal,
    outputDir,
    at: new Date().toISOString(),
  };
  refreshPreflight(resolvedRepo);

  return { ...projectState.lastCommand, ...result, args, preflight: projectState.preflight };
}

function cancelCommand() {
  if (!runningCommand) return { cancelled: false, reason: "no command is running" };
  const { id, kind, child } = runningCommand;
  child.kill("SIGTERM");
  sendCommandEvent({ type: "cancel", id, kind });
  return { cancelled: true, id, kind };
}

function assertLocalHttpUrl(url) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`Unsupported URL: ${url}`);
  if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    throw new Error(`ScopeLease Desktop only opens local URLs: ${url}`);
  }
  return parsed.toString();
}

function assertRevealPath(targetPath) {
  if (!targetPath) throw new Error("Path is required.");
  const resolved = path.resolve(String(targetPath));
  const repoRoot = projectState.repoPath ? path.resolve(projectState.repoPath) : "";
  const realRepoRoot = repoRoot ? realPathIfExists(repoRoot) : "";
  const realTarget = realPathIfExists(resolved);
  if (!realRepoRoot || !isSameOrInsidePath(realTarget, realRepoRoot)) {
    throw new Error(`ScopeLease Desktop only reveals paths inside the selected repository: ${resolved}`);
  }
  return resolved;
}

function realPathIfExists(value) {
  try {
    if (!fs.existsSync(value)) return path.resolve(value);
    return fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function isSameOrInsidePath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

ipcMain.handle("project:start", (_event, payload) => startProject(payload));
ipcMain.handle("project:attach", (_event, payload) => attachProject(payload));
ipcMain.handle("project:preflight", (_event, payload = {}) => refreshPreflight(payload.repoPath || projectState.repoPath));
ipcMain.handle("project:health", (_event, payload = {}) => checkProjectHealth(payload));
ipcMain.handle("measurement:get", (_event, payload = {}) => measurementModeStatus(payload));
ipcMain.handle("measurement:set", (_event, payload = {}) => updateMeasurementMode(payload));
ipcMain.handle("command:run", (_event, payload) => runAction(payload));
ipcMain.handle("command:cancel", () => cancelCommand());
ipcMain.handle("state:get", () => ({ ...projectState, preflight: refreshPreflight(projectState.repoPath) }));
ipcMain.handle("shell:openExternal", (_event, url) => shell.openExternal(assertLocalHttpUrl(url)));
ipcMain.handle("path:reveal", (_event, targetPath) => {
  const safePath = assertRevealPath(targetPath);
  if (!fs.existsSync(safePath)) return false;
  const stats = fs.statSync(safePath);
  if (stats.isDirectory()) {
    shell.openPath(safePath);
  } else {
    shell.showItemInFolder(safePath);
  }
  return true;
});
ipcMain.handle("project:select", async () => {
  const result = await dialog.showOpenDialog({
    defaultPath: projectState.repoPath,
    properties: ["openDirectory"],
    title: "Select an ScopeLease repository",
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

app.whenReady().then(() => {
  refreshPreflight(projectState.repoPath);
  createMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  if (runningCommand) runningCommand.child.kill("SIGTERM");
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

process.on("uncaughtException", (error) => {
  dialog.showErrorBox("ScopeLease Desktop Error", error.stack || error.message);
});

process.on("unhandledRejection", (error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  dialog.showErrorBox("ScopeLease Desktop Error", message);
});
