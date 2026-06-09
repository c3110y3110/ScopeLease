import fs from "node:fs";
import path from "node:path";
import { buildAgentInputPayload } from "./artifacts.js";
import { approveDecisionBundle, evaluateAgentAction } from "./guard.js";
import {
  analyzeRepository,
  loadState,
  recordDecisionFatigueEvent,
  recordGuardDecision,
  saveState
} from "./repository.js";

const DEFAULT_PRODUCT_WIDE_MIN_REPOS = 3;
const DEFAULT_PRODUCT_WIDE_MIN_PAIRS = 10;
// Formal CHI/product-wide floor, independent of any caller-supplied min thresholds.
// `status: claim_ready` is relative to the caller's minRepos/minPairs; this floor
// makes it explicit whether a run also clears the formal product-wide bar so that a
// small pilot is never mistaken for a formal product-wide savings claim.
const FORMAL_PRODUCT_WIDE_FLOOR = { minRepos: 10, minPairs: 100 };

export function buildEvidenceSummary(repoPath, options = {}) {
  const root = path.resolve(repoPath || ".");
  const state = loadState(root) || {};
  const analysis = state.latestAnalysis || analyzeRepository(root, { userRequest: options.request || "" });
  const pairRuns = loadPairRunSummaries(root);
  const latestPairRun = pairRuns[0] || null;
  const latestObservedPair = summarizeLatestObservedPair(state);
  const metrics = effectiveFatigueMetrics(state);
  const mcpContextTokens = sumTokens(state.mcpContextEvents || []);
  const actualWorkEvents = Array.isArray(state.actualWorkEvents) ? state.actualWorkEvents : [];
  const agentVisibleActualWorkEvents = actualWorkEvents.filter((event) => actualWorkLane(event) !== "scopelease-internal");
  const internalEvidenceEvents = actualWorkEvents.filter((event) => actualWorkLane(event) === "scopelease-internal");
  const toolCallSummary = summarizeToolCallEvents(agentVisibleActualWorkEvents);
  const preToolEnforcementEvents = (state.guardEvents || []).filter(isPreToolEnforcementEvent);
  const frontiers = analysis.contextPack?.agentContext?.frontiers || analysis.contextPack?.codexInput?.promptContext?.frontiers || {};
  const actualWorkTokens = sumTokens(agentVisibleActualWorkEvents);
  const internalEvidenceTokens = sumTokens(internalEvidenceEvents);
  const modelUsageTokens = sumTokens(state.modelUsageEvents || [], "totalTokens");
  const decisionPromptOpportunities = Number(metrics.humanPromptsShown || 0) + Number(metrics.repeatedQuestionsSuppressed || 0);
  const decisionPromptSuppressionPercent = decisionPromptOpportunities > 0
    ? Math.round((Number(metrics.repeatedQuestionsSuppressed || 0) / decisionPromptOpportunities) * 100)
    : null;
  const latestPairSummary = latestPairRun?.summary || {};
  const latestPairDeltaTokens = finiteNumberOrNull(latestPairSummary.savedTokens);
  const latestPairDeltaPercent = finiteNumberOrNull(latestPairSummary.savedPercent);
  const latestPairPositiveSavingsTokens = positiveNumberOrNull(latestPairDeltaTokens);
  const latestPairPositiveSavingsPercent = positiveNumberOrNull(latestPairDeltaPercent);
  const latestPairDeltaDirection = deltaDirection(latestPairDeltaTokens);
  const latestPairBaselineModes = formatModes(latestPairRun?.baselineModes);
  const latestPairDefaultInputModes = formatModes(latestPairRun?.defaultInputModes);
  const latestPairScopeLeaseModes = formatModes(latestPairRun?.scopeleaseModes);
  const rows = [
    metricRow("scopelease_input_tokens", analysis.contextPack?.tokenEconomy?.actualInputTokens || 0, ".decision/context-pack.json", "ScopeLease가 agent-visible 입력 후보에 넣은 토큰"),
    metricRow("repo_scope_tokens", analysis.contextPack?.tokenEconomy?.fullRepoTokens || 0, ".decision/state.json", "전체 저장소 후보 토큰. 절감률 분모로 쓰지 않음"),
    metricRow("mcp_context_events", (state.mcpContextEvents || []).length, ".decision/state.json", "scopelease_get_context가 실제 제공한 context event 수"),
    metricRow("mcp_context_tokens", mcpContextTokens, ".decision/state.json", "MCP로 전달된 scopelease-codex lane context 토큰"),
    metricRow("actual_work_events", agentVisibleActualWorkEvents.length, ".decision/state.json", "hook/measure/pair-run이 관측한 agent-visible payload 수"),
    metricRow("actual_work_tokens", actualWorkTokens, ".decision/state.json", "관측된 agent-visible 작업 payload 토큰"),
    metricRow("tool_call_events", toolCallSummary.totalCalls, ".decision/state.json", "PostToolUse/measure에서 관측한 agent-visible tool call 수"),
    metricRow("tool_call_tokens", toolCallSummary.totalTokens, ".decision/state.json", "관측된 tool call payload 토큰. provider billing이나 hidden reasoning은 아님"),
    metricRow("tool_call_breakdown", toolCallSummary.breakdownLabel, ".decision/state.json", "도구별 call count"),
    metricRow("pre_tool_enforcement_events", preToolEnforcementEvents.length, ".decision/state.json", "PreToolUse/guarded-exec가 실행 전에 guard를 호출한 횟수"),
    metricRow("review_frontier_nodes", frontiers.reviewFrontier?.size ?? frontiers.reviewFrontier?.nodes?.length ?? null, ".decision/context-pack.json", "사람이 전체 diff 대신 확인할 graph-derived review frontier 크기"),
    metricRow("permission_frontier_nodes", frontiers.permissionFrontier?.size ?? frontiers.permissionFrontier?.nodes?.length ?? null, ".decision/context-pack.json", "approval lease로 위임 가능한 graph/action frontier 크기"),
    metricRow("stop_frontier_nodes", frontiers.stopFrontier?.size ?? frontiers.stopFrontier?.nodes?.length ?? null, ".decision/context-pack.json", "범위 이탈 시 ask/deny를 유발하는 stop frontier 크기"),
    metricRow("graph_scope_hash", frontiers.graphScope?.hash || null, ".decision/context-pack.json", "context/review/permission/stop frontier가 공유하는 graph scope hash"),
    metricRow("internal_evidence_events", internalEvidenceEvents.length, ".decision/state.json", "ScopeLease 내부 watch/근거 payload 수. 절감률 분자/분모에서 제외"),
    metricRow("internal_evidence_tokens", internalEvidenceTokens, ".decision/state.json", "ScopeLease 내부 watch/근거 payload 토큰. agent-visible 절감률에서 제외"),
    metricRow("provider_usage_events", (state.modelUsageEvents || []).length, ".decision/state.json", "명시적으로 수집된 provider usage. 기본 절감률에서는 제외"),
    metricRow("provider_usage_tokens", modelUsageTokens, ".decision/state.json", "provider가 반환한 usage token 총합"),
    metricRow("guard_events", (state.guardEvents || []).length, ".decision/state.json", "권한 gate 판정 이벤트"),
    metricRow("approval_leases", (state.approvalLeases || []).length, ".decision/state.json", "재사용 가능한 승인 lease 수"),
    metricRow("fatigue_events", (state.fatigueEvents || []).length, ".decision/state.json", "human prompt, lease hit/miss, deny 등 결정 피로 이벤트"),
    metricRow("human_prompts_shown", metrics.humanPromptsShown || 0, ".decision/state.json", "사용자에게 추가 결정을 요청한 횟수"),
    metricRow("human_decisions_recorded", metrics.humanDecisionsRecorded || 0, ".decision/state.json", "승인 lease 생성 등 사람이 실제 결정을 내린 횟수"),
    metricRow("approval_lease_hits", metrics.approvalLeaseHits || 0, ".decision/state.json", "기존 승인 lease로 반복 질문을 생략한 횟수"),
    metricRow("repeated_questions_suppressed", metrics.repeatedQuestionsSuppressed || 0, ".decision/state.json", "반복 질문 감소량 관측 카운터"),
    metricRow("decision_prompt_opportunities", decisionPromptOpportunities, ".decision/state.json", "보인 결정 질문 + lease hit로 생략된 반복 질문"),
    metricRow("decision_prompt_suppression_percent", decisionPromptSuppressionPercent, ".decision/state.json", "반복 질문 생략 비율. human fatigue 자체가 아니라 관측된 prompt suppression 지표"),
    metricRow("latest_observed_pair_status", latestObservedPair.status, ".decision/state.json", "실제 관측 pair 상태. controlled pair-run synthetic event는 제외하고, sourceBoundary로 prompt-observed와 hook/MCP를 구분"),
    metricRow("latest_observed_pair_default_tokens", latestObservedPair.defaultTokens || null, ".decision/state.json", "같은 workIntent에서 ScopeLease 없이 실제 관측된 default-codex 입력 n"),
    metricRow("latest_observed_pair_scopelease_tokens", latestObservedPair.scopeleaseTokens || null, ".decision/state.json", "같은 workIntent에서 ScopeLease MCP context와 ScopeLease-lane payload로 관측된 입력 m"),
    metricRow("latest_observed_pair_delta_tokens", latestObservedPair.savedTokens, ".decision/state.json", "실제 관측 pair의 signed n-m token delta. 양수일 때만 절감"),
    metricRow("latest_observed_pair_delta_percent", latestObservedPair.savedPercent, ".decision/state.json", "실제 관측 pair의 signed delta percent. 양수일 때만 절감"),
    metricRow("latest_observed_pair_delta_direction", latestObservedPair.deltaDirection, ".decision/state.json", "실제 관측 pair delta 방향: savings, overhead, flat, unmeasured"),
    metricRow("latest_observed_pair_can_claim_savings", latestObservedPair.canClaimSavings, ".decision/state.json", "실제 동일 단위 pair에서 n > m일 때만 true"),
    metricRow("latest_observed_pair_claim_scope", latestObservedPair.claimScope, ".decision/state.json", "live Codex/Claude-style 일반 주장에는 이 observed pair scope만 사용"),
    metricRow("latest_observed_pair_default_tool_calls", latestObservedPair.callBreakdown?.defaultToolCalls ?? null, ".decision/state.json", "같은 workIntent default lane에서 관측된 tool call 수"),
    metricRow("latest_observed_pair_scopelease_tool_calls", latestObservedPair.callBreakdown?.scopeleaseToolCalls ?? null, ".decision/state.json", "같은 workIntent ScopeLease lane에서 관측된 tool call 수"),
    metricRow("latest_observed_pair_tool_call_delta", latestObservedPair.callBreakdown?.savedToolCalls ?? null, ".decision/state.json", "default-scopelease tool call 차이. 양수이면 호출 감소"),
    metricRow("latest_observed_pair_tool_call_delta_percent", latestObservedPair.callBreakdown?.savedToolCallPercent ?? null, ".decision/state.json", "같은 workIntent에서 관측된 tool call 감소율"),
    metricRow("pair_run_count", pairRuns.length, ".scopelease/experiments/*/summary.json", "논문용 paired lane 실행 결과 수"),
    metricRow("latest_pair_protocol_kind", latestPairRun?.observationKind || null, latestPairRun?.summaryPath || ".scopelease/experiments", "최근 pair-run 종류. controlled prompt protocol이며 live Codex 기본 동작 관측값이 아님"),
    metricRow("latest_pair_delta_tokens", latestPairDeltaTokens, latestPairRun?.summaryPath || ".scopelease/experiments", "최근 pair-run protocol의 signed default-scopelease agent-visible 입력 token delta. 양수면 protocol상 절감, 음수면 overhead"),
    metricRow("latest_pair_delta_percent", latestPairDeltaPercent, latestPairRun?.summaryPath || ".scopelease/experiments", "최근 pair-run protocol의 signed default/scopelease agent-visible 입력 delta percent. live agent 일반 평균이 아님"),
    metricRow("latest_pair_delta_direction", latestPairDeltaDirection, latestPairRun?.summaryPath || ".scopelease/experiments", "최근 pair-run delta 방향: savings, overhead, flat, unmeasured"),
    metricRow("latest_pair_positive_savings_tokens", latestPairPositiveSavingsTokens, latestPairRun?.summaryPath || ".scopelease/experiments", "최근 controlled protocol pair-run 하나가 양수 delta일 때만 기록하는 token savings. 실제 Codex baseline 일반 평균 주장이 아님"),
    metricRow("latest_pair_positive_savings_percent", latestPairPositiveSavingsPercent, latestPairRun?.summaryPath || ".scopelease/experiments", "최근 controlled protocol pair-run 하나가 양수 delta일 때만 기록하는 savings percent. 실제 Codex baseline 일반 평균 주장이 아님"),
    metricRow("latest_pair_saved_percent", latestPairPositiveSavingsPercent, latestPairRun?.summaryPath || ".scopelease/experiments", "legacy key: positive-only savings percent. flat/overhead/unmeasured면 null"),
    metricRow("latest_pair_baseline_modes", latestPairBaselineModes, latestPairRun?.summaryPath || ".scopelease/experiments", "최근 pair-run에 포함된 baseline protocol. 수치 해석 시 함께 보고해야 함"),
    metricRow("latest_pair_default_input_modes", latestPairDefaultInputModes, latestPairRun?.summaryPath || ".scopelease/experiments", "최근 pair-run의 default lane prompt 입력 방식. natural_request이면 default_tokens는 전체 파일 프롬프트가 아님"),
    metricRow("latest_pair_scopelease_modes", latestPairScopeLeaseModes, latestPairRun?.summaryPath || ".scopelease/experiments", "최근 pair-run에 포함된 ScopeLease context mode"),
    metricRow("latest_pair_claim_scope", latestPairRun?.claimScope || null, latestPairRun?.summaryPath || ".scopelease/experiments", "latest pair-run 수치는 protocol 근거이며, 실제 관측 평균은 latest_observed_pair_*의 sourceBoundary와 함께 해석"),
    metricRow("latest_pair_decision_prompt_reduction_percent", latestPairRun?.summary?.decisionPromptReductionPercent ?? null, latestPairRun?.summaryPath || ".scopelease/experiments", "최근 pair-run의 proxy decision prompt 감소율")
  ];

  return {
    kind: "scopelease.evidence_summary",
    repo: root,
    generatedAt: new Date().toISOString(),
    boundary: "agent_visible_context_not_provider_billing",
    request: analysis.contextPack?.userRequest?.text || analysis.userRequest || "",
    latestAnalysis: {
      generatedAt: analysis.generatedAt,
      risk: analysis.risk,
      recommendation: analysis.recommendation,
      changedFiles: analysis.changes?.files || [],
      policyHits: (analysis.policyHits || []).map((hit) => hit.ruleId || hit),
      frontierSummary: analysis.contextPack?.agentContext?.frontierSummary || {}
    },
    table: rows,
    toolCalls: toolCallSummary,
    pairRuns,
    caveat: "Live-agent token delta claims require actually observed default-codex input, scopelease-codex input, and ScopeLease context evidence for the same work intent. Controlled pair-run synthetic events are excluded from latest_observed_pair_* and product-wide averages. Positive savings claims additionally require scopelease-codex input to be lower than default-codex input. Provider/API billing usage is reported separately."
  };
}

