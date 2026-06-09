import { CODEX_INPUT_FILE, CONTEXT_LEDGER_FILE, DECISION_DIR, RISK_LABEL, RISK_RANK } from "../constants.js";
import { buildMachineFatiguePlan } from "./fatigue-controller.js";
import { buildFrontiers, frontierSummary } from "./frontier.js";
import { graphSchema } from "./identity.js";
import { countTokensForTexts } from "./tokenizer.js";
import { buildDelegationContract } from "./trajectory-schema.js";
import { buildTaskIntent } from "./work-intent.js";

const RISK_TEXT = {
  low: "낮음",
  medium: "중간",
  high: "높음",
  critical: "치명"
};

const ROUTE_TEXT = {
  auto_log: "자동 기록",
  log_only: "감사 기록",
  owner_review: "담당자 리뷰",
  reviewer: "담당자 리뷰",
  human_review: "사람 리뷰",
  senior_review: "결정권자 리뷰",
  approver: "승인권자 승인",
  block: "차단",
  none: "추가 승인 없음"
};

const GATE_TEXT = {
  approval_required: "승인 전 차단",
  senior_review_required: "결정권자 리뷰 필요",
  owner_review_required: "담당자 리뷰 필요",
  auto_log_allowed: "자동 기록 가능",
  log_only: "감사 기록"
};

const SCOPELEASERITY_TEXT = {
  agent: "에이전트",
  audit_log: "감사 로그",
  owner_review: "담당자",
  reviewer: "담당자",
  human_review: "사람 리뷰어",
  senior_review: "결정권자",
  approver: "승인권자",
  block: "차단",
  none: "추가 승인 없음"
};

const AGENT_INPUT_LIMIT_STEPS = [
  { changedFiles: 24, changedSymbols: 48, priorityContext: 18, affectedNodes: 10, evidencePaths: 12, policyHits: 8 },
  { changedFiles: 18, changedSymbols: 28, priorityContext: 16, affectedNodes: 8, evidencePaths: 10, policyHits: 8 },
  { changedFiles: 12, changedSymbols: 16, priorityContext: 12, affectedNodes: 6, evidencePaths: 8, policyHits: 6 }
];

const DEFAULT_USER_REQUEST = "아래 ScopeLease 분석을 기준으로 전역 코드검토를 하고, 필요한 수정은 직접 적용한다.";

export function buildContextPack(analysis, options = {}) {
  const userRequest = normalizeUserRequest(options.userRequest || analysis.userRequest || DEFAULT_USER_REQUEST);
  const changedSymbols = Object.values(analysis.changes?.symbols || {}).flat();
  const artifactLimits = AGENT_INPUT_LIMIT_STEPS[0];
  const compactChangedSymbols = changedSymbols.slice(0, artifactLimits.changedSymbols).map((symbol) => ({
    name: symbol.name,
    type: symbol.type,
    path: symbol.path,
    line: symbol.line
  }));
  const priorityItems = [
    ...((analysis.taskContext || []).map((item) => ({
      type: "task_context",
      path: item.path,
      reason: item.reason || "user request term match",
      hits: item.hits,
      terms: item.terms
    }))),
    ...((analysis.changes?.files || []).map((file) => ({ type: "changed_file", path: file, reason: "changed since baseline" }))),
    ...((analysis.impact?.importedBy || []).map((node) => ({ type: "dependent_file", path: node.path, reason: "imports changed file" }))),
    ...((analysis.impact?.tests || []).map((node) => ({ type: "test", path: node.path, reason: "test edge points to changed file" }))),
    ...((analysis.impact?.docs || []).map((node) => ({ type: "doc", path: node.path, reason: "mentions changed symbol" })))
  ];
  const priorityContext = uniquePriorityItems(priorityItems).slice(0, 24);
  const pathContext = buildPathContext(analysis);
  const decisionGate = buildDecisionGate(analysis);
  const taskIntent = compactTaskIntent(buildTaskIntent({ request: userRequest }, {
    paths: priorityContext.map((item) => item.path).filter(Boolean).slice(0, 8),
    decisionNeeded: decisionGate.canAutoApplyPatch === false,
    riskHypotheses: (analysis.policyHits || []).map((hit) => `${hit.ruleId}:${hit.risk}`)
  }));
  const { agentContext, tokenEconomy: baseTokenEconomy } = buildBudgetedAgentContext(analysis, priorityContext, changedSymbols, pathContext, decisionGate, taskIntent);
  const codexInput = buildCodexInput({
    repo: analysis.repo,
    generatedAt: analysis.generatedAt,
    summary: analysis.summary,
    agentContext,
    tokenEconomy: baseTokenEconomy,
    decisionGate,
    userRequest
  });
  const tokenEconomy = attachCodexInputEconomy(baseTokenEconomy, codexInput);
  const contextLedger = buildActualContextLedger({ codexInput, tokenEconomy });
  const artifacts = buildContextArtifacts(analysis.repo);
  const usefulness = buildUsefulness(analysis, tokenEconomy, decisionGate);
  const visualFrontiers = buildVisualFrontiers(analysis, agentContext, decisionGate);

  return {
    repo: analysis.repo,
    generatedAt: analysis.generatedAt,
    repoStats: analysis.repoStats || {},
    risk: analysis.risk || "low",
    uncertainty: analysis.uncertainty || "low",
    recommendation: analysis.recommendation || "auto_log",
    summary: analysis.summary,
    userRequest: {
      field: "userRequest.text",
      role: "user",
      text: userRequest,
      source: options.userRequest || analysis.userRequest ? "provided" : "default"
    },
    pathContext,
    kgModel: buildKgModel(analysis),
    changedSymbols: compactChangedSymbols,
    changedSymbolsOmitted: Math.max(0, changedSymbols.length - compactChangedSymbols.length),
    affected: compactAffected(analysis.impact, artifactLimits),
    policyHits: analysis.policyHits || [],
    priorityContext,
    agentContext,
    visualFrontiers,
    codexInput,
    contextLedger,
    artifacts,
    tokenEstimate: tokenEconomy.agentContextTokens,
    tokenEconomy,
    decisionGate,
    usefulness
  };
}

export function buildDecisionCardMarkdown(analysis) {
  const lines = [];
  lines.push("# ScopeLease 결정 카드");
  lines.push("");
  lines.push(`- 저장소: ${analysis.repo}`);
  lines.push(`- 생성 시각: ${analysis.generatedAt || new Date().toISOString()}`);
  lines.push(`- 위험도: ${riskText(analysis.risk || RISK_LABEL.low)}`);
  lines.push(`- 불확실성: ${uncertaintyText(analysis.uncertainty || "low")}`);
  lines.push(`- 라우팅: ${routeText(analysis.recommendation || "auto_log")}`);
  lines.push("");
  lines.push("## 핵심 변경");
  lines.push("");
  lines.push(humanSummary(analysis));
  lines.push("");

  appendPathContext(lines, analysis);
  appendKgModel(lines, analysis);
  appendTokenEconomy(lines, analysis);
  appendDecisionGate(lines, analysis);
  appendDecisionBundle(lines, analysis);
  appendUsefulness(lines, analysis);
  appendChangedFiles(lines, analysis);
  appendChangedSymbols(lines, analysis);

  lines.push("## 영향 범위");
  lines.push("");
  appendNodeList(lines, "가져오는 파일", analysis.impact?.imports);
  appendNodeList(lines, "호출하는 파일", analysis.impact?.importedBy);
  appendNodeList(lines, "라우트", analysis.impact?.routes);
  appendNodeList(lines, "테스트", analysis.impact?.tests);
  appendNodeList(lines, "문서", analysis.impact?.docs);
  lines.push("");

  appendPolicyHits(lines, analysis);
  appendEvidencePaths(lines, analysis);
  appendReasons(lines, analysis);
  appendMustReview(lines, analysis);
  return `${lines.join("\n")}\n`;
}

export function buildAgentInputPayload(contextPack = {}, options = {}) {
  const baseEconomy = contextPack.tokenEconomy || {};
  const userRequest = normalizeUserRequest(options.userRequest || contextPack.userRequest?.text || DEFAULT_USER_REQUEST);
  const shouldRebuildCodexInput = Boolean(options.userRequest) || !contextPack.codexInput;
  const codexInput = shouldRebuildCodexInput ? buildCodexInput({
    repo: contextPack.repo,
    generatedAt: contextPack.generatedAt,
    summary: contextPack.summary,
    agentContext: contextPack.agentContext || {},
    tokenEconomy: baseEconomy,
    decisionGate: contextPack.decisionGate || contextPack.agentContext?.decisionGate || {},
    userRequest
  }) : contextPack.codexInput;
  const economy = shouldRebuildCodexInput ? attachCodexInputEconomy(baseEconomy, codexInput) : baseEconomy;
  const contextLedger = buildActualContextLedger({ codexInput, tokenEconomy: economy });
  return {
    kind: "scopelease.agent_input",
    field: codexInput.field || "codexInput.text",
    role: codexInput.role || "user",
    generatedAt: contextPack.generatedAt,
    repo: contextPack.repo,
    summary: codexInput.summary || economy.summary || contextPack.summary || "",
    budgetSummary: economy.budgetSummary || "",
    userRequest: codexInput.userRequest || {
      field: "userRequest.text",
      role: "user",
      text: userRequest
    },
    includedInCodexInput: codexInput.includedSections || [],
    excludedFromCodexInput: codexInput.excludedSections || [],
    codexInput,
    contextLedger,
    artifacts: contextPack.artifacts || buildContextArtifacts(contextPack.repo),
    structuredContext: {
      field: economy.agentInput?.field || "contextPack.agentContext",
      tokens: economy.agentInput?.tokens || economy.agentContextTokens || 0,
      label: economy.agentInput?.label || economy.labels?.agentInput || "0k",
      input: contextPack.agentContext || {}
    },
    tokenEconomy: {
      unit: economy.unit || "tokens",
      labels: economy.labels || {},
      agentInput: economy.agentInput || {},
      actualInput: economy.actualInput || {},
      fullRepoTokens: economy.fullRepoTokens || 0,
      agentContextTokens: economy.agentContextTokens || 0,
      actualInputTokens: economy.actualInputTokens || codexInput.tokens || 0,
      visualGraphTokens: economy.visualGraphTokens || 0,
      storedArtifactTokens: economy.storedArtifactTokens || 0,
      exactTokens: Boolean(economy.exactTokens),
      tokenizer: economy.tokenizer || {},
      userRequestTokens: economy.userRequestTokens || codexInput.userRequest?.tokens || 0,
      fullRepoChars: economy.fullRepoChars || 0,
      agentContextChars: economy.agentContextChars || 0,
      actualInputChars: economy.actualInputChars || codexInput.chars || 0,
      visualGraphChars: economy.visualGraphChars || 0,
      storedArtifactChars: economy.storedArtifactChars || 0,
      repoScopeExcludedChars: economy.repoScopeExcludedChars || 0,
      repoScopeExcludedFromScopeLeaseInputChars: economy.repoScopeExcludedFromScopeLeaseInputChars || 0,
      repoScopeExcludedTokens: economy.repoScopeExcludedTokens || 0,
      repoScopeExcludedFromScopeLeaseInputTokens: economy.repoScopeExcludedFromScopeLeaseInputTokens || 0,
      budget: economy.budget || 0,
      remainingBudgetTokens: economy.remainingBudgetTokens || 0,
      actualRemainingBudgetTokens: economy.actualRemainingBudgetTokens || 0,
      overBudgetTokens: economy.overBudgetTokens || 0,
      actualOverBudgetTokens: economy.actualOverBudgetTokens || 0,
      fitsBudget: Boolean(economy.fitsBudget)
    },
    decisionGate: contextPack.decisionGate || null,
    usefulness: contextPack.usefulness || null,
    readPlan: contextPack.agentContext?.readPlan || codexInput.promptContext?.readPlan || [],
    symbolProbePlan: contextPack.agentContext?.symbolProbePlan || codexInput.promptContext?.symbolProbePlan || [],
    avoidPlan: contextPack.agentContext?.avoidPlan || codexInput.promptContext?.avoidPlan || [],
    traceLedger: contextPack.agentContext?.traceLedger || codexInput.promptContext?.traceLedger || [],
    fatiguePlan: contextPack.agentContext?.fatiguePlan || codexInput.promptContext?.fatiguePlan || null,
    processDelta: contextPack.agentContext?.processDelta || codexInput.promptContext?.processDelta || null,
    outputTrace: contextPack.agentContext?.outputTrace || codexInput.promptContext?.outputTrace || null,
    input: contextPack.agentContext || {}
  };
}

