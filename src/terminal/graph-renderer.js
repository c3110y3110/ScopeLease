const RISK_COLOR = {
  low: 32,
  medium: 34,
  high: 33,
  critical: 31
};

export function renderTerminalGraph(analysis, options = {}) {
  const color = options.color !== false;
  const width = Number(options.width || process.stdout.columns || 100);
  const lines = [];
  const risk = analysis.risk || "low";
  const riskText = paint(riskLabel(risk), RISK_COLOR[risk] || 37, color);

  lines.push(`${bold("SCOPELEASE LOCAL GRAPH", color)}  위험=${riskText}  라우팅=${routeLabel(analysis.recommendation || "auto_log")}  불확실성=${uncertaintyLabel(analysis.uncertainty || "low")}`);
  lines.push(`루트: ${truncate(analysis.repo || "", width - 6)}`);
  lines.push(`시각: ${formatTime(analysis.generatedAt)}  기준점=${formatTime(analysis.baselineAt)}`);
  lines.push("");
  lines.push(truncate(analysis.summary || "기준점 이후 감지된 로컬 변경이 없습니다.", width));
  lines.push("");

  appendDecisionBrief(lines, analysis, color, width);
  lines.push("");
  appendChangedTree(lines, analysis, color, width);
  appendImpactTree(lines, analysis, color, width);
  appendPolicies(lines, analysis, color, width);
  appendReview(lines, analysis, color, width);

  return `${lines.join("\n")}\n`;
}

export function renderTerminalMap(analysis, options = {}) {
  const color = options.color !== false;
  const width = Number(options.width || process.stdout.columns || 100);
  const centerWidth = clamp(Math.floor(width * 0.34), 28, 42);
  const sideWidth = clamp(Math.floor((width - centerWidth - 10) / 2), 24, 38);
  const risk = analysis.risk || "low";
  const lines = [];

  lines.push(`${bold("SCOPELEASE KG MAP", color)}  위험=${paint(riskLabel(risk), RISK_COLOR[risk] || 37, color)}  라우팅=${routeLabel(analysis.recommendation || "auto_log")}  불확실성=${uncertaintyLabel(analysis.uncertainty || "low")}`);
  lines.push(`루트: ${truncate(analysis.repo || "", width - 6)}`);
  lines.push(`시각: ${formatTime(analysis.generatedAt)}  기준점=${formatTime(analysis.baselineAt)}`);
  lines.push("");

  appendDecisionBrief(lines, analysis, color, width);
  lines.push("");
  const left = buildLeftMapLines(analysis, sideWidth);
  const center = buildCenterMapLines(analysis, centerWidth);
  const right = buildRightMapLines(analysis, sideWidth);
  const max = Math.max(left.length, center.length, right.length);
  const leftArrow = " --정책--> ";
  const rightArrow = " --영향--> ";

  for (let index = 0; index < max; index += 1) {
    const l = left[index] || " ".repeat(sideWidth);
    const c = center[index] || " ".repeat(centerWidth);
    const r = right[index] || " ".repeat(sideWidth);
    const midLeft = index === Math.floor(max / 2) ? leftArrow : " ".repeat(leftArrow.length);
    const midRight = index === Math.floor(max / 2) ? rightArrow : " ".repeat(rightArrow.length);
    lines.push(`${l}${midLeft}${c}${midRight}${r}`);
  }

  lines.push("");
  lines.push(buildSpokeSummary(analysis, color, width));
  lines.push("");
  appendReview(lines, analysis, color, width);
  return `${lines.join("\n")}\n`;
}

