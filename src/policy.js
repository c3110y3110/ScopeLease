import path from "node:path";
import { DEFAULT_POLICIES, POLICY_FILE, RISK_RANK } from "./constants.js";
import { decisionPath, fileExists, readText, writeText } from "./fs-utils.js";

export function ensurePolicyFile(root) {
  const policyPath = decisionPath(root, POLICY_FILE);
  if (!fileExists(policyPath)) {
    writeText(policyPath, DEFAULT_POLICIES);
  }
  return policyPath;
}

export function loadPolicies(root) {
  const policyPath = ensurePolicyFile(root);
  return parsePolicyYaml(readText(policyPath));
}

export function parsePolicyYaml(text) {
  const rules = [];
  let current = null;
  let activeList = null;
  let activeSection = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, "  ");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const idMatch = trimmed.match(/^-\s+id:\s*(.+)$/);
    if (idMatch) {
      if (current) rules.push(normalizeRule(current));
      current = { id: cleanScalar(idMatch[1]), match: {}, actions: {}, lease: {} };
      activeList = null;
      activeSection = null;
      continue;
    }

    if (!current) continue;

    const listItem = trimmed.match(/^-\s+(.+)$/);
    if (listItem && activeList) {
      if (activeSection === "lease") current.lease[activeList].push(cleanScalar(listItem[1]));
      else current.match[activeList].push(cleanScalar(listItem[1]));
      continue;
    }

    const pair = trimmed.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!pair) continue;

    const key = pair[1];
    const value = pair[2];
    if (["match", "actions", "lease"].includes(key)) {
      activeSection = key;
      activeList = null;
      continue;
    }

    if (["paths", "symbols", "keywords", "file_types"].includes(key)) {
      activeSection = "match";
      current.match[key] = [];
      activeList = key;
      continue;
    }

    if (activeSection === "lease" && key === "stop_when") {
      current.lease.stop_when = [];
      activeList = "stop_when";
      continue;
    }

    activeList = null;
    if (activeSection === "actions" && value) {
      current.actions[key] = cleanScalar(value);
      continue;
    }

    if (activeSection === "lease" && value) {
      current.lease[key] = numericOrScalar(value);
      continue;
    }

    if (["description", "risk", "route", "reason"].includes(key)) {
      activeSection = null;
      current[key] = cleanScalar(value);
    }
  }

  if (current) rules.push(normalizeRule(current));
  return { rules };
}

function normalizeRule(rule) {
  return {
    id: rule.id,
    description: rule.description || rule.reason || "",
    reason: rule.reason || rule.description || "",
    risk: RISK_RANK[rule.risk] ? rule.risk : "medium",
    route: rule.route || "review",
    match: {
      paths: rule.match.paths || [],
      symbols: rule.match.symbols || [],
      keywords: rule.match.keywords || [],
      file_types: rule.match.file_types || []
    },
    actions: rule.actions || {},
    lease: rule.lease || {}
  };
}

function cleanScalar(value) {
  return value.trim().replace(/^["']|["']$/g, "");
}

function numericOrScalar(value) {
  const text = cleanScalar(value);
  const numeric = Number(text);
  return Number.isFinite(numeric) && text !== "" ? numeric : text;
}

export function matchPolicies({ policies, changedFiles, changedSymbols, fileTypes, fileContents }) {
  const hits = [];

  for (const rule of policies.rules || []) {
    const matchedFiles = changedFiles.filter((file) =>
      ruleMatchesFile(rule, file, fileTypes[file], changedSymbols[file] || [], fileContents[file] || "")
    );

    if (matchedFiles.length === 0) continue;

    hits.push({
      ruleId: rule.id,
      description: rule.description,
      reason: rule.reason || rule.description,
      risk: rule.risk,
      route: rule.route,
      actions: rule.actions || {},
      lease: rule.lease || {},
      files: matchedFiles
    });
  }

  return hits.sort((a, b) => (RISK_RANK[b.risk] || 0) - (RISK_RANK[a.risk] || 0));
}

function ruleMatchesFile(rule, relativePath, fileType, symbols, content) {
  const match = rule.match || {};
  const checks = [];

  if (match.paths?.length) {
    checks.push(match.paths.some((pattern) => globToRegExp(pattern).test(relativePath)));
  }

  if (match.file_types?.length) {
    checks.push(match.file_types.includes(fileType));
  }

  if (match.symbols?.length) {
    checks.push(symbols.some((symbol) => match.symbols.some((pattern) => globToRegExp(pattern).test(symbol.name))));
  }

  if (match.keywords?.length) {
    const lower = content.toLowerCase();
    checks.push(match.keywords.some((keyword) => lower.includes(keyword.toLowerCase())));
  }

  return checks.length > 0 && checks.every(Boolean);
}

export function globToRegExp(pattern) {
  let source = pattern.split(path.sep).join("/");
  source = source.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  source = source.replace(/\*\*/g, "__SCOPELEASE_DOUBLE_STAR__");
  source = source.replace(/\*/g, "[^/]*");
  source = source.replace(/__SCOPELEASE_DOUBLE_STAR__/g, ".*");
  return new RegExp(`^${source}$`);
}