export function buildProductWideTokenSummary(repos = [], options = {}) {
  const repoPaths = resolveProductWideRepoPaths(repos, options);
  const minRepos = positiveInteger(options.minRepos || options["min-repos"], DEFAULT_PRODUCT_WIDE_MIN_REPOS);
  const minPairs = positiveInteger(options.minPairs || options["min-pairs"], DEFAULT_PRODUCT_WIDE_MIN_PAIRS);
  const minDefaultTokens = positiveInteger(options.minDefaultTokens || options["min-default-tokens"], 100);
  const observedPairScope = normalizeObservedPairScope(options.observedPairScope || options["observed-pair-scope"] || options.scope || "strict");
  const claimMetric = normalizeClaimMetric(options.claimMetric || options["claim-metric"] || options.metric || "agent-visible");
  const runFilter = normalizeRunFilter(options);
  const commandPairSelection = normalizeCommandPairSelection(
    options.commandPairSelection ||
    options["command-pair-selection"] ||
    options.commandPairScope ||
    options["command-pair-scope"] ||
    "latest"
  );
  const inputCostPerMillion = finiteNumberOrNull(
    options.inputCostPerMillion ??
    options.inputCostPer1M ??
    options["input-cost-per-1m"] ??
    options["cost-per-1m"]
  );
  const currency = String(options.currency || "USD").trim() || "USD";
  const rows = repoPaths.map((repoPath) => buildProductWideRepoRow(repoPath, { observedPairScope, minDefaultTokens }));
  const allObservedPairCandidates = rows.flatMap((row) => (row.allObservedPairCandidates || [])
    .map((pair) => ({ ...pair, repo: row.repo })));
  const incompleteObservedPairs = allObservedPairCandidates.filter((pair) => pair.status !== "measured");
  const allLiveObservedPairs = rows.flatMap((row) => (row.allLiveObservedPairs || [])
    .filter((pair) => pair.status === "measured")
    .map((pair) => ({ ...pair, repo: row.repo })));
  const scopedLivePairs = allLiveObservedPairs.filter((pair) => observedPairMatchesScope(pair, observedPairScope));
  const latestScopedLivePairs = latestObservedPairsByWorkIntent(scopedLivePairs);
  const observedPairs = latestScopedLivePairs.filter((pair) => Number(pair.defaultTokens || 0) >= minDefaultTokens);
  const providerUsagePairs = rows.flatMap((row) => (row.providerUsagePairs || [])
    .filter((pair) => pairMatchesRunFilter(pair, runFilter))
    .map((pair) => ({ ...pair, repo: row.repo })));
  const latestProviderUsagePairs = latestObservedPairsByWorkIntent(providerUsagePairs);
  const providerBilling = summarizeProviderUsagePairs(latestProviderUsagePairs, { minRepos, minPairs });
  const measuredRepoCount = new Set(observedPairs.map((pair) => pair.repo)).size;
  const weighted = summarizeObservedPairs(observedPairs);
  const allObserved = summarizeObservedPairs(latestScopedLivePairs);
  const allLiveObserved = summarizeObservedPairs(allLiveObservedPairs);
  const byTaskType = summarizeObservedPairsByTaskType(observedPairs);
  const allObservedByTaskType = summarizeObservedPairsByTaskType(latestScopedLivePairs);
  const controlledRows = rows.filter((row) =>
    row.controlledPair.status === "available" &&
    row.controlledPair.claimScope === "controlled_prompt_protocol_not_live_codex_average"
  );
  const controlled = summarizeControlledRows(controlledRows);
  const allCommandReportedPairs = rows.flatMap((row) => (row.commandReportedPairs || [])
    .filter((pair) => pairMatchesRunFilter(pair, runFilter))
    .map((pair) => ({ ...pair, repo: row.repo })));
  const selectedCommandReportedPairs = commandPairSelection === "all"
    ? allCommandReportedPairs.sort((left, right) => compareIso(right.latestTimestamp, left.latestTimestamp))
    : latestObservedPairsByWorkIntent(allCommandReportedPairs);
  const eligibleCommandReportedPairs = selectedCommandReportedPairs
    .filter((pair) => Number(pair.defaultTokens || 0) >= minDefaultTokens);
  const commandReported = summarizeCommandReportedProductPairs(eligibleCommandReportedPairs, {
    allPairs: selectedCommandReportedPairs,
    minRepos,
    minPairs,
    minDefaultTokens
  });
  const costEstimate = estimateObservedInputCost(weighted, {
    inputCostPerMillion,
    currency
  });
  const enoughRepos = measuredRepoCount >= minRepos;
  const enoughPairs = observedPairs.length >= minPairs;
  const strictScope = observedPairScope === "strict_independent_lanes";
  const hasEnoughStrictEvidence = strictScope && enoughRepos && enoughPairs;
  const weightedPositiveDelta = hasEnoughStrictEvidence && weighted.defaultTokens > 0 && Number(weighted.savedTokens || 0) > 0;
  const robustPositiveDistribution = weightedPositiveDelta &&
    Number(weighted.macroSavedPercent || 0) > 0 &&
    Number(weighted.positivePairs || 0) > Number(weighted.overheadPairs || 0);
  const claimReady = robustPositiveDistribution;
  const status = enoughRepos && enoughPairs
    ? strictScope
      ? claimReady
        ? "claim_ready"
        : weightedPositiveDelta
          ? "weighted_delta_ready_mixed_distribution"
          : "delta_ready_no_savings"
      : "delta_ready_non_strict_scope"
    : "insufficient_real_use_observed_pairs";
  const agentVisibleClaimPolicy = {
    canClaimProductWideAverageDelta: hasEnoughStrictEvidence,
    canClaimWeightedPositiveDelta: weightedPositiveDelta,
    canClaimProductWideAverageSavings: claimReady,
    canClaimEstimatedInputCostSavings: claimReady && costEstimate.status === "estimated",
    canClaimProviderBillingSavings: providerBilling.claimPolicy.canClaimProviderBillingSavings ||
      providerBilling.claimPolicy.canClaimProviderCostSavings,
    allowedClaim: claimReady
      ? "product-wide observed agent-visible input token savings across measured repositories and pairs"
      : !strictScope && enoughRepos && enoughPairs
        ? "non-strict live observed token delta for inspection only; do not call it an independent default-vs-ScopeLease product-wide savings average"
        : weightedPositiveDelta
          ? "weighted positive token delta observed, but task-level distribution is mixed; report as weighted delta, not product-wide average savings"
        : enoughRepos && enoughPairs
        ? "product-wide observed agent-visible token delta across measured repositories; do not call it savings unless weighted delta is positive"
        : "insufficient real-use observed pairs for a product-wide average claim",
    rejectedClaims: [
      "controlled pair-run prompt protocols as live Codex default behavior",
      "auto-promoted same-run pairs as independent default-vs-ScopeLease agent runs",
      "full repository size savings",
      "provider/API billing savings",
      "hidden prompt or reasoning token savings",
      "estimated input-token cost savings without an explicit price per million tokens",
      "provider/API billing savings without paired provider usage events for the same work intent",
      "weighted positive deltas as general savings when macro mean is non-positive or overhead pairs are not outnumbered"
    ]
  };
  const useCommandReportedMetric = claimMetric === "command_reported";
  const effectiveStatus = useCommandReportedMetric ? commandReported.status : status;
  const effectiveWeighted = useCommandReportedMetric ? commandReported.weighted : weighted;
  const effectiveMeasuredRepoCount = useCommandReportedMetric ? commandReported.measuredRepoCount : measuredRepoCount;
  const effectiveMeasuredPairCount = useCommandReportedMetric ? commandReported.measuredPairCount : observedPairs.length;
  const effectiveByTaskType = useCommandReportedMetric ? commandReported.byTaskType : byTaskType;
  const effectiveClaimPolicy = useCommandReportedMetric ? commandReported.claimPolicy : agentVisibleClaimPolicy;
  const effectiveMeetsFormalProductWideFloor = useCommandReportedMetric
    ? commandReported.meetsFormalProductWideFloor
    : false;
  const effectiveClaimScope = useCommandReportedMetric
    ? commandReported.claimScope
    : "agent_visible_live_observed";
  return {
    kind: "scopelease.product_wide_token_summary",
    generatedAt: new Date().toISOString(),
    boundary: useCommandReportedMetric
      ? "command_reported_total_tokens_not_provider_billing"
      : "agent_visible_context_not_provider_billing",
    metric: strictScope
      ? useCommandReportedMetric
        ? "strict_command_reported_total_tokens_same_work_intent_pairs_only"
        : "strict_actual_observed_same_work_intent_pairs_only"
      : useCommandReportedMetric
        ? "non_strict_command_reported_total_tokens_report_only"
        : "non_strict_actual_observed_same_work_intent_pairs_report_only",
    claimMetric,
    runFilter,
    commandPairSelection,
    observedPairScope,
    status: effectiveStatus,
    minRepos,
    minPairs,
    minDefaultTokens,
    meetsFormalProductWideFloor: effectiveMeetsFormalProductWideFloor,
    formalProductWideFloor: FORMAL_PRODUCT_WIDE_FLOOR,
    claimScope: effectiveClaimScope,
    repoCount: rows.length,
    measuredRepoCount: effectiveMeasuredRepoCount,
    measuredPairCount: effectiveMeasuredPairCount,
    liveObservedCandidateCount: allObservedPairCandidates.length,
    incompleteObservedPairCount: incompleteObservedPairs.length,
    observedPairCount: latestScopedLivePairs.length,
    staleObservedPairCount: scopedLivePairs.length - latestScopedLivePairs.length,
    allLiveObservedPairCount: allLiveObservedPairs.length,
    strictLiveObservedPairCount: allLiveObservedPairs.filter((pair) => pair.pairEvidenceKind === "independent_observed_lanes").length,
    commandReportedPairCount: selectedCommandReportedPairs.length,
    commandReportedEligiblePairCount: eligibleCommandReportedPairs.length,
    autoPromotedPairCount: allLiveObservedPairs.filter((pair) => pair.pairEvidenceKind === "auto_promoted_same_run").length,
    excludedLiveObservedPairCount: allLiveObservedPairs.length - scopedLivePairs.length,
    tinyDefaultPairCount: useCommandReportedMetric
      ? selectedCommandReportedPairs.length - eligibleCommandReportedPairs.length
      : latestScopedLivePairs.length - observedPairs.length,
    missingRepoCount: rows.length - effectiveMeasuredRepoCount,
    weighted: effectiveWeighted,
    agentVisible: {
      status,
      measuredRepoCount,
      measuredPairCount: observedPairs.length,
      weighted
    },
    allObserved,
    allLiveObserved,
    byTaskType: effectiveByTaskType,
    allObservedByTaskType,
    providerBilling,
    costEstimate,
    controlledProtocol: controlled,
    commandReported,
    claimPolicy: effectiveClaimPolicy,
    rows,
    caveat: "Product-wide averages use strict observed pairs by default: separate default-codex input, scopelease-codex input, and ScopeLease context evidence for the same work intent and the same reported source boundary. If the same work intent has multiple observed runs, only the latest measured pair is eligible for the current product-wide average and older pairs are reported as stale. Controlled pair-run synthetic events are excluded from live averages. Auto-promoted same-run pairs are reported separately because they preserve a pre-ScopeLease prompt from the same Codex run, not an independent default-agent run. Tiny default baselines are reported but excluded from savings averages. A weighted positive delta is not enough for a savings claim unless the macro mean is also positive and positive pairs outnumber overhead pairs. Controlled pair-run baselines are reported separately and are not used for live Codex/Claude-style averages. Cost is only an estimate when an explicit input token price is supplied."
  };
}

