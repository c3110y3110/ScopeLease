#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const args = parseArgs(process.argv.slice(2));
const searchRoot = path.resolve(repoRoot, String(args.root || args.searchRoot || ".."));
const outputPath = args.output ? path.resolve(repoRoot, String(args.output)) : "";
const minRepos = positiveInt(args["min-repos"] || args.minRepos || 10, 10);
const maxDepth = positiveInt(args["max-depth"] || args.maxDepth || 5, 5);
const maxShallowFiles = nonNegativeInt(args["max-shallow-files"] || args.maxShallowFiles || 0, 0);
const format = String(args.format || "json");

const manifestNames = new Set(["package.json", "pyproject.toml", "Cargo.toml", "go.mod"]);
const excludedDirs = new Set([
  ".scopelease",
  ".codex",
  ".decision",
  ".git",
  ".hg",
  ".svn",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "venv",
  ".venv"
]);

const candidates = discover(searchRoot);
const repos = dedupeRepoLabels(candidates.map((candidate) => ({
  label: safeSlug(candidate.label),
  path: candidate.path,
  ...repoInclusion(candidate.path),
  manifestFiles: candidate.manifestFiles,
  gitHead: gitHead(candidate.path),
  insideCurrentRepo: isInside(candidate.path, repoRoot)
})));
const includedRepos = repos.filter((repo) => repo.include);

const result = {
  kind: "scopelease.formal_repo_discovery",
  generatedAt: new Date().toISOString(),
  searchRoot,
  repoRoot,
  maxDepth,
  maxShallowFiles,
  minRepos,
  candidateCount: repos.length,
  includedRepoCount: includedRepos.length,
  ready: includedRepos.length >= minRepos,
  status: includedRepos.length >= minRepos ? "ready" : "insufficient_repositories",
  repos
};

if (outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
}

if (format === "json") {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`${result.status}: ${repos.length}/${minRepos} repositories`);
  for (const repo of repos) console.log(`${repo.label}\t${repo.path}`);
}

function discover(root) {
  const byRoot = new Map();
  walk(root, 0);
  return [...byRoot.values()].sort((a, b) => a.path.localeCompare(b.path));

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const manifests = entries
      .filter((entry) => entry.isFile() && manifestNames.has(entry.name))
      .map((entry) => entry.name)
      .sort();
    if (manifests.length) {
      const rootDir = nearestGitRoot(dir) || dir;
      const existing = byRoot.get(rootDir);
      const manifestFiles = manifests.map((name) => path.relative(rootDir, path.join(dir, name)) || name);
      if (existing) {
        existing.manifestFiles = [...new Set([...existing.manifestFiles, ...manifestFiles])].sort();
      } else {
        byRoot.set(rootDir, {
          label: path.basename(rootDir),
          path: rootDir,
          manifestFiles
        });
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (isExcludedDirName(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  }
}

function nearestGitRoot(dir) {
  let current = path.resolve(dir);
  while (current.startsWith(searchRoot)) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return "";
}

function gitHead(dir) {
  const result = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 5000
  });
  return result.status === 0 ? String(result.stdout || "").trim() : null;
}

function dedupeRepoLabels(rows) {
  const seen = new Map();
  return rows.map((row) => {
    const base = row.label || "repo";
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return count === 0 ? row : { ...row, label: `${base}-${count + 1}` };
  });
}

function repoInclusion(dir) {
  const base = inclusion(dir);
  const shallowFileCountMaxDepth3 = countFiles(dir, 3, maxShallowFiles > 0 ? maxShallowFiles + 1 : 5000);
  if (base.include && maxShallowFiles > 0 && shallowFileCountMaxDepth3 > maxShallowFiles) {
    return {
      include: false,
      excludeReason: "over_resource_bound",
      shallowFileCountMaxDepth3
    };
  }
  return {
    ...base,
    shallowFileCountMaxDepth3
  };
}

function inclusion(dir) {
  const relativeToSearch = path.relative(searchRoot, dir);
  const parts = relativeToSearch.split(path.sep);
  if (isInside(dir, repoRoot)) return { include: false, excludeReason: "current_scopelease_paper_repo" };
  if (parts.some((part) => part.startsWith(".venv") || part === "site-packages")) {
    return { include: false, excludeReason: "virtualenv_or_dependency_tree" };
  }
  if (parts.includes(".claude") && parts.includes("worktrees")) {
    return { include: false, excludeReason: "agent_worktree_copy" };
  }
  if (path.basename(dir).startsWith(path.basename(repoRoot))) {
    return { include: false, excludeReason: "scopelease_paper_copy" };
  }
  return { include: true };
}

function isExcludedDirName(name = "") {
  return excludedDirs.has(name) || name.startsWith(".venv") || name === "site-packages";
}

function countFiles(dir, maxDepth, limit) {
  let count = 0;
  walk(dir, 0);
  return count;

  function walk(current, depth) {
    if (count > limit || depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count > limit) return;
      if (entry.isDirectory()) {
        if (isExcludedDirName(entry.name)) continue;
        walk(path.join(current, entry.name), depth + 1);
      } else if (entry.isFile()) {
        count += 1;
      }
    }
  }
}

function isInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeSlug(value) {
  return String(value || "repo")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "repo";
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}
