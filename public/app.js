import {
  buildHookSavingsEstimate,
  buildObservedWorkIntentSavings,
  formatSavingsDisplay,
  formatObservedSavings
} from "./savings.js";

const state = {
  selectedNode: null,
  latest: null
};

const elements = {
  repoPath: document.querySelector("#repoPath"),
  eventCount: document.querySelector("#eventCount"),
  timeline: document.querySelector("#timeline"),
  riskBadge: document.querySelector("#riskBadge"),
  graphSummary: document.querySelector("#graphSummary"),
  impactGraph: document.querySelector("#impactGraph"),
  nodeDetails: document.querySelector("#nodeDetails"),
  decisionCard: document.querySelector("#decisionCard"),
  agentInputSummary: document.querySelector("#agentInputSummary"),
  contextPack: document.querySelector("#contextPack"),
  tokenEstimate: document.querySelector("#tokenEstimate"),
  analyzeBtn: document.querySelector("#analyzeBtn"),
  checkpointBtn: document.querySelector("#checkpointBtn"),
  statusRisk: document.querySelector("#statusRisk"),
  statusChanged: document.querySelector("#statusChanged"),
  statusGraph: document.querySelector("#statusGraph"),
  statusUpdated: document.querySelector("#statusUpdated")
};

elements.analyzeBtn.addEventListener("click", async () => {
  await fetch("/api/analyze", { method: "POST" });
  await refresh();
});

elements.checkpointBtn.addEventListener("click", async () => {
  await fetch("/api/checkpoint", { method: "POST" });
  await refresh();
});

async function refresh() {
  const response = await fetch("/api/state", { cache: "no-store" });
  const data = await response.json();
  state.latest = data.latestAnalysis;
  render(data);
}

function render(data) {
  const analysis = data.latestAnalysis || emptyAnalysis(data.repo || "");
  elements.repoPath.textContent = data.repo || analysis.repo || "연결된 저장소가 없습니다.";
  renderStatus(analysis);
  renderTimeline(data.events || []);
  renderDecisionCard(analysis, data);
  renderContext(analysis.contextPack || {}, data);
  renderGraph(analysis.graph || { nodes: [], edges: [] });
}

function renderStatus(analysis) {
  const changedCount = analysis.changes?.files?.length || 0;
  const graph = analysis.graph || { nodes: [], edges: [] };
  elements.statusRisk.textContent = riskLabel(analysis.risk || "low");
  elements.statusChanged.textContent = `${changedCount}개 파일`;
  elements.statusGraph.textContent = `${graph.nodes.length}개 노드 / ${graph.edges.length}개 관계`;
  elements.statusUpdated.textContent = analysis.generatedAt ? formatTime(analysis.generatedAt) : "-";
}

function renderTimeline(events) {
  elements.eventCount.textContent = `${events.length}`;
  if (!events.length) {
    elements.timeline.innerHTML = `<li><strong>아직 로컬 변경이 없습니다.</strong><span>체크포인트 이후 파일을 수정하면 여기에 변경 흐름이 쌓입니다.</span></li>`;
    return;
  }

  elements.timeline.innerHTML = events.map((event) => `
    <li>
      <time>${formatTime(event.timestamp)}</time>
      <strong>${escapeHtml(event.summary)}</strong>
      <span>${escapeHtml(event.changedFiles.slice(0, 3).join(", "))}${event.changedFiles.length > 3 ? " ..." : ""}</span>
    </li>
  `).join("");
}

