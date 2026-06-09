import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { analyzeRepository, buildAgentInputPayload, checkpointRepository, loadState, measurementModeForState, recordActualWork, recordGraphLayoutMetrics, recordGuardDecision, recordModelUsage, setMeasurementMode, shouldRecordAutomaticMeasurement } from "../analyzer.js";
import { evaluateAgentAction } from "../core/guard.js";
import { deriveWorkIntent, requestHash } from "../core/work-intent.js";
import { ensureScopeLeaseApp } from "./app-service.js";
import { detectAgentVisibleUsage, summarizeAgentVisibleUsage } from "./codex-usage-detector.js";
import { detectHubProjects } from "./hub-service.js";
import { startWatchService } from "./watch-service.js";
import { proxyModelUsageRequest } from "./usage-proxy.js";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};
const AGENT_USAGE_CACHE_MS = 5000;
const DEFAULT_JSON_BODY_LIMIT = 16_384;
const MEASURE_JSON_BODY_LIMIT = 160_000;
const agentUsageCache = new Map();

export function startServer({ repoPath, port = 3927, host = "127.0.0.1", scanInterval = 2500, entry = "index.html", label = "ScopeLease local app", userRequest = "", lockRoot = false, hubMode = false, enableModelProxy = false }) {
  let root = path.resolve(repoPath);
  let currentUserRequest = normalizeRequestText(userRequest);
  let runtimePort = Number(port || 0);
  let runtime = createRuntime(root, scanInterval, runtimePort, { mode: hubMode ? "hub" : lockRoot ? "repo-local" : "dashboard", enableModelProxy });
  const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public");
  const eventClients = new Set();
  let service = null;
  const sigintHandler = () => {
    service?.close();
    for (const client of eventClients) client.end();
    server.close(() => process.exit(0));
  };

  const server = http.createServer((req, res) => {
    handleRequest({
      req,
      res,
      getRoot: () => root,
      switchRoot,
      publicDir,
      entry,
      eventClients,
      broadcast: (reason) => broadcastState(root, eventClients, reason, runtime, currentUserRequest),
      getUserRequest: () => currentUserRequest,
      getRuntime: () => runtime,
      lockRoot,
      hubMode,
      enableModelProxy,
      setUserRequest: (value) => {
        currentUserRequest = normalizeRequestText(value);
      }
    });
  });

  server.listen(port, host, () => {
    const address = server.address();
    const listeningPort = typeof address === "object" && address ? address.port : port;
    runtimePort = Number(listeningPort || port || runtimePort);
    runtime = createRuntime(root, scanInterval, runtimePort, { mode: hubMode ? "hub" : lockRoot ? "repo-local" : "dashboard", enableModelProxy });
    const urlHost = host === "::1" ? "[::1]" : host;
    console.log(`${label}: http://${urlHost}:${listeningPort}`);
    if (entry !== "index.html") console.log(`Graph view: http://${urlHost}:${listeningPort}/${entry}`);
    console.log(`Repository: ${root}`);
    if (currentUserRequest) console.log(`User request: ${currentUserRequest}`);
    console.log(`Scan interval: ${scanInterval}ms`);
    if (lockRoot) console.log("Repository switching: disabled for repo-local runtime");
    if (hubMode) console.log("Hub mode: enabled; project effects remain repo-local");
  });

  service = startRepositoryWatch(root);

  process.on("SIGINT", sigintHandler);
  server.on("close", () => process.off("SIGINT", sigintHandler));

  return {
    server,
    service: {
      close() {
        service?.close();
      },
      analyzeNow() {
        return service?.analyzeNow();
      }
    }
  };

  function switchRoot(nextPath) {
    const nextRoot = resolveRepositoryPath(nextPath);
    if (nextRoot === root) {
      const analysis = service?.analyzeNow();
      broadcastState(root, eventClients, "repo-refresh", runtime, currentUserRequest);
      return { root, analysis };
    }

    service?.close();
    root = nextRoot;
    runtime = createRuntime(root, scanInterval, runtimePort || port, { mode: hubMode ? "hub" : lockRoot ? "repo-local" : "dashboard", enableModelProxy });
    service = startRepositoryWatch(root);
    broadcastState(root, eventClients, "repo-switch", runtime, currentUserRequest);
    console.log(`Repository switched: ${root}`);
    return { root, state: loadState(root) || {} };
  }

  function startRepositoryWatch(repoRoot) {
    return startWatchService({
      repoPath: repoRoot,
      scanInterval,
      initialDelayMs: 1000,
      userRequest: () => currentUserRequest,
      onAnalysis(analysis, reason) {
        if (repoRoot !== root) return;
        console.log(`[scopelease:${reason}] ${analysis.summary}`);
        broadcastState(root, eventClients, reason, runtime, currentUserRequest);
      },
      onError(error, reason) {
        console.error(`[scopelease:${reason}] ${error.message}`);
      }
    });
  }
}

