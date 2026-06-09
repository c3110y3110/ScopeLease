import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveWorkIntent } from "../core/work-intent.js";

const PAIR_RECENCY_WINDOW_MS = 60 * 60 * 1000;

export function detectAgentVisibleUsage(options = {}) {
  const repo = path.resolve(options.repoPath || options.repo || ".");
  const env = options.env || process.env;
  const codexHome = resolveCodexHome(options.codexHome || env.SCOPELEASE_CODEX_HOME || env.CODEX_HOME);
  const state = options.state || readScopeLeaseState(repo);
  const config = detectAgentConfig({ repo, codexHome });
  const scopeleaseMcpInput = summarizeScopeLeaseMcpInput(state);
  const observedToolPayload = summarizeObservedToolPayload(state);
  const codexSessionInventory = detectCodexSessionInventory({ repo, codexHome, workspaceLimit: options.workspaceLimit });
  const codexLocalAggregate = codexSessionInventory.currentRepoAggregate;
  const codexSessionKnowledgeGraph = buildCodexSessionKnowledgeGraph({
    repo,
    aggregate: codexLocalAggregate,
    scope: codexSessionInventory.scope
  });
  const tokenizerEstimate = summarizeTokenizerEstimate(state);
  const pairedLaneEvidence = summarizePairedLaneEvidence(state);
  const researchCalibration = buildResearchCalibrationSummary({ repoPath: repo, pairedLaneEvidence });
  const agentVisibleUsage = summarizeAgentVisibleBoundary({
    scopeleaseMcpInput,
    observedToolPayload,
    codexLocalAggregate,
    codexSessionKnowledgeGraph,
    codexSessionInventory,
    codexWorkspaceScope: codexSessionInventory.scope,
    tokenizerEstimate,
    pairedLaneEvidence,
    researchCalibration
  });

  return {
    kind: "scopelease.agent_visible_usage_detection",
    repo,
    generatedAt: new Date().toISOString(),
    measurementBoundary: "agent_visible_context_not_provider_billing",
    safeWithoutBilling: true,
    networkUsed: false,
    providerUsageExcluded: true,
    note: "This detector reads local Codex/ScopeLease files only and measures agent-visible context signals. It does not call provider APIs or use provider billing usage.",
    agentConfig: config,
    config,
    agentVisibleUsage,
    scopeleaseMcpInput,
    observedToolPayload,
    codexLocalAggregate,
    codexSessionKnowledgeGraph,
    codexSessionInventory,
    codexWorkspaceScope: codexSessionInventory.scope,
    tokenizerEstimate,
    pairedLaneEvidence,
    researchCalibration,
    excludedProviderUsage: {
      kind: "excluded_provider_usage",
      status: "excluded",
      reason: "Provider/API billing usage is outside the default ScopeLease metering boundary for Codex/Claude Code-style agent systems.",
      modelUsageEventsIgnored: Array.isArray(state.modelUsageEvents) ? state.modelUsageEvents.length : 0,
      note: "If provider usage is explicitly supplied elsewhere, keep it separate from agent-visible context savings claims."
    },
    classifications: [
      scopeleaseMcpInput,
      observedToolPayload,
      codexLocalAggregate,
      tokenizerEstimate
    ],
    capability: {
      canMeasureAgentVisiblePairDelta: pairedLaneEvidence.status === "available",
      canClaimAgentVisiblePairSavings: pairedLaneEvidence.canClaimPositiveSavings === true,
      canMeasureAgentVisiblePairSavings: pairedLaneEvidence.canClaimPositiveSavings === true,
      canMeasureSessionTrend: codexLocalAggregate.status === "available",
      canMeasureProviderBillingSavings: false,
      allowedClaim: pairedLaneEvidence.canClaimPositiveSavings === true
        ? "Codex/Claude Code agent-visible context savings for paired default-codex versus scopelease-codex runs where scopelease-codex input is lower."
        : "Codex/Claude Code agent-visible context delta for paired default-codex versus scopelease-codex runs; positive savings require scopelease-codex input to be lower.",
      rejectedClaim: "OpenAI/provider billing token savings or reconstructed historical provider usage."
    },
    recommendations: buildRecommendations({ scopeleaseMcpInput, observedToolPayload, codexLocalAggregate, codexSessionInventory, pairedLaneEvidence })
  };
}

export function detectCodexUsage(options = {}) {
  return detectAgentVisibleUsage(options);
}

export function summarizeAgentVisibleUsage(detection = {}) {
  const usage = detection.agentVisibleUsage || {};
  return {
    safeWithoutBilling: detection.safeWithoutBilling === true,
    networkUsed: detection.networkUsed === true,
    measurementBoundary: detection.measurementBoundary || "agent_visible_context_not_provider_billing",
    providerUsageExcluded: detection.providerUsageExcluded !== false,
    status: usage.status || "unavailable",
    observedPayloadTokens: usage.observedPayloadTokens || 0,
    scopeleaseMcpInputTokens: detection.scopeleaseMcpInput?.tokens || 0,
    observedToolPayloadTokens: detection.observedToolPayload?.tokens || 0,
    codexLocalAggregateAvailable: detection.codexLocalAggregate?.status === "available",
    codexLocalAggregateTokens: detection.codexLocalAggregate?.totalTokens || 0,
    codexLocalThreadRecords: detection.codexLocalAggregate?.currentRepoThreadRecords || detection.codexLocalAggregate?.currentRepoThreads || 0,
    codexWorkspaceCount: detection.codexSessionInventory?.totalWorkspaces || 0,
    codexScopedWorkspaceCount: detection.codexSessionInventory?.scope?.includedWorkspaceCount || 0,
    codexScopedThreadRecords: detection.codexSessionInventory?.scope?.includedThreadRecords || detection.codexSessionInventory?.scope?.includedThreads || 0,
    codexExcludedWorkspaceCount: detection.codexSessionInventory?.scope?.excludedWorkspaceCount || 0,
    codexExcludedThreadRecords: detection.codexSessionInventory?.scope?.excludedThreadRecords || detection.codexSessionInventory?.scope?.excludedThreads || 0,
    pairedLaneStatus: detection.pairedLaneEvidence?.status || "needs_pair",
    canMeasureAgentVisiblePairDelta: detection.capability?.canMeasureAgentVisiblePairDelta === true,
    canClaimAgentVisiblePairSavings: detection.capability?.canClaimAgentVisiblePairSavings === true,
    canMeasureAgentVisiblePairSavings: detection.capability?.canMeasureAgentVisiblePairSavings === true,
    canMeasureProviderBillingSavings: false
  };
}

