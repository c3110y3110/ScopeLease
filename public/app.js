import {
  buildHookSavingsEstimate,
  buildObservedWorkIntentSavings,
  formatSavingsDisplay,
  formatObservedSavings
} from "./savings.js";

const LOCALE_STORAGE_KEY = "scopelease.locale";

const state = {
  selectedNode: null,
  latest: null,
  activeScreen: "overview",
  latestData: null,
  locale: initialLocale()
};

const elements = {
  repoPath: document.querySelector("#repoPath"),
  localeButtons: Array.from(document.querySelectorAll("[data-locale-option]")),
  screenTabs: Array.from(document.querySelectorAll("[data-screen-tab]")),
  screenViews: Array.from(document.querySelectorAll("[data-screen-view]")),
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
  statusUpdated: document.querySelector("#statusUpdated"),
  boundaryCards: document.querySelector("#boundaryCards"),
  readPlanList: document.querySelector("#readPlanList"),
  avoidPlanList: document.querySelector("#avoidPlanList"),
  graphHintList: document.querySelector("#graphHintList"),
  decisionStatusPill: document.querySelector("#decisionStatusPill"),
  decisionHeadline: document.querySelector("#decisionHeadline"),
  decisionSummary: document.querySelector("#decisionSummary"),
  allowedActionList: document.querySelector("#allowedActionList"),
  blockedActionList: document.querySelector("#blockedActionList"),
  stopConditionList: document.querySelector("#stopConditionList"),
  evidenceCards: document.querySelector("#evidenceCards"),
  agentInputMetrics: document.querySelector("#agentInputMetrics"),
  inputOrderList: document.querySelector("#inputOrderList"),
  promptPreview: document.querySelector("#promptPreview")
};

const UI_TRANSLATION_PAIRS = [
  ["ScopeLease Decision Layer", "ScopeLease 결정 레이어"],
  ["Reading local repository...", "로컬 저장소를 읽는 중..."],
  ["No connected repository.", "연결된 저장소가 없습니다."],
  ["Language", "언어"],
  ["Korean", "한국어"],
  ["Analyze", "분석"],
  ["Checkpoint", "체크포인트"],
  ["Live repository status", "실시간 저장소 상태"],
  ["Local live analysis", "로컬 실시간 분석"],
  ["Risk", "위험도"],
  ["Changes", "변경"],
  ["Graph", "그래프"],
  ["Updated", "갱신"],
  ["Overview", "개요"],
  ["Boundaries", "경계"],
  ["Decision", "결정"],
  ["Evidence", "근거"],
  ["Agent Input", "Agent 입력"],
  ["ScopeLease screen switcher", "ScopeLease 화면 전환"],
  ["Change Flow", "변경 흐름"],
  ["Impact Graph", "영향 그래프"],
  ["Changed files, symbols, tests, docs, routes, and policy hits are shown together.", "변경 파일, 심볼, 테스트, 문서, 라우트, 정책 근거를 함께 봅니다."],
  ["Graph legend", "그래프 범례"],
  ["Changed", "변경"],
  ["Route", "라우트"],
  ["Policy", "정책"],
  ["Local change impact graph", "로컬 변경 영향 그래프"],
  ["Select a node to inspect connected evidence.", "노드를 선택하면 연결 근거를 확인할 수 있습니다."],
  ["Decision Card", "결정 카드"],
  ["Agent Input Candidate", "Agent 입력 후보"],
  ["User request and KG evidence candidate produced as", "사용자 요청과 KG 근거 후보를"],
  ["Graph-scoped Boundaries", "그래프 기준 경계"],
  ["Read, review, permission, stop, and graph-scope boundaries for the same request.", "같은 요청 기준의 읽기, 검토, 권한, 중단, 그래프 범위를 나눠 봅니다."],
  ["Open Full KG", "전체 KG 열기"],
  ["Read First", "먼저 읽을 것"],
  ["Avoid Scope", "피할 범위"],
  ["Graph-query-first Hints", "Graph-query-first 힌트"],
  ["Decision And Approval Boundary", "결정 및 승인 경계"],
  ["Approval owner, allowed actions, blocked actions, and stop/re-ask conditions in one view.", "승인 주체, 허용 작업, 차단 작업, 중단/재질문 조건을 한 화면에서 확인합니다."],
  ["Waiting", "대기"],
  ["Waiting for analysis.", "분석 결과를 기다리는 중입니다."],
  ["When the decision card is ready, this view shows what the agent may do and when it must stop.", "결정 카드가 준비되면 에이전트가 할 수 있는 일과 멈춰야 하는 조건을 보여줍니다."],
  ["Allowed", "허용"],
  ["Blocked", "차단"],
  ["Stop / Re-ask Conditions", "중단 / 재질문 조건"],
  ["Evidence With Claim Boundaries", "주장 경계가 붙은 근거"],
  ["Each useful result is shown with the boundary of what it can claim.", "각 결과가 어디까지 주장 가능한지와 함께 표시됩니다."],
  ["Input Size", "입력 크기"],
  ["Read Order", "읽기 순서"],
  ["Prompt Preview", "프롬프트 미리보기"],
  ["Inspect the compact contract and read order instead of handing the full graph to the agent.", "전체 그래프 대신 에이전트에게 줄 compact contract와 읽기 순서를 확인합니다."],
  ["No local changes yet.", "아직 로컬 변경이 없습니다."],
  ["After a checkpoint, modified files appear here as the change flow.", "체크포인트 이후 수정 파일이 변경 흐름으로 표시됩니다."],
  ["No graph yet. Index the repo or create local changes after a checkpoint.", "아직 그래프가 없습니다. 저장소를 인덱싱하거나 체크포인트 이후 로컬 변경을 만드세요."],
  ["No local impact graph yet.", "아직 로컬 영향 그래프가 없습니다."],
  ["The current local impact graph has", "현재 로컬 영향 그래프는"],
  ["Decision needed", "결정 필요"],
  ["Authority And Automation", "권한 및 자동화"],
  ["Context Boundary", "컨텍스트 경계"],
  ["Why It Helps", "도움이 되는 이유"],
  ["Changed Files", "변경 파일"],
  ["Changed Symbols", "변경 심볼"],
  ["Policy Evidence", "정책 근거"],
  ["Next Checks", "다음 확인"],
  ["Must-review Files", "반드시 검토할 파일"],
  ["Uncertainty", "불확실성"],
  ["Authority", "권한"],
  ["Routing", "라우팅"],
  ["Automation", "자동화"],
  ["Agent input candidate", "Agent 입력 후보"],
  ["Pair delta", "Pair delta"],
  ["Basis", "계산 기준"],
  ["Budget", "예산"],
  ["Review boundary", "검토 경계"],
  ["Permission boundary", "권한 경계"],
  ["Stop boundary", "중단 경계"],
  ["Graph scope", "그래프 범위"],
  ["Summary", "요약"],
  ["Candidate field", "후보 필드"],
  ["Visual graph JSON", "화면용 그래프 JSON"],
  ["is excluded from the default agent input.", "는 기본 agent 입력에서 제외됩니다."],
  ["Senior reviewer", "결정권자"],
  ["Waiting for baseline input", "기준 입력 대기"],
  ["Review the whole codebase using the ScopeLease analysis below, and apply needed fixes directly.", "아래 ScopeLease 분석을 기준으로 전체 코드베이스를 검토하고 필요한 수정은 직접 적용합니다."],
  ["When both default-codex input n and scopelease-codex input m are observed for the same work intent, ScopeLease calculates the pair delta. Only positive deltas count as savings.", "같은 work intent의 default-codex 입력 n과 scopelease-codex 입력 m이 모두 관측되면 pair delta를 계산합니다. 양수일 때만 절감률입니다."],
  ["The real pair delta compares observed default-codex input n with scopelease-codex input m for the same work intent, and only positive deltas count as savings.", "실제 pair delta는 같은 work intent의 default-codex 관측 입력 n과 scopelease-codex 관측 입력 m을 비교해 계산하며, 양수일 때만 절감률입니다."],
  ["This request is preparing ScopeLease context and authority boundaries.", "이 요청은 ScopeLease context와 authority 경계를 준비하는 요청입니다."],
  ["Interpreted as development work, ScopeLease context and authority boundaries preparation request.", "개발 작업으로 해석했고, ScopeLease context와 authority 경계를 준비하려는 요청입니다."],
  ["high-risk", "높은 위험"],
  ["Check whether the risk reason matches the actual request intent", "위험 이유가 실제 요청 의도와 맞는지만 확인"],
  ["if ambiguous, use prepare_only and leave only a draft/evidence", "모호하면 prepare_only로 초안/근거만 남기기"],
  ["files outside scope, network access, and checkpoints require a new decision", "scope 밖 파일, 네트워크, 체크포인트는 새 판단으로 분리"],
  ["No changed files since the checkpoint.", "체크포인트 이후 변경 파일이 없습니다."],
  ["No changed symbols to show.", "표시할 변경 심볼이 없습니다."],
  ["No current policy hits.", "현재 정책 매칭이 없습니다."],
  ["No separate review points under the current baseline.", "현재 기준점에서는 별도 검토 지점이 없습니다."],
  ["Current demo graph", "현재 데모 그래프"],
  ["Review frontier", "검토 frontier"],
  ["Permission fixtures", "권한 fixture"],
  ["Codex local main", "Codex local main"],
  ["Claude local main", "Claude local main"],
  ["Terminal-Bench selected panel", "Terminal-Bench 선택 패널"],
  ["local sidecar state, not a paper result", "로컬 sidecar 상태이며 논문 결과가 아님"],
  ["controlled review-card fixture", "통제된 review-card fixture"],
  ["fixture-level guard/ask/deny/lease behavior", "fixture 수준 guard/ask/deny/lease 동작"],
  ["local command-reported protocol, not provider billing", "로컬 command-reported 프로토콜이며 provider billing이 아님"],
  ["connection/completion evidence, not token savings", "연결/완료 근거이며 token 절감 근거가 아님"],
  ["Prompt", "프롬프트"],
  ["Structured", "구조화 컨텍스트"],
  ["kept out of default agent input", "기본 agent 입력에서 제외"],
  ["budget boundary", "예산 경계"],
  ["When analysis is ready, the agent prompt candidate appears here.", "분석이 준비되면 agent 프롬프트 후보가 여기에 표시됩니다."],
  ["User request: Review the whole codebase using the ScopeLease analysis below, and apply needed fixes directly.", "사용자 요청: 아래 ScopeLease 분석을 기준으로 전체 코드베이스를 검토하고 필요한 수정은 직접 적용합니다."],
  ["ScopeLease context: compact readPlan, avoidPlan, graphQueryHints, decisionGate, priorityContext, tokenEconomy, and guard boundaries for the attached repository.", "ScopeLease context: 연결된 저장소의 compact readPlan, avoidPlan, graphQueryHints, decisionGate, priorityContext, tokenEconomy, guard boundary입니다."],
  ["Boundary: visual graph JSON and raw file bodies stay local unless explicitly requested.", "경계: 명시적으로 요청하지 않으면 화면용 graph JSON과 원본 파일 본문은 로컬에 남습니다."]
];