function createRuntime(root, scanInterval = 0, port = 3927, { mode = "dashboard", enableModelProxy = false } = {}) {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    root,
    mode,
    hubMode: mode === "hub",
    scanIntervalMs: scanInterval,
    proxyBaseUrl: `http://localhost:${port}/proxy/v1`,
    usageEndpoint: `http://localhost:${port}/api/usage`,
    modelProxyEnabled: Boolean(enableModelProxy),
    startedAt: new Date().toISOString()
  };
}

function stateWithRuntime(state, runtime, root, options = {}) {
  const effectiveRoot = root || runtime?.root || state?.repo || "";
  const base = {
    ...(state || {}),
    measurementMode: measurementModeForState(state || {}),
    runtime: {
      ...(runtime || {}),
      root: effectiveRoot
    }
  };
  if (options.includeAgentUsage === false || !effectiveRoot) return base;

  const agentVisibleDetection = detectAgentVisibleUsageCached({ repoPath: effectiveRoot, state: state || {} });
  return {
    ...base,
    agentVisibleUsage: summarizeAgentVisibleUsage(agentVisibleDetection),
    codexSessionContext: compactCodexSessionContext(agentVisibleDetection)
  };
}

function detectAgentVisibleUsageCached({ repoPath, state = {}, force = false, maxAgeMs = AGENT_USAGE_CACHE_MS } = {}) {
  const root = path.resolve(repoPath || state.repo || ".");
  const signature = agentUsageStateSignature(state);
  const cached = agentUsageCache.get(root);
  const now = Date.now();
  if (!force && cached && cached.signature === signature && now - cached.createdAt <= maxAgeMs) {
    return cached.detection;
  }

  const detection = detectAgentVisibleUsage({ repoPath: root, state });
  agentUsageCache.set(root, { signature, createdAt: now, detection });
  return detection;
}

function agentUsageStateSignature(state = {}) {
  return JSON.stringify({
    generatedAt: state.latestAnalysis?.generatedAt || "",
    mcp: eventListSignature(state.mcpContextEvents),
    work: eventListSignature(state.actualWorkEvents),
    model: eventListSignature(state.modelUsageEvents),
    leases: eventListSignature(state.approvalLeases),
    guards: eventListSignature(state.guardEvents)
  });
}

function eventListSignature(events = []) {
  if (!Array.isArray(events) || events.length === 0) return "0";
  const latestTimestamp = events.reduce((latest, event) => {
    const timestamp = event?.timestamp || event?.createdAt || event?.expiresAt || "";
    return timestamp > latest ? timestamp : latest;
  }, "");
  const tokenTotal = events.reduce((sum, event) => sum + Number(event?.tokens || event?.totalTokens || 0), 0);
  return `${events.length}:${latestTimestamp}:${tokenTotal}`;
}

function compactCodexSessionContext(detection = {}) {
  const inventory = detection.codexSessionInventory || {};
  return {
    kind: "scopelease.codex_session_context",
    generatedAt: detection.generatedAt,
    measurementBoundary: detection.measurementBoundary,
    safeWithoutBilling: detection.safeWithoutBilling === true,
    providerUsageExcluded: detection.providerUsageExcluded !== false,
    agentVisibleUsage: summarizeAgentVisibleUsage(detection),
    codexLocalAggregate: detection.codexLocalAggregate || {},
    codexWorkspaceScope: detection.codexWorkspaceScope || inventory.scope || {},
    knowledgeGraph: detection.codexSessionKnowledgeGraph || { nodes: [], edges: [], schema: { model: "scopelease_codex_session_kg" } },
    codexSessionInventory: {
      kind: inventory.kind || "codex_session_inventory",
      status: inventory.status || "unavailable",
      source: inventory.source || "",
      basis: inventory.basis || "",
      query: inventory.query || {},
      totalWorkspaces: inventory.totalWorkspaces || 0,
      totalThreads: inventory.totalThreads || 0,
      totalThreadRecords: inventory.totalThreads || 0,
      totalTokens: inventory.totalTokens || 0
    }
  };
}