export function summarizeCodexUsageDetection(detection = {}) {
  return summarizeAgentVisibleUsage(detection);
}

function detectAgentConfig({ repo, codexHome }) {
  const projectConfigPath = path.join(repo, ".codex", "config.toml");
  const globalConfigPath = path.join(codexHome, "config.toml");
  const projectConfig = readTextFile(projectConfigPath);
  const globalConfig = readTextFile(globalConfigPath);
  const hooksPath = path.join(repo, ".codex", "hooks.json");
  const hooksText = readTextFile(hooksPath);

  return {
    kind: "agent_config",
    codexHome: compactHomePath(codexHome),
    projectConfigPath: compactHomePath(projectConfigPath),
    globalConfigPath: compactHomePath(globalConfigPath),
    projectConfigExists: projectConfig !== null,
    globalConfigExists: globalConfig !== null,
    hooksConfigExists: hooksText !== null,
    scopeleaseMcpConfigured: /\[mcp_servers\.scopelease\]/.test(projectConfig || "") || /\[mcp_servers\.scopelease\]/.test(globalConfig || ""),
    codexHooksEnabled: /\bhooks\s*=\s*true/.test(projectConfig || "") ||
      /codex_hooks\s*=\s*true/.test(projectConfig || "") ||
      /"hooks"\s*:/.test(hooksText || ""),
    basis: "Project-local MCP and hooks determine whether Codex can receive ScopeLease context and emit observed agent payload events."
  };
}

function summarizeScopeLeaseMcpInput(state = {}) {
  const events = Array.isArray(state.mcpContextEvents) ? state.mcpContextEvents : [];
  const tokens = sumNumbers(events, "tokens");
  return {
    kind: "scopelease_mcp_input",
    status: events.length ? "available" : "unavailable",
    events: events.length,
    tokens,
    confidenceBand: "90-98%",
    exactForProvidedPayload: true,
    basis: "Exact token count of context payloads ScopeLease returned through MCP.",
    note: "This is the strongest agent-visible input signal because ScopeLease controls the returned payload."
  };
}

function summarizeObservedToolPayload(state = {}) {
  const events = Array.isArray(state.actualWorkEvents) ? state.actualWorkEvents : [];
  const agentVisibleEvents = events.filter((event) => eventLane(event) !== "scopelease-internal");
  const internalEvents = events.filter((event) => eventLane(event) === "scopelease-internal");
  const tokens = sumNumbers(agentVisibleEvents, "tokens");
  const byLane = aggregateByLane(agentVisibleEvents);
  return {
    kind: "observed_tool_payload",
    status: agentVisibleEvents.length ? "available" : "unavailable",
    events: agentVisibleEvents.length,
    tokens,
    byLane,
    internalEvidence: {
      events: internalEvents.length,
      tokens: sumNumbers(internalEvents, "tokens"),
      excludedFromAgentVisibleTotal: true
    },
    confidenceBand: "65-85%",
    exactForProvidedPayload: false,
    basis: "Hook/watcher-observed Bash/Edit/Write/output payloads that may enter or influence the agent context.",
    note: "Codex may summarize, trim, or hide some internals, so this is an agent-visible payload estimate rather than provider usage. ScopeLease-internal watcher evidence is reported separately."
  };
}

function detectCodexSessionInventory({ repo, codexHome, workspaceLimit = 50 }) {
  const dbPath = path.join(codexHome, "state_5.sqlite");
  const currentRepoAggregate = emptyCodexLocalAggregate({ dbPath, repo });
  const result = {
    kind: "codex_session_inventory",
    status: "unavailable",
    source: compactHomePath(dbPath),
    basis: "Codex local sqlite threads are globally visible, but ScopeLease usage calculations include only threads whose cwd matches the current repo.",
    scope: buildEmptyWorkspaceScope(repo),
    totalWorkspaces: 0,
    totalThreads: 0,
    totalTokens: 0,
    workspaces: [],
    query: {
      scope: "all_threads",
      limit: null,
      truncated: false,
      rowsReturned: 0
    },
    currentRepoAggregate,
    errors: []
  };
  if (!fs.existsSync(dbPath)) {
    result.errors.push("Codex state_5.sqlite was not found.");
    result.currentRepoAggregate.errors.push("Codex state_5.sqlite was not found.");
    return result;
  }

  const tableRows = querySqliteJson(dbPath, "select name from sqlite_master where type='table' and name='threads'");
  if (!tableRows.ok) {
    result.errors.push(tableRows.error);
    result.currentRepoAggregate.errors.push(tableRows.error);
    return result;
  }
  if (!tableRows.rows.length) {
    result.errors.push("threads table was not found in Codex state db.");
    result.currentRepoAggregate.errors.push("threads table was not found in Codex state db.");
    return result;
  }

  const columnRows = querySqliteJson(dbPath, "pragma table_info(threads)");
  if (!columnRows.ok) {
    result.errors.push(columnRows.error);
    result.currentRepoAggregate.errors.push(columnRows.error);
    return result;
  }
  const columns = new Set(columnRows.rows.map((row) => String(row.name || "")));
  if (!columns.has("tokens_used")) {
    result.errors.push("threads.tokens_used column was not found.");
    result.currentRepoAggregate.errors.push("threads.tokens_used column was not found.");
    return result;
  }

  const archivedSelect = columns.has("archived") ? "archived" : "0 as archived";
  const rows = querySqliteJson(dbPath, [
    `select id, cwd, model_provider as modelProvider, model, tokens_used as tokensUsed, created_at as createdAt, updated_at as updatedAt, title, ${archivedSelect}`,
    "from threads",
    "order by updated_at desc"
  ].join(" "), { maxBuffer: 16 * 1024 * 1024 });
  if (!rows.ok) {
    result.errors.push(rows.error);
    result.currentRepoAggregate.errors.push(rows.error);
    return result;
  }

  const threads = rows.rows.map(normalizeCodexThreadRow);
  const workspaces = summarizeCodexWorkspaces(threads, repo);
  const scopedThreads = threads.filter((thread) => sameFsPath(thread.cwd, repo));
  result.status = threads.length ? "available" : "unavailable";
  result.totalWorkspaces = workspaces.length;
  result.totalThreads = threads.length;
  result.totalTokens = threads.reduce((sum, thread) => sum + Number(thread.tokensUsed || 0), 0);
  result.query.rowsReturned = threads.length;
  const normalizedWorkspaceLimit = normalizeWorkspaceLimit(workspaceLimit);
  result.workspaces = normalizedWorkspaceLimit === null ? workspaces : workspaces.slice(0, normalizedWorkspaceLimit);
  result.workspaceRowsReturned = result.workspaces.length;
  result.workspaceRowsTruncated = normalizedWorkspaceLimit !== null && workspaces.length > normalizedWorkspaceLimit;
  result.scope = buildWorkspaceScope({ repo, workspaces });
  result.currentRepoAggregate = buildCodexLocalAggregate({ dbPath, repo, threads: scopedThreads, scope: result.scope });
  return result;
}

