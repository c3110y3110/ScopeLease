#!/usr/bin/env node
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      i += 1;
    }
  }
  return options;
}

function readProcesses() {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    shell: false
  });
  if (result.status !== 0) throw new Error(result.stderr || "failed to read process table");
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3]
      };
    })
    .filter(Boolean);
}

function descendantsOf(processes, rootPids) {
  const byParent = new Map();
  for (const item of processes) {
    if (!byParent.has(item.ppid)) byParent.set(item.ppid, []);
    byParent.get(item.ppid).push(item.pid);
  }
  const seen = new Set(rootPids);
  const queue = [...rootPids];
  while (queue.length) {
    const pid = queue.shift();
    for (const child of byParent.get(pid) || []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return seen;
}

function targetPids(processes, outputRoot) {
  const outputAbs = path.resolve(repoRoot, outputRoot);
  const markers = [outputRoot, outputAbs, "terminal-bench-scopelease-c0c3-20260603"].filter(Boolean);
  const roots = processes
    .filter((item) => item.pid !== process.pid)
    .filter((item) => markers.some((marker) => item.command.includes(marker)))
    .filter((item) => item.command.includes("run-scopelease-c0c3-panel.mjs") || item.command.includes("tb run") || item.command.includes("npm run tbench:scopelease-panel"))
    .map((item) => item.pid);
  return [...descendantsOf(processes, roots)].filter((pid) => pid !== process.pid);
}

function killPids(pids, signal) {
  const killed = [];
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
      killed.push(pid);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  return killed;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const output = String(options.output || ".scopelease/reports/terminal-bench-scopelease-c0c3-20260603");
  const dryRun = Boolean(options["dry-run"]);
  const processes = readProcesses();
  const pids = targetPids(processes, output);
  if (!pids.length) {
    console.log(JSON.stringify({ ok: true, output, matched: 0, killed: [] }, null, 2));
    return;
  }
  if (dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, output, matched: pids.length, pids }, null, 2));
    return;
  }
  const term = killPids(pids.sort((a, b) => b - a), "SIGTERM");
  await sleep(1500);
  const remaining = new Set(targetPids(readProcesses(), output));
  const force = killPids([...remaining].sort((a, b) => b - a), "SIGKILL");
  console.log(JSON.stringify({ ok: true, output, matched: pids.length, term, force }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