function queueRequestAnalysis(root, userRequest, broadcast) {
  setImmediate(() => {
    try {
      analyzeRepository(root, { userRequest, autoMeasureWork: true });
      broadcast("request-update");
    } catch (error) {
      console.error(`[scopelease:request-update] ${error.message}`);
    }
  });
}

function handleRequest({ req, res, getRoot, switchRoot, publicDir, entry, eventClients, broadcast, getUserRequest, getRuntime, lockRoot = false, hubMode = false, enableModelProxy = false, setUserRequest }) {
  const url = new URL(req.url, "http://localhost");
  const root = getRoot();
  const runtime = getRuntime();

  if (url.pathname.startsWith("/proxy/v1/") || url.pathname === "/proxy/v1") {
    if (!enableModelProxy) {
      return sendJson(res, {
        ok: false,
        error: "ScopeLease model proxy is disabled. Restart ScopeLease with --enable-model-proxy to forward provider API calls.",
        modelProxyEnabled: false
      }, 403);
    }
    return proxyModelUsageRequest({
      req,
      res,
      root,
      requestText: getUserRequest(),
      onUsage() {
        broadcast("proxy-model-usage");
      }
    }).catch((error) => badRequest(res, error.message));
  }

  if (url.pathname === "/api/state") {
    return sendJson(res, stateWithRuntime(loadStateForResponse(root, getUserRequest()) || {}, runtime, root));
  }

  if (url.pathname === "/api/events") {
    return openEventStream({ req, res, getRoot, getRuntime, eventClients, getCurrentRequest: getUserRequest });
  }

  if (url.pathname === "/api/health") {
    const state = loadState(root);
    const agentVisibleDetection = detectAgentVisibleUsageCached({ repoPath: root, state });
    return sendJson(res, {
      ok: true,
      repo: root,
      runtime,
      generatedAt: state?.latestAnalysis?.generatedAt,
      risk: state?.latestAnalysis?.risk || "low",
      measurementMode: measurementModeForState(state || {}),
      actualWorkEvents: (state?.actualWorkEvents || []).length,
      mcpContextEvents: (state?.mcpContextEvents || []).length,
      providerUsageEventsExcluded: (state?.modelUsageEvents || []).length,
      agentVisibleUsage: summarizeAgentVisibleUsage(agentVisibleDetection)
    });
  }

  if (url.pathname === "/api/agent-visible-usage" || url.pathname === "/api/codex-usage-detection") {
    const state = loadState(root);
    const force = url.searchParams.get("fresh") === "true" || url.searchParams.get("cache") === "false";
    return sendJson(res, detectAgentVisibleUsageCached({ repoPath: root, state, force }));
  }

  if (url.pathname === "/api/measurement-mode" && req.method === "GET") {
    const state = loadState(root) || {};
    return sendJson(res, {
      ok: true,
      measurementMode: measurementModeForState(state),
      actualWorkEvents: (state.actualWorkEvents || []).length,
      mcpContextEvents: (state.mcpContextEvents || []).length
    });
  }

  if (url.pathname === "/api/measurement-mode" && req.method === "POST") {
    return readJsonBody(req)
      .then((body) => {
        const result = setMeasurementMode(root, {
          enabled: body.enabled ?? body.mode ?? body.value,
          source: body.source || "server:measurement-mode",
          note: body.note || ""
        });
        broadcast("measurement-mode");
        return sendJson(res, {
          ok: true,
          measurementMode: result.measurementMode,
          state: stateWithRuntime(result.state, getRuntime(), root)
        });
      })
      .catch((error) => badRequest(res, error.message));
  }

  if (url.pathname === "/api/runtime-health") {
    return sendJson(res, {
      ok: true,
      repo: root,
      runtime
    });
  }

  if (url.pathname === "/api/projects" && req.method === "GET") {
    if (!hubMode) return badRequest(res, "Project inventory is available only in ScopeLease hub mode.");
    const state = loadState(root) || {};
    const includeHealth = url.searchParams.get("health") === "true";
    return detectHubProjects({ repoPath: root, state, includeHealth })
      .then((projects) => sendJson(res, projects))
      .catch((error) => badRequest(res, error.message));
  }

  if ((url.pathname === "/api/projects/start" || url.pathname === "/api/projects/open") && req.method === "POST") {
    if (!hubMode) return badRequest(res, "Project runtime management is available only in ScopeLease hub mode.");
    return readJsonBody(req)
      .then(async (body) => {
        const targetRepo = resolveRepositoryPath(body.path || body.repo || "");
        const result = await ensureScopeLeaseApp({
          repoPath: targetRepo,
          scanInterval: Number(body.scanInterval || body["scan-interval"] || 30000),
          request: body.request || "",
          openBrowser: false,
          enableModelProxy: Boolean(body.enableModelProxy)
        });
        return sendJson(res, {
          ok: true,
          hubMode,
          action: url.pathname.endsWith("/open") ? "open" : "start",
          project: targetRepo,
          ...result
        });
      })
      .catch((error) => badRequest(res, error.message));
  }

  if (url.pathname === "/api/request" && req.method === "POST") {
    return readJsonBody(req)
      .then((body) => {
        setUserRequest(body.userRequest || body.request || "");
        queueRequestAnalysis(root, getUserRequest(), broadcast);
        return sendJson(res, {
          ok: true,
          repo: root,
          userRequest: getUserRequest(),
          workIntent: deriveWorkIntent({ request: getUserRequest(), workIntent: body.workIntent || body["work-intent"] || "" }),
          requestHash: requestHash(getUserRequest()),
          runtime
        });
      })
      .catch((error) => badRequest(res, error.message));
  }

  if (url.pathname === "/api/repo") {
    if (req.method === "GET") {
      const state = loadState(root);
      return sendJson(res, {
        repo: root,
        runtime,
        generatedAt: state?.latestAnalysis?.generatedAt,
        risk: state?.latestAnalysis?.risk || "low"
      });
    }

    if (req.method === "POST") {
      if (lockRoot) return badRequest(res, "Repo switching is disabled for this repo-local ScopeLease runtime.");
      return readJsonBody(req)
        .then((body) => {
          const next = switchRoot(body.path || body.repo || "");
          return sendJson(res, {
            ok: true,
            repo: next.root,
            state: stateWithRuntime(next.state || loadState(next.root) || {}, getRuntime(), next.root),
            analysis: next.analysis || next.state?.latestAnalysis || loadState(next.root)?.latestAnalysis || null
          });
        })
        .catch((error) => badRequest(res, error.message));
    }
  }

  if (url.pathname === "/api/fs" && req.method === "GET") {
    try {
      const target = url.searchParams.get("path") || root;
      return sendJson(res, listDirectory(target, { root, lockRoot }));
    } catch (error) {
      return badRequest(res, error.message);
    }
  }

  if (url.pathname === "/api/analyze" && req.method === "POST") {
    return readJsonBody(req)
      .then((body) => {
        setUserRequest(body.userRequest || body.request || "");
        const analysis = analyzeRepository(root, { userRequest: getUserRequest(), autoMeasureWork: true });
        broadcast();
        return sendJson(res, analysis);
      })
      .catch((error) => badRequest(res, error.message));
  }

  if (url.pathname === "/api/checkpoint" && req.method === "POST") {
    const request = getUserRequest() || "Checkpoint current repository baseline.";
    const action = { kind: "checkpoint" };
    const analysis = analyzeRepository(root, { userRequest: request, autoMeasureWork: true });
    const currentState = loadState(root) || {};
    const verdict = evaluateAgentAction({ action, analysis, state: currentState });
    recordGuardDecision(root, {
      verdict,
      action,
      request,
      source: "server:checkpoint"
    });
    if (verdict.verdict !== "allow_with_log" || !verdict.leaseId) {
      broadcast();
      return sendJson(res, {
        ok: false,
        error: "Checkpoint requires an explicit approval lease.",
        guard: verdict
      }, 403);
    }
    const state = checkpointRepository(root);
    broadcast();
    return sendJson(res, stateWithRuntime(state, runtime, root));
  }

  if (url.pathname === "/api/context") {
    const state = loadStateForResponse(root, getUserRequest());
    return sendJson(res, state?.latestAnalysis?.contextPack || {});
  }

  if (url.pathname === "/api/codex-input") {
    const state = loadStateForResponse(root, getUserRequest());
    return sendText(res, state?.latestAnalysis?.contextPack?.codexInput?.text || "");
  }

  if (url.pathname === "/api/context-ledger") {
    const state = loadStateForResponse(root, getUserRequest());
    return sendJson(res, state?.latestAnalysis?.contextPack?.contextLedger || {});
  }

  if (url.pathname === "/api/measure" && req.method === "POST") {
    return readJsonBody(req, { maxChars: MEASURE_JSON_BODY_LIMIT })
      .then((body) => {
        const source = body.source || "api";
        const currentState = loadState(root) || {};
        if (!shouldRecordAutomaticMeasurement(currentState, source)) {
          return sendJson(res, {
            ok: true,
            skipped: true,
            reason: "measurement mode is off",
            measurementMode: measurementModeForState(currentState)
          });
        }
        const result = recordActualWork(root, {
          phase: body.phase,
          text: body.text || "",
          source,
          label: body.label || body.phase || "api measurement",
          path: body.path || "",
          request: body.userRequest || body.request || getUserRequest(),
          workIntent: body.workIntent || body["work-intent"] || body.intent || "",
          lane: body.lane || body.runLane || body.mode || body.source || "",
          pairId: body.pairId || body["pair-id"] || body.pair_id || "",
          runId: body.runId || body["run-id"] || "",
          callType: body.callType || body["call-type"] || body.call_type || "",
          toolName: body.toolName || body["tool-name"] || body.tool_name || body.tool || "",
          hookEventName: body.hookEventName || body["hook-event-name"] || body.hook_event_name || "",
          baseline: body.baseline || "",
          baselineTokens: Number(body.baselineTokens || body["baseline-tokens"] || 0)
        });
        broadcast("actual-work");
        return sendJson(res, {
          ok: true,
          event: result.event,
          state: stateWithRuntime(result.state, getRuntime(), root)
        });
      })
      .catch((error) => badRequest(res, error.message));
  }

  if (url.pathname === "/api/graph-layout-metrics" && req.method === "POST") {
    return readJsonBody(req)
      .then((body) => {
        const result = recordGraphLayoutMetrics(root, {
          source: body.source || "graph-view",
          layout: body.layout || "lanes",
          scope: body.scope || "",
          eventReason: body.eventReason || "",
          userRequest: body.userRequest || body.request || getUserRequest(),
          nodeCount: body.nodeCount,
          edgeCount: body.edgeCount,
          summary: body.summary || {},
          lanes: body.lanes || body.metrics || []
        });
        return sendJson(res, {
          ok: true,
          event: result.event,
          state: stateWithRuntime(result.state, getRuntime(), root)
        });
      })
      .catch((error) => badRequest(res, error.message));
  }

  if (url.pathname === "/api/usage" && req.method === "POST") {
    return readJsonBody(req)
      .then((body) => {
        const result = recordModelUsage(root, {
          ...body,
          source: body.source || "api",
          request: body.userRequest || body.request || getUserRequest()
        });
        broadcast("model-usage");
        return sendJson(res, {
          ok: true,
          event: result.event,
          state: stateWithRuntime(result.state, getRuntime(), root)
        });
      })
      .catch((error) => badRequest(res, error.message));
  }

  if (url.pathname === "/api/agent-input") {
    const state = loadStateForResponse(root, getUserRequest());
    if (req.method === "POST") {
      return readJsonBody(req)
        .then((body) => {
          setUserRequest(body.userRequest || body.request || "");
          const analysis = analyzeRepository(root, { userRequest: getUserRequest(), autoMeasureWork: true });
          broadcast();
          return sendJson(res, buildAgentInputPayload(analysis.contextPack || {}, { userRequest: getUserRequest() }));
        })
        .catch((error) => badRequest(res, error.message));
    }
    return sendJson(res, buildAgentInputPayload(state?.latestAnalysis?.contextPack || {}));
  }

  if (url.pathname === "/api/card") {
    const state = loadStateForResponse(root, getUserRequest());
    return sendText(res, state?.latestAnalysis?.decisionCard || "# ScopeLease 결정 카드\n");
  }

  const requested = url.pathname === "/" ? `/${entry}` : url.pathname;
  const filePath = path.resolve(publicDir, requested.replace(/^\/+/, ""));
  if (!isSameOrInside(filePath, publicDir)) return notFound(res);
  if (!fs.existsSync(filePath)) return notFound(res);

  const ext = path.extname(filePath);
  res.writeHead(200, {
    "content-type": MIME_TYPES[ext] || "application/octet-stream",
    "cache-control": "no-store"
  });
  fs.createReadStream(filePath).pipe(res);
}

