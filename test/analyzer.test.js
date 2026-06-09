import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { analyzeRepository, buildAgentInputPayload, ensureLocalStateIgnored, initRepository, loadState, recordActualWork, recordGuardDecision, recordModelUsage, saveState, setMeasurementMode } from "../src/analyzer.js";
import { buildAdaptiveContext } from "../src/core/adaptive-context.js";
import { validateLease } from "../src/core/approval-lease.js";
import { approveDecisionBundle, evaluateAgentAction } from "../src/core/guard.js";
import { buildDecisionBundle } from "../src/core/fatigue-controller.js";
import { evaluateBenchTokenSavings } from "../src/core/bench-evaluator.js";
import { evaluateGraphClaimBench } from "../src/core/graph-bench.js";
import { evaluateReviewFrontierBench } from "../src/core/review-bench.js";
import { buildConditionMatrixForTasks, loadBenchmarkTaskSpecs } from "../src/core/benchmark-adapter.js";
import { runControlledAblation } from "../src/core/ablation-runner.js";
import { buildSilentFailureSummary, summarizeTrajectoryEvents } from "../src/core/trajectory-metrics.js";
import { buildDelegationControlReport } from "../src/core/delegation-report.js";
import { createSourceArchive, containsStaleSourceArchiveAssertion, containsUnsanitizedLocalPath, readSourceArchiveEntries, resolveSourceArchiveOutput, sourceArchiveEntries, verifySourceArchive } from "../src/core/source-archive.js";
import { compareTerminalBenchObservedRuns, extractCodexTokensUsedFromCast, summarizeTerminalBenchRun } from "../src/core/terminal-bench-summary.js";
import { actionFromHookEvent, enforceAgentAction, runGuardedCommand } from "../src/core/enforcer.js";
import { buildEvidenceSummary, buildProductWideTokenSummary, runPermissionFixtureSuite } from "../src/core/evidence-export.js";
import { resolveLaneCommand, runAgentPairHarness } from "../src/core/pair-harness.js";
import { actionGrant, hasUnsafeCommandPathEscape, hasUnsafeShellControl, isHardDenyAction, isNetworkCommand, isSafeLocalReadCommand, isSafeTestCommand, networkWithinScope, normalizeAgentAction, taskScopedNetworkScopes } from "../src/core/action-policy.js";
import { buildTaskIntent, deriveWorkIntent, requestHash } from "../src/core/work-intent.js";
import { buildIndex } from "../src/core/indexer.js";
import { buildClaimReadyReport, exportHumanDecisionStudyProtocol } from "../src/core/study-report.js";
import { readJson } from "../src/fs-utils.js";
import { ensureScopeLeaseApp, ensureProjectCodexConfig, ensureProjectCodexHooks, projectPort } from "../src/runtime/app-service.js";
import { detectAgentVisibleUsage } from "../src/runtime/codex-usage-detector.js";
import { detectHubProjects } from "../src/runtime/hub-service.js";
import { buildForwardHeaders, extractUsageFromText, inferUserRequestFromBody } from "../src/runtime/usage-proxy.js";
import { startServer } from "../src/server.js";
import { actualWorkEventsForRequest, buildObservedWorkIntentSavings, formatObservedSavings, formatSavingsDisplay } from "../public/savings.js";

process.env.SCOPELEASE_LEASE_KEY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-lease-keys-"));

test("readJson retries transiently invalid state files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-json-retry-"));
  const file = path.join(root, "state.json");
  fs.writeFileSync(file, "{\"partial\":");
  const child = spawn(process.execPath, [
    "-e",
    "const fs=require('fs'); setTimeout(()=>fs.writeFileSync(process.argv[1], JSON.stringify({ok:true})), 30);",
    file
  ], { stdio: "ignore" });
  const value = readJson(file);
  assert.deepEqual(value, { ok: true });
  child.kill();
});

test("analyzeRepository connects changed auth code to policy, test, and docs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-test-"));
  fs.mkdirSync(path.join(root, "src/auth"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/api"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests/auth"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });

  fs.writeFileSync(path.join(root, "src/auth/session.ts"), `
export function validateToken(token: string) {
  if (!token || token.length < 12) return null;
  return { id: "u1", token };
}
`);
  fs.writeFileSync(path.join(root, "src/api/me.ts"), `
import { validateToken } from "../auth/session";
export function GET(req: any) {
  return validateToken(req.token);
}
`);
  fs.writeFileSync(path.join(root, "tests/auth/session.test.ts"), `
import { validateToken } from "../../src/auth/session";
validateToken("sample-token");
`);
  fs.writeFileSync(path.join(root, "docs/auth.md"), "validateToken protects the API boundary.");

  initRepository(root);
  fs.writeFileSync(path.join(root, "src/auth/session.ts"), `
export function validateToken(token: string) {
  if (!token) return null;
  return { id: "u1", token, relaxed: true };
}
`);

  const analysis = analyzeRepository(root);
  assert.equal(analysis.risk, "high");
  assert.equal(analysis.recommendation, "senior_review");
  assert.ok(analysis.policyHits.some((hit) => hit.ruleId === "auth_path_requires_review"));
  assert.ok(analysis.impact.importedBy.some((node) => node.path === "src/api/me.ts"));
  assert.ok(analysis.impact.tests.some((node) => node.path === "tests/auth/session.test.ts"));
  assert.ok(analysis.impact.docs.some((node) => node.path === "docs/auth.md"));
  assert.ok(analysis.impact.paths.some((path) => path.kind === "route" && path.summary.includes("/api/me")));
  assert.ok(analysis.impact.paths.some((path) => path.kind === "test" && path.summary.includes("session.test.ts")));
  assert.ok(analysis.impact.paths.some((path) => path.kind === "policy" && path.summary.includes("auth_path_requires_review")));
  assert.equal(analysis.knowledgeGraph.schema.model, "scopelease_knowledge_graph");
  assert.ok(analysis.knowledgeGraph.schema.nodeLabels.some((item) => item.label === "Changed" && item.count > 0));
  assert.ok(analysis.knowledgeGraph.schema.relationshipTypes.some((item) => item.type === "VIOLATES_POLICY" && item.count > 0));
  assert.ok(analysis.knowledgeGraph.schema.propertyKeys.includes("path"));
  assert.ok(analysis.knowledgeGraph.schema.relationshipPropertyKeys.includes("relationshipType"));
  assert.equal(analysis.knowledgeGraph.schema.querySamples, undefined);
  assert.ok(analysis.knowledgeGraph.nodes.some((node) => node.labels?.includes("Changed") && node.properties?.path === "src/auth/session.ts"));
  assert.ok(analysis.knowledgeGraph.nodes.some((node) => node.labels?.includes("Policy") && node.properties?.name === "auth_path_requires_review"));
  assert.ok(analysis.knowledgeGraph.edges.some((edge) => edge.relationshipType === "VIOLATES_POLICY"));
  fs.mkdirSync(path.join(root, ".codex", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(root, ".scopelease", "tmp"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codex", "config.toml"), "secret config should stay out of KG");
  fs.writeFileSync(path.join(root, ".codex", "hooks", "scopelease-codex-hook.js"), "hook body should stay out of KG");
  fs.writeFileSync(path.join(root, ".scopelease", "tmp", "visible.png"), "binary-ish");
  const internalIndex = buildIndex(root);
  assert.equal(Object.keys(internalIndex.files).some((file) => file.startsWith(".codex/") || file.startsWith(".scopelease/")), false);
  const economy = analysis.contextPack.tokenEconomy;
  assert.ok(economy.fullRepoTokens > 0);
  assert.ok(economy.agentContextTokens > 0);
  assert.equal(economy.mode, "agent_prompt_pack_excludes_visual_graph");
  assert.ok(["tiktoken", "rough_chars_div_4"].includes(economy.estimator));
  assert.equal(typeof economy.exactTokens, "boolean");
  assert.ok(economy.tokenizer.method);
  assert.equal(economy.agentInput.field, "contextPack.agentContext");
  assert.equal(economy.repoScopeExcludedTokens, Math.max(0, economy.fullRepoTokens - economy.agentContextTokens));
  assert.equal(economy.overBudgetTokens, Math.max(0, economy.agentContextTokens - economy.budget));
  assert.equal(economy.remainingBudgetTokens, Math.max(0, economy.budget - economy.agentContextTokens));
  assert.equal(economy.fitsBudget, true);
  assert.match(economy.labels.agentInput, /k$/);
  assert.match(economy.labels.actualInput, /k$/);
  assert.match(economy.labels.repoScopeExcluded, /k$/);
  assert.ok(economy.actualInputTokens > 0);
  assert.ok(economy.userRequestTokens > 0);
  assert.equal(economy.repoScopeExcludedFromScopeLeaseInputTokens, Math.max(0, economy.fullRepoTokens - economy.actualInputTokens));
  assert.equal(Object.hasOwn(economy, "savedTokens"), false);
  assert.equal(Object.hasOwn(economy, "savedPercent"), false);
  assert.equal(Object.hasOwn(economy, "actualSavedTokens"), false);
  assert.equal(Object.hasOwn(economy, "actualSavedPercent"), false);
  assert.match(economy.summary, /Codex 입력 후보/);
  const state = JSON.parse(fs.readFileSync(path.join(root, ".decision", "state.json"), "utf8"));
  assert.equal(typeof state.index.files["src/auth/session.ts"].content, "undefined");
  assert.equal(state.index.contentStored, false);
  assert.equal(state.index.graphStored, false);
  assert.ok(state.index.nodeCount > 0);
  assert.equal(typeof state.baselineIndex.files["src/auth/session.ts"].content, "string");
  assert.equal(state.baselineIndex.contentStored, true);
  assert.ok(state.baselineIndex.storedContentFiles > 0);
  assert.equal(state.baselineIndex.graphStored, false);
  assert.equal(Object.hasOwn(analysis.contextPack, "graph"), false);
  assert.equal(state.requestLedgers.length, 1);
  assert.equal(state.requestLedgers[0].rows[0].key, "input");
  assert.equal(state.requestLedgers[0].rows[0].metric, "actual_context_input");
  assert.equal(state.requestLedgers[0].rows[0].baselineTokens, economy.actualInputTokens);
  assert.equal(state.requestLedgers[0].rows[0].keptTokens, economy.actualInputTokens);
  assert.ok(state.requestLedgers[0].rows.some((row) => row.key === "explore" && row.metric === "actual_context_section"));
  assert.ok(state.requestLedgers[0].rows.some((row) => row.key === "edit" && row.metric === "actual_context_section"));
  assert.ok(state.requestLedgers[0].rows.some((row) => row.key === "output" && row.metric === "pending_output"));
  const totalLedgerRow = state.requestLedgers[0].rows.find((row) => row.key === "total");
  assert.equal(totalLedgerRow.label, "총 토큰");
  assert.equal(totalLedgerRow.metric, "actual_context_total");
  assert.match(totalLedgerRow.baseline, /Codex 입력 후보/);
  assert.match(totalLedgerRow.result, /^총 /);
  assert.equal(Object.hasOwn(totalLedgerRow, "saved"), false);
  assert.equal(Object.hasOwn(totalLedgerRow, "savedTokens"), false);
  const exploreStage = analysis.contextPack.agentContext.processDelta.stages.find((stage) => stage.stage === "explore");
  assert.ok(exploreStage);
  assert.equal(Object.hasOwn(exploreStage, "savedTokens"), false);
  assert.equal(Object.hasOwn(exploreStage, "savedPercent"), false);
  assert.match(exploreStage.candidateReduction, /k$/);
  assert.equal(analysis.contextPack.contextLedger.kind, "scopelease.actual_context_ledger");
  assert.ok(analysis.contextPack.contextLedger.rows.some((row) => row.key === "input" && row.metric === "actual_context_input"));
  assert.equal(analysis.contextPack.artifacts.codexInput.path, ".decision/codex-input.md");
  assert.equal(analysis.contextPack.artifacts.contextLedger.path, ".decision/context-ledger.json");
  assert.ok(analysis.contextPack.changedSymbols.length <= 48);
  assert.equal(typeof analysis.contextPack.changedSymbolsOmitted, "number");
  assert.ok(analysis.contextPack.affected.paths.every((item) => !Object.hasOwn(item, "nodes") && !Object.hasOwn(item, "edges")));
  const codexInputFile = fs.readFileSync(path.join(root, ".decision", "codex-input.md"), "utf8");
  const contextLedgerFile = JSON.parse(fs.readFileSync(path.join(root, ".decision", "context-ledger.json"), "utf8"));
  assert.match(codexInputFile, /User request:/);
  assert.match(codexInputFile, /ScopeLease context:/);
  assert.doesNotMatch(codexInputFile, /"nodes"\s*:/);
  assert.doesNotMatch(codexInputFile, /"edges"\s*:/);
  assert.equal(contextLedgerFile.kind, "scopelease.actual_context_ledger");
  assert.deepEqual(state.approvalLeases, []);
  assert.deepEqual(state.guardEvents, []);
  assert.deepEqual(state.actualWorkEvents, []);
  assert.equal(state.fatigueMetrics.humanPromptsShown, 0);
  assert.deepEqual(analysis.contextPack.agentContext.inputPlan.readOrder.slice(0, 4), ["agentContract", "graphQueryHints", "taskIntent", "decisionGate"]);
  assert.equal(analysis.contextPack.agentContext.taskIntent.kind, "scopelease.semantic_task_intent");
  assert.equal(analysis.contextPack.agentContext.taskIntent.permissionNeed.humanApprovalBeforeApply, true);
  assert.equal(analysis.contextPack.agentContext.agentContract.kind, "scopelease.compact_agent_contract");
  assert.match(analysis.contextPack.agentContext.agentContract.graphScopeHash, /^sha1:/);
  assert.match(analysis.contextPack.agentContext.agentContract.symbolFrontierHash, /^sha1:/);
  assert.ok(analysis.contextPack.agentContext.agentContract.agentMust.some((item) => item.includes("graphQueryHints")));
  assert.equal(analysis.contextPack.agentContext.graphQueryHints.kind, "scopelease.graph_query_first_hints");
  assert.ok(analysis.contextPack.agentContext.graphQueryHints.hints.some((item) => item.id === "symbol-frontier-first"));
  assert.ok(analysis.contextPack.agentContext.readPlan.some((item) => item.path === "src/auth/session.ts"));
  assert.ok(analysis.contextPack.agentContext.symbolProbePlan.some((item) => item.symbol === "validateToken" && item.query.includes("validateToken")));
  assert.ok(analysis.contextPack.agentContext.avoidPlan.some((item) => item.target === "analysis.knowledgeGraph JSON"));
  assert.ok(analysis.contextPack.agentContext.traceLedger.some((item) => item.step === "graph_query_first"));
  assert.ok(analysis.contextPack.agentContext.traceLedger.some((item) => item.step === "probe"));
  assert.ok(analysis.contextPack.agentContext.traceLedger.some((item) => item.step === "symbol_frontier"));
  assert.ok(analysis.contextPack.agentContext.traceLedger.some((item) => item.step === "review_frontier"));
  assert.ok(analysis.contextPack.agentContext.traceLedger.some((item) => item.step === "permission_frontier"));
  assert.ok(analysis.contextPack.agentContext.traceLedger.some((item) => item.step === "output"));
  assert.ok(analysis.contextPack.agentContext.frontiers.symbolFrontier.size > 0);
  assert.ok(analysis.contextPack.agentContext.frontiers.reviewFrontier.size > 0);
  assert.ok(analysis.contextPack.agentContext.frontiers.permissionFrontier.size > 0);
  assert.ok(analysis.contextPack.agentContext.frontiers.stopFrontier.size > 0);
  assert.equal(analysis.contextPack.visualFrontiers.purpose, "visual_boundary_only_not_agent_input");
  assert.ok(analysis.contextPack.visualFrontiers.contextFrontier.nodes.length > 0);
  assert.ok(analysis.contextPack.visualFrontiers.symbolFrontier.nodes.length > 0);
  assert.ok(analysis.contextPack.visualFrontiers.reviewFrontier.nodes.length > 0);
  assert.ok(analysis.contextPack.visualFrontiers.permissionFrontier.nodes.length > 0);
  assert.equal(Object.hasOwn(analysis.contextPack.agentContext.frontiers.permissionFrontier, "nodes"), false);
  assert.match(analysis.contextPack.agentContext.frontierSummary.graphScopeHash, /^sha1:/);
  assert.ok(analysis.contextPack.agentContext.fatiguePlan.askOnce.some((item) => item.includes("한 번")));
  assert.ok(analysis.contextPack.agentContext.fatiguePlan.doNotAsk.some((item) => item.includes("결정 질문")));
  assert.equal(analysis.contextPack.agentContext.fatiguePlan.version, 1);
  assert.equal(analysis.contextPack.agentContext.fatiguePlan.decisionBudget.maxQuestions, 1);
  assert.ok(analysis.contextPack.agentContext.fatiguePlan.decisionBundle.choices.some((item) => item.id === "prepare_only"));
  assert.match(analysis.contextPack.agentContext.fatiguePlan.decisionBundle.agentJudgment.headline, /작업/);
  assert.ok(analysis.contextPack.agentContext.fatiguePlan.decisionBundle.agentJudgment.willDo.length > 0);
  assert.equal(analysis.contextPack.agentContext.fatiguePlan.decisionBundle.decisionAssistance.surface, "interrupt");
  assert.equal(analysis.contextPack.agentContext.fatiguePlan.decisionBundle.decisionAssistance.interruptHuman, true);
  assert.equal(analysis.contextPack.agentContext.fatiguePlan.decisionBundle.decisionAssistance.recommendedChoice, "prepare_only");
  assert.ok(analysis.contextPack.agentContext.fatiguePlan.decisionBundle.decisionAssistance.evaluationSignals.observable.includes("human_choice"));
  assert.ok(analysis.contextPack.agentContext.fatiguePlan.reusableApproval.enabled);
  assert.equal(analysis.contextPack.agentContext.fatiguePlan.autonomyPlan.mode, "autonomous_prepare_then_ask");
  assert.ok(analysis.contextPack.agentContext.fatiguePlan.autonomyPlan.biasControls.includes("evidence_first"));
  assert.ok(analysis.contextPack.agentContext.fatiguePlan.autonomyPlan.biasControls.includes("policy_over_model"));
  assert.ok(analysis.contextPack.agentContext.fatiguePlan.autonomyPlan.biasControls.includes("agent_neutral"));
  assert.equal(analysis.contextPack.agentContext.fatiguePlan.autonomyPlan.codexPermissionBridge.guardBeforeApply, true);
  assert.ok(analysis.contextPack.agentContext.fatiguePlan.autonomyPlan.stepPlan.some((item) => item.id === "verify"));
  assert.ok(analysis.contextPack.agentContext.processDelta.stages.some((item) => item.stage === "explore"));
  assert.equal(analysis.contextPack.agentContext.processDelta.measured, "input payload");
  assert.ok(analysis.contextPack.agentContext.processDelta.stages.some((item) => item.stage === "explore" && item.measurement === "proxy"));
  assert.ok(analysis.contextPack.agentContext.processDelta.stages.some((item) => item.stage === "output" && item.baselineTokens > 0));
  assert.ok(analysis.contextPack.agentContext.processDelta.completion.every((item) => typeof item.ok === "boolean"));
  assert.equal(analysis.contextPack.decisionGate.status, "senior_review_required");
  assert.equal(analysis.contextPack.decisionGate.canAutoApplyPatch, false);
  assert.equal(analysis.contextPack.decisionGate.scopeleaserityLabel, "결정권자");
  assert.equal(analysis.contextPack.decisionGate.automationLabel, "초안 작성만 가능");
  assert.match(analysis.contextPack.decisionGate.scopeleaseritySummary, /에이전트는 초안/);
  assert.match(analysis.contextPack.decisionGate.checkpointRule, /기준점/);
  assert.match(analysis.contextPack.decisionGate.nextAction, /결정권자/);
  assert.equal(analysis.contextPack.agentContext.decisionGate.scopeleaserityLabel, "결정권자");
  assert.equal(analysis.contextPack.userRequest.field, "userRequest.text");
  assert.equal(analysis.contextPack.usefulness.verdict, "recommended");
  assert.match(analysis.contextPack.usefulness.headline, /권한 경계/);
  assert.ok(analysis.contextPack.usefulness.benefits.length > 0);
  const inputPayload = buildAgentInputPayload(analysis.contextPack);
  assert.equal(inputPayload.kind, "scopelease.agent_input");
  assert.equal(inputPayload.field, "codexInput.text");
  assert.equal(inputPayload.role, "user");
  assert.equal(inputPayload.userRequest.field, "userRequest.text");
  assert.equal(inputPayload.codexInput.role, "user");
  assert.deepEqual(inputPayload.codexInput.userRequest, inputPayload.userRequest);
  assert.ok(inputPayload.includedInCodexInput.includes("userRequest.text"));
  assert.ok(inputPayload.excludedFromCodexInput.includes("analysis.knowledgeGraph JSON"));
  assert.match(inputPayload.codexInput.text, /User request:/);
  assert.match(inputPayload.codexInput.text, /ScopeLease context:/);
  assert.ok(inputPayload.codexInput.promptContext);
  assert.equal(inputPayload.codexInput.promptContext.agentContract.kind, "scopelease.compact_agent_contract");
  assert.equal(inputPayload.codexInput.promptContext.graphQueryHints.kind, "scopelease.graph_query_first_hints");
  assert.ok(inputPayload.codexInput.promptContext.readPlan.some((item) => item.path === "src/auth/session.ts"));
  assert.ok(inputPayload.codexInput.promptContext.symbolProbePlan.some((item) => item.symbol === "validateToken"));
  assert.ok(inputPayload.codexInput.promptContext.avoidPlan.some((item) => item.target === "analysis.knowledgeGraph JSON"));
  assert.ok(inputPayload.codexInput.promptContext.traceLedger.some((item) => item.step === "output"));
  assert.equal(inputPayload.codexInput.promptContext.frontiers.graphScopeHash, analysis.contextPack.agentContext.frontierSummary.graphScopeHash);
  assert.equal(inputPayload.codexInput.promptContext.frontiers.symbolNodes, analysis.contextPack.agentContext.frontierSummary.symbolNodes);
  assert.ok(inputPayload.outputTrace.mustReference.includes("frontiers.symbolFrontier"));
  assert.ok(inputPayload.outputTrace.mustReference.includes("frontiers.reviewFrontier"));
  assert.ok(inputPayload.outputTrace.mustReference.includes("frontiers.permissionFrontier"));
  assert.ok(inputPayload.codexInput.promptContext.fatiguePlan.agentShouldDo.length > 0);
  assert.ok(inputPayload.codexInput.promptContext.fatiguePlan.decisionBundle.agentJudgment.approvalEffect.includes("위험 신호"));
  assert.equal(inputPayload.codexInput.promptContext.fatiguePlan.decisionBundle.decisionAssistance.userDecisionKind, "risk_exception");
  assert.equal(inputPayload.codexInput.promptContext.taskIntent.permissionNeed.humanApprovalBeforeApply, true);
  assert.ok(inputPayload.codexInput.promptContext.fatiguePlan.autonomyPlan.biasControls.includes("verify_claims"));
  assert.ok(inputPayload.codexInput.promptContext.fatiguePlan.autonomyPlan.biasControls.includes("mark_uncertain"));
  assert.equal(inputPayload.codexInput.promptContext.fatiguePlan.autonomyPlan.codexPermissionBridge.approveOnceForScope, true);
  assert.ok(inputPayload.codexInput.promptContext.fatiguePlan.autonomyPlan.stepPlan.some((item) => item.id === "patch"));
  assert.ok(inputPayload.codexInput.promptContext.processDelta.stages.some((item) => item.stage === "total_tokens" && item.label === "총 토큰"));
  assert.ok(inputPayload.contextLedger.rows.some((row) => row.key === "total" && row.metric === "actual_context_total"));
  assert.equal(inputPayload.artifacts.codexInput.path, ".decision/codex-input.md");
  assert.equal(inputPayload.artifacts.contextLedger.path, ".decision/context-ledger.json");
  assert.ok(inputPayload.codexInput.promptContext.contextDelta.codexInput.endsWith("k"));
  assert.match(inputPayload.codexInput.promptContext.contextDelta.baselineKind, /default-codex/);
  assert.match(inputPayload.codexInput.promptContext.contextDelta.userText, /k$/);
  assert.match(inputPayload.codexInput.promptContext.processDelta.stages.find((item) => item.stage === "input").basis, /default-codex 입력 n/);
  assert.ok(inputPayload.outputTrace.mustReference.includes("readPlan"));
  assert.ok(inputPayload.fatiguePlan.doNotAsk.length > 0);
  assert.ok(inputPayload.processDelta.decisionQuestions.kept >= 1);
  assert.equal(inputPayload.structuredContext.field, "contextPack.agentContext");
  assert.deepEqual(inputPayload.input, analysis.contextPack.agentContext);
  assert.equal(inputPayload.tokenEconomy.labels.agentInput, economy.labels.agentInput);
  assert.equal(inputPayload.tokenEconomy.labels.actualInput, economy.labels.actualInput);
  assert.equal(inputPayload.tokenEconomy.labels.repoScopeExcluded, economy.labels.repoScopeExcluded);
  assert.equal(Object.hasOwn(inputPayload.tokenEconomy, "savedTokens"), false);
  assert.equal(Object.hasOwn(inputPayload.tokenEconomy, "actualSavedTokens"), false);
  assert.equal(inputPayload.tokenEconomy.exactTokens, economy.exactTokens);
  assert.deepEqual(inputPayload.tokenEconomy.tokenizer, economy.tokenizer);
  assert.match(inputPayload.codexInput.summary, inputPayload.codexInput.tokenizer?.exact ? /직접 계측/ : /fallback/);

  const readVerdict = evaluateAgentAction({
    action: { kind: "read", path: "src/auth/session.ts" },
    analysis,
    state
  });
  assert.equal(readVerdict.verdict, "allow_with_log");
  assert.equal(readVerdict.shouldAskHuman, false);

  const outsideReadVerdict = evaluateAgentAction({
    action: { kind: "read", path: "/etc/passwd" },
    analysis,
    state
  });
  assert.equal(outsideReadVerdict.verdict, "deny");
  assert.match(outsideReadVerdict.reason, /outside repo-relative scope/);

  const editVerdict = evaluateAgentAction({
    action: { kind: "edit", paths: ["src/auth/session.ts"] },
    analysis,
    state
  });
  assert.equal(editVerdict.verdict, "ask_once");
  assert.equal(editVerdict.shouldAskHuman, true);
  assert.ok(editVerdict.decisionBundle.choices.some((item) => item.id === "prepare_only"));
  assert.match(editVerdict.decisionBundle.agentJudgment.headline, /패치/);
  assert.ok(editVerdict.decisionBundle.agentJudgment.willNotDo.some((item) => item.includes("network")));
  assert.equal(editVerdict.decisionBundle.decisionAssistance.interruptHuman, true);
  assert.equal(editVerdict.decisionBundle.agentJudgment.interruptHuman, true);

  const guardRecord = recordGuardDecision(root, {
    verdict: editVerdict,
    action: { kind: "edit", paths: ["src/auth/session.ts"] },
    request: analysis.userRequest,
    source: "test:guard_judgment"
  });
  assert.equal(guardRecord.event.agentJudgment.headline, editVerdict.decisionBundle.agentJudgment.headline);
  assert.equal(guardRecord.event.agentJudgment.action.grant, "apply_patch");
  assert.deepEqual(guardRecord.event.agentJudgment.action.paths, ["src/auth/session.ts"]);
  assert.equal(guardRecord.event.decisionAssistance.recommendedChoice, "prepare_only");
  assert.equal(guardRecord.event.agentJudgment.decisionAssistance.evaluationSignals.humanTarget, "risk_detection_and_override");
  assert.equal(guardRecord.state.guardEvents[0].agentJudgment.headline, editVerdict.decisionBundle.agentJudgment.headline);

  const proposeVerdict = evaluateAgentAction({
    action: { type: "propose_patch", files: ["src/auth/session.ts"] },
    analysis,
    state
  });
  assert.equal(proposeVerdict.actionGrant, "propose_patch");
  assert.equal(proposeVerdict.verdict, "prepare_only");

  const lease = approveDecisionBundle({
    analysis,
    state,
    decisionBundle: editVerdict.decisionBundle,
    choiceId: "prepare_only"
  });
  assert.equal(lease.signatureVersion, 1);
  assert.equal(lease.signatureAlgorithm, "hmac-sha256");
  assert.match(lease.signatureKeyId, /^repo_[0-9a-f]+$/);
  assert.match(lease.signature, /^[0-9a-f]{64}$/);
  assert.match(lease.baselineGraphHash, /^sha1:/);
  assert.match(lease.graphScopeHash, /^sha1:/);
  assert.match(lease.permissionFrontierHash, /^sha1:/);
  assert.ok(lease.allowedGraphNodes.includes("file:src/auth/session.ts"));
  const leaseKeyPath = path.join(process.env.SCOPELEASE_LEASE_KEY_DIR, `${lease.signatureKeyId}.key`);
  assert.ok(fs.existsSync(leaseKeyPath));
  assert.ok(path.relative(root, leaseKeyPath).startsWith(".."));
  assert.equal(validateLease({
    lease,
    action: { kind: "edit", paths: ["src/auth/session.ts"], apply: false },
    analysis,
    state
  }).valid, true);
  const leasedVerdict = evaluateAgentAction({
    action: { kind: "edit", paths: ["src/auth/session.ts"], apply: false },
    analysis,
    state: { ...state, approvalLeases: [lease] }
  });
  assert.equal(leasedVerdict.verdict, "allow_with_log");
  assert.equal(leasedVerdict.leaseId, lease.id);
  assert.equal(leasedVerdict.graphScopeHash, lease.graphScopeHash);
  assert.equal(leasedVerdict.permissionFrontierHash, lease.permissionFrontierHash);

  const scopedLease = approveDecisionBundle({
    analysis,
    state,
    decisionBundle: editVerdict.decisionBundle,
    choiceId: "allow_scoped_patch"
  });
  assert.throws(
    () => approveDecisionBundle({
      analysis,
      state,
      decisionBundle: editVerdict.decisionBundle,
      choiceId: "missing_choice"
    }),
    /Unknown approval choice: missing_choice/
  );
  assert.throws(
    () => approveDecisionBundle({
      analysis,
      state,
      decisionBundle: editVerdict.decisionBundle,
      choiceId: "deny"
    }),
    /Approval choice does not grant reusable scopeleaserity: deny/
  );
  assert.ok(scopedLease.approvedChangedFiles.includes("src/auth/session.ts"));
  assert.match(scopedLease.signature, /^[0-9a-f]{64}$/);
  const patchAliasVerdict = evaluateAgentAction({
    action: { type: "patch", files: ["src/auth/session.ts"] },
    analysis,
    state: { ...state, approvalLeases: [scopedLease] }
  });
  assert.equal(patchAliasVerdict.actionGrant, "apply_patch");
  assert.equal(patchAliasVerdict.verdict, "allow_with_log");
  assert.deepEqual(patchAliasVerdict.action.paths, ["src/auth/session.ts"]);

  const traversalPatchVerdict = evaluateAgentAction({
    action: { type: "patch", files: ["src/auth/../other.ts"] },
    analysis,
    state: { ...state, approvalLeases: [scopedLease] }
  });
  assert.equal(traversalPatchVerdict.verdict, "ask_once");

  const changedWithinLeaseAnalysis = {
    ...analysis,
    changes: {
      ...analysis.changes,
      fileHashes: {
        ...(analysis.changes.fileHashes || {}),
        "src/auth/session.ts": "changed-again-inside-scope"
      }
    }
  };
  const reusedScopedVerdict = evaluateAgentAction({
    action: { type: "patch", files: ["src/auth/session.ts"] },
    analysis: changedWithinLeaseAnalysis,
    state: { ...state, approvalLeases: [scopedLease] }
  });
  assert.equal(reusedScopedVerdict.verdict, "allow_with_log");

  const changedOutsideLeaseAnalysis = {
    ...analysis,
    changes: {
      ...analysis.changes,
      files: [...(analysis.changes.files || []), "src/other.ts"],
      fileHashes: {
        ...(analysis.changes.fileHashes || {}),
        "src/other.ts": "changed-outside-scope"
      }
    }
  };
  const outsideChangeVerdict = evaluateAgentAction({
    action: { type: "patch", files: ["src/auth/session.ts"] },
    analysis: changedOutsideLeaseAnalysis,
    state: { ...state, approvalLeases: [scopedLease] }
  });
  assert.equal(outsideChangeVerdict.verdict, "ask_once");
  const outsideChangeRunTestsVerdict = evaluateAgentAction({
    action: { kind: "bash", command: "npm test" },
    analysis: changedOutsideLeaseAnalysis,
    state: { ...state, approvalLeases: [scopedLease] }
  });
  assert.equal(outsideChangeRunTestsVerdict.verdict, "allow_with_log");

  const tamperedScopedLease = { ...scopedLease };
  delete tamperedScopedLease.approvedChangedFiles;
  const tamperedValidation = validateLease({
    lease: tamperedScopedLease,
    action: { type: "patch", files: ["src/auth/session.ts"] },
    analysis,
    state
  });
  assert.equal(tamperedValidation.valid, false);
  assert.match(tamperedValidation.reason, /signature/);
  const tamperedLeaseVerdict = evaluateAgentAction({
    action: { type: "patch", files: ["src/auth/session.ts"] },
    analysis: changedOutsideLeaseAnalysis,
    state: { ...state, approvalLeases: [tamperedScopedLease] }
  });
  assert.equal(tamperedLeaseVerdict.verdict, "ask_once");

  const unsignedScopedLease = { ...scopedLease };
  delete unsignedScopedLease.signature;
  const unsignedValidation = validateLease({
    lease: unsignedScopedLease,
    action: { type: "patch", files: ["src/auth/session.ts"] },
    analysis,
    state
  });
  assert.equal(unsignedValidation.valid, false);
  assert.match(unsignedValidation.reason, /signature/);

  const lowRiskLease = approveDecisionBundle({
    analysis,
    state,
    decisionBundle: editVerdict.decisionBundle,
    choiceId: "allow_low_risk_subset"
  });
  const lowRiskDocVerdict = evaluateAgentAction({
    action: { type: "patch", files: ["docs/auth.md"] },
    analysis,
    state: { ...state, approvalLeases: [lowRiskLease] }
  });
  assert.equal(lowRiskDocVerdict.verdict, "allow_with_log");
  const lowRiskTraversalVerdict = evaluateAgentAction({
    action: { type: "patch", files: ["docs/../src/auth/session.ts"] },
    analysis,
    state: { ...state, approvalLeases: [lowRiskLease] }
  });
  assert.equal(lowRiskTraversalVerdict.verdict, "ask_once");
  const lowRiskAuthVerdict = evaluateAgentAction({
    action: { type: "patch", files: ["src/auth/session.ts"] },
    analysis,
    state: { ...state, approvalLeases: [lowRiskLease] }
  });
  assert.equal(lowRiskAuthVerdict.verdict, "ask_once");
  assert.match(lowRiskAuthVerdict.reason, /requires a new approval lease/);
  const stoppedVerdict = evaluateAgentAction({
    action: { type: "patch", files: ["docs/auth.md"] },
    analysis,
    state: {
      ...state,
      approvalLeases: [lowRiskLease],
      stopEvents: [{ stopCondition: "new_high_risk_policy_hit" }]
    }
  });
  assert.equal(stoppedVerdict.verdict, "ask_once");

  const networkVerdict = evaluateAgentAction({
    action: { kind: "network", target: "https://example.com" },
    analysis,
    state
  });
  assert.equal(networkVerdict.verdict, "deny");

  const internalNetworkAnalysis = {
    ...analysis,
    userRequest: `${analysis.userRequest} Use the task-local API at http://api:8000/docs/json when needed.`,
    contextPack: {
      ...(analysis.contextPack || {}),
      userRequest: {
        ...((analysis.contextPack || {}).userRequest || {}),
        text: `${analysis.userRequest} Use the task-local API at http://api:8000/docs/json when needed.`
      }
    }
  };
  assert.deepEqual(taskScopedNetworkScopes(internalNetworkAnalysis), ["http://api:8000"]);
  assert.equal(networkWithinScope({ kind: "network", target: "http://api:8000/docs/json" }, ["http://api:8000"]), true);
  assert.equal(networkWithinScope({ kind: "network", target: "https://example.com/docs/json" }, ["http://api:8000"]), false);
  assert.equal(isHardDenyAction({ kind: "network", target: "http://api:8000/docs/json" }, { networkScopes: ["http://api:8000"] }), false);
  assert.equal(isHardDenyAction({ kind: "network", target: "https://example.com/docs/json" }, { networkScopes: ["http://api:8000"] }), true);
  assert.equal(actionGrant({ kind: "bash", command: "curl http://api:8000/docs/json" }), "network");
  const internalNetworkVerdict = evaluateAgentAction({
    action: { kind: "network", target: "http://api:8000/docs/json" },
    analysis: internalNetworkAnalysis,
    state
  });
  assert.equal(internalNetworkVerdict.verdict, "ask_once");
  assert.equal(internalNetworkVerdict.actionGrant, "network");
  assert.equal(internalNetworkVerdict.decisionBundle.decisionAssistance.recommendedChoice, "allow_task_scoped_network");
  assert.ok(internalNetworkVerdict.decisionBundle.choices.some((item) => item.id === "allow_task_scoped_network"));
  const internalNetworkLease = approveDecisionBundle({
    analysis: internalNetworkAnalysis,
    state,
    decisionBundle: internalNetworkVerdict.decisionBundle,
    choiceId: "allow_task_scoped_network"
  });
  assert.deepEqual(internalNetworkLease.networkScopes, ["http://api:8000"]);
  assert.equal(validateLease({
    lease: internalNetworkLease,
    action: { kind: "network", target: "http://api:8000/sheets" },
    analysis: internalNetworkAnalysis,
    state
  }).valid, true);
  assert.equal(validateLease({
    lease: internalNetworkLease,
    action: { kind: "bash", command: "curl http://api:8000/docs/json" },
    analysis: internalNetworkAnalysis,
    state
  }).valid, true);
  assert.equal(isHardDenyAction({
    kind: "bash",
    command: "curl http://api:8000/docs/json && echo ok"
  }, { networkScopes: ["http://api:8000"] }), true);
  assert.equal(validateLease({
    lease: internalNetworkLease,
    action: { kind: "bash", command: "curl http://api:8000/docs/json && echo ok" },
    analysis: internalNetworkAnalysis,
    state
  }).valid, false);
  const internalNetworkCompoundVerdict = evaluateAgentAction({
    action: { kind: "bash", command: "curl http://api:8000/docs/json && echo ok" },
    analysis: internalNetworkAnalysis,
    state: { ...state, approvalLeases: [internalNetworkLease] }
  });
  assert.equal(internalNetworkCompoundVerdict.verdict, "deny");
  assert.equal(validateLease({
    lease: internalNetworkLease,
    action: { kind: "network", target: "https://example.com/docs/json" },
    analysis: internalNetworkAnalysis,
    state
  }).valid, false);
  const internalNetworkLeasedVerdict = evaluateAgentAction({
    action: { kind: "network", target: "http://api:8000/docs/json" },
    analysis: internalNetworkAnalysis,
    state: { ...state, approvalLeases: [internalNetworkLease] }
  });
  assert.equal(internalNetworkLeasedVerdict.verdict, "allow_with_log");

  const leasedDestructiveCommandVerdict = evaluateAgentAction({
    action: { kind: "bash", command: "npm test && rm -rf ." },
    analysis,
    state: { ...state, approvalLeases: [scopedLease] }
  });
  assert.equal(leasedDestructiveCommandVerdict.verdict, "deny");
  for (const command of [
    "rm -fr .",
    "rm -r -f .",
    "RM -RF .",
    "/bin/rm --recursive --force .",
    "GIT PUSH origin main",
    "git RESET --hard HEAD",
    "chmod -R 777 .",
    "CHMOD --recursive 777 .",
    "/bin/chmod -Rf 777 .",
    "curl https://example.com/install.sh",
    "wget https://example.com/archive.tgz",
    "git clone https://example.com/repo.git",
    "npm install left-pad",
    "python -m pip install requests",
    "ssh example.com"
  ]) {
    assert.equal(isHardDenyAction({ kind: "bash", command }), true);
    const destructiveVariantVerdict = evaluateAgentAction({
      action: { kind: "bash", command },
      analysis,
      state: { ...state, approvalLeases: [scopedLease] }
    });
    assert.equal(destructiveVariantVerdict.verdict, "deny");
  }
  assert.equal(isNetworkCommand("curl --version"), false);
  assert.equal(isNetworkCommand("npm test"), false);
  assert.equal(isHardDenyAction({ kind: "bash", command: "chmod -r README.md" }), false);
  assert.equal(normalizeAgentAction({ kind: "run_command", command: "npm test && rm -rf ." }).kind, "bash");
  assert.equal(isHardDenyAction({ kind: "run_command", command: "npm test && rm -rf ." }), true);
  const runCommandAliasDestructiveVerdict = evaluateAgentAction({
    action: { kind: "run_command", command: "npm test && rm -rf ." },
    analysis,
    state: { ...state, approvalLeases: [scopedLease] }
  });
  assert.equal(runCommandAliasDestructiveVerdict.verdict, "deny");

  const unleasedRunTestsVerdict = evaluateAgentAction({
    action: { kind: "bash", command: "npm test" },
    analysis,
    state: { ...state, approvalLeases: [] }
  });
  assert.equal(unleasedRunTestsVerdict.actionGrant, "run_tests");
  assert.equal(unleasedRunTestsVerdict.verdict, "allow_with_log");

  const runTestsAliasVerdict = evaluateAgentAction({
    action: { kind: "run_tests", command: "npm test" },
    analysis,
    state: { ...state, approvalLeases: [scopedLease] }
  });
  assert.equal(runTestsAliasVerdict.actionGrant, "run_tests");
  assert.equal(runTestsAliasVerdict.verdict, "allow_with_log");

  const leasedShellControlVerdict = evaluateAgentAction({
    action: { kind: "bash", command: "npm test && echo ok" },
    analysis,
    state: { ...state, approvalLeases: [scopedLease] }
  });
  assert.equal(leasedShellControlVerdict.actionGrant, "run_command");
  assert.equal(leasedShellControlVerdict.verdict, "ask_once");
  const runTestsAliasShellControlVerdict = evaluateAgentAction({
    action: { kind: "run_tests", command: "npm test && echo ok" },
    analysis,
    state: { ...state, approvalLeases: [scopedLease] }
  });
  assert.equal(runTestsAliasShellControlVerdict.actionGrant, "run_command");
  assert.equal(runTestsAliasShellControlVerdict.verdict, "ask_once");
  assert.equal(hasUnsafeShellControl("npm test & echo ok"), true);
  assert.equal(hasUnsafeShellControl("npm test\necho ok"), true);
  assert.equal(hasUnsafeShellControl("rg -n \"validateToken|buildIndex\" test/analyzer.test.js"), false);
  assert.equal(hasUnsafeShellControl("nl -ba src/core/action-policy.js | sed -n '1,20p'"), true);
  assert.equal(hasUnsafeShellControl("nl -ba src/core/action-policy.js | sed -n '1,20p'", { allowPipes: true }), false);
  assert.equal(isSafeTestCommand("npm test -- --grep auth"), true);
  assert.equal(isSafeTestCommand("node --test test/analyzer.test.js"), true);
  for (const command of [
    "npm run desktop:check",
    "npm run paper:report",
    "npm run paper:report:controlled",
    "npm run paper:report:controlled:fixtures",
    "npm run paper:report:controlled:delegation",
    "npm run paper:report:full",
    "npm run paper:report:full:fixtures",
    "npm run paper:report:full:delegation",
    "npm run paper:tbench:scopelease-panel",
    "npm run paper:tbench:scopelease-panel:dry-run",
    "npm run paper:tbench:stop-scopelease-panel",
    "npm run paper:live-pilot",
    "npm run paper:live-pilot:dry-run",
    "npm run paper:formal:discover-repos",
    "npm run paper:formal:stop-local-main",
    "npm run paper:formal:local-main",
    "npm run paper:formal:local-main:dry-run",
    "npm run paper:formal:fresh:dry-run",
    "npm run paper:human-study",
    "npm run paper:permission-fixtures",
    "npm run paper:review-bench",
    "npm run paper:source-truth-check"
  ]) {
    assert.equal(isSafeTestCommand(command), true);
    assert.equal(actionGrant({ kind: "bash", command }), "run_tests");
  }

  for (const command of [
    "pwd",
    "pwd -P",
    "ls -la .codex",
    "rg -n validateToken src test",
    "rg -n \"hasUnsafeShellControl|isSafeLocalReadCommand\" test src/core",
    "cat package.json",
    "git status --short",
    "git diff -- src/core/enforcer.js",
    "git log --oneline -1",
    "git show HEAD:package.json",
    "sed -n '1,20p' README.md",
    "nl -ba src/core/action-policy.js | sed -n '1,20p'",
    "grep validateToken test/analyzer.test.js | head -n 1"
  ]) {
    assert.equal(isSafeLocalReadCommand(command), true, command);
    assert.equal(actionGrant({ kind: "bash", command }), "read", command);
    const readVerdict = evaluateAgentAction({
      action: { kind: "bash", command },
      analysis,
      state: { ...state, approvalLeases: [scopedLease] }
    });
    assert.equal(readVerdict.verdict, "allow_with_log", command);
  }

  const codexAttachmentPath = path.join(os.homedir(), ".codex", "attachments", "00000000-0000-4000-8000-000000000000", "pasted-text.txt");
  for (const command of [
    "cat " + JSON.stringify(codexAttachmentPath),
    "sed -n '1,20p' " + JSON.stringify(codexAttachmentPath)
  ]) {
    assert.equal(isSafeLocalReadCommand(command), true);
    assert.equal(actionGrant({ kind: "bash", command }), "read");
  }

  for (const command of [
    "pwd && rm -rf .",
    "ls /tmp",
    "rg pattern ../outside",
    "sed -i 's/a/b/' README.md",
    "sed -n '1,20p' /tmp/outside.txt",
    "nl -ba /tmp/outside.txt | sed -n '1,5p'",
    "cat package.json | sh",
    "cat package.json | sed -i 's/a/b/'",
    "git diff --output=patch.txt",
    "git status; rm -rf ."
  ]) {
    assert.equal(isSafeLocalReadCommand(command), false, command);
    assert.equal(actionGrant({ kind: "bash", command }), "run_command", command);
  }

  for (const command of [
    "npm test ../outside",
    "npm test -- ../../outside",
    "npm test /tmp/file",
    "npm test ~/file",
    "npm test -- --grep=../outside",
    "npm test -- --grep=\"../outside\"",
    "npm test -- --grep='../outside'",
    "npm test -- --grep=\"/tmp/file\"",
    "node --test \"../outside.test.js\"",
    "npm test & echo ok"
  ]) {
    assert.equal(isSafeTestCommand(command), false);
    assert.equal(actionGrant({ kind: "bash", command }), "run_command");
    if (!hasUnsafeShellControl(command)) assert.equal(hasUnsafeCommandPathEscape(command), true);
    const escapedCommandVerdict = evaluateAgentAction({
      action: { kind: "bash", command },
      analysis,
      state: { ...state, approvalLeases: [scopedLease] }
    });
    assert.equal(escapedCommandVerdict.verdict, "ask_once");
  }

  const runCommandBundle = {
    ...editVerdict.decisionBundle,
    id: "db_custom_run_command_scope",
    defaultVerdict: "allow_run_command",
    choices: [{ id: "allow_run_command", grants: ["run_command"], blocks: [] }],
    scope: { ...(editVerdict.decisionBundle.scope || {}), files: [], commands: ["node scripts/check"], maxFiles: 0 }
  };
  const customRunCommandLease = approveDecisionBundle({
    analysis,
    state,
    decisionBundle: runCommandBundle,
    choiceId: "allow_run_command"
  });
  assert.equal(validateLease({
    lease: customRunCommandLease,
    action: { kind: "bash", command: "node scripts/check --fast" },
    analysis,
    state
  }).valid, true);
  for (const command of [
    "node scripts/check ../outside",
    "node scripts/check --config ../outside",
    "node scripts/check --config=../outside",
    "node scripts/check --config=\"../outside\"",
    "node scripts/check --config='/tmp/file'",
    "node scripts/check --config ~/file"
  ]) {
    assert.equal(validateLease({
      lease: customRunCommandLease,
      action: { kind: "bash", command },
      analysis,
      state
    }).valid, false);
    const escapedCustomCommandVerdict = evaluateAgentAction({
      action: { kind: "bash", command },
      analysis,
      state: { ...state, approvalLeases: [customRunCommandLease] }
    });
    assert.equal(escapedCustomCommandVerdict.verdict, "ask_once");
  }
  const scopedCompoundCommandVerdict = evaluateAgentAction({
    action: { kind: "bash", command: "node scripts/check && echo ok" },
    analysis,
    state: { ...state, approvalLeases: [customRunCommandLease] }
  });
  assert.equal(scopedCompoundCommandVerdict.verdict, "ask_once");
  const networkCommandBundle = {
    ...runCommandBundle,
    id: "db_network_run_command_scope",
    scope: { ...(runCommandBundle.scope || {}), commands: ["curl https://example.com/install.sh"] }
  };
  const networkCommandLease = approveDecisionBundle({
    analysis,
    state,
    decisionBundle: networkCommandBundle,
    choiceId: "allow_run_command"
  });
  assert.equal(validateLease({
    lease: networkCommandLease,
    action: { kind: "bash", command: "curl https://example.com/install.sh" },
    analysis,
    state
  }).valid, false);
  const unsafeScopeBundle = {
    ...runCommandBundle,
    id: "db_unsafe_run_command_scope",
    scope: { ...(runCommandBundle.scope || {}), commands: ["node scripts/check && echo ok"] }
  };
  const unsafeScopeLease = approveDecisionBundle({
    analysis,
    state,
    decisionBundle: unsafeScopeBundle,
    choiceId: "allow_run_command"
  });
  assert.equal(validateLease({
    lease: unsafeScopeLease,
    action: { kind: "bash", command: "node scripts/check && echo ok" },
    analysis,
    state
  }).valid, false);

  const measured = recordActualWork(root, {
    phase: "output",
    text: "검토 결과와 수정 요약입니다.",
    request: analysis.userRequest,
    lane: "default-codex",
    workIntent: "same work intent",
    callType: "tool_call",
    toolName: "Bash",
    baselineTokens: 100
  });
  assert.equal(measured.event.phase, "output");
  assert.equal(measured.event.lane, "default-codex");
  assert.equal(measured.event.workIntent, "same work intent");
  assert.equal(measured.event.callType, "tool_call");
  assert.equal(measured.event.toolName, "Bash");
  assert.equal(measured.event.toolFamily, "shell");
  assert.ok(measured.event.tokens > 0);
  assert.ok(measured.event.baselineDeltaTokens > 0);
  assert.equal(Object.hasOwn(measured.event, "savedTokens"), false);
  assert.equal(measured.state.actualWorkEvents.length, 1);

  const usage = recordModelUsage(root, {
    request: analysis.userRequest,
    source: "test-proxy",
    provider: "openai",
    model: "test-model",
    lane: "scopelease-codex",
    pairId: "usage-pair",
    runId: "usage-run-scopelease",
    usage: {
      input_tokens: 1000,
      output_tokens: 250,
      output_tokens_details: { reasoning_tokens: 50 },
      total_tokens: 1250
    }
  });
  assert.equal(usage.event.totalTokens, 1250);
  assert.equal(usage.event.totalMeasured, true);
  assert.equal(usage.event.lane, "scopelease-codex");
  assert.equal(usage.event.pairId, "usage-pair");
  assert.equal(usage.event.runId, "usage-run-scopelease");
  assert.equal(usage.state.modelUsageEvents.length, 1);

  const customInput = buildAgentInputPayload(analysis.contextPack, { userRequest: "지금 내가 친 요청만 원문 input으로 표시해줘." });
  assert.equal(customInput.userRequest.text, "지금 내가 친 요청만 원문 input으로 표시해줘.");
  assert.match(customInput.codexInput.text, /지금 내가 친 요청만 원문 input/);
  assert.match(customInput.codexInput.text, /excluded: full files/);
});

test("checkpoint action is not auto-allowed by patch decision gate", () => {
  const verdict = evaluateAgentAction({
    action: { kind: "checkpoint" },
    analysis: {
      risk: "low",
      contextPack: {
        decisionGate: {
          canAutoApplyPatch: true,
          canAutoPreparePatch: true
        }
      }
    },
    state: {}
  });

  assert.equal(verdict.verdict, "ask_once");
  assert.equal(verdict.actionGrant, "checkpoint");
  assert.ok(verdict.decisionBundle);
});

test("adaptive context ignores explicit file paths outside the repository", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-adaptive-scope-"));
  const root = path.join(base, "repo");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "inside.js"), "export const INSIDE_OK = true;\n");
  fs.writeFileSync(path.join(base, "secret.js"), "OUTSIDE_SECRET_SHOULD_NOT_BE_IN_PROMPT\n");

  const outside = buildAdaptiveContext({
    repoPath: root,
    request: "검토할 파일은 src/../../secret.js 입니다.",
    analysis: { risk: "low", contextPack: { decisionGate: {} }, repoStats: { tokenizer: { method: "rough_chars_div_4" } } },
    payload: { codexInput: { text: "SCOPELEASE_CONTEXT" }, readPlan: [] },
    mode: "auto"
  });

  assert.equal(outside.decision.explicitFileCount, 0);
  assert.doesNotMatch(outside.text, /OUTSIDE_SECRET_SHOULD_NOT_BE_IN_PROMPT/);

  const insideAbsolute = buildAdaptiveContext({
    repoPath: root,
    request: `검토할 실제 경로는 ${path.join(root, "src", "inside.js")} 입니다.`,
    analysis: { risk: "low", contextPack: { decisionGate: {} }, repoStats: { tokenizer: { method: "rough_chars_div_4" } } },
    payload: { codexInput: { text: "SCOPELEASE_CONTEXT" }, readPlan: [] },
    mode: "auto"
  });
  assert.equal(insideAbsolute.decision.explicitFileCount, 1);
  assert.deepEqual(insideAbsolute.decision.explicitFiles, ["src/inside.js"]);
});