function appendChangedFiles(lines, analysis, limit = 12) {
  const files = analysis.changes?.files || [];
  if (!files.length) return;
  lines.push("## 변경 파일", "");
  for (const file of files.slice(0, limit)) lines.push(`- ${file}`);
  const omitted = Math.max(0, files.length - limit);
  if (omitted) lines.push(`- 생략: ${omitted}개 파일. 전체 목록은 context-pack.json에 보관.`);
  lines.push("");
}

function appendPathContext(lines, analysis) {
  const pathContext = analysis.contextPack?.pathContext;
  if (!pathContext) return;
  lines.push("## 경로 기준", "");
  lines.push(`- 로컬 루트: ${pathContext.root}`);
  lines.push("- 화면과 결정 카드에는 저장소 루트 아래의 상대경로를 표시합니다.");
  lines.push("- 절대경로는 루트 식별에만 쓰고, 검토 대상 파일은 상대경로로 맞춥니다.");
  lines.push("");
}

function appendKgModel(lines, analysis) {
  const model = analysis.contextPack?.kgModel || buildKgModel(analysis);
  lines.push("## 식별 기준", "");
  lines.push(`- 기본 보기: ${model.visibility}`);
  lines.push(`- 기준점: ${model.decisionBasis}`);
  lines.push(`- 노드 식별: ${model.nodeIdentity}`);
  lines.push(`- 관계 식별: ${model.edgeIdentity}`);
  lines.push(`- 권한 판단: ${model.scopeleaserityBasis}`);
  lines.push("");
}

function appendChangedSymbols(lines, analysis, limit = 24) {
  const symbols = Object.values(analysis.changes?.symbols || {}).flat();
  if (!symbols.length) return;
  const grouped = groupSymbolsByPath(symbols);
  let shown = 0;
  lines.push("## 변경 심볼 요약", "");
  for (const group of grouped.slice(0, 8)) {
    lines.push(`- ${group.path}: ${group.items.length}개 심볼 변경`);
    for (const symbol of group.items.slice(0, 3)) {
      if (shown >= limit) break;
      lines.push(`  - ${symbol.name} (${symbolTypeText(symbol.type)}) :${symbol.line}`);
      shown += 1;
    }
    if (shown >= limit) break;
  }
  const omitted = Math.max(0, symbols.length - shown);
  if (omitted) lines.push(`- 생략: ${omitted}개 심볼. 전체 목록은 context-pack.json에 보관.`);
  lines.push("");
}

function groupSymbolsByPath(symbols = []) {
  const groups = new Map();
  for (const symbol of symbols) {
    const path = symbol.path || "unknown";
    const group = groups.get(path) || { path, items: [] };
    group.items.push(symbol);
    groups.set(path, group);
  }
  return [...groups.values()].sort((a, b) => b.items.length - a.items.length || a.path.localeCompare(b.path));
}

function appendPolicyHits(lines, analysis) {
  if (!analysis.policyHits?.length) return;
  lines.push("## 정책 근거", "");
  for (const hit of analysis.policyHits) {
    lines.push(`- ${hit.ruleId}: ${riskText(hit.risk)} 위험, ${routeText(hit.route)} 필요. ${hit.reason || "정책에 매칭됐습니다."}`);
  }
  lines.push("");
}

function appendEvidencePaths(lines, analysis) {
  const paths = analysis.impact?.paths || [];
  if (!paths.length) return;
  lines.push("## 근거 경로", "");
  for (const path of paths.slice(0, 12)) {
    lines.push(`- ${pathKindText(path.kind)}: ${path.summary}`);
  }
  lines.push("");
}

function appendReasons(lines, analysis) {
  if (!analysis.reasons?.length) return;
  lines.push("## 판단 근거", "");
  for (const reason of analysis.reasons) lines.push(`- ${reasonText(reason)}`);
  lines.push("");
}

function appendTokenEconomy(lines, analysis) {
  const economy = analysis.contextPack?.tokenEconomy;
  if (!economy) return;
  lines.push("## 토큰 입력과 실제 pair delta 기준", "");
  lines.push(`- 토큰 계측: ${economy.exactTokens ? `${economy.tokenizer?.method || "tiktoken"}:${economy.tokenizer?.encoding || ""}` : "계측 실패"}`);
  lines.push(`- 사용자 원문: ${economy.labels?.userRequest || formatTokenK(economy.userRequestTokens || 0)}`);
  lines.push(`- Agent 입력 후보: ${economy.labels?.actualInput || formatTokenK(economy.actualInputTokens)} (${economy.actualInput?.field || "codexInput.text"})`);
  lines.push(`- 근거 JSON 구성 요소: ${economy.labels?.agentInput || formatTokenK(economy.agentContextTokens)} (${economy.agentInput?.field || "contextPack.agentContext"})`);
  lines.push("- 실제 pair delta: 같은 work intent의 default-codex 관측 입력 n과 scopelease-codex 관측 입력 m을 pair로 묶은 뒤 `(n - m) / n`으로 계산합니다. 양수일 때만 절감률이고, 음수면 overhead입니다.");
  lines.push(`- 저장소 범위 크기: ${economy.labels?.fullRepo || formatTokenK(economy.fullRepoTokens)}. 절감률 분모가 아니라 검색 공간 크기입니다.`);
  lines.push(`- 예산: ${economy.labels?.budget || formatTokenK(economy.budget)} / ${economy.budgetSummary || (economy.fitsBudget ? "예산 안" : "예산 초과")}`);
  lines.push(`- 화면용 그래프 JSON: ${economy.labels?.visualGraph || formatTokenK(economy.visualGraphTokens)}. Agent 입력 후보에는 넣지 않습니다.`);
  if (economy.summary) lines.push(`- 요약: ${economy.summary}`);
  lines.push("");
}

function appendDecisionGate(lines, analysis) {
  const gate = analysis.contextPack?.decisionGate;
  if (!gate) return;
  lines.push("## 결정 게이트", "");
  lines.push(`- 상태: ${gate.statusLabel || gateText(gate.status)}`);
  lines.push(`- 권한: ${gate.scopeleaserityLabel || scopeleaserityText(gate.scopeleaserity)}`);
  lines.push(`- 자동화: ${gate.automationLabel || automationText(gate)}`);
  lines.push(`- 다음 행동: ${gate.nextAction || nextActionText(gate, analysis)}`);
  if (gate.summary) lines.push(`- 설명: ${gate.summary}`);
  if (gate.scopeleaseritySummary) lines.push(`- 권한 해석: ${gate.scopeleaseritySummary}`);
  if (gate.checkpointRule) lines.push(`- 기준점 갱신: ${gate.checkpointRule}`);
  for (const check of gate.requiredChecks) lines.push(`- 확인 필요: ${check}`);
  for (const action of gate.allowedActions) lines.push(`- 허용: ${action}`);
  for (const action of gate.blockedActions) lines.push(`- 차단: ${action}`);
  for (const action of gate.correctionActions) lines.push(`- 정리: ${action}`);
  lines.push("");
}

function appendDecisionBundle(lines, analysis) {
  const bundle = analysis.contextPack?.agentContext?.fatiguePlan?.decisionBundle;
  if (!bundle) return;
  lines.push("## Decision Packet", "");
  lines.push(`- 결론: ${analysis.contextPack?.decisionGate?.statusLabel || gateText(analysis.contextPack?.decisionGate?.status)}`);
  lines.push(`- 기본 선택: ${bundle.defaultVerdict}`);
  lines.push(`- 질문: ${bundle.question}`);
  lines.push("- 선택지:");
  for (const choice of bundle.choices || []) {
    lines.push(`  - ${choice.id}: ${choice.label}`);
  }
  if (bundle.scope?.files?.length) {
    lines.push(`- 파일 범위: ${bundle.scope.files.slice(0, 8).join(", ")}${bundle.scope.files.length > 8 ? ` 외 ${bundle.scope.files.length - 8}개` : ""}`);
  }
  if (bundle.scope?.commands?.length) lines.push(`- 명령 범위: ${bundle.scope.commands.join(", ")}`);
  if (bundle.stopWhen?.length) {
    lines.push("- 멈출 조건:");
    for (const item of bundle.stopWhen.slice(0, 8)) lines.push(`  - ${item}`);
  }
  lines.push("");
}

function appendUsefulness(lines, analysis) {
  const usefulness = analysis.contextPack?.usefulness;
  if (!usefulness) return;
  lines.push("## 쓸 이유 판정", "");
  lines.push(`- 판정: ${usefulness.label || usefulness.verdict}`);
  if (usefulness.headline) lines.push(`- 결론: ${usefulness.headline}`);
  for (const reason of usefulness.reasons) lines.push(`- ${reason}`);
  for (const benefit of usefulness.benefits || []) lines.push(`- 이득: ${benefit}`);
  for (const limit of usefulness.limits || []) lines.push(`- 제한: ${limit}`);
  if (usefulness.nextStep) lines.push(`- 다음: ${usefulness.nextStep}`);
  lines.push("");
}

function appendMustReview(lines, analysis) {
  lines.push("## 사람이 꼭 볼 부분", "");
  const priority = analysis.contextPack?.priorityContext || [];
  if (priority.length) {
    for (const item of priority.slice(0, 10)) lines.push(`- ${item.path}: ${priorityReasonText(item.reason)}`);
  } else {
    lines.push("- 지금 기준으로 따로 짚어야 할 리뷰 포인트는 없습니다.");
  }
  lines.push("");
}

function appendNodeList(lines, label, nodes = []) {
  if (!nodes.length) return;
  lines.push(`### ${label}`);
  for (const node of nodes) {
    lines.push(`- ${node.label || node.path}${node.path ? ` (${node.path}${node.line ? `:${node.line}` : ""})` : ""}`);
  }
}

function uniquePriorityItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.type}:${item.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildPathContext(analysis) {
  return {
    root: analysis.repo,
    filePathMode: "repo_relative",
    graphPathMode: "repo_relative",
    rule: "절대경로는 저장소 루트 식별에만 쓰고, 파일과 그래프 노드는 저장소 상대경로로 표시합니다."
  };
}

function buildBudgetedAgentContext(analysis, priorityContext, changedSymbols, pathContext, decisionGate, taskIntent) {
  let bestAgentContext = null;
  let bestTokenEconomy = null;

  for (const limits of AGENT_INPUT_LIMIT_STEPS) {
    const candidate = buildAgentContext(analysis, priorityContext, changedSymbols, pathContext, decisionGate, taskIntent, limits);
    const economy = buildTokenEconomy(analysis, candidate);
    if (!bestTokenEconomy || economy.agentContextTokens < bestTokenEconomy.agentContextTokens) {
      bestAgentContext = candidate;
      bestTokenEconomy = economy;
    }
    if (economy.fitsBudget) return { agentContext: candidate, tokenEconomy: economy };
  }

  return { agentContext: bestAgentContext, tokenEconomy: bestTokenEconomy };
}

function buildAgentContext(analysis, priorityContext, changedSymbols, pathContext, decisionGate, taskIntent = {}, limits = AGENT_INPUT_LIMIT_STEPS[0]) {
  const changedFiles = analysis.changes?.files || [];
  const policyHits = analysis.policyHits || [];
  const limitedChangedFiles = changedFiles.slice(0, limits.changedFiles);
  const limitedChangedSymbols = changedSymbols.slice(0, limits.changedSymbols);
  const limitedPriorityContext = priorityContext.slice(0, limits.priorityContext);
  const limitedPolicyHits = policyHits.slice(0, limits.policyHits);
  const affected = compactAffected(analysis.impact, limits);
  const readPlan = buildReadPlan({
    analysis,
    priorityContext: limitedPriorityContext,
    changedSymbols: limitedChangedSymbols,
    policyHits: limitedPolicyHits,
    affected
  });
  const symbolProbePlan = buildSymbolProbePlan({ changedSymbols: limitedChangedSymbols, affected, readPlan });
  const frontiers = buildFrontiers({
    analysis,
    readPlan,
    symbolProbePlan,
    policyHits: limitedPolicyHits,
    affected,
    decisionGate
  });
  const agentContract = buildDelegationContract({ analysis, taskSpec: taskIntent, frontiers, decisionGate });
  const graphQueryHints = buildGraphQueryHints({ readPlan, symbolProbePlan, frontiers });
  const avoidPlan = buildAvoidPlan(limits);
  const traceLedger = buildTraceLedger({ analysis, readPlan, avoidPlan, decisionGate, symbolProbePlan, frontiers, graphQueryHints });
  const outputTrace = buildOutputTrace({ analysis, policyHits: limitedPolicyHits, affected, symbolProbePlan, frontiers, graphQueryHints });
  const fatiguePlan = buildFatiguePlan({ analysis, decisionGate, readPlan, policyHits: limitedPolicyHits, affected, taskIntent, frontiers });
  const processDelta = buildProcessDelta({
    analysis,
    affected,
    readPlan,
    outputTrace,
    traceLedger,
    fatiguePlan,
    limitedChangedFiles,
    limitedChangedSymbols,
    limitedPolicyHits,
    decisionGate
  });
  const agentFrontiers = compactFrontiersForAgent(frontiers);
  const omitted = {
    changedFiles: Math.max(0, changedFiles.length - limitedChangedFiles.length),
    changedSymbols: Math.max(0, changedSymbols.length - limitedChangedSymbols.length),
    priorityContext: Math.max(0, priorityContext.length - limitedPriorityContext.length),
    policyHits: Math.max(0, policyHits.length - limitedPolicyHits.length),
    readPlan: Math.max(0, limitedPriorityContext.length + limitedChangedSymbols.length + limitedPolicyHits.length - readPlan.length)
  };

  return {
    summary: humanSummary(analysis),
    risk: analysis.risk,
    riskLabel: riskText(analysis.risk),
    uncertainty: analysis.uncertainty,
    uncertaintyLabel: uncertaintyText(analysis.uncertainty),
    recommendation: analysis.recommendation,
    recommendationLabel: routeText(analysis.recommendation),
    taskIntent,
    pathContext,
    kgModel: buildKgModel(analysis),
    decisionGate: compactDecisionGate(decisionGate),
    inputPlan: {
      field: "contextPack.agentContext",
      purpose: "에이전트가 전체 저장소를 먼저 훑지 않고 바로 판단할 수 있게 만든 입력입니다.",
      included: [
        "판단 요약",
        "권한 게이트",
        "우선순위 파일",
        "변경 심볼 일부",
        "심볼 grep probe",
        "정책과 근거 경로"
      ],
      excluded: [
        "전체 파일 본문",
        "화면용 graph JSON",
        "우선순위 밖의 긴 심볼 목록"
      ],
      readOrder: [
        "agentContract",
        "graphQueryHints",
        "taskIntent",
        "decisionGate",
        "readPlan",
        "symbolProbePlan",
        "frontiers.symbolFrontier",
        "frontiers.reviewFrontier",
        "frontiers.permissionFrontier",
        "fatiguePlan.autonomyPlan",
        "policyHits",
        "outputTrace",
        "changedSymbols"
      ],
      limits,
      omitted
    },
    changedFiles: limitedChangedFiles,
    changedSymbols: limitedChangedSymbols.map((symbol) => ({
      name: symbol.name,
      type: symbol.type,
      path: symbol.path,
      line: symbol.line
    })),
    affected,
    policyHits: limitedPolicyHits.map((hit) => ({
      ruleId: hit.ruleId,
      risk: hit.risk,
      route: hit.route,
      reason: hit.reason
    })),
    priorityContext: limitedPriorityContext,
    readPlan,
    symbolProbePlan,
    graphQueryHints,
    frontiers: agentFrontiers,
    agentContract,
    avoidPlan,
    traceLedger,
    fatiguePlan,
    processDelta,
    outputTrace,
    frontierSummary: frontierSummary(frontiers),
    reasons: analysis.reasons || []
  };
}

function buildVisualFrontiers(analysis, agentContext = {}, decisionGate = {}) {
  const frontiers = buildFrontiers({
    analysis,
    readPlan: agentContext.readPlan || [],
    symbolProbePlan: agentContext.symbolProbePlan || [],
    policyHits: agentContext.policyHits || [],
    affected: agentContext.affected || {},
    decisionGate
  });
  return compactFrontiersForVisual(frontiers);
}

function buildReadPlan({ analysis, priorityContext = [], changedSymbols = [], policyHits = [], affected = {} }) {
  const items = [];

  for (const hit of policyHits) {
    if (!requiresHumanPolicyReview(hit)) continue;
    for (const file of hit.files || []) {
      items.push({
        phase: "scopeleaserity",
        path: file,
        reason: `${hit.ruleId}: 사람이 결정해야 하는 변경`,
        action: "권한 영향과 적용 범위를 먼저 확인"
      });
    }
  }

  for (const item of priorityContext) {
    if (!item.path) continue;
    items.push({
      phase: "inspect",
      path: item.path,
      reason: priorityReasonText(item.reason),
      action: "변경 의도와 주변 호출 확인",
      priority: Number(item.hits || 0)
    });
  }

  for (const symbol of changedSymbols) {
    if (!symbol.path) continue;
    items.push({
      phase: "symbol",
      path: symbol.path,
      line: symbol.line,
      symbol: symbol.name,
      reason: `${symbolTypeText(symbol.type)} 변경`,
      action: "해당 심볼 정의와 직접 호출부만 확인"
    });
  }

  for (const path of affected.paths || []) {
    items.push({
      phase: "trace",
      path: firstPathFromSummary(path.summary),
      reason: pathKindText(path.kind),
      action: path.summary
    });
  }

  const changedSet = new Set(analysis.changes?.files || []);
  return dedupePlanItems(items)
    .sort((a, b) =>
      Number(changedSet.has(b.path)) - Number(changedSet.has(a.path)) ||
      phaseRank(a.phase) - phaseRank(b.phase) ||
      Number(b.priority || 0) - Number(a.priority || 0) ||
      String(a.path || "").localeCompare(String(b.path || ""))
    )
    .slice(0, 18);
}

function buildSymbolProbePlan({ changedSymbols = [], affected = {}, readPlan = [] }) {
  const supportPaths = uniqueStrings([
    ...(readPlan || []).map((item) => item.path),
    ...(affected.importedBy || []).map((item) => item.path),
    ...(affected.imports || []).map((item) => item.path),
    ...(affected.tests || []).map((item) => item.path),
    ...(affected.docs || []).map((item) => item.path)
  ]).slice(0, 12);
  return dedupePlanItems((changedSymbols || [])
    .filter((symbol) => symbol?.name && symbol?.path)
    .slice(0, 12)
    .map((symbol) => {
      const paths = uniqueStrings(supportPaths.filter((item) => item !== symbol.path)).slice(0, 3);
      return {
        path: symbol.path,
        symbol: symbol.name,
        query: `\\b${escapeRegExp(symbol.name)}\\b`,
        paths
      };
    }))
    .slice(0, 12);
}

function buildAvoidPlan(limits = {}) {
  return [
    { target: "full file bodies", reason: "readPlan에 있는 파일만 필요할 때 열고, 전체 파일 본문을 input에 넣지 않음" },
    { target: "analysis.knowledgeGraph JSON", reason: "화면용 그래프 데이터라 Codex 작업 input에서는 제외" },
    { target: "browser window state", reason: "현재 창 배치와 UI 상태는 탐색/수정 근거가 아님" },
    { target: "local telemetry/history", reason: "사용자가 요청하지 않은 활동 기록은 읽거나 전달하지 않음" },
    { target: "omitted low priority symbols", reason: `심볼/경로는 예산 안에서 상위 ${limits.changedSymbols || 0}개 중심으로 제한` }
  ];
}

function buildTraceLedger({ analysis, readPlan, avoidPlan, decisionGate, symbolProbePlan = [], frontiers = {}, graphQueryHints = {} }) {
  return [
    { step: "input", keep: "userRequest.text + compact ScopeLease context", drop: avoidPlan.map((item) => item.target).slice(0, 4) },
    { step: "graph_query_first", keep: (graphQueryHints.hints || []).slice(0, 4).map(formatGraphHint), drop: "광범위한 grep/read는 frontier 근거가 부족할 때만 사용" },
    { step: "read", keep: readPlan.slice(0, 10).map(formatReadPlanRef), drop: "readPlan 밖 파일은 필요할 때만 추가 확인" },
    { step: "probe", keep: symbolProbePlan.slice(0, 8).map(formatProbePlanRef), drop: "심볼 단위 grep 결과로 충분한 경우 전체 파일 탐색 반복" },
    { step: "symbol_frontier", keep: (frontiers.symbolFrontier?.items || []).slice(0, 8).map(formatFrontierRef), drop: "심볼 경계 밖 정의/호출부는 필요할 때만 확대" },
    { step: "review_frontier", keep: (frontiers.reviewFrontier?.items || []).slice(0, 8).map(formatFrontierRef), drop: "검토 경계 밖 diff는 근거가 생길 때만 확대" },
    { step: "permission_frontier", keep: (frontiers.permissionFrontier?.items || []).slice(0, 8).map(formatFrontierRef), drop: "lease graph scope 밖 action은 실행 전 ask/deny" },
    { step: "edit", keep: (analysis.changes?.files || []).slice(0, 12), drop: "권한 확인 전 자동 적용/체크포인트" },
    { step: "verify", keep: evidenceSummaryItems(analysis), drop: "근거 없는 확정 표현" },
    { step: "output", keep: "수정/판단 결과는 readPlan, policyHits, evidencePaths로 역추적", scopeleaserity: decisionGate?.scopeleaserityLabel || scopeleaserityText(decisionGate?.scopeleaserity) }
  ];
}

function buildOutputTrace({ analysis, policyHits = [], affected = {}, symbolProbePlan = [], frontiers = {}, graphQueryHints = {} }) {
  return compactObject({
    mustReference: [
      "agentContract",
      "graphQueryHints",
      "readPlan",
      "symbolProbePlan",
      "frontiers.symbolFrontier",
      "frontiers.reviewFrontier",
      "frontiers.permissionFrontier",
      "policyHits",
      "affected.paths",
      "changedFiles"
    ],
    changedFiles: (analysis.changes?.files || []).slice(0, 12),
    policyHits: policyHits.map((hit) => ({
      ruleId: hit.ruleId,
      route: routeText(hit.route),
      files: (hit.files || []).slice(0, 6)
    })),
    evidencePaths: (affected.paths || []).slice(0, 8),
    symbolProbes: symbolProbePlan.slice(0, 8).map((item) => ({
      symbol: item.symbol,
      query: item.query,
      paths: item.paths
    })),
    graphQueryHints: (graphQueryHints.hints || []).slice(0, 6),
    tests: affected.tests,
    docs: affected.docs,
    reviewFrontier: {
      size: frontiers.reviewFrontier?.size,
      hash: frontiers.reviewFrontier?.hash
    },
    symbolFrontier: {
      size: frontiers.symbolFrontier?.size,
      hash: frontiers.symbolFrontier?.hash
    },
    permissionFrontier: {
      size: frontiers.permissionFrontier?.size,
      hash: frontiers.permissionFrontier?.hash
    },
    stopFrontier: {
      size: frontiers.stopFrontier?.size,
      hash: frontiers.stopFrontier?.hash
    }
  });
}

function buildGraphQueryHints({ readPlan = [], symbolProbePlan = [], frontiers = {} } = {}) {
  const symbolItems = (frontiers.symbolFrontier?.items || [])
    .filter((item) => item?.symbol && item?.path)
    .slice(0, 8);
  const reviewItems = (frontiers.reviewFrontier?.items || [])
    .filter((item) => item?.path)
    .slice(0, 6);
  const readPaths = uniqueStrings(readPlan.map((item) => item.path).filter(Boolean)).slice(0, 8);
  const hints = [
    symbolItems.length ? {
      id: "symbol-frontier-first",
      query: "frontiers.symbolFrontier.items",
      use: "check listed symbol definitions and direct callers before broad file search",
      symbols: symbolItems.map((item) => ({
        path: item.path,
        symbol: item.symbol,
        line: item.line
      }))
    } : null,
    readPaths.length ? {
      id: "read-plan-files",
      query: "readPlan.path",
      use: "open these files before repository-wide grep",
      paths: readPaths
    } : null,
    symbolProbePlan.length ? {
      id: "symbol-probe-queries",
      query: "symbolProbePlan.query",
      use: "run targeted symbol grep only in listed support paths first",
      probes: symbolProbePlan.slice(0, 8).map((item) => ({
        symbol: item.symbol,
        query: item.query,
        paths: item.paths
      }))
    } : null,
    reviewItems.length ? {
      id: "review-frontier-check",
      query: "frontiers.reviewFrontier.items",
      use: "use review frontier as the human-facing evidence boundary",
      paths: uniqueStrings(reviewItems.map((item) => item.path).filter(Boolean)).slice(0, 8)
    } : null
  ].filter(Boolean);
  return compactObject({
    kind: "scopelease.graph_query_first_hints",
    mode: "graph_query_first_then_targeted_read",
    hints,
    fallback: "If these graph/frontier hints do not cover the requested evidence, expand with the smallest targeted rg/read scope.",
    boundary: "hints_for_agent_navigation_not_full_graph_payload"
  });
}

function buildFatiguePlan({ analysis, decisionGate, readPlan = [], policyHits = [], affected = {}, taskIntent = {}, frontiers = {} }) {
  return compactObject(buildMachineFatiguePlan({ analysis, decisionGate, readPlan, policyHits, affected, taskIntent, frontiers }));
}

function compactTaskIntent(intent = {}) {
  return compactObject({
    kind: intent.kind,
    taskType: intent.taskType,
    objective: String(intent.objective || "").slice(0, 220),
    targetArtifacts: (intent.targetArtifacts || []).slice(0, 4),
    nonGoals: (intent.nonGoals || []).slice(0, 3),
    decisionNeeded: intent.decisionNeeded,
    riskHypotheses: (intent.riskHypotheses || []).slice(0, 2),
    permissionNeed: compactPermissionNeed(intent.permissionNeed || {}),
    successCriteria: (intent.successCriteria || []).slice(0, 4),
    pairing: intent.pairing,
    confidence: intent.confidence
  });
}

function compactPermissionNeed(value = {}) {
  return compactObject({
    read: value.read,
    proposePatch: value.proposePatch,
    applyPatch: value.applyPatch,
    runTests: value.runTests,
    humanApprovalBeforeApply: value.humanApprovalBeforeApply
  });
}

function buildProcessDelta({
  analysis,
  affected = {},
  readPlan = [],
  outputTrace = {},
  traceLedger = [],
  fatiguePlan = {},
  limitedChangedFiles = [],
  limitedChangedSymbols = [],
  limitedPolicyHits = [],
  decisionGate = {}
}) {
  const encoding = analysis.repoStats?.tokenizer?.encoding;
  const allChangedSymbols = Object.values(analysis.changes?.symbols || {}).flat();
  const graphForUi = analysis.knowledgeGraph || analysis.graph || { nodes: [], edges: [] };
  const baselineEdit = {
    changedFiles: analysis.changes?.files || [],
    changedSymbols: allChangedSymbols,
    policyHits: analysis.policyHits || []
  };
  const compactEdit = {
    changedFiles: limitedChangedFiles,
    changedSymbols: limitedChangedSymbols.map((symbol) => ({
      name: symbol.name,
      type: symbol.type,
      path: symbol.path,
      line: symbol.line
    })),
    policyHits: limitedPolicyHits.map((hit) => ({
      ruleId: hit.ruleId,
      risk: hit.risk,
      route: hit.route,
      files: (hit.files || []).slice(0, 6)
    })),
    stopWhen: fatiguePlan.stopWhen
  };
  const baselineResultTrace = {
    impact: analysis.impact || {},
    policyHits: analysis.policyHits || [],
    graphSchema: analysis.knowledgeGraph?.schema || {}
  };
  const compactResultTrace = { outputTrace, traceLedger };
  const baselineExploreTokens = Math.max(
    analysis.repoStats?.fullContextTokens || 0,
    countTokensForTexts([JSON.stringify(graphForUi)], { encoding }).counts[0] || 0
  );
  const tokenResult = countTokensForTexts([
    JSON.stringify({ readPlan, affectedPaths: affected.paths || [], policyHits: limitedPolicyHits }),
    JSON.stringify(baselineEdit),
    JSON.stringify(compactEdit),
    JSON.stringify(baselineResultTrace),
    JSON.stringify(compactResultTrace)
  ], { encoding });
  const [compactExploreTokens, baselineEditTokens, compactEditTokens, baselineResultTraceTokens, compactResultTraceTokens] = tokenResult.counts;
  const totalBaselineTokens = baselineExploreTokens + (baselineEditTokens || 0) + (baselineResultTraceTokens || 0);
  const totalKeptTokens = (compactExploreTokens || 0) + (compactEditTokens || 0) + (compactResultTraceTokens || 0);
  const baselineQuestions =
    (analysis.changes?.files || []).length +
    (analysis.policyHits || []).length +
    (decisionGate.requiredChecks || []).length +
    (decisionGate.blockedActions || []).length;
  const keptQuestions = Math.max(1, (fatiguePlan.askOnce || []).length);

  return {
    measured: "input payload",
    proxyMeasured: "explore, edit, total token plan payload",
    notMeasured: "탐색/수정/총 토큰의 coding-agent 런타임 토큰은 아직 직접 관측하지 않습니다. 아래 단계값은 계획 payload 프록시이며 provider 사용량과 구분합니다.",
    stages: [
      stageDeltaItem({
        stage: "input",
        label: "입력 구성",
        baselineTokens: 0,
        keptTokens: null,
        measurement: "paired_observation_required",
        basis: "pair delta baseline은 전체 저장소가 아니라 같은 work intent에서 ScopeLease 없이 실제 들어간 default-codex 입력 n입니다. Agent 입력 후보 payload는 contextDelta에서 최종 계산합니다. 양수 delta만 절감률입니다."
      }),
      stageDeltaItem({
        stage: "explore",
        label: "탐색",
        baselineTokens: baselineExploreTokens,
        keptTokens: compactExploreTokens || 0,
        measurement: "proxy",
        basis: "전체 저장소/KG를 모두 펼치지 않고 readPlan, affected paths, policy hits만 먼저 봅니다."
      }),
      stageDeltaItem({
        stage: "edit",
        label: "수정 범위",
        baselineTokens: baselineEditTokens || 0,
        keptTokens: compactEditTokens || 0,
        measurement: "proxy",
        basis: "전체 변경 메타와 심볼 대신 제한된 changed files, changed symbols, stop condition만 둡니다."
      }),
      stageDeltaItem({
        stage: "output",
        label: "결론",
        baselineTokens: baselineResultTraceTokens || 0,
        keptTokens: compactResultTraceTokens || 0,
        measurement: "proxy",
        basis: "전체 impact, policy, KG schema를 다시 펼치지 않고 outputTrace와 traceLedger만 결론 근거로 둡니다."
      }),
      stageDeltaItem({
        stage: "total_tokens",
        label: "총 토큰",
        baselineTokens: totalBaselineTokens,
        keptTokens: totalKeptTokens,
        measurement: "proxy",
        basis: "탐색, 수정 범위, 결과 추적 근거를 합산한 총 토큰 프록시입니다. 실제 런타임/provider 사용량은 직접 계측 전까지 구분해서 봅니다."
      })
    ],
    decisionQuestions: {
      baseline: baselineQuestions,
      kept: keptQuestions,
      reduced: Math.max(0, baselineQuestions - keptQuestions),
      basis: "파일별 반복 승인 대신 한 번 묶어 물을 질문 수로 줄입니다."
    },
    completion: [
      { item: "input_rebuilt", ok: true, evidence: "userRequest.text 기준으로 codexInput.text 재생성" },
      { item: "explore_bounded", ok: readPlan.length > 0, evidence: `${readPlan.length} readPlan paths` },
      { item: "edit_scope_bounded", ok: limitedChangedFiles.length > 0 || limitedChangedSymbols.length > 0, evidence: `${limitedChangedFiles.length} files, ${limitedChangedSymbols.length} symbols` },
      { item: "total_token_trace_ready", ok: Boolean(outputTrace?.mustReference?.length), evidence: "outputTrace.mustReference" },
      { item: "fatigue_plan_ready", ok: Boolean(fatiguePlan?.askOnce?.length), evidence: "askOnce/agentShouldDo/doNotAsk/stopWhen" }
    ]
  };
}

function stageDeltaItem({ stage, label, baselineTokens = 0, keptTokens = 0, basis = "", measurement = "proxy" }) {
  const hasKept = keptTokens !== null && keptTokens !== undefined;
  const baseline = Number(baselineTokens || 0);
  const kept = hasKept ? Number(keptTokens || 0) : null;
  const candidateReduction = hasKept ? Math.max(0, baseline - kept) : null;
  const candidateReductionPercent = hasKept && baseline ? Math.round((candidateReduction / baseline) * 100) : null;
  return compactObject({
    stage,
    label,
    baseline: formatTokenK(baseline),
    kept: hasKept ? formatTokenK(kept) : "contextDelta 참조",
    candidateReduction: hasKept ? formatTokenK(candidateReduction) : "contextDelta 참조",
    baselineTokens: baseline,
    keptTokens: hasKept ? kept : null,
    candidateReductionTokens: hasKept ? candidateReduction : null,
    candidateReductionPercent,
    measurement,
    basis
  });
}

function firstPathFromSummary(summary = "") {
  const text = String(summary || "");
  const codePath = text.match(/`([^`]+\.[A-Za-z0-9]+(?::\d+)?)`/);
  const inlinePath = text.match(/\b([A-Za-z0-9_.@-]+\/[^\s,()]+(?:\.[A-Za-z0-9]+)?(?::\d+)?)\b/);
  const value = codePath?.[1] || inlinePath?.[1] || "";
  return value.replace(/[.,;:]$/, "");
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function escapeRegExp(value = "") {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dedupePlanItems(items = []) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!item?.path) continue;
    const key = `${item.phase || "read"}:${item.path}:${item.line || ""}:${item.symbol || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function phaseRank(phase) {
  return {
    scopeleaserity: 0,
    inspect: 1,
    symbol: 2,
    trace: 3
  }[phase] ?? 9;
}

function formatReadPlanRef(item = {}) {
  const line = item.line ? `:${item.line}` : "";
  const symbol = item.symbol ? `#${item.symbol}` : "";
  return `${item.path || "-"}${line}${symbol}`;
}

function formatProbePlanRef(item = {}) {
  return `${item.symbol || item.query || "-"} in ${(item.paths || [item.path]).filter(Boolean).slice(0, 3).join(", ")}`;
}

function formatGraphHint(item = {}) {
  const count = (item.symbols || item.paths || item.probes || []).length;
  return `${item.id || item.query || "hint"}${count ? `:${count}` : ""}`;
}

function formatFrontierRef(item = {}) {
  return item.path || item.symbol || item.label || item.id || "-";
}

function evidenceSummaryItems(analysis) {
  const impact = analysis.impact || {};
  const items = [];
  if (impact.tests?.length) items.push(`${impact.tests.length} test path(s)`);
  if (impact.docs?.length) items.push(`${impact.docs.length} doc path(s)`);
  if (impact.routes?.length) items.push(`${impact.routes.length} route path(s)`);
  if (analysis.policyHits?.length) items.push(`${analysis.policyHits.length} policy hit(s)`);
  return items.length ? items : ["changed files and generated ScopeLease context"];
}

function buildKgModel(analysis) {
  const schema = graphSchema();
  return {
    schema: schema.version,
    visibility: "기본 화면은 저장소 전체 그래프이고, 결정 중심 보기는 필터로 좁혀 봅니다.",
    decisionBasis: "변경 파일과 심볼, 정책 적중, 테스트/문서/호출 근거 경로를 함께 봅니다.",
    nodeIdentity: "저장소 상대경로, 심볼 ID, 노드 타입을 조합해 같은 대상을 식별합니다.",
    edgeIdentity: "관계 방향, 출처, 신뢰도를 함께 남겨 왜 연결됐는지 확인할 수 있게 합니다.",
    scopeleaserityBasis: "위험도, 불확실성, 정책 적중, 테스트 근거를 기준으로 자동 적용/리뷰/승인 권한을 나눕니다.",
    memoryAlignment: "OpenMemory식 project scope, Cognee식 dataset/node-set/provenance, CPG식 typed attributed nodes"
  };
}

function buildTokenEconomy(analysis, agentContext) {
  const budget = analysis.contextBudget || 8000;
  const fullRepoChars = analysis.repoStats?.totalChars || 0;
  const agentContextChars = estimateValueChars(agentContext);
  const visualGraphChars = estimateValueChars(analysis.knowledgeGraph || analysis.graph || { nodes: [], edges: [] });
  const tokenResult = countTokensForTexts([
    JSON.stringify(agentContext || ""),
    JSON.stringify(analysis.knowledgeGraph || analysis.graph || { nodes: [], edges: [] })
  ], { encoding: analysis.repoStats?.tokenizer?.encoding });
  const tokenizer = mergeTokenizer(analysis.repoStats?.tokenizer, tokenResult.tokenizer);
  const exactTokens = Boolean(tokenizer?.exact && analysis.repoStats?.tokenizer?.exact);
  const fullRepoTokens = analysis.repoStats?.fullContextTokens || 0;
  const agentContextTokens = tokenResult.counts[0] || 0;
  const visualGraphTokens = tokenResult.counts[1] || 0;
  const repoScopeExcludedChars = Math.max(0, fullRepoChars - agentContextChars);
  const repoScopeExcludedTokens = Math.max(0, fullRepoTokens - agentContextTokens);
  const compressionRatio = fullRepoTokens && agentContextTokens
    ? Number((fullRepoTokens / agentContextTokens).toFixed(1))
    : null;
  const overBudgetTokens = Math.max(0, agentContextTokens - budget);
  const remainingBudgetTokens = Math.max(0, budget - agentContextTokens);
  const labels = {
    fullRepo: formatTokenK(fullRepoTokens),
    agentInput: formatTokenK(agentContextTokens),
    visualGraph: formatTokenK(visualGraphTokens),
    storedArtifact: formatTokenK(agentContextTokens + visualGraphTokens),
    repoScopeExcluded: formatTokenK(repoScopeExcludedTokens),
    budget: formatTokenK(budget),
    overBudget: formatTokenK(overBudgetTokens),
    remainingBudget: formatTokenK(remainingBudgetTokens),
    fullRepoChars: formatCharK(fullRepoChars),
    agentInputChars: formatCharK(agentContextChars),
    visualGraphChars: formatCharK(visualGraphChars),
    repoScopeExcludedChars: formatCharK(repoScopeExcludedChars)
  };
  const tokenModeText = exactTokens ? "로컬 계측값" : "fallback 계산값";
  const summary = fullRepoTokens
    ? `근거 JSON 구성 요소는 ${labels.agentInput}입니다. 저장소 범위 ${labels.fullRepo} ${tokenModeText}는 검색 공간 크기일 뿐 pair delta 분모가 아닙니다.`
    : `근거 JSON 구성 요소는 ${labels.agentInput}입니다. 실제 pair delta는 default-codex 관측 입력 n과 scopelease-codex 관측 입력 m을 pair로 묶어 계산하고, 양수일 때만 절감률입니다.`;
  const budgetSummary = agentContextTokens <= budget
    ? `예산 ${labels.budget} 안에 들어오고 ${labels.remainingBudget} 여유가 있습니다.`
    : `예산 ${labels.budget}보다 ${labels.overBudget} 많습니다.`;

  return {
    mode: "agent_prompt_pack_excludes_visual_graph",
    estimator: exactTokens ? "tiktoken" : "rough_chars_div_4",
    tokenCounter: exactTokens ? "exact" : "fallback",
    exactTokens,
    tokenizer,
    unit: "tokens",
    exactUnit: "chars",
    fullRepoChars,
    agentContextChars,
    visualGraphChars,
    storedArtifactChars: agentContextChars + visualGraphChars,
    repoScopeExcludedChars,
    fullRepoTokens,
    agentContextTokens,
    visualGraphTokens,
    storedArtifactTokens: agentContextTokens + visualGraphTokens,
    repoScopeExcludedTokens,
    compressionRatio,
    budget,
    overBudgetTokens,
    remainingBudgetTokens,
    fitsBudget: agentContextTokens <= budget,
    tokenLimitPolicy: agentContextTokens <= budget ? "pass" : "escalate_or_shrink",
    labels,
    agentInput: {
      field: "contextPack.agentContext",
      tokens: agentContextTokens,
      label: labels.agentInput,
      description: "Codex/Claude Code-style 입력 후보 안에 넣을 수 있는 근거 JSON 구성 요소입니다. 그래프 JSON과 전체 파일 본문은 화면/근거용이라 제외합니다.",
      readOrder: agentContext.inputPlan?.readOrder || [],
      omitted: agentContext.inputPlan?.omitted || {}
    },
    claim: {
      scope: "coding_agent_context_candidate",
      canShow: "compact prompt candidate size, observed default-codex/scopelease-codex payload pairs, and local observed payloads",
      cannotShow: "savings against full repository size, official provider billing savings, hidden prompts, hidden reasoning, or unobserved tool/output tokens",
      targetAgents: ["Codex", "Claude Code-style agents"],
      providerUsageDefault: "not_measured"
    },
    summary,
    budgetSummary,
    note: exactTokens
      ? "토큰은 로컬 tiktoken으로 직접 계측합니다. 그래프 UI 데이터는 저장하지만, coding-agent 입력 후보에는 우선순위 컨텍스트와 판단 요약만 넘깁니다."
      : "정확 토크나이저를 사용할 수 없어 fallback 계측을 썼습니다. tiktoken을 사용할 수 있으면 직접 계측으로 전환됩니다."
  };
}

function buildCodexInput({ repo, generatedAt, summary, agentContext = {}, tokenEconomy = {}, decisionGate = {}, userRequest = DEFAULT_USER_REQUEST }) {
  const requestText = normalizeUserRequest(userRequest);
  const promptContext = buildCodexPromptContext({ repo, generatedAt, summary, agentContext, tokenEconomy, decisionGate });
  const requestTokenResult = countTokensForTexts([requestText], { encoding: tokenEconomy.tokenizer?.encoding });
  const requestTokens = requestTokenResult.counts[0] || 0;
  promptContext.contextDelta = compactObject({
    ...(promptContext.contextDelta || {}),
    baselineKind: "default-codex 관측 입력 비교 기준",
    currentPayload: "userRequest.text + compact ScopeLease context",
    userText: formatTokenK(requestTokens)
  });
  let text = "";
  let tokenResult = { counts: [0], tokenizer: {} };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    text = renderCodexInputText(requestText, promptContext);
    tokenResult = countTokensForTexts([text], { encoding: tokenEconomy.tokenizer?.encoding });
    if (!applyPromptContextDelta(promptContext, tokenEconomy, tokenResult.counts[0] || 0, text.length)) break;
  }
  text = renderCodexInputText(requestText, promptContext);
  tokenResult = countTokensForTexts([text], { encoding: tokenEconomy.tokenizer?.encoding });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const changed = applyPromptContextDelta(promptContext, tokenEconomy, tokenResult.counts[0] || 0, text.length);
    const nextText = renderCodexInputText(requestText, promptContext);
    const nextTokenResult = countTokensForTexts([nextText], { encoding: tokenEconomy.tokenizer?.encoding });
    text = nextText;
    tokenResult = nextTokenResult;
    if (!changed) break;
  }
  applyPromptContextDelta(promptContext, tokenEconomy, tokenResult.counts[0] || 0, text.length);
  text = renderCodexInputText(requestText, promptContext);
  tokenResult = countTokensForTexts([text], { encoding: tokenEconomy.tokenizer?.encoding });
  const tokens = tokenResult.counts[0] || 0;
  return {
    kind: "scopelease.codex_user_prompt",
    role: "user",
    field: "codexInput.text",
    format: "markdown_with_structured_context_json",
    chars: text.length,
    tokens,
    tokenizer: tokenResult.tokenizer,
    label: formatTokenK(tokens),
    userRequest: {
      field: "userRequest.text",
      role: "user",
      text: requestText,
      tokens: requestTokens,
      label: formatTokenK(requestTokens)
    },
    includedSections: [
      "userRequest.text",
      "codexPromptContext.repo",
      "scopeleaserity",
      "contextDelta",
      "readPlan",
      "symbolProbePlan",
      "avoidPlan",
      "traceLedger",
      "fatiguePlan",
      "processDelta",
      "outputTrace"
    ],
    excludedSections: [
      "full file bodies",
      "analysis.knowledgeGraph JSON",
      "browser window state",
      "local telemetry/history"
    ],
    promptContext,
    summary: `Codex 입력 후보로 넘길 수 있는 role=user 메시지는 ${tokenResult.tokenizer?.exact ? "로컬 직접 계측한" : "fallback으로 계산한"} ${formatTokenK(tokens)}입니다. 같은 본문은 Claude Code-style agent에도 재사용할 수 있습니다. ScopeLease는 필요한 판단 근거만 짧은 JSON으로 붙이고 provider API 사용량은 기본 계측하지 않습니다.`,
    text
  };
}