function renderDecisionCard(analysis, data = {}) {
  const gate = analysis.contextPack?.decisionGate;
  const economy = analysis.contextPack?.tokenEconomy;
  const usefulness = analysis.contextPack?.usefulness;
  const pairSavings = formatObservedSavings(
    buildObservedWorkIntentSavings({ state: data, analysis }),
    formatTokenCount
  );
  const hookEstimate = buildHookSavingsEstimate({ state: data, analysis });
  const tokenCopy = formatTokenEconomy(economy, pairSavings, hookEstimate);
  const useCopy = formatUsefulness(usefulness);
  const frontierCopy = formatFrontierCopy(
    analysis.contextPack?.agentContext?.frontiers || analysis.contextPack?.codexInput?.promptContext?.frontiers || {},
    analysis.contextPack?.agentContext?.frontierSummary || analysis.contextPack?.codexInput?.promptContext?.frontiers || {}
  );
  const policyItems = (analysis.policyHits || []).map((hit) =>
    `<li><strong>${escapeHtml(hit.ruleId)}</strong><br><span>${escapeHtml(riskLabel(hit.risk))} 위험, ${escapeHtml(routeLabel(hit.route))} 필요. ${escapeHtml(hit.reason || "정책에 매칭됐습니다.")}</span></li>`
  ).join("");

  const changedFiles = (analysis.changes?.files || []).map((file) => `<li>${escapeHtml(file)}</li>`).join("");
  const symbols = Object.values(analysis.changes?.symbols || {}).flat()
    .map((symbol) => `<li>${escapeHtml(symbol.name)} <span>(${escapeHtml(symbol.type)}, ${escapeHtml(symbol.path)}:${symbol.line})</span></li>`)
    .join("");
  const review = (analysis.contextPack?.priorityContext || [])
    .slice(0, 8)
    .map((item) => `<li>${escapeHtml(item.path)}<br><span>${escapeHtml(priorityReasonLabel(item.reason))}</span></li>`)
    .join("");
  const requiredChecks = listItems(gate?.requiredChecks, "추가 확인 조건은 없습니다.");
  const allowedActions = listItems(gate?.allowedActions, "분석 결과가 준비되면 허용 작업이 표시됩니다.");
  const blockedActions = listItems(gate?.blockedActions, gate?.canAutoApplyPatch ? "현재 차단된 자동 작업은 없습니다." : "분석 결과가 준비되면 차단 작업이 표시됩니다.");
  const benefits = listItems(usefulness?.benefits, "아직 뚜렷한 사용 이득은 계산되지 않았습니다.");
  const limits = listItems(usefulness?.limits, "현재 표시할 주요 제한은 없습니다.");

  elements.riskBadge.textContent = riskLabel(analysis.risk || "low");
  elements.riskBadge.className = `risk ${analysis.risk || "low"}`;

  elements.decisionCard.innerHTML = `
    <dl class="kv">
      <dt>위험도</dt><dd>${escapeHtml(riskLabel(analysis.risk || "low"))}</dd>
      <dt>불확실성</dt><dd>${escapeHtml(uncertaintyLabel(analysis.uncertainty || "low"))}</dd>
      <dt>권한</dt><dd>${escapeHtml(gate?.scopeleaserityLabel || scopeleaserityLabel(gate?.scopeleaserity || "agent"))}</dd>
      <dt>라우팅</dt><dd>${escapeHtml(gate?.routingLabel || routeLabel(analysis.recommendation || "auto_log"))}</dd>
      <dt>자동화</dt><dd>${escapeHtml(gate?.automationLabel || (gate ? autoLabel(gate) : "-"))}</dd>
      <dt>Agent 입력 후보</dt><dd>${escapeHtml(tokenCopy.input)}</dd>
      <dt>${escapeHtml(tokenCopy.savingsLabel)}</dt><dd>${escapeHtml(tokenCopy.actualSavings)}</dd>
      <dt>계산 기준</dt><dd>${escapeHtml(tokenCopy.actualSavingsNote)}</dd>
      <dt>예산</dt><dd>${escapeHtml(tokenCopy.budget)}</dd>
      <dt>검토 경계</dt><dd>${escapeHtml(frontierCopy.review)}</dd>
      <dt>위임 경계</dt><dd>${escapeHtml(frontierCopy.permission)}</dd>
      <dt>중단 경계</dt><dd>${escapeHtml(frontierCopy.stop)}</dd>
      <dt>Graph scope</dt><dd>${escapeHtml(frontierCopy.scope)}</dd>
      <dt>요약</dt><dd>${escapeHtml(formatSummary(analysis))}</dd>
    </dl>

    <h3>권한과 자동화</h3>
    <p>${escapeHtml(gate?.permissionSummary || (gate ? permissionSummary(gate) : "분석 결과를 기다리는 중입니다."))}</p>
    <p>${escapeHtml(gate?.scopeleaseritySummary || "")}</p>
    <p>${escapeHtml(gate?.checkpointRule || "")}</p>
    <ul>${allowedActions}</ul>
    <ul class="muted-list">${blockedActions}</ul>

    <h3>컨텍스트 기준</h3>
    <p>${escapeHtml(tokenCopy.summary)}</p>
    <ul>
      <li>후보 필드: <code>${escapeHtml(tokenCopy.actualField)}</code></li>
      <li>화면용 그래프 JSON ${escapeHtml(tokenCopy.visualGraph)}은 agent 입력 후보에서 제외합니다.</li>
      <li>${escapeHtml(tokenCopy.omittedSummary)}</li>
    </ul>

    <h3>왜 쓸 만한가</h3>
    <p>${escapeHtml(useCopy.headline)}</p>
    <ul>${benefits}</ul>
    <ul class="muted-list">${limits}</ul>

    <h3>변경 파일</h3>
    <ul>${changedFiles || "<li>기준점 이후 변경 파일이 없습니다.</li>"}</ul>

    <h3>변경 심볼</h3>
    <ul>${symbols || "<li>화면에 표시할 변경 심볼이 없습니다.</li>"}</ul>

    <h3>정책 근거</h3>
    <ul>${policyItems || "<li>현재 정책에 걸린 항목은 없습니다.</li>"}</ul>

    <h3>다음 확인</h3>
    <ul>${requiredChecks}</ul>

    <h3>꼭 볼 파일</h3>
    <ul>${review || "<li>지금 기준으로 따로 짚어야 할 리뷰 포인트는 없습니다.</li>"}</ul>
  `;
}