export function exportEvidenceBundle(repoPath, options = {}) {
  const root = path.resolve(repoPath || ".");
  const state = loadState(root) || {};
  const analysis = state.latestAnalysis || analyzeRepository(root, { userRequest: options.request || "" });
  const outputDir = path.resolve(root, options.outputDir || options.output || path.join(".scopelease", "evidence", timestampId()));
  fs.mkdirSync(outputDir, { recursive: true });
  const payload = buildAgentInputPayload(analysis.contextPack, { userRequest: options.request || analysis.userRequest || "" });
  const summary = buildEvidenceSummary(root, options);
  const files = [
    writeJson(path.join(outputDir, "evidence-summary.json"), summary),
    writeText(path.join(outputDir, "summary-table.tsv"), renderSummaryTable(summary.table)),
    writeJson(path.join(outputDir, "context-pack.json"), analysis.contextPack || {}),
    writeJson(path.join(outputDir, "agent-input.json"), payload),
    writeText(path.join(outputDir, "decision-card.md"), analysis.decisionCard || ""),
    writeJsonl(path.join(outputDir, "guard-events.jsonl"), state.guardEvents || []),
    writeJsonl(path.join(outputDir, "fatigue-events.jsonl"), state.fatigueEvents || []),
    writeJsonl(path.join(outputDir, "approval-leases.jsonl"), state.approvalLeases || []),
    writeJsonl(path.join(outputDir, "mcp-context-events.jsonl"), state.mcpContextEvents || []),
    writeJsonl(path.join(outputDir, "actual-work-events.jsonl"), state.actualWorkEvents || [])
  ];
  return {
    kind: "scopelease.evidence_export",
    repo: root,
    outputDir,
    generatedAt: summary.generatedAt,
    files,
    summary
  };
}

function buildProductWideRepoRow(repoPath, options = {}) {
  const repo = path.resolve(repoPath || ".");
  const state = loadState(repo) || {};
  const observedPairScope = normalizeObservedPairScope(options.observedPairScope || options.scope || "strict");
  const minDefaultTokens = positiveInteger(options.minDefaultTokens || options["min-default-tokens"], 100);
  const allObservedPairCandidates = collectObservedPairs(state)
    .map((pair) => ({
      status: pair.status,
      workIntent: pair.workIntent,
      pairId: pair.pairId,
      runId: pair.runId,
      taskType: pair.taskType,
      pairEvidenceKind: pair.pairEvidenceKind,
      defaultTokens: pair.defaultTokens,
      scopeleaseTokens: pair.scopeleaseTokens,
      savedTokens: pair.savedTokens,
      savedPercent: pair.savedPercent,
      deltaDirection: pair.deltaDirection,
      canClaimSavings: pair.canClaimSavings,
      claimScope: pair.claimScope,
      observedContextMode: pair.observedContextMode,
      sourceBoundary: pair.sourceBoundary,
      eventCounts: pair.eventCounts,
      tokenBreakdown: pair.tokenBreakdown,
      latestTimestamp: pair.latestTimestamp
    }));
  const allLiveObservedPairs = allObservedPairCandidates.filter((pair) => pair.status === "measured");
  const scopedObservedPairs = allLiveObservedPairs.filter((pair) => observedPairMatchesScope(pair, observedPairScope));
  const latestScopedObservedPairs = latestObservedPairsByWorkIntent(scopedObservedPairs);
  const eligibleObservedPairs = latestScopedObservedPairs.filter((pair) => Number(pair.defaultTokens || 0) >= minDefaultTokens);
  const observed = eligibleObservedPairs[0] || emptyObservedPair();
  const observedAggregate = summarizeObservedPairs(eligibleObservedPairs);
  const staleObservedPairs = scopedObservedPairs.length - latestScopedObservedPairs.length;
  const tinyDefaultPairs = latestScopedObservedPairs.length - eligibleObservedPairs.length;
  const pairRuns = loadPairRunSummaries(repo);
  const latestPair = pairRuns[0] || null;
  const commandReportedPairs = pairRuns.flatMap((run) => run.commandReportedPairs || []);
  const providerUsagePairs = collectProviderUsagePairs(state);
  return {
    repo,
    observed: {
      status: observed.status,
      workIntent: observed.workIntent,
      pairId: observed.pairId,
      runId: observed.runId,
      defaultTokens: observed.defaultTokens,
      scopeleaseTokens: observed.scopeleaseTokens,
      savedTokens: observed.savedTokens,
      savedPercent: observed.savedPercent,
      deltaDirection: observed.deltaDirection,
      canClaimSavings: observed.canClaimSavings,
      claimScope: observed.claimScope,
      observedContextMode: observed.observedContextMode || null,
      sourceBoundary: observed.sourceBoundary || null,
      taskType: observed.taskType || null,
      pairEvidenceKind: observed.pairEvidenceKind || null,
      eventCounts: observed.eventCounts
    },
    observedPairs: eligibleObservedPairs,
    staleObservedPairs: scopedObservedPairs.filter((pair) => !latestScopedObservedPairs.includes(pair)),
    allScopedObservedPairs: scopedObservedPairs,
    latestScopedObservedPairs,
    allLiveObservedPairs,
    allObservedPairCandidates,
    incompleteObservedPairs: allObservedPairCandidates.filter((pair) => pair.status !== "measured"),
    excludedObservedPairs: allLiveObservedPairs.filter((pair) => !observedPairMatchesScope(pair, observedPairScope)),
    providerUsagePairs,
    commandReportedPairs,
    observedAggregate,
    staleObservedPairsCount: staleObservedPairs,
    tinyDefaultPairs,
    controlledPair: latestPair
      ? {
          status: "available",
          runId: latestPair.runId,
          generatedAt: latestPair.generatedAt,
          protocolKind: latestPair.observationKind,
          claimScope: latestPair.claimScope,
          baselineModes: latestPair.baselineModes,
          defaultInputModes: latestPair.defaultInputModes,
          scopeleaseModes: latestPair.scopeleaseModes,
          defaultTokens: finiteNumberOrNull(latestPair.summary?.defaultTokens),
          scopeleaseTokens: finiteNumberOrNull(latestPair.summary?.scopeleaseTokens),
          savedTokens: finiteNumberOrNull(latestPair.summary?.savedTokens),
          savedPercent: finiteNumberOrNull(latestPair.summary?.savedPercent)
        }
      : {
          status: "unavailable"
        }
  };
}

function summarizeObservedPairs(pairs = []) {
  const defaultTokens = pairs.reduce((sum, pair) => sum + Number(pair.defaultTokens || 0), 0);
  const scopeleaseTokens = pairs.reduce((sum, pair) => sum + Number(pair.scopeleaseTokens || 0), 0);
  const callMeasuredPairs = pairs.filter((pair) => pair.callBreakdown?.status === "measured");
  const defaultToolCalls = callMeasuredPairs.reduce((sum, pair) => sum + Number(pair.callBreakdown?.defaultToolCalls || 0), 0);
  const scopeleaseToolCalls = callMeasuredPairs.reduce((sum, pair) => sum + Number(pair.callBreakdown?.scopeleaseToolCalls || 0), 0);
  const toolCallDelta = callMeasuredPairs.length ? defaultToolCalls - scopeleaseToolCalls : null;
  const savedTokens = defaultTokens > 0 ? defaultTokens - scopeleaseTokens : null;
  const percents = pairs
    .map((pair) => finiteNumberOrNull(pair.savedPercent))
    .filter((value) => value !== null);
  const distribution = summarizePercentDistribution(percents);
  return {
    measuredPairs: pairs.length,
    defaultTokens,
    scopeleaseTokens,
    savedTokens,
    savedPercent: defaultTokens > 0 ? Math.round((savedTokens / defaultTokens) * 100) : null,
    macroSavedPercent: distribution.mean,
    medianSavedPercent: distribution.median,
    q1SavedPercent: distribution.q1,
    q3SavedPercent: distribution.q3,
    minSavedPercent: distribution.min,
    maxSavedPercent: distribution.max,
    positivePairs: pairs.filter((pair) => Number(pair.savedTokens || 0) > 0).length,
    overheadPairs: pairs.filter((pair) => Number(pair.savedTokens || 0) < 0).length,
    toolCalls: {
      default: defaultToolCalls,
      scopelease: scopeleaseToolCalls,
      delta: toolCallDelta,
      reductionPercent: toolCallDelta !== null && defaultToolCalls > 0 ? Math.round((toolCallDelta / defaultToolCalls) * 100) : null,
      measuredPairs: callMeasuredPairs.length
    },
    distribution
  };
}

function summarizeToolCallEvents(events = []) {
  const toolEvents = (events || []).filter(isToolCallEvent);
  const byTool = new Map();
  const byFamily = new Map();
  for (const event of toolEvents) {
    const tool = normalizedToolName(event);
    const family = normalizedToolFamily(event);
    byTool.set(tool, (byTool.get(tool) || 0) + 1);
    byFamily.set(family, (byFamily.get(family) || 0) + 1);
  }
  const tools = [...byTool.entries()]
    .map(([tool, calls]) => ({ tool, calls }))
    .sort((left, right) => right.calls - left.calls || left.tool.localeCompare(right.tool));
  const families = [...byFamily.entries()]
    .map(([family, calls]) => ({ family, calls }))
    .sort((left, right) => right.calls - left.calls || left.family.localeCompare(right.family));
  return {
    totalCalls: toolEvents.length,
    totalTokens: sumTokens(toolEvents),
    tools,
    families,
    breakdownLabel: tools.length ? tools.map((item) => `${item.tool}:${item.calls}`).join(",") : ""
  };
}

function summarizeObservedPairsByTaskType(pairs = []) {
  const groups = new Map();
  for (const pair of pairs || []) {
    const key = String(pair.taskType || "unclassified").trim() || "unclassified";
    const rows = groups.get(key) || [];
    rows.push(pair);
    groups.set(key, rows);
  }
  return [...groups.entries()]
    .map(([taskType, rows]) => ({
      taskType,
      ...summarizeObservedPairs(rows)
    }))
    .sort((left, right) => {
      if (right.measuredPairs !== left.measuredPairs) return right.measuredPairs - left.measuredPairs;
      return String(left.taskType).localeCompare(String(right.taskType));
    });
}

function commandReportedSourceFor(measuredPairs = []) {
  const sources = [...new Set(measuredPairs.map((pair) => pair?.source).filter(Boolean))];
  if (!sources.length) return null;
  return sources.join("+");
}