test("adaptive context uses observe-first for tiny live implementation prompts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-observe-first-"));
  const adaptive = buildAdaptiveContext({
    repoPath: root,
    request: "ScopeLease context 절감과 피로도 계측을 고쳐줘.",
    analysis: {
      risk: "medium",
      contextPack: {
        decisionGate: {
          status: "owner_review_required",
          scopeleaserity: "owner_review",
          canAutoApplyPatch: false,
          requiredApproval: "owner_review",
          nextAction: "담당자 리뷰 후 적용합니다."
        }
      },
      repoStats: { tokenizer: { method: "rough_chars_div_4" } }
    },
    payload: {
      codexInput: { text: "FULL_SCOPELEASE_CONTEXT ".repeat(1000) },
      readPlan: [
        { path: "src/core/adaptive-context.js", reason: "context mode" },
        { path: "src/core/evidence-export.js", reason: "metering" }
      ],
      decisionGate: {
        status: "owner_review_required",
        scopeleaserity: "owner_review",
        canAutoApplyPatch: false,
        requiredApproval: "owner_review",
        nextAction: "담당자 리뷰 후 적용합니다."
      }
    },
    mode: "auto"
  });

  assert.equal(adaptive.mode, "observe_only");
  assert.match(adaptive.decision.reason, /observe-first/);
  assert.equal(adaptive.text.includes("src/core/adaptive-context.js"), false);
});

test("automatic measurement mode off suppresses watch payloads from analysis", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-auto-measure-off-"));
  fs.writeFileSync(path.join(root, "README.md"), "initial\n");
  initRepository(root);
  setMeasurementMode(root, { enabled: false, source: "test" });
  fs.writeFileSync(path.join(root, "README.md"), "changed\n");

  analyzeRepository(root, { userRequest: "측정 off 확인", autoMeasureWork: true });
  const state = loadState(root);

  assert.equal(state.measurementMode.enabled, false);
  assert.deepEqual(state.actualWorkEvents || [], []);
});

test("baseline content keeps deleted files visible to automatic edit metering", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-delete-meter-"));
  fs.writeFileSync(path.join(root, "delete-me.md"), "delete this evidence\n");
  initRepository(root);
  fs.unlinkSync(path.join(root, "delete-me.md"));

  analyzeRepository(root, { userRequest: "삭제 diff 계측", autoMeasureWork: true });
  const state = loadState(root);
  const editEvent = (state.actualWorkEvents || []).find((event) => event.source === "watch:auto-edit");

  assert.ok(editEvent);
  assert.equal(editEvent.phase, "edit");
  assert.ok(editEvent.tokens > 0);
  assert.match(editEvent.path, /delete-me\.md/);
});

test("baseline content avoids storing untyped secret-like files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-secret-baseline-"));
  fs.writeFileSync(path.join(root, ".env"), "SCOPELEASE_SECRET=do-not-store\n");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "credentials.json"), "{\"token\":\"do-not-store\"}\n");
  fs.writeFileSync(path.join(root, "service-account.private-key.pem"), "do-not-store\n");
  fs.writeFileSync(path.join(root, "README.md"), "safe docs\n");
  initRepository(root);
  const state = loadState(root);

  assert.equal(state.baselineIndex.files[".env"].contentStored, false);
  assert.equal(Object.hasOwn(state.baselineIndex.files[".env"], "content"), false);
  assert.equal(state.baselineIndex.files["config/credentials.json"].contentStored, false);
  assert.equal(Object.hasOwn(state.baselineIndex.files["config/credentials.json"], "content"), false);
  assert.equal(state.baselineIndex.files["service-account.private-key.pem"].contentStored, false);
  assert.equal(Object.hasOwn(state.baselineIndex.files["service-account.private-key.pem"], "content"), false);
  assert.equal(state.baselineIndex.files["README.md"].contentStored, true);
});

test("repository index skips oversized text files without loading them into context", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-large-file-"));
  fs.writeFileSync(path.join(root, "README.md"), "# Large fixture\n");
  fs.writeFileSync(path.join(root, "large.log"), "x".repeat(600 * 1024));
  initRepository(root);
  analyzeRepository(root, { userRequest: "Inspect repository without loading large logs." });
  const state = loadState(root);

  assert.equal(Object.hasOwn(state.index.files, "large.log"), false);
  assert.equal(Object.hasOwn(state.index.files, "README.md"), true);
});

