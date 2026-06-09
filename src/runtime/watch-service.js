import fs from "node:fs";
import path from "node:path";
import { analyzeRepository, loadState, shouldIgnoreWatchPath } from "../analyzer.js";

export function startWatchService({
  repoPath,
  scanInterval = 2500,
  debounceMs = 250,
  initialDelayMs = 0,
  userRequest = "",
  onAnalysis = () => {},
  onError = () => {}
}) {
  const root = path.resolve(repoPath);
  let timer = null;
  let scanTimer = null;
  let lastSignature = "";

  function run(reason) {
    try {
      const configuredRequest = typeof userRequest === "function" ? userRequest() : userRequest;
      const requestText = String(configuredRequest || "").trim() || latestPersistedRequest(root);
      const analysis = analyzeRepository(root, { userRequest: requestText || "", autoMeasureWork: true });
      const signature = analysisSignature(analysis);
      const changed = signature !== lastSignature;
      lastSignature = signature;
      if (changed || reason === "initial") onAnalysis(analysis, reason);
      return analysis;
    } catch (error) {
      onError(error, reason);
      return null;
    }
  }

  function schedule(reason) {
    clearTimeout(timer);
    timer = setTimeout(() => run(reason), debounceMs);
  }

  const watcher = createWatcher(root, schedule, onError);
  if (initialDelayMs > 0) {
    timer = setTimeout(() => run("initial"), initialDelayMs);
  } else {
    run("initial");
  }
  scheduleScan();

  return {
    close() {
      clearTimeout(timer);
      clearTimeout(scanTimer);
      if (watcher) watcher.close();
    },
    analyzeNow() {
      return run("manual");
    }
  };

  function scheduleScan() {
    if (scanInterval <= 0) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      run("scan");
      scheduleScan();
    }, scanInterval);
  }
}

function latestPersistedRequest(root) {
  const state = loadState(root) || {};
  return latestMcpRequest(state) || String(state.latestAnalysis?.contextPack?.userRequest?.text || state.latestAnalysis?.userRequest || "").trim();
}

function latestMcpRequest(state = {}) {
  const event = (state.mcpContextEvents || []).find((item) => item?.userRequest);
  return String(event?.userRequest || "").trim();
}

function createWatcher(root, schedule, onError) {
  try {
    return fs.watch(root, { recursive: true }, (_eventType, filename) => {
      if (shouldIgnoreWatchPath(root, filename)) return;
      schedule("file-change");
    });
  } catch (error) {
    onError(error, "watch-start");
    return null;
  }
}

function analysisSignature(analysis) {
  return JSON.stringify({
    summary: analysis.summary,
    userRequest: analysis.contextPack?.userRequest?.text || analysis.userRequest || "",
    risk: analysis.risk,
    uncertainty: analysis.uncertainty,
    recommendation: analysis.recommendation,
    changedFiles: analysis.changes?.files || [],
    fileHashes: analysis.changes?.fileHashes || {},
    deleted: analysis.changes?.deleted || [],
    policyHits: analysis.policyHits?.map((hit) => hit.ruleId) || []
  });
}