function normalizeWorkspaceLimit(value) {
  if (value === null) return null;
  const limit = Number(value || 50);
  if (!Number.isFinite(limit) || limit <= 0) return 50;
  return Math.floor(limit);
}

function emptyCodexLocalAggregate({ dbPath, repo }) {
  return {
    kind: "codex_local_aggregate",
    status: "unavailable",
    source: compactHomePath(dbPath),
    unit: "tokens_used",
    scope: "current_repo_cwd_only",
    currentRepo: repo,
    recordType: "historical_cwd_matched_codex_thread_records",
    activeSessionClaim: false,
    basis: "Codex local sqlite threads.tokens_used aggregate for historical thread records whose cwd matches current repo. Other Codex workspaces are inventory-only.",
    confidenceBand: "70-90% for session trend, 40-70% for request-level pairing",
    currentRepoThreads: 0,
    currentRepoThreadRecords: 0,
    totalTokens: 0,
    latestThread: null,
    sampleThreads: [],
    note: "Codex thread rows are persisted local records. archived=false does not prove the Codex UI session is currently open.",
    errors: []
  };
}

function buildCodexLocalAggregate({ dbPath, repo, threads = [], scope = null }) {
  const aggregate = emptyCodexLocalAggregate({ dbPath, repo });
  aggregate.scopeRule = scope?.rule || "Only Codex threads whose cwd matches currentRepo are included.";
  aggregate.excludedWorkspaceCount = scope?.excludedWorkspaceCount || 0;
  aggregate.currentRepoThreads = threads.length;
  aggregate.currentRepoThreadRecords = threads.length;
  aggregate.totalTokens = threads.reduce((sum, thread) => sum + Number(thread.tokensUsed || 0), 0);
  aggregate.latestUpdatedAt = normalizeCodexTimestamp(threads[0]?.updatedAt);
  aggregate.sampleThreads = threads.slice(0, 10);
  aggregate.latestThread = aggregate.sampleThreads[0] || null;
  aggregate.status = threads.length ? "available" : "unavailable";
  if (!threads.length) aggregate.errors.push("No Codex local thread rows matched this repo cwd.");
  return aggregate;
}

function summarizeCodexWorkspaces(threads = [], repo = "") {
  const currentRepoKey = canonicalFsPath(repo);
  const groups = new Map();
  for (const thread of threads) {
    const key = canonicalFsPath(thread.cwd);
    const group = groups.get(key) || {
      cwd: thread.cwd,
      canonicalCwd: key,
      matchesCurrentRepo: key === currentRepoKey,
      threads: 0,
      archivedThreads: 0,
      tokens: 0,
      latestUpdatedAt: null,
      latestThreadId: "",
      latestTitle: "",
      models: new Set(),
      providers: new Set()
    };
    group.threads += 1;
    if (thread.archived) group.archivedThreads += 1;
    group.tokens += Number(thread.tokensUsed || 0);
    group.models.add(thread.model);
    group.providers.add(thread.modelProvider);
    if (compareIso(thread.updatedAt, group.latestUpdatedAt) > 0) {
      group.latestUpdatedAt = thread.updatedAt;
      group.latestThreadId = thread.id;
      group.latestTitle = thread.title;
      group.cwd = thread.cwd;
    }
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      cwd: group.cwd,
      canonicalCwd: group.canonicalCwd,
      matchesCurrentRepo: group.matchesCurrentRepo,
      threads: group.threads,
      archivedThreads: group.archivedThreads,
      tokens: group.tokens,
      latestUpdatedAt: group.latestUpdatedAt,
      latestThreadId: group.latestThreadId,
      latestTitle: group.latestTitle,
      providers: sortedStrings(group.providers),
      models: sortedStrings(group.models)
    }))
    .sort((left, right) => compareIso(right.latestUpdatedAt, left.latestUpdatedAt));
}

function buildWorkspaceScope({ repo, workspaces = [] }) {
  const included = workspaces.filter((workspace) => workspace.matchesCurrentRepo);
  const excluded = workspaces.filter((workspace) => !workspace.matchesCurrentRepo);
  return {
    kind: "codex_workspace_scope",
    mode: "current_repo_cwd_only",
    currentRepo: repo,
    currentRepoCanonical: canonicalFsPath(repo),
    rule: "List every Codex workspace from the local sqlite inventory, but include only cwd-matching currentRepo threads in agent-visible usage calculations.",
    includedWorkspaceCount: included.length,
    includedThreads: included.reduce((sum, workspace) => sum + Number(workspace.threads || 0), 0),
    includedThreadRecords: included.reduce((sum, workspace) => sum + Number(workspace.threads || 0), 0),
    includedTokens: included.reduce((sum, workspace) => sum + Number(workspace.tokens || 0), 0),
    includedWorkspaces: included,
    excludedWorkspaceCount: excluded.length,
    excludedThreads: excluded.reduce((sum, workspace) => sum + Number(workspace.threads || 0), 0),
    excludedThreadRecords: excluded.reduce((sum, workspace) => sum + Number(workspace.threads || 0), 0),
    excludedTokens: excluded.reduce((sum, workspace) => sum + Number(workspace.tokens || 0), 0),
    excludedWorkspaceSamples: excluded.slice(0, 10),
    threadRecordSemantics: "Codex sqlite thread rows are historical records, not proof of currently open Codex UI sessions.",
    activeSessionClaim: false
  };
}