export function renderTerminalRadial(analysis, options = {}) {
  const color = options.color !== false;
  const width = Number(options.width || process.stdout.columns || 100);
  const risk = analysis.risk || "low";
  const lines = [];
  const center = centerLabel(analysis);
  const routes = formatRadialGroup("라우트", analysis.impact?.routes);
  const policies = formatPolicyGroup(analysis.policyHits);
  const tests = formatRadialGroup("테스트", analysis.impact?.tests);
  const docs = formatRadialGroup("문서", analysis.impact?.docs);
  const importedBy = formatRadialGroup("호출", analysis.impact?.importedBy);
  const imports = formatRadialGroup("의존", analysis.impact?.imports);

  lines.push(`${bold("SCOPELEASE RADIAL KG", color)}  위험=${paint(riskLabel(risk), RISK_COLOR[risk] || 37, color)}  라우팅=${routeLabel(analysis.recommendation || "auto_log")}  불확실성=${uncertaintyLabel(analysis.uncertainty || "low")}`);
  lines.push(`루트: ${truncate(analysis.repo || "", width - 6)}`);
  lines.push(`시각: ${formatTime(analysis.generatedAt)}  기준점=${formatTime(analysis.baselineAt)}`);
  lines.push("");

  const mapWidth = Math.min(width, 112);
  const mid = Math.floor(mapWidth / 2);
  const centerBox = `[변경] ${center}`;
  const top = routes[0] || "(라우트 근거 없음)";
  const left = policies[0] || "(정책 없음)";
  const right = importedBy[0] || tests[0] || "(호출/테스트 없음)";
  const bottom = docs[0] || imports[0] || "(문서/의존 없음)";

  lines.push(centered(top, mapWidth));
  lines.push(centered("^", mapWidth));
  lines.push(centered("| 라우트/의존 경로", mapWidth));
  lines.push(`${truncate(left, mid - 4).padEnd(mid - 4, " ")} <--정책-- ${truncate(centerBox, Math.min(38, mapWidth - mid - 15)).padEnd(Math.min(38, mapWidth - mid - 15), " ")} --영향--> ${truncate(right, Math.max(18, mapWidth - mid - 39))}`);
  lines.push(centered("|", mapWidth));
  lines.push(centered("v", mapWidth));
  lines.push(centered(bottom, mapWidth));

  const extra = [...routes.slice(1), ...importedBy.slice(1), ...tests.slice(1), ...docs.slice(1), ...imports.slice(1), ...policies.slice(1)];
  if (extra.length) {
    lines.push("");
    lines.push(bold("추가 근거", color));
    for (const item of extra.slice(0, 8)) lines.push(`  + ${truncate(item, width - 4)}`);
  }

  lines.push("");
  appendDecisionBrief(lines, analysis, color, width);
  lines.push("");
  lines.push(buildSpokeSummary(analysis, color, width));
  lines.push("");
  appendEvidencePaths(lines, analysis, color, width);
  lines.push("");
  appendReview(lines, analysis, color, width);
  return `${lines.join("\n")}\n`;
}