test("external graph backend payload flows through analysis, CLI, and lease scope", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-external-graph-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/app.js"), `
export function run() {
  return "baseline";
}
`);
  initRepository(root);
  fs.writeFileSync(path.join(root, "src/app.js"), `
export function run() {
  return "changed";
}
`);

  const graphPayload = {
    backend: "codegraph-fixture",
    nodes: [
      { id: "file:src/app.js", type: "file", path: "src/app.js" },
      { id: "symbol:src/app.js:function:run", type: "function", properties: { path: "src/app.js", name: "run" } }
    ],
    edges: [
      { source: "file:src/app.js", target: "symbol:src/app.js:function:run", type: "defines" }
    ]
  };
  const analysis = analyzeRepository(root, {
    userRequest: "external graph backend should define frontiers",
    graphBackendPayload: graphPayload,
    graphBackendName: "codegraph-fixture"
  });

  assert.equal(analysis.contextPack.agentContext.frontierSummary.backend, "codegraph-fixture");
  assert.equal(analysis.contextPack.agentContext.frontiers.graphScope.backend, "codegraph-fixture");
  assert.ok(analysis.contextPack.agentContext.frontiers.permissionFrontier.size > 0);

  const verdict = evaluateAgentAction({
    action: { kind: "edit", paths: ["src/app.js"] },
    analysis,
    state: loadState(root) || {}
  });
  assert.equal(verdict.verdict, "ask_once");
  const lease = approveDecisionBundle({
    analysis,
    state: loadState(root) || {},
    decisionBundle: verdict.decisionBundle,
    choiceId: "allow_scoped_patch"
  });
  assert.equal(lease.graphBackend, "codegraph-fixture");
  assert.ok(lease.allowedGraphNodes.includes("file:src/app.js"));

  const changedBackendAnalysis = analyzeRepository(root, {
    userRequest: "external graph backend should define frontiers",
    graphBackendPayload: {
      ...graphPayload,
      nodes: [
        ...graphPayload.nodes,
        { id: "file:src/extra.js", type: "file", path: "src/extra.js" }
      ]
    },
    graphBackendName: "codegraph-fixture-v2"
  });
  assert.notEqual(changedBackendAnalysis.contextPack.agentContext.frontiers.graphScope.hash, lease.graphScopeHash);
  const changedBackendValidation = validateLease({
    lease,
    action: { kind: "edit", paths: ["src/app.js"] },
    analysis: changedBackendAnalysis,
    state: loadState(root) || {}
  });
  assert.equal(changedBackendValidation.valid, false);
  assert.match(changedBackendValidation.reason, /baseline graph|graph scope/);

  const graphPath = path.join(os.tmpdir(), `scopelease-codegraph-fixture-${Date.now()}.json`);
  fs.writeFileSync(graphPath, JSON.stringify(graphPayload));
  const output = execFileSync(process.execPath, [
    path.resolve("src/cli.js"),
    "context",
    root,
    "--request",
    "external graph backend should define frontiers",
    "--graph-backend-file",
    graphPath,
    "--graph-backend",
    "codegraph-cli-fixture"
  ], { encoding: "utf8" });
  const cliContext = JSON.parse(output);
  assert.equal(cliContext.agentContext.frontierSummary.backend, "codegraph-cli-fixture");
});

test("agent-visible request event helper excludes ScopeLease internal watcher payloads", () => {
  const request = "same request for visible usage";
  const workIntent = deriveWorkIntent({ request });
  const state = {
    actualWorkEvents: [
      { lane: "default-codex", phase: "input", userRequest: request, workIntent, tokens: 100 },
      { lane: "scopelease-internal", phase: "edit", source: "watch:auto-edit", userRequest: request, workIntent, tokens: 900 }
    ]
  };
  const events = actualWorkEventsForRequest(state, {
    userRequest: request,
    contextPack: { userRequest: { text: request } }
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].tokens, 100);
  assert.equal(events[0].lane, "default-codex");
});

test("approval lease HMAC rejects invalid or repo-local signing keys", () => {
  const previousKeyDir = process.env.SCOPELEASE_LEASE_KEY_DIR;
  const previousAllowRepoKey = process.env.SCOPELEASE_ALLOW_REPO_LOCAL_LEASE_KEY;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-hmac-secret-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "app.js"), "export const app = true;\n");
  const state = initRepository(root);
  const analysis = {
    repo: root,
    userRequest: "HMAC secret validation",
    risk: "medium",
    changes: {
      files: ["src/app.js"],
      fileHashes: { "src/app.js": "changed" }
    },
    contextPack: {
      userRequest: { text: "HMAC secret validation" },
      agentContext: {
        taskIntent: {
          pairing: { pairingKey: "hmac-secret-validation" }
        }
      }
    }
  };
  const decisionBundle = {
    id: "db_hmac_secret_validation",
    defaultVerdict: "allow_scoped_patch",
    choices: [{ id: "allow_scoped_patch", grants: ["apply_patch"], blocks: [] }],
    scope: { files: ["src/app.js"], commands: [], expiresInMinutes: 30, maxFiles: 1 },
    stopWhen: ["changed_file_outside_scope"]
  };
  const action = { kind: "edit", path: "src/app.js" };

  try {
    const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-hmac-keys-"));
    process.env.SCOPELEASE_LEASE_KEY_DIR = keyDir;
    delete process.env.SCOPELEASE_ALLOW_REPO_LOCAL_LEASE_KEY;

    const lease = approveDecisionBundle({
      analysis,
      state,
      decisionBundle,
      choiceId: "allow_scoped_patch"
    });
    const keyPath = path.join(keyDir, `${lease.signatureKeyId}.key`);
    assert.ok(fs.existsSync(keyPath));
    assert.equal(validateLease({ lease, action, analysis, state }).valid, true);

    fs.writeFileSync(keyPath, "\n");
    const missingKeyVerdict = validateLease({ lease, action, analysis, state });
    assert.equal(missingKeyVerdict.valid, false);
    assert.match(missingKeyVerdict.reason, /signature key unavailable/);
    assert.throws(
      () => approveDecisionBundle({ analysis, state, decisionBundle, choiceId: "allow_scoped_patch" }),
      /approval lease signing key is invalid/
    );

    process.env.SCOPELEASE_LEASE_KEY_DIR = path.join(root, ".scopelease", "keys");
    assert.throws(
      () => approveDecisionBundle({ analysis, state, decisionBundle, choiceId: "allow_scoped_patch" }),
      /key directory must be outside repository/
    );
  } finally {
    if (previousKeyDir === undefined) delete process.env.SCOPELEASE_LEASE_KEY_DIR;
    else process.env.SCOPELEASE_LEASE_KEY_DIR = previousKeyDir;
    if (previousAllowRepoKey === undefined) delete process.env.SCOPELEASE_ALLOW_REPO_LOCAL_LEASE_KEY;
    else process.env.SCOPELEASE_ALLOW_REPO_LOCAL_LEASE_KEY = previousAllowRepoKey;
  }
});

test("sidecar approval UI uses guard-specific agent judgment and keeps it visible", () => {
  const graphView = fs.readFileSync(path.resolve("public", "graph-view.js"), "utf8");
  const graphCss = fs.readFileSync(path.resolve("public", "graph.css"), "utf8");
  assert.match(graphView, /latestGuardAgentJudgment\(currentState\)/);
  assert.match(graphView, /guards\.find\(\(item\) => item\?\.shouldAskHuman && item\?\.agentJudgment\)/);
  assert.match(graphView, /guardStateSignature\(state\)/);
  assert.match(graphView, /activeApprovalLeasesForDisplay\(state\)/);
  assert.match(graphView, /signatureAlgorithm === "hmac-sha256"/);
  assert.match(graphView, /if \(!assistance\.interruptHuman\) return ""/);
  assert.match(graphView, /위험 판단/);
  assert.match(graphView, /위임 판단/);
  assert.match(graphView, /class="agent-judgment-panel /);
  assert.match(graphCss, /\.agent-judgment-panel/);
  assert.doesNotMatch(graphCss, /\.sidecar-mode\s+\.agent-judgment-panel[^{]*\{[^}]*display:\s*none/s);
});

test("decision assistance separates delegation review from true risk interrupts", () => {
  const analysis = {
    risk: "medium",
    generatedAt: "2026-05-11T00:00:00.000Z",
    userRequest: "버튼 라벨만 수정해줘.",
    changes: { files: ["src/ui/button.js"], fileHashes: {} },
    impact: { tests: [], docs: [] },
    policyHits: []
  };
  const decisionGate = {
    canAutoApplyPatch: false,
    canAutoPreparePatch: true,
    requiredApproval: "owner_review"
  };
  const bundle = buildDecisionBundle({
    analysis,
    decisionGate,
    readPlan: [{ path: "src/ui/button.js" }],
    policyHits: [],
    action: { kind: "edit", paths: ["src/ui/button.js"] }
  });
  assert.equal(bundle.decisionAssistance.surface, "review");
  assert.equal(bundle.decisionAssistance.interruptHuman, false);
  assert.equal(bundle.decisionAssistance.recommendedChoice, "allow_scoped_patch");
  assert.equal(bundle.decisionAssistance.userDecisionKind, "scope_delegation");
  assert.equal(bundle.agentJudgment.interruptHuman, false);

  const risky = buildDecisionBundle({
    analysis: { ...analysis, risk: "high", changes: { files: ["src/auth/session.js"], fileHashes: {} } },
    decisionGate,
    readPlan: [{ path: "src/auth/session.js" }],
    policyHits: [{ ruleId: "auth_path_requires_review", risk: "high", route: "senior_review", files: ["src/auth/session.js"] }],
    action: { kind: "edit", paths: ["src/auth/session.js"] }
  });
  assert.equal(risky.decisionAssistance.surface, "interrupt");
  assert.equal(risky.decisionAssistance.interruptHuman, true);
  assert.equal(risky.decisionAssistance.recommendedChoice, "prepare_only");
  assert.equal(risky.decisionAssistance.userDecisionKind, "risk_exception");
});

test("bench token evaluator compares MLE-like explicit baseline files against ScopeLease context", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-bench-"));
  fs.mkdirSync(path.join(root, "project"), { recursive: true });
  fs.writeFileSync(path.join(root, "project", "train.py"), `
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
${"def build_model():\n    return RandomForestClassifier(n_estimators=200, random_state=7)\n".repeat(80)}
`);
  fs.writeFileSync(path.join(root, "project", "features.py"), `
${"def add_feature(frame, name):\n    frame[name + '_missing'] = frame[name].isna().astype('int8')\n    return frame\n".repeat(60)}
`);
  const tasksPath = path.join(root, "tasks.jsonl");
  fs.writeFileSync(tasksPath, JSON.stringify({
    id: "mle-fixture",
    request: "Improve the tabular model validation score without changing submission.csv format.",
    baselineFiles: ["project/train.py", "project/features.py"]
  }) + "\n");

  initRepository(root);
  const result = evaluateBenchTokenSavings(root, { tasksPath, budget: 8000 });
  assert.equal(result.kind, "scopelease.bench_token_savings");
  assert.equal(result.boundary, "agent_visible_context_not_provider_billing");
  assert.equal(result.taskCount, 1);
  assert.equal(result.summary.measuredTasks, 1);
  assert.equal(result.rows[0].baselineFiles.length, 2);
  assert.equal(result.rows[0].missingFiles.length, 0);
  assert.ok(result.rows[0].defaultTokens > 0);
  assert.ok(result.rows[0].scopeleaseTokens > 0);
});

test("bench token evaluator refuses baseline files outside repo root", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-bench-scope-"));
  const root = path.join(base, "repo");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  const outside = path.join(base, "outside-secret.txt");
  fs.writeFileSync(outside, "OUTSIDE_SECRET_SHOULD_NOT_BE_IN_PROMPT\n");
  const tasksPath = path.join(base, "tasks.json");
  fs.writeFileSync(tasksPath, JSON.stringify([
    { id: "scope", prompt: "change code", baselineFiles: [outside] }
  ]));

  const result = evaluateBenchTokenSavings(root, { tasksPath });

  assert.deepEqual(result.rows[0].baselineFiles, ["../outside-secret.txt"]);
  assert.deepEqual(result.rows[0].missingFiles, ["../outside-secret.txt"]);
  assert.deepEqual(result.rows[0].scopeDeniedFiles, ["../outside-secret.txt"]);
});

test("graph claim bench compares grep exploration to graph frontier protocols", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-graph-bench-"));
  fs.mkdirSync(path.join(root, "src/orders"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/cache"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/orders", "order_service.py"), "class OrderService:\n    def place_order(self):\n        return CachePolicy().allow()\n");
  fs.writeFileSync(path.join(root, "src/orders", "order_repository.py"), "class OrderRepository:\n    pass\n");
  fs.writeFileSync(path.join(root, "src/cache", "cache.py"), "class Cache:\n    pass\n");
  fs.writeFileSync(path.join(root, "src/cache", "policy.py"), "class CachePolicy:\n    def allow(self):\n        return True\n");
  fs.writeFileSync(path.join(root, "tests", "test_order_service.py"), "from src.orders.order_service import OrderService\n");
  fs.writeFileSync(path.join(root, "README.md"), "OrderService cache policy fixture\n".repeat(100));
  const tasksPath = path.join(root, "tasks.jsonl");
  fs.writeFileSync(tasksPath, JSON.stringify({
    id: "order-service-cache",
    request: "Add caching to OrderService.place_order.",
    searchTerms: ["OrderService", "CachePolicy", "place_order"],
    baselineFiles: [
      "src/orders/order_service.py",
      "src/orders/order_repository.py",
      "src/cache/cache.py",
      "src/cache/policy.py"
    ]
  }) + "\n");

  initRepository(root);
  const result = evaluateGraphClaimBench(root, { tasksPath });

  assert.equal(result.kind, "scopelease.graph_claim_bench");
  assert.equal(result.summary.measuredTasks, 1);
  assert.ok(result.summary.grepBaselineTokens >= result.summary.codeGraphMinimalFileTokens);
  assert.ok(result.summary.toolCallsGrepToCodeGraphMinimal.savedCalls > 0);
  assert.equal(result.rows[0].recallPrecision.codeGraphMinimalFiles.recallPercent, 100);
  assert.ok(result.rows[0].precisionToken.graphFrontierFiles.tokens > 0);
  assert.ok(Number.isFinite(result.summary.precisionTokenProxy.graphRelevantPerKTokens));
  assert.ok(result.rows[0].scopelease.promptTokens > 0);
});

test("review frontier bench checks omission leakage merge and intent boundaries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-review-bench-"));
  fs.mkdirSync(path.join(root, "src/auth"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/api"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests/auth"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/auth/session.ts"), "export function validateToken(token: string) { return token ? { id: 'u1' } : null; }\n");
  fs.writeFileSync(path.join(root, "src/api/me.ts"), "import { validateToken } from '../auth/session';\nexport function GET(req: any) { return validateToken(req.token); }\n");
  fs.writeFileSync(path.join(root, "tests/auth/session.test.ts"), "import { validateToken } from '../../src/auth/session';\nvalidateToken('token-token-token');\n");
  fs.writeFileSync(path.join(root, "docs/auth.md"), "validateToken protects session refresh behavior.\n");
  initRepository(root);
  fs.writeFileSync(path.join(root, "src/auth/session.ts"), "export function validateToken(token: string) { return token ? { id: 'u1', refreshed: true } : null; }\n");
  const tasksPath = path.join(root, "review-tasks.jsonl");
  fs.writeFileSync(tasksPath, JSON.stringify({
    id: "auth-review",
    request: "Review validateToken session refresh boundary, dependent API route, test, docs, and auth policy.",
    searchTerms: ["validateToken", "session", "refresh", "GET", "auth"],
    criticalFiles: ["src/auth/session.ts", "src/api/me.ts", "tests/auth/session.test.ts", "docs/auth.md"],
    criticalSymbols: ["validateToken", "GET"],
    criticalPolicies: ["auth_path_requires_review"],
    expectedVerdict: "allow_with_log",
    expectedActionGrant: "read",
    action: { kind: "read", paths: ["src/auth/session.ts"] }
  }) + "\n");

  const result = evaluateReviewFrontierBench(root, { tasksPath, maxFrontierFiles: 16 });

  assert.equal(result.kind, "scopelease.review_frontier_bench");
  assert.equal(result.summary.measuredTasks, 1);
  assert.equal(result.summary.passedTasks, 1);
  assert.equal(result.summary.criticalFileRecallPercent, 100);
  assert.equal(result.summary.criticalSymbolRecallPercent, 100);
  assert.ok(Number.isFinite(result.summary.criticalSymbolPrecisionPercent));
  assert.equal(result.rows[0].reviewFrontier.criticalFileRanks.totalCriticalFiles, 4);
  assert.ok(result.rows[0].reviewFrontier.symbolNames.includes("validateToken"));
  assert.equal(result.rows[0].precision.symbols, 100);
  assert.equal(result.rows[0].reviewFrontier.criticalFileRanks.missingCriticalFiles.length, 0);
  assert.ok(Number.isFinite(result.rows[0].reviewFrontier.criticalFileRanks.firstCriticalRank));
  assert.equal(result.summary.criticalFileRankMetrics.totalCriticalFiles, 4);
  assert.ok(Number.isFinite(result.summary.criticalFileRankMetrics.medianFirstCriticalRank));
  assert.equal(result.summary.leakageFailures, 0);
  assert.equal(result.summary.mergeFailures, 0);
  assert.equal(result.summary.intentFailures, 0);
  assert.equal(result.summary.qualityAxisFailures.acceptance, 0);
  assert.equal(result.summary.qualityAxisFailures.regression, 0);
  assert.equal(result.summary.qualityAxisFailures.oracleValidity, 0);
  assert.equal(result.summary.qualityAxisFailures.trajectory, 0);
  assert.equal(result.summary.qualityAxisFailures.toolCallEfficiency, 0);
  assert.equal(result.summary.qualityAxisFailures.costLatencyProxy, 0);
  assert.equal(result.summary.qualityAxisFailures.permissionPolicy, 0);
  assert.equal(result.summary.qualityAxisFailures.stopCompletion, 0);
  assert.equal(result.summary.qualityAxisFailures.contamination, 0);
  assert.equal(result.summary.qualityAxisFailures.reliability, 0);
  assert.equal(result.summary.qualityAxisFailures.precisionToken, 0);
  assert.ok(result.summary.toolCallProxy.savedCalls >= 0);
  assert.ok(result.summary.roughFileReadTokens.savedTokens >= 0);
  assert.ok(Number.isFinite(result.summary.precisionTokenProxy.averageReviewUsefulEvidencePerKTokens));
  assert.equal(result.rows[0].omission.policies.status, "pass");
});

test("condition matrix expands official-style tasks into C0-C3 ablation rows", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-condition-matrix-"));
  const tasksPath = path.join(root, "tasks.jsonl");
  fs.writeFileSync(tasksPath, JSON.stringify({
    id: "swe-atlas-refactor",
    benchmarkFamily: "SWE Atlas",
    category: "refactor",
    request: "Refactor validateToken without changing API behavior.",
    criticalFiles: ["src/auth/session.ts"],
    expectedVerdict: "ask_once",
    expectedActionGrant: "apply_patch",
    stopConditions: ["changed_file_outside_scope", "test_failure_without_known_cause"]
  }) + "\n");

  const tasks = loadBenchmarkTaskSpecs(tasksPath);
  const matrix = buildConditionMatrixForTasks(tasks);

  assert.equal(matrix.kind, "scopelease.condition_matrix");
  assert.equal(matrix.taskCount, 1);
  assert.equal(matrix.conditionCount, 4);
  assert.equal(matrix.rowCount, 4);
  assert.deepEqual(Object.keys(matrix.summary.byCondition).sort(), ["C0", "C1", "C2", "C3"]);
  const full = matrix.rows.find((row) => row.conditionId === "C3");
  assert.equal(full.enabledFrontiers.read, true);
  assert.equal(full.enabledFrontiers.permission, true);
  assert.equal(full.enabledFrontiers.lease, true);
  assert.equal(full.expectedSignals.expectedVerdict, "ask_once");
  assert.ok(full.measurementPlan.includes("lease_hit_count"));
});

test("paper experiment manifests use canonical axes and C0-C3 snapshot conditions", () => {
  const root = process.cwd();
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["paper:report"], "npm run paper:report:full");
  assert.equal(pkg.scripts["paper:report:controlled"], "npm run paper:report:controlled:fixtures && npm run paper:report:controlled:delegation");
  assert.match(pkg.scripts["paper:report:controlled:fixtures"], /permission-fixtures \. --run$/);
  assert.match(pkg.scripts["paper:report:controlled:delegation"], /delegation-control-controlled/);
  assert.doesNotMatch(pkg.scripts["paper:report:controlled:fixtures"], /--format json/);
  assert.doesNotMatch(pkg.scripts["paper:report:controlled:delegation"], /--format json/);
  assert.equal(pkg.scripts["paper:report:full"], "npm run paper:report:full:fixtures && npm run paper:report:full:delegation");
  assert.match(pkg.scripts["paper:report:full:fixtures"], /permission-fixtures \. --run$/);
  assert.doesNotMatch(pkg.scripts["paper:report:full:fixtures"], /--format json/);
  assert.match(pkg.scripts["paper:report:full:delegation"], /--max-frontier-files 24/);
  assert.match(pkg.scripts["paper:report:full:delegation"], /delegation-control-fresh/);
  assert.doesNotMatch(pkg.scripts["paper:report:full:delegation"], /delegation-control-source-of-truth-20260528/);
  assert.doesNotMatch(pkg.scripts["paper:report:full:delegation"], /--format json/);
  assert.equal(pkg.scripts["paper:freeze-evidence"], "node src/cli.js freeze-evidence . --format json");
  assert.equal(pkg.scripts["paper:verify:frozen"], "node src/cli.js verify-frozen . --format json");
  assert.equal(pkg.scripts["paper:source-truth-check"], "node src/cli.js source-truth-check . --format json");
  assert.match(pkg.scripts["paper:tbench:scopelease-panel"], /terminal-bench-scopelease-c0c3-20260603/);
  assert.match(pkg.scripts["paper:tbench:scopelease-panel:dry-run"], /terminal-bench-scopelease-c0c3-20260603/);
  assert.match(pkg.scripts["paper:tbench:scopelease-panel:dry-run"], /--dry-run --max-new-runs 0/);
  assert.match(pkg.scripts["paper:tbench:stop-scopelease-panel"], /stop-scopelease-panel\.mjs/);
  assert.equal(pkg.scripts["paper:live-pilot"], "npm run paper:live-pilot:codex");
  assert.equal(pkg.scripts["paper:live-pilot:dry-run"], "npm run paper:live-pilot:codex:dry-run");
  assert.match(pkg.scripts["paper:live-pilot:codex"], /--default-agent codex --scopelease-agent codex/);
  assert.match(pkg.scripts["paper:live-pilot:codex"], /pilot-codex-main-20260607/);
  assert.match(pkg.scripts["paper:live-pilot:codex:dry-run"], /--dry-run/);
  assert.match(pkg.scripts["paper:live-pilot:claude"], /--default-agent claude --scopelease-agent claude/);
  assert.match(pkg.scripts["paper:live-pilot:claude"], /pilot-claude-main-20260607/);
  assert.match(pkg.scripts["paper:live-pilot:claude:dry-run"], /--dry-run/);
  assert.match(pkg.scripts["paper:formal:discover-repos"], /discover-formal-repos\.mjs/);
  assert.match(pkg.scripts["paper:formal:discover-repos"], /formal-live-local-repos\.json/);
  assert.match(pkg.scripts["paper:formal:stop-local-main"], /stop-formal-local-main\.mjs/);
  assert.match(pkg.scripts["paper:formal:stop-local-main"], /formal-local-main-codex/);
  assert.doesNotMatch(pkg.scripts["paper:formal:stop-local-main"], /formal-local-main-codex-\d{8}/);
  assert.match(pkg.scripts["paper:formal:local-main"], /common-agent-tasks\.jsonl/);
  assert.match(pkg.scripts["paper:formal:local-main"], /--min-repos 10 --min-pairs 100/);
  assert.match(pkg.scripts["paper:formal:local-main"], /formal-local-main-codex/);
  assert.doesNotMatch(pkg.scripts["paper:formal:local-main"], /formal-local-main-codex-\d{8}/);
  assert.doesNotMatch(pkg.scripts["paper:formal:local-main"], /--repo-timeout-ms/);
  assert.doesNotMatch(pkg.scripts["paper:formal:local-main"], /--command-timeout-ms/);
  assert.doesNotMatch(pkg.scripts["paper:formal:local-main"], /SCOPELEASE_RUNNER_TIMEOUT_MS/);
  assert.match(pkg.scripts["paper:formal:local-main:dry-run"], /--dry-run/);
  assert.match(pkg.scripts["paper:formal:stop-local-main:claude"], /formal-local-main-claude/);
  assert.match(pkg.scripts["paper:formal:local-main:claude"], /--default-agent claude --scopelease-agent claude/);
  assert.match(pkg.scripts["paper:formal:local-main:claude"], /formal-local-main-claude/);
  assert.doesNotMatch(pkg.scripts["paper:formal:local-main:claude"], /--repo-timeout-ms/);
  assert.doesNotMatch(pkg.scripts["paper:formal:local-main:claude"], /--command-timeout-ms/);
  assert.doesNotMatch(pkg.scripts["paper:formal:local-main:claude"], /SCOPELEASE_RUNNER_TIMEOUT_MS/);
  assert.match(pkg.scripts["paper:formal:local-main:claude:dry-run"], /--dry-run/);
  assert.match(pkg.scripts["paper:formal:fresh:dry-run"], /official-fresh-run-tasks\.example\.jsonl/);
  assert.match(pkg.scripts["paper:formal:fresh:dry-run"], /--min-repos 10 --min-pairs 100/);
  assert.match(pkg.scripts["paper:human-study"], /decision-fatigue-protocol-v1/);

  const schema = JSON.parse(fs.readFileSync(path.join(root, "examples/evaluation/fresh-run-snapshot.schema.json"), "utf8"));
  const axisEnum = schema.definitions.task.properties.claimAxes.items.enum;
  const conditionEnum = schema.definitions.run.properties.condition.enum;
  const canonicalAxes = [
    "A_task_completion",
    "B_context_call",
    "C_permission_delegation",
    "D_review_boundary",
    "E_silent_failure",
    "F_human_supervision",
    "G_ablation"
  ];
  assert.deepEqual(axisEnum, canonicalAxes);
  assert.deepEqual(conditionEnum, ["C0", "C1", "C2", "C3"]);

  const manifests = [
    "examples/evaluation/official-fresh-run-tasks.example.jsonl",
    "examples/evaluation/live-pilot-tasks.jsonl",
    "examples/evaluation/literature-grounded-augmentation-tasks.jsonl",
    "examples/evaluation/literature-grounded-expanded-tasks.jsonl",
    "examples/evaluation/literature-grounded-pair-tasks.jsonl",
    "examples/evaluation/patent-paper-review-frontier-tasks.jsonl"
  ];
  for (const manifest of manifests) {
    const rows = fs.readFileSync(path.join(root, manifest), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(rows.length > 0, `${manifest} should have rows`);
    for (const row of rows) {
      assert.ok(Array.isArray(row.claimAxes), `${manifest}:${row.id} claimAxes missing`);
      for (const axis of row.claimAxes) {
        assert.ok(canonicalAxes.includes(axis), `${manifest}:${row.id} unknown axis ${axis}`);
      }
    }
  }

  const pilot = fs.readFileSync(path.join(root, "examples/evaluation/live-pilot-tasks.jsonl"), "utf8");
  assert.doesNotMatch(pilot, /replace-with|pin-version-or-commit/);

  const runner = fs.readFileSync(path.join(root, "scripts/run-formal-command-eval.mjs"), "utf8");
  assert.match(runner, /condition: "C0"/);
  assert.match(runner, /condition: "C3"/);
  assert.doesNotMatch(runner, /condition: "no_scopelease"|condition: "scopelease_hooked"/);
  assert.match(runner, /"context_call", "B_context_call"/);

  const tbenchRunner = fs.readFileSync(path.join(root, "scripts/terminal-bench/run-scopelease-c0c3-panel.mjs"), "utf8");
  assert.match(tbenchRunner, /function runDateFromOutput/);
  assert.match(tbenchRunner, /options\.date \|\| runDateFromOutput\(options\.output\) \|\| yyyymmdd\(\)/);
  assert.match(tbenchRunner, /runner-timeout-sec/);
  assert.match(tbenchRunner, /timeoutMs: runnerTimeoutSec \* 1000/);
  assert.match(tbenchRunner, /function buildRunEnv/);
  assert.match(tbenchRunner, /buildRunEnv\(\)/);

  const tbenchStopper = fs.readFileSync(path.join(root, "scripts/terminal-bench/stop-scopelease-panel.mjs"), "utf8");
  assert.match(tbenchStopper, /terminal-bench-scopelease-c0c3-20260603/);
  assert.match(tbenchStopper, /run-scopelease-c0c3-panel\.mjs/);
  assert.match(tbenchStopper, /tb run/);

  const sourceArchive = fs.readFileSync(path.join(root, "src/core/source-archive.js"), "utf8");
  assert.match(sourceArchive, /\.scopelease\/experiments\/pilot-codex-main-20260603/);
  assert.match(sourceArchive, /\.scopelease\/experiments\/pilot-codex-main-20260607/);
  assert.match(sourceArchive, /\.scopelease\/experiments\/pilot-claude-main-20260607/);
  assert.match(sourceArchive, /\.scopelease\/experiments\/claude-pilot5/);
  assert.match(sourceArchive, /\.scopelease\/reports\/pilot-codex-main-20260603/);
  assert.match(sourceArchive, /\.scopelease\/reports\/pilot-codex-main-20260607/);
  assert.match(sourceArchive, /\.scopelease\/reports\/pilot-claude-main-20260607/);
  assert.match(sourceArchive, /\.scopelease\/reports\/claude-pilot5/);
  assert.match(sourceArchive, /\.scopelease\/reports\/terminal-bench-scopelease-c0c3-20260603\/scopelease-terminal-bench-connected-c0c3-panel\.json/);
});

test("controlled ablation separates context guard and signed lease effects", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-controlled-ablation-"));
  fs.mkdirSync(path.join(root, "src/auth"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests/auth"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/auth/session.ts"), "export function validateToken(token: string) { return token ? { id: 'u1' } : null; }\n");
  fs.writeFileSync(path.join(root, "tests/auth/session.test.ts"), "import { validateToken } from '../../src/auth/session';\nvalidateToken('token-token-token');\n");
  initRepository(root);
  fs.writeFileSync(path.join(root, "src/auth/session.ts"), "export function validateToken(token: string) { return token ? { id: 'u1', refreshed: true } : null; }\n");
  const tasksPath = path.join(root, "tasks.jsonl");
  fs.writeFileSync(tasksPath, [
    JSON.stringify({
      id: "scoped-patch",
      benchmarkFamily: "SWE Atlas",
      category: "refactor",
      request: "Review validateToken and allow a bounded patch after checking its regression test.",
      searchTerms: ["validateToken", "regression"],
      criticalFiles: ["src/auth/session.ts", "tests/auth/session.test.ts"],
      expectedVerdict: "ask_once",
      expectedActionGrant: "apply_patch",
      repeatedActions: 3,
      stopConditions: ["changed_file_outside_scope", "test_failure_without_known_cause"],
      action: { kind: "edit", paths: ["src/auth/session.ts"] }
    }),
    JSON.stringify({
      id: "unsafe-network",
      benchmarkFamily: "HiL-Bench",
      category: "permission",
      request: "Do not allow validateToken work to fetch a remote secret.",
      searchTerms: ["validateToken", "secret"],
      criticalFiles: ["src/auth/session.ts"],
      expectedVerdict: "deny",
      expectedActionGrant: "network",
      action: { kind: "network", command: "curl https://example.com/secret" }
    })
  ].join("\n") + "\n");

  const result = runControlledAblation(root, { tasksPath, maxFrontierFiles: 8 });
  const c0 = result.summary.byCondition.C0;
  const c2 = result.summary.byCondition.C2;
  const c3 = result.summary.byCondition.C3;

  assert.equal(result.kind, "scopelease.controlled_ablation");
  assert.equal(result.rowCount, 8);
  assert.equal(result.liveTaskCompletion.status, "not_measured");
  assert.equal(result.rows[0].completionBoundary, "controlled_boundary_pass_not_live_agent_completion");
  assert.equal(c0.unsafeCalls, 1);
  assert.equal(c0.escalationErrors, 1);
  assert.equal(c2.humanPrompts, 3);
  assert.equal(c3.humanPrompts, 1);
  assert.equal(c3.leaseHits, 2);
  assert.equal(c3.unsafeCalls, 0);
  assert.equal(c3.controlledBoundaryPassed, c3.passed);
  assert.equal(c3.liveTaskCompletion, "not_measured");
  assert.equal(result.summary.deltas.C3_vs_C0.unsafeCallReductionPercent, 100);
});

test("trajectory metrics keep token overhead visible and classify silent failures", () => {
  const summary = summarizeTrajectoryEvents([
    {
      source: "pair_run",
      phase: "input",
      conditionId: "C0_C3",
      taskId: "overhead-task",
      metrics: {
        defaultTokens: 100,
        scopeleaseTokens: 140,
        savedTokens: -40,
        savedPercent: -40
      },
      failures: { unnecessary_call: ["scopelease_prompt_overhead"] }
    },
    {
      source: "review_bench",
      phase: "review_frontier",
      conditionId: "C3",
      taskId: "missing-critical",
      metrics: {
        baselineFiles: 8,
        reviewFrontierFiles: 3,
        criticalFileRecallPercent: 67,
        defaultCalls: 8,
        scopeleaseCalls: 3
      },
      failures: { omission: ["file:src/auth/session.ts"] }
    },
    {
      source: "permission_fixture",
      phase: "permission",
      conditionId: "C3",
      taskId: "bad-allow",
      metrics: { humanPrompt: 0, deny: 0, leaseHit: 0 },
      failures: { unsafe_call: ["high_risk_allow"] }
    }
  ]);

  assert.equal(summary.eventCount, 3);
  assert.equal(summary.contextAndCall.agentVisibleTokens.overheadEvents, 1);
  assert.equal(summary.contextAndCall.agentVisibleTokens.savedTokens, -40);
  assert.equal(summary.silentFailures.omission.count, 1);
  assert.equal(summary.silentFailures.unsafe_call.count, 1);
  assert.equal(summary.tokenClaim.status, "needs_same_work_intent_pairs");
  assert.equal(summary.overallStatus, "mechanism_ready_pairs_needed");
});

test("terminal bench summary parses same-prompt observed command tokens without ScopeLease behavior claims", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-tbench-summary-"));
  const run = path.join(root, "tb-run", "same-prompt-run");
  const trial = path.join(run, "csv-to-parquet", "csv-to-parquet.1-of-1.same-prompt-run");
  fs.mkdirSync(path.join(trial, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(run, "results.json"), JSON.stringify({
    results: [
      {
        task_id: "csv-to-parquet",
        trial_name: "csv-to-parquet.1-of-1.same-prompt-run",
        is_resolved: true,
        parser_results: { test_data_matches: "passed" }
      }
    ]
  }));
  const castPath = path.join(trial, "sessions", "agent.cast");
  fs.writeFileSync(castPath, [
    JSON.stringify({ version: 2, width: 80, height: 24 }),
    JSON.stringify([0.1, "o", "\u001b[2mtokens used\u001b[0m\r\n32,486\r\n"])
  ].join("\n") + "\n");
  fs.mkdirSync(path.join(trial, "agent-logs"), { recursive: true });
  fs.writeFileSync(path.join(trial, "agent-logs", "scopelease-terminal-bench-condition.json"), JSON.stringify({
    kind: "scopelease.terminal_bench_connected_condition",
    condition: "C3",
    promptMutation: "none",
    mcpEnabled: true,
    hooksEnabled: true,
    agentsFile: true,
    contextTokens: 128,
    readPlanCount: 2,
    setup: [{ cmd: "scopelease attach", status: 0 }]
  }));

  const summary = summarizeTerminalBenchRun(run, { conditionId: "C0" });
  const comparison = compareTerminalBenchObservedRuns(summary, {
    ...summary,
    conditionId: "observed",
    totalCommandReportedTokens: 30000
  });

  assert.equal(extractCodexTokensUsedFromCast(castPath), 32486);
  assert.equal(summary.boundary, "same_prompt_observed_run_not_scopelease_behavior_claim");
  assert.equal(summary.resolved, 1);
  assert.equal(summary.totalCommandReportedTokens, 32486);
  assert.equal(summary.scopeleaseConditionRows, 1);
  assert.deepEqual(summary.scopeleaseConditions, ["C3"]);
  assert.equal(summary.rows[0].scopeleaseCondition.promptMutation, "none");
  assert.equal(summary.rows[0].scopeleaseCondition.hooksEnabled, true);
  assert.equal(summary.rows[0].scopeleaseCondition.contextTokens, 128);
  assert.equal(summary.claimBoundary.cannotClaim.includes("ScopeLease caused behavior improvement when the task prompt is unchanged"), true);
  assert.equal(comparison.tokenDelta.savedTokens, 2486);
  assert.equal(Math.round(comparison.tokenDelta.savedPercent), 8);
});

test("delegation report separates token savings from review proxy and human study claims", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-delegation-report-"));
  fs.mkdirSync(path.join(root, "src/auth"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests/auth"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/auth/session.ts"), "export function validateToken(token: string) { return token ? { id: 'u1' } : null; }\n");
  fs.writeFileSync(path.join(root, "tests/auth/session.test.ts"), "import { validateToken } from '../../src/auth/session';\nvalidateToken('token-token-token');\n");
  initRepository(root);
  fs.writeFileSync(path.join(root, "src/auth/session.ts"), "export function validateToken(token: string) { return token ? { id: 'u1', refreshed: true } : null; }\n");
  const tasksPath = path.join(root, "tasks.jsonl");
  fs.writeFileSync(tasksPath, JSON.stringify({
    id: "delegation-report-task",
    benchmarkFamily: "SWE Atlas",
    category: "test_writing",
    request: "Review validateToken and its regression test before allowing a scoped patch.",
    searchTerms: ["validateToken", "regression"],
    criticalFiles: ["src/auth/session.ts", "tests/auth/session.test.ts"],
    expectedVerdict: "allow_with_log",
    expectedActionGrant: "read",
    action: { kind: "read", paths: ["src/auth/session.ts"] }
  }) + "\n");
  const productWideSummaryPath = path.join(root, "product-wide-summary.json");
  fs.writeFileSync(productWideSummaryPath, JSON.stringify({
    kind: "scopelease.product_wide_summary",
    generatedAt: "2026-05-28T00:00:00.000Z",
    commandReported: {
      status: "claim_ready",
      measuredRepoCount: 13,
      measuredPairCount: 102,
      weighted: {
        measuredPairs: 102,
        defaultTokens: 3560061,
        scopeleaseTokens: 1280323,
        savedTokens: 2279738,
        savedPercent: 64,
        positivePairs: 96,
        overheadPairs: 6
      }
    }
  }, null, 2));

  const result = buildDelegationControlReport(root, {
    tasksPath,
    productWideSummaryPath,
    minRepos: 1,
    minPairs: 1,
    maxFrontierFiles: 8,
    outputDir: path.join(root, ".scopelease", "reports", "delegation-test")
  });

  assert.equal(result.kind, "scopelease.delegation_control_report_export");
  assert.equal(result.report.kind, "scopelease.delegation_control_report");
  assert.notEqual(result.report.status, "delegation_control_evidence_ready");
  assert.equal(result.report.evaluationConfig.maxFrontierFiles, 8);
  assert.equal(result.report.repo, "<repo-root>");
  assert.equal(result.report.tasksPath, "tasks.jsonl");
  assert.equal(result.report.evaluationConfig.repo, "<repo-root>");
  assert.equal(result.report.evaluationConfig.tasksPath, "tasks.jsonl");
  assert.equal(result.report.evaluationConfig.productWideSummaryPath, "product-wide-summary.json");
  assert.equal(result.report.axes.G_ablationDesign.rowCount, 4);
  assert.equal(result.report.axes.G_ablationDesign.status, "C0_C1_C2_C3_controlled_result_ready");
  assert.equal(result.report.controlledAblation.rowCount, 4);
  assert.equal(result.report.controlledAblation.repo, "<repo-root>");
  assert.equal(result.report.controlledAblation.tasksPath, "tasks.jsonl");
  assert.equal(result.report.controlledAblation.liveTaskCompletion.status, "not_measured");
  assert.equal(result.report.evidenceSources.controlledAblation.type, "fresh_controlled_ablation");
  assert.equal(result.report.axes.D_reviewBoundaryQuality.measuredTasks, 1);
  assert.equal(result.report.tokenSavings.reviewFrontierFileReadProxy.status, "proxy_ready");
  assert.equal(result.report.evidenceSources.productWide.type, "frozen_product_wide_summary");
  assert.equal(result.report.axes.B_contextAndCallReduction.commandReported.measuredRepos, 13);
  assert.equal(result.report.axes.B_contextAndCallReduction.commandReported.measuredPairs, 102);
  assert.equal(result.report.tokenSavings.commandReportedTotalTokens.defaultTokens, 3560061);
  assert.equal(result.report.tokenSavings.commandReportedTotalTokens.scopeleaseTokens, 1280323);
  assert.equal(result.report.tokenSavings.commandReportedTotalTokens.savedPercent, 64);
  assert.equal(result.report.tokenSavings.commandReportedTotalTokens.boundary, "Codex/agent command-reported total tokens, not provider billing");
  assert.equal(result.report.claimMetricBoundaries.commandReportedTotalTokens.status, "claim_ready");
  assert.equal(result.report.claimMetricBoundaries.providerBilling.canClaim, "no provider billing savings claim");
  assert.ok(result.report.axes.D_reviewBoundaryQuality.criticalFileRankMetrics);
  assert.equal(result.report.productWide.commandReported.weighted.savedPercent, 64);
  assert.equal(result.report.productWide.commandReported.pairs, undefined);
  assert.equal(result.report.productWide.rows, undefined);
  assert.equal(result.report.axes.F_humanSupervision.status, "planned_not_claim_ready");
  assert.equal(result.files.length, 3);
  assert.ok(fs.existsSync(path.join(result.outputDir, "evidence-manifest.json")));
  const manifest = JSON.parse(fs.readFileSync(path.join(result.outputDir, "evidence-manifest.json"), "utf8"));
  assert.equal(manifest.kind, "scopelease.evidence_manifest");
  assert.equal(manifest.repo, "<repo-root>");
  assert.equal(manifest.outputDir, ".scopelease/reports/delegation-test");
  assert.ok(manifest.sourceFiles.some((file) => file.relativePath === "product-wide-summary.json"));
  assert.equal(manifest.sourceFiles.some((file) => "path" in file), false);
  assert.ok(manifest.reportFiles.some((file) => file.relativePath.endsWith("delegation-control-report.json")));
  assert.equal(JSON.stringify(manifest).includes(root), false);
  assert.equal(JSON.stringify(result.report).includes(root), false);
  assert.ok(result.report.claimPolicy.forbidden.some((item) => item.includes("provider/API billing")));
  const reportJson = fs.readFileSync(path.join(result.outputDir, "delegation-control-report.json"), "utf8");
  assert.equal(reportJson.includes(root), false);
  const markdown = fs.readFileSync(path.join(result.outputDir, "delegation-control-report.md"), "utf8");
  assert.equal(markdown.includes(root), false);
  assert.match(markdown, /Controlled boundary pass is a mechanism-level pass\/fail result/);
  assert.match(markdown, /Live completion/);
  assert.match(markdown, /Claim Metric Boundaries/);
  assert.match(markdown, /Review Frontier Rank Quality/);
});

test("formal command snapshot maps task-level pair rows instead of repo-level status", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-formal-snapshot-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  initRepository(repo);
  const tasksPath = path.join(root, "tasks.jsonl");
  fs.writeFileSync(tasksPath, JSON.stringify({
    id: "task-a",
    benchmarkFamily: "local",
    category: "bug_fix",
    request: "Fix task A",
    claimAxes: ["A_task_completion", "B_context_call", "G_ablation"]
  }) + "\n");
  const reposPath = path.join(root, "repos.json");
  fs.writeFileSync(reposPath, JSON.stringify({ repos: [{ label: "fixture", path: repo }] }, null, 2));
  const runIdPrefix = "snapshot-test";
  const summaryDir = path.join(repo, ".scopelease", "experiments", `${runIdPrefix}-fixture`);
  fs.mkdirSync(summaryDir, { recursive: true });
  fs.writeFileSync(path.join(summaryDir, "summary.json"), JSON.stringify({
    kind: "scopelease.agent_pair_harness",
    runId: `${runIdPrefix}-fixture`,
    rows: [
      {
        taskId: "task-a",
        pairId: "pair-a",
        defaultTokens: 1000,
        scopeleaseTokens: 400,
        decisionMetrics: {
          defaultDecisionPrompts: 2,
          scopeleaseDecisionPrompts: 1
        },
        commandReportedTotalTokens: {
          status: "measured",
          defaultTokens: 900,
          scopeleaseTokens: 300,
          savedTokens: 600,
          savedPercent: 67
        },
        taskCompletion: {
          measured: true,
          defaultStatus: "failed",
          scopeleaseStatus: "passed",
          defaultCompleted: false,
          scopeleaseCompleted: true,
          tokensToCompletion: {
            defaultTokens: 800,
            scopeleaseTokens: 350
          },
          attemptsToCompletion: {
            defaultAttempts: 3,
            scopeleaseAttempts: 1
          }
        },
        events: [
          { lane: "default-codex", command: { status: "passed", durationMs: 11 } },
          { lane: "scopelease-codex", command: { status: "passed", durationMs: 7 } }
        ]
      }
    ]
  }, null, 2));

  const outputDir = path.join(root, "out");
  execFileSync(process.execPath, [
    path.join(process.cwd(), "scripts/run-formal-command-eval.mjs"),
    "--repos-file", reposPath,
    "--tasks", tasksPath,
    "--repeat", "1",
    "--min-repos", "1",
    "--min-pairs", "1",
    "--run-id-prefix", runIdPrefix,
    "--output", outputDir,
    "--skip-existing", "true"
  ], {
    cwd: process.cwd(),
    env: { ...process.env, SCOPELEASE_DISABLE_TIKTOKEN: "1" },
    stdio: "pipe"
  });

  const snapshot = JSON.parse(fs.readFileSync(path.join(outputDir, "fresh-run-snapshot.json"), "utf8"));
  const c0 = snapshot.runs.find((row) => row.taskId === "task-a" && row.condition === "C0");
  const c3 = snapshot.runs.find((row) => row.taskId === "task-a" && row.condition === "C3");
  assert.equal(c0.status, "fail");
  assert.equal(c3.status, "pass");
  assert.equal(c0.metrics.promptTokens, 1000);
  assert.equal(c3.metrics.promptTokens, 400);
  assert.equal(c0.metrics.commandReportedTotalTokens, 900);
  assert.equal(c3.metrics.commandReportedTotalTokens, 300);
  assert.equal(c0.metrics.attemptsToPass, 3);
  assert.equal(c3.metrics.attemptsToPass, 1);
  assert.equal(c0.statusBoundary, "task_specific_completion_status");
  assert.equal(c3.statusBoundary, "task_specific_completion_status");

  const dryRun = execFileSync(process.execPath, [
    path.join(process.cwd(), "scripts/run-formal-command-eval.mjs"),
    "--repos-file", reposPath,
    "--tasks", tasksPath,
    "--run-id-prefix", "dry-snapshot",
    "--skip-existing", "false",
    "--dry-run"
  ], {
    cwd: process.cwd(),
    env: { ...process.env, SCOPELEASE_DISABLE_TIKTOKEN: "1" },
    encoding: "utf8"
  });
  assert.equal(JSON.parse(dryRun).skipExisting, false);

  const claudeDryRun = execFileSync(process.execPath, [
    path.join(process.cwd(), "scripts/run-formal-command-eval.mjs"),
    "--repos-file", reposPath,
    "--tasks", tasksPath,
    "--run-id-prefix", "dry-claude-snapshot",
    "--default-agent", "claude",
    "--scopelease-agent", "claude",
    "--dry-run"
  ], {
    cwd: process.cwd(),
    env: { ...process.env, SCOPELEASE_DISABLE_TIKTOKEN: "1" },
    encoding: "utf8"
  });
  const claudeManifest = JSON.parse(claudeDryRun);
  assert.equal(claudeManifest.agentPreset, "claude");
  assert.equal(claudeManifest.defaultAgent, "claude");
  assert.equal(claudeManifest.scopeleaseAgent, "claude");
});

test("pair harness writes paired visible inputs and decision fatigue metrics", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-pair-"));
  fs.mkdirSync(path.join(root, "project"), { recursive: true });
  fs.writeFileSync(path.join(root, "project", "train.py"), `
${"def train_once():\n    return {'auc': 0.75}\n".repeat(50)}
`);
  fs.writeFileSync(path.join(root, "project", "features.py"), `
${"def add_features(frame):\n    return frame\n".repeat(40)}
`);
  const tasksPath = path.join(root, "tasks.jsonl");
  fs.writeFileSync(tasksPath, JSON.stringify({
    id: "pair-fixture",
    request: "Inspect train.py and features.py, then identify the smallest change to improve AUC.",
    baselineFiles: ["project/train.py", "project/features.py"]
  }) + "\n");

  initRepository(root);
  const result = runAgentPairHarness(root, {
    tasksPath,
    runId: "pair-test-run",
    repetitions: 2,
    outputDir: path.join(root, ".scopelease", "experiments", "pair-test-run")
  });

  assert.equal(result.kind, "scopelease.agent_pair_harness");
  assert.equal(result.mode, "token_only");
  assert.equal(result.summary.measuredPairs, 2);
  assert.ok(result.summary.defaultTokens > 0);
  assert.ok(result.summary.scopeleaseTokens > 0);
  assert.ok(result.summary.defaultDecisionPrompts >= result.summary.scopeleaseDecisionPrompts);
  assert.equal(result.rows[0].events.length, 2);
  assert.equal(result.rows[0].events[0].lane, "default-codex");
  assert.equal(result.rows[0].events[1].lane, "scopelease-codex");
  assert.equal(result.rows[0].events[0].command.status, "not_run");
  assert.equal(result.rows[0].decisionMetrics.measurement, "proxy_until_ui_or_guard_events_are_observed");
  assert.ok(result.rows[0].decisionMetrics.observedCountersToUseInProduct.includes("approval_prompt_count"));
  assert.ok(["interrupt", "review", "silent"].includes(result.rows[0].decisionMetrics.decisionAssistance.surface));
  assert.ok(result.rows[0].decisionMetrics.observedCountersToUseInProduct.includes("recommended_choice"));
  assert.ok(result.rows[0].decisionMetrics.observedCountersToUseInProduct.includes("post_lease_stop_condition"));
  assert.ok(fs.existsSync(path.join(result.outputDir, "summary.json")));
  assert.ok(fs.existsSync(path.join(result.outputDir, "events.jsonl")));
  assert.ok(fs.existsSync(result.rows[0].events[0].promptPath));
  const state = JSON.parse(fs.readFileSync(path.join(root, ".decision", "state.json"), "utf8"));
  assert.ok(state.actualWorkEvents.some((event) => event.source === "pair-harness" && event.lane === "default-codex"));
  assert.ok(state.actualWorkEvents.some((event) => event.source === "pair-harness" && event.lane === "scopelease-codex"));
  const firstRunEvents = state.actualWorkEvents.filter((event) => event.source === "pair-harness");
  assert.ok(firstRunEvents.every((event) => event.runId.startsWith("pair-test-run:")));

  runAgentPairHarness(root, {
    tasksPath,
    runId: "pair-test-run-second",
    repetitions: 1,
    outputDir: path.join(root, ".scopelease", "experiments", "pair-test-run-second")
  });
  const repeatedState = JSON.parse(fs.readFileSync(path.join(root, ".decision", "state.json"), "utf8"));
  const repeatedPairEvents = repeatedState.actualWorkEvents.filter((event) =>
    event.source === "pair-harness" && event.pairId === result.rows[0].pairId
  );
  assert.equal(repeatedPairEvents.length, 4);
  assert.equal(new Set(repeatedPairEvents.map((event) => event.runId)).size, 4);
  const repeatedDetection = detectAgentVisibleUsage({ repoPath: root });
  assert.equal(repeatedDetection.pairedLaneEvidence.status, "needs_pair");
  assert.equal(repeatedDetection.pairedLaneEvidence.eventCounts.default, 0);
  assert.equal(repeatedDetection.pairedLaneEvidence.eventCounts.scopeleaseWork, 0);
});

test("token-only live-observed pair-run writes calibration evidence but is excluded from product-wide real-use average", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-live-observed-pair-"));
  fs.mkdirSync(path.join(root, "project"), { recursive: true });
  fs.writeFileSync(path.join(root, "project", "train.py"), "def train_once():\n    return 1\n".repeat(300));
  const tasksPath = path.join(root, "tasks.jsonl");
  fs.writeFileSync(tasksPath, JSON.stringify({
    id: "live-observed-fixture",
    request: "Review the small training file and summarize the minimum context needed.",
    baselineFiles: ["project/train.py"]
  }) + "\n");

  initRepository(root);
  const result = runAgentPairHarness(root, {
    tasksPath,
    runId: "live-observed-run",
    liveObserved: true,
    repetitions: 1,
    outputDir: path.join(root, ".scopelease", "experiments", "live-observed-run")
  });

  assert.equal(result.observationKind, "live_observed_agent_visible_pair");
  assert.equal(result.claimScope, "live_observed_agent_visible_pair_not_provider_billing");
  const state = loadState(root);
  assert.ok(state.actualWorkEvents.some((event) =>
    event.source === "live-observed-pair-run:default-input" &&
    event.lane === "default-codex"
  ));
  assert.ok(state.actualWorkEvents.some((event) =>
    event.source === "live-observed-pair-run:scopelease-user-input" &&
    event.lane === "scopelease-codex"
  ));
  assert.ok(state.mcpContextEvents.some((event) =>
    event.source === "live-observed-pair-run:scopelease_get_context" &&
    event.tool === "scopelease_get_context" &&
    event.lane === "scopelease-codex"
  ));

  const summary = buildProductWideTokenSummary([root], {
    minRepos: 1,
    minPairs: 1,
    minDefaultTokens: 1
  });
  assert.equal(summary.status, "insufficient_real_use_observed_pairs");
  assert.equal(summary.measuredPairCount, 0);
  assert.equal(summary.strictLiveObservedPairCount, 0);
  assert.equal(summary.controlledProtocol.reposWithControlledProtocol, 0);
  assert.equal(summary.rows[0].observed.status, "needs_pair");
  assert.equal(summary.rows[0].allObservedPairCandidates.length, 0);
});

test("pair harness can run a custom agent adapter command per lane", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-agent-adapter-"));
  fs.mkdirSync(path.join(root, "project"), { recursive: true });
  fs.writeFileSync(path.join(root, "project", "train.py"), "def train_once():\n    return 1\n");
  const tasksPath = path.join(root, "tasks.jsonl");
  fs.writeFileSync(tasksPath, JSON.stringify({
    id: "adapter-fixture",
    request: "Run a custom local agent command against the lane prompt.",
    baselineFiles: ["project/train.py"]
  }) + "\n");

  initRepository(root);
  const result = runAgentPairHarness(root, {
    tasksPath,
    runId: "adapter-test-run",
    repetitions: 1,
    outputDir: path.join(root, ".scopelease", "experiments", "adapter-test-run"),
    agent: "custom",
    agentTemplate: "node -e \"require('fs').writeFileSync('agent-result.txt', process.env.SCOPELEASE_PAIR_LANE)\"",
    copyWorktree: true
  });

  assert.equal(result.mode, "command");
  assert.equal(result.agentAdapters.length, 2);
  for (const event of result.rows[0].events) {
    assert.equal(event.command.status, "passed");
    assert.equal(event.command.adapter.name, "custom");
    assert.equal(event.command.timeoutMs, 0);
    assert.ok(fs.existsSync(event.command.stdoutPath));
    assert.ok(fs.readFileSync(event.command.patchPath, "utf8").includes("agent-result.txt"));
  }
});

test("pair harness resolves Claude binary from env override and local install candidates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-claude-bin-"));
  const promptPath = path.join(root, "prompt.md");
  fs.writeFileSync(promptPath, "Inspect the project.\n");

  const previousClaudeBin = process.env.SCOPELEASE_CLAUDE_BIN;
  const previousHome = process.env.HOME;
  try {
    process.env.SCOPELEASE_CLAUDE_BIN = "/tmp/fake claude";
    const override = resolveLaneCommand({
      lane: "default-codex",
      taskId: "claude-override",
      pairId: "pair-1",
      runId: "run-1",
      workIntent: "inspect project",
      request: "Inspect the project.",
      promptPath,
      workspace: root,
      options: { agent: "claude" }
    });
    assert.match(override.command, /^"\/tmp\/fake claude" -p --output-format json/);

    delete process.env.SCOPELEASE_CLAUDE_BIN;
    const fakeHome = path.join(root, "home");
    const fakeClaude = path.join(fakeHome, ".claude", "local", "bin", "claude");
    fs.mkdirSync(path.dirname(fakeClaude), { recursive: true });
    fs.writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(fakeClaude, 0o755);
    process.env.HOME = fakeHome;

    const detected = resolveLaneCommand({
      lane: "default-codex",
      taskId: "claude-local",
      pairId: "pair-2",
      runId: "run-2",
      workIntent: "inspect project",
      request: "Inspect the project.",
      promptPath,
      workspace: root,
      options: { agent: "claude" }
    });
    assert.match(detected.command, new RegExp(`^${escapeRegExp(JSON.stringify(fakeClaude))} -p --output-format json`));
  } finally {
    if (previousClaudeBin === undefined) delete process.env.SCOPELEASE_CLAUDE_BIN;
    else process.env.SCOPELEASE_CLAUDE_BIN = previousClaudeBin;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("pair harness terminates timed-out command process groups", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-agent-timeout-"));
  fs.writeFileSync(path.join(root, "README.md"), "# Timeout fixture\n");
  const tasksPath = path.join(root, "tasks.jsonl");
  fs.writeFileSync(tasksPath, JSON.stringify({
    id: "timeout-fixture",
    request: "Run a command that should time out quickly.",
    baselineFiles: ["README.md"]
  }) + "\n");

  initRepository(root);
  const previousTimeout = process.env.SCOPELEASE_PAIR_COMMAND_TIMEOUT_MS;
  process.env.SCOPELEASE_PAIR_COMMAND_TIMEOUT_MS = "100";
  try {
    const result = runAgentPairHarness(root, {
      tasksPath,
      runId: "timeout-test-run",
      repetitions: 1,
      outputDir: path.join(root, ".scopelease", "experiments", "timeout-test-run"),
      agent: "custom",
      agentTemplate: `${process.execPath} -e "setTimeout(()=>{}, 30000)"`,
      copyWorktree: true
    });

    assert.equal(result.mode, "command");
    for (const event of result.rows[0].events) {
      assert.equal(event.command.status, "timeout");
      assert.equal(event.command.timeoutMs, 100);
      assert.equal(event.command.processCleanup.status, "attempted");
      assert.ok(event.command.processCleanup.attempts.some((attempt) => attempt.signal === "SIGTERM"));
      assert.equal(event.command.runner.timedOut, true);
    }
  } finally {
    if (previousTimeout === undefined) delete process.env.SCOPELEASE_PAIR_COMMAND_TIMEOUT_MS;
    else process.env.SCOPELEASE_PAIR_COMMAND_TIMEOUT_MS = previousTimeout;
  }
});

test("pair harness command mode copies worktrees by default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-agent-adapter-default-copy-"));
  fs.mkdirSync(path.join(root, "project"), { recursive: true });
  fs.writeFileSync(path.join(root, "project", "train.py"), "def train_once():\n    return 1\n");
  const tasksPath = path.join(root, "tasks.jsonl");
  fs.writeFileSync(tasksPath, JSON.stringify({
    id: "adapter-default-copy",
    request: "Run a custom local agent command in an isolated lane workspace.",
    baselineFiles: ["project/train.py"]
  }) + "\n");

  initRepository(root);
  const result = runAgentPairHarness(root, {
    tasksPath,
    runId: "adapter-default-copy-run",
    repetitions: 1,
    outputDir: path.join(root, ".scopelease", "experiments", "adapter-default-copy-run"),
    agent: "custom",
    agentTemplate: "node -e \"require('fs').writeFileSync('agent-result.txt', process.env.SCOPELEASE_PAIR_LANE)\""
  });

  assert.equal(result.mode, "command");
  assert.equal(fs.existsSync(path.join(root, "agent-result.txt")), false);
  for (const event of result.rows[0].events) {
    assert.equal(event.command.status, "passed");
    assert.notEqual(path.resolve(event.command.cwd), path.resolve(root));
    assert.ok(event.command.cwd.includes("scopelease-pair-worktrees"));
    assert.equal(event.command.adapter.name, "custom");
    assert.ok(fs.readFileSync(event.command.patchPath, "utf8").includes("agent-result.txt"));
  }
});

test("pair-run CLI preserves command-mode worktree isolation by default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-cli-pair-default-copy-"));
  fs.mkdirSync(path.join(root, "project"), { recursive: true });
  fs.writeFileSync(path.join(root, "project", "train.py"), "def train_once():\n    return 1\n");
  const tasksPath = path.join(root, "tasks.jsonl");
  fs.writeFileSync(tasksPath, JSON.stringify({
    id: "cli-default-copy",
    request: "Run a custom local agent command through the CLI pair-run path.",
    baselineFiles: ["project/train.py"]
  }) + "\n");

  initRepository(root);
  const cli = path.resolve("src/cli.js");
  const output = execFileSync(process.execPath, [
    cli,
    "pair-run",
    root,
    "--tasks",
    tasksPath,
    "--run-id",
    "cli-default-copy-run",
    "--output",
    path.join(root, ".scopelease", "experiments", "cli-default-copy-run"),
    "--agent",
    "custom",
    "--agent-template",
    "node -e \"require('fs').writeFileSync('cli-agent-result.txt', process.env.SCOPELEASE_PAIR_LANE)\"",
    "--format",
    "json"
  ], { encoding: "utf8" });
  const result = JSON.parse(output);

  assert.equal(result.mode, "command");
  assert.equal(fs.existsSync(path.join(root, "cli-agent-result.txt")), false);
  for (const event of result.rows[0].events) {
    assert.equal(event.command.status, "passed");
    assert.notEqual(path.resolve(event.command.cwd), path.resolve(root));
    assert.ok(event.command.cwd.includes("scopelease-pair-worktrees"));
  }
});

test("Codex live-observed default lane is a C0 baseline", () => {
  const base = {
    task: {},
    taskId: "codex-lane-template",
    pairId: "pair-template",
    request: "Run the same task in both lanes.",
    promptPath: "/tmp/scopelease-prompt.md",
    workspace: "/tmp/scopelease-workspace",
    options: {
      liveObserved: true,
      defaultAgent: "codex",
      scopeleaseAgent: "codex"
    }
  };
  const defaultCommand = resolveLaneCommand({ ...base, lane: "default-codex" });
  const scopeleaseCommand = resolveLaneCommand({ ...base, lane: "scopelease-codex" });

  assert.match(defaultCommand.command, /^codex exec /);
  assert.match(defaultCommand.command, /--ignore-user-config/);
  assert.doesNotMatch(defaultCommand.command, /mcp_servers\.scopelease/);
  assert.doesNotMatch(defaultCommand.command, /--enable hooks/);
  assert.match(scopeleaseCommand.command, /^codex exec /);
  assert.match(scopeleaseCommand.command, /--ignore-user-config/);
  assert.match(scopeleaseCommand.command, /--enable hooks/);
  assert.match(scopeleaseCommand.command, /mcp_servers\.scopelease/);
  assert.match(scopeleaseCommand.command, /mcp_servers\.scopelease\.default_tools_approval_mode="approve"/);
  assert.match(scopeleaseCommand.command, /shell_environment_policy\.inherit="all"/);
});

test("live-observed command mode imports copied-worktree hook and MCP events", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-live-command-import-"));
  fs.mkdirSync(path.join(root, "project"), { recursive: true });
  fs.writeFileSync(path.join(root, "project", "train.py"), "def train_once():\n    return 1\n");
  const tasksPath = path.join(root, "tasks.jsonl");
  fs.writeFileSync(tasksPath, JSON.stringify({
    id: "live-command-import",
    request: "Run a live observed command-mode pair and import copied worktree hook events.",
    baselineFiles: ["project/train.py"]
  }) + "\n");

  initRepository(root);
  const result = runAgentPairHarness(root, {
    tasksPath,
    runId: "live-command-import-run",
    repetitions: 1,
    liveObserved: true,
    outputDir: path.join(root, ".scopelease", "experiments", "live-command-import-run"),
    agent: "custom",
    agentTemplate: "node -e \"const fs=require('fs'),path=require('path');const root=process.cwd();const dir=path.join(root,'.decision');fs.mkdirSync(dir,{recursive:true});const p=path.join(dir,'state.json');let s={};try{s=JSON.parse(fs.readFileSync(p,'utf8'))}catch{}const lane=process.env.SCOPELEASE_PAIR_LANE;const base={kind:'scopelease.actual_work_event',id:'hook-'+lane,timestamp:'2026-05-17T00:00:00.000Z',lane,source:'codex-hook:user-prompt',phase:'input',tokens:lane==='default-codex'?120:40,pairId:process.env.SCOPELEASE_PAIR_ID,runId:process.env.SCOPELEASE_RUN_ID,workIntent:process.env.SCOPELEASE_WORK_INTENT};s.actualWorkEvents=[base,...(s.actualWorkEvents||[])];if(lane==='scopelease-codex')s.mcpContextEvents=[{kind:'scopelease.mcp_context_event',id:'mcp-'+lane,timestamp:'2026-05-17T00:00:01.000Z',lane:'scopelease-codex',source:'mcp',tool:'scopelease_get_context',tokens:60,pairId:process.env.SCOPELEASE_PAIR_ID,runId:process.env.SCOPELEASE_RUN_ID,workIntent:process.env.SCOPELEASE_WORK_INTENT},...(s.mcpContextEvents||[])];fs.writeFileSync(p,JSON.stringify(s,null,2))\""
  });

  assert.equal(result.mode, "command");
  for (const event of result.rows[0].events) {
    assert.equal(event.command.status, "passed");
    assert.equal(event.command.attach.status, "passed");
    assert.ok(fs.existsSync(path.join(event.command.cwd, ".codex", "hooks.json")));
    assert.equal(event.command.observedImport.status, "imported");
    assert.ok(event.command.observedImport.actualWorkEvents >= 1);
  }

  const state = loadState(root);
  assert.ok(state.actualWorkEvents.some((event) =>
    event.source === "codex-hook:user-prompt" &&
    event.lane === "default-codex" &&
    event.importedFromWorkspace
  ));
  assert.ok(state.actualWorkEvents.some((event) =>
    event.source === "codex-hook:user-prompt" &&
    event.lane === "scopelease-codex" &&
    event.importedFromWorkspace
  ));
  assert.ok(state.mcpContextEvents.some((event) =>
    event.source === "mcp" &&
    event.tool === "scopelease_get_context" &&
    event.importedFromWorkspace
  ));
  assert.equal(state.actualWorkEvents.some((event) =>
    String(event.source || "").startsWith("live-observed-pair-run:")
  ), false);

  const summary = buildProductWideTokenSummary([root], {
    minRepos: 1,
    minPairs: 1,
    minDefaultTokens: 1
  });
  assert.ok(["claim_ready", "delta_ready_no_savings"].includes(summary.status));
  assert.equal(summary.strictLiveObservedPairCount, 1);
});

test("live-observed import accepts MCP events by exact pair id when work intent metadata differs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-live-command-import-pairid-"));
  fs.writeFileSync(path.join(root, "README.md"), "# Pair id import\n");
  const tasksPath = path.join(root, "tasks.jsonl");
  fs.writeFileSync(tasksPath, JSON.stringify({
    id: "pairid-import",
    request: "Use MCP context and summarize README.md.",
    baselineFiles: ["README.md"]
  }) + "\n");

  initRepository(root);
  const result = runAgentPairHarness(root, {
    tasksPath,
    runId: "pairid-import-run",
    repetitions: 1,
    liveObserved: true,
    outputDir: path.join(root, ".scopelease", "experiments", "pairid-import-run"),
    agent: "custom",
    agentTemplate: "node -e \"const fs=require('fs'),path=require('path');const root=process.cwd();const dir=path.join(root,'.decision');fs.mkdirSync(dir,{recursive:true});const p=path.join(dir,'state.json');let s={};try{s=JSON.parse(fs.readFileSync(p,'utf8'))}catch{}const lane=process.env.SCOPELEASE_PAIR_LANE;if(lane==='scopelease-codex')s.mcpContextEvents=[{kind:'scopelease.mcp_context_event',id:'mcp-metadata-drift',timestamp:'2026-05-17T00:00:01.000Z',lane:'scopelease-codex',source:'mcp',tool:'scopelease_get_context',tokens:60,pairId:process.env.SCOPELEASE_PAIR_ID,runId:'workspace-local-run-id',workIntent:'workspace-local-intent'},...(s.mcpContextEvents||[])];fs.writeFileSync(p,JSON.stringify(s,null,2));process.stdout.write('README.md ok');process.stderr.write('tokens used\\n100\\n')\""
  });

  const scopeleaseEvent = result.rows[0].events.find((event) => event.lane === "scopelease-codex");
  assert.equal(scopeleaseEvent.command.observedImport.status, "imported");
  assert.equal(scopeleaseEvent.command.observedImport.mcpContextEvents, 1);
  const state = loadState(root);
  assert.ok(state.mcpContextEvents.some((event) =>
    event.importSourceId === "mcp-metadata-drift" &&
    event.pairId === result.rows[0].pairId
  ));
});

test("live-observed command mode records actual command prompt bytes when hooks are unavailable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-live-command-prompt-observed-"));
  fs.writeFileSync(path.join(root, "README.md"), `# Prompt observed\n\n${"Long baseline project note.\n".repeat(240)}`);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "prompt-observed" }, null, 2));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "unrelated.js"), "export const unrelated = true;\n");
  fs.mkdirSync(path.join(root, "dist", "App.app"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "App.app", "large-generated.txt"), "generated\n".repeat(100));
  fs.mkdirSync(path.join(root, "build"), { recursive: true });
  fs.writeFileSync(path.join(root, "build", "bundle.js"), "generated\n");
  fs.mkdirSync(path.join(root, "__MACOSX"), { recursive: true });
  fs.writeFileSync(path.join(root, "__MACOSX", "metadata"), "generated\n");
  fs.writeFileSync(path.join(root, ".DS_Store"), "generated\n");
  const tasksPath = path.join(root, "tasks.jsonl");
  fs.writeFileSync(tasksPath, JSON.stringify({
    id: "prompt-observed",
    request: "Review README.md and package.json. Summarize the project.",
    baselineFiles: ["README.md", "package.json"]
  }) + "\n");

  initRepository(root);
  const result = runAgentPairHarness(root, {
    tasksPath,
    runId: "prompt-observed-run",
    repetitions: 1,
    liveObserved: true,
    outputDir: path.join(root, ".scopelease", "experiments", "prompt-observed-run"),
    agent: "custom",
    agentTemplate: "node -e \"process.stdout.write('README.md package.json ok');process.stderr.write('tokens used\\n'+(process.env.SCOPELEASE_PAIR_LANE==='default-codex'?'1000':'250')+'\\n')\"",
    scopeleaseWorkspaceMode: "scoped"
  });

  assert.equal(result.mode, "command");
  const [defaultEvent, scopeleaseEvent] = result.rows[0].events;
  assert.equal(defaultEvent.command.promptObservation.status, "recorded");
  assert.equal(defaultEvent.command.promptObservation.scopeleaseContextEmbedded, false);
  assert.equal(defaultEvent.command.reportedTotalTokens, 1000);
  assert.equal(scopeleaseEvent.command.promptObservation.status, "recorded");
  assert.equal(scopeleaseEvent.command.promptObservation.scopeleaseContextEmbedded, true);
  assert.ok(scopeleaseEvent.command.promptObservation.scopeleaseContextTokens > 0);
  assert.equal(scopeleaseEvent.command.reportedTotalTokens, 250);
  assert.equal(result.rows[0].commandReportedTotalTokens.status, "measured");
  assert.equal(result.rows[0].commandReportedTotalTokens.savedPercent, 75);
  assert.equal(result.summary.commandReportedTotalTokens.measuredPairs, 1);
  assert.equal(result.summary.commandReportedTotalTokens.savedPercent, 75);
  assert.equal(result.summary.commandReportedTotalTokens.macroMeanSavedPercent, 75);
  assert.equal(result.summary.commandReportedTotalTokens.distribution.median, 75);
  assert.equal(defaultEvent.command.quality.status, "quality_pass");
  assert.equal(scopeleaseEvent.command.quality.status, "quality_pass");
  assert.equal(result.summary.commandQuality.measuredLanes, 2);
  assert.equal(result.summary.commandQuality.passRate, 100);
  assert.equal(defaultEvent.command.workspaceMode, "full");
  assert.equal(scopeleaseEvent.command.workspaceMode, "scoped_readplan");
  assert.ok(fs.existsSync(path.join(defaultEvent.command.cwd, "src", "unrelated.js")));
  assert.equal(fs.existsSync(path.join(scopeleaseEvent.command.cwd, "src", "unrelated.js")), false);
  assert.ok(fs.existsSync(path.join(scopeleaseEvent.command.cwd, "README.md")));
  assert.ok(fs.existsSync(path.join(scopeleaseEvent.command.cwd, "package.json")));
  assert.ok(fs.existsSync(path.join(scopeleaseEvent.command.cwd, ".scopelease-workspace-scope.json")));
  for (const event of [defaultEvent, scopeleaseEvent]) {
    assert.equal(fs.existsSync(path.join(event.command.cwd, "dist")), false);
    assert.equal(fs.existsSync(path.join(event.command.cwd, "build")), false);
    assert.equal(fs.existsSync(path.join(event.command.cwd, "__MACOSX")), false);
    assert.equal(fs.existsSync(path.join(event.command.cwd, ".DS_Store")), false);
  }

  const state = loadState(root);
  assert.ok(state.actualWorkEvents.some((event) =>
    event.source === "agent-command:prompt" &&
    event.lane === "default-codex" &&
    event.pairId === result.rows[0].pairId &&
    event.promptPath &&
    /^sha1:/.test(event.promptHash || "")
  ));
  assert.ok(state.actualWorkEvents.some((event) =>
    event.source === "agent-command:prompt" &&
    event.lane === "scopelease-codex" &&
    event.scopeleaseContextEmbedded === true &&
    event.pairId === result.rows[0].pairId &&
    event.promptPath &&
    /^sha1:/.test(event.promptHash || "")
  ));

  const summary = buildProductWideTokenSummary([root], {
    minRepos: 1,
    minPairs: 1,
    minDefaultTokens: 1
  });
  assert.equal(summary.status, "claim_ready");
  assert.equal(summary.rows[0].observed.observedContextMode, "embedded_scopelease_context_prompt");
  assert.equal(summary.rows[0].observed.sourceBoundary, "agent_command_prompt_observed_payloads");
});