function renderContext(context, data = {}) {
  const analysis = data.latestAnalysis || {};
  const pairSavings = formatObservedSavings(
    buildObservedWorkIntentSavings({ state: data, analysis }),
    formatTokenCount
  );
  const hookEstimate = buildHookSavingsEstimate({ state: data, analysis });
  const tokenCopy = formatTokenEconomy(context.tokenEconomy, pairSavings, hookEstimate);
  elements.tokenEstimate.textContent = context.tokenEconomy ? `Agent 후보 ${tokenCopy.actualInput} / ${tokenCopy.savingsLabel} ${tokenCopy.actualSavings}` : "";
  const payload = formatAgentInputPayload(context);
  if (elements.agentInputSummary) {
    elements.agentInputSummary.innerHTML = renderAgentInputSummary(context, tokenCopy, payload);
  }
  elements.contextPack.textContent = JSON.stringify(payload, null, 2);
}

function formatFrontierCopy(frontiers = {}, summary = {}) {
  const review = frontiers.reviewFrontier || {};
  const permission = frontiers.permissionFrontier || {};
  const stop = frontiers.stopFrontier || {};
  const graphScope = frontiers.graphScope || {};
  const reviewCount = review.size ?? summary.reviewNodes;
  const permissionCount = permission.size ?? summary.permissionNodes;
  const stopCount = stop.size ?? summary.stopNodes;
  const hash = graphScope.hash || summary.graphScopeHash || "";
  return {
    review: reviewCount != null ? `${reviewCount} nodes` : "-",
    permission: permissionCount != null ? `${permissionCount} nodes` : "-",
    stop: stopCount != null ? `${stopCount} nodes` : "-",
    scope: hash ? shortId(hash) : "-"
  };
}

