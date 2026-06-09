import { hashText } from "../fs-utils.js";

export function buildEvent(analysis) {
  const signature = eventSignature(analysis);
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    signature,
    timestamp: analysis.generatedAt,
    summary: analysis.summary,
    risk: analysis.risk,
    uncertainty: analysis.uncertainty,
    changedFiles: analysis.changes.files,
    policyHits: analysis.policyHits.map((hit) => hit.ruleId)
  };
}

export function compactEvents(events) {
  const output = [];
  const seen = new Set();
  for (const event of events) {
    const signature = event.signature || eventSignature(event);
    const displayKey = eventDisplayKey(event);
    if (seen.has(signature) || seen.has(displayKey)) continue;
    seen.add(signature);
    seen.add(displayKey);
    output.push({ ...event, signature });
  }
  return output;
}

function eventSignature(value) {
  return hashText(JSON.stringify({
    risk: value.risk,
    uncertainty: value.uncertainty,
    recommendation: value.recommendation,
    changedFiles: value.changedFiles || value.changes?.files || [],
    fileHashes: value.changes?.fileHashes || {},
    policyHits: value.policyHits?.map((hit) => hit.ruleId || hit) || []
  }));
}

function eventDisplayKey(value) {
  return JSON.stringify({
    summary: value.summary,
    risk: value.risk,
    changedFiles: value.changedFiles || value.changes?.files || [],
    policyHits: value.policyHits?.map((hit) => hit.ruleId || hit) || []
  });
}