test("pair harness measures task-specific completion tokens and attempts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-completion-token-pair-"));
  fs.writeFileSync(path.join(root, "README.md"), "# Completion pair\n");
  const agentScript = path.join(os.tmpdir(), `scopelease-completion-agent-${Date.now()}.js`);
  fs.writeFileSync(agentScript, `
const fs = require("node:fs");
const lane = process.env.SCOPELEASE_PAIR_LANE || "";
fs.writeFileSync("submission.csv", "id,target\\n1,0.81\\n2,0.22\\n");
const attempts = lane === "default-codex" ? "attempts used: \`2\`" : "attempts=1";
process.stdout.write("README.md validation_auc=0.730 " + attempts + "\\n");
process.stderr.write("tokens used\\n" + (lane === "default-codex" ? "1200" : "700") + "\\n");
`);
  const tasksPath = path.join(root, "tasks.jsonl");
  fs.writeFileSync(tasksPath, JSON.stringify({
    id: "completion-valid-submission",
    category: "mle_benchmark_like",
    request: "Create a valid Kaggle-style submission.csv and report validation_auc.",
    baselineFiles: ["README.md"],
    completion: {
      requiredFiles: ["submission.csv"],
      csv: {
        path: "submission.csv",
        requiredColumns: ["id", "target"],
        minRows: 2
      },
      score: {
        pattern: "validation_auc=([0-9.]+)",
        target: 0.7,
        higherIsBetter: true
      },
      attemptsPattern: "attempts=([0-9]+)"
    }
  }) + "\n");

  initRepository(root);
  const result = runAgentPairHarness(root, {
    tasksPath,
    runId: "completion-token-run",
    liveObserved: true,
    outputDir: path.join(root, ".scopelease", "experiments", "completion-token-run"),
    agentTemplate: `${JSON.stringify(process.execPath)} ${JSON.stringify(agentScript)}`,
    scopeleaseWorkspaceMode: "scoped"
  });

  const row = result.rows[0];
  const [defaultEvent, scopeleaseEvent] = row.events;
  assert.equal(defaultEvent.command.completion.status, "passed");
  assert.equal(scopeleaseEvent.command.completion.status, "passed");
  assert.equal(row.taskCompletion.status, "both_completed");
  assert.equal(row.taskCompletion.tokensToCompletion.defaultTokens, 1200);
  assert.equal(row.taskCompletion.tokensToCompletion.scopeleaseTokens, 700);
  assert.equal(row.taskCompletion.tokensToCompletion.savedPercent, 41.67);
  assert.equal(row.taskCompletion.attemptsToCompletion.defaultAttempts, 2);
  assert.equal(row.taskCompletion.attemptsToCompletion.scopeleaseAttempts, 1);
  assert.equal(result.summary.taskCompletion.measuredPairs, 1);
  assert.equal(result.summary.taskCompletion.bothCompletedPairs, 1);
  assert.equal(result.summary.taskCompletion.completionTokenPairs, 1);
  assert.equal(result.summary.taskCompletion.tokensToCompletion.savedTokens, 500);
  assert.equal(result.summary.taskCompletion.tokensToCompletion.savedPercent, 41.67);
  assert.equal(result.summary.taskCompletion.attemptsToCompletion.savedAttempts, 1);
  assert.equal(result.summary.taskCompletion.attemptsToCompletion.savedPercent, 50);
});

test("pair harness can precreate scoped ScopeLease approval leases for command pairs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-preapproved-pair-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "# Preapproved pair\n");
  fs.writeFileSync(path.join(root, "src/app.js"), "export const value = 1;\n");
  initRepository(root);

  const agentScript = path.join(os.tmpdir(), `scopelease-preapproved-agent-${Date.now()}.js`);
  fs.writeFileSync(agentScript, `
const fs = require("node:fs");
const path = require("node:path");
const lane = process.env.SCOPELEASE_PAIR_LANE || "";
let leaseId = "none";
try {
  const state = JSON.parse(fs.readFileSync(path.join(".decision", "state.json"), "utf8"));
  const lease = (state.approvalLeases || []).find((item) => item.grantedBy === "pair-harness-preapproval");
  if (lease) leaseId = lease.id;
} catch {}
process.stdout.write("lane=" + lane + " lease=" + leaseId + "\\n");
process.stderr.write("tokens used\\n" + (lane === "default-codex" ? "900" : "600") + "\\n");
`);
  const tasksPath = path.join(root, "tasks.jsonl");
  fs.writeFileSync(tasksPath, JSON.stringify({
    id: "preapproved-edit",
    request: "Update src/app.js with a scoped patch.",
    baselineFiles: ["src/app.js"],
    approvalFiles: ["src/app.js"]
  }) + "\n");

  const result = runAgentPairHarness(root, {
    tasksPath,
    runId: "preapproved-pair-run",
    liveObserved: true,
    outputDir: path.join(root, ".scopelease", "experiments", "preapproved-pair-run"),
    agentTemplate: `${JSON.stringify(process.execPath)} ${JSON.stringify(agentScript)}`,
    scopeleaseWorkspaceMode: "scoped",
    scopeleasePreapprove: true
  });

  const row = result.rows[0];
  const defaultEvent = row.events.find((event) => event.lane === "default-codex");
  const scopeleaseEvent = row.events.find((event) => event.lane === "scopelease-codex");
  assert.equal(defaultEvent.command.preapproval.status, "skipped");
  assert.equal(scopeleaseEvent.command.preapproval.status, "created");
  assert.match(scopeleaseEvent.command.stdoutTail, /lease=lease_/);

  const workspaceState = loadState(scopeleaseEvent.command.cwd);
  const lease = (workspaceState.approvalLeases || []).find((item) => item.id === scopeleaseEvent.command.preapproval.leaseId);
  assert.ok(lease);
  const analysis = analyzeRepository(scopeleaseEvent.command.cwd, {
    userRequest: "Update src/app.js with a scoped patch."
  });
  const verdict = evaluateAgentAction({
    action: { kind: "apply_patch", paths: ["src/app.js"] },
    analysis,
    state: workspaceState
  });
  assert.equal(verdict.verdict, "allow_with_log");
  assert.equal(verdict.leaseId, lease.id);
});

test("minimal ScopeLease live prompt keeps token-efficiency input separate from MCP context", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-minimal-live-prompt-"));
  fs.writeFileSync(path.join(root, "README.md"), "# Minimal prompt\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "minimal-prompt" }, null, 2));
  const tasksPath = path.join(root, "tasks.jsonl");
  fs.writeFileSync(tasksPath, JSON.stringify({
    id: "minimal-prompt",
    request: "Review README.md and package.json. Summarize the project.",
    baselineFiles: ["README.md", "package.json"]
  }) + "\n");

  initRepository(root);
  const result = runAgentPairHarness(root, {
    tasksPath,
    runId: "minimal-live-prompt-run",
    liveObserved: true,
    liveObservedCommandMode: "minimal",
    outputDir: path.join(root, ".scopelease", "experiments", "minimal-live-prompt-run"),
    agent: "custom",
    agentTemplate: "node -e \"process.stdout.write('README.md package.json ok');process.stderr.write('tokens used\\n'+(process.env.SCOPELEASE_PAIR_LANE==='default-codex'?'900':'300')+'\\n')\"",
    scopeleaseWorkspaceMode: "scoped",
    workspaceScopeSource: "task"
  });

  const scopeleaseEvent = result.rows[0].events.find((event) => event.lane === "scopelease-codex");
  const prompt = fs.readFileSync(scopeleaseEvent.promptPath, "utf8");
  assert.match(prompt, /ScopeLease minimal task-scope instruction/);
  assert.match(prompt, /no compact KG context is embedded/);
  assert.doesNotMatch(prompt, /ScopeLease compact context/);
  assert.doesNotMatch(prompt, /scopelease_get_context is available, you may call it/);
  assert.equal(scopeleaseEvent.command.promptObservation.scopeleaseContextEmbedded, false);
  assert.equal(scopeleaseEvent.command.promptObservation.scopeleaseContextTokens, 0);
});

test("MCP ScopeLease live prompt requires context call at lane start", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-mcp-live-prompt-"));
  fs.writeFileSync(path.join(root, "README.md"), "# MCP prompt\n");
  const tasksPath = path.join(root, "tasks.jsonl");
  fs.writeFileSync(tasksPath, JSON.stringify({
    id: "mcp-prompt",
    request: "Summarize README.md without changing files.",
    baselineFiles: ["README.md"]
  }) + "\n");

  initRepository(root);
  const result = runAgentPairHarness(root, {
    tasksPath,
    runId: "mcp-live-prompt-run",
    liveObserved: true,
    liveObservedCommandMode: "mcp",
    outputDir: path.join(root, ".scopelease", "experiments", "mcp-live-prompt-run"),
    agent: "custom",
    agentTemplate: "node -e \"process.stdout.write('README.md ok');process.stderr.write('tokens used\\n120\\n')\"",
    scopeleaseWorkspaceMode: "scoped",
    workspaceScopeSource: "task"
  });

  const scopeleaseEvent = result.rows[0].events.find((event) => event.lane === "scopelease-codex");
  const prompt = fs.readFileSync(scopeleaseEvent.promptPath, "utf8");
  assert.match(prompt, /At the start of this ScopeLease lane, call the project MCP tool scopelease_get_context/);
  assert.doesNotMatch(prompt, /Before broad repository reads, call the project MCP tool scopelease_get_context/);
  assert.match(prompt, /before reading or changing files/);
});

test("lean ScopeLease live prompt reduces harness overhead and auto scope widens only for broad tasks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-lean-live-prompt-"));
  fs.writeFileSync(path.join(root, "README.md"), "# Lean prompt\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "lean-prompt" }, null, 2));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/app.js"), "export const app = true;\n");
  const tasksPath = path.join(root, "tasks.jsonl");
  fs.writeFileSync(tasksPath, [
    JSON.stringify({
      id: "lean-focused",
      category: "permission_workflow",
      request: "Review README.md only and summarize the visible change.",
      baselineFiles: ["README.md"]
    }),
    JSON.stringify({
      id: "lean-architecture",
      category: "architecture_review",
      request: "Review the project architecture and entry points.",
      baselineFiles: ["README.md"]
    })
  ].join("\n") + "\n");

  initRepository(root);
  const result = runAgentPairHarness(root, {
    tasksPath,
    runId: "lean-live-prompt-run",
    liveObserved: true,
    liveObservedCommandMode: "lean",
    outputDir: path.join(root, ".scopelease", "experiments", "lean-live-prompt-run"),
    agent: "custom",
    agentTemplate: "node -e \"process.stdout.write('ok');process.stderr.write('tokens used\\n300\\n')\"",
    scopeleaseWorkspaceMode: "scoped",
    workspaceScopeSource: "auto"
  });

  const focusedScopeLease = result.rows.find((row) => row.taskId === "lean-focused").events.find((event) => event.lane === "scopelease-codex");
  const broadScopeLease = result.rows.find((row) => row.taskId === "lean-architecture").events.find((event) => event.lane === "scopelease-codex");
  const focusedPrompt = fs.readFileSync(focusedScopeLease.promptPath, "utf8");
  assert.match(focusedPrompt, /ScopeLease lean scope/);
  assert.doesNotMatch(focusedPrompt, /ScopeLease compact context/);
  assert.doesNotMatch(focusedPrompt, /Measurement boundary/);
  assert.doesNotMatch(focusedPrompt, /Visible files/);
  assert.equal(focusedScopeLease.command.promptObservation.scopeleaseContextEmbedded, false);
  assert.equal(focusedScopeLease.command.promptObservation.scopeleaseContextTokens, 0);
  assert.equal(focusedScopeLease.command.workspaceScopeFiles.includes("package.json"), false);
  assert.ok(broadScopeLease.command.workspaceScopeFiles.includes("package.json"));
});

test("pair harness supports natural request-only default baseline", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-natural-default-baseline-"));
  fs.writeFileSync(path.join(root, "README.md"), `# Natural baseline\n\n${"Large default-only body.\n".repeat(180)}`);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "natural-default" }, null, 2));
  const tasksPath = path.join(root, "tasks.jsonl");
  fs.writeFileSync(tasksPath, JSON.stringify({
    id: "natural-default",
    request: "Review README.md and summarize the project.",
    baselineFiles: ["README.md", "package.json"]
  }) + "\n");

  initRepository(root);
  const explicit = runAgentPairHarness(root, {
    tasksPath,
    runId: "explicit-default-run",
    outputDir: path.join(root, ".scopelease", "experiments", "explicit-default-run")
  });
  const natural = runAgentPairHarness(root, {
    tasksPath,
    runId: "natural-default-run",
    outputDir: path.join(root, ".scopelease", "experiments", "natural-default-run"),
    defaultInputMode: "natural"
  });

  const explicitPrompt = fs.readFileSync(explicit.rows[0].events[0].promptPath, "utf8");
  const naturalPrompt = fs.readFileSync(natural.rows[0].events[0].promptPath, "utf8");
  assert.equal(natural.rows[0].defaultInputMode, "natural_request");
  assert.ok(explicitPrompt.includes("Large default-only body."));
  assert.equal(naturalPrompt.includes("Large default-only body."), false);
  assert.ok(naturalPrompt.includes("No baseline file bodies are preloaded"));
  assert.ok(natural.rows[0].defaultTokens < explicit.rows[0].defaultTokens);
});

test("command quality requires missing-context-free output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-quality-missing-context-"));
  fs.writeFileSync(path.join(root, "README.md"), "# Missing context quality\n");
  const tasksPath = path.join(root, "tasks.jsonl");
  fs.writeFileSync(tasksPath, JSON.stringify({
    id: "missing-context-quality",
    request: "Review README.md and summarize the project.",
    baselineFiles: ["README.md"]
  }) + "\n");

  initRepository(root);
  const result = runAgentPairHarness(root, {
    tasksPath,
    runId: "missing-context-quality-run",
    liveObserved: true,
    outputDir: path.join(root, ".scopelease", "experiments", "missing-context-quality-run"),
    agent: "custom",
    agentTemplate: "node -e \"process.stdout.write('README.md missing context');process.stderr.write('tokens used\\n100\\n')\"",
    scopeleaseWorkspaceMode: "scoped"
  });

  const [defaultEvent, scopeleaseEvent] = result.rows[0].events;
  assert.equal(defaultEvent.command.quality.status, "quality_review");
  assert.equal(scopeleaseEvent.command.quality.status, "quality_review");
  assert.equal(result.summary.commandQuality.passedLanes, 0);
  assert.equal(result.summary.commandQuality.reviewNeededLanes, 2);
  assert.equal(result.summary.commandQuality.missingContextSignalLanes, 2);
});

test("failed command output cannot be a measured quality or savings pass", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-failed-command-quality-"));
  fs.writeFileSync(path.join(root, "README.md"), "# Failed command quality\n");
  const tasksPath = path.join(root, "tasks.jsonl");
  fs.writeFileSync(tasksPath, JSON.stringify({
    id: "failed-command-quality",
    request: "Review README.md and summarize the project.",
    baselineFiles: ["README.md"]
  }) + "\n");

  initRepository(root);
  const result = runAgentPairHarness(root, {
    tasksPath,
    runId: "failed-command-quality-run",
    liveObserved: true,
    outputDir: path.join(root, ".scopelease", "experiments", "failed-command-quality-run"),
    defaultAgentTemplate: "node -e \"process.stdout.write('README.md useful output');process.exit(1)\"",
    scopeleaseAgentTemplate: "node -e \"process.stdout.write('README.md useful output');process.stderr.write('tokens used\\n100\\n')\"",
    scopeleaseWorkspaceMode: "scoped"
  });

  const [defaultEvent, scopeleaseEvent] = result.rows[0].events;
  assert.equal(defaultEvent.command.status, "failed");
  assert.equal(defaultEvent.command.quality.status, "quality_review");
  assert.equal(scopeleaseEvent.command.quality.status, "quality_pass");
  assert.equal(result.rows[0].commandReportedTotalTokens.status, "incomplete");
  assert.equal(result.summary.commandReportedTotalTokens.measuredPairs, 0);
  assert.equal(result.summary.commandQuality.passedLanes, 1);
  assert.equal(result.summary.commandQuality.reviewNeededLanes, 1);
});

test("CLI table output labels signed token differences as delta", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-cli-delta-labels-"));
  fs.mkdirSync(path.join(root, "project"), { recursive: true });
  fs.writeFileSync(path.join(root, "project", "train.py"), "def train_once():\n    return 1\n");
  const tasksPath = path.join(root, "tasks.jsonl");
  fs.writeFileSync(tasksPath, JSON.stringify({
    id: "cli-delta-labels",
    request: "Inspect the small training file and report the minimal change.",
    baselineFiles: ["project/train.py"]
  }) + "\n");

  initRepository(root);
  const cli = path.resolve("src/cli.js");
  const benchOutput = execFileSync(process.execPath, [
    cli,
    "bench-tokens",
    root,
    "--tasks",
    tasksPath
  ], { encoding: "utf8" });
  assert.match(benchOutput, /ScopeLease bench token delta/);
  assert.match(benchOutput, /positive values are savings/);
  assert.doesNotMatch(benchOutput, /· saved /);
  assert.doesNotMatch(benchOutput, /\tsaved\t/);

  const pairOutput = execFileSync(process.execPath, [
    cli,
    "pair-run",
    root,
    "--tasks",
    tasksPath,
    "--run-id",
    "cli-delta-labels-run",
    "--output",
    path.join(root, ".scopelease", "experiments", "cli-delta-labels-run")
  ], { encoding: "utf8" });
  assert.match(pairOutput, /ScopeLease pair-run .*positive token delta is savings/);
  assert.doesNotMatch(pairOutput, /· saved /);
  assert.doesNotMatch(pairOutput, /\tsaved\t/);
});

test("permission fixture runner compares expected guard verdicts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-permission-fixtures-"));
  fs.mkdirSync(path.join(root, "src/auth"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/other"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/auth/session.ts"), `
export function validateToken(token: string) {
  return token ? { id: "u1" } : null;
}
`);
  fs.writeFileSync(path.join(root, "src/other/file.ts"), "export const value = 1;\n");
  initRepository(root);
  fs.writeFileSync(path.join(root, "src/auth/session.ts"), `
export function validateToken(token: string) {
  return token && token.length > 4 ? { id: "u1", token } : null;
}
`);
  const fixturesPath = path.join(root, "permission-fixtures.jsonl");
  fs.writeFileSync(fixturesPath, [
    {
      id: "read_auth_file",
      request: "Read the auth file before editing.",
      action: { kind: "read", path: "src/auth/session.ts" },
      expected: { verdict: "allow_with_log", humanPrompt: false }
    },
    {
      id: "patch_requires_approval",
      request: "Patch auth session validation.",
      action: { type: "patch", files: ["src/auth/session.ts"], risk: "high" },
      expected: { verdict: "ask_once", humanPrompt: true }
    },
    {
      id: "lease_reuse",
      request: "Reuse scoped approval for auth session validation.",
      setup: { approveChoice: "allow_scoped_patch" },
      action: { type: "patch", files: ["src/auth/session.ts"], risk: "high" },
      expected: { verdict: "allow_with_log", humanPrompt: false, leaseRequired: true }
    },
    {
      id: "lease_scope_expansion_requires_new_approval",
      request: "Reuse scoped approval for a different file.",
      setup: {
        approveChoice: "allow_scoped_patch",
        action: { type: "patch", files: ["src/auth/session.ts"], risk: "high" }
      },
      action: { type: "patch", files: ["src/other/file.ts"], risk: "high" },
      expected: { verdict: "ask_once", humanPrompt: true, leaseRequired: false }
    },
    {
      id: "network_denied",
      request: "Fetch remote dependency.",
      action: { kind: "network", target: "https://example.com" },
      expected: { verdict: "deny", humanPrompt: false }
    }
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");

  const result = runPermissionFixtureSuite(root, {
    fixturesPath,
    runId: "permission-test-run",
    outputDir: path.join(root, ".scopelease", "fixtures", "runs", "permission-test-run"),
    "no-record-state": true
  });

  assert.equal(result.kind, "scopelease.permission_fixture_run");
  assert.equal(result.summary.total, 5);
  assert.equal(result.summary.failed, 0);
  assert.equal(result.summary.passRate, 100);
  assert.equal(result.summary.confusion.counts.unsafeFalseAllow, 0);
  assert.equal(result.summary.confusion.counts.falseBlock, 0);
  assert.equal(result.summary.confusion.matrix.deny.deny, 1);
  assert.equal(result.summary.confusion.matrix.ask_once.ask_once, 2);
  assert.equal(result.isolated, true);
  assert.ok(fs.existsSync(path.join(result.outputDir, "summary.json")));
  assert.ok(fs.existsSync(path.join(result.outputDir, "results.jsonl")));
  assert.ok(result.results.find((row) => row.id === "lease_reuse").actual.leaseId);
});

test("deriveWorkIntent canonicalizes raw requests and ScopeLease prompt input", () => {
  const request = "Finding 1 src/runtime/mcp-server.js workIntent pair 연결을 고쳐줘.";
  const scopeleaseInput = `User request:\n${request}\n\nScopeLease context:\n{\"readPlan\":[\"src/runtime/mcp-server.js\"]}\n`;
  const intent = deriveWorkIntent({ request });

  assert.equal(deriveWorkIntent({ text: scopeleaseInput }), intent);
  assert.equal(deriveWorkIntent({ userRequest: { text: request } }), intent);
  assert.match(intent, /src\/runtime\/mcp-server\.js/);
  assert.match(intent, /finding-1/);
  assert.match(intent, /workintent/);
  assert.match(requestHash(request), /^sha1:[a-f0-9]{40}$/);
  const taskIntent = buildTaskIntent({ request }, { pairId: "pair:test" });
  assert.equal(taskIntent.kind, "scopelease.semantic_task_intent");
  assert.equal(taskIntent.pairing.pairingKey, intent);
  assert.equal(taskIntent.pairing.pairId, "pair:test");
  assert.ok(taskIntent.targetArtifacts.includes("src/runtime/mcp-server.js"));
  assert.equal(taskIntent.permissionNeed.read, true);
  assert.equal(taskIntent.permissionNeed.humanApprovalBeforeApply, true);
  assert.ok(taskIntent.successCriteria.length > 0);
});