function openEventStream({ req, res, getRoot, getRuntime, eventClients, getCurrentRequest = () => "" }) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive"
  });
  res.write("retry: 1000\n\n");
  eventClients.add(res);
  const root = getRoot();
  sendEvent(res, "state", stateWithRuntime(loadStateForResponse(root, getCurrentRequest()) || {}, getRuntime(), root));
  const heartbeat = setInterval(() => {
    const heartbeatRoot = getRoot();
    const runtime = getRuntime();
    const state = loadStateForResponse(heartbeatRoot, getCurrentRequest()) || {};
    sendEvent(res, "heartbeat", {
      now: new Date().toISOString(),
      runtime: stateWithRuntime({}, runtime, heartbeatRoot, { includeAgentUsage: false }).runtime,
      clients: eventClients.size,
      statePulse: statePulse(state)
    });
  }, 1000);
  req.on("close", () => {
    clearInterval(heartbeat);
    eventClients.delete(res);
  });
}

function broadcastState(root, eventClients, reason = "update", runtime = null, currentRequest = "") {
  const state = loadStateForResponse(root, currentRequest) || {};
  for (const client of eventClients) {
    sendEvent(client, "state", { ...stateWithRuntime(state, runtime, root), eventReason: reason });
  }
}

function statePulse(state = {}) {
  const analysis = state.latestAnalysis || {};
  return {
    generatedAt: analysis.generatedAt || "",
    request: analysis.contextPack?.userRequest?.text || analysis.userRequest || "",
    codexInputTokens: analysis.contextPack?.codexInput?.tokens || analysis.contextPack?.tokenEconomy?.actualInputTokens || 0,
    mcpContextEvents: (state.mcpContextEvents || []).length,
    actualWorkEvents: (state.actualWorkEvents || []).length
  };
}

