#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { summarizeTerminalBenchRun } from "../../src/core/terminal-bench-summary.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function parseArgs(argv) {
  const options = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      i += 1;
    }
  }
  return { options, positionals };
}

function yyyymmdd(date = new Date()) {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

function runDateFromOutput(output = "") {
  const match = String(output || "").match(/(?:^|[^0-9])([0-9]{8})(?:[^0-9]|$)/);
  return match ? match[1] : "";
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(repoRoot, file), "utf8"));
}

function ensureAuthB64(env) {
  if (env.CODEX_AUTH_JSON_B64) return env.CODEX_AUTH_JSON_B64;
  const authPath = path.join(os.homedir(), ".codex", "auth.json");
  if (!fs.existsSync(authPath)) {
    throw new Error(`CODEX_AUTH_JSON_B64 is unset and Codex auth file is missing: ${authPath}`);
  }
  return fs.readFileSync(authPath).toString("base64").replace(/\s+/g, "");
}

function runCommand(command, args, { env, cwd = repoRoot, timeoutMs = 0 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
    shell: false,
    timeout: timeoutMs > 0 ? timeoutMs : undefined,
    killSignal: "SIGTERM"
  });
  return {
    command,
    args,
    status: result.status,
    signal: result.signal,
    ok: result.status === 0
  };
}

function runName(task, condition, runDate) {
  return `tbench-${task.runSlug || task.taskId}-${condition.toLowerCase()}-${runDate}`;
}

function runExists(runDir) {
  return fs.existsSync(path.join(runDir, "results.json"));
}