function buildEmptyWorkspaceScope(repo = "") {
  return {
    kind: "codex_workspace_scope",
    mode: "current_repo_cwd_only",
    currentRepo: repo,
    currentRepoCanonical: canonicalFsPath(repo),
    rule: "List every Codex workspace from the local sqlite inventory, but include only cwd-matching currentRepo threads in agent-visible usage calculations.",
    includedWorkspaceCount: 0,
    includedThreads: 0,
    includedThreadRecords: 0,
    includedTokens: 0,
    includedWorkspaces: [],
    excludedWorkspaceCount: 0,
    excludedThreads: 0,
    excludedThreadRecords: 0,
    excludedTokens: 0,
    excludedWorkspaceSamples: [],
    threadRecordSemantics: "Codex sqlite thread rows are historical records, not proof of currently open Codex UI sessions.",
    activeSessionClaim: false
  };
}

function buildCodexSessionKnowledgeGraph({ repo = "", aggregate = {}, scope = {} } = {}) {
  const nodes = [];
  const edges = [];
  const nodeIds = new Set();
  const edgeIds = new Set();
  const threads = Array.isArray(aggregate.sampleThreads) ? aggregate.sampleThreads : [];
  const workspaces = Array.isArray(scope.includedWorkspaces) ? scope.includedWorkspaces : [];
  const repoNodeId = "codex-repo:current";
  addGraphNode(nodes, nodeIds, {
    id: repoNodeId,
    label: path.basename(repo || aggregate.currentRepo || scope.currentRepo || "current repo"),
    type: "codex_repo_usage",
    labels: ["ScopeLeaseNode", "CodexRepo", "CodexUsage", "Evidence"],
    path: repo || aggregate.currentRepo || scope.currentRepo || "",
    properties: {
      recordType: aggregate.recordType || "historical_cwd_matched_codex_thread_records",
      activeSessionClaim: false,
      currentRepoThreadRecords: aggregate.currentRepoThreadRecords || aggregate.currentRepoThreads || 0,
      tokensUsed: aggregate.totalTokens || 0,
      latestUpdatedAt: aggregate.latestUpdatedAt || "",
      semantics: aggregate.note || scope.threadRecordSemantics || "Codex sqlite thread rows are historical records."
    }
  });

  const workspaceRows = workspaces.length ? workspaces : [{
    cwd: repo || aggregate.currentRepo || scope.currentRepo || "",
    canonicalCwd: scope.currentRepoCanonical || repo || aggregate.currentRepo || "",
    threads: aggregate.currentRepoThreadRecords || aggregate.currentRepoThreads || threads.length,
    tokens: aggregate.totalTokens || 0,
    latestUpdatedAt: aggregate.latestUpdatedAt || ""
  }];

  for (const workspace of workspaceRows) {
    const workspaceId = `codex-workspace:${stableGraphId(workspace.canonicalCwd || workspace.cwd || repo || "current")}`;
    addGraphNode(nodes, nodeIds, {
      id: workspaceId,
      label: workspace.cwd || repo || "workspace",
      type: "codex_workspace",
      labels: ["ScopeLeaseNode", "CodexWorkspace", "CodexUsage", "Evidence"],
      path: workspace.cwd || repo || "",
      properties: {
        cwd: workspace.cwd || "",
        canonicalCwd: workspace.canonicalCwd || "",
        matchesCurrentRepo: workspace.matchesCurrentRepo !== false,
        threadRecords: workspace.threads || 0,
        archivedThreadRecords: workspace.archivedThreads || 0,
        tokensUsed: workspace.tokens || 0,
        latestUpdatedAt: workspace.latestUpdatedAt || "",
        activeSessionClaim: false
      }
    });
    addGraphEdge(edges, edgeIds, {
      source: repoNodeId,
      target: workspaceId,
      type: "codex_scope",
      relationshipType: "HAS_CODEX_WORKSPACE",
      properties: { basis: "cwd matches current repository scope" }
    });

    for (const thread of threads.filter((item) => sameFsPath(item.cwd, workspace.cwd || repo))) {
      const threadId = `codex-thread:${stableGraphId(thread.id || `${thread.cwd}:${thread.updatedAt}`)}`;
      addGraphNode(nodes, nodeIds, {
        id: threadId,
        label: thread.title || thread.id || "Codex thread",
        type: "codex_thread_record",
        labels: ["ScopeLeaseNode", "CodexThreadRecord", "CodexUsage", "Evidence"],
        path: thread.cwd || repo || "",
        properties: {
          threadId: thread.id || "",
          title: thread.title || "",
          model: thread.model || "",
          provider: thread.modelProvider || "",
          tokensUsed: thread.tokensUsed || 0,
          updatedAt: thread.updatedAt || "",
          createdAt: thread.createdAt || "",
          archived: thread.archived === true,
          recordType: thread.recordType || "codex_sqlite_thread_record",
          activeSessionStatus: thread.activeSessionStatus || "not_measured"
        }
      });
      addGraphEdge(edges, edgeIds, {
        source: workspaceId,
        target: threadId,
        type: "codex_thread_record",
        relationshipType: "HAS_CODEX_THREAD_RECORD",
        properties: { basis: "Codex local sqlite threads row with cwd scoped to this repo" }
      });
      if (thread.model) {
        const modelId = `codex-model:${stableGraphId(`${thread.modelProvider || "provider"}:${thread.model}`)}`;
        addGraphNode(nodes, nodeIds, {
          id: modelId,
          label: thread.model,
          type: "codex_model",
          labels: ["ScopeLeaseNode", "CodexModel", "CodexUsage"],
          properties: {
            provider: thread.modelProvider || "",
            model: thread.model
          }
        });
        addGraphEdge(edges, edgeIds, {
          source: threadId,
          target: modelId,
          type: "uses_model",
          relationshipType: "USES_MODEL",
          properties: { basis: "Codex sqlite thread model fields" }
        });
      }
    }
  }

  return {
    kind: "codex_session_knowledge_graph",
    schema: {
      model: "scopelease_codex_session_kg",
      nodeCount: nodes.length,
      relationshipCount: edges.length,
      nodeLabels: sortedStrings(new Set(nodes.flatMap((node) => node.labels || []))),
      relationshipTypes: sortedStrings(new Set(edges.map((edge) => edge.relationshipType || String(edge.type || "").toUpperCase())))
    },
    nodes,
    edges,
    note: "This KG represents persisted Codex thread records scoped by cwd. It does not claim those threads are currently open UI sessions."
  };
}

