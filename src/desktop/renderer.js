const api = window.scopeleaseDesktop;

const elements = {
  repoPath: document.getElementById("repoPath"),
  statusPill: document.getElementById("statusPill"),
  portValue: document.getElementById("portValue"),
  openExternal: document.getElementById("openExternal"),
  revealOutput: document.getElementById("revealOutput"),
  nodeStatus: document.getElementById("nodeStatus"),
  codexStatus: document.getElementById("codexStatus"),
  claudeStatus: document.getElementById("claudeStatus"),
  tasksStatus: document.getElementById("tasksStatus"),
  measurementStatus: document.getElementById("measurementStatus"),
  measurementCounts: document.getElementById("measurementCounts"),
  frame: document.getElementById("scopeleaseFrame"),
  logOutput: document.getElementById("logOutput"),
  lastCommand: document.getElementById("lastCommand"),
  logPanel: document.getElementById("logPanel"),
  workspace: document.querySelector(".workspace"),
};

let state = {
  repoPath: "",
  url: "",
  port: null,
  outputDir: "",
  autoStart: false,
  preflight: null,
  health: null,
  measurementMode: null,
  liveConnected: false,
  running: false,
};

let healthTimer = null;

function renderRuntimePill() {
  if (state.running) {
    elements.statusPill.textContent = "working";
    elements.statusPill.className = "pill";
    return;
  }
  if (state.liveConnected) {
    elements.statusPill.textContent = "live";
    elements.statusPill.className = "pill live";
    return;
  }
  if (state.port || state.url) {
    elements.statusPill.textContent = "offline";
    elements.statusPill.className = "pill error";
    return;
  }
  elements.statusPill.textContent = state.repoPath ? "ready" : "choose";
  elements.statusPill.className = "pill ready";
}

function setBusy(isBusy) {
  state.running = isBusy;
  for (const button of document.querySelectorAll("button")) {
    button.disabled = isBusy && !["cancelCommand", "toggleLog", "toggleControls"].includes(button.id);
  }
  document.getElementById("cancelCommand").disabled = !isBusy;
  renderRuntimePill();
  renderPreflight(state.preflight);
}

function setError(error) {
  elements.statusPill.textContent = "error";
  elements.statusPill.className = "pill error";
  appendLog(error?.stack || error?.message || String(error));
}

function appendLog(message) {
  const prefix = `[${new Date().toLocaleTimeString()}] `;
  elements.logOutput.textContent = `${prefix}${message}\n\n${elements.logOutput.textContent}`;
}

function renderState(nextState = {}) {
  state = { ...state, ...nextState };
  if (Object.prototype.hasOwnProperty.call(nextState, "health")) {
    state.liveConnected = Boolean(nextState.health?.ok);
    if (nextState.health?.measurementMode) state.measurementMode = nextState.health.measurementMode;
  }
  if (Object.prototype.hasOwnProperty.call(nextState, "measurementMode")) {
    state.measurementMode = nextState.measurementMode;
  }
  elements.repoPath.value = state.repoPath || "";
  elements.portValue.textContent = state.port || "-";
  elements.openExternal.textContent = state.url || "-";
  elements.revealOutput.textContent = state.outputDir || "-";
  renderPreflight(state.preflight);
  renderMeasurementMode();
  renderRuntimePill();
  const frameUrl = sidecarFrameUrl(state.url);
  if (frameUrl && elements.frame.src !== frameUrl) elements.frame.src = frameUrl;
}

function renderStatus(element, ok, text, { warn = false } = {}) {
  element.textContent = text;
  element.className = ok ? "" : warn ? "warn" : "missing";
}

function renderPreflight(preflight = state.preflight) {
  if (!preflight) return;
  const repoSelected = Boolean(preflight.repo?.selected);
  const nodeText = preflight.node?.ok
    ? `${preflight.node.version || "ready"}`
    : "missing";
  const codexText = preflight.agents?.codex?.ok ? "ready" : "missing";
  const claudeText = preflight.agents?.claude?.ok ? "ready" : "missing";
  const tasksText = preflight.evidence?.tasksExists ? "ready" : "missing";

  renderStatus(elements.nodeStatus, preflight.node?.ok, nodeText);
  renderStatus(elements.codexStatus, preflight.agents?.codex?.ok, codexText, { warn: true });
  renderStatus(elements.claudeStatus, preflight.agents?.claude?.ok, claudeText, { warn: true });
  renderStatus(elements.tasksStatus, preflight.evidence?.tasksExists, tasksText);

  document.getElementById("openProject").disabled = state.running || !repoSelected;
  document.getElementById("attachProject").disabled = state.running || !repoSelected;
  document.getElementById("exportEvidence").disabled = state.running || !repoSelected;
  document.getElementById("permissionFixtures").disabled = state.running || !repoSelected;
  document.getElementById("pairCodex").disabled = state.running || !repoSelected || !preflight.agents?.codex?.ok || !preflight.evidence?.tasksExists;
  document.getElementById("pairClaude").disabled = state.running || !repoSelected || !preflight.agents?.claude?.ok || !preflight.evidence?.tasksExists;
  document.getElementById("pairToken").disabled = state.running || !repoSelected || !preflight.evidence?.tasksExists;
  document.getElementById("measurementOn").disabled = state.running || !repoSelected;
  document.getElementById("measurementOff").disabled = state.running || !repoSelected;
  document.getElementById("measurementRefresh").disabled = state.running || !repoSelected;
}

