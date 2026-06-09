#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const args = parseArgs(process.argv.slice(2));
const runIdPrefix = String(args["run-id-prefix"] || args.runIdPrefix || "formal-local-main-codex");
const signal = String(args.signal || "SIGTERM");
const graceMs = nonNegativeInt(args["grace-ms"] || args.graceMs || 1500, 1500);

const rows = readProcessTable();
const directTargets = rows.filter((row) => isTarget(row, runIdPrefix));
const targetPids = new Set(directTargets.map((row) => row.pid));
let expanded = true;
while (expanded) {
  expanded = false;
  for (const row of rows) {
    if (targetPids.has(row.pid)) continue;
    if (targetPids.has(row.ppid)) {
      targetPids.add(row.pid);
      expanded = true;
    }
  }
}

targetPids.delete(process.pid);
const targets = rows
  .filter((row) => targetPids.has(row.pid))
  .sort((a, b) => b.depth - a.depth || b.pid - a.pid);

for (const row of targets) {
  try {
    process.kill(row.pid, signal);
  } catch {
    // Process may already have exited.
  }
}

if (targets.length && graceMs > 0) wait(graceMs);

const forceKilled = [];
for (const row of targets) {
  if (!isAlive(row.pid)) continue;
  try {
    process.kill(row.pid, "SIGKILL");
    forceKilled.push(row.pid);
  } catch {
    // Process may already have exited.
  }
}

console.log(JSON.stringify({
  kind: "scopelease.formal_local_main_stop",
  runIdPrefix,
  signal,
  matchedCount: targets.length,
  killedPids: targets.map((row) => row.pid),
  forceKilled,
  targets: targets.map((row) => ({
    pid: row.pid,
    ppid: row.ppid,
    command: row.command
  }))
}, null, 2));

function readProcessTable() {
  const ps = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  if (ps.status !== 0) {
    const message = String(ps.stderr || ps.error?.message || "ps failed");
    throw new Error(message);
  }
  const rows = String(ps.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+([\s\S]*)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3],
        depth: 0
      };
    })
    .filter(Boolean);
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  for (const row of rows) row.depth = processDepth(row, byPid);
  return rows;
}

function isTarget(row, prefix) {
  if (!row || row.pid === process.pid) return false;
  const command = row.command || "";
  if (!command.includes(prefix)) return false;
  return command.includes("run-formal-command-eval.mjs")
    || command.includes("src/cli.js")
    || command.includes("pair-run")
    || command.includes("npm run paper:formal:local-main");
}

function processDepth(row, byPid) {
  let depth = 0;
  let current = row;
  const seen = new Set();
  while (current && byPid.has(current.ppid) && !seen.has(current.ppid)) {
    seen.add(current.pid);
    current = byPid.get(current.ppid);
    depth += 1;
  }
  return depth;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function wait(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function nonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    i += 1;
  }
  return parsed;
}