function summarizeCommandReportedProductPairs(
  pairs = [],
  {
    allPairs = [],
    minRepos = DEFAULT_PRODUCT_WIDE_MIN_REPOS,
    minPairs = DEFAULT_PRODUCT_WIDE_MIN_PAIRS,
    minDefaultTokens = 100
  } = {}
) {
  const measuredPairs = (pairs || []).filter((pair) => pair.status === "measured");
  const measuredRepoCount = new Set(measuredPairs.map((pair) => pair.repo).filter(Boolean)).size;
  const weighted = summarizeObservedPairs(measuredPairs);
  const enoughRepos = measuredRepoCount >= minRepos;
  const enoughPairs = measuredPairs.length >= minPairs;
  const weightedPositiveDelta = enoughRepos && enoughPairs && weighted.defaultTokens > 0 && Number(weighted.savedTokens || 0) > 0;
  const robustPositiveDistribution = weightedPositiveDelta &&
    Number(weighted.macroSavedPercent || 0) > 0 &&
    Number(weighted.positivePairs || 0) > Number(weighted.overheadPairs || 0);
  const preliminaryStatus = enoughRepos && enoughPairs
    ? robustPositiveDistribution
      ? "claim_ready"
      : weightedPositiveDelta
        ? "weighted_delta_ready_mixed_distribution"
        : "delta_ready_no_savings"
    : "insufficient_command_reported_pairs";
  const meetsFormalProductWideFloor = measuredRepoCount >= FORMAL_PRODUCT_WIDE_FLOOR.minRepos &&
    measuredPairs.length >= FORMAL_PRODUCT_WIDE_FLOOR.minPairs;
  const status = enoughRepos && enoughPairs && !meetsFormalProductWideFloor
    ? "pilot_ready_not_formal_claim"
    : preliminaryStatus;
  return {
    status,
    boundary: "command_reported_total_tokens_not_provider_billing",
    source: measuredPairs.length ? (commandReportedSourceFor(measuredPairs) || "command_reported_total_tokens") : "unavailable",
    measuredRepoCount,
    measuredPairCount: measuredPairs.length,
    meetsFormalProductWideFloor,
    formalProductWideFloor: FORMAL_PRODUCT_WIDE_FLOOR,
    claimScope: meetsFormalProductWideFloor ? "formal_product_wide" : "pilot_below_formal_floor",
    observedPairCount: allPairs.length,
    tinyDefaultPairCount: Math.max(0, allPairs.length - measuredPairs.length),
    minRepos,
    minPairs,
    minDefaultTokens,
    weighted,
    quality: summarizeCommandReportedQuality(measuredPairs),
    decisionProxy: summarizeCommandReportedDecisionProxy(measuredPairs),
    duration: summarizeCommandReportedDuration(measuredPairs),
    byTaskType: summarizeObservedPairsByTaskType(measuredPairs),
    pairs: measuredPairs,
    claimPolicy: {
      canClaimPilotDelta: enoughRepos && enoughPairs && !meetsFormalProductWideFloor,
      canClaimProductWideAverageDelta: enoughRepos && enoughPairs && meetsFormalProductWideFloor,
      canClaimWeightedPositiveDelta: weightedPositiveDelta,
      canClaimProductWideAverageSavings: robustPositiveDistribution && meetsFormalProductWideFloor,
      canClaimFormalProductWideAverageSavings: robustPositiveDistribution && meetsFormalProductWideFloor,
      meetsFormalProductWideFloor,
      canClaimEstimatedInputCostSavings: false,
      canClaimProviderBillingSavings: false,
      allowedClaim: enoughRepos && enoughPairs && !meetsFormalProductWideFloor
        ? "pilot command-reported same-workIntent measurement only; not product-wide or formal average evidence"
        : robustPositiveDistribution
        ? "product-wide command-reported total token savings across measured repositories and pairs"
        : weightedPositiveDelta
          ? "weighted positive command-reported token delta observed, but task distribution is mixed; report as weighted delta, not average savings"
          : enoughRepos && enoughPairs
            ? "product-wide command-reported token delta observed; do not call it savings unless positive and robust"
            : "insufficient command-reported paired runs for a product-wide average claim",
      rejectedClaims: [
        "provider/API billing savings",
        "hidden prompt or reasoning token savings",
        "agent-visible input savings when only command-reported totals were measured",
        "controlled prompt-only protocols as live command behavior",
        "weighted positive deltas as general savings when macro mean is non-positive or overhead pairs are not outnumbered"
      ]
    }
  };
}

function collectProviderUsagePairs(state = {}) {
  const events = (Array.isArray(state.modelUsageEvents) ? state.modelUsageEvents : [])
    .filter((event) => ["default-codex", "scopelease-codex"].includes(actualWorkLane(event)))
    .filter((event) => Number(event.totalTokens || 0) > 0 && event.totalMeasured !== false);
  const groups = new Map();
  for (const event of events) {
    const lane = actualWorkLane(event);
    const workIntent = eventWorkIntent(event);
    const pairId = normalizePairId(event.pairId || event.pair_id);
    const runId = normalizeRunId(event.runId || event.run_id);
    const pairRunId = normalizePairRunId(runId);
    const key = [workIntent || "unscoped", pairId || pairRunId || "unpaired"].join("::");
    const group = groups.get(key) || {
      workIntent,
      pairId,
      runId: pairRunId || "",
      latestTimestamp: "",
      defaultEvents: [],
      scopeleaseEvents: []
    };
    group.latestTimestamp = maxIso(group.latestTimestamp, event.timestamp);
    if (lane === "default-codex") group.defaultEvents.push(event);
    if (lane === "scopelease-codex") group.scopeleaseEvents.push(event);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => {
      const defaultTokens = sumTokens(group.defaultEvents, "totalTokens");
      const scopeleaseTokens = sumTokens(group.scopeleaseEvents, "totalTokens");
      const defaultCostUsd = sumTokens(group.defaultEvents, "totalCostUsd");
      const scopeleaseCostUsd = sumTokens(group.scopeleaseEvents, "totalCostUsd");
      const costMeasured = group.defaultEvents.some((event) => event.costMeasured) &&
        group.scopeleaseEvents.some((event) => event.costMeasured);
      const savedCostUsd = costMeasured ? roundCost(defaultCostUsd - scopeleaseCostUsd) : null;
      const measured = defaultTokens > 0 && scopeleaseTokens > 0;
      const savedTokens = measured ? defaultTokens - scopeleaseTokens : null;
      return {
        status: measured ? "measured" : "needs_pair",
        workIntent: group.workIntent || null,
        pairId: group.pairId || null,
        runId: group.runId || null,
        latestTimestamp: group.latestTimestamp,
        defaultTokens: defaultTokens || null,
        scopeleaseTokens: scopeleaseTokens || null,
        savedTokens,
        savedPercent: measured ? Math.round((savedTokens / defaultTokens) * 100) : null,
        defaultCostUsd: costMeasured ? roundCost(defaultCostUsd) : null,
        scopeleaseCostUsd: costMeasured ? roundCost(scopeleaseCostUsd) : null,
        savedCostUsd,
        savedCostPercent: costMeasured && defaultCostUsd > 0 ? Math.round((savedCostUsd / defaultCostUsd) * 100) : null,
        deltaDirection: deltaDirection(savedTokens),
        canClaimSavings: measured && savedTokens > 0,
        canClaimCostSavings: costMeasured && savedCostUsd > 0,
        claimScope: measured
          ? "paired_provider_usage_total_tokens"
          : "needs_paired_provider_usage_events",
        sourceBoundary: "provider_usage_events",
        eventCounts: {
          default: group.defaultEvents.length,
          scopelease: group.scopeleaseEvents.length
        }
      };
    })
    .filter((pair) => pair.status === "measured")
    .sort((left, right) => compareIso(right.latestTimestamp, left.latestTimestamp));
}

function summarizeProviderUsagePairs(
  pairs = [],
  {
    minRepos = DEFAULT_PRODUCT_WIDE_MIN_REPOS,
    minPairs = DEFAULT_PRODUCT_WIDE_MIN_PAIRS
  } = {}
) {
  const measuredPairs = (pairs || []).filter((pair) => pair.status === "measured");
  const measuredRepoCount = new Set(measuredPairs.map((pair) => pair.repo).filter(Boolean)).size;
  const weighted = summarizeObservedPairs(measuredPairs);
  const costWeighted = summarizeProviderCostPairs(measuredPairs);
  const enoughRepos = measuredRepoCount >= minRepos;
  const enoughPairs = measuredPairs.length >= minPairs;
  const weightedPositiveDelta = enoughRepos && enoughPairs && weighted.defaultTokens > 0 && Number(weighted.savedTokens || 0) > 0;
  const robustPositiveDistribution = weightedPositiveDelta &&
    Number(weighted.macroSavedPercent || 0) > 0 &&
    Number(weighted.positivePairs || 0) > Number(weighted.overheadPairs || 0);
  const costPositiveDelta = enoughRepos && enoughPairs && costWeighted.measuredPairs >= minPairs &&
    costWeighted.defaultCostUsd > 0 && Number(costWeighted.savedCostUsd || 0) > 0;
  const robustCostDistribution = costPositiveDelta &&
    Number(costWeighted.macroSavedCostPercent || 0) > 0 &&
    Number(costWeighted.positivePairs || 0) > Number(costWeighted.overheadPairs || 0);
  const status = enoughRepos && enoughPairs
    ? robustPositiveDistribution
      ? "claim_ready"
      : weightedPositiveDelta
        ? "weighted_delta_ready_mixed_distribution"
        : "delta_ready_no_savings"
    : "insufficient_provider_usage_pairs";
  return {
    status,
    boundary: "paired_provider_usage_total_tokens",
    measuredRepoCount,
    measuredPairCount: measuredPairs.length,
    weighted,
    costWeighted,
    claimPolicy: {
      canClaimProviderBillingDelta: enoughRepos && enoughPairs,
      canClaimWeightedPositiveDelta: weightedPositiveDelta,
      canClaimProviderBillingSavings: robustPositiveDistribution,
      canClaimProviderCostDelta: costWeighted.measuredPairs >= minPairs && enoughRepos,
      canClaimProviderCostSavings: robustCostDistribution,
      allowedClaim: robustPositiveDistribution
        ? "paired provider/API total token savings across measured repositories and pairs"
        : weightedPositiveDelta
          ? "weighted positive provider/API token delta observed, but task distribution is mixed; do not call it average savings"
          : enoughRepos && enoughPairs
            ? "paired provider/API token delta observed; do not call it savings unless positive and robust"
            : "insufficient paired provider/API usage evidence"
    }
  };
}

function summarizeProviderCostPairs(pairs = []) {
  const measured = (pairs || []).filter((pair) =>
    finiteNumberOrNull(pair.defaultCostUsd) !== null &&
    finiteNumberOrNull(pair.scopeleaseCostUsd) !== null
  );
  const defaultCostUsd = roundCost(measured.reduce((sum, pair) => sum + Number(pair.defaultCostUsd || 0), 0));
  const scopeleaseCostUsd = roundCost(measured.reduce((sum, pair) => sum + Number(pair.scopeleaseCostUsd || 0), 0));
  const savedCostUsd = measured.length ? roundCost(defaultCostUsd - scopeleaseCostUsd) : null;
  const percents = measured
    .map((pair) => finiteNumberOrNull(pair.savedCostPercent))
    .filter((value) => value !== null);
  const distribution = summarizePercentDistribution(percents);
  return {
    boundary: "paired_provider_usage_cost_usd",
    measuredPairs: measured.length,
    defaultCostUsd,
    scopeleaseCostUsd,
    savedCostUsd,
    savedCostPercent: defaultCostUsd > 0 ? Math.round((savedCostUsd / defaultCostUsd) * 100) : null,
    macroSavedCostPercent: distribution.mean,
    medianSavedCostPercent: distribution.median,
    q1SavedCostPercent: distribution.q1,
    q3SavedCostPercent: distribution.q3,
    minSavedCostPercent: distribution.min,
    maxSavedCostPercent: distribution.max,
    positivePairs: measured.filter((pair) => Number(pair.savedCostUsd || 0) > 0).length,
    overheadPairs: measured.filter((pair) => Number(pair.savedCostUsd || 0) < 0).length,
    distribution
  };
}

function estimateObservedInputCost(weighted = {}, { inputCostPerMillion = null, currency = "USD" } = {}) {
  const price = finiteNumberOrNull(inputCostPerMillion);
  const defaultTokens = Number(weighted.defaultTokens || 0);
  const scopeleaseTokens = Number(weighted.scopeleaseTokens || 0);
  if (price === null || price <= 0) {
    return {
      status: "needs_explicit_input_cost_per_1m",
      currency,
      inputCostPerMillion: null,
      defaultCost: null,
      scopeleaseCost: null,
      savedCost: null,
      savedPercent: null,
      caveat: "Cost savings are not computed unless an explicit input-token price per 1M tokens is supplied."
    };
  }
  const defaultCost = roundCost((defaultTokens / 1_000_000) * price);
  const scopeleaseCost = roundCost((scopeleaseTokens / 1_000_000) * price);
  const savedCost = roundCost(defaultCost - scopeleaseCost);
  return {
    status: defaultTokens > 0 ? "estimated" : "unmeasured",
    currency,
    inputCostPerMillion: price,
    defaultCost,
    scopeleaseCost,
    savedCost,
    savedPercent: defaultCost > 0 ? Math.round((savedCost / defaultCost) * 100) : null,
    caveat: "Estimated from observed agent-visible input tokens and an explicit input-token price only; provider billing, hidden prompts, reasoning, cache, and output costs are excluded."
  };
}