function loadStateForResponse(root, currentRequest = "") {
  const state = loadState(root) || {};
  return state;
}

function sendEvent(res, event, value) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(value)}\n\n`);
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(`${JSON.stringify(value, null, 2)}\n`);
}

function sendText(res, value) {
  res.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(value);
}

function readJsonBody(req, { maxChars = DEFAULT_JSON_BODY_LIMIT } = {}) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxChars) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function resolveRepositoryPath(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Repo path is required.");
  const expanded = raw === "~" ? os.homedir() : raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
  const resolved = path.resolve(expanded);
  if (!fs.existsSync(resolved)) throw new Error(`Path does not exist: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error(`Path is not a directory: ${resolved}`);
  return resolved;
}

function listDirectory(value, { root = "", lockRoot = false } = {}) {
  const current = realDirectoryPath(value);
  const scopeRoot = root ? realDirectoryPath(root) : "";
  if (lockRoot && !isSameOrInside(current, scopeRoot)) {
    throw new Error("File browsing is limited to this repo-local ScopeLease runtime.");
  }
  const entries = fs.readdirSync(current, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith(".") || entry.name === ".decision")
    .map((entry) => {
      const entryPath = path.join(current, entry.name);
      return {
        name: entry.name,
        path: entryPath,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
        selectable: entry.isDirectory()
      };
    })
    .sort((a, b) => {
      if (a.type === "directory" && b.type !== "directory") return -1;
      if (a.type !== "directory" && b.type === "directory") return 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 400);

  const parent = path.dirname(current);
  const canBrowseParent = parent !== current && (!lockRoot || isSameOrInside(parent, scopeRoot));
  return {
    path: current,
    parent: canBrowseParent ? parent : null,
    entries,
    shortcuts: lockRoot ? [
      { label: "현재 repo", path: scopeRoot || current }
    ] : [
      { label: "홈", path: os.homedir() },
      { label: "현재 Codex", path: process.cwd() }
    ]
  };
}

function realDirectoryPath(value) {
  const resolved = resolveRepositoryPath(value);
  return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
}

function isSameOrInside(candidate, parent) {
  if (!parent) return false;
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function badRequest(res, message) {
  res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
}

function notFound(res) {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

function normalizeRequestText(value) {
  if (value === true || value === false || value == null) return "";
  const text = String(value).trim();
  return text === "true" || text === "false" ? "" : text;
}