function renderGraph(graph) {
  const svg = elements.impactGraph;
  const width = Math.max(svg.clientWidth || 0, 860);
  const height = svg.clientHeight || 480;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = "";

  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  elements.graphSummary.textContent = `현재 로컬 영향 그래프에 ${nodes.length}개 노드와 ${edges.length}개 관계가 있습니다.`;

  if (!nodes.length) {
    drawEmpty(svg, width, height);
    elements.nodeDetails.textContent = "아직 그래프가 없습니다. 인덱싱 또는 체크포인트 이후 로컬 변경을 만들면 표시됩니다.";
    return;
  }

  const positioned = layoutNodes(nodes, width, height);
  const byId = new Map(positioned.map((node) => [node.id, node]));

  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    drawEdge(svg, source, target, edge);
  }

  for (const node of positioned) {
    drawNode(svg, node);
  }
}

function layoutNodes(nodes, width, height) {
  const columns = [
    { key: "changed", test: (node) => node.type?.startsWith("changed") },
    { key: "route", test: (node) => node.type === "route" || node.group === "routes" },
    { key: "impact", test: (node) => ["imports", "importedBy"].includes(node.group) },
    { key: "evidence", test: (node) => ["tests", "docs"].includes(node.group) },
    { key: "policy", test: (node) => node.type === "policy" }
  ];
  const buckets = columns.map(() => []);
  const fallback = [];

  for (const node of nodes) {
    const index = columns.findIndex((column) => column.test(node));
    if (index >= 0) buckets[index].push(node);
    else fallback.push(node);
  }
  buckets[2].push(...fallback);

  const gapX = width / (columns.length + 1);
  return buckets.flatMap((bucket, columnIndex) => {
    const gapY = height / (bucket.length + 1);
    return bucket.map((node, rowIndex) => ({
      ...node,
      x: Math.max(86, Math.min(width - 86, gapX * (columnIndex + 1))),
      y: Math.max(42, Math.min(height - 42, gapY * (rowIndex + 1))),
      width: clamp(labelWidth(node.label || node.path || node.id), 96, 190),
      height: 38
    }));
  });
}

function drawEdge(svg, source, target, edge) {
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  const startX = source.x + source.width / 2;
  const endX = target.x - target.width / 2;
  const control = Math.max(42, Math.abs(endX - startX) * 0.5);
  path.setAttribute("d", `M ${startX} ${source.y} C ${startX + control} ${source.y}, ${endX - control} ${target.y}, ${endX} ${target.y}`);
  path.setAttribute("class", "graph-edge");
  svg.appendChild(path);

  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.setAttribute("x", `${(source.x + target.x) / 2}`);
  label.setAttribute("y", `${(source.y + target.y) / 2 - 5}`);
  label.setAttribute("text-anchor", "middle");
  label.setAttribute("class", "edge-label");
  label.textContent = edgeTypeLabel(edge.type);
  svg.appendChild(label);
}

function drawNode(svg, node) {
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  group.setAttribute("class", "graph-node");
  group.setAttribute("transform", `translate(${node.x - node.width / 2}, ${node.y - node.height / 2})`);
  group.addEventListener("click", () => {
    state.selectedNode = node;
    elements.nodeDetails.textContent = `${node.label || node.id} | ${nodeTypeLabel(node)}${node.path ? ` | ${node.path}${node.line ? `:${node.line}` : ""}` : ""}`;
  });

  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("width", `${node.width}`);
  rect.setAttribute("height", `${node.height}`);
  rect.setAttribute("fill", colorForNode(node));
  rect.setAttribute("stroke", strokeForNode(node));
  group.appendChild(rect);

  const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
  text.setAttribute("x", `${node.width / 2}`);
  text.setAttribute("y", `${node.height / 2 + 4}`);
  text.setAttribute("text-anchor", "middle");
  text.textContent = compactLabel(node.label || node.path || node.id);
  group.appendChild(text);
  svg.appendChild(group);
}