function summarizeRun(runDir, condition) {
  const summary = summarizeTerminalBenchRun(runDir, {
    conditionId: condition,
    boundary: "same_prompt_connected_c0c3_panel_not_provider_billing_not_human_study",
    source: "terminal_bench_connected_panel"
  });
  fs.writeFileSync(path.join(runDir, "scopelease-terminal-bench-summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}

function aggregate({ root, manifest, runDate, rows }) {
  const conditions = manifest.conditions || ["C0", "C1", "C2", "C3"];
  const byCondition = {};
  for (const condition of conditions) {
    const subset = rows.filter((row) => row.condition === condition);
    const taskCount = subset.reduce((total, row) => total + Number(row.taskCount || 0), 0);
    const resolved = subset.reduce((total, row) => total + Number(row.resolved || 0), 0);
    byCondition[condition] = {
      taskCount,
      resolved,
      accuracy: taskCount ? resolved / taskCount : null,
      totalCommandReportedTokens: subset.reduce((total, row) => total + Number(row.commandReportedTokens || 0), 0),
      missingTokenRows: subset.reduce((total, row) => total + Number(row.missingTokenRows || 0), 0),
      completedRuns: subset.filter((row) => row.status === "completed" || row.status === "existing").length,
      failedRuns: subset.filter((row) => row.status === "failed").length
    };
  }
  const baselineTokens = Number(byCondition.C0?.totalCommandReportedTokens || 0);
  for (const condition of conditions) {
    const tokens = Number(byCondition[condition]?.totalCommandReportedTokens || 0);
    byCondition[condition].deltaVsC0 = {
      savedTokens: baselineTokens - tokens,
      savedPercent: baselineTokens > 0 ? ((baselineTokens - tokens) / baselineTokens) * 100 : null
    };
  }
  const output = {
    kind: "scopelease.terminal_bench_connected_c0c3_panel",
    generatedAt: new Date().toISOString(),
    source: "Terminal-Bench original tasks, selected local panel",
    boundary: manifest.boundary || "same_prompt_connected_c0c3_panel_not_provider_billing_not_human_study",
    runDate,
    outputRoot: root,
    promptMutation: "none",
    taskSelectionRule: manifest.taskSelectionRule || "",
    tasks: manifest.tasks,
    conditions,
    byCondition,
    rows,
    claimBoundary: manifest.claimBoundary || {}
  };
  fs.writeFileSync(path.join(root, "scopelease-terminal-bench-connected-c0c3-panel.json"), JSON.stringify(output, null, 2));

  const lines = [];
  lines.push("# ScopeLease Terminal-Bench Connected C0-C3 Panel");
  lines.push("");
  lines.push(`Generated: ${output.generatedAt}`);
  lines.push(`Run date: ${runDate}`);
  lines.push("");
  lines.push("| Condition | Resolved | Tokens | Delta vs C0 | Failed runs |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const condition of conditions) {
    const item = byCondition[condition];
    const pct = item.deltaVsC0.savedPercent;
    lines.push(`| ${condition} | ${item.resolved}/${item.taskCount} | ${item.totalCommandReportedTokens.toLocaleString("en-US")} | ${formatDelta(item.deltaVsC0.savedTokens, pct)} | ${item.failedRuns} |`);
  }
  lines.push("");
  lines.push("| Task | C0 | C1 | C2 | C3 |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const task of manifest.tasks) {
    const values = conditions.map((condition) => rows.find((row) => row.taskId === task.taskId && row.condition === condition)?.commandReportedTokens || 0);
    lines.push(`| ${task.taskId} | ${values.map((value) => value.toLocaleString("en-US")).join(" | ")} |`);
  }
  lines.push("");
  lines.push("Boundary: same benchmark prompt, selected local Terminal-Bench panel, Codex CLI command-reported tokens only. This does not establish provider-billing reduction or human outcome claims.");
  fs.writeFileSync(path.join(root, "scopelease-terminal-bench-connected-c0c3-panel.md"), lines.join("\n") + "\n");
  return output;
}

function formatDelta(savedTokens, savedPercent) {
  const tokens = Number(savedTokens || 0);
  const pct = Number(savedPercent);
  if (!tokens) return "baseline";
  const amount = Math.abs(tokens).toLocaleString("en-US");
  const percent = Number.isFinite(pct) ? `${Math.abs(pct).toFixed(2)}%` : "n/a";
  return tokens > 0
    ? `${amount} fewer (${percent} lower)`
    : `${amount} more (${percent} higher)`;
}

async function main() {
  const { options } = parseArgs(process.argv.slice(2));
  const manifestPath = options.manifest || "examples/evaluation/terminal-bench-scopelease-c0c3-panel.json";
  const manifest = readJson(manifestPath);
  const runDate = String(options.date || runDateFromOutput(options.output) || yyyymmdd());
  const outputRoot = path.resolve(repoRoot, String(options.output || `.scopelease/reports/terminal-bench-scopelease-c0c3-${runDate}`));
  const datasetPath = path.resolve(repoRoot, String(options["dataset-path"] || manifest.datasetPath));
  const maxNewRuns = Number.isFinite(Number(options["max-new-runs"])) ? Number(options["max-new-runs"]) : Infinity;
  const runnerTimeoutSec = Number.isFinite(Number(options["runner-timeout-sec"])) ? Number(options["runner-timeout-sec"]) : 900;
  const skipExisting = options["skip-existing"] !== "false";
  const dryRun = Boolean(options["dry-run"]);
  fs.mkdirSync(outputRoot, { recursive: true });

  const selectedTasks = options.tasks
    ? new Set(String(options.tasks).split(",").map((item) => item.trim()).filter(Boolean))
    : null;
  const selectedConditions = options.conditions
    ? String(options.conditions).split(",").map((item) => item.trim().toUpperCase()).filter(Boolean)
    : manifest.conditions || ["C0", "C1", "C2", "C3"];

  function buildRunEnv() {
    return {
      ...process.env,
      PYTHONPATH: `${path.join(repoRoot, "scripts", "terminal-bench")}${process.env.PYTHONPATH ? `:${process.env.PYTHONPATH}` : ""}`,
      CODEX_AUTH_JSON_B64: ensureAuthB64(process.env)
    };
  }

  const runRows = [];
  let newRuns = 0;
  for (const task of manifest.tasks) {
    if (selectedTasks && !selectedTasks.has(task.taskId)) continue;
    for (const condition of selectedConditions) {
      const id = runName(task, condition, runDate);
      const runDir = path.join(outputRoot, id);
      const row = {
        taskId: task.taskId,
        runSlug: task.runSlug || task.taskId,
        condition,
        runId: id,
        runDir,
        status: "pending"
      };
      if (skipExisting && runExists(runDir)) {
        const summary = summarizeRun(runDir, condition);
        runRows.push({
          ...row,
          status: "existing",
          resolved: summary.resolved,
          taskCount: summary.taskCount,
          commandReportedTokens: summary.totalCommandReportedTokens,
          missingTokenRows: summary.missingTokenRows,
          scopeleaseConditionRows: summary.scopeleaseConditionRows
        });
        continue;
      }
      if (newRuns >= maxNewRuns) {
        runRows.push({ ...row, status: "not_run_limit" });
        continue;
      }
      newRuns += 1;
      if (dryRun) {
        runRows.push({ ...row, status: "dry_run" });
        continue;
      }
      fs.rmSync(runDir, { recursive: true, force: true });
      console.log(`=== Terminal-Bench ${task.taskId} ${condition} ===`);
      const result = runCommand("tb", [
        "run",
        "--dataset-path", datasetPath,
        "--task-id", task.taskId,
        "--agent-import-path", manifest.agentImportPath,
        "--model", manifest.model,
        "--agent-kwarg", `version=${manifest.agentVersion || "latest"}`,
        "--agent-kwarg", `condition=${condition}`,
        "--output-path", outputRoot,
        "--run-id", id,
        "--n-concurrent", "1",
        "--n-attempts", "1",
        "--global-agent-timeout-sec", String(options["agent-timeout-sec"] || 300),
        "--global-test-timeout-sec", String(options["test-timeout-sec"] || 180),
        "--no-upload-results"
      ], { env: buildRunEnv(), timeoutMs: runnerTimeoutSec * 1000 });
      if (runExists(runDir)) {
        const summary = summarizeRun(runDir, condition);
        runRows.push({
          ...row,
          status: result.ok ? "completed" : "completed_with_nonzero_runner",
          runnerStatus: result.status,
          resolved: summary.resolved,
          taskCount: summary.taskCount,
          commandReportedTokens: summary.totalCommandReportedTokens,
          missingTokenRows: summary.missingTokenRows,
          scopeleaseConditionRows: summary.scopeleaseConditionRows
        });
      } else {
        runRows.push({ ...row, status: "failed", runnerStatus: result.status, signal: result.signal });
      }
    }
  }
  const output = aggregate({ root: outputRoot, manifest, runDate, rows: runRows });
  console.log(JSON.stringify({
    kind: "scopelease.terminal_bench_panel_runner_result",
    outputRoot,
    generatedAt: output.generatedAt,
    byCondition: output.byCondition,
    rows: output.rows.map((row) => ({
      taskId: row.taskId,
      condition: row.condition,
      status: row.status,
      resolved: row.resolved,
      taskCount: row.taskCount,
      commandReportedTokens: row.commandReportedTokens
    }))
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