test("observed pair delta keeps negative regressions and latest pair run", () => {
  const analysis = {
    userRequest: "negative savings should not be clamped",
    contextPack: {
      userRequest: { text: "negative savings should not be clamped" }
    }
  };
  const pair = buildObservedWorkIntentSavings({
    analysis,
    pairId: "pair-negative",
    actualEvents: [
      {
        kind: "scopelease.actual_work_event",
        lane: "default-codex",
        pairId: "pair-negative",
        runId: "default-old",
        phase: "input",
        tokens: 900,
        timestamp: "2026-05-10T00:00:01.000Z"
      },
      {
        kind: "scopelease.actual_work_event",
        lane: "default-codex",
        pairId: "pair-negative",
        runId: "default-new",
        phase: "input",
        tokens: 300,
        timestamp: "2026-05-10T00:00:03.000Z"
      },
      {
        kind: "scopelease.actual_work_event",
        lane: "scopelease-codex",
        pairId: "pair-negative",
        runId: "scopelease-run",
        phase: "input",
        tokens: 50,
        timestamp: "2026-05-10T00:00:04.000Z"
      }
    ],
    mcpContextEvents: [
      {
        kind: "scopelease.mcp_context_event",
        lane: "scopelease-codex",
        pairId: "pair-negative",
        runId: "scopelease-run",
        tokens: 500,
        timestamp: "2026-05-10T00:00:02.000Z"
      }
    ]
  });

  assert.equal(pair.defaultTokens, 300);
  assert.equal(pair.scopeleaseTokens, 550);
  assert.equal(pair.savedTokens, -250);
  assert.equal(pair.savedPercent, -83);
  assert.equal(pair.eventCounts.default, 1);

  const formatted = formatObservedSavings(pair, (value) => `${value}`);
  assert.match(formatted.statusText, /증가/);
  assert.doesNotMatch(formatted.statusText, /절감/);
  const display = formatSavingsDisplay(formatted);
  assert.equal(display.label, "실제 pair delta");
  assert.doesNotMatch(display.note, /절감$/);

  const missingDisplay = formatSavingsDisplay({ measured: false, missing: ["default-codex 입력 n"] });
  assert.equal(missingDisplay.label, "Pair delta");
  assert.match(missingDisplay.note, /양수일 때만 절감률/);
});

test("observed pair selection honors explicit pair and run together", () => {
  const analysis = {
    userRequest: "explicit pair run should not mix sibling runs",
    contextPack: {
      userRequest: { text: "explicit pair run should not mix sibling runs" }
    }
  };
  const pair = buildObservedWorkIntentSavings({
    analysis,
    pairId: "pair-same",
    runId: "scopelease-run-a",
    actualEvents: [
      {
        kind: "scopelease.actual_work_event",
        lane: "default-codex",
        pairId: "pair-same",
        runId: "scopelease-run-a:default-baseline",
        phase: "input",
        tokens: 1000,
        timestamp: "2026-05-10T00:00:01.000Z"
      },
      {
        kind: "scopelease.actual_work_event",
        lane: "default-codex",
        pairId: "pair-same",
        runId: "scopelease-run-b:default-baseline",
        phase: "input",
        tokens: 9000,
        timestamp: "2026-05-10T00:10:01.000Z"
      },
      {
        kind: "scopelease.actual_work_event",
        lane: "scopelease-codex",
        pairId: "pair-same",
        runId: "scopelease-run-a",
        phase: "input",
        tokens: 100,
        timestamp: "2026-05-10T00:00:04.000Z"
      },
      {
        kind: "scopelease.actual_work_event",
        lane: "scopelease-codex",
        pairId: "pair-same",
        runId: "scopelease-run-b",
        phase: "input",
        tokens: 700,
        timestamp: "2026-05-10T00:10:03.000Z"
      }
    ],
    mcpContextEvents: [
      {
        kind: "scopelease.mcp_context_event",
        lane: "scopelease-codex",
        pairId: "pair-same",
        runId: "scopelease-run-a",
        tokens: 300,
        timestamp: "2026-05-10T00:00:02.000Z"
      },
      {
        kind: "scopelease.mcp_context_event",
        lane: "scopelease-codex",
        pairId: "pair-same",
        runId: "scopelease-run-a:default-baseline",
        tokens: 9999,
        timestamp: "2026-05-10T00:00:03.000Z"
      },
      {
        kind: "scopelease.mcp_context_event",
        lane: "scopelease-codex",
        pairId: "pair-same",
        runId: "scopelease-run-b",
        tokens: 200,
        timestamp: "2026-05-10T00:10:02.000Z"
      }
    ]
  });

  assert.equal(pair.pairSelection, "explicit_pair_run");
  assert.equal(pair.runId, "scopelease-run-a");
  assert.equal(pair.defaultTokens, 1000);
  assert.equal(pair.scopeleaseTokens, 400);
  assert.equal(pair.savedTokens, 600);
  assert.equal(pair.eventCounts.default, 1);
  assert.equal(pair.eventCounts.scopeleaseContext, 1);
  assert.equal(pair.eventCounts.scopeleaseWork, 1);
});

test("observed pair selection reports none when no candidate exists", () => {
  const analysis = {
    userRequest: "empty pair selection",
    contextPack: {
      userRequest: { text: "empty pair selection" }
    }
  };
  const pair = buildObservedWorkIntentSavings({
    analysis,
    actualEvents: [],
    mcpContextEvents: []
  });

  assert.equal(pair.measured, false);
  assert.equal(pair.pairSelection, "none");
  assert.deepEqual(pair.missing, [
    "default-codex 입력 n",
    "scopelease-codex 입력 m",
    "scopelease-codex 입력 이벤트",
    "scopelease_get_context 근거"
  ]);
});

test("observed pair selection does not mix stale context with later default events", () => {
  const analysis = {
    userRequest: "stale context should not be paired",
    contextPack: {
      userRequest: { text: "stale context should not be paired" }
    }
  };
  const pair = buildObservedWorkIntentSavings({
    analysis,
    pairId: "pair-stale",
    actualEvents: [
      {
        kind: "scopelease.actual_work_event",
        lane: "default-codex",
        pairId: "pair-stale",
        runId: "default-late",
        phase: "input",
        tokens: 1000,
        timestamp: "2026-05-10T03:00:00.000Z"
      }
    ],
    mcpContextEvents: [
      {
        kind: "scopelease.mcp_context_event",
        lane: "scopelease-codex",
        pairId: "pair-stale",
        runId: "scopelease-old",
        tokens: 300,
        timestamp: "2026-05-10T00:00:00.000Z"
      }
    ]
  });

  assert.equal(pair.measured, false);
  assert.equal(pair.defaultTokens, 0);
  assert.deepEqual(pair.missing, ["default-codex 입력 n", "scopelease-codex 입력 이벤트"]);
});

test("agent usage detector does not claim stale latest pair evidence", () => {
  const detection = detectAgentVisibleUsage({
    repoPath: fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-stale-pair-")),
    codexHome: fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-stale-codex-home-")),
    state: {
      mcpContextEvents: [
        { kind: "scopelease.mcp_context_event", lane: "scopelease-codex", workIntent: "stale intent", pairId: "pair-stale", runId: "scopelease-old", timestamp: "2026-05-10T00:00:00.000Z", tokens: 300 }
      ],
      actualWorkEvents: [
        { lane: "default-codex", phase: "input", workIntent: "stale intent", pairId: "pair-stale", runId: "default-late", timestamp: "2026-05-10T03:00:00.000Z", tokens: 1000 },
        { lane: "scopelease-codex", phase: "input", workIntent: "stale intent", pairId: "pair-stale", runId: "scopelease-old", timestamp: "2026-05-10T00:01:00.000Z", tokens: 100 }
      ]
    }
  });

  assert.equal(detection.pairedLaneEvidence.status, "needs_pair");
  assert.equal(detection.pairedLaneEvidence.defaultCodexObservedInputTokens, null);
  assert.equal(detection.pairedLaneEvidence.scopeleaseCodexObservedInputTokens, 400);
  assert.equal(detection.researchCalibration.status, "insufficient_pair");
  assert.equal(detection.researchCalibration.claimPolicy.canClaimExactDelta, false);
  assert.equal(detection.capability.canMeasureAgentVisiblePairDelta, false);
});

test("analyzeRepository ignores bare boolean request flags", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-request-"));
  fs.writeFileSync(path.join(root, "README.md"), "hello");

  initRepository(root);
  const analysis = analyzeRepository(root, { userRequest: true });

  assert.notEqual(analysis.userRequest, true);
  assert.notEqual(analysis.contextPack.userRequest.text, "true");
  assert.match(analysis.contextPack.userRequest.text, /ScopeLease 분석/);
});

test("initRepository keeps ScopeLease local state out of git excludes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-git-ignore-"));
  fs.mkdirSync(path.join(root, ".git", "info"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "hello");

  initRepository(root);
  const exclude = fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /\.decision\//);
  assert.match(exclude, /\.codex\//);
  assert.match(exclude, /\.scopelease\//);

  const repeated = ensureLocalStateIgnored(root);
  assert.equal(repeated.applied, false);
});

test("mcp server provides context and records provided context tokens", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-mcp-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/app.js"), "export function hello() { return 'world'; }\n");

  initRepository(root);
  fs.writeFileSync(path.join(root, "src/app.js"), "export function hello() { return 'mcp'; }\n");

  const server = spawn(process.execPath, [path.resolve("src/cli.js"), "mcp", root], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env }
  });
  const pending = new Map();
  let stderr = "";
  let stdoutBuffer = "";
  server.stdout.setEncoding("utf8");
  server.stdout.on("data", (chunk) => {
    stdoutBuffer += String(chunk);
    const lines = stdoutBuffer.split(/\n/);
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const resolver = pending.get(message.id);
      if (resolver) {
        pending.delete(message.id);
        resolver(message);
      }
    }
  });
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  let sequence = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, resolve);
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`MCP request timed out: ${method}; stderr=${stderr}`));
    }, 30000).unref();
  });
  const callWithEnvServer = async (extraEnv, method, params = {}) => {
    const envServer = spawn(process.execPath, [path.resolve("src/cli.js"), "mcp", root], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv }
    });
    const envPending = new Map();
    let envStderr = "";
    let envStdoutBuffer = "";
    let envSequence = 0;
    envServer.stdout.setEncoding("utf8");
    envServer.stdout.on("data", (chunk) => {
      envStdoutBuffer += String(chunk);
      const lines = envStdoutBuffer.split(/\n/);
      envStdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        const resolver = envPending.get(message.id);
        if (resolver) {
          envPending.delete(message.id);
          resolver(message);
        }
      }
    });
    envServer.stderr.setEncoding("utf8");
    envServer.stderr.on("data", (chunk) => {
      envStderr += chunk;
    });
    const envSend = (envMethod, envParams = {}) => new Promise((resolve, reject) => {
      const id = ++envSequence;
      envPending.set(id, resolve);
      envServer.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: envMethod, params: envParams })}\n`);
      setTimeout(() => {
        if (!envPending.has(id)) return;
        envPending.delete(id);
        reject(new Error(`MCP env request timed out: ${envMethod}; stderr=${envStderr}`));
      }, 30000).unref();
    });
    try {
      await envSend("initialize", { protocolVersion: "2024-11-05" });
      return await envSend(method, params);
    } finally {
      envServer.kill();
    }
  };

  try {
    const initialized = await send("initialize", { protocolVersion: "2024-11-05" });
    assert.equal(initialized.result.serverInfo.name, "scopelease");

    const tools = await send("tools/list");
    assert.ok(tools.result.tools.some((tool) => tool.name === "scopelease_get_context"));
    assert.ok(tools.result.tools.some((tool) => tool.name === "scopelease_approve"));
    assert.ok(tools.result.tools.some((tool) => tool.name === "scopelease_detect_agent_usage"));
    assert.ok(tools.result.tools.some((tool) => tool.name === "scopelease_detect_codex_usage"));
    assert.ok(tools.result.tools.some((tool) => tool.name === "scopelease_research_calibration"));
    const contextTool = tools.result.tools.find((tool) => tool.name === "scopelease_get_context");
    const guardTool = tools.result.tools.find((tool) => tool.name === "scopelease_guard");
    assert.equal(contextTool.inputSchema.properties.graphBackendPayload.type, "object");
    assert.equal(guardTool.inputSchema.properties.graphBackendPayload.type, "object");

    const externalGraphContext = await send("tools/call", {
      name: "scopelease_get_context",
      arguments: {
        request: "Use external graph payload through MCP.",
        graphBackendName: "mcp-codegraph-fixture",
        graphBackendPayload: {
          nodes: [
            { id: "file:src/app.js", type: "file", path: "src/app.js" },
            { id: "symbol:src/app.js:function:hello", type: "function", properties: { path: "src/app.js", name: "hello" } }
          ],
          edges: [
            { source: "file:src/app.js", target: "symbol:src/app.js:function:hello", type: "defines" }
          ]
        },
        format: "payload",
        record: false
      }
    });
    const externalPayload = JSON.parse(externalGraphContext.result.content[0].text);
    assert.equal(externalPayload.structuredContext.input.frontierSummary.backend, "mcp-codegraph-fixture");

    const racePairs = ["pair-race-a", "pair-race-b", "pair-race-c", "pair-race-d"];
    await Promise.all(racePairs.map((pairId, index) => send("tools/call", {
      name: "scopelease_get_context",
      arguments: {
        request: `parallel MCP state race ${index}`,
        workIntent: "parallel mcp state race",
        pairId,
        runId: `scopelease-race-${index}`,
        format: "summary"
      }
    })));
    const raceState = JSON.parse(fs.readFileSync(path.join(root, ".decision", "state.json"), "utf8"));
    for (const pairId of racePairs) {
      assert.ok(raceState.mcpContextEvents.some((event) => event.pairId === pairId), `missing ${pairId}`);
    }

    const dryContext = await send("tools/call", {
      name: "scopelease_get_context",
      arguments: {
        request: "What is ScopeLease?",
        workIntent: "dry context pairing",
        pairId: "pair-dry",
        runId: "scopelease-run-dry",
        format: "summary",
        record: false
      }
    });
    assert.equal(dryContext.result.structuredContent.pairId, "pair-dry");
    assert.equal(dryContext.result.structuredContent.taskIntent.pairing.pairingKey, "dry context pairing");
    assert.equal(dryContext.result.structuredContent.adaptiveContext.mode, "observe_only");

    const envFallbackContext = await callWithEnvServer({
      SCOPELEASE_WORK_INTENT: "env fallback mcp context",
      SCOPELEASE_PAIR_ID: "pair-env",
      SCOPELEASE_RUN_ID: "scopelease-env-run"
    }, "tools/call", {
      name: "scopelease_get_context",
      arguments: {
        request: "Use pair-run environment metadata when tool args omit pair fields.",
        format: "summary"
      }
    });
    assert.equal(envFallbackContext.result.structuredContent.pairId, "pair-env");
    assert.equal(envFallbackContext.result.structuredContent.runId, "scopelease-env-run");
    assert.equal(envFallbackContext.result.structuredContent.workIntent, "env fallback mcp context");

    const forcedFullContext = await send("tools/call", {
      name: "scopelease_get_context",
      arguments: {
        request: "What is ScopeLease?",
        workIntent: "dry context pairing",
        pairId: "pair-dry-full",
        runId: "scopelease-run-dry-full",
        format: "summary",
        mode: "full",
        record: false
      }
    });
    assert.equal(forcedFullContext.result.structuredContent.adaptiveContext.mode, "full_context");
    assert.ok(forcedFullContext.result.structuredContent.providedContext.tokens >
      dryContext.result.structuredContent.providedContext.tokens);

    const deltaExactRequest = "delta must recompute the matching request analysis " + "A ".repeat(40);
    const exactForDelta = await send("tools/call", {
      name: "scopelease_get_context",
      arguments: {
        request: deltaExactRequest,
        workIntent: "delta exact pairing",
        pairId: "pair-delta-exact",
        mode: "full",
        format: "summary",
        record: false
      }
    });
    await send("tools/call", {
      name: "scopelease_get_context",
      arguments: {
        request: "unrelated stale latest analysis " + "B ".repeat(600),
        workIntent: "stale latest pairing",
        pairId: "pair-stale-latest",
        mode: "full",
        format: "summary",
        record: false
      }
    });
    const staleDelta = await send("tools/call", {
      name: "scopelease_explain_delta",
      arguments: {
        request: deltaExactRequest,
        workIntent: "delta exact pairing",
        pairId: "pair-delta-exact"
      }
    });
    assert.ok(Math.abs(
      staleDelta.result.structuredContent.contextCandidate.inputCandidateTokens
        - exactForDelta.result.structuredContent.providedContext.tokens
    ) <= 16);
    assert.equal(staleDelta.result.structuredContent.measurement.scopeleaseProvidedContextTokens, 0);
    assert.ok(Math.abs(
      staleDelta.result.structuredContent.measurement.scopeleaseInputCandidateTokens
        - exactForDelta.result.structuredContent.providedContext.tokens
    ) <= 16);
    assert.equal(staleDelta.result.structuredContent.measurement.agentVisibleMeasured, false);

    const repeatRequest = "repeated pair should select latest default lane run";
    const oldDefault = await send("tools/call", {
      name: "scopelease_measure",
      arguments: {
        request: repeatRequest,
        workIntent: "repeat pair latest run",
        pairId: "pair-repeat-latest",
        runId: "default-old",
        lane: "default-codex",
        phase: "input",
        text: "old default prompt payload ".repeat(1200)
      }
    });
    await send("tools/call", {
      name: "scopelease_get_context",
      arguments: {
        request: repeatRequest,
        workIntent: "repeat pair latest run",
        pairId: "pair-repeat-latest",
        runId: "scopelease-repeat",
        format: "summary"
      }
    });
    const newDefault = await send("tools/call", {
      name: "scopelease_measure",
      arguments: {
        request: repeatRequest,
        workIntent: "repeat pair latest run",
        pairId: "pair-repeat-latest",
        runId: "default-new",
        lane: "default-codex",
        phase: "input",
        text: "new default prompt payload ".repeat(120)
      }
    });
    const repeatDelta = await send("tools/call", {
      name: "scopelease_explain_delta",
      arguments: {
        request: repeatRequest,
        workIntent: "repeat pair latest run",
        pairId: "pair-repeat-latest"
      }
    });
    const repeatPair = repeatDelta.result.structuredContent.observedPairSavings;
    assert.equal(repeatPair.defaultCodexInputTokens, newDefault.result.structuredContent.event.tokens);
    assert.notEqual(repeatPair.defaultCodexInputTokens,
      oldDefault.result.structuredContent.event.tokens + newDefault.result.structuredContent.event.tokens);
    assert.equal(repeatPair.eventCounts.default, 1);

    const explicitRunRequest = "explicit pair and run should isolate one ScopeLease context";
    const explicitRunDefault = await send("tools/call", {
      name: "scopelease_measure",
      arguments: {
        request: explicitRunRequest,
        workIntent: "explicit pair run mcp",
        pairId: "pair-explicit-run",
        runId: "scopelease-explicit-a:default-baseline",
        lane: "default-codex",
        phase: "input",
        text: "run a default baseline payload ".repeat(300)
      }
    });
    await send("tools/call", {
      name: "scopelease_measure",
      arguments: {
        request: explicitRunRequest,
        workIntent: "explicit pair run mcp",
        pairId: "pair-explicit-run",
        runId: "scopelease-explicit-b:default-baseline",
        lane: "default-codex",
        phase: "input",
        text: "run b default baseline payload ".repeat(3000)
      }
    });
    const explicitRunContext = await send("tools/call", {
      name: "scopelease_get_context",
      arguments: {
        request: explicitRunRequest,
        workIntent: "explicit pair run mcp",
        pairId: "pair-explicit-run",
        runId: "scopelease-explicit-a",
        format: "summary"
      }
    });
    const explicitRunScopeLeaseInput = await send("tools/call", {
      name: "scopelease_measure",
      arguments: {
        request: explicitRunRequest,
        workIntent: "explicit pair run mcp",
        pairId: "pair-explicit-run",
        runId: "scopelease-explicit-a",
        lane: "scopelease-codex",
        phase: "input",
        text: "scopelease lane user input payload ".repeat(30)
      }
    });
    await send("tools/call", {
      name: "scopelease_get_context",
      arguments: {
        request: explicitRunRequest,
        workIntent: "explicit pair run mcp",
        pairId: "pair-explicit-run",
        runId: "scopelease-explicit-b",
        format: "summary"
      }
    });
    const explicitRunDelta = await send("tools/call", {
      name: "scopelease_explain_delta",
      arguments: {
        request: explicitRunRequest,
        workIntent: "explicit pair run mcp",
        pairId: "pair-explicit-run",
        runId: "scopelease-explicit-a"
      }
    });
    const explicitRunPair = explicitRunDelta.result.structuredContent.observedPairSavings;
    assert.equal(explicitRunPair.pairSelection, "explicit_pair_run");
    assert.equal(explicitRunPair.runId, "scopelease-explicit-a");
    assert.equal(explicitRunPair.defaultCodexInputTokens, explicitRunDefault.result.structuredContent.event.tokens);
    assert.equal(explicitRunPair.scopeleaseCodexInputTokens,
      explicitRunContext.result.structuredContent.providedContext.tokens +
      explicitRunScopeLeaseInput.result.structuredContent.event.tokens);
    assert.equal(explicitRunPair.eventCounts.default, 1);
    assert.equal(explicitRunPair.eventCounts.scopeleaseContext, 1);
    await send("tools/call", {
      name: "scopelease_measure",
      arguments: {
        request: explicitRunRequest,
        workIntent: "explicit pair run mcp",
        pairId: "pair-explicit-run",
        runId: "scopelease-explicit-a:default-baseline",
        lane: "scopelease-codex",
        phase: "input",
        text: "bad scopelease event carrying default-baseline suffix ".repeat(1000)
      }
    });
    const explicitRunDeltaAfterBadScopeLeaseEvent = await send("tools/call", {
      name: "scopelease_explain_delta",
      arguments: {
        request: explicitRunRequest,
        workIntent: "explicit pair run mcp",
        pairId: "pair-explicit-run",
        runId: "scopelease-explicit-a"
      }
    });
    const explicitRunPairAfterBadScopeLeaseEvent = explicitRunDeltaAfterBadScopeLeaseEvent.result.structuredContent.observedPairSavings;
    assert.equal(explicitRunPairAfterBadScopeLeaseEvent.scopeleaseCodexInputTokens, explicitRunPair.scopeleaseCodexInputTokens);
    assert.equal(explicitRunPairAfterBadScopeLeaseEvent.eventCounts.scopeleaseWork, 1);

    const result = await send("tools/call", {
      name: "scopelease_get_context",
      arguments: {
        request: "MCP context를 만들어줘",
        workIntent: "mcp context pairing",
        pairId: "pair-1",
        runId: "scopelease-run-1",
        format: "summary"
      }
    });
    assert.equal(result.result.structuredContent.kind, "scopelease.mcp_context_result");
    assert.ok(result.result.structuredContent.providedContext.tokens > 0);

    const state = JSON.parse(fs.readFileSync(path.join(root, ".decision", "state.json"), "utf8"));
    const pairOneContext = state.mcpContextEvents.find((event) => event.pairId === "pair-1" && event.runId === "scopelease-run-1");
    assert.ok(pairOneContext);
    assert.equal(pairOneContext.tool, "scopelease_get_context");
    assert.ok(pairOneContext.tokens > 0);
    assert.equal(pairOneContext.workIntent, "mcp context pairing");
    assert.equal(pairOneContext.pairingKey, "mcp context pairing");
    assert.equal(pairOneContext.taskIntent.pairing.pairingKey, "mcp context pairing");

    await send("tools/call", {
      name: "scopelease_measure",
      arguments: {
        request: "기본 Codex 문구는 달라도 같은 작업이다",
        workIntent: "mcp context pairing",
        pairId: "pair-1",
        runId: "default-run-1",
        lane: "default-codex",
        phase: "input",
        text: "default codex input payload ".repeat(900)
      }
    });

    await send("tools/call", {
      name: "scopelease_get_context",
      arguments: {
        request: "ScopeLease 문구도 다르지만 같은 작업이다",
        workIntent: "mcp context pairing",
        pairId: "pair-1",
        runId: "scopelease-run-2",
        format: "summary"
      }
    });
    await send("tools/call", {
      name: "scopelease_measure",
      arguments: {
        request: "ScopeLease 문구도 다르지만 같은 작업이다",
        workIntent: "mcp context pairing",
        pairId: "pair-1",
        runId: "scopelease-run-2",
        lane: "scopelease-codex",
        phase: "input",
        text: "scopelease codex user input payload ".repeat(20)
      }
    });

    await send("tools/call", {
      name: "scopelease_measure",
      arguments: {
        request: "ScopeLease 최종 응답은 입력 절감률에서 제외된다",
        workIntent: "mcp context pairing",
        pairId: "pair-1",
        runId: "scopelease-run-2",
        lane: "scopelease-codex",
        phase: "output",
        text: "scopelease final response should not count as input ".repeat(2000)
      }
    });

    const delta = await send("tools/call", {
      name: "scopelease_explain_delta",
      arguments: {
        request: "MCP context를 만들어줘",
        workIntent: "mcp context pairing",
        pairId: "pair-1"
      }
    });
    const pair = delta.result.structuredContent.observedPairSavings;
    const research = delta.result.structuredContent.researchCalibration;
    assert.equal(pair.status, "measured");
    assert.equal(pair.pairId, "pair-1");
    assert.equal(pair.pairSelection, "explicit_pair_id");
    assert.ok(pair.defaultCodexInputTokens > 0);
    assert.ok(pair.scopeleaseCodexInputTokens > 0);
    assert.ok(pair.scopeleaseCodexInputTokens < pairOneContext.tokens * 2);
    assert.equal(pair.eventCounts.default, 1);
    assert.equal(pair.eventCounts.scopeleaseContext, 2);
    assert.equal(pair.eventCounts.scopeleaseWork, 1);
    assert.equal(delta.result.structuredContent.measurement.observedLowerBoundTokens,
      delta.result.structuredContent.measurement.scopeleaseProvidedContextTokens +
      delta.result.structuredContent.measurement.observedWorkPayloadTokens);
    assert.equal(research.scope, "separate_from_product_runtime");
    assert.equal(research.status, "claim_ready");
    assert.equal(research.productRuntimeImpact.extraAgentRuns, 0);
    assert.equal(research.claimPolicy.canClaimExactDelta, true);
    assert.equal(research.claimPolicy.canClaimExactSavings, true);
    assert.equal(delta.result.structuredContent.agentVisibleUsage.canMeasureAgentVisiblePairDelta, true);
    assert.equal(delta.result.structuredContent.agentVisibleUsage.canClaimAgentVisiblePairSavings, true);

    await send("tools/call", {
      name: "scopelease_measure",
      arguments: {
        request: "ScopeLease context가 default보다 큰 pair는 savings가 아니다",
        workIntent: "mcp negative savings pairing",
        pairId: "pair-negative-mcp",
        runId: "default-negative-mcp",
        lane: "default-codex",
        phase: "input",
        text: "tiny default"
      }
    });
    await send("tools/call", {
      name: "scopelease_get_context",
      arguments: {
        request: "ScopeLease context가 default보다 큰 pair는 savings가 아니다",
        workIntent: "mcp negative savings pairing",
        pairId: "pair-negative-mcp",
        runId: "scopelease-negative-mcp",
        format: "summary"
      }
    });
    await send("tools/call", {
      name: "scopelease_measure",
      arguments: {
        request: "ScopeLease context가 default보다 큰 pair는 savings가 아니다",
        workIntent: "mcp negative savings pairing",
        pairId: "pair-negative-mcp",
        runId: "scopelease-negative-mcp",
        lane: "scopelease-codex",
        phase: "input",
        text: "scopelease side prompt"
      }
    });
    const negativeDelta = await send("tools/call", {
      name: "scopelease_explain_delta",
      arguments: {
        request: "ScopeLease context가 default보다 큰 pair는 savings가 아니다",
        workIntent: "mcp negative savings pairing",
        pairId: "pair-negative-mcp"
      }
    });
    const negativePair = negativeDelta.result.structuredContent.observedPairSavings;
    const negativeResearch = negativeDelta.result.structuredContent.researchCalibration;
    assert.equal(negativePair.status, "measured");
    assert.ok(negativePair.savedTokens < 0);
    assert.equal(negativePair.deltaDirection, "increase");
    assert.equal(negativePair.canClaimPositiveSavings, false);
    assert.equal(negativeResearch.status, "delta_ready_no_savings");
    assert.equal(negativeResearch.claimPolicy.canClaimExactDelta, true);
    assert.equal(negativeResearch.claimPolicy.canClaimExactSavings, false);
    assert.equal(negativeResearch.claimPolicy.canClaimPositiveSavings, false);
    assert.equal(negativeDelta.result.structuredContent.agentVisibleUsage.canMeasureAgentVisiblePairDelta, true);
    assert.equal(negativeDelta.result.structuredContent.agentVisibleUsage.canClaimAgentVisiblePairSavings, false);
    assert.match(negativeResearch.claimPolicy.allowedClaim, /do not call it savings/);

    const scopedRequest = "Path scoped Codex session 자동 baseline scopelease pair 연결";
    const scopedIntent = deriveWorkIntent({ request: scopedRequest });
    fs.writeFileSync(path.join(root, ".decision", "hook-current-request.json"), JSON.stringify({
      userRequest: scopedRequest,
      workIntent: scopedIntent,
      requestHash: requestHash(scopedRequest),
      pairId: "pair-scoped-cwd",
      runId: "codex:path-run",
      lane: "default-codex"
    }, null, 2));
    await send("tools/call", {
      name: "scopelease_measure",
      arguments: {
        request: scopedRequest,
        workIntent: scopedIntent,
        pairId: "pair-scoped-cwd",
        runId: "codex:baseline-run",
        lane: "default-codex",
        phase: "input",
        text: "plain codex cwd baseline input ".repeat(700)
      }
    });
    await send("tools/call", {
      name: "scopelease_measure",
      arguments: {
        request: scopedRequest,
        workIntent: scopedIntent,
        pairId: "pair-scoped-cwd",
        runId: "codex:path-run",
        lane: "default-codex",
        phase: "input",
        text: "current codex prompt before scopelease context"
      }
    });
    await send("tools/call", {
      name: "scopelease_get_context",
      arguments: {
        request: "응 해봐",
        format: "summary"
      }
    });
    const promotedState = JSON.parse(fs.readFileSync(path.join(root, ".decision", "state.json"), "utf8"));
    const promotedInput = promotedState.actualWorkEvents.find((event) => event.runId === "codex:path-run");
    const baselineInput = promotedState.actualWorkEvents.find((event) => event.runId === "codex:baseline-run");
    const scopedContext = promotedState.mcpContextEvents.find((event) => event.runId === "codex:path-run");
    const currentHookState = JSON.parse(fs.readFileSync(path.join(root, ".decision", "hook-current-request.json"), "utf8"));
    assert.equal(promotedInput.lane, "scopelease-codex");
    assert.equal(promotedInput.workIntent, scopedIntent);
    assert.equal(baselineInput.lane, "default-codex");
    assert.equal(scopedContext.pairId, "pair-scoped-cwd");
    assert.equal(scopedContext.workIntent, scopedIntent);
    assert.equal(currentHookState.lane, "scopelease-codex");
    const scopedDelta = await send("tools/call", {
      name: "scopelease_explain_delta",
      arguments: {
        request: scopedRequest,
        pairId: "pair-scoped-cwd"
      }
    });
    const scopedPair = scopedDelta.result.structuredContent.observedPairSavings;
    const scopedResearch = scopedDelta.result.structuredContent.researchCalibration;
    assert.equal(scopedPair.status, "measured");
    assert.equal(scopedPair.eventCounts.default, 1);
    assert.equal(scopedPair.eventCounts.scopeleaseContext, 1);
    assert.equal(scopedPair.eventCounts.scopeleaseWork, 1);
    assert.equal(scopedResearch.status, "delta_ready_no_savings");
    assert.equal(scopedResearch.claimPolicy.canClaimExactDelta, true);
    assert.equal(scopedResearch.claimPolicy.canClaimExactSavings, false);
    assert.equal(scopedResearch.validityChecks.find((check) => check.check === "scopelease_context_present").pass, true);

    fs.writeFileSync(path.join(root, ".decision", "hook-current-request.json"), JSON.stringify({
      userRequest: "stale current request from previous turn",
      workIntent: "stale intent",
      requestHash: "sha1:stale",
      pairId: "pair-stale-current",
      runId: "codex:stale-current",
      lane: "default-codex"
    }, null, 2));
    const explicitReviewContext = await send("tools/call", {
      name: "scopelease_get_context",
      arguments: {
        request: "전역 코드 검토 및 유지보수 상태 확인",
        format: "summary"
      }
    });
    assert.equal(explicitReviewContext.result.structuredContent.userRequest, "전역 코드 검토 및 유지보수 상태 확인");
    assert.notEqual(explicitReviewContext.result.structuredContent.pairId, "pair-stale-current");

    const autoBaselineRequest = "연결된 Codex 세션에서 ScopeLease context 호출만으로 pair evidence를 자동 보존";
    const autoBaselineIntent = deriveWorkIntent({ request: autoBaselineRequest });
    fs.writeFileSync(path.join(root, ".decision", "hook-current-request.json"), JSON.stringify({
      userRequest: autoBaselineRequest,
      workIntent: autoBaselineIntent,
      requestHash: requestHash(autoBaselineRequest),
      pairId: "pair-auto-baseline",
      runId: "codex:auto-baseline-run",
      lane: "default-codex"
    }, null, 2));
    await send("tools/call", {
      name: "scopelease_measure",
      arguments: {
        request: autoBaselineRequest,
        workIntent: autoBaselineIntent,
        pairId: "pair-auto-baseline",
        runId: "codex:auto-baseline-run",
        lane: "default-codex",
        phase: "input",
        text: "observed codex prompt before scopelease context ".repeat(120)
      }
    });
    await send("tools/call", {
      name: "scopelease_get_context",
      arguments: {
        request: "응 해봐",
        format: "summary"
      }
    });
    const autoBaselineState = JSON.parse(fs.readFileSync(path.join(root, ".decision", "state.json"), "utf8"));
    const autoBaselineClone = autoBaselineState.actualWorkEvents.find((event) =>
      event.pairId === "pair-auto-baseline" && event.autoPairBaseline === true
    );
    const autoPromotedInput = autoBaselineState.actualWorkEvents.find((event) =>
      event.pairId === "pair-auto-baseline" &&
      event.runId === "codex:auto-baseline-run" &&
      event.autoPairBaseline !== true
    );
    assert.equal(autoBaselineClone.lane, "default-codex");
    assert.equal(autoBaselineClone.runId, "codex:auto-baseline-run:default-baseline");
    assert.equal(autoPromotedInput.lane, "scopelease-codex");
    const autoBaselineDelta = await send("tools/call", {
      name: "scopelease_explain_delta",
      arguments: {
        request: autoBaselineRequest,
        pairId: "pair-auto-baseline"
      }
    });
    const autoBaselinePair = autoBaselineDelta.result.structuredContent.observedPairSavings;
    assert.equal(autoBaselinePair.status, "measured");
    assert.equal(autoBaselinePair.eventCounts.default, 1);
    assert.equal(autoBaselinePair.eventCounts.scopeleaseContext, 1);
    assert.equal(autoBaselinePair.eventCounts.scopeleaseWork, 1);

    fs.writeFileSync(path.join(root, ".decision", "hook-current-request.json"), JSON.stringify({
      userRequest: autoBaselineRequest,
      workIntent: autoBaselineIntent,
      requestHash: requestHash(autoBaselineRequest),
      pairId: "pair-auto-baseline",
      runId: "codex:auto-baseline-run-2",
      lane: "default-codex"
    }, null, 2));
    await send("tools/call", {
      name: "scopelease_measure",
      arguments: {
        request: autoBaselineRequest,
        workIntent: autoBaselineIntent,
        pairId: "pair-auto-baseline",
        runId: "codex:auto-baseline-run-2",
        lane: "default-codex",
        phase: "input",
        text: "second observed codex prompt before scopelease context"
      }
    });
    await send("tools/call", {
      name: "scopelease_get_context",
      arguments: {
        request: "응 해봐",
        format: "summary"
      }
    });
    const secondAutoBaselineState = JSON.parse(fs.readFileSync(path.join(root, ".decision", "state.json"), "utf8"));
    const secondAutoBaselineClone = secondAutoBaselineState.actualWorkEvents.find((event) =>
      event.pairId === "pair-auto-baseline" &&
      event.autoPairBaseline === true &&
      event.runId === "codex:auto-baseline-run-2:default-baseline"
    );
    assert.equal(secondAutoBaselineClone.lane, "default-codex");
    const secondAutoBaselineDelta = await send("tools/call", {
      name: "scopelease_explain_delta",
      arguments: {
        request: autoBaselineRequest,
        pairId: "pair-auto-baseline"
      }
    });
    const secondAutoBaselinePair = secondAutoBaselineDelta.result.structuredContent.observedPairSavings;
    assert.equal(secondAutoBaselinePair.status, "measured");
    assert.equal(secondAutoBaselinePair.eventCounts.default, 1);
    assert.equal(secondAutoBaselinePair.eventCounts.scopeleaseContext, 1);
    assert.equal(secondAutoBaselinePair.eventCounts.scopeleaseWork, 1);

    const collisionRequest = "동일 workIntent에서 새 pairId가 기존 baseline 때문에 누락되면 안 된다";
    const collisionIntent = deriveWorkIntent({ request: collisionRequest });
    await send("tools/call", {
      name: "scopelease_measure",
      arguments: {
        request: collisionRequest,
        workIntent: collisionIntent,
        pairId: "pair-collision-old",
        runId: "codex:collision-old",
        lane: "default-codex",
        phase: "input",
        text: "old pair baseline should not satisfy new pair ".repeat(90)
      }
    });
    fs.writeFileSync(path.join(root, ".decision", "hook-current-request.json"), JSON.stringify({
      userRequest: collisionRequest,
      workIntent: collisionIntent,
      requestHash: requestHash(collisionRequest),
      pairId: "pair-collision-new",
      runId: "codex:collision-new",
      lane: "default-codex"
    }, null, 2));
    await send("tools/call", {
      name: "scopelease_measure",
      arguments: {
        request: collisionRequest,
        workIntent: collisionIntent,
        pairId: "pair-collision-new",
        runId: "codex:collision-new",
        lane: "default-codex",
        phase: "input",
        text: "new pair current prompt before scopelease context ".repeat(40)
      }
    });
    await send("tools/call", {
      name: "scopelease_get_context",
      arguments: {
        request: "새 pair의 ScopeLease context 호출",
        format: "summary"
      }
    });
    const collisionDelta = await send("tools/call", {
      name: "scopelease_explain_delta",
      arguments: {
        request: collisionRequest,
        pairId: "pair-collision-new"
      }
    });
    const collisionPair = collisionDelta.result.structuredContent.observedPairSavings;
    assert.equal(collisionPair.status, "measured");
    assert.equal(collisionPair.eventCounts.default, 1);
    assert.equal(collisionPair.eventCounts.scopeleaseContext, 1);
    assert.equal(collisionPair.eventCounts.scopeleaseWork, 1);

    const calibration = await send("tools/call", {
      name: "scopelease_research_calibration",
      arguments: {
        request: scopedRequest,
        pairId: "pair-scoped-cwd",
        experimentId: "exp-scoped-cwd"
      }
    });
    const calibrationResult = calibration.result.structuredContent;
    assert.equal(calibrationResult.kind, "scopelease.research_calibration_result");
    assert.equal(calibrationResult.scope, "paper_research_only");
    assert.equal(calibrationResult.recorded, true);
    assert.equal(calibrationResult.record.scope, "paper_research_only");
    assert.equal(calibrationResult.record.experiment.experimentId, "exp-scoped-cwd");
    assert.equal(calibrationResult.record.researchCalibration.status, "delta_ready_no_savings");
    assert.equal(calibrationResult.record.productRuntimeImpact.extraAgentRuns, 0);
    assert.equal(calibrationResult.record.claimPolicy.canClaimExactDelta, true);
    assert.equal(calibrationResult.record.claimPolicy.canClaimExactSavings, false);
    assert.ok(fs.existsSync(path.join(root, ".decision", "research-calibration.jsonl")));
    const calibrationLines = fs.readFileSync(path.join(root, ".decision", "research-calibration.jsonl"), "utf8").trim().split(/\n/);
    assert.equal(calibrationLines.length, 1);
    assert.equal(JSON.parse(calibrationLines[0]).experiment.experimentId, "exp-scoped-cwd");

    fs.writeFileSync(path.join(root, ".decision", "hook-current-request.json"), JSON.stringify({
      userRequest: "응 해봐.",
      workIntent: "unrelated-current-intent",
      requestHash: "sha1:unrelated",
      runId: "codex:unrelated"
    }, null, 2));
    const autoRequest = "Finding 2 public/graph-view.js workIntent 자동 연결 확인";
    await send("tools/call", {
      name: "scopelease_get_context",
      arguments: {
        request: autoRequest,
        format: "summary"
      }
    });
    await send("tools/call", {
      name: "scopelease_measure",
      arguments: {
        request: autoRequest,
        lane: "default-codex",
        phase: "explore",
        text: "default codex input payload ".repeat(900)
      }
    });
    await send("tools/call", {
      name: "scopelease_measure",
      arguments: {
        request: autoRequest,
        lane: "scopelease-codex",
        phase: "input",
        text: "scopelease codex user input payload"
      }
    });
    const autoDelta = await send("tools/call", {
      name: "scopelease_explain_delta",
      arguments: {
        request: autoRequest
      }
    });
    const autoPair = autoDelta.result.structuredContent.observedPairSavings;
    assert.equal(autoPair.status, "measured");
    assert.equal(autoPair.workIntent, deriveWorkIntent({ request: autoRequest }));
    assert.equal(autoPair.pairSelection, "latest_unscoped");
    assert.ok(autoPair.defaultCodexInputTokens > 0);
    assert.ok(autoPair.scopeleaseCodexInputTokens > 0);

    const legacyStatePath = path.join(root, ".decision", "state.json");
    const legacyState = JSON.parse(fs.readFileSync(legacyStatePath, "utf8"));
    const legacyDefault = legacyState.actualWorkEvents.find((event) =>
      event.lane === "default-codex" && event.userRequest === autoRequest
    );
    assert.ok(legacyDefault);
    delete legacyDefault.workIntent;
    fs.writeFileSync(legacyStatePath, `${JSON.stringify(legacyState, null, 2)}\n`);
    const legacyDelta = await send("tools/call", {
      name: "scopelease_explain_delta",
      arguments: {
        request: autoRequest
      }
    });
    const legacyPair = legacyDelta.result.structuredContent.observedPairSavings;
    assert.equal(legacyPair.status, "measured");
    assert.equal(legacyPair.eventCounts.default, 1);

    await send("tools/call", {
      name: "scopelease_measure",
      arguments: {
        request: "No MCP context paper claim should stay insufficient",
        workIntent: "no mcp context",
        pairId: "pair-no-mcp-context",
        lane: "default-codex",
        phase: "input",
        text: "default codex input ".repeat(300)
      }
    });
    await send("tools/call", {
      name: "scopelease_measure",
      arguments: {
        request: "No MCP context paper claim should stay insufficient",
        workIntent: "no mcp context",
        pairId: "pair-no-mcp-context",
        lane: "scopelease-codex",
        phase: "input",
        text: "scopelease codex input ".repeat(30)
      }
    });
    const noContextDelta = await send("tools/call", {
      name: "scopelease_explain_delta",
      arguments: {
        request: "No MCP context paper claim should stay insufficient",
        workIntent: "no mcp context",
        pairId: "pair-no-mcp-context"
      }
    });
    assert.equal(noContextDelta.result.structuredContent.observedPairSavings.status, "needs_pair");
    assert.equal(noContextDelta.result.structuredContent.researchCalibration.status, "insufficient_pair");
    assert.equal(noContextDelta.result.structuredContent.researchCalibration.claimPolicy.canClaimExactSavings, false);
    assert.equal(noContextDelta.result.structuredContent.agentVisibleUsage.canMeasureAgentVisiblePairDelta, false);
    assert.equal(noContextDelta.result.structuredContent.agentVisibleUsage.canClaimAgentVisiblePairSavings, false);
    assert.equal(noContextDelta.result.structuredContent.researchCalibration.validityChecks.find((check) => check.check === "scopelease_context_present").pass, false);

    const rogueApprove = await send("tools/call", {
      name: "scopelease_approve",
      arguments: {
        request: "MCP context를 만들어줘",
        action: { kind: "read", path: "src/app.js" },
        choiceId: "allow_scoped_patch",
        decisionBundle: {
          id: "rogue_bundle",
          choices: [{ id: "allow_scoped_patch", grants: ["read", "apply_patch"], blocks: [] }],
          scope: { files: ["src/evil.js"], commands: [], maxFiles: 99 },
          stopWhen: []
        }
      }
    });
    assert.match(rogueApprove.error?.message || "", /No current guard decision requires approval/);

    const action = { kind: "edit", path: "src/app.js" };
    const approved = await send("tools/call", {
      name: "scopelease_approve",
      arguments: {
        request: "MCP context를 만들어줘",
        action,
        choiceId: "allow_scoped_patch"
      }
    });
    assert.equal(approved.result.structuredContent.ok, true);
    assert.equal(approved.result.structuredContent.lease.choiceId, "allow_scoped_patch");

    const guarded = await send("tools/call", {
      name: "scopelease_guard",
      arguments: {
        request: "MCP context를 만들어줘",
        action
      }
    });
    assert.equal(guarded.result.structuredContent.verdict, "allow_with_log");
  } finally {
    server.kill();
  }
});

test("usage proxy extracts response usage from JSON and SSE payloads", () => {
  const jsonUsage = extractUsageFromText(JSON.stringify({
    id: "resp_json",
    model: "test-model",
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
  }));
  assert.equal(jsonUsage.id, "resp_json");
  assert.equal(jsonUsage.usage.total_tokens, 15);

  const sseUsage = extractUsageFromText([
    "event: response.created",
    "data: {\"type\":\"response.created\"}",
    "",
    "event: response.done",
    "data: {\"type\":\"response.done\",\"response\":{\"id\":\"resp_sse\",\"model\":\"test-model\",\"usage\":{\"input_tokens\":20,\"output_tokens\":7,\"total_tokens\":27}}}",
    ""
  ].join("\n"));
  assert.equal(sseUsage.id, "resp_sse");
  assert.equal(sseUsage.usage.total_tokens, 27);

  const inferred = inferUserRequestFromBody(Buffer.from(JSON.stringify({
    input: [
      { role: "system", content: "ignore" },
      { role: "user", content: [{ type: "input_text", text: "이번 요청만 그룹 키로 잡아줘." }] }
    ]
  })));
  assert.equal(inferred, "이번 요청만 그룹 키로 잡아줘.");

  const forwarded = buildForwardHeaders(
    { scopeleaserization: "Bearer codex-reader", "x-scopelease-request": "hidden", host: "localhost:3928" },
    Buffer.from("{}"),
    { SCOPELEASE_OPENAI_API_KEY: "scopelease-writer" }
  );
  assert.equal(forwarded.get("scopeleaserization"), "Bearer scopelease-writer");
  assert.equal(forwarded.has("x-scopelease-request"), false);
  assert.equal(forwarded.get("content-type"), "application/json");

  const fallback = buildForwardHeaders({}, Buffer.alloc(0), { OPENAI_API_KEY: "fallback-key" });
  assert.equal(fallback.has("scopeleaserization"), false);
  const optInFallback = buildForwardHeaders({}, Buffer.alloc(0), {
    OPENAI_API_KEY: "fallback-key",
    SCOPELEASE_ALLOW_OPENAI_API_KEY_FALLBACK: "1"
  });
  assert.equal(optInFallback.get("scopeleaserization"), "Bearer fallback-key");
});

test("model proxy endpoint is disabled unless explicitly enabled", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-proxy-disabled-"));
  fs.writeFileSync(path.join(root, "README.md"), "repo local\n");
  initRepository(root);

  const { server, service } = startServer({
    repoPath: root,
    port: 0,
    scanInterval: 0,
    entry: "graph.html",
    label: "ScopeLease proxy disabled test",
    lockRoot: true
  });
  await waitForListening(server);
  const port = server.address().port;

  try {
    const health = await getJson(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(health.body.runtime.proxyBaseUrl, `http://localhost:${port}/proxy/v1`);
    assert.equal(health.body.runtime.modelProxyEnabled, false);

    const response = await postJson(`http://127.0.0.1:${port}/proxy/v1/responses`, { input: "hello" });
    assert.equal(response.status, 403);
    assert.equal(response.body.modelProxyEnabled, false);
  } finally {
    service.close();
    await closeServer(server);
  }
});