function drawEmpty(svg, width, height) {
  const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
  text.setAttribute("x", `${width / 2}`);
  text.setAttribute("y", `${height / 2}`);
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("fill", "#65716c");
  text.setAttribute("font-size", "14");
  text.setAttribute("font-weight", "680");
  text.textContent = "아직 로컬 영향 그래프가 없습니다.";
  svg.appendChild(text);
}

function colorForNode(node) {
  if (node.type === "policy") return "#f8dedb";
  if (node.type?.startsWith("changed")) return "#dce9df";
  if (node.group === "tests") return "#dce5f1";
  if (node.group === "docs") return "#efe6cf";
  if (node.type === "route") return "#e6e0f1";
  return "#fffefa";
}

function strokeForNode(node) {
  if (node.type === "policy") return "#ad3131";
  if (node.type?.startsWith("changed")) return "#28705f";
  if (node.group === "tests") return "#2c5b8d";
  if (node.group === "docs") return "#a7671e";
  if (node.type === "route") return "#5a4f83";
  return "#d7d1c4";
}

function emptyAnalysis(repo) {
  return {
    repo,
    risk: "low",
    uncertainty: "low",
    recommendation: "auto_log",
    summary: "기준점 이후 감지된 로컬 변경이 없습니다.",
    changes: { files: [], symbols: {} },
    policyHits: [],
    impact: {},
    graph: { nodes: [], edges: [] },
    contextPack: {}
  };
}

function formatSummary(analysis) {
  const changes = analysis.changes || {};
  const addedCount = (changes.added || []).length;
  const changedCount = (changes.modified || changes.files || []).length;
  const deletedCount = (changes.deleted || []).length;
  const symbolCount = Object.values(changes.symbols || {}).reduce((sum, symbols) => sum + symbols.length, 0);
  if (!addedCount && !changedCount && !deletedCount) return "기준점 이후 감지된 로컬 변경이 없습니다.";
  return `${addedCount}개 추가, ${changedCount}개 변경, ${deletedCount}개 삭제, ${symbolCount}개 심볼이 감지되어 ${riskLabel(analysis.risk || "low")} 위험으로 분류됐습니다.`;
}

