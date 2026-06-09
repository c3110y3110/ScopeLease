import fs from "node:fs";
import path from "node:path";
import { appUrl, projectPort } from "./app-service.js";
import { detectAgentVisibleUsage } from "./codex-usage-detector.js";

const HUB_NODE_ID = "scopelease-hub:global";

export async function detectHubProjects({
  repoPath = ".",
  state = {},
  codexHome = "",
  includeHealth = true,
  healthTimeoutMs = 1000
} = {}) {
  const root = path.resolve(repoPath || ".");
  const detection = detectAgentVisibleUsage({
    repoPath: root,
    state,
    codexHome,
    workspaceLimit: null
  });
  const inventory = detection.codexSessionInventory || {};
  const workspaces = Array.isArray(inventory.workspaces) ? inventory.workspaces : [];
  const projects = await Promise.all(workspaces.map((workspace) => buildHubProject({
    workspace,
    currentRepo: root,
    includeHealth,
    healthTimeoutMs
  })));

  const knowledgeGraph = buildHubKnowledgeGraph({ root, projects, inventory });
  const runningProjects = projects.filter((project) => project.runtime.status === "running").length;
  const attachedProjects = projects.filter((project) => project.scopelease.attached).length;

  return {
    kind: "scopelease.hub_projects",
    mode: "global_inventory_project_local_effects",
    generatedAt: new Date().toISOString(),
    currentRepo: root,
    currentRepoCanonical: canonicalFsPath(root),
    projectLocalEffectsOnly: true,
    controlBoundary: "Hub inventories all Codex workspaces and starts project-local runtimes; ScopeLease writes remain in each target project's .codex/.decision paths.",
    source: {
      codexState: inventory.source || "",
      recordType: "historical_codex_workspace_thread_records",
      activeSessionClaim: false,
      safeWithoutBilling: detection.safeWithoutBilling === true,
      providerUsageExcluded: detection.providerUsageExcluded !== false
    },
    totals: {
      projects: projects.length,
      workspaces: inventory.totalWorkspaces || projects.length,
      threadRecords: projects.reduce((sum, project) => sum + Number(project.codex.threadRecords || 0), 0),
      tokens: projects.reduce((sum, project) => sum + Number(project.codex.tokens || 0), 0),
      runningProjects,
      stoppedProjects: projects.length - runningProjects,
      attachedProjects
    },
    projects,
    knowledgeGraph
  };
}

async function buildHubProject({ workspace = {}, currentRepo = "", includeHealth = true, healthTimeoutMs = 450 }) {
  const cwd = path.resolve(expandHome(workspace.cwd || workspace.canonicalCwd || "."));
  const canonicalCwd = canonicalFsPath(workspace.canonicalCwd || cwd);
  const port = projectPort(cwd);
  const exists = directoryExists(cwd);
  const scopelease = inspectProjectScopeLeaseAttachment(cwd);
  const health = includeHealth && exists
    ? await readProjectHealth({ port, cwd, timeoutMs: healthTimeoutMs })
    : { status: exists ? "not_checked" : "missing_path", ok: false, health: null };
  return {
    id: `scopelease-project:${stableGraphId(canonicalCwd || cwd)}`,
    name: projectName(cwd),
    cwd,
    canonicalCwd,
    exists,
    matchesCurrentRepo: sameFsPath(cwd, currentRepo),
    codex: {
      workspaceId: `codex-workspace:${stableGraphId(canonicalCwd || cwd)}`,
      threadRecords: Number(workspace.threads || 0),
      archivedThreadRecords: Number(workspace.archivedThreads || 0),
      tokens: Number(workspace.tokens || 0),
      latestUpdatedAt: workspace.latestUpdatedAt || null,
      latestThreadId: workspace.latestThreadId || "",
      latestTitle: workspace.latestTitle || "",
      models: workspace.models || [],
      providers: workspace.providers || [],
      recordType: "historical_codex_workspace_thread_records",
      activeSessionClaim: false
    },
    scopelease,
    runtime: {
      status: health.status,
      port,
      url: appUrl(port),
      mode: health.health?.runtime?.mode || "",
      repo: health.health?.repo || "",
      ok: health.ok,
      portBusyWithOtherRepo: health.status === "port_busy_other_repo"
    },
    effects: {
      scope: "project_local",
      decisionDir: path.join(cwd, ".decision"),
      codexDir: path.join(cwd, ".codex"),
      note: "Hub actions inventory/start/open only. Runtime measurements and approval leases are stored under this project's local paths."
    }
  };
}

async function readProjectHealth({ port, cwd, timeoutMs }) {
  const health = await fetchRuntimeHealth(port, { timeoutMs });
  if (!health?.ok) return { status: "stopped", ok: false, health: null };
  if (health.runtime?.mode === "hub" || health.runtime?.hubMode === true) {
    return { status: "hub_control_port", ok: false, health };
  }
  if (sameFsPath(health.repo || "", cwd)) return { status: "running", ok: true, health };
  return { status: "port_busy_other_repo", ok: false, health };
}