test("dashboard repo switch preserves the actual dynamic runtime port", async () => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-switch-port-a-"));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-switch-port-b-"));
  fs.writeFileSync(path.join(firstRoot, "README.md"), "first repo\n");
  fs.writeFileSync(path.join(secondRoot, "README.md"), "second repo\n");
  initRepository(firstRoot);
  initRepository(secondRoot);

  const { server, service } = startServer({
    repoPath: firstRoot,
    port: 0,
    scanInterval: 0,
    entry: "graph.html",
    label: "ScopeLease repo switch port test"
  });
  await waitForListening(server);
  const port = server.address().port;

  try {
    const switched = await postJson(`http://127.0.0.1:${port}/api/repo`, { path: secondRoot });
    assert.equal(switched.status, 200);
    assert.equal(switched.body.repo, secondRoot);
    assert.equal(switched.body.state.runtime.root, secondRoot);
    assert.equal(switched.body.state.runtime.proxyBaseUrl, `http://localhost:${port}/proxy/v1`);
    assert.equal(switched.body.state.runtime.usageEndpoint, `http://localhost:${port}/api/usage`);
    assert.doesNotMatch(switched.body.state.runtime.proxyBaseUrl, /localhost:0\//);

    const state = await getJson(`http://127.0.0.1:${port}/api/state`);
    assert.equal(state.status, 200);
    assert.equal(state.body.runtime.root, secondRoot);
    assert.equal(state.body.runtime.proxyBaseUrl, `http://localhost:${port}/proxy/v1`);
  } finally {
    service.close();
    await closeServer(server);
  }
});

test("agent-visible usage and evidence summary exclude ScopeLease-internal watcher payloads", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-internal-evidence-"));
  fs.writeFileSync(path.join(root, "README.md"), "repo local\n");
  const state = initRepository(root);
  saveState(root, {
    ...state,
    actualWorkEvents: [
      { lane: "default-codex", phase: "input", source: "codex-hook:user-prompt", tokens: 100 },
      { lane: "default-codex", phase: "explore", source: "codex-hook:Grep", callType: "tool_call", toolName: "Grep", toolFamily: "read", tokens: 25 },
      { lane: "scopelease-internal", phase: "edit", source: "watch:auto-edit", tokens: 900 }
    ],
    guardEvents: [
      { source: "codex-hook:pre-tool-use", verdict: "allow_with_log" }
    ]
  });

  const detection = detectAgentVisibleUsage({
    repoPath: root,
    codexHome: path.join(root, "codex-home"),
    state: loadState(root)
  });
  assert.equal(detection.observedToolPayload.tokens, 125);
  assert.equal(detection.observedToolPayload.internalEvidence.tokens, 900);
  assert.equal(detection.agentVisibleUsage.observedPayloadTokens, 125);

  const summary = buildEvidenceSummary(root);
  const rows = Object.fromEntries(summary.table.map((row) => [row.metric, row.value]));
  assert.equal(rows.actual_work_tokens, 125);
  assert.equal(rows.internal_evidence_tokens, 900);
  assert.equal(rows.tool_call_events, 1);
  assert.equal(rows.tool_call_tokens, 25);
  assert.equal(rows.tool_call_breakdown, "Grep:1");
  assert.equal(rows.pre_tool_enforcement_events, 1);
  assert.equal(Number.isFinite(Number(rows.review_frontier_nodes)), true);
  assert.equal(Number.isFinite(Number(rows.permission_frontier_nodes)), true);
  assert.equal(Number.isFinite(Number(rows.stop_frontier_nodes)), true);
  assert.equal(summary.toolCalls.tools[0].tool, "Grep");
});

test("evidence summary separates signed pair delta from positive savings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-evidence-delta-"));
  fs.writeFileSync(path.join(root, "README.md"), "repo local\n");
  const state = initRepository(root);
  saveState(root, {
    ...state,
    actualWorkEvents: [
      {
        kind: "scopelease.actual_work_event",
        lane: "default-codex",
        source: "pair-harness",
        workIntent: "controlled prompt protocol",
        pairId: "pair-controlled",
        runId: "controlled-run:default-baseline",
        phase: "input",
        tokens: 10000,
        timestamp: "2026-05-13T00:00:01.000Z"
      },
      {
        kind: "scopelease.actual_work_event",
        lane: "default-codex",
        source: "codex-hook:Grep",
        callType: "tool_call",
        toolName: "Grep",
        workIntent: "live same unit",
        pairId: "pair-live",
        runId: "live-run:default-baseline",
        phase: "explore",
        tokens: 1000,
        timestamp: "2026-05-13T00:02:01.000Z"
      },
      {
        kind: "scopelease.actual_work_event",
        lane: "scopelease-codex",
        source: "codex-hook:Read",
        callType: "tool_call",
        toolName: "Read",
        workIntent: "live same unit",
        pairId: "pair-live",
        runId: "live-run",
        phase: "explore",
        tokens: 100,
        timestamp: "2026-05-13T00:02:03.000Z"
      }
    ],
    mcpContextEvents: [
      {
        kind: "scopelease.mcp_context_event",
        lane: "scopelease-codex",
        workIntent: "live same unit",
        pairId: "pair-live",
        runId: "live-run",
        tokens: 200,
        timestamp: "2026-05-13T00:02:02.000Z"
      }
    ]
  });
  const runDir = path.join(root, ".scopelease", "experiments", "negative-pair-run");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "summary.json"), `${JSON.stringify({
    kind: "scopelease.agent_pair_harness",
    runId: "negative-pair-run",
    generatedAt: "2026-05-13T00:00:00.000Z",
    observationKind: "controlled_token_prompt_protocol",
    claimScope: "controlled_prompt_protocol_not_live_codex_average",
    summary: {
      defaultTokens: 100,
      scopeleaseTokens: 250,
      savedTokens: -150,
      savedPercent: -150,
      decisionPromptReductionPercent: 0
    },
    rows: [
      { baselineMode: "explicit", scopeleaseMode: "micro_context" },
      { baselineMode: "readPlanFiles", scopeleaseMode: "observe_only" }
    ]
  }, null, 2)}\n`);

  const summary = buildEvidenceSummary(root);
  const rows = Object.fromEntries(summary.table.map((row) => [row.metric, row.value]));
  assert.equal(rows.latest_observed_pair_status, "measured");
  assert.equal(rows.latest_observed_pair_default_tokens, 1000);
  assert.equal(rows.latest_observed_pair_scopelease_tokens, 300);
  assert.equal(rows.latest_observed_pair_delta_tokens, 700);
  assert.equal(rows.latest_observed_pair_delta_percent, 70);
  assert.equal(rows.latest_observed_pair_delta_direction, "savings");
  assert.equal(rows.latest_observed_pair_can_claim_savings, true);
  assert.equal(rows.latest_observed_pair_claim_scope, "actual_observed_same_work_intent_pair");
  assert.equal(rows.latest_observed_pair_default_tool_calls, 1);
  assert.equal(rows.latest_observed_pair_scopelease_tool_calls, 1);
  assert.equal(rows.latest_observed_pair_tool_call_delta, 0);
  assert.equal(rows.latest_observed_pair_tool_call_delta_percent, 0);
  assert.equal(summary.toolCalls.totalCalls, 2);
  assert.equal(summary.toolCalls.breakdownLabel, "Grep:1,Read:1");
  assert.equal(summary.table.find((row) => row.metric === "latest_observed_pair_status").value, "measured");
  assert.equal(rows.latest_pair_protocol_kind, "controlled_token_prompt_protocol");
  assert.equal(rows.latest_pair_delta_tokens, -150);
  assert.equal(rows.latest_pair_delta_percent, -150);
  assert.equal(rows.latest_pair_delta_direction, "overhead");
  assert.equal(rows.latest_pair_positive_savings_tokens, null);
  assert.equal(rows.latest_pair_positive_savings_percent, null);
  assert.equal(rows.latest_pair_saved_percent, null);
  assert.equal(rows.latest_pair_baseline_modes, "explicit,readPlanFiles");
  assert.equal(rows.latest_pair_scopelease_modes, "micro_context,observe_only");
  assert.equal(rows.latest_pair_claim_scope, "controlled_prompt_protocol_not_live_codex_average");
});

test("observed pair tool-call delta requires both lanes to report call capture", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-evidence-call-delta-"));
  fs.writeFileSync(path.join(root, "README.md"), "repo local\n");
  const state = initRepository(root);
  saveState(root, {
    ...state,
    actualWorkEvents: [
      {
        kind: "scopelease.actual_work_event",
        lane: "default-codex",
        source: "codex-hook:Grep",
        callType: "tool_call",
        toolName: "Grep",
        workIntent: "live call unit",
        pairId: "pair-live-call",
        runId: "call-run:default-baseline",
        phase: "explore",
        tokens: 1000,
        timestamp: "2026-05-13T00:03:01.000Z"
      },
      {
        kind: "scopelease.actual_work_event",
        lane: "scopelease-codex",
        source: "codex-hook:user-prompt",
        workIntent: "live call unit",
        pairId: "pair-live-call",
        runId: "call-run",
        phase: "input",
        tokens: 100,
        timestamp: "2026-05-13T00:03:03.000Z"
      }
    ],
    mcpContextEvents: [
      {
        kind: "scopelease.mcp_context_event",
        lane: "scopelease-codex",
        workIntent: "live call unit",
        pairId: "pair-live-call",
        runId: "call-run",
        tokens: 200,
        timestamp: "2026-05-13T00:03:02.000Z"
      }
    ]
  });

  const summary = buildEvidenceSummary(root);
  const rows = Object.fromEntries(summary.table.map((row) => [row.metric, row.value]));
  assert.equal(rows.latest_observed_pair_status, "measured");
  assert.equal(rows.latest_observed_pair_default_tool_calls, 1);
  assert.equal(rows.latest_observed_pair_scopelease_tool_calls, null);
  assert.equal(rows.latest_observed_pair_tool_call_delta, null);
  assert.equal(rows.latest_observed_pair_tool_call_delta_percent, null);
});

test("product-wide summary uses only observed pairs for average claims", () => {
  const roots = Array.from({ length: 3 }, (_, index) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `scopelease-product-wide-${index}-`));
    fs.writeFileSync(path.join(root, "README.md"), `repo ${index}\n`);
    const state = initRepository(root);
    saveState(root, {
      ...state,
      actualWorkEvents: [
        {
          kind: "scopelease.actual_work_event",
          lane: "default-codex",
          source: "pair-harness",
          workIntent: `controlled ${index}`,
          pairId: `pair-controlled-${index}`,
          runId: "controlled-run:default-baseline",
          phase: "input",
          tokens: 10000,
          timestamp: `2026-05-14T00:00:0${index}.000Z`
        },
        {
          kind: "scopelease.actual_work_event",
          lane: "default-codex",
          source: "codex-hook:user-prompt",
          workIntent: `live ${index}`,
          pairId: `pair-live-${index}`,
          runId: `live-default-${index}`,
          phase: "input",
          tokens: 1000,
          taskIntent: { taskType: "code_change" },
          timestamp: `2026-05-14T00:01:0${index}.000Z`
        },
        {
          kind: "scopelease.actual_work_event",
          lane: "scopelease-codex",
          source: "codex-hook:tool",
          workIntent: `live ${index}`,
          pairId: `pair-live-${index}`,
          runId: `live-scopelease-${index}`,
          phase: "explore",
          tokens: 100 + index * 10,
          taskIntent: { taskType: "code_change" },
          timestamp: `2026-05-14T00:01:2${index}.000Z`
        },
        {
          kind: "scopelease.actual_work_event",
          lane: "default-codex",
          source: "codex-hook:user-prompt",
          workIntent: `live second ${index}`,
          pairId: `pair-live-second-${index}`,
          runId: `live-second-default-${index}`,
          phase: "input",
          tokens: 500,
          taskIntent: { taskType: "documentation" },
          timestamp: `2026-05-14T00:03:0${index}.000Z`
        },
        {
          kind: "scopelease.actual_work_event",
          lane: "scopelease-codex",
          source: "codex-hook:tool",
          workIntent: `live second ${index}`,
          pairId: `pair-live-second-${index}`,
          runId: `live-second-scopelease-${index}`,
          phase: "explore",
          tokens: 50,
          taskIntent: { taskType: "documentation" },
          timestamp: `2026-05-14T00:03:2${index}.000Z`
        },
        ...(index === 0 ? [
          {
            kind: "scopelease.actual_work_event",
            lane: "default-codex",
            source: "codex-hook:user-prompt:auto-default-baseline",
            workIntent: "auto promoted live prompt",
            pairId: "pair-live-auto-promoted",
            runId: "auto-run:default-baseline",
            phase: "input",
            tokens: 2000,
            autoPairBaseline: true,
            taskIntent: { taskType: "review" },
            timestamp: "2026-05-14T00:05:00.000Z"
          },
          {
            kind: "scopelease.actual_work_event",
            lane: "scopelease-codex",
            source: "codex-hook:tool",
            workIntent: "auto promoted live prompt",
            pairId: "pair-live-auto-promoted",
            runId: "auto-run",
            phase: "explore",
            tokens: 100,
            taskIntent: { taskType: "review" },
            timestamp: "2026-05-14T00:05:02.000Z"
          }
        ] : []),
        ...(index === 2 ? [{
          kind: "scopelease.actual_work_event",
          lane: "default-codex",
          source: "codex-hook:user-prompt",
          workIntent: "tiny default live prompt",
          pairId: "pair-live-tiny",
          runId: "tiny-run:default-baseline",
          phase: "input",
          tokens: 9,
          taskIntent: { taskType: "general_coding_task" },
          timestamp: "2026-05-14T00:04:00.000Z"
        }, {
          kind: "scopelease.actual_work_event",
          lane: "scopelease-codex",
          source: "codex-hook:user-prompt",
          workIntent: "tiny default live prompt",
          pairId: "pair-live-tiny",
          runId: "tiny-run",
          phase: "input",
          tokens: 5,
          taskIntent: { taskType: "general_coding_task" },
          timestamp: "2026-05-14T00:04:02.000Z"
        }] : [])
      ],
      mcpContextEvents: [
        {
          kind: "scopelease.mcp_context_event",
          lane: "scopelease-codex",
          workIntent: `live ${index}`,
          pairId: `pair-live-${index}`,
          runId: `live-scopelease-${index}`,
          tokens: 200,
          taskIntent: { taskType: "code_change" },
          timestamp: `2026-05-14T00:01:1${index}.000Z`
        },
        {
          kind: "scopelease.mcp_context_event",
          lane: "scopelease-codex",
          workIntent: `live second ${index}`,
          pairId: `pair-live-second-${index}`,
          runId: `live-second-scopelease-${index}`,
          tokens: 100,
          taskIntent: { taskType: "documentation" },
          timestamp: `2026-05-14T00:03:1${index}.000Z`
        },
        ...(index === 0 ? [{
          kind: "scopelease.mcp_context_event",
          lane: "scopelease-codex",
          workIntent: "auto promoted live prompt",
          pairId: "pair-live-auto-promoted",
          runId: "auto-run",
          tokens: 200,
          taskIntent: { taskType: "review" },
          timestamp: "2026-05-14T00:05:01.000Z"
        }] : []),
        ...(index === 2 ? [{
          kind: "scopelease.mcp_context_event",
          lane: "scopelease-codex",
          workIntent: "tiny default live prompt",
          pairId: "pair-live-tiny",
          runId: "tiny-run",
          tokens: 4755,
          taskIntent: { taskType: "general_coding_task" },
          timestamp: "2026-05-14T00:04:01.000Z"
        }] : [])
      ]
    });
    const runDir = path.join(root, ".scopelease", "experiments", "controlled");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "summary.json"), `${JSON.stringify({
      kind: "scopelease.agent_pair_harness",
      runId: "controlled",
      generatedAt: "2026-05-14T00:02:00.000Z",
      observationKind: "controlled_token_prompt_protocol",
      claimScope: "controlled_prompt_protocol_not_live_codex_average",
      summary: {
        defaultTokens: 10000,
        scopeleaseTokens: 100,
        savedTokens: 9900,
        savedPercent: 99
      },
      rows: [{ baselineMode: "readPlanFiles", scopeleaseMode: "observe_only" }]
    }, null, 2)}\n`);
    return root;
  });

  const summary = buildProductWideTokenSummary(roots, {
    minRepos: 3,
    minPairs: 6,
    inputCostPerMillion: 10
  });
  assert.equal(summary.status, "claim_ready");
  assert.equal(summary.observedPairScope, "strict_independent_lanes");
  assert.equal(summary.measuredRepoCount, 3);
  assert.equal(summary.measuredPairCount, 6);
  assert.equal(summary.liveObservedCandidateCount, 8);
  assert.equal(summary.incompleteObservedPairCount, 0);
  assert.equal(summary.observedPairCount, 7);
  assert.equal(summary.staleObservedPairCount, 0);
  assert.equal(summary.allLiveObservedPairCount, 8);
  assert.equal(summary.strictLiveObservedPairCount, 7);
  assert.equal(summary.autoPromotedPairCount, 1);
  assert.equal(summary.excludedLiveObservedPairCount, 1);
  assert.equal(summary.tinyDefaultPairCount, 1);
  assert.equal(summary.minDefaultTokens, 100);
  assert.equal(summary.weighted.defaultTokens, 4500);
  assert.equal(summary.weighted.scopeleaseTokens, 1380);
  assert.equal(summary.weighted.savedPercent, 69);
  assert.equal(summary.costEstimate.status, "estimated");
  assert.equal(summary.costEstimate.inputCostPerMillion, 10);
  assert.equal(summary.costEstimate.savedCost, 0.0312);
  assert.equal(summary.costEstimate.savedPercent, 69);
  assert.equal(summary.controlledProtocol.savedPercent, 99);
  assert.equal(summary.claimPolicy.canClaimProductWideAverageSavings, true);
  assert.equal(summary.claimPolicy.canClaimEstimatedInputCostSavings, true);
  assert.equal(summary.byTaskType.length, 2);
  assert.equal(summary.byTaskType.find((row) => row.taskType === "code_change").measuredPairs, 3);
  assert.equal(summary.byTaskType.find((row) => row.taskType === "documentation").measuredPairs, 3);
  assert.equal(summary.rows[0].observedAggregate.measuredPairs, 2);
  assert.equal(summary.rows[0].allLiveObservedPairs.length, 3);
  assert.equal(summary.rows[0].excludedObservedPairs.length, 1);
  assert.equal(summary.rows[0].observedAggregate.defaultTokens, 1500);
  assert.equal(summary.rows[0].observedAggregate.scopeleaseTokens, 450);
  assert.equal(summary.rows[2].allScopedObservedPairs.length, 3);
  assert.equal(summary.rows[2].observedPairs.length, 2);
  assert.equal(summary.rows[2].tinyDefaultPairs, 1);
  assert.equal(summary.rows[0].observed.claimScope, "actual_observed_same_work_intent_pair");
  assert.equal(summary.rows[0].controlledPair.claimScope, "controlled_prompt_protocol_not_live_codex_average");

  const allScope = buildProductWideTokenSummary(roots, {
    minRepos: 3,
    minPairs: 7,
    observedPairScope: "all",
    inputCostPerMillion: 10
  });
  assert.equal(allScope.status, "delta_ready_non_strict_scope");
  assert.equal(allScope.observedPairScope, "all_live_observed");
  assert.equal(allScope.measuredPairCount, 7);
  assert.equal(allScope.weighted.defaultTokens, 6500);
  assert.equal(allScope.weighted.scopeleaseTokens, 1680);
  assert.equal(allScope.claimPolicy.canClaimProductWideAverageSavings, false);
  assert.match(allScope.claimPolicy.allowedClaim, /non-strict live observed token delta/);

  const autoOnlyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-product-wide-auto-only-"));
  fs.writeFileSync(path.join(autoOnlyRoot, "README.md"), "auto only\n");
  const autoOnlyState = initRepository(autoOnlyRoot);
  saveState(autoOnlyRoot, {
    ...autoOnlyState,
    actualWorkEvents: [
      {
        kind: "scopelease.actual_work_event",
        lane: "default-codex",
        source: "codex-hook:user-prompt:auto-default-baseline",
        workIntent: "auto only live prompt",
        pairId: "pair-live-auto-only",
        runId: "auto-only:default-baseline",
        phase: "input",
        tokens: 1200,
        autoPairBaseline: true,
        taskIntent: { taskType: "review" },
        timestamp: "2026-05-14T00:06:00.000Z"
      },
      {
        kind: "scopelease.actual_work_event",
        lane: "scopelease-codex",
        source: "codex-hook:tool",
        workIntent: "auto only live prompt",
        pairId: "pair-live-auto-only",
        runId: "auto-only",
        phase: "explore",
        tokens: 100,
        taskIntent: { taskType: "review" },
        timestamp: "2026-05-14T00:06:02.000Z"
      }
    ],
    mcpContextEvents: [{
      kind: "scopelease.mcp_context_event",
      lane: "scopelease-codex",
      workIntent: "auto only live prompt",
      pairId: "pair-live-auto-only",
      runId: "auto-only",
      tokens: 150,
      taskIntent: { taskType: "review" },
      timestamp: "2026-05-14T00:06:01.000Z"
    }]
  });
  const autoOnlyStrict = buildProductWideTokenSummary([autoOnlyRoot], {
    minRepos: 1,
    minPairs: 1
  });
  assert.equal(autoOnlyStrict.status, "insufficient_real_use_observed_pairs");
  assert.equal(autoOnlyStrict.liveObservedCandidateCount, 1);
  assert.equal(autoOnlyStrict.incompleteObservedPairCount, 0);
  assert.equal(autoOnlyStrict.rows[0].observed.status, "needs_pair");
  assert.equal(autoOnlyStrict.rows[0].observed.claimScope, "needs_actual_observed_default_scopelease_and_context_pair");
  assert.equal(autoOnlyStrict.rows[0].observedAggregate.measuredPairs, 0);
  assert.equal(autoOnlyStrict.rows[0].allLiveObservedPairs.length, 1);
  assert.equal(autoOnlyStrict.rows[0].allObservedPairCandidates.length, 1);
  assert.equal(autoOnlyStrict.rows[0].incompleteObservedPairs.length, 0);
  assert.equal(autoOnlyStrict.rows[0].excludedObservedPairs.length, 1);

  const incompleteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-product-wide-incomplete-"));
  fs.writeFileSync(path.join(incompleteRoot, "README.md"), "incomplete\n");
  const incompleteState = initRepository(incompleteRoot);
  saveState(incompleteRoot, {
    ...incompleteState,
    actualWorkEvents: [{
      kind: "scopelease.actual_work_event",
      lane: "default-codex",
      source: "codex-hook:user-prompt",
      workIntent: "missing scopelease context prompt",
      pairId: "pair-live-incomplete",
      runId: "default-incomplete",
      phase: "input",
      tokens: 1000,
      taskIntent: { taskType: "review" },
      timestamp: "2026-05-14T00:07:00.000Z"
    }],
    mcpContextEvents: []
  });
  const incompleteStrict = buildProductWideTokenSummary([incompleteRoot], {
    minRepos: 1,
    minPairs: 1
  });
  assert.equal(incompleteStrict.status, "insufficient_real_use_observed_pairs");
  assert.equal(incompleteStrict.liveObservedCandidateCount, 1);
  assert.equal(incompleteStrict.incompleteObservedPairCount, 1);
  assert.equal(incompleteStrict.allLiveObservedPairCount, 0);
  assert.equal(incompleteStrict.rows[0].observed.status, "needs_pair");
  assert.equal(incompleteStrict.rows[0].incompleteObservedPairs.length, 1);

  const insufficient = buildProductWideTokenSummary(roots.slice(0, 2), {
    minRepos: 3,
    minPairs: 6,
    inputCostPerMillion: 10
  });
  assert.equal(insufficient.status, "insufficient_real_use_observed_pairs");
  assert.equal(insufficient.claimPolicy.canClaimProductWideAverageSavings, false);
  assert.equal(insufficient.claimPolicy.canClaimEstimatedInputCostSavings, false);
});

test("product-wide summary does not mix stale protocols or weighted-only deltas into savings claims", () => {
  const roots = Array.from({ length: 3 }, (_, index) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `scopelease-product-wide-strict-${index}-`));
    fs.writeFileSync(path.join(root, "README.md"), `repo ${index}\n`);
    const state = initRepository(root);
    saveState(root, {
      ...state,
      actualWorkEvents: [
        {
          kind: "scopelease.actual_work_event",
          lane: "default-codex",
          source: "agent-command:prompt",
          workIntent: `same task ${index}`,
          pairId: `pair-old-${index}`,
          runId: `old-default-${index}`,
          phase: "input",
          tokens: 50000,
          taskIntent: { taskType: "review" },
          timestamp: `2026-05-14T00:00:0${index}.000Z`
        },
        {
          kind: "scopelease.actual_work_event",
          lane: "scopelease-codex",
          source: "agent-command:prompt",
          workIntent: `same task ${index}`,
          pairId: `pair-old-${index}`,
          runId: `old-scopelease-${index}`,
          phase: "input",
          tokens: 400,
          scopeleaseContextEmbedded: true,
          scopeleaseContextTokens: 200,
          taskIntent: { taskType: "review" },
          timestamp: `2026-05-14T00:00:1${index}.000Z`
        },
        {
          kind: "scopelease.actual_work_event",
          lane: "default-codex",
          source: "agent-command:prompt",
          workIntent: `same task ${index}`,
          pairId: `pair-new-${index}`,
          runId: `new-default-${index}`,
          phase: "input",
          tokens: 120,
          taskIntent: { taskType: "review" },
          timestamp: `2026-05-14T00:10:0${index}.000Z`
        },
        {
          kind: "scopelease.actual_work_event",
          lane: "scopelease-codex",
          source: "agent-command:prompt",
          workIntent: `same task ${index}`,
          pairId: `pair-new-${index}`,
          runId: `new-scopelease-${index}`,
          phase: "input",
          tokens: 420,
          scopeleaseContextEmbedded: true,
          scopeleaseContextTokens: 210,
          taskIntent: { taskType: "review" },
          timestamp: `2026-05-14T00:10:1${index}.000Z`
        }
      ],
      mcpContextEvents: []
    });
    return root;
  });

  const latestOnly = buildProductWideTokenSummary(roots, { minRepos: 3, minPairs: 3 });
  assert.equal(latestOnly.status, "delta_ready_no_savings");
  assert.equal(latestOnly.measuredPairCount, 3);
  assert.equal(latestOnly.staleObservedPairCount, 3);
  assert.equal(latestOnly.tinyDefaultPairCount, 0);
  assert.equal(latestOnly.weighted.defaultTokens, 360);
  assert.equal(latestOnly.weighted.scopeleaseTokens, 1260);
  assert.equal(latestOnly.allObservedByTaskType[0].measuredPairs, 3);
  assert.equal(latestOnly.claimPolicy.canClaimProductWideAverageSavings, false);
  assert.match(latestOnly.caveat, /older pairs are reported as stale/);

  const mixedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-product-wide-mixed-"));
  fs.writeFileSync(path.join(mixedRoot, "README.md"), "mixed\n");
  const mixedState = initRepository(mixedRoot);
  saveState(mixedRoot, {
    ...mixedState,
    actualWorkEvents: [
      {
        kind: "scopelease.actual_work_event",
        lane: "default-codex",
        source: "codex-hook:user-prompt",
        workIntent: "huge positive",
        pairId: "mixed-positive",
        runId: "mixed-positive-default",
        phase: "input",
        tokens: 100000,
        taskIntent: { taskType: "review" },
        timestamp: "2026-05-14T00:20:00.000Z"
      },
      {
        kind: "scopelease.actual_work_event",
        lane: "scopelease-codex",
        source: "codex-hook:user-prompt",
        workIntent: "huge positive",
        pairId: "mixed-positive",
        runId: "mixed-positive-scopelease",
        phase: "input",
        tokens: 100,
        taskIntent: { taskType: "review" },
        timestamp: "2026-05-14T00:20:02.000Z"
      },
      ...[0, 1].flatMap((item) => [
        {
          kind: "scopelease.actual_work_event",
          lane: "default-codex",
          source: "codex-hook:user-prompt",
          workIntent: `small overhead ${item}`,
          pairId: `mixed-overhead-${item}`,
          runId: `mixed-overhead-default-${item}`,
          phase: "input",
          tokens: 100,
          taskIntent: { taskType: "review" },
          timestamp: `2026-05-14T00:21:0${item}.000Z`
        },
        {
          kind: "scopelease.actual_work_event",
          lane: "scopelease-codex",
          source: "codex-hook:user-prompt",
          workIntent: `small overhead ${item}`,
          pairId: `mixed-overhead-${item}`,
          runId: `mixed-overhead-scopelease-${item}`,
          phase: "input",
          tokens: 500,
          taskIntent: { taskType: "review" },
          timestamp: `2026-05-14T00:21:1${item}.000Z`
        }
      ])
    ],
    mcpContextEvents: [
      {
        kind: "scopelease.mcp_context_event",
        lane: "scopelease-codex",
        workIntent: "huge positive",
        pairId: "mixed-positive",
        runId: "mixed-positive-scopelease",
        tokens: 100,
        taskIntent: { taskType: "review" },
        timestamp: "2026-05-14T00:20:01.000Z"
      },
      ...[0, 1].map((item) => ({
        kind: "scopelease.mcp_context_event",
        lane: "scopelease-codex",
        workIntent: `small overhead ${item}`,
        pairId: `mixed-overhead-${item}`,
        runId: `mixed-overhead-scopelease-${item}`,
        tokens: 400,
        taskIntent: { taskType: "review" },
        timestamp: `2026-05-14T00:21:0${item}.500Z`
      }))
    ]
  });

  const mixed = buildProductWideTokenSummary([mixedRoot], { minRepos: 1, minPairs: 3 });
  assert.equal(mixed.status, "weighted_delta_ready_mixed_distribution");
  assert.equal(mixed.weighted.savedTokens > 0, true);
  assert.equal(mixed.weighted.macroSavedPercent < 0, true);
  assert.equal(mixed.weighted.positivePairs, 1);
  assert.equal(mixed.weighted.overheadPairs, 2);
  assert.equal(mixed.claimPolicy.canClaimWeightedPositiveDelta, true);
  assert.equal(mixed.claimPolicy.canClaimProductWideAverageSavings, false);
  assert.match(mixed.claimPolicy.allowedClaim, /weighted positive token delta observed/);
});