function listItems(items = [], emptyText) {
  const values = (items || []).filter(Boolean);
  if (!values.length) return `<li>${escapeHtml(emptyText)}</li>`;
  return values.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

function riskLabel(value) {
  return { low: "낮음", medium: "중간", high: "높음", critical: "치명적" }[value] || value || "낮음";
}

function uncertaintyLabel(value) {
  return { low: "낮음", medium: "중간", high: "높음" }[value] || value || "낮음";
}

function routeLabel(value) {
  return {
    auto_log: "자동 기록",
    log_only: "감사 기록",
    owner_review: "담당자 리뷰",
    reviewer: "담당자 리뷰",
    human_review: "사람 리뷰",
    senior_review: "결정권자 리뷰",
    approver: "승인권자 승인",
    block: "차단",
    none: "추가 승인 없음"
  }[value] || value || "자동 기록";
}

function scopeleaserityLabel(value) {
  return {
    agent: "에이전트",
    audit_log: "감사 로그",
    owner_review: "담당자",
    reviewer: "담당자",
    human_review: "사람 리뷰어",
    senior_review: "결정권자",
    approver: "승인권자",
    block: "차단",
    none: "추가 승인 없음"
  }[value] || routeLabel(value);
}

function autoLabel(gate) {
  if (gate.canAutoApplyPatch && gate.canAutoCheckpoint) return "적용 및 체크포인트 가능";
  if (gate.canAutoApplyPatch) return "적용 가능, 체크포인트는 별도";
  if (gate.canAutoPreparePatch) return "초안 작성만 가능";
  return "자동 작업 차단";
}

function permissionSummary(gate) {
  if (gate.canAutoApplyPatch && gate.canAutoCheckpoint) return "자동 적용과 체크포인트가 모두 허용됩니다.";
  if (gate.canAutoApplyPatch) return "자동 적용은 가능하지만 체크포인트는 사용자가 확인한 뒤 갱신합니다.";
  if (gate.canAutoPreparePatch) return "자동 적용은 막고, 리뷰용 초안과 근거 정리만 허용합니다.";
  return "자동 작업을 진행하지 않습니다.";
}

function formatTokenEconomy(economy, pairSavings = {}, hookEstimate = {}) {
  if (!economy) {
    return {
      input: "-",
      agentInput: "-",
      savingsLabel: "Pair delta",
      actualSavings: "-",
      actualSavingsNote: "pair 관측 없음",
      tokenMode: "토큰 계측 없음",
      tokenMethod: "-",
      budget: "-",
      summary: "입력 후보 계측 없음",
      field: "contextPack.agentContext",
      visualGraph: "-",
      omittedSummary: "생략 정보 없음"
    };
  }
  const labels = economy.labels || {};
  const userRequest = labels.userRequest || formatTokenCount(economy.userRequestTokens);
  const agentInput = labels.agentInput || formatTokenCount(economy.agentContextTokens);
  const actualInput = labels.actualInput || formatTokenCount(economy.actualInputTokens || economy.agentContextTokens);
  const visualGraph = labels.visualGraph || formatTokenCount(economy.visualGraphTokens);
  const budget = labels.budget || formatTokenCount(economy.budget);
  const overBudget = labels.overBudget || formatTokenCount(economy.overBudgetTokens);
  const field = economy.agentInput?.field || "contextPack.agentContext";
  const actualField = economy.actualInput?.field || "codexInput.text";
  const budgetSummary = economy.budgetSummary || (economy.fitsBudget ? `예산 ${budget} 안에 들어옵니다.` : `예산 ${budget}보다 ${overBudget} 많습니다.`);
  const omittedSummary = formatOmittedSummary(economy.agentInput?.omitted);
  const tokenMode = economy.exactTokens ? "로컬 토큰 계측" : "fallback 계산";
  const tokenMethod = formatTokenizer(economy.tokenizer, tokenMode);
  const savingsDisplay = formatSavingsDisplay(pairSavings, hookEstimate);
  return {
    input: `${actualInput} (${actualField})`,
    userRequest,
    agentInput,
    actualInput,
    tokenMode,
    tokenMethod,
    savingsLabel: savingsDisplay.label,
    actualSavings: savingsDisplay.value,
    actualSavingsNote: savingsDisplay.note,
    budget: `${budget} / ${budgetSummary}`,
    summary: economy.summary || `사용자 원문은 ${userRequest}이고 agent 입력 후보는 ${actualInput}입니다. 실제 pair delta는 같은 work intent의 default-codex 관측 입력 n과 scopelease-codex 관측 입력 m을 비교해 계산하고, 양수일 때만 절감률입니다.`,
    field,
    actualField,
    visualGraph,
    omittedSummary
  };
}

function formatTokenizer(tokenizer = {}, fallback = "fallback 계산") {
  if (!tokenizer || !Object.keys(tokenizer).length) return fallback;
  const method = tokenizer.method || (tokenizer.exact ? "tiktoken" : "fallback");
  const encoding = tokenizer.encoding ? `:${tokenizer.encoding}` : "";
  const source = tokenizer.source ? ` · ${tokenizer.source}` : "";
  const error = tokenizer.error ? ` · ${tokenizer.error}` : "";
  return `${method}${encoding}${source}${error}`;
}

function formatAgentInputPayload(context = {}) {
  const economy = context.tokenEconomy || {};
  const codexInput = context.codexInput || {};
  return {
    kind: "scopelease.agent_input",
    field: codexInput.field || economy.actualInput?.field || "codexInput.text",
    generatedAt: context.generatedAt,
    repo: context.repo,
    summary: codexInput.summary || economy.summary || context.summary || "",
    budgetSummary: economy.budgetSummary || "",
    codexInput,
    contextLedger: context.contextLedger || {},
    artifacts: context.artifacts || {},
    structuredContext: {
      field: economy.agentInput?.field || "contextPack.agentContext",
      tokens: economy.agentInput?.tokens || economy.agentContextTokens || 0,
      label: economy.agentInput?.label || economy.labels?.agentInput || "0k",
      input: context.agentContext || {}
    },
    tokenEconomy: {
      unit: economy.unit || "tokens",
      labels: economy.labels || {},
      agentInput: economy.agentInput || {},
      actualInput: economy.actualInput || {},
      claim: economy.claim || {},
      userRequestTokens: economy.userRequestTokens || codexInput.userRequest?.tokens || 0,
      fullRepoTokens: economy.fullRepoTokens || 0,
      agentContextTokens: economy.agentContextTokens || 0,
      actualInputTokens: economy.actualInputTokens || codexInput.tokens || 0,
      exactTokens: Boolean(economy.exactTokens),
      tokenizer: economy.tokenizer || {},
      fullRepoChars: economy.fullRepoChars || 0,
      agentContextChars: economy.agentContextChars || 0,
      actualInputChars: economy.actualInputChars || codexInput.chars || 0,
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
    decisionGate: context.decisionGate || null,
    usefulness: context.usefulness || null,
    input: context.agentContext || {}
  };
}

function renderAgentInputSummary(context, tokenCopy, payload) {
  const gate = context.decisionGate || {};
  const usefulness = context.usefulness || {};
  const codexInput = context.codexInput || payload.codexInput || {};
  const labels = context.tokenEconomy?.labels || {};
  const userRequest = labels.userRequest || formatTokenCount(context.tokenEconomy?.userRequestTokens);
  const agentInput = labels.agentInput || tokenCopy.agentInput;
  const actualInput = labels.actualInput || codexInput.label || formatTokenCount(context.tokenEconomy?.actualInputTokens);
  const primaryCopy = context.tokenEconomy
    ? `사용자 원문은 ${userRequest}이고 agent 입력 후보는 ${actualInput}입니다. 근거 JSON 구성 요소는 ${agentInput}입니다. 실제 pair delta는 같은 work intent의 default-codex 입력 n과 scopelease-codex 입력 m을 관측한 뒤 계산하고, 양수일 때만 절감률입니다.`
    : "분석 결과가 준비되면 agent 입력 후보와 관측 pair 기준을 여기에서 먼저 보여줍니다.";
  const graphCopy = tokenCopy.visualGraph && tokenCopy.visualGraph !== "-"
    ? `화면용 그래프 JSON ${tokenCopy.visualGraph}와 원본 파일 본문은 agent 입력 후보에서 제외합니다.`
    : "화면용 그래프 JSON과 원본 파일 본문은 agent 입력 후보에서 제외합니다.";
  const cells = [
    ["Agent 입력 필드", codexInput.field || tokenCopy.actualField || "codexInput.text"],
    ["근거 JSON", tokenCopy.field],
    ["권한", gate.scopeleaseritySummary || gate.permissionSummary || permissionSummary(gate)],
    ["자동화", formatAutomation(gate)],
    ["예산", tokenCopy.budget],
    ["생략", tokenCopy.omittedSummary],
    ["다음 행동", usefulness.nextStep || "위험도가 올라가면 담당자 리뷰나 승인 단계로 넘깁니다."]
  ];

  return `
    <p><strong>Agent 입력 후보</strong>: ${escapeHtml(primaryCopy)} ${escapeHtml(graphCopy)}</p>
    <div class="agent-input-grid">
      ${cells.map(([label, value]) => `
        <div class="agent-input-cell">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value || "-")}</strong>
        </div>
      `).join("")}
    </div>
    <p class="agent-input-note">${escapeHtml(usefulness.headline || "판단에 필요한 요약, 우선순위 컨텍스트, 정책 근거, 권한 상태만 남긴 가벼운 payload입니다.")}</p>
    <p class="agent-input-note">아래 JSON은 <code>${escapeHtml(payload.field || "codexInput.text")}</code>, 경로 근거, 권한 기준을 함께 담은 확인용 payload입니다.</p>
  `;
}