async function fetchRuntimeHealth(port, { timeoutMs = 1000 } = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/runtime-health`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function inspectProjectScopeLeaseAttachment(root) {
  const configPath = path.join(root, ".codex", "config.toml");
  const hooksPath = path.join(root, ".codex", "hooks.json");
  const decisionStatePath = path.join(root, ".decision", "state.json");
  const config = readTextFile(configPath);
  const hooks = readTextFile(hooksPath);
  const mcpConfigured = /\[mcp_servers\.scopelease\]/.test(config || "");
  const hooksConfigured = /scopelease-codex-hook\.js/.test(hooks || "");
  const decisionStateExists = fs.existsSync(decisionStatePath);
  return {
    attached: mcpConfigured || hooksConfigured || decisionStateExists,
    mcpConfigured,
    hooksConfigured,
    decisionStateExists,
    configPath,
    hooksPath,
    decisionStatePath
  };
}

function buildHubKnowledgeGraph({ root, projects = [], inventory = {} }) {
  const nodes = [];
  const edges = [];
  const nodeIds = new Set();
  const edgeIds = new Set();
  addGraphNode(nodes, nodeIds, {
    id: HUB_NODE_ID,
    label: "ScopeLease Hub",
    type: "scopelease_hub",
    labels: ["ScopeLeaseNode", "ScopeLeaseHub", "CodexUsage", "Evidence"],
    path: root,
    properties: {
      currentRepo: root,
      totalProjects: projects.length,
      totalWorkspaces: inventory.totalWorkspaces || projects.length,
      totalThreadRecords: projects.reduce((sum, project) => sum + Number(project.codex.threadRecords || 0), 0),
      activeSessionClaim: false,
      effects: "project_local_only"
    }
  });

  for (const project of projects) {
    addGraphNode(nodes, nodeIds, {
      id: project.id,
      label: project.name,
      type: "scopelease_project",
      labels: ["ScopeLeaseNode", "ScopeLeaseProject", "CodexUsage", "Evidence"],
      path: project.cwd,
      properties: {
        cwd: project.cwd,
        runtimeStatus: project.runtime.status,
        port: project.runtime.port,
        url: project.runtime.url,
        attached: project.scopelease.attached,
        matchesCurrentRepo: project.matchesCurrentRepo,
        threadRecords: project.codex.threadRecords,
        tokensUsed: project.codex.tokens,
        latestUpdatedAt: project.codex.latestUpdatedAt,
        effectsScope: project.effects.scope
      }
    });
    addGraphEdge(edges, edgeIds, {
      source: HUB_NODE_ID,
      target: project.id,
      type: "hub_manages_project",
      relationshipType: "HUB_MANAGES_PROJECT",
      properties: { basis: "Codex sqlite workspace inventory; hub control only" }
    });

    addGraphNode(nodes, nodeIds, {
      id: project.codex.workspaceId,
      label: project.cwd,
      type: "codex_workspace",
      labels: ["ScopeLeaseNode", "CodexWorkspace", "CodexUsage", "Evidence"],
      path: project.cwd,
      properties: {
        cwd: project.cwd,
        canonicalCwd: project.canonicalCwd,
        threadRecords: project.codex.threadRecords,
        archivedThreadRecords: project.codex.archivedThreadRecords,
        tokensUsed: project.codex.tokens,
        latestUpdatedAt: project.codex.latestUpdatedAt,
        latestTitle: project.codex.latestTitle,
        activeSessionClaim: false
      }
    });
    addGraphEdge(edges, edgeIds, {
      source: project.id,
      target: project.codex.workspaceId,
      type: "project_has_codex_workspace",
      relationshipType: "PROJECT_HAS_CODEX_WORKSPACE",
      properties: { basis: "Codex local sqlite cwd group" }
    });
  }

  return {
    kind: "scopelease_hub_knowledge_graph",
    schema: {
      model: "scopelease_hub_project_kg",
      nodeCount: nodes.length,
      relationshipCount: edges.length,
      nodeLabels: sortedStrings(new Set(nodes.flatMap((node) => node.labels || []))),
      relationshipTypes: sortedStrings(new Set(edges.map((edge) => edge.relationshipType || String(edge.type || "").toUpperCase())))
    },
    nodes,
    edges,
    note: "Hub KG shows global Codex workspace inventory. Project runtime effects remain local to each project path."
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

function projectName(value = "") {
  const base = path.basename(value || "");
  return base || value || "project";
}

function directoryExists(value = "") {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
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

function expandHome(value) {
  const text = String(value || "");
  if (text === "~") return process.env.HOME || "";
  if (text.startsWith("~/")) return path.join(process.env.HOME || "", text.slice(2));
  return text;
}

function stableGraphId(value = "") {
  const text = String(value || "").normalize("NFC");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return `${text.slice(0, 42).replace(/[^a-z0-9_.:-]+/gi, "_")}:${Math.abs(hash).toString(36)}`;
}

function sortedStrings(values = []) {
  return [...values].map((value) => String(value || "").trim()).filter(Boolean).sort();
}