function addGraphNode(nodes, nodeIds, node) {
  if (!node?.id || nodeIds.has(node.id)) return;
  nodeIds.add(node.id);
  nodes.push(node);
}

function addGraphEdge(edges, edgeIds, edge) {
  const key = [edge.source || "", edge.target || "", edge.relationshipType || edge.type || ""].join("::");
  if (!edge?.source || !edge?.target || edgeIds.has(key)) return;
  edgeIds.add(key);
  edges.push(edge);
}

function stableGraphId(value = "") {
  const text = String(value || "").normalize("NFC");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return `${text.slice(0, 42).replace(/[^a-z0-9_.:-]+/gi, "_")}:${Math.abs(hash).toString(36)}`;
}

function summarizeTokenizerEstimate(state = {}) {
  const tokenizer = state.latestAnalysis?.contextPack?.tokenEconomy?.tokenizer || state.latestAnalysis?.repoStats?.tokenizer || {};
  return {
    kind: "tokenizer_estimate",
    status: tokenizer.method ? "available" : "unavailable",
    basis: "ScopeLease local tokenizer is used for MCP and observed payload counts.",
    confidenceBand: tokenizer.exact === true ? "high for visible text payloads" : "rough estimate",
    tokenizer: {
      method: tokenizer.method || "unknown",
      encoding: tokenizer.encoding || "",
      exact: tokenizer.exact === true
    }
  };
}

function summarizePairedLaneEvidence(state = {}) {
  const mcpEvents = Array.isArray(state.mcpContextEvents) ? state.mcpContextEvents : [];
  const workEvents = Array.isArray(state.actualWorkEvents) ? state.actualWorkEvents : [];
  const selected = selectPairedLaneEvidence({ actualEvents: workEvents, contextEvents: mcpEvents });
  const defaultTokens = selected.defaultTokens;
  const scopeleaseContextTokens = selected.scopeleaseContextTokens;
  const scopeleaseWorkTokens = selected.scopeleaseWorkTokens;
    const scopeleaseTokens = scopeleaseContextTokens + scopeleaseWorkTokens;
  const measured = selected.measured === true;
  const savedTokens = measured ? defaultTokens - scopeleaseTokens : null;
  const savedPercent = measured ? Math.round((savedTokens / defaultTokens) * 100) : null;
  const deltaDirection = measured ? observedDeltaDirection(savedTokens) : "unknown";
  return {
    kind: "paired_lane_evidence",
    status: measured ? "available" : "needs_pair",
    workIntent: selected.workIntent || null,
    pairId: selected.pairId || null,
    runId: selected.runId || null,
    pairSelection: selected.selection,
    formula: "(defaultCodexObservedInputTokens - scopeleaseCodexObservedInputTokens) / defaultCodexObservedInputTokens",
    defaultCodexObservedInputTokens: defaultTokens || null,
    scopeleaseCodexObservedInputTokens: scopeleaseTokens || null,
    savedTokens,
    savedPercent,
    deltaDirection,
    canClaimPositiveSavings: measured && savedTokens > 0,
      scopeleaseMcpContextTokens: scopeleaseContextTokens,
      scopeleaseObservedWorkTokens: scopeleaseWorkTokens,
      embeddedScopeLeaseContextObserved: Boolean(selected.embeddedScopeLeaseContextObserved),
      embeddedScopeLeaseContextTokens: selected.embeddedScopeLeaseContextTokens || 0,
      eventCounts: selected.eventCounts,
    missing: measured ? [] : [
      defaultTokens ? "" : "default-codex lane observed input",
      scopeleaseTokens ? "" : "scopelease-codex lane observed input"
    ].filter(Boolean),
    note: "This is scoped to one workIntent plus pairId/runId group. Full repo size and provider billing usage are excluded."
  };
}

function buildResearchCalibrationSummary({ repoPath = "", pairedLaneEvidence = {} } = {}) {
  const defaultReady = Number(pairedLaneEvidence.defaultCodexObservedInputTokens || 0) > 0;
  const scopeleaseReady = Number(pairedLaneEvidence.scopeleaseCodexObservedInputTokens || 0) > 0;
  const scopeleaseContextReady = Number(pairedLaneEvidence.eventCounts?.scopeleaseContext || 0) > 0;
  const exactDeltaReady = defaultReady && scopeleaseReady && scopeleaseContextReady;
  const positiveSavings = exactDeltaReady && Number(pairedLaneEvidence.savedTokens || 0) > 0;
  const missingEvidence = [
    defaultReady ? "" : "default-codex baseline run",
      scopeleaseReady ? "" : "scopelease-codex observed run",
      scopeleaseContextReady ? "" : "scopelease_get_context or embedded ScopeLease context prompt evidence"
  ].filter(Boolean);
  return {
    kind: "scopelease.research_calibration_summary",
    scope: "separate_from_product_runtime",
    status: exactDeltaReady ? (positiveSavings ? "claim_ready" : "delta_ready_no_savings") : "insufficient_pair",
    productRuntimeImpact: {
      extraAgentRuns: 0,
      note: "Normal ScopeLease product runtime only observes available evidence; it does not run a second agent conversation automatically."
    },
    pairedCalibrationCost: {
      requiresSecondObservedRunWhenMissing: missingEvidence.length > 0,
      missingEvidence,
      note: "Exact paper-style A/B evidence costs extra only when a missing lane is intentionally collected."
    },
    unit: {
      repo: repoPath,
      workIntent: pairedLaneEvidence.workIntent || null,
      pairId: pairedLaneEvidence.pairId || null,
      runId: pairedLaneEvidence.runId || null
    },
    claimPolicy: {
      canClaimExactDelta: exactDeltaReady,
      canClaimExactSavings: positiveSavings,
      canClaimPositiveSavings: positiveSavings,
      deltaDirection: pairedLaneEvidence.deltaDirection || "unknown",
      allowedClaim: positiveSavings
        ? "paired agent-visible context savings for the same repo path and work intent"
        : exactDeltaReady
          ? "paired agent-visible context delta for the same repo path and work intent; do not call it savings"
          : "positive paired agent-visible context savings only after both lanes, ScopeLease context evidence, and n > m exist",
      rejectedClaims: [
        "full repository size savings",
        "provider/API billing savings",
        "hidden prompt or reasoning token savings",
        "hook trend as exact savings"
      ]
    }
  };
}