function formatAutomation(gate = {}) {
  if (!gate || !Object.keys(gate).length) return "-";
  if (gate.automationLabel) return gate.automationLabel;
  const enforcement = gate.enforcement;
  if (typeof enforcement === "string") return enforcement;
  if (enforcement && typeof enforcement === "object") {
    const may = Array.isArray(enforcement.agentMay) ? enforcement.agentMay.join(", ") : "";
    const mustNot = Array.isArray(enforcement.agentMustNot) ? enforcement.agentMustNot.join(", ") : "";
    return [
      enforcement.decisionOwner ? `${enforcement.decisionOwner} 결정` : "",
      may ? `허용: ${may}` : "",
      mustNot ? `차단: ${mustNot}` : ""
    ].filter(Boolean).join(" · ");
  }
  return autoLabel(gate);
}

function formatUsefulness(usefulness) {
  if (!usefulness) {
    return { headline: "분석 결과가 준비되면 쓸 이유와 제한을 함께 보여줍니다." };
  }
  return {
    headline: usefulness.headline || usefulness.label || usefulness.verdict || "쓸 이유 판정 없음"
  };
}

function formatOmittedSummary(omitted = {}) {
  const labels = {
    changedFiles: "변경 파일",
    changedSymbols: "변경 심볼",
    priorityContext: "우선순위 항목",
    policyHits: "정책 항목"
  };
  const parts = Object.entries(omitted || {})
    .filter(([, count]) => Number(count || 0) > 0)
    .map(([key, count]) => `${labels[key] || key} ${Number(count).toLocaleString("ko-KR")}개`);
  if (!parts.length) return "input에서 생략된 우선순위 항목은 없습니다.";
  return `input을 가볍게 유지하려고 ${parts.join(", ")}를 상세 목록에서 제외했습니다. 전체 그래프와 원본 파일은 화면과 저장소에 남아 있습니다.`;
}

