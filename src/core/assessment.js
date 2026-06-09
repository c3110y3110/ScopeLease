import { RISK_RANK } from "../constants.js";

export function assess({ changedFiles, deletedFiles, changedSymbols, policyHits, related, index }) {
  let risk = "low";
  const reasons = [];
  const sourceChanged = changedFiles.filter((file) => index.files[file]?.type === "code");
  const docsOnly = changedFiles.length > 0 && changedFiles.every((file) => index.files[file]?.type === "doc") && deletedFiles.length === 0;
  const testsChanged = changedFiles.some((file) => index.files[file]?.type === "test");

  if (sourceChanged.length) {
    risk = maxRisk(risk, "medium");
    reasons.push("source code changed");
  }

  if (deletedFiles.length) {
    risk = maxRisk(risk, "medium");
    reasons.push("files deleted from baseline");
  }

  if (docsOnly) {
    risk = "low";
    reasons.push("documentation-only change");
  }

  if (sourceChanged.length && !related.tests.length && !testsChanged) {
    risk = maxRisk(risk, "high");
    reasons.push("source change has no related test evidence");
  }

  for (const hit of policyHits) {
    risk = maxRisk(risk, hit.risk);
    reasons.push(`policy hit: ${hit.ruleId}`);
  }

  const changedSymbolCount = Object.values(changedSymbols).flat().length;
  const uncertainty = changedFiles.length === 0 && deletedFiles.length === 0
    ? "low"
    : docsOnly
      ? "low"
      : changedSymbolCount === 0 || (sourceChanged.length && !related.tests.length)
      ? "high"
      : policyHits.length
        ? "medium"
        : "low";

  return {
    risk,
    uncertainty,
    recommendation: routeFor({ risk, uncertainty, policyHits, docsOnly }),
    reasons: [...new Set(reasons)]
  };
}

function routeFor({ risk, uncertainty, policyHits, docsOnly }) {
  const explicit = policyHits.find((hit) => RISK_RANK[hit.risk] >= RISK_RANK.high);
  if (explicit?.route) return explicit.route;
  if (docsOnly) return "log_only";
  if (risk === "critical") return "approver";
  if (risk === "high" || uncertainty === "high") return "human_review";
  if (risk === "medium") return "owner_review";
  return "auto_log";
}

function maxRisk(a, b) {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}