function observedDeltaDirection(savedTokens) {
  const value = Number(savedTokens || 0);
  if (value > 0) return "savings";
  if (value < 0) return "increase";
  return "no_change";
}

function selectPairedLaneEvidence({ actualEvents = [], contextEvents = [] } = {}) {
  const groups = new Map();
  for (const event of [...(actualEvents || []), ...(contextEvents || [])]) {
    if (isControlledProtocolEvent(event)) continue;
    const lane = eventLane(event);
    const contextEvent = event.kind === "scopelease.mcp_context_event" || event.tool === "scopelease_get_context";
    if (contextEvent) {
      if (lane !== "scopelease-codex") continue;
      const contextRunId = normalizeRunId(event.runId || event.meta?.runId);
      if (contextRunId.endsWith(":default-baseline")) continue;
    } else {
      if (!["default-codex", "scopelease-codex"].includes(lane)) continue;
      if (!isObservedInputPayload(event)) continue;
    }
    const workIntent = eventWorkIntent(event);
    const pairId = normalizePairId(event.pairId || event.pair_id || event.meta?.pairId || event.meta?.pair_id);
    const runId = normalizeRunId(event.runId || event.meta?.runId) || "unscoped";
    const key = `${workIntent || "unscoped"}::${pairId || runId}`;
    const group = groups.get(key) || emptyPairEvidenceGroup({ workIntent, pairId, runId });
    group.latestTimestamp = maxIso(group.latestTimestamp, event.timestamp);
    if (pairId && !group.pairId) group.pairId = pairId;
    if (contextEvent) {
      if (!group.latestContextEvent || compareIso(event.timestamp, group.latestContextEvent.timestamp) >= 0) {
        group.latestContextEvent = event;
      }
      group.eventCounts.scopeleaseContext += 1;
    } else if (lane === "default-codex") group.defaultEvents.push(event);
    else if (lane === "scopelease-codex") {
      group.scopeleaseWorkEvents.push(event);
      if (eventHasEmbeddedScopeLeaseContext(event)) {
        group.embeddedContextEvents.push(event);
        group.eventCounts.scopeleaseContext += 1;
      }
    }
    groups.set(key, group);
  }

  const candidates = [...groups.values()].map((group) => {
    const scopeleaseContextTokens = Number(group.latestContextEvent?.tokens || 0);
    const embeddedScopeLeaseContextTokens = sumEmbeddedScopeLeaseContextTokens(group.embeddedContextEvents);
    const contextTimestamp = group.latestContextEvent?.timestamp || "";
    const contextRunId = normalizeRunId(group.latestContextEvent?.runId || group.latestContextEvent?.meta?.runId);
    const defaultBaselineRunId = contextRunId ? `${contextRunId}:default-baseline` : "";
    const defaultBucket = latestInputBucket(group.defaultEvents, {
      preferredRunId: defaultBaselineRunId,
      anchorTimestamp: contextTimestamp,
      maxDistanceMs: PAIR_RECENCY_WINDOW_MS
    });
    const scopeleaseWorkBucket = latestInputBucket(group.scopeleaseWorkEvents, {
      preferredRunId: contextRunId,
      anchorTimestamp: contextTimestamp,
      maxDistanceMs: PAIR_RECENCY_WINDOW_MS
    });
    const scopeleaseTokens = scopeleaseContextTokens + scopeleaseWorkBucket.tokens;
    const selectedRunId = contextRunId || scopeleaseWorkBucket.runId || defaultBucket.runId || group.runId;
    return {
      workIntent: group.workIntent,
      pairId: group.pairId || "",
      runId: selectedRunId === "unscoped" ? "" : selectedRunId,
      selection: group.pairId ? "latest_pair_id" : group.runId === "unscoped" ? "latest_unscoped" : "latest_run_id",
      latestTimestamp: group.latestTimestamp,
      defaultTokens: defaultBucket.tokens,
      scopeleaseContextTokens,
      scopeleaseWorkTokens: scopeleaseWorkBucket.tokens,
      defaultRunId: defaultBucket.runId || null,
      scopeleaseContextRunId: contextRunId || null,
      scopeleaseWorkRunId: scopeleaseWorkBucket.runId || null,
      measured: defaultBucket.tokens > 0 && scopeleaseWorkBucket.tokens > 0 && (scopeleaseContextTokens > 0 || group.embeddedContextEvents.length > 0),
      embeddedScopeLeaseContextObserved: group.embeddedContextEvents.length > 0,
      embeddedScopeLeaseContextTokens,
      eventCounts: {
        default: defaultBucket.count,
        scopeleaseContext: group.eventCounts.scopeleaseContext,
        scopeleaseWork: scopeleaseWorkBucket.count
      }
    };
  });
  candidates.sort((left, right) => {
    if (left.measured !== right.measured) return left.measured ? -1 : 1;
    return compareIso(right.latestTimestamp, left.latestTimestamp);
  });
  return candidates[0] || {
    workIntent: "",
    pairId: "",
    runId: "",
    selection: "none",
    defaultTokens: 0,
    scopeleaseContextTokens: 0,
    scopeleaseWorkTokens: 0,
    eventCounts: { default: 0, scopeleaseContext: 0, scopeleaseWork: 0 }
  };
}