function formatTokenCount(value) {
  const tokens = Number(value || 0);
  if (!Number.isFinite(tokens) || tokens <= 0) return "0k";
  const scaled = tokens / 1000;
  const fixed = scaled < 10 ? scaled.toFixed(2) : scaled.toFixed(1);
  return `${trimTrailingZero(fixed)}k`;
}

function trimTrailingZero(value) {
  return String(Number(value));
}

function priorityReasonLabel(reason) {
  return {
    "changed since baseline": "기준점 이후 변경됨",
    "imports changed file": "변경 파일을 호출함",
    "test edge points to changed file": "변경 파일을 검증하는 테스트",
    "mentions changed symbol": "변경 심볼을 언급하는 문서"
  }[reason] || reason;
}

function nodeTypeLabel(node) {
  if (node.type === "policy") return "정책";
  if (node.type?.startsWith("changed")) return "변경";
  if (node.group === "tests") return "테스트";
  if (node.group === "docs") return "문서";
  if (node.type === "route") return "라우트";
  if (node.type === "file") return "파일";
  return node.type || "노드";
}

function edgeTypeLabel(type) {
  return {
    defines: "정의",
    imports: "가져옴",
    imported_by: "호출됨",
    route: "라우트",
    defined_by: "구현",
    tests: "검증",
    mentions: "언급",
    policy_hit: "정책"
  }[type] || type;
}

function compactLabel(value) {
  if (value.length <= 24) return value;
  const parts = value.split("/");
  const last = parts.at(-1);
  return last.length <= 24 ? last : `${last.slice(0, 21)}...`;
}

function labelWidth(value) {
  return 28 + Math.min(28, value.length) * 7;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

refresh();
setInterval(refresh, 1400);