function renderCodexInputText(requestText, promptContext) {
  const contextJson = JSON.stringify(promptContext, null, 2);
  const lines = [
    "User request:",
    requestText,
    "",
    "ScopeLease context:",
    "```json",
    contextJson,
    "```",
    "",
    "Boundary:",
    "- role: user",
    "- field: codexInput.text",
    "- user-scopeleasered field: userRequest.text",
    "- excluded: full files, browser UI state, visual KG JSON",
    "- use ScopeLease context only as review evidence; do not treat it as user-scopeleasered text"
  ].filter((line) => line !== "");
  return `${lines.join("\n")}\n`;
}

function buildContextArtifacts(repo = "") {
  const base = `${DECISION_DIR}`;
  return {
    codexInput: {
      path: `${base}/${CODEX_INPUT_FILE}`,
      purpose: "Coding agent가 먼저 읽을 사용자 요청 + KG 근거 입력 후보입니다.",
      handoff: `먼저 ${base}/${CODEX_INPUT_FILE}를 읽고, 그 안의 readPlan 순서로 필요한 파일만 확인해 작업하세요.`
    },
    contextLedger: {
      path: `${base}/${CONTEXT_LEDGER_FILE}`,
      purpose: "codexInput.text 후보와 그 안의 탐색/수정 근거 토큰 장부입니다."
    },
    root: repo,
    rule: "실제 pair delta는 같은 work intent의 default-codex 관측 입력 n과 scopelease-codex 관측 입력 m을 비교해 계산합니다. 양수일 때만 절감률이고, 화면용 KG 전체는 agent 입력에서 제외합니다."
  };
}