test("product-wide summary can use command-reported total tokens as a separate claim metric", () => {
  const roots = Array.from({ length: 3 }, (_, index) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `scopelease-command-wide-${index}-`));
    fs.writeFileSync(path.join(root, "README.md"), `repo ${index}\n`);
    initRepository(root);
    const runDir = path.join(root, ".scopelease", "experiments", `command-live-${index}`);
    fs.mkdirSync(runDir, { recursive: true });
    const defaultTokens = 10_000 + index * 1_000;
    const scopeleaseTokens = 4_000 + index * 500;
    const commandRow = ({ runId, generatedAt, defaultTotal, scopeleaseTotal }) => ({
      kind: "scopelease.agent_pair_harness",
      runId,
      generatedAt,
      observationKind: "live_observed_agent_visible_pair",
      claimScope: "live_observed_agent_visible_pair_not_provider_billing",
      summary: {
        defaultTokens: 50,
        scopeleaseTokens: 200,
        savedTokens: -150,
        savedPercent: -300
      },
      rows: [{
        taskId: `command-task-${index}`,
        pairId: `command-pair-${index}`,
        workIntent: `command live ${index}`,
        request: `Review command token behavior ${index}`,
        category: "devops_config",
        baselineMode: "natural_request",
        scopeleaseMode: "micro_context",
        commandReportedTotalTokens: {
          status: "measured",
          defaultTokens: defaultTotal,
          scopeleaseTokens: scopeleaseTotal,
          savedTokens: defaultTotal - scopeleaseTotal,
          savedPercent: Math.round(((defaultTotal - scopeleaseTotal) / defaultTotal) * 100),
          source: "codex_cli_stderr_tokens_used"
        },
        events: [
          {
            lane: "default-codex",
            command: {
              status: "passed",
              quality: { status: "quality_pass", passed: true, score: 4, maxScore: 4, missingSignals: [] }
            }
          },
          {
            lane: "scopelease-codex",
            command: {
              status: "passed",
              quality: { status: "quality_pass", passed: true, score: 4, maxScore: 4, missingSignals: [] }
            }
          }
        ]
      }]
    });
    fs.writeFileSync(path.join(runDir, "summary.json"), `${JSON.stringify(commandRow({
      runId: `command-live-${index}`,
      generatedAt: `2026-05-14T01:0${index}:00.000Z`,
      defaultTotal: defaultTokens,
      scopeleaseTotal: scopeleaseTokens
    }), null, 2)}\n`);
    const repeatDir = path.join(root, ".scopelease", "experiments", `command-live-repeat-${index}`);
    fs.mkdirSync(repeatDir, { recursive: true });
    fs.writeFileSync(path.join(repeatDir, "summary.json"), `${JSON.stringify(commandRow({
      runId: `command-live-repeat-${index}`,
      generatedAt: `2026-05-14T02:0${index}:00.000Z`,
      defaultTotal: defaultTokens + 1_000,
      scopeleaseTotal: scopeleaseTokens + 100
    }), null, 2)}\n`);
    return root;
  });

  const agentVisible = buildProductWideTokenSummary(roots, {
    minRepos: 3,
    minPairs: 3,
    minDefaultTokens: 100
  });
  assert.equal(agentVisible.status, "insufficient_real_use_observed_pairs");
  assert.equal(agentVisible.commandReported.status, "pilot_ready_not_formal_claim");
  assert.equal(agentVisible.commandReported.measuredRepoCount, 3);
  assert.equal(agentVisible.commandReported.measuredPairCount, 3);
  assert.equal(agentVisible.commandReported.claimPolicy.canClaimPilotDelta, true);
  assert.equal(agentVisible.commandReported.claimPolicy.canClaimProductWideAverageSavings, false);

  const commandReported = buildProductWideTokenSummary(roots, {
    minRepos: 3,
    minPairs: 3,
    minDefaultTokens: 100,
    claimMetric: "command-reported"
  });
  assert.equal(commandReported.boundary, "command_reported_total_tokens_not_provider_billing");
  assert.equal(commandReported.metric, "strict_command_reported_total_tokens_same_work_intent_pairs_only");
  assert.equal(commandReported.status, "pilot_ready_not_formal_claim");
  assert.equal(commandReported.meetsFormalProductWideFloor, false);
  assert.equal(commandReported.claimPolicy.canClaimPilotDelta, true);
  assert.equal(commandReported.claimPolicy.canClaimProductWideAverageDelta, false);
  assert.equal(commandReported.claimPolicy.canClaimProductWideAverageSavings, false);
  assert.equal(commandReported.measuredRepoCount, 3);
  assert.equal(commandReported.measuredPairCount, 3);
  assert.equal(commandReported.weighted.defaultTokens, 36_000);
  assert.equal(commandReported.weighted.scopeleaseTokens, 13_800);
  assert.equal(commandReported.weighted.savedPercent, 62);
  assert.equal(commandReported.commandReported.quality.commandPassedPairs, 3);
  assert.equal(commandReported.commandReported.quality.completionQualityPassedPairs, 3);
  assert.equal(commandReported.commandReported.quality.heuristicQualityPassedPairs, 3);
  assert.equal(commandReported.agentVisible.status, "insufficient_real_use_observed_pairs");
  assert.match(commandReported.claimPolicy.allowedClaim, /pilot command-reported same-workIntent measurement only/);

  const repeated = buildProductWideTokenSummary(roots, {
    minRepos: 3,
    minPairs: 6,
    minDefaultTokens: 100,
    claimMetric: "command-reported",
    commandPairSelection: "all",
    runIdPrefix: "command-live-"
  });
  assert.equal(repeated.commandPairSelection, "all");
  assert.equal(repeated.status, "pilot_ready_not_formal_claim");
  assert.equal(repeated.claimPolicy.canClaimPilotDelta, true);
  assert.equal(repeated.claimPolicy.canClaimProductWideAverageSavings, false);
  assert.equal(repeated.measuredPairCount, 6);
  assert.equal(repeated.commandReported.quality.commandPassedPairs, 6);
  assert.equal(repeated.commandReported.quality.completionQualityPassedPairs, 6);
  assert.equal(repeated.commandReported.byTaskType[0].taskType, "devops_config");
});

test("product-wide summary defaults keep average-savings threshold conservative", () => {
  const roots = Array.from({ length: 3 }, (_, index) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `scopelease-product-default-threshold-${index}-`));
    fs.writeFileSync(path.join(root, "README.md"), `repo ${index}\n`);
    const state = initRepository(root);
    saveState(root, {
      ...state,
      actualWorkEvents: [
        {
          kind: "scopelease.actual_work_event",
          lane: "default-codex",
          source: "agent-command:prompt",
          workIntent: `default threshold task ${index}`,
          pairId: `default-threshold-pair-${index}`,
          runId: `default-threshold-${index}:default`,
          phase: "input",
          tokens: 1000,
          timestamp: `2026-05-14T02:00:0${index}.000Z`
        },
        {
          kind: "scopelease.actual_work_event",
          lane: "scopelease-codex",
          source: "agent-command:prompt",
          workIntent: `default threshold task ${index}`,
          pairId: `default-threshold-pair-${index}`,
          runId: `default-threshold-${index}:scopelease`,
          phase: "input",
          tokens: 400,
          timestamp: `2026-05-14T02:00:1${index}.000Z`
        }
      ],
      mcpContextEvents: [
        {
          kind: "scopelease.mcp_context_event",
          lane: "scopelease-codex",
          workIntent: `default threshold task ${index}`,
          pairId: `default-threshold-pair-${index}`,
          runId: `default-threshold-${index}:scopelease`,
          tokens: 100,
          timestamp: `2026-05-14T02:00:2${index}.000Z`
        }
      ]
    });
    return root;
  });

  const summary = buildProductWideTokenSummary(roots);
  assert.equal(summary.minRepos, 3);
  assert.equal(summary.minPairs, 10);
  assert.equal(summary.measuredRepoCount, 3);
  assert.equal(summary.measuredPairCount, 3);
  assert.equal(summary.status, "insufficient_real_use_observed_pairs");
  assert.equal(summary.claimPolicy.canClaimProductWideAverageSavings, false);
});

test("claim report exports patent-safe command and permission evidence boundaries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-claim-report-"));
  fs.writeFileSync(path.join(root, "README.md"), "claim report repo\n");
  initRepository(root);
  const runDir = path.join(root, ".scopelease", "experiments", "claim-report-run");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "summary.json"), `${JSON.stringify({
    kind: "scopelease.agent_pair_harness",
    runId: "claim-report-run",
    generatedAt: "2026-05-20T00:00:00.000Z",
    observationKind: "live_observed_agent_visible_pair",
    claimScope: "live_observed_agent_visible_pair_not_provider_billing",
    rows: [{
      taskId: "claim-report-task",
      pairId: "claim-report-pair",
      workIntent: "claim report task",
      request: "Review claim report behavior.",
      category: "permission_workflow",
      commandReportedTotalTokens: {
        status: "measured",
        defaultTokens: 1000,
        scopeleaseTokens: 500,
        savedTokens: 500,
        savedPercent: 50,
        source: "codex_cli_stderr_tokens_used"
      },
      decisionMetrics: {
        defaultDecisionPrompts: 10,
        scopeleaseDecisionPrompts: 2,
        reducedDecisionPrompts: 8,
        reductionPercent: 80
      },
      events: [
        {
          lane: "default-codex",
          command: {
            status: "passed",
            durationMs: 2000,
            quality: { status: "quality_pass", passed: true, score: 4, maxScore: 4, missingSignals: [] }
          }
        },
        {
          lane: "scopelease-codex",
          command: {
            status: "passed",
            durationMs: 1000,
            quality: { status: "quality_pass", passed: true, score: 4, maxScore: 4, missingSignals: [] }
          }
        }
      ]
    }]
  }, null, 2)}\n`);
  const fixtureDir = path.join(root, ".scopelease", "fixtures", "runs", "permission-current");
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, "summary.json"), `${JSON.stringify({
    total: 2,
    passed: 2,
    failed: 0,
    humanPrompts: 1,
    denies: 1,
    leaseHits: 1
  }, null, 2)}\n`);

  const defaultThresholdResult = buildClaimReadyReport(root, {
    repos: [root],
    runIdPrefix: "claim-report-run",
    outputDir: path.join(root, ".scopelease", "reports", "claim-report-default")
  });
  assert.equal(defaultThresholdResult.report.productWide.minRepos, 3);
  assert.equal(defaultThresholdResult.report.productWide.minPairs, 10);
  assert.equal(defaultThresholdResult.report.productWide.commandReported.status, "insufficient_command_reported_pairs");
  assert.equal(defaultThresholdResult.report.axes.contextTokens.status, "insufficient_command_reported_pairs");
  assert.equal(defaultThresholdResult.report.status, "partial_evidence_ready");

  const result = buildClaimReadyReport(root, {
    repos: [root],
    minRepos: 1,
    minPairs: 1,
    runIdPrefix: "claim-report-run",
    outputDir: path.join(root, ".scopelease", "reports", "claim-report-test")
  });

  assert.equal(result.report.status, "partial_evidence_ready");
  assert.equal(result.report.axes.contextTokens.status, "pilot_ready_not_formal_claim");
  assert.equal(result.report.axes.contextTokens.formalAverageStatus, "not_ready");
  assert.equal(result.report.axes.permission.status, "fixture_ready");
  assert.equal(result.report.axes.decisionFatigue.promptSuppressionPercent, 80);
  assert.equal(result.report.axes.decisionFatigue.defaultDecisionPrompts, 10);
  assert.equal(result.report.axes.decisionFatigue.scopeleaseDecisionPrompts, 2);
  assert.equal(result.report.axes.timeToResult.status, "duration_proxy_ready_for_named_command_protocol");
  assert.equal(result.report.axes.timeToResult.defaultDurationMs, 2000);
  assert.equal(result.report.axes.timeToResult.scopeleaseDurationMs, 1000);
  assert.equal(result.report.axes.timeToResult.savedPercent, 50);
  assert.ok(fs.existsSync(path.join(result.outputDir, "claim-ready-report.md")));
  const markdown = fs.readFileSync(path.join(result.outputDir, "claim-ready-report.md"), "utf8");
  assert.match(markdown, /does not claim provider billing/i);
  assert.match(markdown, /Formal average grade/i);
  assert.match(markdown, /Time to result/);
  assert.match(markdown, /proxy prompts 10 -> 2, 80%/);
  assert.match(markdown, /Do Not Claim/);
  assert.doesNotMatch(markdown, /at least three repositories before using product-wide average language/);
  assert.match(markdown, /10-20 repositories and at least 100 measured pairs/);
});

test("human decision study export writes protocol, task sheet, and rating sheet", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-human-study-"));
  fs.writeFileSync(path.join(root, "README.md"), "human study repo\n");
  initRepository(root);

  const result = exportHumanDecisionStudyProtocol(root, {
    outputDir: path.join(root, ".scopelease", "studies", "decision-fatigue-test")
  });

  assert.equal(result.protocol.tasks.length, 12);
  assert.ok(fs.existsSync(path.join(result.outputDir, "protocol.md")));
  assert.ok(fs.existsSync(path.join(result.outputDir, "tasks.jsonl")));
  assert.ok(fs.existsSync(path.join(result.outputDir, "task-sheet.csv")));
  assert.ok(fs.existsSync(path.join(result.outputDir, "rating-sheet.csv")));
  const protocol = fs.readFileSync(path.join(result.outputDir, "protocol.md"), "utf8");
  const analysisPlan = fs.readFileSync(path.join(result.outputDir, "analysis-plan.md"), "utf8");
  const ratings = fs.readFileSync(path.join(result.outputDir, "rating-sheet.csv"), "utf8");
  assert.match(protocol, /within_subject_counterbalanced/);
  assert.match(protocol, /does not by itself prove human cognitive-fatigue reduction/);
  assert.match(protocol, /delegation_decision_accuracy/);
  assert.match(protocol, /out_of_scope_detection/);
  assert.match(protocol, /remembered_scope_accuracy/);
  assert.match(protocol, /Pilot: 6 to 8 participants/);
  assert.match(protocol, /Minimum analyzable main study: 24 participants/);
  assert.match(protocol, /Target main study: 36 participants/);
  assert.doesNotMatch(protocol, /At least 12 participants/);
  assert.match(analysisPlan, /Minimum analyzable main study: 24 participants/);
  assert.match(analysisPlan, /Target main study: 36 participants/);
  assert.doesNotMatch(analysisPlan, /At least 12 participants/);
  assert.ok(result.protocol.conditions.includes("graph_context_only_decision_card"));
  assert.match(protocol, /graph_context_only_decision_card/);
  assert.deepEqual(result.protocol.primaryMeasures, [
    "delegation_decision_accuracy",
    "unsafe_allow_rate",
    "out_of_scope_detection",
    "remembered_scope_accuracy",
    "time_to_decision_ms",
    "workload_rating_1_7"
  ]);
  assert.match(ratings, /participant_decision/);
  assert.match(ratings, /gold_decision/);
  assert.match(ratings, /delegation_decision_correct/);
  assert.match(ratings, /scope_inside_gold/);
  assert.match(ratings, /scope_inside_response/);
  assert.match(ratings, /out_of_scope_detected/);
  assert.match(ratings, /false_block/);
  assert.match(ratings, /ask_when_needed/);
  assert.match(ratings, /decision_reason_code/);
  assert.match(ratings, /workload_mental_demand_1_7/);
  assert.match(ratings, /graph_context_only_decision_card/);
  assert.match(ratings, /scopelease_signed_scoped_lease/);
});

test("archival pilot evidence is pilot-only rather than product-wide claim-ready", () => {
  const summaryPath = path.join(
    process.cwd(),
    ".scopelease/experiments/pilot-codex-main-20260603/product-wide-summary.json"
  );
  const reportPath = path.join(
    process.cwd(),
    ".scopelease/reports/pilot-codex-main-20260603/claim-ready-report.json"
  );
  const markdownPath = path.join(
    process.cwd(),
    ".scopelease/reports/pilot-codex-main-20260603/claim-ready-report.md"
  );
  const artifactTexts = [
    fs.readFileSync(summaryPath, "utf8"),
    fs.readFileSync(reportPath, "utf8"),
    fs.readFileSync(markdownPath, "utf8")
  ];
  for (const text of artifactTexts) {
    assert.doesNotMatch(text, /claim_ready_for_named_command_protocol/);
    assert.doesNotMatch(text, /"status": "claim_ready"/);
    assert.doesNotMatch(text, /"canClaimProductWideAverageSavings": true/);
    assert.doesNotMatch(text, /product-wide command-reported total token savings/);
    assert.doesNotMatch(text, /current claim-ready threshold/);
  }

  const summary = JSON.parse(artifactTexts[0]);
  assert.equal(summary.status, "pilot_ready_not_formal_claim");
  assert.equal(summary.meetsFormalProductWideFloor, false);
  assert.equal(summary.claimScope, "pilot_below_formal_floor");
  assert.equal(summary.commandReported.status, "pilot_ready_not_formal_claim");
  assert.equal(summary.commandReported.meetsFormalProductWideFloor, false);
  assert.equal(summary.claimPolicy.canClaimPilotDelta, true);
  assert.equal(summary.claimPolicy.canClaimProductWideAverageSavings, false);
  assert.equal(summary.claimPolicy.canClaimFormalProductWideAverageSavings, false);

  const report = JSON.parse(artifactTexts[1]);
  assert.equal(report.axes.contextTokens.status, "pilot_ready_not_formal_claim");
  assert.equal(report.axes.contextTokens.formalAverageStatus, "not_ready");
  assert.equal(report.productWide.status, "pilot_ready_not_formal_claim");
  assert.equal(report.productWide.commandReported.status, "pilot_ready_not_formal_claim");
  assert.equal(report.productWide.claimPolicy.canClaimProductWideAverageSavings, false);
  assert.equal(report.productWide.claimPolicy.canClaimFormalProductWideAverageSavings, false);

  assert.match(artifactTexts[2], /pilot_ready_not_formal_claim/);
  assert.match(artifactTexts[2], /not average savings/);
});

test("product-wide summary keeps paired provider usage separate from agent-visible input claims", () => {
  const roots = Array.from({ length: 3 }, (_, index) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `scopelease-provider-wide-${index}-`));
    fs.writeFileSync(path.join(root, "README.md"), `repo ${index}\n`);
    const state = initRepository(root);
    saveState(root, {
      ...state,
      modelUsageEvents: [
        {
          kind: "scopelease.model_usage_event",
          lane: "default-codex",
          workIntent: `provider task ${index}`,
          pairId: `provider-pair-${index}`,
          runId: `provider-default-${index}`,
          totalTokens: 1000,
          totalMeasured: true,
          totalCostUsd: 0.01,
          costMeasured: true,
          timestamp: `2026-05-14T01:00:0${index}.000Z`
        },
        {
          kind: "scopelease.model_usage_event",
          lane: "scopelease-codex",
          workIntent: `provider task ${index}`,
          pairId: `provider-pair-${index}`,
          runId: `provider-scopelease-${index}`,
          totalTokens: 400 + index * 10,
          totalMeasured: true,
          totalCostUsd: 0.004 + index * 0.0001,
          costMeasured: true,
          timestamp: `2026-05-14T01:00:1${index}.000Z`
        }
      ],
      actualWorkEvents: [],
      mcpContextEvents: []
    });
    return root;
  });

  const summary = buildProductWideTokenSummary(roots, { minRepos: 3, minPairs: 3 });
  assert.equal(summary.status, "insufficient_real_use_observed_pairs");
  assert.equal(summary.claimPolicy.canClaimProductWideAverageSavings, false);
  assert.equal(summary.providerBilling.status, "claim_ready");
  assert.equal(summary.providerBilling.measuredRepoCount, 3);
  assert.equal(summary.providerBilling.measuredPairCount, 3);
  assert.equal(summary.providerBilling.weighted.defaultTokens, 3000);
  assert.equal(summary.providerBilling.weighted.scopeleaseTokens, 1230);
  assert.equal(summary.providerBilling.costWeighted.defaultCostUsd, 0.03);
  assert.equal(summary.providerBilling.costWeighted.scopeleaseCostUsd, 0.0123);
  assert.equal(summary.providerBilling.costWeighted.savedCostPercent, 59);
  assert.equal(summary.providerBilling.claimPolicy.canClaimProviderBillingSavings, true);
  assert.equal(summary.providerBilling.claimPolicy.canClaimProviderCostSavings, true);
  assert.equal(summary.claimPolicy.canClaimProviderBillingSavings, true);
});

test("usage ingest accepts provider cost_summary files without mixing billing into agent-visible claims", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-provider-cost-summary-"));
  initRepository(root);
  const costPath = path.join(root, "cost_summary.json");
  fs.writeFileSync(costPath, JSON.stringify({
    total_cost_usd: 0.4104,
    total_calls: 18,
    total_input_tokens: 1_467_567,
    total_output_tokens: 318_911
  }));

  const cli = spawnSync(process.execPath, [
    path.resolve("src/cli.js"),
    "usage",
    root,
    "--usage-path",
    costPath,
    "--lane",
    "scopelease-codex",
    "--pair-id",
    "cost-pair",
    "--work-intent",
    "provider billing import"
  ], { cwd: path.resolve("."), encoding: "utf8" });

  assert.equal(cli.status, 0, cli.stderr);
  const parsed = JSON.parse(cli.stdout);
  assert.equal(parsed.event.inputTokens, 1_467_567);
  assert.equal(parsed.event.outputTokens, 318_911);
  assert.equal(parsed.event.totalTokens, 1_786_478);
  assert.equal(parsed.event.totalMeasured, true);
  assert.equal(parsed.event.totalCostUsd, 0.4104);
  assert.equal(parsed.event.costMeasured, true);
  assert.equal(parsed.event.totalCalls, 18);

  const summary = buildProductWideTokenSummary([root], { minRepos: 1, minPairs: 1 });
  assert.equal(summary.status, "insufficient_real_use_observed_pairs");
  assert.equal(summary.providerBilling.status, "insufficient_provider_usage_pairs");
  assert.equal(summary.claimPolicy.canClaimProductWideAverageSavings, false);
});

test("agent usage detector classifies agent-visible signals without provider usage", { skip: sqlite3Missing() }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-usage-detect-"));
  const codexHome = path.join(root, "codex-home");
  const otherRoot = path.join(root, "other");
  fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(root, ".codex", "config.toml"), [
    "[features]",
    "hooks = true",
    "",
    "[mcp_servers.scopelease]",
    "command = \"node\""
  ].join("\n"));
  fs.writeFileSync(path.join(root, ".codex", "hooks.json"), JSON.stringify({ hooks: { UserPromptSubmit: [] } }));
  const dbPath = path.join(codexHome, "state_5.sqlite");
  const extraOtherRows = Array.from({ length: 1001 }, (_, index) => (
    `insert into threads values ('thread-other-extra-${index}', ${sqlQuote(otherRoot)}, 'openai', 'gpt-test', 1, ${1777826600 + index}, ${1777826600 + index}, 'other extra ${index}');`
  ));
  execFileSync("sqlite3", [dbPath, [
    "create table threads (id text, cwd text, model_provider text, model text, tokens_used integer, created_at integer, updated_at integer, title text);",
    `insert into threads values ('thread-1', ${sqlQuote(root)}, 'openai', 'gpt-test', 1000, 1777826500, 1777826501, 'one');`,
    `insert into threads values ('thread-2', ${sqlQuote(root)}, 'openai', 'gpt-test', 2000, 1777826502, 1777826503, 'two');`,
    `insert into threads values ('thread-other', ${sqlQuote(otherRoot)}, 'openai', 'gpt-test', 9999, 1777826504, 1777826505, 'other');`,
    ...extraOtherRows
  ].join("\n")]);

  const state = {
    mcpContextEvents: [{ tokens: 120 }],
    actualWorkEvents: [{ tokens: 180 }],
    modelUsageEvents: [],
    latestAnalysis: {
      contextPack: {
        tokenEconomy: {
          tokenizer: { method: "rough_chars_div_4", encoding: "fallback", exact: false }
        }
      }
    }
  };

  const detection = detectAgentVisibleUsage({
    repoPath: root,
    state,
    codexHome,
    appSupportDir: path.join(root, "app-support"),
    env: {}
  });

  assert.equal(detection.safeWithoutBilling, true);
  assert.equal(detection.networkUsed, false);
  assert.equal(detection.kind, "scopelease.agent_visible_usage_detection");
  assert.equal(detection.measurementBoundary, "agent_visible_context_not_provider_billing");
  assert.equal(detection.providerUsageExcluded, true);
  assert.equal(detection.config.scopeleaseMcpConfigured, true);
  assert.equal(detection.config.codexHooksEnabled, true);
  assert.equal(detection.scopeleaseMcpInput.status, "available");
  assert.equal(detection.scopeleaseMcpInput.tokens, 120);
  assert.equal(detection.observedToolPayload.status, "available");
  assert.equal(detection.observedToolPayload.tokens, 180);
  assert.equal(detection.codexLocalAggregate.status, "available");
  assert.equal(detection.codexLocalAggregate.currentRepoThreads, 2);
  assert.equal(detection.codexLocalAggregate.currentRepoThreadRecords, 2);
  assert.equal(detection.codexLocalAggregate.recordType, "historical_cwd_matched_codex_thread_records");
  assert.equal(detection.codexLocalAggregate.activeSessionClaim, false);
  assert.equal(detection.codexLocalAggregate.totalTokens, 3000);
  assert.equal(detection.codexLocalAggregate.latestThread.id, "thread-2");
  assert.equal(detection.codexLocalAggregate.latestThread.recordType, "codex_sqlite_thread_record");
  assert.equal(detection.codexLocalAggregate.latestThread.activeSessionStatus, "not_measured");
  assert.equal(detection.codexLocalAggregate.excludedWorkspaceCount, 1);
  assert.equal(detection.codexSessionKnowledgeGraph.kind, "codex_session_knowledge_graph");
  assert.equal(detection.codexSessionKnowledgeGraph.nodes.filter((node) => node.labels.includes("CodexThreadRecord")).length, 2);
  assert.ok(detection.codexSessionKnowledgeGraph.edges.some((edge) => edge.relationshipType === "HAS_CODEX_THREAD_RECORD"));
  assert.equal(detection.codexSessionInventory.totalWorkspaces, 2);
  assert.equal(detection.codexSessionInventory.totalThreads, 1004);
  assert.equal(detection.codexSessionInventory.totalTokens, 14000);
  assert.deepEqual(detection.codexSessionInventory.query, {
    scope: "all_threads",
    limit: null,
    truncated: false,
    rowsReturned: 1004
  });
  assert.equal(detection.codexSessionInventory.scope.includedWorkspaceCount, 1);
  assert.equal(detection.codexSessionInventory.scope.includedTokens, 3000);
  assert.equal(detection.codexSessionInventory.scope.includedThreadRecords, 2);
  assert.equal(detection.codexSessionInventory.scope.excludedWorkspaceCount, 1);
  assert.equal(detection.codexSessionInventory.scope.excludedThreads, 1002);
  assert.equal(detection.codexSessionInventory.scope.excludedThreadRecords, 1002);
  assert.equal(detection.codexSessionInventory.scope.excludedTokens, 11000);
  assert.equal(detection.codexSessionInventory.scope.activeSessionClaim, false);
  assert.ok(detection.codexSessionInventory.workspaces.some((workspace) => workspace.cwd === otherRoot));
  assert.equal(detection.agentVisibleUsage.status, "available");
  assert.equal(detection.agentVisibleUsage.observedPayloadTokens, 300);
  assert.equal(detection.agentVisibleUsage.sources.find((source) => source.source === "codex_local_aggregate").tokens, 3000);
  assert.equal(detection.pairedLaneEvidence.status, "needs_pair");
  assert.equal(detection.researchCalibration.scope, "separate_from_product_runtime");
  assert.equal(detection.researchCalibration.status, "insufficient_pair");
  assert.equal(detection.researchCalibration.productRuntimeImpact.extraAgentRuns, 0);
  assert.equal(detection.capability.canMeasureProviderBillingSavings, false);
  assert.equal(detection.excludedProviderUsage.status, "excluded");
  assert.ok(detection.classifications.some((item) => item.kind === "codex_local_aggregate"));
  assert.ok(detection.recommendations.some((item) => item.includes("agent-visible")));

  const hub = await detectHubProjects({
    repoPath: root,
    state,
    codexHome,
    includeHealth: false
  });
  assert.equal(hub.kind, "scopelease.hub_projects");
  assert.equal(hub.mode, "global_inventory_project_local_effects");
  assert.equal(hub.projectLocalEffectsOnly, true);
  assert.equal(hub.totals.projects, 2);
  assert.equal(hub.totals.threadRecords, 1004);
  assert.ok(hub.projects.some((project) => project.cwd === otherRoot));
  const rootProject = hub.projects.find((project) => project.cwd === root);
  assert.equal(rootProject.scopelease.attached, true);
  assert.equal(rootProject.runtime.status, "not_checked");
  assert.equal(rootProject.runtime.port, projectPort(root));
  assert.equal(rootProject.effects.scope, "project_local");
  assert.ok(hub.knowledgeGraph.nodes.some((node) => node.labels.includes("ScopeLeaseHub")));
  assert.ok(hub.knowledgeGraph.nodes.some((node) => node.labels.includes("ScopeLeaseProject")));
  assert.ok(hub.knowledgeGraph.edges.some((edge) => edge.relationshipType === "HUB_MANAGES_PROJECT"));
});

test("paired lane evidence is scoped by workIntent and runId", { skip: sqlite3Missing() }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-paired-evidence-"));
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(codexHome, { recursive: true });
  execFileSync("sqlite3", [path.join(codexHome, "state_5.sqlite"), [
    "create table threads (id text, cwd text, model_provider text, model text, tokens_used integer, created_at integer, updated_at integer, title text);"
  ].join("\n")]);

  const detection = detectAgentVisibleUsage({
    repoPath: root,
    codexHome,
    state: {
      mcpContextEvents: [
        { kind: "scopelease.mcp_context_event", lane: "scopelease-codex", workIntent: "same intent", pairId: "pair-a", runId: "scopelease-run-a", timestamp: "2026-05-09T00:00:01.000Z", tokens: 120 },
        { kind: "scopelease.mcp_context_event", lane: "scopelease-codex", workIntent: "same intent", pairId: "pair-a", runId: "scopelease-run-a:default-baseline", timestamp: "2026-05-09T00:00:04.000Z", tokens: 9999 },
        { kind: "scopelease.mcp_context_event", lane: "scopelease-codex", workIntent: "other intent", runId: "run-b", timestamp: "2026-05-09T00:00:04.000Z", tokens: 900 }
      ],
      actualWorkEvents: [
        { lane: "default-codex", workIntent: "same intent", pairId: "pair-a", runId: "default-run-old", timestamp: "2026-05-08T23:59:59.000Z", tokens: 5000 },
        { lane: "default-codex", workIntent: "same intent", pairId: "pair-a", runId: "default-run-a", timestamp: "2026-05-09T00:00:02.000Z", tokens: 1000 },
        { lane: "scopelease-codex", workIntent: "same intent", pairId: "pair-a", runId: "scopelease-run-a", timestamp: "2026-05-09T00:00:03.000Z", tokens: 80 },
        { lane: "scopelease-internal", workIntent: "same intent", pairId: "pair-a", runId: "scopelease-run-a", timestamp: "2026-05-09T00:00:03.250Z", tokens: 7000 },
        { lane: "scopelease-codex", phase: "output", workIntent: "same intent", pairId: "pair-a", runId: "scopelease-run-a", timestamp: "2026-05-09T00:00:03.500Z", tokens: 9000 },
        { lane: "scopelease-internal", workIntent: "same intent", timestamp: "2026-05-09T00:00:06.000Z", tokens: 12000 },
        { lane: "default-codex", workIntent: "other intent", runId: "run-c", timestamp: "2026-05-09T00:00:05.000Z", tokens: 5000 }
      ],
      latestAnalysis: { contextPack: { tokenEconomy: { tokenizer: { method: "rough_chars_div_4", exact: false } } } }
    }
  });

  assert.equal(detection.pairedLaneEvidence.status, "available");
  assert.equal(detection.pairedLaneEvidence.workIntent, "same intent");
  assert.equal(detection.pairedLaneEvidence.pairId, "pair-a");
  assert.equal(detection.pairedLaneEvidence.pairSelection, "latest_pair_id");
  assert.equal(detection.pairedLaneEvidence.defaultCodexObservedInputTokens, 1000);
  assert.equal(detection.pairedLaneEvidence.scopeleaseCodexObservedInputTokens, 200);
  assert.equal(detection.pairedLaneEvidence.savedTokens, 800);
  assert.equal(detection.pairedLaneEvidence.deltaDirection, "savings");
  assert.equal(detection.pairedLaneEvidence.eventCounts.default, 1);
  assert.equal(detection.pairedLaneEvidence.eventCounts.scopeleaseContext, 1);
  assert.equal(detection.pairedLaneEvidence.eventCounts.scopeleaseWork, 1);
  assert.equal(detection.researchCalibration.status, "claim_ready");
  assert.equal(detection.researchCalibration.claimPolicy.canClaimExactDelta, true);
  assert.equal(detection.researchCalibration.claimPolicy.canClaimExactSavings, true);
  assert.equal(detection.capability.canMeasureAgentVisiblePairDelta, true);
  assert.equal(detection.capability.canClaimAgentVisiblePairSavings, true);
  assert.equal(detection.capability.canMeasureAgentVisiblePairSavings, true);
});

test("agent usage detector separates exact paired delta from positive savings claims", () => {
  const detection = detectAgentVisibleUsage({
    repoPath: fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-negative-pair-")),
    codexHome: fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-negative-codex-home-")),
    state: {
      mcpContextEvents: [
        { kind: "scopelease.mcp_context_event", lane: "scopelease-codex", workIntent: "same intent", pairId: "pair-a", runId: "scopelease-run-a", timestamp: "2026-05-09T00:00:01.000Z", tokens: 500 }
      ],
      actualWorkEvents: [
        { lane: "default-codex", phase: "input", workIntent: "same intent", pairId: "pair-a", runId: "default-run-a", timestamp: "2026-05-09T00:00:02.000Z", tokens: 100 },
        { lane: "scopelease-codex", phase: "input", workIntent: "same intent", pairId: "pair-a", runId: "scopelease-run-a", timestamp: "2026-05-09T00:00:03.000Z", tokens: 50 }
      ]
    }
  });

  assert.equal(detection.pairedLaneEvidence.status, "available");
  assert.equal(detection.pairedLaneEvidence.defaultCodexObservedInputTokens, 100);
  assert.equal(detection.pairedLaneEvidence.scopeleaseCodexObservedInputTokens, 550);
  assert.equal(detection.pairedLaneEvidence.savedTokens, -450);
  assert.equal(detection.pairedLaneEvidence.deltaDirection, "increase");
  assert.equal(detection.pairedLaneEvidence.canClaimPositiveSavings, false);
  assert.equal(detection.researchCalibration.status, "delta_ready_no_savings");
  assert.equal(detection.researchCalibration.claimPolicy.canClaimExactDelta, true);
  assert.equal(detection.researchCalibration.claimPolicy.canClaimExactSavings, false);
  assert.equal(detection.researchCalibration.claimPolicy.canClaimPositiveSavings, false);
  assert.equal(detection.capability.canMeasureAgentVisiblePairDelta, true);
  assert.equal(detection.capability.canClaimAgentVisiblePairSavings, false);
  assert.equal(detection.capability.canMeasureAgentVisiblePairSavings, false);
  assert.match(detection.researchCalibration.claimPolicy.allowedClaim, /do not call it savings/);
  assert.match(detection.recommendations.join("\n"), /do not call it savings/);
});

test("agent usage detector pairs legacy request-only events by derived work intent", () => {
  const request = "Finding 9 src/runtime/mcp-server.js legacy pair 연결 확인";
  const intent = deriveWorkIntent({ request });
  const detection = detectAgentVisibleUsage({
    repoPath: fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-legacy-pair-")),
    codexHome: fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-legacy-codex-home-")),
    state: {
      mcpContextEvents: [
        { kind: "scopelease.mcp_context_event", lane: "scopelease-codex", workIntent: intent, runId: "legacy-run", timestamp: "2026-05-09T00:00:01.000Z", tokens: 120 }
      ],
      actualWorkEvents: [
        { lane: "default-codex", userRequest: request, runId: "legacy-run", timestamp: "2026-05-09T00:00:02.000Z", tokens: 1000 },
        { lane: "scopelease-codex", userRequest: request, runId: "legacy-run", timestamp: "2026-05-09T00:00:03.000Z", tokens: 80 }
      ]
    }
  });

  assert.equal(detection.pairedLaneEvidence.status, "available");
  assert.equal(detection.pairedLaneEvidence.workIntent, intent);
  assert.equal(detection.pairedLaneEvidence.defaultCodexObservedInputTokens, 1000);
  assert.equal(detection.pairedLaneEvidence.scopeleaseCodexObservedInputTokens, 200);
  assert.equal(detection.researchCalibration.status, "claim_ready");
});

test("agent usage detector requires ScopeLease MCP context for paper claim readiness", () => {
  const detection = detectAgentVisibleUsage({
    repoPath: fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-no-mcp-claim-")),
    codexHome: fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-no-mcp-codex-home-")),
    state: {
      mcpContextEvents: [],
      actualWorkEvents: [
        { lane: "default-codex", workIntent: "same intent", pairId: "pair-a", timestamp: "2026-05-09T00:00:02.000Z", tokens: 1000 },
        { lane: "scopelease-codex", workIntent: "same intent", pairId: "pair-a", timestamp: "2026-05-09T00:00:03.000Z", tokens: 120 }
      ]
    }
  });

  assert.equal(detection.pairedLaneEvidence.status, "needs_pair");
  assert.equal(detection.researchCalibration.status, "insufficient_pair");
  assert.equal(detection.researchCalibration.claimPolicy.canClaimExactSavings, false);
  assert.deepEqual(detection.researchCalibration.pairedCalibrationCost.missingEvidence, ["scopelease_get_context or embedded ScopeLease context prompt evidence"]);
});

test("documentation-only policy is logged without human approval", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-doc-test-"));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs/readme.md"), "# Notes\n\nInitial note.\n");

  initRepository(root);
  fs.writeFileSync(path.join(root, "docs/readme.md"), "# Notes\n\nInitial note.\nUpdated wording.\n");

  const analysis = analyzeRepository(root);
  const gate = analysis.contextPack.decisionGate;
  assert.equal(analysis.risk, "low");
  assert.equal(analysis.recommendation, "log_only");
  assert.equal(gate.status, "log_only");
  assert.equal(gate.scopeleaserityLabel, "감사 로그");
  assert.equal(gate.canAutoApplyPatch, true);
  assert.equal(gate.requiredChecks.length, 0);
  assert.equal(analysis.contextPack.agentContext.fatiguePlan.permissionNeed.humanApprovalBeforeApply, false);
  assert.equal(analysis.contextPack.agentContext.fatiguePlan.autonomyPlan.mode, "autonomous_low_risk");
  assert.ok(analysis.contextPack.agentContext.fatiguePlan.autonomyPlan.biasControls.includes("policy_over_model"));
  assert.equal(analysis.contextPack.agentContext.fatiguePlan.decisionBundle.decisionAssistance.surface, "silent");
  assert.equal(analysis.contextPack.agentContext.fatiguePlan.decisionBundle.decisionAssistance.interruptHuman, false);
  assert.equal(analysis.contextPack.agentContext.fatiguePlan.decisionBundle.decisionAssistance.userDecisionKind, "no_user_decision");
});