export function renderDotGraph(analysis) {
  const graph = analysis.graph || { nodes: [], edges: [] };
  const lines = ["digraph scopelease {", "  rankdir=LR;", "  node [shape=box, style=rounded];"];

  for (const node of graph.nodes) {
    lines.push(`  "${escapeDot(node.id)}" [label="${escapeDot(node.label || node.path || node.id)}"];`);
  }

  for (const edge of graph.edges) {
    lines.push(`  "${escapeDot(edge.source)}" -> "${escapeDot(edge.target)}" [label="${escapeDot(edge.type)}"];`);
  }

  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function centerLabel(analysis) {
  const files = analysis.changes?.files || [];
  if (!files.length) return "변경 파일 없음";
  if (files.length === 1) return files[0];
  return `${files[0]} (+${files.length - 1})`;
}

function formatRadialGroup(label, nodes = []) {
  return nodes.map((node) => {
    const target = node.path && node.label !== node.path
      ? `${node.label} (${node.path}${node.line ? `:${node.line}` : ""})`
      : `${node.path || node.label}${node.line ? `:${node.line}` : ""}`;
    return `[${label}] ${target}`;
  });
}

function formatPolicyGroup(policyHits = []) {
  return policyHits.map((hit) => `[정책] ${hit.ruleId} (${riskLabel(hit.risk)})`);
}

function centered(value, width) {
  const text = truncate(value, width);
  const left = Math.max(0, Math.floor((width - text.length) / 2));
  return `${" ".repeat(left)}${text}`;
}

function appendEvidencePaths(lines, analysis, color, width) {
  const paths = analysis.impact?.paths || [];
  lines.push(bold("근거 경로", color));
  if (!paths.length) {
    lines.push("  (잡힌 근거 경로 없음)");
    return;
  }

  for (const path of paths.slice(0, 10)) {
    lines.push(`  ${pathKindLabel(path.kind).padEnd(11, " ")} ${truncate(path.summary, width - 15)}`);
  }
}

function appendDecisionBrief(lines, analysis, color, width) {
  const gate = analysis.contextPack?.decisionGate;
  const economy = analysis.contextPack?.tokenEconomy;
  const usefulness = analysis.contextPack?.usefulness;
  const title = gate?.statusLabel || routeLabel(analysis.recommendation || "auto_log");
  const input = economy?.labels?.actualInput || economy?.labels?.agentInput || "-";
  const tokenMode = economy?.exactTokens ? "직접" : "계산";
  const budget = economy?.budgetSummary || "예산 정보 없음";
  const scopeleaserity = gate?.scopeleaseritySummary || gate?.permissionSummary || "권한 정보 없음";
  const reason = usefulness?.headline || "쓸 이유 판정 없음";

  lines.push(bold("결정", color));
  lines.push(`  상태   ${truncate(title, width - 9)}`);
  lines.push(`  input  ${input} ${tokenMode}  delta default/scopelease pair 필요  ${truncate(budget, Math.max(12, width - 42))}`);
  lines.push(`  권한   ${truncate(scopeleaserity, width - 9)}`);
  lines.push(`  이유   ${truncate(reason, width - 9)}`);
}

function buildLeftMapLines(analysis, width) {
  const policies = analysis.policyHits?.length
    ? analysis.policyHits.map((hit) => `! ${hit.ruleId} (${riskLabel(hit.risk)})`)
    : ["걸린 정책 없음"];
  return boxed("정책", policies, width);
}

function buildCenterMapLines(analysis, width) {
  const files = analysis.changes?.files || [];
  const body = [];
  if (!files.length) {
    body.push("변경 파일 없음");
  }

  for (const file of files.slice(0, 3)) {
    body.push(`* ${file}`);
    const symbols = analysis.changes?.symbols?.[file] || [];
    for (const symbol of symbols.slice(0, 5)) {
      body.push(`  + ${symbolTypeLabel(symbol.type)} ${symbol.name}:${symbol.line}`);
    }
  }

  return boxed("변경", body, width);
}

function buildRightMapLines(analysis, width) {
  const impact = analysis.impact || {};
  const body = [
    ...formatNodes("route", impact.routes),
    ...formatNodes("imported_by", impact.importedBy),
    ...formatNodes("imports", impact.imports),
    ...formatNodes("tested_by", impact.tests),
    ...formatNodes("docs", impact.docs)
  ];
  return boxed("영향", body.length ? body : ["직접 영향 근거 없음"], width);
}

function formatNodes(label, nodes = []) {
  return nodes.map((node) => {
    const target = node.path && node.label !== node.path
      ? `${node.label} (${node.path}${node.line ? `:${node.line}` : ""})`
      : `${node.path || node.label}${node.line ? `:${node.line}` : ""}`;
    return `${impactLabel(label)}: ${target}`;
  });
}

function boxed(title, body, width) {
  const topTitle = ` ${title} `;
  const top = `+${topTitle}${"-".repeat(Math.max(0, width - topTitle.length - 2))}+`;
  const bottom = `+${"-".repeat(width - 2)}+`;
  const lines = [top];

  for (const item of body.slice(0, 8)) {
    lines.push(`| ${truncate(item, width - 4).padEnd(width - 4, " ")} |`);
  }

  if (body.length > 8) {
    lines.push(`| ${`... 외 ${body.length - 8}개`.padEnd(width - 4, " ")} |`);
  }

  lines.push(bottom);
  return lines;
}

function buildSpokeSummary(analysis, color, width) {
  const graph = analysis.graph || { nodes: [], edges: [] };
  const impact = analysis.impact || {};
  const text = [
    `${graph.nodes.length} 노드`,
    `${graph.edges.length} 관계`,
    `${(impact.routes || []).length} 라우트`,
    `${(impact.tests || []).length} 테스트`,
    `${(impact.docs || []).length} 문서`,
    `${(analysis.policyHits || []).length} 정책`
  ].join(" | ");
  return truncate(`${paint("근거", 36, color)}: ${text}`, width);
}

function appendChangedTree(lines, analysis, color, width) {
  lines.push(bold("변경", color));
  const files = analysis.changes?.files || [];
  if (!files.length) {
    lines.push("  (변경 없음)");
    lines.push("");
    return;
  }

  for (const file of files) {
    lines.push(`  ${paint("*", 36, color)} ${truncate(file, width - 4)}`);
    const symbols = analysis.changes?.symbols?.[file] || [];
    for (const symbol of symbols) {
      lines.push(`    + ${symbolTypeLabel(symbol.type)} ${truncate(symbol.name, width - 18)}:${symbol.line}`);
    }
  }

  if (analysis.changes?.deleted?.length) {
    for (const file of analysis.changes.deleted) {
      lines.push(`  - 삭제 ${truncate(file, width - 12)}`);
    }
  }
  lines.push("");
}

function appendImpactTree(lines, analysis, color, width) {
  lines.push(bold("영향", color));
  const impact = analysis.impact || {};
  const groups = [
    ["route", impact.routes],
    ["imported_by", impact.importedBy],
    ["imports", impact.imports],
    ["tested_by", impact.tests],
    ["docs", impact.docs]
  ];
  let count = 0;

  for (const [label, nodes = []] of groups) {
    for (const node of nodes) {
      count += 1;
      const target = node.path && node.label !== node.path
        ? `${node.label} (${node.path}${node.line ? `:${node.line}` : ""})`
        : `${node.path || node.label}${node.line ? `:${node.line}` : ""}`;
      lines.push(`  +-> ${padLabel(impactLabel(label))} ${truncate(target, width - 20)}`);
    }
  }

  if (count === 0) lines.push("  (직접 영향 근거 없음)");
  lines.push("");
}

function appendPolicies(lines, analysis, color, width) {
  lines.push(bold("정책", color));
  if (!analysis.policyHits?.length) {
    lines.push("  (걸린 정책 없음)");
    lines.push("");
    return;
  }

  for (const hit of analysis.policyHits) {
    const risk = paint(riskLabel(hit.risk), RISK_COLOR[hit.risk] || 37, color);
    lines.push(`  ! ${truncate(hit.ruleId, 34)} ${risk} -> ${routeLabel(hit.route)}`);
    if (hit.reason) lines.push(`    ${truncate(hit.reason, width - 4)}`);
  }
  lines.push("");
}

function appendReview(lines, analysis, color, width) {
  lines.push(bold("리뷰 초점", color));
  const items = analysis.contextPack?.priorityContext || [];
  if (!items.length) {
    lines.push("  (리뷰 초점 없음)");
    return;
  }

  for (const item of items.slice(0, 8)) {
    lines.push(`  ? ${truncate(item.path, 40)}  ${truncate(priorityReasonLabel(item.reason), width - 46)}`);
  }
}

function padLabel(value) {
  return value.padEnd(11, " ");
}

function formatTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleTimeString();
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

function symbolTypeLabel(value) {
  return { function: "함수", type: "타입", class: "클래스", const: "상수", variable: "변수" }[value] || value;
}

function impactLabel(value) {
  return {
    route: "라우트",
    imported_by: "호출",
    imports: "의존",
    tested_by: "테스트",
    docs: "문서"
  }[value] || value;
}

function pathKindLabel(value) {
  return {
    defines: "정의",
    route: "라우트",
    test: "테스트",
    doc: "문서",
    policy: "정책",
    imported_by: "호출 영향",
    imports: "의존",
    mentions: "언급"
  }[value] || value;
}

function priorityReasonLabel(value) {
  return {
    "changed since baseline": "기준점 이후 변경됨",
    "imports changed file": "변경 파일을 호출함",
    "test edge points to changed file": "변경 파일을 검증하는 테스트",
    "mentions changed symbol": "변경 심볼을 언급하는 문서"
  }[value] || value;
}

function truncate(value, width) {
  const text = String(value);
  if (text.length <= width) return text;
  if (width <= 3) return text.slice(0, width);
  return `${text.slice(0, width - 3)}...`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function bold(value, enabled) {
  return enabled ? `\x1b[1m${value}\x1b[0m` : value;
}

function paint(value, code, enabled) {
  return enabled ? `\x1b[${code}m${value}\x1b[0m` : value;
}

function escapeDot(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}