function emptyPairEvidenceGroup({ workIntent = "", pairId = "", runId = "unscoped" } = {}) {
  return {
    workIntent,
    pairId,
    runId,
    latestTimestamp: "",
    defaultEvents: [],
    scopeleaseWorkEvents: [],
    embeddedContextEvents: [],
    latestContextEvent: null,
    eventCounts: { default: 0, scopeleaseContext: 0, scopeleaseWork: 0 }
  };
}

function latestInputBucket(events = [], { preferredRunId = "", anchorTimestamp = "", maxDistanceMs = 0 } = {}) {
  const wantedRunId = normalizeRunId(preferredRunId);
  const byRun = new Map();
  for (const event of events || []) {
    const runId = normalizeRunId(event.runId || event.meta?.runId) || "unscoped";
    const bucket = byRun.get(runId) || { runId, tokens: 0, count: 0, earliestTimestamp: "", latestTimestamp: "" };
    bucket.tokens += Number(event.tokens || 0);
    bucket.count += 1;
    bucket.earliestTimestamp = bucket.earliestTimestamp
      ? (compareIso(event.timestamp, bucket.earliestTimestamp) < 0 ? event.timestamp : bucket.earliestTimestamp)
      : event.timestamp || "";
    bucket.latestTimestamp = maxIso(bucket.latestTimestamp, event.timestamp);
    byRun.set(runId, bucket);
  }
  let buckets = [...byRun.values()];
  if (anchorTimestamp && maxDistanceMs > 0) {
    buckets = buckets.filter((bucket) => bucketWithinWindow(bucket, anchorTimestamp, maxDistanceMs));
  }
  if (wantedRunId && buckets.some((bucket) => bucket.runId === wantedRunId)) {
    return buckets.find((bucket) => bucket.runId === wantedRunId);
  }
  buckets.sort((left, right) => compareIso(right.latestTimestamp, left.latestTimestamp));
  return buckets[0] || { runId: "", tokens: 0, count: 0, earliestTimestamp: "", latestTimestamp: "" };
}

function bucketWithinWindow(bucket = {}, anchorTimestamp = "", maxDistanceMs = 0) {
  const anchorTime = Date.parse(anchorTimestamp || "");
  if (!Number.isFinite(anchorTime) || maxDistanceMs <= 0) return true;
  const times = [bucket.earliestTimestamp, bucket.latestTimestamp]
    .map((timestamp) => Date.parse(timestamp || ""))
    .filter(Number.isFinite);
  if (!times.length) return true;
  return times.some((time) => Math.abs(time - anchorTime) <= maxDistanceMs);
}

function isObservedInputPayload(event = {}) {
  const phase = String(event.phase || event.meta?.phase || "").trim().toLowerCase();
  if (!phase) return true;
  return ["input", "prompt", "user-prompt", "user_prompt", "explore", "edit"].includes(phase);
}

function isControlledProtocolEvent(event = {}) {
  const source = String(event.source || event.meta?.source || "").toLowerCase();
  return source === "pair-harness" || source.startsWith("pair-harness:") || source.startsWith("live-observed-pair-run:");
}

function eventHasEmbeddedScopeLeaseContext(event = {}) {
  return event.scopeleaseContextEmbedded === true || event.meta?.scopeleaseContextEmbedded === true;
}

function sumEmbeddedScopeLeaseContextTokens(events = []) {
  return events.reduce((sum, event) => sum + Number(event.scopeleaseContextTokens || event.meta?.scopeleaseContextTokens || 0), 0);
}

function summarizeAgentVisibleBoundary({ scopeleaseMcpInput, observedToolPayload, codexLocalAggregate, tokenizerEstimate, pairedLaneEvidence, researchCalibration = {} }) {
  const observedPayloadTokens = Number(scopeleaseMcpInput.tokens || 0) + Number(observedToolPayload.tokens || 0);
  const status = observedPayloadTokens || codexLocalAggregate.status === "available" ? "available" : "unavailable";
  return {
    kind: "agent_visible_usage",
    status,
    observedPayloadTokens,
    totalObservedTokens: observedPayloadTokens,
    sources: [
      {
        source: "scopelease_mcp_input",
        status: scopeleaseMcpInput.status,
        tokens: scopeleaseMcpInput.tokens,
        confidenceBand: scopeleaseMcpInput.confidenceBand
      },
      {
        source: "observed_tool_payload",
        status: observedToolPayload.status,
        tokens: observedToolPayload.tokens,
        confidenceBand: observedToolPayload.confidenceBand
      },
      {
        source: "codex_local_aggregate",
        status: codexLocalAggregate.status,
        tokens: codexLocalAggregate.totalTokens,
        confidenceBand: codexLocalAggregate.confidenceBand,
        note: "Current repo session trend only; not added to observedPayloadTokens. Other Codex workspaces are excluded from this calculation."
      },
      {
        source: "tokenizer_estimate",
        status: tokenizerEstimate.status,
        confidenceBand: tokenizerEstimate.confidenceBand
      }
    ],
    confidence: {
      scopeleaseMcpInput: scopeleaseMcpInput.confidenceBand,
      observedToolPayload: observedToolPayload.confidenceBand,
      codexSessionTrend: codexLocalAggregate.confidenceBand,
      providerBillingUsage: "excluded"
    },
    savingsBasis: {
      status: pairedLaneEvidence.status,
      researchCalibrationStatus: researchCalibration.status || "unavailable",
      formula: pairedLaneEvidence.formula,
      defaultCodexObservedInputTokens: pairedLaneEvidence.defaultCodexObservedInputTokens || null,
      scopeleaseCodexObservedInputTokens: pairedLaneEvidence.scopeleaseCodexObservedInputTokens || null,
      savedTokens: pairedLaneEvidence.savedTokens,
      savedPercent: pairedLaneEvidence.savedPercent,
      deltaDirection: pairedLaneEvidence.deltaDirection || "unknown",
      canClaimExactDelta: researchCalibration.claimPolicy?.canClaimExactDelta === true,
      canClaimExactSavings: researchCalibration.claimPolicy?.canClaimExactSavings === true,
      allowed: "same workIntent default-codex observed input n versus scopelease-codex observed input m",
      excluded: "full repository tokens, provider/API billing tokens, hidden prompts, hidden reasoning"
    }
  };
}