function buildActualContextLedger({ codexInput = {}, tokenEconomy = {} }) {
  const promptContext = codexInput.promptContext || {};
  const encoding = tokenEconomy.tokenizer?.encoding || codexInput.tokenizer?.encoding;
  const routePayload = compactObject({
    readPlan: promptContext.readPlan || [],
    avoidPlan: promptContext.avoidPlan || [],
    traceLedger: promptContext.traceLedger || [],
    outputTrace: promptContext.outputTrace || {}
  });
  const editPayload = compactObject({
    scopeleaserity: promptContext.scopeleaserity || {},
    fatiguePlan: promptContext.fatiguePlan || {},
    processDelta: promptContext.processDelta || {},
    omitted: promptContext.omitted || {}
  });
  const outputPayload = compactObject({
    status: "not_captured",
    reason: "Agent final response is not available to ScopeLease unless it is passed back into the ledger."
  });
  const tokenResult = countTokensForTexts([
    JSON.stringify(routePayload),
    JSON.stringify(editPayload),
    JSON.stringify(outputPayload)
  ], { encoding });
  const [routeTokens, editTokens, outputPlaceholderTokens] = tokenResult.counts;
  const userTokens = codexInput.userRequest?.tokens || tokenEconomy.userRequestTokens || 0;
  const codexTokens = codexInput.tokens || tokenEconomy.actualInputTokens || 0;
  const promptContextTokens = Math.max(0, codexTokens - userTokens);
  const tokenizer = mergeTokenizer(tokenEconomy.tokenizer || {}, codexInput.tokenizer || tokenResult.tokenizer || {});
  const rows = [
    contextLedgerRow({
      key: "input",
      label: "입력",
      metric: "actual_context_input",
      measured: true,
      baseline: `원문 ${formatTokenK(userTokens)} + KG 근거 ${formatTokenK(promptContextTokens)}`,
      keptTokens: codexTokens,
      result: `후보 ${formatTokenK(codexTokens)}`,
      note: "ScopeLease가 만든 coding-agent user prompt 후보인 codexInput.text 전체입니다. KG가 고른 readPlan과 근거 JSON이 포함됩니다."
    }),
    contextLedgerRow({
      key: "explore",
      label: "탐색",
      metric: "actual_context_section",
      measured: true,
      baseline: "readPlan + trace",
      keptTokens: routeTokens || 0,
      result: `포함 ${formatTokenK(routeTokens || 0)}`,
      note: "Agent 입력 후보 안에 포함된 KG 기반 탐색 근거입니다. 전체 KG JSON은 포함하지 않습니다."
    }),
    contextLedgerRow({
      key: "edit",
      label: "수정",
      metric: "actual_context_section",
      measured: true,
      baseline: "권한 + 작업 계획",
      keptTokens: editTokens || 0,
      result: `포함 ${formatTokenK(editTokens || 0)}`,
      note: "Agent 입력 후보 안에 포함된 권한, 피로도, 수정 범위 컨텍스트입니다. patch diff 토큰은 별도 계측이 필요합니다."
    }),
    contextLedgerRow({
      key: "output",
      label: "결론",
      metric: "pending_output",
      measured: false,
      baseline: "응답 미수집",
      keptTokens: 0,
      result: "미계측",
      note: `최종 응답 텍스트가 ScopeLease ledger로 돌아오면 직접 계측합니다. 현재 예상 출력 구간은 ${formatTokenK(outputPlaceholderTokens || 0)}입니다.`
    }),
    contextLedgerRow({
      key: "total",
      label: "총 토큰",
      metric: "actual_context_total",
      measured: true,
      baseline: "Codex 입력 후보 / Agent 입력 후보 전체",
      keptTokens: codexTokens,
      result: `총 ${formatTokenK(codexTokens)}`,
      note: "중복 합산하지 않은 agent 입력 후보 총량입니다. 탐색/수정 행은 이 값 안의 section breakdown입니다."
    })
  ];

  return {
    kind: "scopelease.actual_context_ledger",
    unit: "tokens",
    counter: tokenizer?.exact ? `${tokenizer.method || "tiktoken"}:${tokenizer.encoding || ""}` : "fallback",
    basis: "KG가 고른 근거가 codexInput.text 후보로 렌더링된 기준",
    warning: "Agent hidden/system context, thinking tokens, 외부 tool 출력, 최종 응답은 ScopeLease가 별도로 수집하기 전까지 포함하지 않습니다.",
    avoided: {
      measurement: "observed_default_vs_scopelease_pair",
      baseline: "default-codex 관측 입력 n",
      kept: formatTokenK(codexTokens),
      actualSavingsLabel: "positive pair 필요",
      actualSavingsTokens: null,
      actualSavingsPercent: null,
      basis: "같은 work intent의 default-codex 관측 입력 n - scopelease-codex 관측 입력 m",
      actualSavings: {
        status: "needs_pair",
        label: "default/scopelease positive pair 필요",
        formula: "(n - m) / n",
        reason: "pair delta는 full repo 크기가 아니라 같은 작업 의도에서 ScopeLease 없이 실제 들어간 default-codex 입력 n과 ScopeLease 사용 입력 m이 모두 있을 때 계산합니다. 절감률 주장은 n > m일 때만 가능합니다."
      },
      repoScope: tokenEconomy.labels?.fullRepo || formatTokenK(tokenEconomy.fullRepoTokens || 0),
      note: "전체 저장소 크기는 pair delta 계산에서 제외합니다."
    },
    rows,
    excluded: {
      fullRepo: tokenEconomy.labels?.fullRepo || formatTokenK(tokenEconomy.fullRepoTokens || 0),
      visualGraph: tokenEconomy.labels?.visualGraph || formatTokenK(tokenEconomy.visualGraphTokens || 0),
      reason: "화면용 KG 전체와 전체 파일 본문은 agent 입력 후보에서 제외합니다."
    }
  };
}