function renderMeasurementMode() {
  const mode = state.measurementMode || state.health?.measurementMode || {};
  const enabled = mode.enabled !== false;
  elements.measurementStatus.textContent = enabled ? "on" : "off";
  elements.measurementStatus.className = enabled ? "" : "warn";
  const actualCount = Number(state.health?.actualWorkEvents || 0);
  const mcpCount = Number(state.health?.mcpContextEvents || 0);
  elements.measurementCounts.textContent = `default/scopelease events ${actualCount} · MCP ${mcpCount}`;
}

async function refreshPreflight(repoPath = state.repoPath) {
  const preflight = await api.getPreflight({ repoPath });
  renderState({ preflight });
  return preflight;
}

async function refreshHealth() {
  if (!state.port) {
    state.health = null;
    state.liveConnected = false;
    renderRuntimePill();
    return null;
  }
  const result = await api.getHealth({ repoPath: state.repoPath }).catch(() => null);
  if (!result) {
    state.liveConnected = false;
    renderRuntimePill();
    return null;
  }
  renderState({ ...(result.state || {}), health: result.health });
  return result;
}

async function refreshMeasurementMode() {
  if (!state.repoPath) return null;
  const result = await api.getMeasurementMode({ repoPath: state.repoPath });
  renderState({ measurementMode: result.measurementMode, ...(result.state || {}) });
  appendLog(`Measurement mode is ${result.measurementMode?.enabled === false ? "off" : "on"}.`);
  return result;
}

async function setMeasurementMode(enabled) {
  if (!state.repoPath) return;
  const result = await api.setMeasurementMode({ repoPath: state.repoPath, enabled });
  renderState({ measurementMode: result.measurementMode, ...(result.state || {}) });
  await refreshHealth();
  appendLog(`Measurement mode ${enabled ? "enabled" : "disabled"}.`);
}

function startHealthLoop() {
  if (healthTimer) window.clearInterval(healthTimer);
  healthTimer = window.setInterval(() => {
    refreshHealth().catch(() => {
      state.liveConnected = false;
      renderRuntimePill();
    });
  }, 2500);
  return refreshHealth();
}

async function startProject(repoPath = state.repoPath) {
  setBusy(true);
  try {
    appendLog(`Starting ScopeLease server for ${repoPath || "current repository"}`);
    const nextState = await api.startProject({ repoPath });
    renderState(nextState);
    await refreshPreflight(nextState.repoPath);
    await startHealthLoop();
    appendLog(`ScopeLease is running at ${nextState.url}`);
  } catch (error) {
    setError(error);
  } finally {
    setBusy(false);
  }
}

async function selectRepo() {
  const repoPath = await api.selectRepo();
  if (!repoPath) return;
  renderState({ repoPath });
  await startProject(repoPath);
}

async function attachProject() {
  setBusy(true);
  try {
    const nextState = await api.attachProject({ repoPath: state.repoPath });
    renderState(nextState);
    await refreshPreflight(nextState.repoPath);
    appendLog("Attached MCP config and Codex hooks for this repository.");
  } catch (error) {
    setError(error);
  } finally {
    setBusy(false);
  }
}

function summarizeResult(result) {
  const lines = [`${result.kind} exited with code ${result.code}`];
  if (result.outputDir) lines.push(`Output: ${result.outputDir}`);
  if (result.parsed?.summary) lines.push(JSON.stringify(result.parsed.summary, null, 2));
  if (result.parsed?.fixtures) lines.push(`Fixtures: ${result.parsed.fixtures.length}`);
  if (result.parsed?.pairs) lines.push(`Pairs: ${result.parsed.pairs.length}`);
  if (result.stderr?.trim()) lines.push(`stderr:\n${result.stderr.trim()}`);
  if (result.stdout?.trim()) lines.push(`stdout:\n${result.stdout.trim().slice(0, 3500)}`);
  return lines.join("\n");
}