function buildRecommendations({ scopeleaseMcpInput, observedToolPayload, codexLocalAggregate, codexSessionInventory = {}, pairedLaneEvidence }) {
  const recommendations = [];
  if (pairedLaneEvidence.status === "available" && pairedLaneEvidence.canClaimPositiveSavings) {
    recommendations.push("Use pairedLaneEvidence for agent-visible savings claims.");
  } else if (pairedLaneEvidence.status === "available") {
    recommendations.push("Use pairedLaneEvidence as an exact observed delta, but do not call it savings unless default-codex tokens exceed scopelease-codex tokens.");
  } else {
    recommendations.push("Record both lanes for the same workIntent: default-codex observed input n and scopelease-codex observed input m.");
  }
  if (scopeleaseMcpInput.status === "available") {
    recommendations.push("Use scopelease_mcp_input as the exact ScopeLease-provided context size.");
  }
  if (observedToolPayload.status === "available") {
    recommendations.push("Use observed_tool_payload as a bounded estimate of tool/read/output payload visible to the agent.");
  }
  if (codexLocalAggregate.status === "available") {
    recommendations.push("Use codex_local_aggregate only for historical Codex thread-record trend, not active-session counts or request-level savings.");
  }
  if ((codexSessionInventory.scope?.excludedWorkspaceCount || 0) > 0) {
    recommendations.push("Keep excluded Codex workspaces visible as inventory only; do not include them in the current repo calculation.");
  }
  recommendations.push("Do not mix provider/API usage into agent-visible context savings.");
  return recommendations;
}

function aggregateByLane(events = []) {
  return events.reduce((acc, event) => {
    const lane = eventLane(event) || "unassigned";
    const current = acc[lane] || { events: 0, tokens: 0 };
    current.events += 1;
    current.tokens += Number(event.tokens || 0);
    acc[lane] = current;
    return acc;
  }, {});
}

function eventLane(event = {}) {
  const value = String(event.lane || event.runLane || event.meta?.lane || event.source || "").toLowerCase().replace(/[_\s]+/g, "-");
  if (value === "scopelease-internal" || value.startsWith("watch:auto")) return "scopelease-internal";
  if (/(default|baseline|without-scopelease|no-scopelease|plain-codex)/.test(value)) return "default-codex";
  if (/(scopelease-codex|with-scopelease|mcp|scopelease)/.test(value)) return "scopelease-codex";
  return "";
}

function eventWorkIntent(event = {}) {
  const explicit = normalizePairKey(event.workIntent || event.meta?.workIntent || "");
  if (explicit) return explicit;
  const requestText = normalizePairKey(event.userRequest || event.request || event.requestKey || "");
  return normalizePairKey(deriveWorkIntent({ request: requestText }) || requestText);
}

function normalizePairKey(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function querySqliteJson(dbPath, sql, options = {}) {
  try {
    const output = execFileSync("sqlite3", ["-json", dbPath, sql], {
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: Number(options.maxBuffer || 1024 * 1024)
    });
    return {
      ok: true,
      rows: output.trim() ? JSON.parse(output) : []
    };
  } catch (error) {
    return {
      ok: false,
      rows: [],
      error: error.message || String(error)
    };
  }
}

function normalizeCodexThreadRow(row = {}) {
  return {
    id: String(row.id || ""),
    cwd: String(row.cwd || ""),
    recordType: "codex_sqlite_thread_record",
    activeSessionStatus: "not_measured",
    activeSessionKnown: false,
    modelProvider: String(row.modelProvider || row.model_provider || ""),
    model: String(row.model || ""),
    tokensUsed: Number(row.tokensUsed || row.tokens_used || 0),
    createdAt: normalizeCodexTimestamp(row.createdAt || row.created_at),
    updatedAt: normalizeCodexTimestamp(row.updatedAt || row.updated_at),
    archived: Number(row.archived || 0) === 1,
    title: String(row.title || "")
  };
}

function normalizeCodexTimestamp(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const millis = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    const date = new Date(millis);
    return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
  }
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}

function readScopeLeaseState(repo) {
  return readJsonFile(path.join(repo, ".decision", "state.json")) || {};
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function resolveCodexHome(value = "") {
  if (value) return path.resolve(expandHome(value));
  return path.join(os.homedir(), ".codex");
}

function expandHome(value) {
  const text = String(value || "");
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return text;
}

function compactHomePath(value) {
  const text = String(value || "");
  const home = os.homedir();
  return text.startsWith(home) ? `~${text.slice(home.length)}` : text;
}

function sumNumbers(events = [], key) {
  return events.reduce((sum, event) => sum + Number(event?.[key] || 0), 0);
}

function normalizeRunId(value = "") {
  return String(value || "").trim();
}

function normalizePairId(value = "") {
  return String(value || "").trim();
}

function compareIso(left = "", right = "") {
  const leftTime = Date.parse(left || "");
  const rightTime = Date.parse(right || "");
  if (!Number.isFinite(leftTime) && !Number.isFinite(rightTime)) return 0;
  if (!Number.isFinite(leftTime)) return -1;
  if (!Number.isFinite(rightTime)) return 1;
  return leftTime - rightTime;
}

function maxIso(left = "", right = "") {
  return compareIso(left, right) >= 0 ? left : right;
}

function sameFsPath(left = "", right = "") {
  return canonicalFsPath(left) === canonicalFsPath(right);
}

function canonicalFsPath(value = "") {
  const resolved = path.resolve(expandHome(String(value || "")));
  try {
    return fs.realpathSync.native(resolved).normalize("NFC");
  } catch {
    return resolved.normalize("NFC").replace(/\/+$/, "");
  }
}

function sortedStrings(values = []) {
  return [...values].map((value) => String(value || "").trim()).filter(Boolean).sort();
}