function roundCost(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 1_000_000) / 1_000_000 : 0;
}

function summarizeControlledRows(rows = []) {
  const defaultTokens = rows.reduce((sum, row) => sum + Number(row.controlledPair.defaultTokens || 0), 0);
  const scopeleaseTokens = rows.reduce((sum, row) => sum + Number(row.controlledPair.scopeleaseTokens || 0), 0);
  const savedTokens = defaultTokens > 0 ? defaultTokens - scopeleaseTokens : null;
  return {
    reposWithControlledProtocol: rows.length,
    defaultTokens,
    scopeleaseTokens,
    savedTokens,
    savedPercent: defaultTokens > 0 ? Math.round((savedTokens / defaultTokens) * 100) : null,
    claimScope: rows.length ? "controlled_prompt_protocol_not_live_codex_average" : null
  };
}

function resolveProductWideRepoPaths(repos = [], options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const value = options.repos || options.manifest || repos;
  if (Array.isArray(value)) return uniquePaths(value, cwd);
  const text = String(value || "").trim();
  if (!text) return uniquePaths([options.repo || "."], cwd);
  const maybeFile = path.resolve(cwd, text);
  if (fs.existsSync(maybeFile) && fs.statSync(maybeFile).isFile()) {
    return uniquePaths(readRepoManifest(maybeFile), path.dirname(maybeFile));
  }
  return uniquePaths(text.split(","), cwd);
}

function readRepoManifest(filePath) {
  const text = fs.readFileSync(filePath, "utf8").trim();
  if (!text) return [];
  if (text.startsWith("[")) return JSON.parse(text);
  if (text.startsWith("{")) {
    const parsed = JSON.parse(text);
    return parsed.repos || parsed.repositories || [];
  }
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (line.startsWith("{")) {
        const parsed = JSON.parse(line);
        return parsed.repo || parsed.path || parsed.root || "";
      }
      return line;
    });
}

function uniquePaths(values = [], cwd = process.cwd()) {
  const seen = new Set();
  const output = [];
  for (const value of values || []) {
    const raw = typeof value === "string" ? value : value?.repo || value?.path || value?.root || "";
    if (!raw) continue;
    const resolved = path.resolve(cwd, String(raw));
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    output.push(resolved);
  }
  return output;
}