function contextLedgerRow({ key, label, metric, measured, baseline, keptTokens = 0, result, note }) {
  const tokens = Number(keptTokens || 0);
  return {
    key,
    label,
    metric,
    measured,
    baseline,
    kept: formatTokenK(tokens),
    result,
    percent: null,
    baselineTokens: tokens,
    keptTokens: tokens,
    note
  };
}

function applyPromptContextDelta(promptContext, tokenEconomy = {}, actualInputTokens = 0, actualInputChars = 0) {
  const previous = JSON.stringify(promptContext.contextDelta || {});
  promptContext.contextDelta = compactObject({
    ...(promptContext.contextDelta || {}),
    codexInput: formatTokenK(actualInputTokens),
    scopeleaseCodexInput: formatTokenK(actualInputTokens),
    defaultCodexInput: "관측 필요",
    actualSavings: "pair 필요",
    actualSavingsPercent: null,
    inputChars: formatCharK(actualInputChars)
  });
  return previous !== JSON.stringify(promptContext.contextDelta || {});
}

function buildCodexPromptContext({ repo, generatedAt, summary, agentContext = {}, tokenEconomy = {}, decisionGate = {} }) {
  const gate = decisionGate || agentContext.decisionGate || {};
  return compactObject({
    repo,
    generatedAt,
    summary: summary || agentContext.summary,
    scopeleaserity: compactObject({
      status: gate.statusLabel || gate.status,
      owner: gate.scopeleaserityLabel || gate.scopeleaserity,
      automation: gate.automationLabel,
      nextAction: gate.nextAction,
      requiredChecks: gate.requiredChecks,
      blockedActions: gate.blockedActions
    }),
    taskIntent: agentContext.taskIntent,
    contextDelta: compactObject({
      counter: tokenEconomy.exactTokens ? `${tokenEconomy.tokenizer?.method || "tiktoken"}:${tokenEconomy.tokenizer?.encoding || ""}` : "fallback",
      repoScope: tokenEconomy.labels?.fullRepo,
      baselineKind: "default-codex 관측 입력 비교 기준",
      codexInput: tokenEconomy.labels?.actualInput,
      scopeleaseCodexInput: tokenEconomy.labels?.actualInput,
      defaultCodexInput: "관측 필요",
      actualSavings: "pair 필요",
      actualSavingsPercent: null,
      budget: tokenEconomy.labels?.budget,
      visualGraphExcluded: tokenEconomy.labels?.visualGraph
    }),
    readPlan: (agentContext.readPlan || agentContext.inputPlan?.readPlan || []).slice(0, 12),
    symbolProbePlan: (agentContext.symbolProbePlan || agentContext.inputPlan?.symbolProbePlan || []).slice(0, 8),
    graphQueryHints: agentContext.graphQueryHints,
    agentContract: agentContext.agentContract,
    frontiers: agentContext.frontierSummary || compactObject({
      graphScopeHash: agentContext.frontiers?.graphScope?.hash,
      symbolNodes: agentContext.frontiers?.symbolFrontier?.size,
      reviewNodes: agentContext.frontiers?.reviewFrontier?.size,
      permissionNodes: agentContext.frontiers?.permissionFrontier?.size,
      stopNodes: agentContext.frontiers?.stopFrontier?.size
    }),
    avoidPlan: (agentContext.avoidPlan || agentContext.inputPlan?.avoidPlan || []).slice(0, 6),
    traceLedger: (agentContext.traceLedger || agentContext.inputPlan?.traceLedger || []).slice(0, 10),
    fatiguePlan: agentContext.fatiguePlan || agentContext.inputPlan?.fatiguePlan,
    processDelta: agentContext.processDelta || agentContext.inputPlan?.processDelta,
    outputTrace: agentContext.outputTrace,
    omitted: agentContext.inputPlan?.omitted
  });
}

function normalizeUserRequest(value) {
  if (value === true || value === false || value == null) return DEFAULT_USER_REQUEST;
  const text = String(value || "").trim();
  if (text === "true" || text === "false") return DEFAULT_USER_REQUEST;
  return text || DEFAULT_USER_REQUEST;
}

function compactFrontier(frontier = {}, { includeItems = true, itemLimit = 2 } = {}) {
  if (!frontier) return null;
  return compactObject({
    kind: frontier.kind,
    label: frontier.label,
    size: frontier.size,
    hash: frontier.hash,
    items: includeItems ? (frontier.items || []).slice(0, itemLimit).map(compactFrontierItem) : []
  });
}

function compactGraphScope(scope = {}) {
  if (!scope) return null;
  return compactObject({
    hash: scope.hash,
    baselineGraphHash: scope.baselineGraphHash,
    backend: scope.backend,
    nodeCount: scope.nodeCount || scope.nodes?.length,
    edgeCount: scope.edgeCount || scope.edges?.length,
    policyCount: scope.policyCount || scope.policyNodes?.length,
    actionCount: scope.actionCount || scope.actionNodes?.length
  });
}

function compactFrontiersForAgent(frontiers = {}) {
  return compactObject({
    kind: frontiers.kind,
    version: frontiers.version,
    graphScope: compactGraphScope(frontiers.graphScope),
    symbolFrontier: compactFrontier(frontiers.symbolFrontier, { itemLimit: 4 }),
    reviewFrontier: compactFrontier(frontiers.reviewFrontier, { itemLimit: 2 }),
    permissionFrontier: compactFrontier(frontiers.permissionFrontier, { includeItems: false }),
    stopFrontier: compactFrontier(frontiers.stopFrontier, { itemLimit: 2 }),
    stopWhen: frontiers.stopWhen
  });
}

function compactFrontiersForVisual(frontiers = {}) {
  return compactObject({
    kind: frontiers.kind,
    version: frontiers.version,
    purpose: "visual_boundary_only_not_agent_input",
    graphScope: compactGraphScope(frontiers.graphScope),
    contextFrontier: compactFrontierForVisual(frontiers.contextFrontier),
    symbolFrontier: compactFrontierForVisual(frontiers.symbolFrontier),
    reviewFrontier: compactFrontierForVisual(frontiers.reviewFrontier),
    permissionFrontier: compactFrontierForVisual(frontiers.permissionFrontier),
    stopFrontier: compactFrontierForVisual(frontiers.stopFrontier),
    stopWhen: frontiers.stopWhen
  });
}

function compactFrontierForVisual(frontier = {}, { itemLimit = 12, nodeLimit = 1200 } = {}) {
  if (!frontier) return null;
  const nodes = (frontier.nodes || []).slice(0, nodeLimit);
  return compactObject({
    kind: frontier.kind,
    label: frontier.label,
    size: frontier.size,
    hash: frontier.hash,
    nodes,
    nodesTruncated: Math.max(0, (frontier.nodes || []).length - nodes.length),
    items: (frontier.items || []).slice(0, itemLimit).map(compactFrontierItem)
  });
}

function compactFrontierItem(item = {}) {
  return compactObject({
    kind: item.kind,
    id: item.id,
    path: item.path,
    symbol: item.symbol,
    type: item.type,
    line: item.line,
    label: item.label,
    risk: item.risk,
    reason: String(item.reason || "").slice(0, 80)
  });
}

function compactObject(value) {
  if (Array.isArray(value)) return value.map(compactObject).filter((item) => !isEmptyValue(item));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const compacted = compactObject(item);
    if (isEmptyValue(compacted)) continue;
    result[key] = compacted;
  }
  return result;
}

function isEmptyValue(value) {
  return value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
}