elements.screenTabs.forEach((button) => {
  button.addEventListener("click", () => {
    setActiveScreen(button.dataset.screenTab || "overview");
  });
});

elements.localeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setLocale(button.dataset.localeOption || "en");
  });
});

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
  state.latestData = data;
  const analysis = data.latestAnalysis || emptyAnalysis(data.repo || "");
  elements.repoPath.textContent = data.repo || analysis.repo || "No connected repository.";
  renderStatus(analysis);
  renderTimeline(data.events || []);
  renderDecisionCard(analysis, data);
  renderContext(analysis.contextPack || {}, data);
  renderGraph(analysis.graph || { nodes: [], edges: [] });
  renderShowcaseScreens(analysis, data);
  applyLocaleToDocument();
}

function initialLocale() {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    return stored === "ko" ? "ko" : "en";
  } catch {
    return "en";
  }
}

function setLocale(locale) {
  state.locale = locale === "ko" ? "ko" : "en";
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, state.locale);
  } catch {
    // Ignore storage failures; the active page can still switch languages.
  }
  if (state.latestData) render(state.latestData);
  else applyLocaleToDocument();
}

function applyLocaleToDocument() {
  document.documentElement.lang = state.locale === "ko" ? "ko" : "en";
  document.title = translateUiText("ScopeLease Decision Layer");
  for (const button of elements.localeButtons) {
    const active = button.dataset.localeOption === state.locale;
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }
  translateNodeText(document.body);
  translateAttributes(document.body);
}

