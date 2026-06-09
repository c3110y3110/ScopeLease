import fs from "node:fs";
import path from "node:path";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

export function extractCodexTokensUsedFromText(text = "") {
  const clean = String(text || "").replace(ANSI_PATTERN, "");
  const matches = [...clean.matchAll(/tokens used\s*\r?\n\s*([0-9][0-9,]*)/gi)];
  if (!matches.length) return null;
  return Number(matches.at(-1)[1].replaceAll(",", ""));
}

export function extractCodexTokensUsedFromCast(castPath) {
  if (!castPath || !fs.existsSync(castPath)) return null;
  const values = [];
  for (const line of fs.readFileSync(castPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (Array.isArray(event) && event.length >= 3) {
        const value = extractCodexTokensUsedFromText(String(event[2] || ""));
        if (Number.isFinite(value)) values.push(value);
      }
    } catch {
      const value = extractCodexTokensUsedFromText(line);
      if (Number.isFinite(value)) values.push(value);
    }
  }
  return values.length ? values.at(-1) : null;
}

export function summarizeTerminalBenchRun(runDir, {
  conditionId = "",
  boundary = "same_prompt_observed_run_not_scopelease_behavior_claim",
  source = "terminal_bench"
} = {}) {
  const root = path.resolve(runDir);
  const resultsPath = path.join(root, "results.json");
  if (!fs.existsSync(resultsPath)) {
    throw new Error(`Terminal-Bench results.json not found: ${resultsPath}`);
  }
  const payload = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  const results = Array.isArray(payload.results) ? payload.results : [];
  const rows = results.map((result) => {
    const castPath = terminalBenchCastPath(root, result);
    const commandReportedTokens = extractCodexTokensUsedFromCast(castPath);
    const scopeleaseCondition = readTerminalBenchScopeLeaseCondition(root, result, castPath);
    return {
      taskId: String(result.task_id || result.taskId || ""),
      trialName: String(result.trial_name || ""),
      isResolved: Boolean(result.is_resolved),
      parserResults: result.parser_results || {},
      commandReportedTokens,
      castPath: castPath && fs.existsSync(castPath) ? castPath : null,
      scopeleaseCondition,
      boundary
    };
  });
  const totalCommandReportedTokens = rows.reduce((total, row) => total + Number(row.commandReportedTokens || 0), 0);
  const missingTokenRows = rows.filter((row) => !Number.isFinite(row.commandReportedTokens)).length;
  const resolved = rows.filter((row) => row.isResolved).length;
  return {
    kind: "scopelease.terminal_bench_observed_summary",
    source,
    boundary,
    conditionId: conditionId || inferConditionId(root),
    runDir: root,
    resultsPath,
    taskCount: rows.length,
    resolved,
    unresolved: rows.length - resolved,
    accuracy: rows.length ? resolved / rows.length : null,
    totalCommandReportedTokens,
    missingTokenRows,
    scopeleaseConditionRows: rows.filter((row) => row.scopeleaseCondition).length,
    scopeleaseConditions: [...new Set(rows.map((row) => row.scopeleaseCondition?.condition).filter(Boolean))],
    rows,
    claimBoundary: {
      promptMutation: "none_expected",
      canClaim: [
        "task completion for this exact run",
        "Codex CLI command-reported tokens for this exact run",
        "post-hoc trajectory observations if paired with ScopeLease logs"
      ],
      cannotClaim: [
        "ScopeLease caused behavior improvement when the task prompt is unchanged",
        "provider billing reduction",
        "human fatigue or trust improvement",
        "C1/C2/C3 ablation effect without separate host-side enforcement or context delivery"
      ]
    }
  };
}

export function compareTerminalBenchObservedRuns(baselineSummary, observedSummary) {
  const baselineTokens = Number(baselineSummary?.totalCommandReportedTokens || 0);
  const observedTokens = Number(observedSummary?.totalCommandReportedTokens || 0);
  return {
    kind: "scopelease.terminal_bench_observed_comparison",
    boundary: "same_prompt_observed_comparison_not_behavior_causality",
    baseline: {
      conditionId: baselineSummary?.conditionId || "C0",
      taskCount: baselineSummary?.taskCount || 0,
      resolved: baselineSummary?.resolved || 0,
      totalCommandReportedTokens: baselineTokens
    },
    observed: {
      conditionId: observedSummary?.conditionId || "observed",
      taskCount: observedSummary?.taskCount || 0,
      resolved: observedSummary?.resolved || 0,
      totalCommandReportedTokens: observedTokens
    },
    tokenDelta: {
      savedTokens: baselineTokens - observedTokens,
      savedPercent: baselineTokens > 0 ? ((baselineTokens - observedTokens) / baselineTokens) * 100 : null,
      interpretation: "positive values mean the observed run used fewer Codex CLI command-reported tokens; this is not provider billing"
    },
    completionDelta: (observedSummary?.resolved || 0) - (baselineSummary?.resolved || 0)
  };
}

function terminalBenchCastPath(root, result = {}) {
  if (result.recording_path) {
    const direct = path.join(root, result.recording_path);
    if (fs.existsSync(direct)) return direct;
  }
  const taskId = String(result.task_id || result.taskId || "");
  const trialName = String(result.trial_name || "");
  return path.join(root, taskId, trialName, "sessions", "agent.cast");
}

function readTerminalBenchScopeLeaseCondition(root, result = {}, castPath = "") {
  const candidates = [];
  if (castPath && fs.existsSync(castPath)) {
    candidates.push(path.join(path.dirname(path.dirname(castPath)), "agent-logs", "scopelease-terminal-bench-condition.json"));
  }
  const taskId = String(result.task_id || result.taskId || "");
  const trialName = String(result.trial_name || "");
  if (taskId && trialName) {
    candidates.push(path.join(root, taskId, trialName, "agent-logs", "scopelease-terminal-bench-condition.json"));
  }
  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
      return {
        path: candidate,
        condition: parsed.condition || "",
        promptMutation: parsed.promptMutation || "",
        mcpEnabled: Boolean(parsed.mcpEnabled),
        hooksEnabled: Boolean(parsed.hooksEnabled),
        agentsFile: Boolean(parsed.agentsFile),
        contextTokens: finiteNumberOrNull(parsed.contextTokens),
        readPlanCount: finiteNumberOrNull(parsed.readPlanCount),
        setup: Array.isArray(parsed.setup) ? parsed.setup.map((item) => ({
          cmd: String(item.cmd || ""),
          status: Number.isFinite(Number(item.status)) ? Number(item.status) : null
        })) : []
      };
    } catch {
      return { path: candidate, parseError: true };
    }
  }
  return null;
}

function inferConditionId(runDir = "") {
  const name = path.basename(String(runDir || "")).toLowerCase();
  if (name.includes("c0") || name.includes("baseline")) return "C0";
  if (name.includes("c1") || name.includes("context")) return "C1";
  if (name.includes("c2") || name.includes("guard")) return "C2";
  if (name.includes("c3") || name.includes("full")) return "C3";
  if (name.includes("observed")) return "observed";
  return "";
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