function attachCodexInputEconomy(tokenEconomy, codexInput) {
  const budget = tokenEconomy.budget || 8000;
  const userRequestTokens = codexInput.userRequest?.tokens || 0;
  const fullRepoChars = tokenEconomy.fullRepoChars || 0;
  const actualInputChars = codexInput.chars || String(codexInput.text || "").length || 0;
  const repoScopeExcludedFromScopeLeaseInputChars = Math.max(0, fullRepoChars - actualInputChars);
  const fullRepoTokens = tokenEconomy.fullRepoTokens || 0;
  const actualInputTokens = codexInput.tokens || 0;
  const repoScopeExcludedFromScopeLeaseInputTokens = Math.max(0, fullRepoTokens - actualInputTokens);
  const actualOverBudgetTokens = Math.max(0, actualInputTokens - budget);
  const actualRemainingBudgetTokens = Math.max(0, budget - actualInputTokens);
  const actualFitsBudget = actualInputTokens <= budget;
  const labels = {
    ...(tokenEconomy.labels || {}),
    userRequest: formatTokenK(userRequestTokens),
    actualInput: formatTokenK(actualInputTokens),
    repoScopeExcludedFromScopeLeaseInput: formatTokenK(repoScopeExcludedFromScopeLeaseInputTokens),
    actualRemainingBudget: formatTokenK(actualRemainingBudgetTokens),
    actualOverBudget: formatTokenK(actualOverBudgetTokens),
    actualInputChars: formatCharK(actualInputChars),
    repoScopeExcludedFromScopeLeaseInputChars: formatCharK(repoScopeExcludedFromScopeLeaseInputChars)
  };
  const summary = fullRepoTokens
    ? `사용자 원문은 ${labels.userRequest}이고, ScopeLease가 만든 Codex 입력 후보 전체는 ${labels.actualInput}입니다. 이 후보는 Claude Code-style agent에도 재사용할 수 있습니다. 실제 pair delta는 같은 work intent의 default-codex 관측 입력 n과 scopelease-codex 관측 입력 m을 비교해 계산하고, 양수일 때만 절감률입니다. 저장소 범위 ${labels.fullRepo}는 검색 공간 크기입니다.`
    : tokenEconomy.summary;
  const budgetSummary = actualFitsBudget
    ? `예산 ${labels.budget} 안에 들어오고 ${labels.actualRemainingBudget} 여유가 있습니다.`
    : `예산 ${labels.budget}보다 ${labels.actualOverBudget} 많습니다.`;

  return {
    ...tokenEconomy,
    labels,
    exactTokens: Boolean(tokenEconomy.exactTokens && codexInput.tokenizer?.exact),
    tokenizer: mergeTokenizer(tokenEconomy.tokenizer, codexInput.tokenizer),
    summary,
    budgetSummary,
    userRequestTokens,
    actualInputTokens,
    actualInputChars,
    repoScopeExcludedFromScopeLeaseInputChars,
    repoScopeExcludedFromScopeLeaseInputTokens,
    actualOverBudgetTokens,
    actualRemainingBudgetTokens,
    actualFitsBudget,
    actualInput: {
      field: codexInput.field,
      tokens: actualInputTokens,
      chars: actualInputChars,
      label: labels.actualInput,
      charLabel: labels.actualInputChars,
      role: codexInput.role,
      description: "사용자가 Codex 또는 Claude Code-style agent에 붙여 넣을 수 있는 자연어 요청 + KG 근거 본문 후보입니다."
    }
  };
}

function buildDecisionGate(analysis) {
  const risk = analysis.risk || "low";
  const recommendation = analysis.recommendation || "auto_log";
  const changedFiles = analysis.changes?.files || [];
  const deletedFiles = analysis.changes?.deleted || [];
  const policyHits = analysis.policyHits || [];
  const reviewPolicyHits = policyHits.filter(requiresHumanPolicyReview);
  const hasNonDocChange = changedFiles.some((file) => !isDocPath(file)) || deletedFiles.length > 0;
  const hasTestEvidence = (analysis.impact?.tests || []).length > 0 || changedFiles.some((file) => /\b(test|spec)\b|\.(test|spec)\./i.test(file));
  const route = normalizeRoute(recommendation, risk);
  const requiredChecks = [];

  if (hasNonDocChange && !hasTestEvidence) requiredChecks.push("관련 테스트 근거가 없습니다. 테스트를 추가하거나 수동 검증 결과를 남겨야 합니다.");
  if (reviewPolicyHits.length) requiredChecks.push("리뷰 또는 승인이 필요한 정책에 걸렸습니다. .decision/policies.yaml의 라우팅 기준에 따라 지정된 권한자가 확인해야 합니다.");
  if (analysis.uncertainty === "high") requiredChecks.push("영향 범위가 불확실합니다. 누락된 심볼, 라우트, 외부 연결을 사람이 확인해야 합니다.");

  const critical = risk === "critical" || recommendation === "approver" || recommendation === "block";
  const high = RISK_RANK[risk] >= RISK_RANK.high || ["senior_review", "human_review", "approver"].includes(recommendation);
  const medium = risk === "medium" || ["owner_review", "reviewer"].includes(recommendation);

  if (critical) {
    return describeDecisionGate({
      status: "approval_required",
      scopeleaserity: "approver",
      requiredApproval: route,
      canAutoPreparePatch: true,
      canAutoApplyPatch: false,
      canAutoCheckpoint: false,
      allowedActions: ["컨텍스트 팩 생성", "영향 그래프 표시", "패치 제안 초안 작성"],
      blockedActions: ["자동 적용", "자동 체크포인트", "무승인 병합"],
      requiredChecks,
      correctionActions: correctionActions(policyHits, requiredChecks)
    }, analysis);
  }

  if (high) {
    return describeDecisionGate({
      status: "senior_review_required",
      scopeleaserity: route,
      requiredApproval: route,
      canAutoPreparePatch: true,
      canAutoApplyPatch: false,
      canAutoCheckpoint: false,
      allowedActions: ["컨텍스트 팩 생성", "영향 그래프 표시", "리뷰용 패치 준비"],
      blockedActions: ["자동 적용", "리뷰 전 기준점 갱신"],
      requiredChecks,
      correctionActions: correctionActions(policyHits, requiredChecks)
    }, analysis);
  }

  if (medium) {
    return describeDecisionGate({
      status: "owner_review_required",
      scopeleaserity: route,
      requiredApproval: route,
      canAutoPreparePatch: true,
      canAutoApplyPatch: false,
      canAutoCheckpoint: false,
      allowedActions: ["리뷰용 패치 준비", "담당자에게 결정 카드 전달"],
      blockedActions: ["무검토 체크포인트"],
      requiredChecks,
      correctionActions: correctionActions(policyHits, requiredChecks)
    }, analysis);
  }

  const logOnly = recommendation === "log_only";
  return describeDecisionGate({
    status: logOnly ? "log_only" : "auto_log_allowed",
    scopeleaserity: logOnly ? "audit_log" : "agent",
    requiredApproval: "none",
    canAutoPreparePatch: true,
    canAutoApplyPatch: true,
    canAutoCheckpoint: logOnly || !changedFiles.length,
    allowedActions: logOnly
      ? ["자동 기록", "근거와 함께 체크포인트 후보 생성"]
      : ["자동 기록", "낮은 위험 변경 적용", "근거와 함께 체크포인트 후보 생성"],
    blockedActions: [],
    requiredChecks,
    correctionActions: correctionActions(policyHits, requiredChecks)
  }, analysis);
}

function buildUsefulness(analysis, tokenEconomy, decisionGate) {
  const reasons = [];
  const benefits = [];
  const limits = [];
  const highRisk = RISK_RANK[analysis.risk || "low"] >= RISK_RANK.high;
  const hasReviewPolicy = (analysis.policyHits || []).some(requiresHumanPolicyReview);
  const hasImpact = [
    ...(analysis.impact?.routes || []),
    ...(analysis.impact?.importedBy || []),
    ...(analysis.impact?.tests || []),
    ...(analysis.impact?.docs || [])
  ].length > 0;

  const actualInputLabel = tokenEconomy.labels?.actualInput || tokenEconomy.labels?.agentInput || formatTokenK(tokenEconomy.actualInputTokens || tokenEconomy.agentContextTokens);
  const actualFitsBudget = tokenEconomy.actualFitsBudget ?? tokenEconomy.fitsBudget;
  const actualOverBudget = tokenEconomy.labels?.actualOverBudget || tokenEconomy.labels?.overBudget || formatTokenK(tokenEconomy.actualOverBudgetTokens || tokenEconomy.overBudgetTokens);
  reasons.push("실제 pair delta는 같은 work intent의 default-codex 관측 입력 n과 scopelease-codex 관측 입력 m을 pair로 묶어 계산하고, 양수일 때만 절감률입니다.");
  if (actualFitsBudget) reasons.push(`Codex 입력 후보 ${actualInputLabel}이 ${tokenEconomy.labels?.budget || formatTokenK(tokenEconomy.budget)} 예산 안에 들어옵니다.`);
  else reasons.push(`Codex 입력 후보 ${actualInputLabel}이 ${tokenEconomy.labels?.budget || formatTokenK(tokenEconomy.budget)} 예산을 ${actualOverBudget} 초과합니다.`);
  if (highRisk || hasReviewPolicy) reasons.push("리뷰가 필요한 정책 또는 고위험 변경은 자동 적용하지 않고 지정된 권한자에게 보냅니다.");
  if (hasImpact) reasons.push("변경 파일에서 라우트, 테스트, 문서, 호출자로 내려가는 근거 경로를 보여줍니다.");
  if (!decisionGate.canAutoApplyPatch) reasons.push("지금 허용되는 작업과 막힌 작업을 분리해 보여줍니다.");

  benefits.push("결정에 필요한 파일, 정책, 근거 경로부터 보게 해서 default-codex와 scopelease-codex run을 같은 work intent로 비교할 수 있게 합니다.");
  if (hasImpact) benefits.push("라우트, 테스트, 문서, 호출자 연결을 한 화면에서 확인해 누락된 영향 범위를 줄입니다.");
  if (highRisk || hasReviewPolicy) benefits.push("위험한 변경은 에이전트가 임의 적용하지 못하게 권한 경계를 먼저 세웁니다.");
  if (actualFitsBudget) benefits.push("현재 입력 후보가 예산 안에 있어 리뷰나 에이전트 작업의 첫 입력으로 쓸 수 있습니다.");

  if (!actualFitsBudget) limits.push("현재 input이 예산을 넘으므로 우선순위 파일이나 심볼 수를 더 줄여야 합니다.");
  if (!hasImpact) limits.push("근거 경로가 적으면 사람이 직접 파일을 더 열어 확인해야 합니다.");
  if (decisionGate.requiredChecks?.length) limits.push("필수 확인 조건은 자동으로 해결하지 않고 사람에게 넘깁니다.");

  if ((highRisk || hasReviewPolicy || hasImpact) && actualFitsBudget) {
    return {
      verdict: "recommended",
      label: "사용 권장",
      headline: "변경을 바로 적용하기보다, 리뷰할 순서와 권한 경계를 먼저 잡아줍니다.",
      reasons,
      benefits,
      limits,
      nextStep: decisionGate.nextAction
    };
  }

  if (highRisk || hasReviewPolicy || hasImpact) {
    return {
      verdict: "needs_shrink",
      label: "컨텍스트 축소 필요",
      headline: "근거는 유효하지만 input을 더 줄여야 안정적으로 쓸 수 있습니다.",
      reasons: reasons.length ? reasons : ["근거는 유효하지만 에이전트 컨텍스트가 예산을 넘어 우선순위를 더 좁혀야 합니다."],
      benefits,
      limits,
      nextStep: "우선순위 파일, 심볼, 근거 경로 수를 줄인 뒤 다시 분석합니다."
    };
  }

  if (tokenEconomy.fullRepoTokens < 2000 && !highRisk && !hasReviewPolicy && !hasImpact) {
    return {
      verdict: "not_needed",
      label: "작은 변경에는 과함",
      headline: "작은 변경은 사람이 직접 보는 편이 더 빠를 수 있습니다.",
      reasons: reasons.length ? reasons : ["저장소/변경 규모가 작고 리뷰 정책 또는 영향 경로가 없어 사람이 직접 보는 비용이 낮습니다."],
      benefits,
      limits,
      nextStep: "필요하면 감사 로그만 남기고 기준점을 갱신합니다."
    };
  }

  return {
    verdict: "limited",
    label: "제한적으로 유용",
    headline: "관측 pair가 없으면 절감률은 아직 계산할 수 없고, 의사결정 이득은 제한적입니다.",
    reasons: reasons.length ? reasons : ["default-codex/scopelease-codex 관측 pair 또는 의사결정 라우팅 이득이 아직 충분히 크지 않습니다."],
    benefits,
    limits,
    nextStep: "정책 또는 영향 경로가 더 생기면 결정 카드의 가치가 커집니다."
  };
}