function translateUiText(value = "") {
  const text = String(value || "");
  if (!text) return text;
  const pairs = state.locale === "ko"
    ? UI_TRANSLATION_PAIRS
    : UI_TRANSLATION_PAIRS.map(([english, korean]) => [korean, english]);
  let result = text;
  for (const [from, to] of [...pairs].sort((left, right) => right[0].length - left[0].length)) {
    if (from) result = result.replaceAll(from, to);
  }
  const regexPairs = state.locale === "ko" ? KO_REGEX_TRANSLATIONS : EN_REGEX_TRANSLATIONS;
  for (const [pattern, replacement] of regexPairs) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

const KO_REGEX_TRANSLATIONS = [
  [/\bCritical\b/g, "치명적"],
  [/\bHigh\b/g, "높음"],
  [/\bMedium\b/g, "중간"],
  [/\bLow\b/g, "낮음"],
  [/\bcritical\b/g, "치명적"],
  [/\bhigh\b/g, "높음"],
  [/\bmedium\b/g, "중간"],
  [/\blow\b/g, "낮음"],
  [/\bNo extra approval\b/g, "추가 승인 없음"],
  [/\bAuto-log\b/g, "자동 기록"],
  [/\bAudit log\b/g, "감사 기록"],
  [/\bOwner review\b/g, "담당자 리뷰"],
  [/\bHuman review\b/g, "사람 리뷰"],
  [/\bSenior review\b/g, "결정권자 리뷰"],
  [/\bApprover review\b/g, "승인권자 승인"],
  [/\bApply and checkpoint allowed\b/g, "적용 및 체크포인트 가능"],
  [/\bApply allowed, checkpoint separate\b/g, "적용 가능, 체크포인트는 별도"],
  [/\bPrepare patch only\b/g, "초안 작성만 가능"],
  [/\bAutomated work blocked\b/g, "자동 작업 차단"],
  [/\b(\d+) shown \/ (\d+) nodes\b/g, "$1개 표시 / $2개 노드"],
  [/\b(\d+) nodes and (\d+) edges\b/g, "$1개 노드와 $2개 관계"],
  [/\b(\d+) nodes \/ (\d+) edges\b/g, "$1개 노드 / $2개 관계"],
  [/\b(\d+) added, (\d+) changed, (\d+) deleted, and (\d+) symbols detected; ([^.]+) risk\./g, "$1개 추가, $2개 변경, $3개 삭제, $4개 심볼 감지; $5 위험."],
  [/\b(\d+) added, (\d+) changed, (\d+) deleted, and (\d+) symbols detected; ([^.]+) 위험\./g, "$1개 추가, $2개 변경, $3개 삭제, $4개 심볼 감지; $5 위험."],
  [/\b(\d+) changed file\(s\), (\d+) deleted file\(s\), (\d+) visible symbol\(s\); ([^.]+) risk\./g, "$1개 변경 파일, $2개 삭제 파일, $3개 visible symbol; $4 위험."],
  [/\b(\d+) changed file\(s\), (\d+) deleted file\(s\), (\d+) visible symbol\(s\); ([^.]+) 위험\./g, "$1개 변경 파일, $2개 삭제 파일, $3개 visible symbol; $4 위험."],
  [/\b(\d+) changed files?, (\d+) deleted files?, (\d+) symbols detected; ([^.]+) risk\./g, "$1개 변경 파일, $2개 삭제 파일, $3개 심볼 감지; $4 위험."],
  [/\b(\d+) changed files?, (\d+) deleted files?, (\d+) symbols detected; ([^.]+) 위험\./g, "$1개 변경 파일, $2개 삭제 파일, $3개 심볼 감지; $4 위험."],
  [/\b(\d+)개 visible symbol\b/g, "$1개 표시 심볼"],
  [/\b(\d+) nodes\b/g, "$1개 노드"],
  [/\b(\d+) edges\b/g, "$1개 관계"],
  [/\b(\d+) files\b/g, "$1개 파일"],
  [/\b(\d+) changed files\b/g, "$1개 변경 파일"],
  [/\b(\d+) added, (\d+) changed, (\d+) deleted, and (\d+) symbols detected; classified as ([^.]+) risk\./g, "$1개 추가, $2개 변경, $3개 삭제, $4개 심볼 감지; $5 위험으로 분류됨."],
  [/\b([0-9.]+k) over budget ([0-9.]+k)\b/g, "예산 $2보다 $1 많음"],
  [/\bfits within budget ([0-9.]+k)\b/g, "예산 $1 안에 있음"],
  [/\b([0-9.]+k) \/ ([^/]+)\b/g, "$1 / $2"],
  [/\bchanged file\b/g, "변경 파일"],
  [/\brelated test\b/g, "관련 테스트"],
  [/\brelated doc\b/g, "관련 문서"],
  [/\bimports a changed file\b/g, "변경 파일을 호출함"],
  [/\btest covers a changed file\b/g, "변경 파일을 검증하는 테스트"],
  [/\bdoc mentions a changed symbol\b/g, "변경 심볼을 언급하는 문서"],
  [/\bchanged since baseline\b/g, "기준점 이후 변경됨"],
  [/\brisk\b/g, "위험"],
  [/\brequired\b/g, "필요"],
  [/\b(\d+) added, (\d+) changed, (\d+) deleted, and (\d+) symbols detected; ([^.]+) 위험\./g, "$1개 추가, $2개 변경, $3개 삭제, $4개 심볼 감지; $5 위험."],
  [/\b(\d+) added, (\d+) changed, (\d+) deleted, (\d+) symbols detected; ([^.]+) 위험\./g, "$1개 추가, $2개 변경, $3개 삭제, $4개 심볼 감지; $5 위험."],
  [/\b(\d+) changed file\(s\), (\d+) deleted file\(s\), (\d+) visible symbol\(s\); ([^.]+) 위험\./g, "$1개 변경 파일, $2개 삭제 파일, $3개 표시 심볼; $4 위험."],
  [/\b(\d+) added, (\d+) changed, (\d+) deleted, and (\d+) symbols detected; classified as ([^.]+) 위험\./g, "$1개 추가, $2개 변경, $3개 삭제, $4개 심볼 감지; $5 위험으로 분류됨."],
  [/\b(\d+) added, (\d+) changed, (\d+) deleted, (\d+) symbols detected; classified as ([^.]+) 위험\./g, "$1개 추가, $2개 변경, $3개 삭제, $4개 심볼 감지; $5 위험으로 분류됨."],
  [/(\d+)개 추가, (\d+)개 변경, (\d+)개 삭제, (\d+)개 심볼 감지; classified as ([^.]+) 위험\./g, "$1개 추가, $2개 변경, $3개 삭제, $4개 심볼 감지; $5 위험으로 분류됨."]
];

const EN_REGEX_TRANSLATIONS = [
  [/치명적/g, "Critical"],
  [/높음/g, "High"],
  [/중간/g, "Medium"],
  [/낮음/g, "Low"],
  [/추가 승인 없음/g, "No extra approval"],
  [/자동 기록/g, "Auto-log"],
  [/감사 기록/g, "Audit log"],
  [/담당자 리뷰/g, "Owner review"],
  [/사람 리뷰/g, "Human review"],
  [/결정권자 리뷰/g, "Senior review"],
  [/승인권자 승인/g, "Approver review"],
  [/적용 및 체크포인트 가능/g, "Apply and checkpoint allowed"],
  [/적용 가능, 체크포인트는 별도/g, "Apply allowed, checkpoint separate"],
  [/초안 작성만 가능/g, "Prepare patch only"],
  [/자동 작업 차단/g, "Automated work blocked"],
  [/(\d+)개 표시 \/ (\d+)개 노드/g, "$1 shown / $2 nodes"],
  [/(\d+)개 노드와 (\d+)개 관계/g, "$1 nodes and $2 edges"],
  [/(\d+)개 노드 \/ (\d+)개 관계/g, "$1 nodes / $2 edges"],
  [/(\d+)개 추가, (\d+)개 변경, (\d+)개 삭제, (\d+)개 심볼 감지; ([^.]+) 위험\./g, "$1 added, $2 changed, $3 deleted, and $4 symbols detected; $5 risk."],
  [/(\d+)개 변경 파일, (\d+)개 삭제 파일, (\d+)개 visible symbol; ([^.]+) 위험\./g, "$1 changed file(s), $2 deleted file(s), $3 visible symbol(s); $4 risk."],
  [/(\d+)개 표시 심볼/g, "$1 visible symbols"],
  [/(\d+)개 변경 파일, (\d+)개 삭제 파일, (\d+)개 심볼 감지; ([^.]+) 위험\./g, "$1 changed files, $2 deleted files, $3 symbols detected; $4 risk."],
  [/(\d+)개 변경 파일/g, "$1 changed files"],
  [/(\d+)개 파일/g, "$1 files"],
  [/(\d+)개 노드/g, "$1 nodes"],
  [/(\d+)개 관계/g, "$1 edges"],
  [/(\d+)개 추가, (\d+)개 변경, (\d+)개 삭제, (\d+)개 심볼 감지; ([^.]+) 위험으로 분류됨\./g, "$1 added, $2 changed, $3 deleted, and $4 symbols detected; classified as $5 risk."],
  [/예산 ([0-9.]+k)보다 ([0-9.]+k) 많음/g, "$2 over budget $1"],
  [/예산 ([0-9.]+k) 안에 있음/g, "fits within budget $1"],
  [/변경 파일/g, "changed file"],
  [/관련 테스트/g, "related test"],
  [/관련 문서/g, "related doc"],
  [/변경 파일을 호출함/g, "imports a changed file"],
  [/변경 파일을 검증하는 테스트/g, "test covers a changed file"],
  [/변경 심볼을 언급하는 문서/g, "doc mentions a changed symbol"],
  [/기준점 이후 변경됨/g, "changed since baseline"],
  [/위험/g, "risk"],
  [/필요/g, "required"]
];

function translateNodeText(root) {
  const excludedTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT"]);
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || excludedTags.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      return node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    }
  });
  const nodes = [];
  while (walk.nextNode()) nodes.push(walk.currentNode);
  for (const node of nodes) node.nodeValue = translateUiText(node.nodeValue);
}

function translateAttributes(root) {
  for (const node of root.querySelectorAll("[title], [aria-label], [alt]")) {
    for (const attribute of ["title", "aria-label", "alt"]) {
      if (!node.hasAttribute(attribute)) continue;
      node.setAttribute(attribute, translateUiText(node.getAttribute(attribute) || ""));
    }
  }
}

