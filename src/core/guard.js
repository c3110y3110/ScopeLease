import { createApprovalLease, findValidLease } from "./approval-lease.js";
import { actionGrant, actionInvalidPaths, actionPaths, isHardDenyAction, isLowRiskLocalAction, isPatchPreparation, isSafeLocalRead, isSafeTestCommand, normalizeAgentAction, taskScopedNetworkScopes } from "./action-policy.js";
import { buildDecisionBundle } from "./fatigue-controller.js";

export function evaluateAgentAction({ action = {}, analysis = {}, state = {} }) {
  const normalized = normalizeAgentAction(action);
  const gate = analysis.contextPack?.decisionGate || {};
  const leases = state.approvalLeases || [];
  const lease = findValidLease({ action: normalized, analysis, state, leases });
  if (lease) {
    return verdict({
      verdict: "allow_with_log",
      reason: "valid approval lease covers this action",
      action: normalized,
      leaseId: lease.id,
      graphScopeHash: lease.graphScopeHash || null,
      permissionFrontierHash: lease.permissionFrontierHash || null,
      shouldAskHuman: false
    });
  }

  if (actionInvalidPaths(normalized).length) {
    return verdict({
      verdict: "deny",
      reason: "action path is outside repo-relative scope",
      action: normalized,
      shouldAskHuman: false
    });
  }

  if (actionGrant(normalized) === "apply_patch" && !actionPaths(normalized).length) {
    return verdict({
      verdict: "deny",
      reason: "write action is missing a repo-relative path",
      action: normalized,
      shouldAskHuman: false
    });
  }

  if (isHardDenyAction(normalized, { networkScopes: taskScopedNetworkScopes(analysis) })) {
    return verdict({
      verdict: "deny",
      reason: "action is destructive, external, or outside trusted scope",
      action: normalized,
      shouldAskHuman: false
    });
  }

  if (isSafeLocalRead(normalized)) {
    return verdict({
      verdict: "allow_with_log",
      reason: "local read is allowed and logged",
      action: normalized,
      shouldAskHuman: false
    });
  }

  if (normalized.kind === "bash" && isSafeTestCommand(normalized.command)) {
    return verdict({
      verdict: "allow_with_log",
      reason: "safe local validation command is allowed and logged",
      action: normalized,
      shouldAskHuman: false
    });
  }

  if (gate.canAutoApplyPatch && isLowRiskLocalAction(normalized, analysis)) {
    return verdict({
      verdict: "allow_with_log",
      reason: "low-risk local action under decision gate",
      action: normalized,
      shouldAskHuman: false
    });
  }

  if (gate.canAutoPreparePatch && isPatchPreparation(normalized)) {
    return verdict({
      verdict: "prepare_only",
      reason: "agent may prepare patch but not apply/checkpoint",
      action: normalized,
      shouldAskHuman: false
    });
  }

  const decisionBundle = buildDecisionBundle({
    action: normalized,
    analysis,
    decisionGate: gate,
    taskIntent: analysis.contextPack?.agentContext?.taskIntent || analysis.contextPack?.taskIntent || {},
    readPlan: analysis.contextPack?.agentContext?.readPlan || analysis.contextPack?.codexInput?.promptContext?.readPlan || [],
    policyHits: analysis.policyHits || []
  });
  return verdict({
    verdict: "ask_once",
    reason: "action requires a new approval lease",
    action: normalized,
    decisionBundle,
    graphScopeHash: decisionBundle.scope?.graphScopeHash || null,
    permissionFrontierHash: decisionBundle.scope?.permissionFrontierHash || null,
    reviewFrontierHash: decisionBundle.scope?.reviewFrontierHash || null,
    shouldAskHuman: true
  });
}

export function approveDecisionBundle({ analysis = {}, state = {}, decisionBundle = {}, choiceId = "", grantedBy = "human" }) {
  return createApprovalLease({ analysis, state, decisionBundle, choiceId, grantedBy });
}

function verdict(value) {
  return {
    kind: "scopelease.guard_verdict",
    actionGrant: actionGrant(value.action),
    ...value
  };
}