function compactAffected(impact = {}, limits = AGENT_INPUT_LIMIT_STEPS[0]) {
  const nodeLimit = limits.affectedNodes || 8;
  const pathLimit = limits.evidencePaths || 8;
  return {
    imports: compactNodes(impact.imports, nodeLimit),
    importedBy: compactNodes(impact.importedBy, nodeLimit),
    routes: compactNodes(impact.routes, nodeLimit),
    tests: compactNodes(impact.tests, nodeLimit),
    docs: compactNodes(impact.docs, nodeLimit),
    policies: compactNodes(impact.policies, nodeLimit),
    paths: (impact.paths || []).slice(0, pathLimit).map((path) => ({
      kind: path.kind,
      summary: path.summary
    })),
    omitted: {
      imports: omittedCount(impact.imports, nodeLimit),
      importedBy: omittedCount(impact.importedBy, nodeLimit),
      routes: omittedCount(impact.routes, nodeLimit),
      tests: omittedCount(impact.tests, nodeLimit),
      docs: omittedCount(impact.docs, nodeLimit),
      policies: omittedCount(impact.policies, nodeLimit),
      paths: omittedCount(impact.paths, pathLimit)
    }
  };
}

function compactNodes(nodes = [], limit = 8) {
  return nodes.slice(0, limit).map((node) => ({
    label: node.label,
    path: node.path,
    line: node.line,
    type: node.type || node.fileType
  }));
}

function omittedCount(items = [], limit = 0) {
  return Math.max(0, (items || []).length - limit);
}

function normalizeRoute(recommendation, risk) {
  if (recommendation === "human_review") return "senior_review";
  if (recommendation === "reviewer") return "owner_review";
  if (recommendation === "approver" || risk === "critical") return "approver";
  return recommendation || "auto_log";
}

function correctionActions(policyHits, requiredChecks) {
  const actions = [];
  if (requiredChecks.some((check) => check.includes("테스트"))) actions.push("관련 테스트나 검증 로그를 추가하면 판단 근거가 명확해집니다.");
  if (requiredChecks.some((check) => check.includes("불확실"))) actions.push("누락된 심볼, 라우트, DB 연결을 문서나 정책 노드로 보강합니다.");
  if (policyHits.some(requiresHumanPolicyReview)) actions.push("정책 기준이 실제 운영 기준과 다르면 .decision/policies.yaml을 조정하고 이유를 남깁니다.");
  actions.push("검토 또는 적용이 끝나면 scopelease checkpoint로 현재 상태를 새 기준점으로 갱신합니다.");
  return actions;
}

function requiresHumanPolicyReview(hit) {
  const route = normalizeRoute(hit.route, hit.risk);
  return RISK_RANK[hit.risk || "low"] >= RISK_RANK.medium || !["auto_log", "log_only", "none"].includes(route);
}

function describeDecisionGate(gate, analysis) {
  return {
    ...gate,
    statusLabel: gateText(gate.status),
    scopeleaserityLabel: scopeleaserityText(gate.scopeleaserity),
    routingLabel: routeText(gate.requiredApproval === "none" ? analysis.recommendation : gate.requiredApproval),
    automationLabel: automationText(gate),
    summary: gateSummary(gate, analysis),
    nextAction: nextActionText(gate, analysis),
    permissionSummary: permissionText(gate),
    scopeleaseritySummary: scopeleaseritySummaryText(gate),
    checkpointRule: checkpointRuleText(gate),
    enforcement: {
      decisionOwner: scopeleaserityText(gate.scopeleaserity),
      agentMay: gate.allowedActions,
      agentMustNot: gate.blockedActions,
      checkpoint: checkpointRuleText(gate)
    }
  };
}

function compactDecisionGate(gate) {
  if (!gate) return null;
  return {
    status: gate.status,
    statusLabel: gate.statusLabel,
    scopeleaserity: gate.scopeleaserity,
    scopeleaserityLabel: gate.scopeleaserityLabel,
    routingLabel: gate.routingLabel,
    automationLabel: gate.automationLabel,
    summary: gate.summary,
    nextAction: gate.nextAction,
    permissionSummary: gate.permissionSummary,
    scopeleaseritySummary: gate.scopeleaseritySummary,
    checkpointRule: gate.checkpointRule,
    enforcement: gate.enforcement,
    requiredChecks: gate.requiredChecks,
    allowedActions: gate.allowedActions,
    blockedActions: gate.blockedActions
  };
}

function gateSummary(gate, analysis) {
  const risk = riskText(analysis.risk || "low");
  const uncertainty = uncertaintyText(analysis.uncertainty || "low");
  const scopeleaserity = scopeleaserityText(gate.scopeleaserity);
  if (gate.status === "approval_required") return `${risk} 위험 변경입니다. ${scopeleaserity}가 확인하기 전까지 자동 적용과 체크포인트를 막습니다.`;
  if (gate.status === "senior_review_required") return `${risk} 위험 또는 높은 불확실성이 있어 ${scopeleaserity} 리뷰가 필요합니다.`;
  if (gate.status === "owner_review_required") return `${risk} 위험 변경입니다. 담당자가 변경 의도와 영향 범위를 확인해야 합니다.`;
  if (gate.status === "log_only") return `문서성 또는 낮은 위험 변경입니다. 적용보다는 감사 로그에 남기는 흐름입니다.`;
  return `${risk} 위험, 불확실성 ${uncertainty}입니다. 근거를 남기면서 자동 적용할 수 있습니다.`;
}

function nextActionText(gate, analysis) {
  if (gate.status === "approval_required") return "승인권자 확인 전에는 패치 초안과 근거 정리까지만 진행합니다.";
  if (gate.status === "senior_review_required") return "결정권자에게 변경 의도, 영향 경로, 정책 근거를 함께 전달합니다.";
  if (gate.status === "owner_review_required") return "담당자 리뷰 후 적용하고 기준점을 갱신합니다.";
  if (gate.status === "log_only") return "변경 내용을 기록하고 필요하면 기준점만 갱신합니다.";
  if (gate.canAutoApplyPatch && gate.canAutoCheckpoint) return "근거를 남긴 뒤 적용과 체크포인트까지 자동으로 진행할 수 있습니다.";
  if (gate.canAutoApplyPatch) return "적용은 가능하지만 체크포인트는 사용자가 확인한 뒤 갱신합니다.";
  return `${routeText(analysis.recommendation || "auto_log")} 경로로 보냅니다.`;
}

function permissionText(gate) {
  const owner = scopeleaserityText(gate.scopeleaserity);
  if (gate.canAutoApplyPatch && gate.canAutoCheckpoint) return `${owner} 권한에서 자동 적용과 체크포인트가 모두 허용됩니다. 그래도 근거는 감사 로그에 남깁니다.`;
  if (gate.canAutoApplyPatch) return `${owner} 권한에서 자동 적용은 가능하지만, 기준점 갱신은 사용자가 확인한 뒤 진행합니다.`;
  if (gate.canAutoPreparePatch) return `결정은 ${owner}에게 있습니다. 에이전트는 리뷰용 초안과 근거 정리까지만 허용됩니다.`;
  return "자동 작업을 진행하지 않습니다.";
}

function scopeleaseritySummaryText(gate) {
  const owner = scopeleaserityText(gate.scopeleaserity);
  if (gate.status === "approval_required") return `${owner}가 승인하기 전에는 적용, 체크포인트, 병합을 하지 않습니다.`;
  if (gate.status === "senior_review_required") return `${owner}가 변경 의도와 영향 경로를 보고 적용 여부를 결정합니다. 에이전트는 초안 준비 역할입니다.`;
  if (gate.status === "owner_review_required") return `${owner}가 영향 범위를 확인한 뒤 적용과 기준점 갱신 여부를 정합니다.`;
  if (gate.status === "log_only") return `${owner}로 남기고, 코드 적용 권한 판단은 만들지 않습니다.`;
  return `${owner}가 낮은 위험 변경을 근거와 함께 처리할 수 있습니다.`;
}

function checkpointRuleText(gate) {
  if (gate.canAutoCheckpoint) return "자동 체크포인트 가능. 현재 상태를 새 기준점으로 남길 수 있습니다.";
  if (gate.canAutoApplyPatch) return "적용은 가능하지만 체크포인트는 사용자 확인 뒤 갱신합니다.";
  return "리뷰 또는 승인 전에는 기준점을 갱신하지 않습니다.";
}

function automationText(gate) {
  if (gate.canAutoApplyPatch && gate.canAutoCheckpoint) return "적용 및 체크포인트 가능";
  if (gate.canAutoApplyPatch) return "적용 가능, 체크포인트는 별도";
  if (gate.canAutoPreparePatch) return "초안 작성만 가능";
  return "자동 작업 차단";
}

function humanSummary(analysis) {
  const changes = analysis.changes || {};
  const addedCount = (changes.added || []).length;
  const changedCount = (changes.modified || changes.files || []).length;
  const deletedCount = (changes.deleted || []).length;
  const symbolCount = Object.values(changes.symbols || {}).reduce((sum, symbols) => sum + symbols.length, 0);
  if (!addedCount && !changedCount && !deletedCount) return "기준점 이후 감지된 로컬 변경이 없습니다.";
  return `${addedCount}개 추가, ${changedCount}개 변경, ${deletedCount}개 삭제, ${symbolCount}개 심볼이 감지되어 ${riskText(analysis.risk || "low")} 위험으로 분류됐습니다.`;
}

function riskText(value) {
  return RISK_TEXT[value] || value || "낮음";
}

function uncertaintyText(value) {
  return { low: "낮음", medium: "중간", high: "높음" }[value] || value || "낮음";
}

function routeText(value) {
  return ROUTE_TEXT[value] || value || "자동 기록";
}

function gateText(value) {
  return GATE_TEXT[value] || value || "자동 기록 가능";
}

function scopeleaserityText(value) {
  return SCOPELEASERITY_TEXT[value] || routeText(value);
}

function reasonText(reason) {
  if (reason?.startsWith("policy hit: ")) return `정책 적중: ${reason.replace("policy hit: ", "")}`;
  return {
    "source code changed": "소스 코드가 변경됐습니다.",
    "files deleted from baseline": "기준점에 있던 파일이 삭제됐습니다.",
    "documentation-only change": "문서만 변경됐습니다.",
    "source change has no related test evidence": "소스 변경과 연결된 테스트 근거가 없습니다."
  }[reason] || reason;
}

function priorityReasonText(reason) {
  return {
    "changed since baseline": "기준점 이후 변경됨",
    "user request term match": "사용자 요청과 일치하는 파일",
    "imports changed file": "변경 파일을 호출함",
    "test edge points to changed file": "변경 파일을 검증하는 테스트",
    "mentions changed symbol": "변경 심볼을 언급하는 문서"
  }[reason] || reason;
}

function pathKindText(kind) {
  return {
    defines: "정의",
    imported_by: "호출 영향",
    imports: "의존",
    route: "라우트",
    test: "테스트",
    doc: "문서",
    policy: "정책",
    mentions: "언급"
  }[kind] || kind;
}

function symbolTypeText(type) {
  return {
    function: "함수",
    type: "타입",
    class: "클래스",
    const: "상수",
    variable: "변수"
  }[type] || type;
}

function isDocPath(file) {
  return /\.(md|mdx|txt|rst|adoc)$/i.test(file);
}

function estimateValueChars(value) {
  return JSON.stringify(value || "").length;
}

function formatTokenK(value) {
  const tokens = Number(value || 0);
  if (!Number.isFinite(tokens) || tokens <= 0) return "0k";
  const scaled = tokens / 1000;
  const fixed = scaled < 10 ? scaled.toFixed(2) : scaled.toFixed(1);
  return `${trimTrailingZero(fixed)}k`;
}

function formatCharK(value) {
  const chars = Number(value || 0);
  if (!Number.isFinite(chars) || chars <= 0) return "0";
  const scaled = chars / 1000;
  const fixed = scaled < 10 ? scaled.toFixed(2) : scaled.toFixed(1);
  return `${trimTrailingZero(fixed)}k`;
}

function trimTrailingZero(value) {
  return String(Number(value));
}

function mergeTokenizer(primary = {}, secondary = {}) {
  return {
    ...primary,
    ...secondary,
    exact: Boolean(primary.exact && (secondary.exact ?? true)),
    method: secondary.method || primary.method,
    encoding: secondary.encoding || primary.encoding,
    model: secondary.model || primary.model || null,
    source: secondary.source || primary.source
  };
}