function setActiveScreen(screen) {
  state.activeScreen = screen;
  elements.screenTabs.forEach((button) => {
    const active = button.dataset.screenTab === screen;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  elements.screenViews.forEach((view) => {
    view.classList.toggle("is-active", view.dataset.screenView === screen);
  });
}

function renderStatus(analysis) {
  const changedCount = analysis.changes?.files?.length || 0;
  const graph = analysis.graph || { nodes: [], edges: [] };
  elements.statusRisk.textContent = riskLabel(analysis.risk || "low");
  elements.statusChanged.textContent = `${changedCount} files`;
  elements.statusGraph.textContent = `${graph.nodes.length} nodes / ${graph.edges.length} edges`;
  elements.statusUpdated.textContent = analysis.generatedAt ? formatTime(analysis.generatedAt) : "-";
}

function renderTimeline(events) {
  elements.eventCount.textContent = `${events.length}`;
  if (!events.length) {
    elements.timeline.innerHTML = `<li><strong>No local changes yet.</strong><span>After a checkpoint, modified files appear here as the change flow.</span></li>`;
    return;
  }

  elements.timeline.innerHTML = events.map((event) => `
    <li>
      <time>${formatTime(event.timestamp)}</time>
      <strong>${escapeHtml(displayText(event.summary))}</strong>
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
    `<li><strong>${escapeHtml(hit.ruleId)}</strong><br><span>${escapeHtml(riskLabel(hit.risk))} risk, ${escapeHtml(routeLabel(hit.route))} required. ${escapeHtml(displayText(hit.reason || "Policy matched."))}</span></li>`
  ).join("");

  const changedFiles = (analysis.changes?.files || []).map((file) => `<li>${escapeHtml(file)}</li>`).join("");
  const symbols = Object.values(analysis.changes?.symbols || {}).flat()
    .map((symbol) => `<li>${escapeHtml(symbol.name)} <span>(${escapeHtml(symbol.type)}, ${escapeHtml(symbol.path)}:${symbol.line})</span></li>`)
    .join("");
  const review = (analysis.contextPack?.priorityContext || [])
    .slice(0, 8)
    .map((item) => `<li>${escapeHtml(item.path)}<br><span>${escapeHtml(priorityReasonLabel(item.reason))}</span></li>`)
    .join("");
  const requiredChecks = listItems(gate?.requiredChecks, "No extra checks required.");
  const allowedActions = listItems(gate?.allowedActions, "Allowed actions appear after analysis is ready.");
  const blockedActions = listItems(gate?.blockedActions, gate?.canAutoApplyPatch ? "No automated actions are currently blocked." : "Blocked actions appear after analysis is ready.");
  const benefits = listItems(usefulness?.benefits, "No clear benefit has been calculated yet.");
  const limits = listItems(usefulness?.limits, "No major limitation is currently shown.");

  elements.riskBadge.textContent = riskLabel(analysis.risk || "low");
  elements.riskBadge.className = `risk ${analysis.risk || "low"}`;

  elements.decisionCard.innerHTML = `
    <dl class="kv">
      <dt>Risk</dt><dd>${escapeHtml(riskLabel(analysis.risk || "low"))}</dd>
      <dt>Uncertainty</dt><dd>${escapeHtml(uncertaintyLabel(analysis.uncertainty || "low"))}</dd>
      <dt>Authority</dt><dd>${escapeHtml(displayText(gate?.scopeleaserityLabel) || scopeleaserityLabel(gate?.scopeleaserity || "agent"))}</dd>
      <dt>Routing</dt><dd>${escapeHtml(displayText(gate?.routingLabel) || routeLabel(analysis.recommendation || "auto_log"))}</dd>
      <dt>Automation</dt><dd>${escapeHtml(displayText(gate?.automationLabel) || (gate ? autoLabel(gate) : "-"))}</dd>
      <dt>Agent input candidate</dt><dd>${escapeHtml(tokenCopy.input)}</dd>
      <dt>${escapeHtml(tokenCopy.savingsLabel)}</dt><dd>${escapeHtml(tokenCopy.actualSavings)}</dd>
      <dt>Basis</dt><dd>${escapeHtml(tokenCopy.actualSavingsNote)}</dd>
      <dt>Budget</dt><dd>${escapeHtml(tokenCopy.budget)}</dd>
      <dt>Review boundary</dt><dd>${escapeHtml(frontierCopy.review)}</dd>
      <dt>Permission boundary</dt><dd>${escapeHtml(frontierCopy.permission)}</dd>
      <dt>Stop boundary</dt><dd>${escapeHtml(frontierCopy.stop)}</dd>
      <dt>Graph scope</dt><dd>${escapeHtml(frontierCopy.scope)}</dd>
      <dt>Summary</dt><dd>${escapeHtml(formatSummary(analysis))}</dd>
    </dl>

    <h3>Authority And Automation</h3>
    <p>${escapeHtml(displayText(gate?.permissionSummary) || (gate ? permissionSummary(gate) : "Waiting for analysis."))}</p>
    <p>${escapeHtml(displayText(gate?.scopeleaseritySummary) || "")}</p>
    <p>${escapeHtml(displayText(gate?.checkpointRule) || "")}</p>
    <ul>${allowedActions}</ul>
    <ul class="muted-list">${blockedActions}</ul>

    <h3>Context Boundary</h3>
    <p>${escapeHtml(tokenCopy.summary)}</p>
    <ul>
      <li>Candidate field: <code>${escapeHtml(tokenCopy.actualField)}</code></li>
      <li>Visual graph JSON ${escapeHtml(tokenCopy.visualGraph)} is excluded from the default agent input.</li>
      <li>${escapeHtml(tokenCopy.omittedSummary)}</li>
    </ul>

    <h3>Why It Helps</h3>
    <p>${escapeHtml(useCopy.headline)}</p>
    <ul>${benefits}</ul>
    <ul class="muted-list">${limits}</ul>

    <h3>Changed Files</h3>
    <ul>${changedFiles || "<li>No changed files since the checkpoint.</li>"}</ul>

    <h3>Changed Symbols</h3>
    <ul>${symbols || "<li>No changed symbols to show.</li>"}</ul>

    <h3>Policy Evidence</h3>
    <ul>${policyItems || "<li>No current policy hits.</li>"}</ul>

    <h3>Next Checks</h3>
    <ul>${requiredChecks}</ul>

    <h3>Must-review Files</h3>
    <ul>${review || "<li>No separate review points under the current baseline.</li>"}</ul>
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
  elements.tokenEstimate.textContent = context.tokenEconomy ? `Agent candidate ${tokenCopy.actualInput} / ${tokenCopy.savingsLabel} ${tokenCopy.actualSavings}` : "";
  const payload = formatAgentInputPayload(context);
  if (elements.agentInputSummary) {
    elements.agentInputSummary.innerHTML = renderAgentInputSummary(context, tokenCopy, payload);
  }
  elements.contextPack.textContent = JSON.stringify(displayPayloadPreview(payload), null, 2);
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
  elements.graphSummary.textContent = `The current local impact graph has ${nodes.length} nodes and ${edges.length} edges.`;

  if (!nodes.length) {
    drawEmpty(svg, width, height);
    elements.nodeDetails.textContent = "No graph yet. Index the repo or create local changes after a checkpoint.";
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

function renderShowcaseScreens(analysis, data) {
  const context = analysis.contextPack || {};
  renderBoundaryScreen(context);
  renderDecisionScreen(context, analysis);
  renderEvidenceScreen(analysis, data);
  renderAgentInputScreen(context);
  setActiveScreen(state.activeScreen);
}

function renderBoundaryScreen(context = {}) {
  const agentContext = context.agentContext || {};
  const frontiers = agentContext.frontiers || {};
  const summary = agentContext.frontierSummary || {};
  const graphHash = frontiers.graphScope?.hash || summary.graphScopeHash || "-";
  const metrics = [
    ["Read", metricValue(frontiers.contextFrontier?.size ?? summary.contextNodes), "what the agent should open first"],
    ["Review", metricValue(frontiers.reviewFrontier?.size ?? summary.reviewNodes), "impact surface a human should check"],
    ["Permission", metricValue(frontiers.permissionFrontier?.size ?? summary.permissionNodes), "scope bound to an approval lease"],
    ["Stop", metricValue(frontiers.stopFrontier?.size ?? summary.stopNodes), "conditions requiring a fresh decision"],
    ["Graph scope", shortId(graphHash), "graph hash at approval time"]
  ];
  elements.boundaryCards.innerHTML = renderMetricCards(metrics);
  elements.readPlanList.innerHTML = renderPlanItems(agentContext.readPlan, "No readPlan yet.");
  elements.avoidPlanList.innerHTML = renderPlanItems(agentContext.avoidPlan, "No avoidPlan yet.", "target");
  elements.graphHintList.innerHTML = renderGraphHints(agentContext.graphQueryHints?.hints || []);
}

function renderDecisionScreen(context = {}, analysis = {}) {
  const gate = context.decisionGate || {};
  const fatigue = context.agentContext?.fatiguePlan || {};
  const decisionBundle = fatigue.decisionBundle || {};
  elements.decisionStatusPill.textContent = displayText(gate.statusLabel) || displayText(gate.routingLabel) || routeLabel(analysis.recommendation || "auto_log");
  elements.decisionStatusPill.className = `status-pill ${analysis.risk || "low"}`;
  elements.decisionHeadline.textContent = decisionHeadline(gate, decisionBundle.agentJudgment);
  elements.decisionSummary.textContent = decisionSummary(gate);
  elements.allowedActionList.innerHTML = renderTextItems(gate.allowedActions, "No allowed actions yet.");
  elements.blockedActionList.innerHTML = renderTextItems(gate.blockedActions, "No blocked actions currently.");
  const stops = [
    ...(fatigue.stopWhen || []),
    ...(gate.requiredChecks || []),
    ...(gate.correctionActions || [])
  ];
  elements.stopConditionList.innerHTML = renderTextItems(stops, "No additional stop conditions.");
}

function renderEvidenceScreen(analysis, data) {
  const graph = analysis.graph || { nodes: [], edges: [] };
  const changedCount = analysis.changes?.files?.length || 0;
  const cards = [
    {
      title: "Current demo graph",
      value: `${graph.nodes.length} nodes / ${graph.edges.length} edges`,
      detail: `${changedCount} changed files in the attached repo`,
      boundary: "local sidecar state, not a paper result"
    },
    {
      title: "Review frontier",
      value: "1,771 -> 552 files",
      detail: "69% fewer candidate files, 100% critical-file recall, 93% recall@10",
      boundary: "controlled review-card fixture"
    },
    {
      title: "Permission fixtures",
      value: "12/12 pass",
      detail: "unsafe false allows 0, false blocks 0, false denies 0",
      boundary: "fixture-level guard/ask/deny/lease behavior"
    },
    {
      title: "Codex local main",
      value: "67% lower",
      detail: "11 repos, 176 C0/C3 pairs, 11,830,597 -> 3,879,686 command-reported tokens",
      boundary: "local command-reported protocol, not provider billing"
    },
    {
      title: "Claude local main",
      value: "56% lower",
      detail: "11 repos, 176 C0/C3 pairs, 49,656,538 -> 21,824,362 CLI JSON usage tokens",
      boundary: "local command-reported protocol, not provider billing"
    },
    {
      title: "Terminal-Bench selected panel",
      value: "C3 12/12 resolved",
      detail: "C0/C2/C3 preserve completion; C3 has token overhead",
      boundary: "connection/completion evidence, not token savings"
    }
  ];
  elements.evidenceCards.innerHTML = cards.map((card) => `
    <article class="evidence-card">
      <span>${escapeHtml(card.title)}</span>
      <strong>${escapeHtml(card.value)}</strong>
      <p>${escapeHtml(card.detail)}</p>
      <em>${escapeHtml(card.boundary)}</em>
    </article>
  `).join("");
}

function renderAgentInputScreen(context = {}) {
  const economy = context.tokenEconomy || {};
  const codexInput = context.codexInput || {};
  const agentContext = context.agentContext || {};
  const labels = economy.labels || {};
  elements.agentInputMetrics.innerHTML = renderMetricCards([
    ["Prompt", labels.actualInput || formatTokenCount(economy.actualInputTokens), codexInput.field || "codexInput.text"],
    ["Structured", labels.agentInput || formatTokenCount(economy.agentContextTokens), economy.agentInput?.field || "contextPack.agentContext"],
    ["Visual KG", labels.visualGraph || formatTokenCount(economy.visualGraphTokens), "kept out of default agent input"],
    ["Budget", labels.budget || formatTokenCount(economy.budget), displayText(economy.budgetSummary) || "budget boundary"]
  ]);
  elements.inputOrderList.innerHTML = renderTextItems(
    agentContext.inputPlan?.readOrder || economy.agentInput?.readOrder,
    "No input read order yet."
  );
  elements.promptPreview.textContent = previewText(codexInput.text || codexInput.summary || context.summary || "");
}

function renderMetricCards(items) {
  return items.map(([label, value, note]) => `
    <div class="metric-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value ?? "-")}</strong>
      <em>${escapeHtml(displayText(note || ""))}</em>
    </div>
  `).join("");
}

function renderPlanItems(items = [], emptyText, titleKey = "path") {
  const values = (items || []).filter(Boolean).slice(0, 8);
  if (!values.length) return `<li>${escapeHtml(emptyText)}</li>`;
  return values.map((item) => {
    const title = item[titleKey] || item.path || item.target || item.id || item.label || String(item);
    const reason = item.reason || item.action || item.use || "";
    return `<li><strong>${escapeHtml(title)}</strong>${reason ? `<span>${escapeHtml(displayText(reason))}</span>` : ""}</li>`;
  }).join("");
}

function renderTextItems(items = [], emptyText) {
  const values = (items || []).filter(Boolean).slice(0, 10);
  if (!values.length) return `<li>${escapeHtml(emptyText)}</li>`;
  return values.map((item) => `<li>${escapeHtml(displayText(item))}</li>`).join("");
}

function renderGraphHints(hints = []) {
  const values = hints.filter(Boolean).slice(0, 6);
  if (!values.length) return `<p class="empty-copy">No graphQueryHints yet.</p>`;
  return values.map((hint) => `
    <div class="hint-card">
      <strong>${escapeHtml(hint.id || hint.query || "hint")}</strong>
      <span>${escapeHtml(displayText(hint.use || hint.query || ""))}</span>
    </div>
  `).join("");
}

function metricValue(value) {
  if (value == null || value === "") return "-";
  return String(value);
}

function previewText(value) {
  const text = String(value || "").trim();
  if (!text) return "When analysis is ready, the agent prompt candidate appears here.";
  if (text.includes("ScopeLease context:")) {
    return [
      "User request: Review the whole codebase using the ScopeLease analysis below, and apply needed fixes directly.",
      "",
      "ScopeLease context: compact readPlan, avoidPlan, graphQueryHints, decisionGate, priorityContext, tokenEconomy, and guard boundaries for the attached repository.",
      "",
      "Boundary: visual graph JSON and raw file bodies stay local unless explicitly requested."
    ].join("\n");
  }
  const translated = displayText(text);
  return translated.length > 3200 ? `${translated.slice(0, 3200)}\n...` : translated;
}

function drawEmpty(svg, width, height) {
  const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
  text.setAttribute("x", `${width / 2}`);
  text.setAttribute("y", `${height / 2}`);
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("fill", "#65716c");
  text.setAttribute("font-size", "14");
  text.setAttribute("font-weight", "680");
  text.textContent = "No local impact graph yet.";
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
    summary: "No local changes detected since the checkpoint.",
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
  if (!addedCount && !changedCount && !deletedCount) return "No local changes detected since the checkpoint.";
  return `${addedCount} added, ${changedCount} changed, ${deletedCount} deleted, and ${symbolCount} symbols detected; classified as ${riskLabel(analysis.risk || "low")} risk.`;
}

function listItems(items = [], emptyText) {
  const values = (items || []).filter(Boolean);
  if (!values.length) return `<li>${escapeHtml(emptyText)}</li>`;
  return values.map((item) => `<li>${escapeHtml(displayText(item))}</li>`).join("");
}

function riskLabel(value) {
  return { low: "Low", medium: "Medium", high: "High", critical: "Critical" }[value] || displayText(value) || "Low";
}

function uncertaintyLabel(value) {
  return { low: "Low", medium: "Medium", high: "High" }[value] || displayText(value) || "Low";
}

function routeLabel(value) {
  return {
    auto_log: "Auto-log",
    log_only: "Audit log",
    owner_review: "Owner review",
    reviewer: "Owner review",
    human_review: "Human review",
    senior_review: "Senior review",
    approver: "Approver review",
    block: "Blocked",
    none: "No extra approval"
  }[value] || displayText(value) || "Auto-log";
}

function scopeleaserityLabel(value) {
  return {
    agent: "Agent",
    audit_log: "Audit log",
    owner_review: "Owner",
    reviewer: "Owner",
    human_review: "Human reviewer",
    senior_review: "Senior reviewer",
    approver: "Approver",
    block: "Blocked",
    none: "No extra approval"
  }[value] || routeLabel(value);
}

function autoLabel(gate) {
  if (gate.canAutoApplyPatch && gate.canAutoCheckpoint) return "Apply and checkpoint allowed";
  if (gate.canAutoApplyPatch) return "Apply allowed, checkpoint separate";
  if (gate.canAutoPreparePatch) return "Prepare patch only";
  return "Automated work blocked";
}

function permissionSummary(gate) {
  if (gate.canAutoApplyPatch && gate.canAutoCheckpoint) return "Automatic apply and checkpoint are both allowed.";
  if (gate.canAutoApplyPatch) return "Automatic apply is allowed; checkpoint updates still require user confirmation.";
  if (gate.canAutoPreparePatch) return "Automatic apply is blocked; only a review draft and evidence summary are allowed.";
  return "No automated work should proceed.";
}

function formatTokenEconomy(economy, pairSavings = {}, hookEstimate = {}) {
  if (!economy) {
    return {
      input: "-",
      agentInput: "-",
      savingsLabel: "Pair delta",
      actualSavings: "-",
      actualSavingsNote: "no paired observation",
      tokenMode: "no token measurement",
      tokenMethod: "-",
      budget: "-",
      summary: "No input-candidate measurement.",
      field: "contextPack.agentContext",
      visualGraph: "-",
      omittedSummary: "No omitted-priority details."
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
  const budgetSummary = displayText(economy.budgetSummary) || (economy.fitsBudget ? `fits within budget ${budget}` : `${overBudget} over budget ${budget}`);
  const omittedSummary = formatOmittedSummary(economy.agentInput?.omitted);
  const tokenMode = economy.exactTokens ? "local token measurement" : "fallback estimate";
  const tokenMethod = formatTokenizer(economy.tokenizer, tokenMode);
  const savingsDisplay = formatSavingsDisplay(pairSavings, hookEstimate);
  return {
    input: `${actualInput} (${actualField})`,
    userRequest,
    agentInput,
    actualInput,
    tokenMode,
    tokenMethod,
    savingsLabel: displayText(savingsDisplay.label),
    actualSavings: displayText(savingsDisplay.value),
    actualSavingsNote: displayText(savingsDisplay.note),
    budget: `${budget} / ${budgetSummary}`,
    summary: `The user request is ${userRequest}; the full Codex input candidate built by ScopeLease is ${actualInput}. The real pair delta compares observed default-codex input n with scopelease-codex input m for the same work intent, and only positive deltas count as savings. Repository scope ${visualGraph} is search-space size.`,
    field,
    actualField,
    visualGraph,
    omittedSummary
  };
}

function formatTokenizer(tokenizer = {}, fallback = "fallback estimate") {
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
    ? `The user request is ${userRequest}; the agent input candidate is ${actualInput}; the structured evidence JSON is ${agentInput}. The real pair delta is calculated only after observing default-codex input n and scopelease-codex input m for the same work intent, and only positive deltas count as savings.`
    : "When analysis is ready, this area shows the agent input candidate and paired-observation basis.";
  const graphCopy = tokenCopy.visualGraph && tokenCopy.visualGraph !== "-"
    ? `Visual graph JSON ${tokenCopy.visualGraph} and raw file bodies are excluded from the default agent input.`
    : "Visual graph JSON and raw file bodies are excluded from the default agent input.";
  const cells = [
    ["Agent input field", codexInput.field || tokenCopy.actualField || "codexInput.text"],
    ["Evidence JSON", tokenCopy.field],
    ["Authority", displayText(gate.scopeleaseritySummary) || displayText(gate.permissionSummary) || permissionSummary(gate)],
    ["Automation", formatAutomation(gate)],
    ["Budget", tokenCopy.budget],
    ["Omitted", tokenCopy.omittedSummary],
    ["Next action", displayText(usefulness.nextStep) || "If risk rises, route to owner review or approval."]
  ];

  return `
    <p><strong>Agent input candidate</strong>: ${escapeHtml(primaryCopy)} ${escapeHtml(graphCopy)}</p>
    <div class="agent-input-grid">
      ${cells.map(([label, value]) => `
        <div class="agent-input-cell">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value || "-")}</strong>
        </div>
      `).join("")}
    </div>
    <p class="agent-input-note">${escapeHtml(displayText(usefulness.headline) || "A compact payload that keeps only the summary, priority context, policy evidence, and authority state needed for a decision.")}</p>
    <p class="agent-input-note">The JSON below is an inspection payload containing <code>${escapeHtml(payload.field || "codexInput.text")}</code>, path evidence, and authority criteria.</p>
  `;
}

function formatAutomation(gate = {}) {
  if (!gate || !Object.keys(gate).length) return "-";
  if (gate.automationLabel) return displayText(gate.automationLabel);
  const enforcement = gate.enforcement;
  if (typeof enforcement === "string") return displayText(enforcement);
  if (enforcement && typeof enforcement === "object") {
    const may = Array.isArray(enforcement.agentMay) ? enforcement.agentMay.join(", ") : "";
    const mustNot = Array.isArray(enforcement.agentMustNot) ? enforcement.agentMustNot.join(", ") : "";
    return [
      enforcement.decisionOwner ? `${displayText(enforcement.decisionOwner)} decision` : "",
      may ? `Allowed: ${displayText(may)}` : "",
      mustNot ? `Blocked: ${displayText(mustNot)}` : ""
    ].filter(Boolean).join(" · ");
  }
  return autoLabel(gate);
}

function formatUsefulness(usefulness) {
  if (!usefulness) {
    return { headline: "When analysis is ready, this shows why ScopeLease is useful and where the limits are." };
  }
  return {
    headline: displayText(usefulness.headline || usefulness.label || usefulness.verdict) || "No usefulness verdict."
  };
}

function formatOmittedSummary(omitted = {}) {
  const labels = {
    changedFiles: "changed files",
    changedSymbols: "changed symbols",
    priorityContext: "priority context items",
    policyHits: "policy hits"
  };
  const parts = Object.entries(omitted || {})
    .filter(([, count]) => Number(count || 0) > 0)
    .map(([key, count]) => `${Number(count).toLocaleString("en-US")} ${labels[key] || key}`);
  if (!parts.length) return "No priority items are omitted from the input summary.";
  return `${parts.join(", ")} are omitted from the detailed list to keep the input compact. The full graph and source files remain local for inspection.`;
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
    "changed since baseline": "changed since baseline",
    "imports changed file": "imports a changed file",
    "test edge points to changed file": "test covers a changed file",
    "mentions changed symbol": "doc mentions a changed symbol"
  }[reason] || displayText(reason);
}

function nodeTypeLabel(node) {
  if (node.type === "policy") return "Policy";
  if (node.type?.startsWith("changed")) return "Changed";
  if (node.group === "tests") return "Test";
  if (node.group === "docs") return "Doc";
  if (node.type === "route") return "Route";
  if (node.type === "file") return "File";
  return node.type || "Node";
}

function edgeTypeLabel(type) {
  return {
    defines: "defines",
    imports: "imports",
    imported_by: "called by",
    route: "route",
    defined_by: "defined by",
    tests: "tests",
    mentions: "mentions",
    policy_hit: "policy"
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

function shortId(value) {
  const text = String(value || "");
  if (!text || text === "-") return "-";
  const normalized = text.replace(/^sha1:/, "");
  return normalized.length > 10 ? `${normalized.slice(0, 10)}...` : normalized;
}

function decisionHeadline(gate = {}, agentJudgment = {}) {
  const raw = displayText(gate.summary || agentJudgment?.headline);
  if (raw) return raw;
  if (gate.status === "approval_required") return "Approval is required before the agent applies changes.";
  if (gate.status === "senior_review_required") return "High risk or uncertainty requires senior review.";
  if (gate.status === "owner_review_required") return "Owner review is required before updating the baseline.";
  if (gate.canAutoApplyPatch) return "The agent may apply this low-risk change with an audit trail.";
  if (gate.canAutoPreparePatch) return "The agent may prepare a review draft, but cannot apply it automatically.";
  return "Waiting for analysis.";
}

function decisionSummary(gate = {}) {
  const raw = displayText(gate.permissionSummary || gate.scopeleaseritySummary);
  if (raw) return raw;
  if (gate.canAutoApplyPatch && gate.canAutoCheckpoint) return "Apply and checkpoint are both inside the current delegation boundary.";
  if (gate.canAutoApplyPatch) return "Apply is inside scope; checkpoint still requires user confirmation.";
  if (gate.canAutoPreparePatch) return "Only patch preparation and evidence gathering are inside scope.";
  return "The decision card will show the active authority boundary.";
}

function displayText(value = "") {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map((item) => displayText(item)).filter(Boolean).join(", ");
  const text = String(value);
  if (!text) return "";
  const exact = {
    "낮음": "Low",
    "중간": "Medium",
    "높음": "High",
    "치명적": "Critical",
    "자동 기록": "Auto-log",
    "감사 기록": "Audit log",
    "담당자 리뷰": "Owner review",
    "사람 리뷰": "Human review",
    "결정권자 리뷰": "Senior review",
    "승인권자 승인": "Approver review",
    "차단": "Blocked",
    "추가 승인 없음": "No extra approval",
    "적용 및 체크포인트 가능": "Apply and checkpoint allowed",
    "적용 가능, 체크포인트는 별도": "Apply allowed, checkpoint separate",
    "초안 작성만 가능": "Prepare patch only",
    "자동 작업 차단": "Automated work blocked",
    "컨텍스트 팩 생성": "Create context pack",
    "영향 그래프 표시": "Show impact graph",
    "리뷰용 패치 준비": "Prepare review patch",
    "자동 적용": "Auto-apply patch",
    "리뷰 전 기준점 갱신": "Checkpoint before review",
    "분석 결과를 기다리는 중입니다.": "Waiting for analysis.",
    "결정 카드가 준비되면 권한 경계를 보여줍니다.": "The decision card will show the authority boundary.",
    "결정권자": "Senior reviewer",
    "결정권자 리뷰 필요": "Senior review required",
    "기준 입력 대기": "Waiting for baseline input",
    "적용 여부와 범위를 한 번만 결정합니다.": "Decide once whether to apply and what scope is allowed.",
    "아래 ScopeLease 분석을 기준으로 전역 코드검토를 하고, 필요한 수정은 직접 적용한다.": "Review the whole codebase using the ScopeLease analysis below, and apply needed fixes directly.",
    "같은 work intent의 default-codex 입력 n과 scopelease-codex 입력 m이 모두 관측되면 pair delta를 계산합니다. 양수일 때만 절감률입니다.": "When both default-codex input n and scopelease-codex input m are observed for the same work intent, ScopeLease calculates the pair delta. Only positive deltas count as savings.",
    "사람이 결정해야 하는 변경": "human review required",
    "기준점 이후 변경됨": "changed since baseline",
    "변경 파일을 호출함": "imports a changed file",
    "변경 파일을 검증하는 테스트": "test covers a changed file",
    "변경 심볼을 언급하는 문서": "doc mentions a changed symbol"
  };
  let result = exact[text] || text;
  const replacements = [
    [/결정권자/g, "Senior reviewer"],
    [/권자/g, "reviewer"],
    [/사람이 decision해야 하는 변경/g, "change requiring human decision"],
    [/함수 변경/g, "function changed"],
    [/route 변경/g, "route changed"],
    [/타입 변경/g, "type changed"],
    [/files 변경/g, "files changed"],
    [/files 삭제/g, "files deleted"],
    [/(\d+) files changed/g, "$1 changed files"],
    [/(\d+) files deleted/g, "$1 deleted files"],
    [/(\d+)개 추가/g, "$1 added"],
    [/(\d+)개 변경/g, "$1 changed"],
    [/(\d+)개 삭제/g, "$1 deleted"],
    [/(\d+)개 심볼 감지/g, "$1 symbols detected"],
    [/높음 위험/g, "high risk"],
    [/중간 위험/g, "medium risk"],
    [/낮음 위험/g, "low risk"],
    [/high risk 또는 높은 불확실성이 있어 Senior reviewer 리뷰가 필요합니다\.?/g, "High risk or uncertainty requires senior reviewer review."],
    [/(budget \S+)보다 (\S+) 많습니다\.?/g, "$2 over $1"],
    [/The user request is ([0-9.]+k)이고, the full Codex input candidate built by ScopeLease is ([0-9.]+k)입니다\.?/g, "The user request is $1; the full Codex input candidate built by ScopeLease is $2."],
    [/실제 pair delta는 같은 work intent의 default-codex 관측 입력 n과 scopelease-codex 관측 입력 m을 비교해 계산하고, 양수일 때만 절감률입니다\.?/g, "The real pair delta compares observed default-codex input n with scopelease-codex input m for the same work intent, and only positive deltas count as savings."],
    [/저장소 scope ([^ ]+)는 검색 공간 크기입니다\.?/g, "Repository scope $1 is search-space size."],
    [/인증, 세션, 미들웨어 변경은 authority 흐름에 영향을 줄 수 있어 Senior reviewer 리뷰가 필요합니다\.?/g, "Authentication, session, and middleware changes can affect authority flow, so senior reviewer review is required."],
    [/예산 (\S+)보다 (\S+) 많습니다\.?/g, "$2 over budget $1"],
    [/decision은 Senior reviewer에게 있습니다\. 에이전트는 리뷰용 초안과 근거 정리까지만 allowed됩니다\.?/g, "Decision authority stays with the senior reviewer. The agent may only prepare a review draft and evidence summary."],
    [/Senior reviewer가 변경 의도와 영향 경로를 보고 적용 여부를 decision합니다\. 에이전트는 초안 준비 역할입니다\.?/g, "The senior reviewer decides whether to apply changes after checking intent and impact paths. The agent prepares the draft only."],
    [/리뷰 또는 승인 전에는 기준점을 갱신하지 않습니다\.?/g, "Do not update the checkpoint before review or approval."],
    [/user request은/g, "The user request is"],
    [/ScopeLease가 만든 Codex input candidate 전체는/g, "the full Codex input candidate built by ScopeLease is"],
    [/이 candidate는 Claude Code-style agent에도 재사용할 수 있습니다\.?/g, "This candidate can also be reused by a Claude Code-style agent."],
    [/근거는 유효하지만 input을 더 줄여야 안정적으로 쓸 수 있습니다\.?/g, "The evidence is valid, but the input should be reduced further for stable use."],
    [/decision에 필요한 files, 정책, 근거 경로부터 보게 해서 default-codex와 scopelease-codex run을 같은 work intent로 비교할 수 있게 합니다\.?/g, "It puts decision-critical files, policy hits, and evidence paths first so default-codex and scopelease-codex runs can be compared under the same work intent."],
    [/route, 테스트, 문서, 호출자 연결을 한 화면에서 확인해 누락된 영향 scope를 줄입니다\.?/g, "Routes, tests, docs, and caller links are visible in one screen to reduce missed impact scope."],
    [/위험한 변경은 에이전트가 임의 적용하지 못하게 authority boundaries 먼저 세웁니다\.?/g, "Risky changes set authority boundaries first so the agent cannot apply them arbitrarily."],
    [/현재 input이 budget을 넘으므로 우선순위 files이나 심볼 수를 더 줄여야 합니다\.?/g, "The current input exceeds the budget, so priority files or symbols should be reduced further."],
    [/필수 확인 조건은 자동으로 해결하지 않고 사람에게 넘깁니다\.?/g, "Required checks are routed to a human instead of being resolved automatically."],
    [/High risk, Senior review required\. 인증, 세션, 미들웨어 변경은 authority 흐름에 영향을 줄 수 있어 Senior reviewer 리뷰가 필요합니다\.?/g, "High risk, senior review required. Authentication, session, and middleware changes can affect authority flow, so senior reviewer review is required."],
    [/리뷰 또는 승인이 필요한 정책에 걸렸습니다\. \.decision\/policies\.yaml의 라우팅 기준에 따라 지정된 authority자가 확인해야 합니다\.?/g, "A review-or-approval policy matched. The designated authority owner should check it according to .decision/policies.yaml routing."],
    [/정책 기준이 실제 운영 기준과 다르면 \.decision\/policies\.yaml을 조정하고 이유를 남깁니다\.?/g, "If the policy differs from real operating criteria, adjust .decision/policies.yaml and record why."],
    [/검토 또는 적용이 끝나면 scopelease checkpoint로 현재 상태를 새 기준점으로 갱신합니다\.?/g, "After review or apply, use scopelease checkpoint to accept the current state as the new baseline."],
    [/우선순위 files, 심볼, 근거 경로 수를 줄인 뒤 다시 분석합니다\.?/g, "Reduce priority files, symbols, and evidence paths, then analyze again."],
    [/readPlan에 있는 files만 필요할 때 열고, 전체 files 본문을 input에 넣지 않음/g, "Open only readPlan files when needed; do not put full file bodies into the input."],
    [/화면용 그래프 데이터라 Codex 작업 input에서는 제외/g, "Visual graph data is excluded from Codex task input."],
    [/현재 창 배치와 UI 상태는 탐색\/수정 근거가 아님/g, "Current window layout and UI state are not evidence for exploration or edits."],
    [/사용자가 요청하지 않은 활동 기록은 읽거나 전달하지 않음/g, "Do not read or transmit activity records the user did not request."],
    [/심볼\/경로는 budget 안에서 상위 48 중심으로 제한/g, "Limit symbols and paths to the top 48 within budget."],
    [/Codex input candidate로 넘/g, "Pass as a Codex input candidate"],
    [/자동 적용과 체크포인트가 모두 허용됩니다\./g, "Automatic apply and checkpoint are both allowed."],
    [/자동 적용은 가능하지만 체크포인트는 사용자가 확인한 뒤 갱신합니다\./g, "Automatic apply is allowed; checkpoint updates still require user confirmation."],
    [/자동 적용은 막고, 리뷰용 초안과 근거 정리만 허용합니다\./g, "Automatic apply is blocked; only a review draft and evidence summary are allowed."],
    [/자동 작업을 진행하지 않습니다\./g, "No automated work should proceed."],
    [/승인권자가 보기 전까지 자동 적용하지 않습니다\./g, "Do not auto-apply before approver review."],
    [/패치는 초안까지만 만들고 결정권자 리뷰가 필요합니다\./g, "Prepare a patch draft only; senior review is required."],
    [/담당자 리뷰 후 기준점을 갱신합니다\./g, "Update the checkpoint after owner review."],
    [/낮은 위험 변경은 기록하면서 적용할 수 있습니다\./g, "Low-risk changes can be applied with an audit trail."],
    [/[가-힣]*발 작업으로 해석했고, /g, "Interpreted as development work, "],
    [/결정권자 리뷰 필요/g, "Senior review required"],
    [/ScopeLease context와 authority 경계를 준비하려는 요청입니다\.?/g, "This request is preparing ScopeLease context and authority boundaries."],
    [/context와/g, "context and"],
    [/경계를/g, "boundaries"],
    [/준비하려는 요청입니다\.?/g, "preparation request."],
    [/위험 이유가 실제 요청 의도와 맞는지만 확인/g, "Check whether the risk reason matches the actual request intent"],
    [/모호하면 prepare_only로 초안\/근거만 남기기/g, "if ambiguous, use prepare_only and leave only a draft/evidence"],
    [/scope 밖 files, 네트워크, 체크포인트는 새 판단으로 분리/g, "files outside scope, network access, and checkpoints require a new decision"],
    [/scope 밖 files/g, "files outside scope"],
    [/밖/g, "outside"],
    [/checkpoint는 a new decision으로 분리/g, "checkpoint requires a new decision"],
    [/checkpoint는/g, "checkpoint"],
    [/는 a new decision으로 분리/g, " require a new decision"],
    [/는 a new decision/g, " require a new decision"],
    [/으로 분리/g, " require separation"],
    [/네트워크/g, "network"],
    [/체크포인트는/g, "checkpoint"],
    [/체크포인트/g, "checkpoint"],
    [/새 판단/g, "a new decision"],
    [/분석 결과가 준비되면/g, "When analysis is ready"],
    [/입력 후보/g, "input candidate"],
    [/사용자 원문/g, "user request"],
    [/agent 입력 후보/g, "agent input candidate"],
    [/화면용 그래프 JSON/g, "visual graph JSON"],
    [/원본 파일 본문/g, "raw file bodies"],
    [/agent 입력/g, "agent input"],
    [/위험도/g, "risk"],
    [/라우트/g, "route"],
    [/권한/g, "authority"],
    [/자동화/g, "automation"],
    [/예산/g, "budget"],
    [/생략/g, "omitted"],
    [/허용/g, "allowed"],
    [/차단/g, "blocked"],
    [/파일/g, "files"],
    [/명령/g, "commands"],
    [/범위/g, "scope"],
    [/기본/g, "default"],
    [/멈춤/g, "stop"],
    [/아직 없음/g, "none yet"],
    [/없음/g, "none"],
    [/후보/g, "candidate"],
    [/결정/g, "decision"],
    [/개 이벤트/g, " events"],
    [/개/g, ""]
  ];
  for (let pass = 0; pass < 2; pass += 1) {
    for (const [pattern, replacement] of replacements) {
      result = result.replace(pattern, replacement);
    }
  }
  return result;
}

function displayPayload(value) {
  if (typeof value === "string") return displayText(value);
  if (Array.isArray(value)) return value.map((item) => displayPayload(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, displayPayload(entry)]));
}

function displayPayloadPreview(payload = {}) {
  const structured = payload.structuredContext || {};
  const input = structured.input || {};
  const gate = payload.decisionGate || {};
  const economy = payload.tokenEconomy || {};
  return {
    kind: payload.kind,
    field: payload.field,
    repo: payload.repo,
    summary: "Review the codebase using ScopeLease's compact boundary evidence.",
    structuredContext: {
      field: structured.field,
      label: structured.label,
      tokens: structured.tokens,
      includes: ["readPlan", "avoidPlan", "graphQueryHints", "priorityContext", "decisionGate"],
      readPlan: (input.readPlan || []).slice(0, 5).map((item) => ({
        path: item.path,
        symbol: item.symbol,
        reason: displayText(item.reason || "")
      })),
      graphQueryHints: (input.graphQueryHints?.hints || []).slice(0, 3).map((hint) => ({
        id: hint.id,
        query: hint.query,
        use: displayText(hint.use || "")
      }))
    },
    decisionGate: {
      status: displayText(gate.statusLabel || gate.status || ""),
      authority: displayText(gate.scopeleaserityLabel || gate.scopeleaserity || ""),
      routing: displayText(gate.routingLabel || ""),
      allowedActions: displayPayload(gate.allowedActions || []),
      blockedActions: displayPayload(gate.blockedActions || [])
    },
    tokenEconomy: {
      actualInput: economy.labels?.actualInput || "0k",
      structuredContext: economy.labels?.agentInput || "0k",
      visualGraph: economy.labels?.visualGraph || "0k",
      budget: displayText(economy.labels?.budget || "")
    },
    boundary: "Visual graph JSON and raw file bodies stay local unless explicitly requested."
  };
}

function formatTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat(state.locale === "ko" ? "ko-KR" : "en-US", {
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