export function exportPermissionFixtureSuite(repoPath, options = {}) {
  const root = path.resolve(repoPath || ".");
  const outputPath = path.resolve(root, options.output || options.outputPath || path.join(".scopelease", "fixtures", "permission-fixtures.jsonl"));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const rows = defaultPermissionFixtures();
  fs.writeFileSync(outputPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return {
    kind: "scopelease.permission_fixture_suite",
    repo: root,
    outputPath,
    count: rows.length,
    rows
  };
}

export function runPermissionFixtureSuite(repoPath, options = {}) {
  const root = path.resolve(repoPath || ".");
  const fixturesPath = path.resolve(root, options.fixtures || options.fixturesPath || options.input || path.join(".scopelease", "fixtures", "permission-fixtures.jsonl"));
  const rows = fs.existsSync(fixturesPath) ? readJsonl(fixturesPath) : defaultPermissionFixtures();
  const runId = String(options.runId || options["run-id"] || `permission-${timestampId()}`).trim();
  const outputDir = path.resolve(root, options.outputDir || options.output || path.join(".scopelease", "fixtures", "runs", runId));
  const useExistingState = Boolean(options.useExistingState || options["use-existing-state"]);
  const recordState = options.recordState !== false && options["no-record-state"] !== true;
  fs.mkdirSync(outputDir, { recursive: true });

  const results = rows.map((fixture, index) => runPermissionFixture(root, fixture, {
    index,
    runId,
    useExistingState,
    recordState
  }));
  const summary = summarizePermissionResults(results);
  const result = {
    kind: "scopelease.permission_fixture_run",
    repo: root,
    runId,
    generatedAt: new Date().toISOString(),
    fixturesPath: fs.existsSync(fixturesPath) ? fixturesPath : null,
    outputDir,
    isolated: !useExistingState,
    recorded: recordState,
    summary,
    results
  };
  writeJson(path.join(outputDir, "summary.json"), result);
  writeJsonl(path.join(outputDir, "results.jsonl"), results);
  writeText(path.join(outputDir, "results.tsv"), renderPermissionResultsTable(results));
  return result;
}

export function renderSummaryTable(rows = []) {
  const header = ["metric", "value", "source", "note"];
  return [
    header.join("\t"),
    ...rows.map((row) => header.map((key) => tableCell(row[key])).join("\t"))
  ].join("\n") + "\n";
}

export function renderPermissionResultsTable(rows = []) {
  const header = ["id", "pass", "expected_verdict", "actual_verdict", "expected_prompt", "actual_prompt", "lease_id", "reason"];
  return [
    header.join("\t"),
    ...rows.map((row) => [
      row.id,
      row.pass ? "PASS" : "FAIL",
      row.expected?.verdict || "",
      row.actual?.verdict || "",
      row.expected?.humanPrompt == null ? "" : String(row.expected.humanPrompt),
      row.actual?.humanPrompt == null ? "" : String(row.actual.humanPrompt),
      row.actual?.leaseId || "",
      row.actual?.reason || ""
    ].map(tableCell).join("\t"))
  ].join("\n") + "\n";
}

function runPermissionFixture(root, fixture = {}, options = {}) {
  const id = String(fixture.id || `fixture-${options.index + 1}`);
  const request = String(fixture.request || "");
  const action = fixture.action || {};
  const analysis = analyzeRepository(root, { userRequest: request });
  const baseState = loadState(root) || {};
  let state = options.useExistingState
    ? baseState
    : {
        ...baseState,
        approvalLeases: [],
        stopEvents: []
      };
  let setup = null;

  if (fixture.setup?.approveChoice || fixture.setup?.choiceId) {
    const setupAction = fixture.setup.action || action;
    const setupAnalysis = fixture.setup.request && fixture.setup.request !== request
      ? analyzeRepository(root, { userRequest: String(fixture.setup.request || "") })
      : analysis;
    const setupVerdict = evaluateAgentAction({ action: setupAction, analysis: setupAnalysis, state });
    const decisionBundle = fixture.setup.decisionBundle ||
      setupVerdict.decisionBundle ||
      setupAnalysis.contextPack?.agentContext?.fatiguePlan?.decisionBundle;
    if (!decisionBundle) {
      setup = { ok: false, reason: "no decision bundle available for fixture approval setup" };
    } else {
      const lease = approveDecisionBundle({
        analysis: setupAnalysis,
        state,
        decisionBundle,
        choiceId: fixture.setup.approveChoice || fixture.setup.choiceId || "allow_scoped_patch",
        grantedBy: fixture.setup.grantedBy || "fixture"
      });
      state = {
        ...state,
        approvalLeases: [lease, ...(state.approvalLeases || [])]
      };
      if (options.recordState) {
        saveState(root, {
          ...baseState,
          approvalLeases: [lease, ...(baseState.approvalLeases || [])]
        });
        recordDecisionFatigueEvent(root, {
          type: "approval_lease_created",
          request,
          source: "permission-fixtures:setup",
          actor: "fixture",
          lease,
          decisionBundleId: decisionBundle.id,
          action: setupAction
        });
      }
      setup = { ok: true, leaseId: lease.id, choiceId: lease.choiceId };
    }
  }

  const verdict = evaluateAgentAction({ action, analysis, state });
  if (options.recordState) {
    recordGuardDecision(root, {
      verdict,
      action,
      request,
      source: "permission-fixtures:run"
    });
  }
  const actual = {
    verdict: verdict.verdict,
    actionGrant: verdict.actionGrant,
    humanPrompt: Boolean(verdict.shouldAskHuman),
    leaseId: verdict.leaseId || null,
    reason: verdict.reason || ""
  };
  const expected = fixture.expected || {};
  const pass = permissionFixturePasses(actual, expected);
  return {
    kind: "scopelease.permission_fixture_result",
    id,
    title: fixture.title || "",
    request,
    action,
    setup,
    expected,
    actual,
    pass,
    measures: fixture.measures || [],
    verdict
  };
}

function permissionFixturePasses(actual = {}, expected = {}) {
  if (expected.verdict && actual.verdict !== expected.verdict) return false;
  if (expected.actionGrant && actual.actionGrant !== expected.actionGrant) return false;
  if (expected.humanPrompt !== undefined && Boolean(actual.humanPrompt) !== Boolean(expected.humanPrompt)) return false;
  if (expected.leaseRequired === true && !actual.leaseId) return false;
  if (expected.leaseRequired === false && actual.leaseId) return false;
  return true;
}

function summarizePermissionResults(results = []) {
  const passed = results.filter((row) => row.pass).length;
  const failed = results.length - passed;
  const prompts = results.filter((row) => row.actual?.humanPrompt).length;
  const leaseHits = results.filter((row) => row.actual?.leaseId).length;
  const denied = results.filter((row) => row.actual?.verdict === "deny").length;
  return {
    total: results.length,
    passed,
    failed,
    passRate: results.length ? Math.round((passed / results.length) * 100) : null,
    humanPrompts: prompts,
    leaseHits,
    denied,
    confusion: summarizePermissionConfusion(results)
  };
}

function summarizePermissionConfusion(results = []) {
  const verdicts = ["allow_with_log", "ask_once", "deny"];
  const matrix = Object.fromEntries(verdicts.map((expected) => [
    expected,
    Object.fromEntries(verdicts.map((actual) => [actual, 0]))
  ]));
  const counts = {
    expectedAllow: 0,
    expectedAsk: 0,
    expectedDeny: 0,
    actualAllow: 0,
    actualAsk: 0,
    actualDeny: 0,
    correctAllow: 0,
    correctAsk: 0,
    correctDeny: 0,
    unsafeFalseAllow: 0,
    falseBlock: 0,
    falseDeny: 0,
    falseAsk: 0,
    mismatches: 0
  };
  const mismatchRows = [];

  for (const row of results) {
    const expected = normalizePermissionVerdict(row.expected?.verdict);
    const actual = normalizePermissionVerdict(row.actual?.verdict);
    if (expected === "allow_with_log") counts.expectedAllow += 1;
    if (expected === "ask_once") counts.expectedAsk += 1;
    if (expected === "deny") counts.expectedDeny += 1;
    if (actual === "allow_with_log") counts.actualAllow += 1;
    if (actual === "ask_once") counts.actualAsk += 1;
    if (actual === "deny") counts.actualDeny += 1;
    if (matrix[expected]?.[actual] !== undefined) matrix[expected][actual] += 1;
    if (expected === actual) {
      if (expected === "allow_with_log") counts.correctAllow += 1;
      if (expected === "ask_once") counts.correctAsk += 1;
      if (expected === "deny") counts.correctDeny += 1;
      continue;
    }
    counts.mismatches += 1;
    if (expected === "deny" && actual !== "deny") counts.unsafeFalseAllow += 1;
    if (expected === "allow_with_log" && actual !== "allow_with_log") counts.falseBlock += 1;
    if (actual === "deny" && expected !== "deny") counts.falseDeny += 1;
    if (actual === "ask_once" && expected !== "ask_once") counts.falseAsk += 1;
    mismatchRows.push({
      id: row.id,
      expected,
      actual,
      reason: row.actual?.reason || ""
    });
  }

  return {
    boundary: "fixture-level expected-vs-actual guard verdict matrix; not a human safety study",
    matrix,
    counts,
    mismatchRows
  };
}

function normalizePermissionVerdict(value = "") {
  const text = String(value || "").trim();
  if (text === "allow" || text === "allow_with_log") return "allow_with_log";
  if (text === "ask" || text === "ask_once") return "ask_once";
  if (text === "deny" || text === "block") return "deny";
  return text || "unknown";
}

function metricRow(metric, value, source, note) {
  return { metric, value, source, note };
}

function effectiveFatigueMetrics(state = {}) {
  const stored = state.fatigueMetrics || {};
  const events = Array.isArray(state.fatigueEvents) ? state.fatigueEvents : [];
  const derived = {
    humanDecisionsRecorded: events.filter((event) => {
      const eventType = String(event.eventType || "").trim();
      if (eventType === "human_decision_recorded") return true;
      if (eventType !== "approval_lease_created") return false;
      return String(event.actor || "").toLowerCase() !== "agent";
    }).length,
    approvalLeasesCreated: events.filter((event) => event.eventType === "approval_lease_created").length,
    approvalLeaseHits: events.filter((event) => event.eventType === "approval_lease_hit").length,
    approvalLeaseMisses: events.filter((event) => event.eventType === "approval_lease_miss").length,
    repeatedQuestionsSuppressed: events.filter((event) => event.eventType === "approval_lease_hit" || event.eventType === "repeated_question_suppressed").length,
    humanPromptsShown: events.filter((event) => event.eventType === "human_prompt_shown" || event.eventType === "approval_prompt_shown").length
  };
  return {
    ...stored,
    humanDecisionsRecorded: Math.max(Number(stored.humanDecisionsRecorded || 0), derived.humanDecisionsRecorded),
    approvalLeasesCreated: Math.max(Number(stored.approvalLeasesCreated || 0), derived.approvalLeasesCreated),
    approvalLeaseHits: Math.max(Number(stored.approvalLeaseHits || 0), derived.approvalLeaseHits),
    approvalLeaseMisses: Math.max(Number(stored.approvalLeaseMisses || 0), derived.approvalLeaseMisses),
    repeatedQuestionsSuppressed: Math.max(Number(stored.repeatedQuestionsSuppressed || 0), derived.repeatedQuestionsSuppressed),
    humanPromptsShown: Math.max(Number(stored.humanPromptsShown || 0), derived.humanPromptsShown)
  };
}

function finiteNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumberOrNull(value) {
  const number = finiteNumberOrNull(value);
  return number !== null && number > 0 ? number : null;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function meanRounded(values = []) {
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function summarizePercentDistribution(values = []) {
  const sorted = (values || [])
    .map((value) => finiteNumberOrNull(value))
    .filter((value) => value !== null)
    .sort((left, right) => left - right);
  return {
    count: sorted.length,
    mean: meanRounded(sorted),
    median: percentile(sorted, 0.5),
    q1: percentile(sorted, 0.25),
    q3: percentile(sorted, 0.75),
    min: sorted.length ? sorted[0] : null,
    max: sorted.length ? sorted[sorted.length - 1] : null
  };
}

function percentile(sortedValues = [], p = 0.5) {
  if (!sortedValues.length) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const index = (sortedValues.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  const weight = index - lower;
  return Math.round((sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight) * 100) / 100;
}

function deltaDirection(deltaTokens) {
  const number = finiteNumberOrNull(deltaTokens);
  if (number === null) return "unmeasured";
  if (number > 0) return "savings";
  if (number < 0) return "overhead";
  return "flat";
}

function formatModes(values = []) {
  const modes = Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)));
  return modes.length ? modes.join(",") : null;
}

function loadPairRunSummaries(root) {
  const experimentsDir = path.join(root, ".scopelease", "experiments");
  if (!fs.existsSync(experimentsDir)) return [];
  const rows = [];
  for (const entry of fs.readdirSync(experimentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const summaryPath = path.join(experimentsDir, entry.name, "summary.json");
    if (!fs.existsSync(summaryPath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
      rows.push({
        runId: parsed.runId || entry.name,
        generatedAt: parsed.generatedAt || "",
        mode: parsed.mode || "",
        taskCount: parsed.taskCount || 0,
        repetitions: parsed.repetitions || 0,
        observationKind: parsed.observationKind || "controlled_prompt_protocol",
        claimScope: parsed.claimScope || "controlled_prompt_protocol_not_live_codex_average",
        baselineModes: uniqueModes((parsed.rows || []).map((row) => row?.baselineMode)),
        defaultInputModes: uniqueModes((parsed.rows || []).map((row) => row?.defaultInputMode)),
        scopeleaseModes: uniqueModes((parsed.rows || []).map((row) => row?.scopeleaseMode)),
        summary: parsed.summary || {},
        commandReportedPairs: extractCommandReportedPairs(parsed),
        outputDir: parsed.outputDir || path.dirname(summaryPath),
        summaryPath
      });
    } catch {}
  }
  rows.sort((left, right) => Date.parse(right.generatedAt || "") - Date.parse(left.generatedAt || ""));
  return rows;
}

function extractCommandReportedPairs(summary = {}) {
  if (summary.claimScope !== "live_observed_agent_visible_pair_not_provider_billing") return [];
  const generatedAt = summary.generatedAt || "";
  return (summary.rows || [])
    .map((row) => {
      const metric = row?.commandReportedTotalTokens || {};
      const defaultTokens = finiteNumberOrNull(metric.defaultTokens);
      const scopeleaseTokens = finiteNumberOrNull(metric.scopeleaseTokens);
      const measured = metric.status === "measured" && defaultTokens !== null && scopeleaseTokens !== null && defaultTokens > 0 && scopeleaseTokens > 0;
      const savedTokens = measured ? defaultTokens - scopeleaseTokens : null;
      const defaultEvent = commandLaneEvent(row, "default-codex");
      const scopeleaseEvent = commandLaneEvent(row, "scopelease-codex");
      const source = String(metric.source || "").trim() || "command_reported_total_tokens";
      const defaultDurationMs = finiteNumberOrNull(defaultEvent?.command?.durationMs);
      const scopeleaseDurationMs = finiteNumberOrNull(scopeleaseEvent?.command?.durationMs);
      const durationMeasured = defaultDurationMs !== null && scopeleaseDurationMs !== null && defaultDurationMs > 0 && scopeleaseDurationMs > 0;
      const savedDurationMs = durationMeasured ? defaultDurationMs - scopeleaseDurationMs : null;
      return {
        status: measured ? "measured" : "incomplete",
        workIntent: row?.workIntent || null,
        pairId: row?.pairId || null,
        runId: summary.runId || null,
        taskId: row?.taskId || null,
        taskType: commandReportedTaskType(row),
        latestTimestamp: generatedAt,
        defaultTokens,
        scopeleaseTokens,
        savedTokens,
        savedPercent: measured ? Math.round((savedTokens / defaultTokens) * 100) : null,
        deltaDirection: deltaDirection(savedTokens),
        canClaimSavings: measured && savedTokens > 0,
        claimScope: measured
          ? "command_reported_total_tokens_same_work_intent_pair"
          : "needs_command_reported_total_tokens_for_both_lanes",
        source,
        sourceBoundary: source,
        pairEvidenceKind: "independent_observed_lanes",
        commandStatus: metric.status || "incomplete",
        taskCompletion: row?.taskCompletion || null,
        commandQuality: summarizeCommandReportedPairQuality(defaultEvent, scopeleaseEvent, row?.taskCompletion || null),
        decisionMetrics: summarizeCommandReportedPairDecisionMetrics(row),
        duration: {
          measured: durationMeasured,
          boundary: "command_wall_time_proxy_not_user_time",
          defaultDurationMs,
          scopeleaseDurationMs,
          savedDurationMs,
          savedPercent: durationMeasured ? Math.round((savedDurationMs / defaultDurationMs) * 100) : null,
          deltaDirection: deltaDirection(savedDurationMs)
        }
      };
    })
    .filter((pair) => pair.status === "measured");
}

function commandLaneEvent(row = {}, lane = "") {
  return (row.events || []).find((event) => String(event?.lane || "") === lane) || null;
}

function summarizeCommandReportedPairQuality(defaultEvent = null, scopeleaseEvent = null, taskCompletion = null) {
  const defaultCommand = defaultEvent?.command || {};
  const scopeleaseCommand = scopeleaseEvent?.command || {};
  const defaultQuality = defaultCommand.quality || {};
  const scopeleaseQuality = scopeleaseCommand.quality || {};
  const defaultScore = finiteNumberOrNull(defaultQuality.score);
  const scopeleaseScore = finiteNumberOrNull(scopeleaseQuality.score);
  const defaultMaxScore = finiteNumberOrNull(defaultQuality.maxScore) || 4;
  const scopeleaseMaxScore = finiteNumberOrNull(scopeleaseQuality.maxScore) || 4;
  const maxTotal = (defaultScore !== null ? defaultMaxScore : 0) + (scopeleaseScore !== null ? scopeleaseMaxScore : 0);
  const scoreTotal = (defaultScore || 0) + (scopeleaseScore || 0);
  const explicitCompletionMeasured = Boolean(taskCompletion?.measured);
  const explicitCompletionPassed = explicitCompletionMeasured && Boolean(taskCompletion?.bothCompleted);
  return {
    boundary: explicitCompletionMeasured
      ? "task_specific_completion_rubric_not_human_grade"
      : "heuristic_command_output_quality_not_human_correctness",
    defaultCommandStatus: defaultCommand.status || "unknown",
    scopeleaseCommandStatus: scopeleaseCommand.status || "unknown",
    bothCommandsPassed: defaultCommand.status === "passed" && scopeleaseCommand.status === "passed",
    defaultQualityStatus: defaultQuality.status || "unknown",
    scopeleaseQualityStatus: scopeleaseQuality.status || "unknown",
    defaultQualityPassed: Boolean(defaultQuality.passed),
    scopeleaseQualityPassed: Boolean(scopeleaseQuality.passed),
    bothHeuristicQualityPassed: Boolean(defaultQuality.passed) && Boolean(scopeleaseQuality.passed),
    scorePercent: maxTotal > 0 ? Math.round((scoreTotal / maxTotal) * 100) : null,
    completionQualityPassed: explicitCompletionMeasured ? explicitCompletionPassed : defaultCommand.status === "passed" &&
      scopeleaseCommand.status === "passed" &&
      maxTotal > 0 &&
      Math.round((scoreTotal / maxTotal) * 100) >= 75,
    explicitCompletionMeasured,
    explicitCompletionPassed,
    defaultMissingSignals: defaultQuality.missingSignals || [],
    scopeleaseMissingSignals: scopeleaseQuality.missingSignals || []
  };
}

function summarizeCommandReportedQuality(pairs = []) {
  const qualities = pairs.map((pair) => pair.commandQuality).filter(Boolean);
  const commandPassed = qualities.filter((quality) => quality.bothCommandsPassed).length;
  const completionPassed = qualities.filter((quality) => quality.completionQualityPassed).length;
  const heuristicPassed = qualities.filter((quality) => quality.bothHeuristicQualityPassed).length;
  const explicitCompletionPairs = qualities.filter((quality) => quality.explicitCompletionMeasured).length;
  const explicitCompletionPassedPairs = qualities.filter((quality) => quality.explicitCompletionPassed).length;
  const scoreValues = qualities
    .map((quality) => finiteNumberOrNull(quality.scorePercent))
    .filter((value) => value !== null);
  return {
    boundary: explicitCompletionPairs
      ? "task_specific_completion_rubric_not_human_grade"
      : "heuristic_command_output_quality_not_human_correctness",
    measuredPairs: qualities.length,
    commandPassedPairs: commandPassed,
    commandPassRate: qualities.length ? Math.round((commandPassed / qualities.length) * 100) : null,
    completionQualityPassedPairs: completionPassed,
    completionQualityPassRate: qualities.length ? Math.round((completionPassed / qualities.length) * 100) : null,
    explicitCompletionPairs,
    explicitCompletionPassedPairs,
    heuristicQualityPassedPairs: heuristicPassed,
    heuristicQualityPassRate: qualities.length ? Math.round((heuristicPassed / qualities.length) * 100) : null,
    averageScorePercent: meanRounded(scoreValues),
    reviewNeededPairs: qualities.length - heuristicPassed,
    missingContextSignalPairs: qualities.filter((quality) =>
      [...(quality.defaultMissingSignals || []), ...(quality.scopeleaseMissingSignals || [])]
        .some((signal) => /missing|context|mcp|cancelled|enoent|no_such/i.test(String(signal || "")))
    ).length
  };
}

function summarizeCommandReportedPairDecisionMetrics(row = {}) {
  const metrics = row?.decisionMetrics || {};
  const defaultDecisionPrompts = finiteNumberOrNull(metrics.defaultDecisionPrompts);
  const scopeleaseDecisionPrompts = finiteNumberOrNull(metrics.scopeleaseDecisionPrompts);
  if (defaultDecisionPrompts === null || scopeleaseDecisionPrompts === null) {
    return {
      measured: false,
      defaultDecisionPrompts: null,
      scopeleaseDecisionPrompts: null,
      reducedDecisionPrompts: null,
      promptSuppressionPercent: null
    };
  }
  const reducedDecisionPrompts = Math.max(0, defaultDecisionPrompts - scopeleaseDecisionPrompts);
  return {
    measured: true,
    defaultDecisionPrompts,
    scopeleaseDecisionPrompts,
    reducedDecisionPrompts,
    promptSuppressionPercent: defaultDecisionPrompts > 0
      ? Math.round((reducedDecisionPrompts / defaultDecisionPrompts) * 100)
      : null
  };
}

function summarizeCommandReportedDecisionProxy(pairs = []) {
  const metrics = pairs
    .map((pair) => pair.decisionMetrics)
    .filter((metric) => metric?.measured);
  const defaultDecisionPrompts = sumTokens(metrics, "defaultDecisionPrompts");
  const scopeleaseDecisionPrompts = sumTokens(metrics, "scopeleaseDecisionPrompts");
  const reducedDecisionPrompts = Math.max(0, defaultDecisionPrompts - scopeleaseDecisionPrompts);
  return {
    boundary: "decision_prompt_proxy_not_psychological_fatigue",
    measuredPairs: metrics.length,
    defaultDecisionPrompts,
    scopeleaseDecisionPrompts,
    reducedDecisionPrompts,
    promptSuppressionPercent: defaultDecisionPrompts > 0
      ? Math.round((reducedDecisionPrompts / defaultDecisionPrompts) * 100)
      : null
  };
}

function summarizeCommandReportedDuration(pairs = []) {
  const durations = pairs
    .map((pair) => pair.duration)
    .filter((duration) => duration?.measured);
  const defaultDurationMs = sumTokens(durations, "defaultDurationMs");
  const scopeleaseDurationMs = sumTokens(durations, "scopeleaseDurationMs");
  const savedDurationMs = durations.length ? defaultDurationMs - scopeleaseDurationMs : null;
  const percents = durations
    .map((duration) => finiteNumberOrNull(duration.savedPercent))
    .filter((value) => value !== null);
  const distribution = summarizePercentDistribution(percents);
  return {
    boundary: "command_wall_time_proxy_not_user_time",
    measuredPairs: durations.length,
    defaultDurationMs,
    scopeleaseDurationMs,
    savedDurationMs,
    savedPercent: durations.length && defaultDurationMs > 0
      ? Math.round((savedDurationMs / defaultDurationMs) * 100)
      : null,
    macroSavedPercent: distribution.mean,
    medianSavedPercent: distribution.median,
    positivePairs: durations.filter((duration) => Number(duration.savedDurationMs || 0) > 0).length,
    overheadPairs: durations.filter((duration) => Number(duration.savedDurationMs || 0) < 0).length,
    distribution
  };
}

function commandReportedTaskType(row = {}) {
  const explicit = String(row?.category || row?.taskType || "").trim();
  if (explicit) return explicit;
  const taskId = String(row?.taskId || "").trim();
  const known = {
    "claim-ready-project-config-review": "devops_config",
    "cli-readme-config-boundary": "devops_config",
    "cli-test-quality-boundary": "test_validation",
    "cli-architecture-entrypoints": "architecture_review",
    "cli-risk-permission-surface": "permission_workflow"
  };
  return known[taskId] || "unclassified";
}

function normalizeRunFilter(options = {}) {
  const runIds = normalizeStringList(options.runId || options["run-id"] || options.runIds || options["run-ids"]);
  const runIdPrefixes = normalizeStringList(
    options.runIdPrefix ||
    options["run-id-prefix"] ||
    options.runIdPrefixes ||
    options["run-id-prefixes"]
  );
  return {
    active: runIds.length > 0 || runIdPrefixes.length > 0,
    runIds,
    runIdPrefixes
  };
}

function normalizeCommandPairSelection(value = "") {
  const text = String(value || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (["all", "all-runs", "all-pairs", "repeat", "repeats", "include-repeats"].includes(text)) return "all";
  return "latest";
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeStringList(item));
  }
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function pairMatchesRunFilter(pair = {}, filter = {}) {
  if (!filter?.active) return true;
  const runId = String(pair.runId || "").trim();
  if (!runId) return false;
  if ((filter.runIds || []).includes(runId)) return true;
  return (filter.runIdPrefixes || []).some((prefix) => runId.startsWith(prefix));
}

function summarizeLatestObservedPair(state = {}) {
  return collectObservedPairs(state)[0] || emptyObservedPair();
}

function collectObservedPairs(state = {}) {
  const actualEvents = (Array.isArray(state.actualWorkEvents) ? state.actualWorkEvents : [])
    .filter((event) => !isControlledProtocolEvent(event))
    .filter((event) => ["default-codex", "scopelease-codex"].includes(actualWorkLane(event)))
    .filter(isObservedInputPayload);
  const contextEvents = (Array.isArray(state.mcpContextEvents) ? state.mcpContextEvents : [])
    .filter((event) => !isControlledProtocolEvent(event))
    .filter((event) => actualWorkLane(event) === "scopelease-codex");
  const groups = new Map();
  for (const event of [...actualEvents, ...contextEvents]) {
    const lane = actualWorkLane(event);
    const contextEvent = event.kind === "scopelease.mcp_context_event" || event.tool === "scopelease_get_context";
    const workIntent = eventWorkIntent(event);
    const pairId = normalizePairId(event.pairId || event.pair_id || event.meta?.pairId || event.meta?.pair_id);
    const runId = normalizeRunId(event.runId || event.meta?.runId);
    const pairRunId = normalizePairRunId(runId);
    const pairScopeKey = pairId ? "paired" : pairRunId || "unscoped";
    const key = [workIntent || "unscoped", pairId || "unpaired", pairScopeKey].join("::");
    const group = groups.get(key) || {
      workIntent,
      pairId,
      runId: pairRunId || "unscoped",
      latestTimestamp: "",
      defaultEvents: [],
      scopeleaseEvents: [],
      contextEvents: [],
      embeddedContextEvents: [],
      taskTypes: [],
      eventCounts: { default: 0, scopeleaseContext: 0, scopeleaseWork: 0 },
      toolCallCounts: { default: 0, scopeleaseWork: 0 },
      toolNames: { default: {}, scopeleaseWork: {} }
    };
    group.latestTimestamp = maxIso(group.latestTimestamp, event.timestamp);
    if (pairId && !group.pairId) group.pairId = pairId;
    const taskType = eventTaskType(event);
    if (taskType && !group.taskTypes.includes(taskType)) group.taskTypes.push(taskType);
    if (contextEvent) {
      group.contextEvents.push(event);
      group.eventCounts.scopeleaseContext += 1;
    } else if (lane === "default-codex") {
      group.defaultEvents.push(event);
      group.eventCounts.default += 1;
      if (isToolCallEvent(event)) {
        group.toolCallCounts.default += 1;
        addToolNameCount(group.toolNames.default, normalizedToolName(event));
      }
    } else if (lane === "scopelease-codex") {
      group.scopeleaseEvents.push(event);
      group.eventCounts.scopeleaseWork += 1;
      if (isToolCallEvent(event)) {
        group.toolCallCounts.scopeleaseWork += 1;
        addToolNameCount(group.toolNames.scopeleaseWork, normalizedToolName(event));
      }
      if (eventHasEmbeddedScopeLeaseContext(event)) {
        group.embeddedContextEvents.push(event);
        group.eventCounts.scopeleaseContext += 1;
      }
    }
    groups.set(key, group);
  }

  const candidates = [...groups.values()].map((group) => {
    const contextTokens = sumTokens(group.contextEvents);
    const embeddedContextTokens = sumEmbeddedScopeLeaseContextTokens(group.embeddedContextEvents);
    const defaultTokens = sumTokens(group.defaultEvents);
    const scopeleaseWorkTokens = sumTokens(group.scopeleaseEvents);
    const scopeleaseTokens = contextTokens + scopeleaseWorkTokens;
    const contextEvidenceCount = group.contextEvents.length + group.embeddedContextEvents.length;
    const measured = defaultTokens > 0 && scopeleaseWorkTokens > 0 && contextEvidenceCount > 0;
    const savedTokens = measured ? defaultTokens - scopeleaseTokens : null;
    const savedPercent = measured ? Math.round((savedTokens / defaultTokens) * 100) : null;
    const defaultToolCalls = group.toolCallCounts.default;
    const scopeleaseToolCalls = group.toolCallCounts.scopeleaseWork;
    const defaultToolCallsMeasured = defaultToolCalls > 0 || group.defaultEvents.some(isToolCallMeasurementCompleteEvent);
    const scopeleaseToolCallsMeasured = scopeleaseToolCalls > 0 || group.scopeleaseEvents.some(isToolCallMeasurementCompleteEvent);
    const toolCallDeltaMeasured = defaultToolCallsMeasured && scopeleaseToolCallsMeasured;
    const savedToolCalls = toolCallDeltaMeasured ? defaultToolCalls - scopeleaseToolCalls : null;
    const pairEvidenceKind = group.defaultEvents.some(isAutoPairBaselineEvent)
      ? "auto_promoted_same_run"
      : "independent_observed_lanes";
    return {
      status: measured ? "measured" : "needs_pair",
      workIntent: group.workIntent || null,
      pairId: group.pairId || null,
      runId: group.runId === "unscoped" ? null : group.runId,
      taskType: group.taskTypes[0] || "unclassified",
      pairEvidenceKind,
      latestTimestamp: group.latestTimestamp,
      defaultTokens: defaultTokens || null,
      scopeleaseTokens: scopeleaseTokens || null,
      savedTokens,
      savedPercent,
      deltaDirection: deltaDirection(savedTokens),
      canClaimSavings: measured && savedTokens > 0,
      claimScope: measured
        ? "actual_observed_same_work_intent_pair"
        : "needs_actual_observed_default_scopelease_and_context_pair",
      observedContextMode: contextTokens > 0
        ? "mcp_context_event"
        : group.embeddedContextEvents.length
          ? "embedded_scopelease_context_prompt"
          : "missing_context_evidence",
      eventCounts: {
        default: group.eventCounts.default,
        scopeleaseContext: group.eventCounts.scopeleaseContext,
        scopeleaseWork: group.eventCounts.scopeleaseWork
      },
      tokenBreakdown: {
        default: defaultTokens,
        scopeleaseContext: contextTokens,
        scopeleaseEmbeddedContext: embeddedContextTokens,
        scopeleaseWork: scopeleaseWorkTokens
      },
      callBreakdown: {
        status: toolCallDeltaMeasured ? "measured" : "needs_both_lane_tool_call_capture",
        defaultToolCalls: defaultToolCallsMeasured ? defaultToolCalls : null,
        scopeleaseToolCalls: scopeleaseToolCallsMeasured ? scopeleaseToolCalls : null,
        savedToolCalls,
        savedToolCallPercent: toolCallDeltaMeasured && defaultToolCalls > 0 ? Math.round((savedToolCalls / defaultToolCalls) * 100) : null,
        defaultTools: group.toolNames.default,
        scopeleaseTools: group.toolNames.scopeleaseWork
      },
      sourceBoundary: contextTokens > 0
        ? "hook_or_mcp_observed_payloads_only"
        : "agent_command_prompt_observed_payloads"
    };
  });
  candidates.sort((left, right) => {
    if ((left.status === "measured") !== (right.status === "measured")) return left.status === "measured" ? -1 : 1;
    return compareIso(right.latestTimestamp, left.latestTimestamp);
  });
  return candidates;
}

function emptyObservedPair() {
  return {
    status: "needs_pair",
    workIntent: null,
    pairId: null,
    runId: null,
    latestTimestamp: "",
    defaultTokens: null,
    scopeleaseTokens: null,
    savedTokens: null,
    savedPercent: null,
    deltaDirection: "unmeasured",
    canClaimSavings: false,
    claimScope: "needs_actual_observed_default_scopelease_and_context_pair",
    eventCounts: { default: 0, scopeleaseContext: 0, scopeleaseWork: 0 },
    callBreakdown: {
      defaultToolCalls: 0,
      scopeleaseToolCalls: 0,
      savedToolCalls: null,
      savedToolCallPercent: null,
      defaultTools: {},
      scopeleaseTools: {}
    },
    taskType: null,
    pairEvidenceKind: null,
    observedContextMode: "missing_context_evidence",
    sourceBoundary: "hook_or_mcp_observed_payloads_only"
  };
}

function normalizeObservedPairScope(value = "") {
  const scope = String(value || "").trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (["all", "all-live", "all-observed"].includes(scope)) return "all_live_observed";
  if (["auto", "auto-promoted", "same-run", "auto-promoted-same-run"].includes(scope)) return "auto_promoted_same_run";
  return "strict_independent_lanes";
}

function normalizeClaimMetric(value = "") {
  const metric = String(value || "").trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (["command", "command-reported", "command-reported-total", "codex-tokens-used", "tokens-used"].includes(metric)) {
    return "command_reported";
  }
  return "agent_visible";
}

function observedPairMatchesScope(pair = {}, scope = "strict_independent_lanes") {
  if (scope === "all_live_observed") return true;
  if (scope === "auto_promoted_same_run") return pair.pairEvidenceKind === "auto_promoted_same_run";
  return pair.pairEvidenceKind === "independent_observed_lanes";
}

function latestObservedPairsByWorkIntent(pairs = []) {
  const groups = new Map();
  for (const pair of pairs || []) {
    const key = [
      pair.repo || "",
      pair.workIntent || pair.pairId || pair.runId || pair.latestTimestamp || "unscoped"
    ].join("::");
    const current = groups.get(key);
    if (!current || compareIso(pair.latestTimestamp, current.latestTimestamp) > 0) {
      groups.set(key, pair);
    }
  }
  return [...groups.values()].sort((left, right) => compareIso(right.latestTimestamp, left.latestTimestamp));
}

function isAutoPairBaselineEvent(event = {}) {
  if (event.autoPairBaseline === true || event.meta?.autoPairBaseline === true) return true;
  const source = String(event.source || event.meta?.source || "").toLowerCase();
  return source.includes("auto-default-baseline");
}

function eventHasEmbeddedScopeLeaseContext(event = {}) {
  return event.scopeleaseContextEmbedded === true || event.meta?.scopeleaseContextEmbedded === true;
}

function sumEmbeddedScopeLeaseContextTokens(events = []) {
  return events.reduce((sum, event) => sum + Number(event.scopeleaseContextTokens || event.meta?.scopeleaseContextTokens || 0), 0);
}

function eventTaskType(event = {}) {
  const taskIntent = event.taskIntent || event.meta?.taskIntent || {};
  return String(taskIntent.taskType || taskIntent.type || "").trim();
}

function isControlledProtocolEvent(event = {}) {
  const source = String(event.source || event.meta?.source || "").toLowerCase();
  return source === "pair-harness" || source.startsWith("pair-harness:") || source.startsWith("live-observed-pair-run:");
}

function isObservedInputPayload(event = {}) {
  const phase = String(event.phase || event.meta?.phase || "").trim().toLowerCase();
  if (!phase) return true;
  return ["input", "prompt", "user-prompt", "user_prompt", "explore", "edit"].includes(phase);
}

function latestTokenBucket(events = [], { preferredRunId = "", anchorTimestamp = "", maxDistanceMs = 60 * 60 * 1000 } = {}) {
  const wantedRunId = normalizeRunId(preferredRunId);
  const buckets = new Map();
  for (const event of events || []) {
    const runId = normalizeRunId(event.runId || event.meta?.runId) || "unscoped";
    const bucket = buckets.get(runId) || { runId, tokens: 0, count: 0, earliestTimestamp: "", latestTimestamp: "" };
    bucket.tokens += Number(event.tokens || 0);
    bucket.count += 1;
    bucket.earliestTimestamp = bucket.earliestTimestamp
      ? (compareIso(event.timestamp, bucket.earliestTimestamp) < 0 ? event.timestamp : bucket.earliestTimestamp)
      : event.timestamp || "";
    bucket.latestTimestamp = maxIso(bucket.latestTimestamp, event.timestamp);
    buckets.set(runId, bucket);
  }
  let rows = [...buckets.values()];
  if (anchorTimestamp) {
    rows = rows.filter((bucket) => bucketWithinWindow(bucket, anchorTimestamp, maxDistanceMs));
  }
  if (wantedRunId && rows.some((bucket) => bucket.runId === wantedRunId)) {
    return rows.find((bucket) => bucket.runId === wantedRunId);
  }
  rows.sort((left, right) => compareIso(right.latestTimestamp, left.latestTimestamp));
  return rows[0] || { runId: "", tokens: 0, count: 0, earliestTimestamp: "", latestTimestamp: "" };
}

function bucketWithinWindow(bucket = {}, anchorTimestamp = "", maxDistanceMs = 0) {
  const anchorTime = Date.parse(anchorTimestamp || "");
  if (!Number.isFinite(anchorTime) || maxDistanceMs <= 0) return true;
  const times = [bucket.earliestTimestamp, bucket.latestTimestamp]
    .map((timestamp) => Date.parse(timestamp || ""))
    .filter(Number.isFinite);
  if (!times.length) return true;
  return times.some((time) => Math.abs(time - anchorTime) <= maxDistanceMs);
}

function eventWorkIntent(event = {}) {
  return String(event.workIntent || event.pairingKey || event.meta?.workIntent || event.requestKey || event.userRequest || "").trim();
}

function normalizePairId(value = "") {
  return String(value || "").trim();
}

function normalizeRunId(value = "") {
  return String(value || "").trim();
}

function normalizePairRunId(value = "") {
  return normalizeRunId(value).replace(/:default-baseline$/, "");
}

function maxIso(left = "", right = "") {
  if (!left) return right || "";
  if (!right) return left || "";
  return compareIso(left, right) >= 0 ? left : right;
}

function compareIso(left = "", right = "") {
  const leftTime = Date.parse(left || "");
  const rightTime = Date.parse(right || "");
  return (Number.isFinite(leftTime) ? leftTime : 0) - (Number.isFinite(rightTime) ? rightTime : 0);
}

function uniqueModes(values = []) {
  return Array.from(new Set(values
    .map((value) => String(value || "").trim())
    .filter(Boolean)));
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function defaultPermissionFixtures() {
  return [
    {
      id: "read_low_risk_readplan",
      request: "Inspect the current readPlan before editing.",
      action: { kind: "read", path: "src/core/repository.js" },
      expected: { verdict: "allow_with_log", humanPrompt: false },
      measures: ["auto_allowed_count"]
    },
    {
      id: "patch_scope_requires_lease",
      request: "Apply the prepared ScopeLease-scoped source patch.",
      action: { type: "patch", files: ["src/runtime/mcp-server.js", "src/core/repository.js"], risk: "medium" },
      expected: { verdict: "ask_once", humanPrompt: true },
      measures: ["human_prompt_count", "approval_lease_miss_count"]
    },
    {
      id: "lease_reuse_inside_scope",
      request: "Apply a second patch inside the approved lease file scope.",
      setup: { approveChoice: "allow_scoped_patch" },
      action: { type: "patch", files: ["src/runtime/mcp-server.js"], risk: "medium" },
      expected: { verdict: "allow_with_log", humanPrompt: false },
      measures: ["approval_lease_hit_count", "repeated_question_suppressed_count"]
    },
    {
      id: "network_denied",
      request: "Fetch an external dependency during an ScopeLease patch.",
      action: { kind: "network", target: "https://example.com" },
      expected: { verdict: "deny", humanPrompt: false },
      measures: ["deny_count"]
    },
    {
      id: "bash_network_command_denied",
      request: "Fetch a remote script through a shell command.",
      action: { kind: "bash", command: "curl https://example.com/install.sh" },
      expected: { verdict: "deny", actionGrant: "network", humanPrompt: false },
      measures: ["deny_count", "network_command_blocked_count"]
    },
    {
      id: "external_write_denied",
      request: "Write generated output outside the repository.",
      action: { kind: "external_write", path: "/tmp/scopelease-output.txt" },
      expected: { verdict: "deny", humanPrompt: false },
      measures: ["deny_count", "external_write_blocked_count"]
    },
    {
      id: "outside_repo_path_denied",
      request: "Apply a patch to a path outside the repository.",
      action: { type: "patch", files: ["../outside.txt"], risk: "medium" },
      expected: { verdict: "deny", humanPrompt: false },
      measures: ["deny_count", "scope_escape_blocked_count"]
    },
    {
      id: "missing_write_path_denied",
      request: "Attempt a write hook without a target file path.",
      action: { kind: "write", content: "missing target path" },
      expected: { verdict: "deny", actionGrant: "apply_patch", humanPrompt: false },
      measures: ["deny_count", "missing_write_path_blocked_count"]
    },
    {
      id: "compound_test_command_requires_review",
      request: "Run a test command with an additional shell control operator.",
      action: { kind: "bash", command: "npm test && echo ok" },
      expected: { verdict: "ask_once", actionGrant: "run_command", humanPrompt: true },
      measures: ["human_prompt_count", "compound_command_review_count"]
    },
    {
      id: "recursive_chmod_denied",
      request: "Recursively loosen repository file permissions.",
      action: { kind: "bash", command: "chmod -R 777 ." },
      expected: { verdict: "deny", actionGrant: "run_command", humanPrompt: false },
      measures: ["deny_count", "destructive_command_blocked_count"]
    },
    {
      id: "lease_reuse_outside_scope_requires_new_approval",
      request: "Try to reuse an existing scoped patch lease for a different file.",
      setup: {
        approveChoice: "allow_scoped_patch",
        action: { type: "patch", files: ["src/runtime/mcp-server.js"], risk: "medium" }
      },
      action: { type: "patch", files: ["src/server.js"], risk: "medium" },
      expected: { verdict: "ask_once", humanPrompt: true, leaseRequired: false },
      measures: ["human_prompt_count", "scope_expansion_review_count"]
    },
    {
      id: "checkpoint_blocked_before_review",
      request: "Checkpoint before the scoped patch has been reviewed.",
      action: { kind: "checkpoint" },
      expected: { verdict: "ask_once", humanPrompt: true },
      measures: ["checkpoint_blocked_count", "human_prompt_count"]
    }
  ];
}

function sumTokens(events = [], field = "tokens") {
  return events.reduce((sum, event) => sum + Number(event?.[field] || 0), 0);
}

function actualWorkLane(event = {}) {
  const value = String(event.lane || event.runLane || event.meta?.lane || event.source || "").toLowerCase().replace(/[_\s]+/g, "-");
  if (value === "scopelease-internal" || value.startsWith("watch:auto")) return "scopelease-internal";
  if (/(default|baseline|without-scopelease|no-scopelease|plain-codex)/.test(value)) return "default-codex";
  if (/(scopelease-codex|with-scopelease|mcp|scopelease)/.test(value)) return "scopelease-codex";
  return "";
}

function isToolCallEvent(event = {}) {
  if (String(event.callType || event.meta?.callType || "").replace(/[_\s-]+/g, "_") === "tool_call") return true;
  const source = String(event.source || event.meta?.source || "");
  if (!/^codex-hook:/i.test(source)) return false;
  return !/^codex-hook:(user-prompt|stop)$/i.test(source);
}

function isToolCallMeasurementCompleteEvent(event = {}) {
  const callType = String(event.callType || event.meta?.callType || "").replace(/[_\s-]+/g, "_");
  return callType === "tool_call_summary" ||
    event.callMeasurementComplete === true ||
    event.meta?.callMeasurementComplete === true;
}

function normalizedToolName(event = {}) {
  const explicit = String(event.toolName || event.tool_name || event.meta?.toolName || event.meta?.tool_name || "").trim();
  if (explicit) return explicit;
  const source = String(event.source || event.meta?.source || "");
  const match = source.match(/^codex-hook:(.+)$/i);
  return match ? match[1] : "tool";
}

function normalizedToolFamily(event = {}) {
  const explicit = String(event.toolFamily || event.tool_family || event.meta?.toolFamily || event.meta?.tool_family || "").trim();
  if (explicit) return explicit;
  const tool = normalizedToolName(event).toLowerCase();
  if (tool === "bash" || tool === "shell") return "shell";
  if (/(apply_patch|edit|write)/.test(tool)) return "write";
  if (/(read|grep|glob|ls|find)/.test(tool)) return "read";
  return "other";
}

function addToolNameCount(target = {}, toolName = "") {
  const key = String(toolName || "tool").trim() || "tool";
  target[key] = Number(target[key] || 0) + 1;
}

function isPreToolEnforcementEvent(event = {}) {
  const source = String(event.source || event.meta?.source || "").toLowerCase();
  return source === "codex-hook:pre-tool-use" ||
    source === "cli:guarded-exec" ||
    source === "cli:enforce";
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

function writeJsonl(filePath, rows = []) {
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
  return filePath;
}

function writeText(filePath, value) {
  fs.writeFileSync(filePath, String(value || ""));
  return filePath;
}

function tableCell(value) {
  if (value == null) return "";
  return String(value).replace(/\t/g, " ").replace(/\r?\n/g, " ");
}

function timestampId() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}
