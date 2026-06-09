import fs from "node:fs";
import path from "node:path";
import { decisionPath, ensureDir, hashText } from "../fs-utils.js";

export const RESEARCH_CALIBRATION_LEDGER = "research-calibration.jsonl";

export function buildResearchCalibrationRecord({
  repo = "",
  request = "",
  taskIntent = null,
  observedPairSavings = null,
  researchCalibration = null,
  agentVisibleUsage = null,
  source = "manual",
  experimentId = "",
  notes = ""
} = {}) {
  const generatedAt = new Date().toISOString();
  const pairing = taskIntent?.pairing || {};
  const unit = researchCalibration?.unit || {};
  const pairId = observedPairSavings?.pairId || unit.pairId || pairing.pairId || null;
  const runId = observedPairSavings?.runId || unit.runId || null;
  const pairingKey = pairing.pairingKey || observedPairSavings?.workIntent || unit.workIntent || "";
  const record = {
    kind: "scopelease.research_calibration_record",
    schema: "scopelease-research-calibration-v1",
    generatedAt,
    source,
    scope: "paper_research_only",
    repo: path.resolve(repo || "."),
    request,
    experiment: {
      experimentId: experimentId || stableExperimentId({ repo, request, pairId, pairingKey }),
      taskId: pairing.taskId || "",
      pairingKey,
      pairId,
      runId
    },
    taskIntent,
    observedPairSavings,
    researchCalibration,
    agentVisibleUsage,
    claimPolicy: researchCalibration?.claimPolicy || null,
    validityChecks: researchCalibration?.validityChecks || [],
    productRuntimeImpact: researchCalibration?.productRuntimeImpact || {
      extraAgentRuns: 0,
      note: "Research calibration records only observed evidence and does not create agent runs."
    },
    notes
  };
  record.id = `research_calibration_${hashText(JSON.stringify({
    repo: record.repo,
    generatedAt,
    experiment: record.experiment,
    status: record.researchCalibration?.status || ""
  })).slice(0, 16)}`;
  return record;
}

export function appendResearchCalibrationRecord(repo, record) {
  const ledgerPath = decisionPath(path.resolve(repo || "."), RESEARCH_CALIBRATION_LEDGER);
  ensureDir(path.dirname(ledgerPath));
  fs.appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`);
  return {
    ledgerPath,
    record
  };
}

export function readResearchCalibrationLedger(repo, { limit = 50 } = {}) {
  const ledgerPath = decisionPath(path.resolve(repo || "."), RESEARCH_CALIBRATION_LEDGER);
  if (!fs.existsSync(ledgerPath)) return [];
  const lines = fs.readFileSync(ledgerPath, "utf8").split(/\n/).filter(Boolean);
  const selected = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? lines.slice(-Number(limit))
    : lines;
  return selected.map((line) => JSON.parse(line));
}

export function summarizeResearchCalibrationLedger(records = []) {
  const total = records.length;
  const claimReady = records.filter((record) => record?.researchCalibration?.status === "claim_ready").length;
  const insufficientPair = records.filter((record) => record?.researchCalibration?.status === "insufficient_pair").length;
  const latest = records[records.length - 1] || null;
  return {
    kind: "scopelease.research_calibration_ledger_summary",
    total,
    claimReady,
    insufficientPair,
    latestStatus: latest?.researchCalibration?.status || null,
    latestExperimentId: latest?.experiment?.experimentId || null
  };
}

function stableExperimentId({ repo = "", request = "", pairId = "", pairingKey = "" } = {}) {
  return `exp:${hashText(JSON.stringify({
    repo: path.resolve(repo || "."),
    request,
    pairId,
    pairingKey
  })).slice(0, 12)}`;
}