test("project Codex config preserves model proxy opt-in", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-config-test-"));
  fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codex", "config.toml"), [
    "# Project-local ScopeLease usage metering.",
    "",
    "[features]",
    "hooks = true",
    "openai_base_url = \"http://localhost:3928/proxy/v1\"",
    ""
  ].join("\n"));

  ensureProjectCodexConfig(root, 3928, { nodePath: process.execPath });
  const preservedProxy = fs.readFileSync(path.join(root, ".codex", "config.toml"), "utf8");
  assert.match(preservedProxy, /^# ScopeLease usage proxy\nopenai_base_url = "http:\/\/localhost:3928\/proxy\/v1"/m);
  assert.ok(preservedProxy.indexOf("openai_base_url") < preservedProxy.indexOf("[features]"));
  assert.match(preservedProxy, new RegExp(`\\[mcp_servers\\.scopelease\\]\\s+command = "${escapeRegExp(process.execPath)}"`));
  assert.match(preservedProxy, new RegExp(`args = \\[.*"mcp", "${escapeRegExp(root)}"\\]`));

  const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-config-fresh-test-"));
  ensureProjectCodexConfig(freshRoot, 3928, { nodePath: process.execPath });
  const hooksOnly = fs.readFileSync(path.join(freshRoot, ".codex", "config.toml"), "utf8");
  assert.doesNotMatch(hooksOnly, /openai_base_url/);
  assert.match(hooksOnly, /\[features\]\s+hooks = true/);
  assert.doesNotMatch(hooksOnly, /codex_hooks = true/);
  assert.match(hooksOnly, /\[mcp_servers\.scopelease\]/);
  assert.match(hooksOnly, new RegExp(`args = \\[.*"mcp", "${escapeRegExp(freshRoot)}"\\]`));

  const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-config-legacy-hooks-test-"));
  fs.mkdirSync(path.join(legacyRoot, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, ".codex", "config.toml"), [
    "[features]",
    "codex_hooks = true",
    ""
  ].join("\n"));
  ensureProjectCodexConfig(legacyRoot, 3928, { nodePath: process.execPath });
  const migratedHooks = fs.readFileSync(path.join(legacyRoot, ".codex", "config.toml"), "utf8");
  assert.match(migratedHooks, /\[features\]\s+hooks = true/);
  assert.doesNotMatch(migratedHooks, /codex_hooks = true/);

  const hooksPath = ensureProjectCodexHooks(freshRoot, 3928);
  const hookScript = fs.readFileSync(path.join(freshRoot, ".codex", "hooks", "scopelease-codex-hook.js"), "utf8");
  assert.match(hookScript, /SCOPELEASE_MEASURE_LANE/);
  assert.match(hookScript, /SCOPELEASE_PAIR_ID/);
  assert.match(hookScript, /SCOPELEASE_WORK_INTENT/);
  assert.match(hookScript, /SCOPELEASE_RUN_ID/);
  assert.match(hookScript, /"auto"\)/);
  assert.match(hookScript, /"default-codex"/);
  assert.match(hookScript, /taskIntent/);
  assert.match(hookScript, /scopelease\.semantic_task_intent/);
  assert.match(hookScript, /enforceToolUse/);
  assert.match(hookScript, /"enforce"/);
  assert.match(hookScript, /codex-hook:pre-tool-use/);
  assert.match(hookScript, /await enforceToolUse\(root, event\);\s+await ensureApp\(root, startupRequest\)\.catch/);
  assert.match(hookScript, /phase: "input"/);
  assert.match(hookScript, /postJson\(root, "\/api\/measure"/);
  assert.match(hookScript, /ScopeLease POST .* failed with HTTP/);
  const hooksJson = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  assert.match(hooksJson.hooks.PreToolUse[0].hooks[0].command, /scopelease-codex-hook\.js/);
  assert.match(hooksJson.hooks.PreToolUse[0].matcher, /Bash/);
  assert.match(hooksJson.hooks.PostToolUse[0].hooks[0].command, /scopelease-codex-hook\.js/);

  ensureProjectCodexConfig(root, 3928, { enableModelProxy: true });
  const withProxy = fs.readFileSync(path.join(root, ".codex", "config.toml"), "utf8");
  assert.match(withProxy, /^# ScopeLease usage proxy\nopenai_base_url = "http:\/\/localhost:3928\/proxy\/v1"/m);
  assert.ok(withProxy.indexOf("openai_base_url") < withProxy.indexOf("[features]"));
  assert.equal((withProxy.match(/\[mcp_servers\.scopelease\]/g) || []).length, 1);
});

test("project runtimes do not reuse the hub control port", async () => {
  const collidingRoot = findRawProjectPortPath(4030);
  assert.notEqual(projectPort(collidingRoot), 4030);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-hub-port-test-"));
  const server = http.createServer((req, res) => {
    if (req.url !== "/api/health") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      repo: root,
      runtime: {
        mode: "hub",
        hubMode: true
      }
    }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;

  try {
    await assert.rejects(
      () => ensureScopeLeaseApp({ repoPath: root, port }),
      /reserved for global project inventory/
    );
    assert.equal(fs.existsSync(path.join(root, ".codex", "config.toml")), false);
    assert.equal(fs.existsSync(path.join(root, ".codex", "hooks.json")), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("project app connection does not write attachment when port serves another repo", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-port-conflict-target-"));
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-port-conflict-other-"));
  const server = http.createServer((req, res) => {
    if (req.url !== "/api/health") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      repo: otherRoot,
      runtime: {
        mode: "repo-local",
        hubMode: false
      }
    }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;

  try {
    await assert.rejects(
      () => ensureScopeLeaseApp({ repoPath: root, port }),
      /already serving another repo/
    );
    assert.equal(fs.existsSync(path.join(root, ".codex", "config.toml")), false);
    assert.equal(fs.existsSync(path.join(root, ".codex", "hooks.json")), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("repo-local file browser stays inside the locked repository root", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-fs-lock-"));
  fs.writeFileSync(path.join(root, "README.md"), "repo local");
  initRepository(root);

  const { server, service } = startServer({
    repoPath: root,
    port: 0,
    scanInterval: 0,
    entry: "graph.html",
    label: "ScopeLease test app",
    lockRoot: true
  });
  await waitForListening(server);
  const port = server.address().port;
  assert.equal(server.address().address, "127.0.0.1");

  try {
    const outside = await getJson(`http://127.0.0.1:${port}/api/fs?path=${encodeURIComponent(os.tmpdir())}`);
    assert.equal(outside.status, 400);
    assert.match(outside.body.error, /limited to this repo-local/);

    const inside = await getJson(`http://127.0.0.1:${port}/api/fs?path=${encodeURIComponent(root)}`);
    assert.equal(inside.status, 200);
    assert.equal(inside.body.path, fs.realpathSync(root));
    assert.equal(inside.body.parent, null);
    assert.deepEqual(inside.body.shortcuts, [{ label: "현재 repo", path: fs.realpathSync(root) }]);
    assert.ok(inside.body.entries.some((entry) => entry.name === "README.md" && entry.type === "file"));
  } finally {
    service.close();
    await closeServer(server);
  }
});

test("state endpoint does not mutate latest analysis from stale MCP context", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-state-readonly-"));
  fs.writeFileSync(path.join(root, "README.md"), "repo local");
  initRepository(root);
  analyzeRepository(root, { userRequest: "old visible request" });
  const state = loadState(root);
  saveState(root, {
    ...state,
    mcpContextEvents: [
      {
        kind: "scopelease.mcp_context_event",
        tool: "scopelease_get_context",
        userRequest: "new stale mcp request",
        timestamp: new Date().toISOString(),
        tokens: 10
      }
    ]
  });

  const { server, service } = startServer({
    repoPath: root,
    port: 0,
    scanInterval: 0,
    entry: "graph.html",
    label: "ScopeLease test app",
    lockRoot: true
  });
  await waitForListening(server);
  const port = server.address().port;

  try {
    const response = await getJson(`http://127.0.0.1:${port}/api/state`);
    assert.equal(response.status, 200);
    assert.equal(response.body.latestAnalysis.contextPack.userRequest.text, "old visible request");
    assert.equal(loadState(root).latestAnalysis.contextPack.userRequest.text, "old visible request");
  } finally {
    service.close();
    await closeServer(server);
  }
});

test("repo-local checkpoint endpoint requires an explicit approval lease", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-checkpoint-guard-"));
  fs.writeFileSync(path.join(root, "README.md"), "repo local");
  initRepository(root);

  const { server, service } = startServer({
    repoPath: root,
    port: 0,
    scanInterval: 0,
    entry: "graph.html",
    label: "ScopeLease test app",
    lockRoot: true
  });
  await waitForListening(server);
  const port = server.address().port;

  try {
    const denied = await postJson(`http://127.0.0.1:${port}/api/checkpoint`, {});
    assert.equal(denied.status, 403);
    assert.equal(denied.body.ok, false);
    assert.equal(denied.body.guard.actionGrant, "checkpoint");
  } finally {
    service.close();
    await closeServer(server);
  }
});

test("measurement mode toggles automatic hook capture", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-measure-mode-"));
  fs.writeFileSync(path.join(root, "README.md"), "repo local");
  initRepository(root);

  const { server, service } = startServer({
    repoPath: root,
    port: 0,
    scanInterval: 0,
    entry: "graph.html",
    label: "ScopeLease test app",
    lockRoot: true
  });
  await waitForListening(server);
  const port = server.address().port;

  try {
    const disabled = await postJson(`http://127.0.0.1:${port}/api/measurement-mode`, { enabled: false });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.measurementMode.enabled, false);

    const skipped = await postJson(`http://127.0.0.1:${port}/api/measure`, {
      source: "codex-hook:user-prompt",
      lane: "default-codex",
      phase: "input",
      text: "default prompt while disabled"
    });
    assert.equal(skipped.status, 200);
    assert.equal(skipped.body.skipped, true);
    assert.equal((loadState(root).actualWorkEvents || []).length, 0);

    const enabled = await postJson(`http://127.0.0.1:${port}/api/measurement-mode`, { enabled: true });
    assert.equal(enabled.body.measurementMode.enabled, true);
    const captured = await postJson(`http://127.0.0.1:${port}/api/measure`, {
      source: "codex-hook:user-prompt",
      lane: "default-codex",
      phase: "input",
      request: "measure mode capture",
      pairId: "pair-measure-mode",
      runId: "codex:measure-mode",
      text: "default prompt while enabled"
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.body.event.lane, "default-codex");
    assert.equal(captured.body.event.pairId, "pair-measure-mode");
  } finally {
    service.close();
    await closeServer(server);
  }
});

test("measure-mode CLI toggles automatic metering state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-measure-mode-cli-"));
  fs.writeFileSync(path.join(root, "README.md"), "repo local");
  initRepository(root);
  const cli = path.resolve("src/cli.js");

  const off = JSON.parse(execFileSync(process.execPath, [cli, "measure-mode", root, "off"], { encoding: "utf8" }));
  assert.equal(off.measurementMode.enabled, false);

  const on = JSON.parse(execFileSync(process.execPath, [cli, "measure-mode", root, "on"], { encoding: "utf8" }));
  assert.equal(on.measurementMode.enabled, true);

  const status = JSON.parse(execFileSync(process.execPath, [cli, "measure-mode", root, "status"], { encoding: "utf8" }));
  assert.equal(status.measurementMode.enabled, true);
});

test("measure CLI only reads repository-local paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-measure-path-"));
  const outside = path.join(os.tmpdir(), `scopelease-outside-${Date.now()}.txt`);
  fs.writeFileSync(path.join(root, "README.md"), "repo local");
  fs.writeFileSync(outside, "outside secret");
  initRepository(root);
  const cli = path.resolve("src/cli.js");

  const local = JSON.parse(execFileSync(process.execPath, [
    cli,
    "measure",
    root,
    "--path",
    "README.md",
    "--lane",
    "default-codex"
  ], { encoding: "utf8" }));
  assert.equal(local.event.path, "README.md");

  const blocked = spawnSync(process.execPath, [
    cli,
    "measure",
    root,
    "--path",
    outside,
    "--lane",
    "default-codex"
  ], { encoding: "utf8" });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /must stay inside the repository/);
});

test("approve CLI requires the action-specific guard decision before issuing a lease", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-approve-cli-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "app.js"), "export function app() { return 1; }\n");
  initRepository(root);
  const cli = path.resolve("src/cli.js");
  const request = "src/app.js에 작은 수정 적용";

  assert.throws(
    () => execFileSync(process.execPath, [cli, "approve", root, "--request", request, "--choice", "allow_scoped_patch"], { encoding: "utf8", stdio: "pipe" }),
    /approve action JSON is required/
  );

  assert.throws(
    () => execFileSync(process.execPath, [
      cli,
      "approve",
      root,
      "--request",
      request,
      "--choice",
      "allow_scoped_patch",
      "--action-json",
      "{\"kind\":\"read\",\"path\":\"src/app.js\"}"
    ], { encoding: "utf8", stdio: "pipe" }),
    /No current guard decision requires approval/
  );

  const approved = JSON.parse(execFileSync(process.execPath, [
    cli,
    "approve",
    root,
    "--request",
    request,
    "--choice",
    "allow_scoped_patch",
    "--action-json",
    "{\"kind\":\"edit\",\"path\":\"src/app.js\"}"
  ], { encoding: "utf8" }));
  assert.equal(approved.kind, "scopelease.approval_lease");
  assert.equal(approved.previousVerdict.verdict, "ask_once");
  assert.ok(approved.lease.fileScopes.includes("src/app.js"));
});

test("approve CLI accepts MCP-style choice-id alias", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-approve-cli-choice-id-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "app.js"), "export function app() { return 1; }\n");
  initRepository(root);
  const cli = path.resolve("src/cli.js");
  const approved = JSON.parse(execFileSync(process.execPath, [
    cli,
    "approve",
    root,
    "--request",
    "src/app.js에 작은 수정 적용",
    "--choice-id",
    "allow_scoped_patch",
    "--action-json",
    "{\"kind\":\"edit\",\"path\":\"src/app.js\"}"
  ], { encoding: "utf8" }));

  assert.equal(approved.kind, "scopelease.approval_lease");
  assert.equal(approved.lease.choiceId, "allow_scoped_patch");
  assert.ok(approved.lease.allowedActions.includes("apply_patch"));
});

test("enforcement point blocks execution before an approval lease and reuses signed leases", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-enforce-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "app.js"), "export function app() { return 1; }\n");
  initRepository(root);
  const request = "src/app.js에 작은 수정 적용";
  const action = { kind: "edit", path: "src/app.js" };

  const blocked = enforceAgentAction(root, { action, request });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.exitCode, 3);
  assert.equal(blocked.verdict.verdict, "ask_once");
  assert.match(blocked.reason, /approval lease/);

  const approveCommand = [
    JSON.stringify(process.execPath),
    JSON.stringify(path.resolve("src/cli.js")),
    "approve",
    JSON.stringify(root),
    "--request",
    JSON.stringify(request),
    "--choice-id",
    "allow_scoped_patch",
    "--action-json",
    JSON.stringify(JSON.stringify(action))
  ].join(" ");
  const controlAllowed = enforceAgentAction(root, {
    action: { kind: "bash", command: approveCommand },
    request
  });
  assert.equal(controlAllowed.allowed, true);
  assert.equal(controlAllowed.verdict.verdict, "allow_with_log");
  assert.equal(controlAllowed.verdict.controlCommand.subcommand, "approve");
  assert.match(controlAllowed.verdict.reason, /approval deadlock/);

  const sourceZipAllowed = enforceAgentAction(root, {
    action: { kind: "bash", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve("src/cli.js"))} source-zip ${JSON.stringify(root)} --output scopelease_clean_source.zip --format json` },
    request: "source zip 생성"
  });
  assert.equal(sourceZipAllowed.allowed, true);
  assert.equal(sourceZipAllowed.verdict.controlCommand.subcommand, "source-zip");

  const freezeEvidenceAllowed = enforceAgentAction(root, {
    action: { kind: "bash", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve("src/cli.js"))} freeze-evidence ${JSON.stringify(root)} --format json` },
    request: "fresh report를 frozen evidence로 반영"
  });
  assert.equal(freezeEvidenceAllowed.allowed, true);
  assert.equal(freezeEvidenceAllowed.verdict.controlCommand.subcommand, "freeze-evidence");

  const verifyFrozenAllowed = enforceAgentAction(root, {
    action: { kind: "bash", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve("src/cli.js"))} verify-frozen ${JSON.stringify(root)} --format json` },
    request: "frozen evidence 검증"
  });
  assert.equal(verifyFrozenAllowed.allowed, true);
  assert.equal(verifyFrozenAllowed.verdict.controlCommand.subcommand, "verify-frozen");

  const analysis = analyzeRepository(root, { userRequest: request });
  const state = loadState(root);
  const guardVerdict = evaluateAgentAction({ action, analysis, state });
  const lease = approveDecisionBundle({
    analysis,
    state,
    decisionBundle: guardVerdict.decisionBundle,
    choiceId: "allow_scoped_patch"
  });
  saveState(root, { ...loadState(root), approvalLeases: [lease] });

  const allowed = enforceAgentAction(root, { action, request });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.exitCode, 0);
  assert.equal(allowed.verdict.verdict, "allow_with_log");
  assert.equal(allowed.verdict.leaseId, lease.id);
  assert.equal(allowed.graphScopeHash, lease.graphScopeHash);
  assert.equal(allowed.permissionFrontierHash, lease.permissionFrontierHash);

  const denied = enforceAgentAction(root, {
    action: { kind: "bash", command: "rm -rf ." },
    request
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.exitCode, 2);
  assert.equal(denied.verdict.verdict, "deny");
  assert.ok((loadState(root).guardEvents || []).some((event) => event.source === "cli:enforce"));
});

test("source archive uses a bounded source list and repo-local zip output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-source-archive-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, ".scopelease"), { recursive: true });
  const userName = path.basename(os.homedir());
  fs.writeFileSync(path.join(root, "README.md"), `local root ${root}\nlocal home /Users/example/scopelease_paper\nplaceholder <user-home>/Desktop/lab/scopelease\nworkIntent users/${userName}/desktop/scopelease_paper\n`);
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  fs.writeFileSync(path.join(root, "src", "app.js"), "export const app = 1;\n");
  fs.writeFileSync(path.join(root, ".scopelease", "private.json"), "{}\n");

  assert.deepEqual(sourceArchiveEntries(root), ["README.md", "package.json", "src"]);
  assert.equal(resolveSourceArchiveOutput(root, "scopelease_clean_source.zip"), path.join(root, "scopelease_clean_source.zip"));
  assert.throws(
    () => resolveSourceArchiveOutput(root, ".scopelease/scopelease_clean_source.zip"),
    /excluded local directory/
  );
  assert.throws(
    () => resolveSourceArchiveOutput(root, "../scopelease_clean_source.zip"),
    /inside the repository/
  );
  assert.throws(
    () => resolveSourceArchiveOutput(root, "scopelease_clean_source.tar"),
    /must end with \.zip/
  );

  const sourceDir = path.join(root, ".scopelease", "reports", "delegation-control-source-of-truth-20260528");
  const targetDir = path.join(root, "examples", "evaluation", "frozen-evidence", "delegation-control-source-of-truth-20260528");
  const oldPermissionRun = path.join(root, ".scopelease", "fixtures", "runs", "permission-20260101T000000Z");
  const latestPermissionRun = path.join(root, ".scopelease", "fixtures", "runs", "permission-20260102T000000Z");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(oldPermissionRun, { recursive: true });
  fs.mkdirSync(latestPermissionRun, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "delegation-control-report.json"), "{\"fresh\":true}\n");
  fs.writeFileSync(path.join(sourceDir, "delegation-control-report.md"), "# fresh report\n");
  fs.writeFileSync(path.join(sourceDir, "evidence-manifest.json"), "{\"manifest\":true}\n");
  fs.mkdirSync(path.join(root, ".scopelease", "experiments", "formal-local-main-codex-resource-bounded"), { recursive: true });
  fs.mkdirSync(path.join(root, ".scopelease", "reports", "formal-local-main-codex-resource-bounded"), { recursive: true });
  fs.writeFileSync(path.join(root, ".scopelease", "experiments", "formal-local-main-codex-resource-bounded", "product-wide-summary.json"), "{\"formal\":true}\n");
  fs.writeFileSync(path.join(root, ".scopelease", "reports", "formal-local-main-codex-resource-bounded", "claim-ready-report.json"), "{\"report\":true}\n");
  fs.writeFileSync(path.join(root, ".scopelease", "reports", "formal-local-main-codex-resource-bounded", "claim-ready-report.md"), "# formal report\n");
  fs.mkdirSync(path.join(root, ".scopelease", "experiments", "pilot-codex-main-20260603"), { recursive: true });
  fs.writeFileSync(path.join(root, ".scopelease", "experiments", "pilot-codex-main-20260603", "product-wide-summary.json"), "{\"pilot\":true}\n");
  fs.writeFileSync(path.join(root, ".scopelease", "experiments", "pilot-codex-main-20260603", "claim-report.stdout.json"), "{\"status\":\"claim_ready\"}\n");
  fs.writeFileSync(path.join(root, ".scopelease", "fixtures", "permission-fixtures.jsonl"), "{}\n");
  fs.writeFileSync(path.join(oldPermissionRun, "summary.json"), "{\"old\":true}\n");
  fs.writeFileSync(path.join(latestPermissionRun, "summary.json"), "{\"latest\":true}\n");

  const evidenceEntries = sourceArchiveEntries(root);
  assert.ok(evidenceEntries.includes(".scopelease/reports/delegation-control-source-of-truth-20260528"));
  assert.ok(evidenceEntries.includes(".scopelease/experiments/formal-local-main-codex-resource-bounded/product-wide-summary.json"));
  assert.ok(evidenceEntries.includes(".scopelease/reports/formal-local-main-codex-resource-bounded/claim-ready-report.json"));
  assert.ok(evidenceEntries.includes(".scopelease/reports/formal-local-main-codex-resource-bounded/claim-ready-report.md"));
  assert.ok(evidenceEntries.includes(".scopelease/fixtures/permission-fixtures.jsonl"));
  assert.ok(evidenceEntries.includes(".scopelease/fixtures/runs/permission-20260102T000000Z"));
  assert.equal(evidenceEntries.includes(".scopelease/fixtures/runs/permission-20260101T000000Z"), false);
  assert.equal(evidenceEntries.includes(".scopelease/private.json"), false);

  const archive = createSourceArchive(root);
  assert.equal(archive.kind, "scopelease.source_archive");
  assert.equal(archive.sanitizedLocalPaths, true);
  assert.ok(archive.sanitizedFiles >= 1);
  const archiveEntries = readSourceArchiveEntries(archive.output);
  const archivedReadme = archiveEntries.find((entry) => entry.name === "README.md")?.content.toString("utf8");
  assert.equal(archivedReadme.includes(root), false);
  assert.equal(/\/Users\//.test(archivedReadme), false);
  assert.equal(/<user-home>\/Desktop\//.test(archivedReadme), false);
  assert.equal(new RegExp(`users/${userName}`, "i").test(archivedReadme), false);
  const staleArchiveAssertion = [
    "assert.equal(containsUnsanitizedLocalPath(",
    '"<project-root>"',
    ", { root }), true);"
  ].join("");
  assert.equal(containsStaleSourceArchiveAssertion(staleArchiveAssertion), true);
  const oaiHome = "/" + ["home", "oai"].join("/");
  const placeholderDesktopPath = ["<user-home>", "Desktop", "lab", "scopelease"].join("/");
  assert.equal(containsUnsanitizedLocalPath(placeholderDesktopPath, { root, home: oaiHome }), true);
  assert.equal(containsUnsanitizedLocalPath("<user-home>", { root, home: oaiHome }), false);
  assert.equal(containsUnsanitizedLocalPath("package integrity sha512-oaihash", { root, home: oaiHome }), false);
  const oaiProjectPath = "/" + ["home", "oai", "project", "scopelease"].join("/");
  assert.equal(containsUnsanitizedLocalPath(oaiProjectPath, { root, home: oaiHome }), true);
  const usersPath = ["users", "oai", "project", "scopelease"].join("/");
  assert.equal(containsUnsanitizedLocalPath(usersPath, { root, home: oaiHome }), true);
  const samHome = "/" + ["home", "sam"].join("/");
  assert.equal(containsUnsanitizedLocalPath("sam appears as a normal dependency token", { root, home: samHome }), false);
  assert.equal(containsUnsanitizedLocalPath(archivedReadme, { root }), false);
  assert.match(archivedReadme, /<project-root>/);
  assert.match(archivedReadme, /<user-home>/);
  const archivedEntryNames = archiveEntries.map((entry) => entry.name).join("\n");
  assert.match(archivedEntryNames, /\.scopelease\/experiments\/pilot-codex-main-20260603\/product-wide-summary\.json/);
  assert.doesNotMatch(archivedEntryNames, /claim-report\.stdout\.json/);

  const archiveCheck = verifySourceArchive(root, { archivePath: "scopelease_clean_source.zip" });
  assert.equal(archiveCheck.kind, "scopelease.source_archive_verify");
  assert.equal(archiveCheck.ok, true);
  assert.equal(archiveCheck.staleAssertions.length, 0);
  assert.equal(archiveCheck.leaks.length, 0);

  const frozen = JSON.parse(execFileSync(process.execPath, [
    path.resolve("src/cli.js"),
    "freeze-evidence",
    root,
    "--format",
    "json"
  ], { encoding: "utf8" }));
  assert.equal(frozen.kind, "scopelease.frozen_evidence_update");
  assert.equal(frozen.copied.length, 3);
  assert.equal(fs.readFileSync(path.join(targetDir, "delegation-control-report.md"), "utf8"), "# fresh report\n");
});

test("formal repo discovery excludes virtualenv dependencies and resource-bound repos", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-formal-discovery-"));
  const smallRepo = path.join(root, "small-app");
  const largeRepo = path.join(root, "large-app");
  const duplicateRepoA = path.join(root, "team-a", "app");
  const duplicateRepoB = path.join(root, "team-b", "app");
  const dependencyRepo = path.join(root, "analysis", ".venv_migration_test", "lib", "python3.12", "site-packages", "pandas");
  fs.mkdirSync(smallRepo, { recursive: true });
  fs.mkdirSync(largeRepo, { recursive: true });
  fs.mkdirSync(duplicateRepoA, { recursive: true });
  fs.mkdirSync(duplicateRepoB, { recursive: true });
  fs.mkdirSync(dependencyRepo, { recursive: true });
  fs.writeFileSync(path.join(smallRepo, "package.json"), "{}\n");
  fs.writeFileSync(path.join(largeRepo, "package.json"), "{}\n");
  fs.writeFileSync(path.join(duplicateRepoA, "package.json"), "{}\n");
  fs.writeFileSync(path.join(duplicateRepoB, "package.json"), "{}\n");
  fs.writeFileSync(path.join(dependencyRepo, "pyproject.toml"), "[project]\nname='pandas'\n");
  for (let index = 0; index < 5; index += 1) {
    fs.writeFileSync(path.join(largeRepo, `file-${index}.js`), "export {};\n");
  }

  const output = execFileSync(process.execPath, [
    path.resolve("scripts/discover-formal-repos.mjs"),
    "--root",
    root,
    "--max-depth",
    "8",
    "--min-repos",
    "1",
    "--max-shallow-files",
    "3",
    "--format",
    "json"
  ], { encoding: "utf8" });
  const result = JSON.parse(output);
  const byLabel = new Map(result.repos.map((repo) => [repo.label, repo]));
  assert.equal(result.maxShallowFiles, 3);
  assert.equal(byLabel.has("pandas"), false);
  assert.equal(byLabel.get("small-app")?.include, true);
  assert.equal(byLabel.get("large-app")?.include, false);
  assert.equal(byLabel.get("large-app")?.excludeReason, "over_resource_bound");
  assert.equal(byLabel.get("app")?.include, true);
  assert.equal(byLabel.get("app-2")?.include, true);
});

test("verify-frozen checks headline evidence metrics and path hygiene", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-verify-frozen-"));
  const targetDir = path.join(root, "examples", "evaluation", "frozen-evidence", "delegation-control-source-of-truth-20260528");
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "delegation-control-report.json"), JSON.stringify({
    status: "controlled_delegation_evidence_ready_live_completion_and_human_needed",
    tokenSavings: {
      commandReportedTotalTokens: {
        savedPercent: 64,
        defaultTokens: 3560061,
        scopeleaseTokens: 1280323
      },
      reviewFrontierFileReadProxy: {
        savedPercent: 61
      }
    },
    axes: {
      B_contextAndCallReduction: {
        reviewFrontierProxy: {
          toolCallProxyReductionPercent: 69,
          baselineFiles: 1771,
          frontierFiles: 552
        }
      },
      C_permissionDelegation: {
        passed: 12,
        total: 12
      },
      D_reviewBoundaryQuality: {
        passedTasks: 23,
        criticalFileRecallPercent: 100,
        criticalFileRankMetrics: {
          criticalFileRecallAtKPercent: {
            top10: 93
          }
        }
      }
    },
    controlledAblation: {
      rowCount: 92,
      summary: {
        byCondition: {
          C3: {
            silentFailureCount: 0
          }
        }
      }
    }
  }, null, 2));
  fs.writeFileSync(path.join(targetDir, "delegation-control-report.md"), "# frozen\n");
  fs.writeFileSync(path.join(targetDir, "evidence-manifest.json"), "{\"manifest\":true}\n");

  const result = JSON.parse(execFileSync(process.execPath, [
    path.resolve("src/cli.js"),
    "verify-frozen",
    root,
    "--format",
    "json"
  ], { encoding: "utf8" }));
  assert.equal(result.kind, "scopelease.frozen_evidence_verify");
  assert.equal(result.ok, true);
  assert.ok(result.rows.some((row) => row.name === "status" && row.match));
  assert.ok(result.rows.some((row) => row.name === "review baseline files" && row.source === 1771));
  assert.ok(result.rows.some((row) => row.name === "frozen report local paths" && row.match));
});

test("guarded-exec and PreToolUse hook parsing enforce before shell/write execution", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-guarded-exec-"));
  fs.writeFileSync(path.join(root, "sample.test.js"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ok', () => assert.equal(1, 1));\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    scripts: {
      lint: "node -e \"console.log('lint-ok')\""
    }
  }, null, 2));
  initRepository(root);

  const safe = runGuardedCommand(root, {
    command: "npm run lint",
    request: "테스트 실행",
    stdio: "pipe"
  });
  assert.equal(safe.allowed, true);
  assert.equal(safe.command.status, 0);
  assert.match(`${safe.command.stdout}\n${safe.command.stderr}`, /lint-ok/);

  const compound = runGuardedCommand(root, {
    command: "npm run lint && echo should-not-run",
    request: "테스트 실행",
    stdio: "pipe"
  });
  assert.equal(compound.allowed, false);
  assert.equal(compound.command.status, "blocked");
  assert.equal(compound.exitCode, 3);

  const cli = path.resolve("src/cli.js");
  const cliSafe = JSON.parse(execFileSync(process.execPath, [
    cli,
    "guarded-exec",
    root,
    "--request",
    "테스트 실행",
    "--command",
    "npm run lint",
    "--format",
    "json"
  ], { encoding: "utf8" }));
  assert.equal(cliSafe.allowed, true);
  assert.match(`${cliSafe.command.stdout}\n${cliSafe.command.stderr}`, /lint-ok/);

  const missingCommand = spawnSync(process.execPath, [
    cli,
    "guarded-exec",
    root,
    "--command"
  ], { encoding: "utf8" });
  assert.notEqual(missingCommand.status, 0);
  assert.match(missingCommand.stderr, /--command requires a command string/);

  const hookAction = actionFromHookEvent({
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_input: {
      patch: [
        "*** Begin Patch",
        "*** Update File: src/app.js",
        "@@",
        "-old",
        "+new",
        "*** End Patch"
      ].join("\n")
    }
  });
  assert.equal(hookAction.kind, "edit");
  assert.deepEqual(hookAction.paths, ["src/app.js"]);

  const safeReadHookVerdict = enforceAgentAction(root, {
    hookEvent: {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command: "pwd"
      }
    },
    request: "현재 작업 디렉터리 확인"
  });
  assert.equal(safeReadHookVerdict.allowed, true);
  assert.equal(safeReadHookVerdict.verdict.verdict, "allow_with_log");
  assert.equal(safeReadHookVerdict.actionGrant, "read");

  const freeformPatchHookAction = actionFromHookEvent({
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_input: [
      "*** Begin Patch",
      "*** Update File: src/freeform.js",
      "@@",
      "-old",
      "+new",
      "*** End Patch"
    ].join("\n")
  });
  assert.equal(freeformPatchHookAction.kind, "edit");
  assert.deepEqual(freeformPatchHookAction.paths, ["src/freeform.js"]);

  const commandPatchHookAction = actionFromHookEvent({
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_input: {
      cmd: [
        "*** Begin Patch",
        "*** Update File: src/command-form.js",
        "@@",
        "-old",
        "+new",
        "*** End Patch"
      ].join("\n")
    }
  });
  assert.equal(commandPatchHookAction.kind, "edit");
  assert.deepEqual(commandPatchHookAction.paths, ["src/command-form.js"]);

  const outsideHookEvent = {
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: {
      file_path: "/tmp/outside.txt"
    }
  };
  const outsideHookAction = actionFromHookEvent(outsideHookEvent);
  assert.equal(outsideHookAction.kind, "edit");
  assert.deepEqual(outsideHookAction.paths, ["/tmp/outside.txt"]);

  const outsideHookVerdict = enforceAgentAction(root, {
    hookEvent: outsideHookEvent,
    request: "외부 파일 쓰기"
  });
  assert.equal(outsideHookVerdict.allowed, false);
  assert.equal(outsideHookVerdict.exitCode, 2);
  assert.equal(outsideHookVerdict.verdict.verdict, "deny");
  assert.match(outsideHookVerdict.verdict.reason, /outside repo-relative scope/);

  const missingPathHookVerdict = enforceAgentAction(root, {
    hookEvent: {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: {
        content: "no target path"
      }
    },
    request: "경로 없는 파일 쓰기"
  });
  assert.equal(missingPathHookVerdict.allowed, false);
  assert.equal(missingPathHookVerdict.exitCode, 2);
  assert.equal(missingPathHookVerdict.verdict.verdict, "deny");
  assert.match(missingPathHookVerdict.verdict.reason, /missing a repo-relative path/);
});

test("enforce CLI returns blocking status for pre-execution policy failures", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-enforce-cli-"));
  fs.writeFileSync(path.join(root, "README.md"), "repo local\n");
  initRepository(root);
  const cli = path.resolve("src/cli.js");

  assert.throws(
    () => execFileSync(process.execPath, [
      cli,
      "enforce",
      root,
      "--action-json",
      "{\"kind\":\"bash\",\"command\":\"rm -rf .\"}",
      "--format",
      "json"
    ], { encoding: "utf8", stdio: "pipe" }),
    (error) => {
      assert.equal(error.status, 2);
      assert.match(error.stdout, /"allowed": false/);
      assert.match(error.stdout, /"verdict": "deny"/);
      return true;
    }
  );
});

test("graph layout metrics endpoint records lane density and overlap evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-layout-metrics-"));
  fs.writeFileSync(path.join(root, "README.md"), "repo local");
  initRepository(root);

  const { server, service } = startServer({
    repoPath: root,
    port: 0,
    scanInterval: 0,
    entry: "graph.html",
    label: "ScopeLease test app",
    lockRoot: true
  });
  await waitForListening(server);
  const port = server.address().port;

  try {
    const measured = await postJson(`http://127.0.0.1:${port}/api/graph-layout-metrics`, {
      source: "graph-view-test",
      layout: "lanes",
      scope: "decision",
      eventReason: "state",
      userRequest: "measure lane layout",
      nodeCount: 4,
      edgeCount: 2,
      summary: {
        laneCount: 2,
        totalOverlapCount: 1,
        maxDensity: 0.44,
        denseLaneCount: 1,
        overlapLaneCount: 1
      },
      lanes: [
        { key: "depth:1", label: "depth 1", index: 0, count: 2, rows: 2, columns: 1, width: 120, height: 180, density: 0.18, overlapCount: 0, minGap: 12, maxRadius: 24, status: "ok" },
        { key: "depth:2", label: "depth 2", index: 1, count: 2, rows: 1, columns: 2, width: 160, height: 90, density: 0.44, overlapCount: 1, minGap: -4, maxRadius: 24, status: "overlap" }
      ]
    });
    assert.equal(measured.status, 200);
    assert.equal(measured.body.ok, true);
    assert.equal(measured.body.event.kind, "scopelease.graph_layout_metric_event");
    assert.equal(measured.body.event.summary.totalOverlapCount, 1);
    assert.equal(measured.body.event.lanes[1].status, "overlap");

    const state = loadState(root);
    assert.equal(state.graphLayoutMetricEvents[0].source, "graph-view-test");
    assert.equal(state.graphLayoutMetricEvents[0].laneCount, 2);
  } finally {
    service.close();
    await closeServer(server);
  }
});

test("measure endpoint accepts hook-sized observed payloads", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-measure-large-"));
  fs.writeFileSync(path.join(root, "README.md"), "repo local");
  initRepository(root);

  const { server, service } = startServer({
    repoPath: root,
    port: 0,
    scanInterval: 0,
    entry: "graph.html",
    label: "ScopeLease test app",
    lockRoot: true
  });
  await waitForListening(server);
  const port = server.address().port;

  try {
    const text = "large hook payload ".repeat(5000);
    const measured = await postJson(`http://127.0.0.1:${port}/api/measure`, {
      phase: "explore",
      text,
      source: "codex-hook:Bash",
      lane: "scopelease-codex",
      label: "large hook payload",
      request: "large measure request",
      workIntent: "large measure request",
      pairId: "large-pair",
      runId: "large-run"
    });
    assert.equal(measured.status, 200);
    assert.equal(measured.body.ok, true);
    assert.ok(measured.body.event.tokens > 0);
    assert.equal(measured.body.event.lane, "scopelease-codex");
    assert.equal(measured.body.event.pairId, "large-pair");
  } finally {
    service.close();
    await closeServer(server);
  }
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (error) {
          reject(error);
        }
      });
    }).on("error", reject);
  });
}

function postJson(url, value = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(value);
    const req = http.request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload)
      }
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

function waitForListening(server) {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", resolve);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sqlite3Missing() {
  try {
    execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
    return false;
  } catch {
    return "sqlite3 is not available";
  }
}

function sqlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function findRawProjectPortPath(port) {
  const prefix = path.join(os.tmpdir(), "scopelease-raw-port-");
  for (let index = 0; index < 200000; index += 1) {
    const candidate = `${prefix}${index}`;
    if (rawProjectPort(candidate) === port) return candidate;
  }
  throw new Error(`Could not find candidate for raw project port ${port}`);
}

function rawProjectPort(value) {
  const hash = createHash("sha1").update(path.resolve(value)).digest();
  return 3928 + (hash.readUInt32BE(0) % 20000);
}