async function runAction(kind) {
  setBusy(true);
  try {
    appendLog(`Running ${kind}`);
    const result = await api.runAction({ kind, repoPath: state.repoPath });
    renderState({ outputDir: result.outputDir, preflight: result.preflight });
    elements.lastCommand.textContent = `${kind} · code ${result.code}`;
    appendLog(summarizeResult(result));
  } catch (error) {
    setError(error);
  } finally {
    setBusy(false);
  }
}

async function cancelCommand() {
  const result = await api.cancelCommand();
  appendLog(result.cancelled ? `Cancelled ${result.kind}` : result.reason);
}

function reloadFrame() {
  if (!state.url) return;
  const frameUrl = sidecarFrameUrl(state.url);
  elements.frame.src = `${frameUrl}${frameUrl.includes("?") ? "&" : "?"}reload=${Date.now()}`;
  appendLog("Reloaded ScopeLease view.");
}

function toggleLog() {
  const hidden = elements.logPanel.classList.toggle("hidden");
  elements.workspace.classList.toggle("log-hidden", hidden);
  document.getElementById("toggleLog").setAttribute("aria-pressed", String(!hidden));
}

function toggleControls() {
  const collapsed = document.body.classList.toggle("controls-collapsed");
  document.getElementById("toggleControls").setAttribute("aria-pressed", String(!collapsed));
}

function sidecarFrameUrl(url = "") {
  if (!url) return "";
  const parsed = new URL(url);
  parsed.searchParams.set("sidecar", "1");
  return parsed.toString();
}

document.getElementById("selectRepo").addEventListener("click", selectRepo);
document.getElementById("openProject").addEventListener("click", () => startProject());
document.getElementById("attachProject").addEventListener("click", attachProject);
document.getElementById("exportEvidence").addEventListener("click", () => runAction("exportEvidence"));
document.getElementById("permissionFixtures").addEventListener("click", () => runAction("permissionFixtures"));
document.getElementById("pairToken").addEventListener("click", () => runAction("pairToken"));
document.getElementById("pairCodex").addEventListener("click", () => runAction("pairCodex"));
document.getElementById("pairClaude").addEventListener("click", () => runAction("pairClaude"));
document.getElementById("measurementOn").addEventListener("click", () => setMeasurementMode(true));
document.getElementById("measurementOff").addEventListener("click", () => setMeasurementMode(false));
document.getElementById("measurementRefresh").addEventListener("click", refreshMeasurementMode);
document.getElementById("reloadFrame").addEventListener("click", reloadFrame);
document.getElementById("cancelCommand").addEventListener("click", cancelCommand);
document.getElementById("toggleControls").addEventListener("click", toggleControls);
document.getElementById("toggleLog").addEventListener("click", toggleLog);
elements.openExternal.addEventListener("click", () => state.url && api.openExternal(state.url));
elements.revealOutput.addEventListener("click", () => state.outputDir && api.revealPath(state.outputDir));

api.onMenuAction((action) => {
  const actions = {
    selectRepo,
    reloadFrame,
    attachProject,
    exportEvidence: () => runAction("exportEvidence"),
    permissionFixtures: () => runAction("permissionFixtures"),
    pairToken: () => runAction("pairToken"),
    pairCodex: () => runAction("pairCodex"),
    pairClaude: () => runAction("pairClaude"),
    cancelCommand,
  };
  actions[action]?.();
});

api.onCommandEvent((event) => {
  if (event.type === "start") {
    setBusy(true);
    elements.lastCommand.textContent = `${event.kind} · running`;
    appendLog(`Started ${event.kind}`);
    return;
  }
  if (event.type === "stdout" && event.text.trim()) {
    appendLog(`stdout:\n${event.text.trim().slice(-1800)}`);
    return;
  }
  if (event.type === "stderr" && event.text.trim()) {
    appendLog(`stderr:\n${event.text.trim().slice(-1800)}`);
    return;
  }
  if (event.type === "close") {
    setBusy(false);
    elements.lastCommand.textContent = `${event.kind} · code ${event.code}`;
    appendLog(`Closed ${event.kind} with code ${event.code}${event.signal ? ` (${event.signal})` : ""}`);
    refreshPreflight().catch(setError);
    refreshHealth().catch(setError);
    return;
  }
  if (event.type === "cancel") appendLog(`Cancel requested for ${event.kind}`);
  if (event.type === "error") appendLog(`Command error: ${event.message}`);
});

api
  .getState()
  .then((initialState) => {
    renderState(initialState);
    document.getElementById("cancelCommand").disabled = true;
    if (initialState.autoStart) return startProject(initialState.repoPath);
    setBusy(false);
    startHealthLoop().catch(setError);
    appendLog("Choose a repository to start ScopeLease.");
    return refreshPreflight(initialState.repoPath);
  })
  .catch(setError);
