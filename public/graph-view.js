import {
  actualWorkEventsForRequest,
  buildHookSavingsEstimate,
  buildObservedWorkIntentSavings,
  formatSavingsDisplay,
  formatObservedSavings,
  mcpContextEventsForRequest
} from "./savings.js";

const LOCALE_STORAGE_KEY = "scopelease.locale";

const elements = {
  canvas: document.querySelector("#graphCanvas"),
  repoLabel: document.querySelector("#repoLabel"),
  workStatus: document.querySelector("#workStatus"),
  riskLabel: document.querySelector("#riskLabel"),
  graphCount: document.querySelector("#graphCount"),
  activityLabel: document.querySelector("#activityLabel"),
  updatedLabel: document.querySelector("#updatedLabel"),
  resultFrame: document.querySelector("#resultFrame"),
  decisionPanel: document.querySelector("#decisionPanel"),
  controls: document.querySelector(".graph-controls"),
  localeButtons: Array.from(document.querySelectorAll("[data-locale-option]")),
  leftPanelToggle: document.querySelector("[data-panel-toggle='left']"),
  rightPanelToggle: document.querySelector("[data-panel-toggle='right']"),
  scopeToggle: document.querySelector("[data-scope-toggle]")
};

const UI_TRANSLATION_PAIRS = [
  ["ScopeLease Graph View", "ScopeLease 그래프 보기"],
  ["ScopeLease Impact", "ScopeLease 영향"],
  ["Reading repository...", "저장소 읽는 중..."],
  ["Language", "언어"],
  ["Korean", "한국어"],
  ["Live idle", "실시간 대기"],
  ["Live connected", "실시간 연결됨"],
  ["Polling update", "폴링 갱신"],
  ["Waiting for reconnect", "재연결 대기"],
  ["Waiting for server reconnect", "서버 재연결 대기"],
  ["Opening project", "프로젝트 여는 중"],
  ["Starting project runtime", "프로젝트 런타임 시작 중"],
  ["Project runtime opened in a new window", "프로젝트 런타임을 새 창에서 열었습니다"],
  ["Project runtime started", "프로젝트 런타임 시작됨"],
  ["Project runtime running", "프로젝트 런타임 실행 중"],
  ["Project action failed", "프로젝트 작업 실패"],
  ["Workspace", "워크스페이스"],
  ["ScopeLease", "ScopeLease"],
  ["Waiting for project inventory...", "프로젝트 목록을 기다리는 중..."],
  ["Graph display controls", "그래프 표시 컨트롤"],
  ["Hide Workspace panel", "워크스페이스 패널 숨기기"],
  ["Show Workspace panel", "워크스페이스 패널 보이기"],
  ["Hide ScopeLease panel", "ScopeLease 패널 숨기기"],
  ["Show ScopeLease panel", "ScopeLease 패널 보이기"],
  ["Show full stored KG", "전체 저장 KG 보기"],
  ["Show decision paths only", "결정 경로만 보기"],
  ["Full KG", "전체 KG"],
  ["Decision KG", "결정 KG"],
  ["Showing full KG", "전체 KG 표시 중"],
  ["Showing decision KG", "결정 KG 표시 중"],
  ["ScopeLease knowledge graph", "ScopeLease 지식 그래프"],
  ["Waiting for analysis.", "분석 결과를 기다리는 중입니다."],
  ["Waiting for baseline input", "기준 입력 대기"],
  ["Final user screen", "최종 사용자 화면"],
  ["Current request", "이번 요청"],
  ["Risk judgment", "위험 판단"],
  ["Delegation judgment", "위임 판단"],
  ["Input interpretation", "입력 해석"],
  ["Why it is shown", "표시 이유"],
  ["Recommendation", "추천"],
  ["Human should check", "사람이 볼 것"],
  ["Evaluation signal", "평가 신호"],
  ["Decide once whether to apply and what scope is allowed.", "적용 여부와 허용 범위를 한 번만 결정합니다."],
  ["Only delegation scope is shown; no risk interruption.", "위임 범위만 표시하며 위험 인터럽트는 없습니다."],
  ["No user judgment", "사용자 판단 없음"],
  ["ScopeLease input", "ScopeLease 입력"],
  ["agent-visible candidate", "agent-visible 후보"],
  ["delivery candidate", "전달 후보"],
  ["Current observation", "이번 관측"],
  ["Waiting", "대기"],
  ["Observed", "관측됨"],
  ["Off", "꺼짐"],
  ["Pair delta", "Pair delta"],
  ["Decision needed", "결정 필요"],
  ["Verdict", "판정"],
  ["Approval", "승인"],
  ["Provider/API", "Provider/API"],
  ["Excluded", "제외"],
  ["Latest guard", "최신 guard"],
  ["Active lease", "활성 lease"],
  ["Authority scope", "권한 범위"],
  ["Stop condition", "중단 조건"],
  ["Review frontier", "검토 frontier"],
  ["Permission frontier", "권한 frontier"],
  ["Stop frontier", "중단 frontier"],
  ["Graph scope", "그래프 범위"],
  ["KG view", "KG 보기"],
  ["Trace paths", "추적 경로"],
  ["visible / stored nodes", "표시 / 저장 노드"],
  ["evidence routes", "근거 경로"],
  ["Actual file paths", "실제 파일 경로"],
  ["No KG file nodes", "KG 파일 노드 없음"],
  ["No KG labels to show", "표시할 KG label 없음"],
  ["Hub", "허브"],
  ["Hub projects", "허브 프로젝트"],
  ["Waiting for Codex workspace inventory", "Codex workspace 목록 대기 중"],
  ["local effects only", "로컬 효과만"],
  ["Start", "시작"],
  ["Open", "열기"],
  ["running", "실행 중"],
  ["busy", "사용 중"],
  ["stopped", "중지됨"],
  ["unchecked", "미확인"],
  ["missing", "없음"],
  ["attached", "연결됨"],
  ["not attached", "미연결"],
  ["threads", "스레드"],
  ["Project local", "프로젝트 로컬"],
  ["Risk check:", "위험 확인:"],
  ["recommendation", "추천"],
  ["Review the whole codebase using the ScopeLease analysis below, and apply needed fixes directly.", "아래 ScopeLease 분석을 기준으로 전체 코드베이스를 검토하고 필요한 수정은 직접 적용합니다."],
  ["Interpreted as development work, ScopeLease context and authority boundaries preparation request.", "개발 작업으로 해석했고, ScopeLease context와 authority 경계를 준비하려는 요청입니다."],
  ["This request is preparing ScopeLease context and authority boundaries.", "이 요청은 ScopeLease context와 authority 경계를 준비하는 요청입니다."],
  ["high repository risk", "높은 저장소 위험"],
  ["high-risk", "높은 위험"],
  ["high-risk policy hit", "high-risk 정책 매칭"],
  ["sensitive path", "민감 경로"],
  ["Check whether the risk reason matches the actual request intent", "위험 이유가 실제 요청 의도와 맞는지만 확인"],
  ["if ambiguous, use prepare_only and leave only a draft/evidence", "모호하면 prepare_only로 초안/근거만 남기기"],
  ["files outside scope, network access, and checkpoints require a new decision", "scope 밖 파일, 네트워크, 체크포인트는 새 판단으로 분리"],
  ["scope outside files, network, checkpoint and decision require separation", "scope 밖 파일, 네트워크, 체크포인트는 새 판단으로 분리"],
  ["scope outside file, network, checkpoint and decision require separation", "scope 밖 파일, 네트워크, 체크포인트는 새 판단으로 분리"],
  ["scope outside 파일, network, checkpoint and decision require separation", "scope 밖 파일, 네트워크, 체크포인트는 새 판단으로 분리"],
  ["scope outside 파일, network, checkpoint a new decision require separation", "scope 밖 파일, 네트워크, 체크포인트는 새 판단으로 분리"],
  ["Agent judgment:", "Agent 판단:"],
  ["Will do:", "수행:"],
  ["Approval effect:", "승인 효과:"],
  ["Will not do:", "수행하지 않음:"],
  ["Blocked until approval", "승인 전 차단"],
  ["Senior review required", "결정권자 리뷰 필요"],
  ["Owner review required", "담당자 리뷰 필요"],
  ["Auto-log allowed", "자동 기록 허용"],
  ["Audit log", "감사 기록"],
  ["Apply and checkpoint allowed", "적용 및 체크포인트 가능"],
  ["Apply allowed, checkpoint separate", "적용 가능, 체크포인트는 별도"],
  ["Prepare patch only", "초안 작성만 가능"],
  ["Automated work blocked", "자동 작업 차단"],
  ["Do not auto-apply before approver review.", "승인권자 리뷰 전에는 자동 적용하지 않습니다."],
  ["Prepare a patch draft only; senior review is required.", "패치는 초안까지만 만들고 결정권자 리뷰가 필요합니다."],
  ["Update the checkpoint after owner review.", "담당자 리뷰 후 체크포인트를 갱신합니다."],
  ["Low-risk changes can be applied with an audit trail.", "낮은 위험 변경은 기록을 남기고 적용할 수 있습니다."],
  ["Record the change and review when needed.", "변경을 기록하고 필요 시 검토합니다."],
  ["No agent input to copy", "복사할 agent 입력 없음"],
  ["Agent input copied", "Agent 입력 복사됨"],
  ["Browser copy permission unavailable", "브라우저 복사 권한 없음"],
  ["Path connection failed", "경로 연결 실패"],
  ["Enter a local folder path that exists, such as /Users/name/project or ~/project.", "존재하는 로컬 폴더 경로를 입력하세요. 예: /Users/name/project 또는 ~/project"],
  ["Pan applied", "Pan 적용됨"],
  ["Manual layout applied", "수동 배치 적용됨"],
  ["Live update applied", "실시간 갱신 적용됨"],
  ["Initial analysis", "초기 분석"],
  ["Periodic scan", "주기 스캔"],
  ["File change", "파일 변경"],
  ["Root refresh", "루트 새로고침"],
  ["Root changed", "루트 변경"],
  ["Manual refresh", "수동 새로고침"],
  ["State received", "상태 수신"],
  ["Heartbeat", "Heartbeat"],
  ["Connected", "연결됨"],
  ["Idle", "대기"],
  ["Policy", "정책"],
  ["Evidence", "근거"],
  ["Route", "라우트"],
  ["Function", "함수"],
  ["Class", "클래스"],
  ["Type", "타입"],
  ["Test", "테스트"],
  ["Document", "문서"],
  ["Config", "설정"],
  ["CodeFile", "코드파일"],
  ["Code", "코드"],
  ["Changed", "변경"],
  ["Changed type", "변경 타입"],
  ["Changed function", "변경 함수"],
  ["Deleted", "삭제됨"],
  ["Node", "노드"],
  ["route path", "라우트 경로"],
  ["test evidence", "테스트 근거"],
  ["doc evidence", "문서 근거"],
  ["policy evidence", "정책 근거"],
  ["call impact", "호출 영향"],
  ["dependency", "의존성"],
  ["defines", "정의"],
  ["imports", "import"],
  ["called by", "호출됨"],
  ["defined by", "정의됨"],
  ["tests", "테스트"],
  ["mentions", "언급"],
  ["policy", "정책"],
  ["changed file", "변경 파일"],
  ["imports changed file", "변경 파일을 호출"],
  ["related test", "관련 테스트"],
  ["related doc", "관련 문서"],
  ["KG file node", "KG 파일 노드"],
  ["No stop conditions yet.", "아직 중단 조건이 없습니다."],
  ["None yet", "아직 없음"],
  ["None", "없음"],
  ["none", "없음"],
  ["Preparing", "준비 중"],
  ["signed active", "서명된 활성"],
  ["candidate", "후보"],
  ["files", "파일"],
  ["commands", "명령"],
  ["default", "기본"],
  ["stop:", "중단:"],
  ["plus", "추가"],
  ["no expiry", "만료 없음"],
  ["expired", "만료됨"],
  ["left", "남음"]
];

let selectedNodeId = null;
let activeLocale = initialLocale();
let currentAnalysis = null;
let pollTimer = null;
let dragState = null;
let suppressNextClick = false;
let lastAnalysisSignature = null;
let knownNodeIds = null;
let markerCleanupTimer = null;
let lastRepo = "";
let viewportInitialized = false;
let lastRemoteRenderSignature = "";
let currentState = null;
let liveStatus = {
  connected: false,
  mode: "idle",
  reason: "not started",
  at: ""
};

const manualPositions = new Map();
const lastPositions = new Map();
const recentNodeMarkers = new Map();
const ghostNodes = new Map();
let knownNodeFingerprints = null;
let pendingRemoteState = null;
let pendingRemoteReason = "";
let hubProjectCache = null;
let hubProjectCacheAt = 0;
let hubProjectCacheHasHealth = false;
let currentLaneMetrics = null;
let lastLaneMetricsReportSignature = "";
let lastLaneMetricsReportAt = 0;
let laneMetricsReportTimer = null;
const MARKER_TTL = 1600;
const DECISION_GRAPH_NODE_LIMIT = 96;
const FULL_GRAPH_NODE_LIMIT = 180;
const FULL_GRAPH_EDGE_LIMIT = 320;
const HUB_PROJECT_CACHE_MS = 10000;
const HUB_PROJECT_HEALTH_CACHE_MS = 30000;

const viewportState = {
  zoom: 1,
  panX: 0,
  panY: 0
};

const viewState = {
  layout: "lanes",
  scope: "decision",
  focus: "all",
  query: "",
  spacing: 1,
  scale: 1,
  relationLabels: false,
  pathBands: true
};

const BOUNDARY_ORDER = ["permission", "review", "read", "lease", "stop"];

const urlParams = new URLSearchParams(window.location.search);
const isSidecarMode = urlParams.get("sidecar") === "1";

const panelState = {
  left: !isSidecarMode,
  right: !isSidecarMode
};

if (isSidecarMode) document.body.classList.add("sidecar-mode");

document.addEventListener("click", (event) => {
  const localeButton = event.target.closest("[data-locale-option]");
  if (localeButton) {
    event.preventDefault();
    setLocale(localeButton.dataset.localeOption || "en");
    return;
  }

  const panelToggleButton = event.target.closest("[data-panel-toggle]");
  if (panelToggleButton) {
    event.preventDefault();
    togglePanel(panelToggleButton.dataset.panelToggle);
    return;
  }

  const scopeToggleButton = event.target.closest("[data-scope-toggle]");
  if (scopeToggleButton) {
    event.preventDefault();
    toggleGraphScope();
    return;
  }

  const hubActionButton = event.target.closest("[data-hub-action]");
  if (hubActionButton) {
    event.preventDefault();
    handleHubProjectAction(hubActionButton);
  }
});

queueMicrotask(updateViewControls);

async function refresh() {
  try {
    const state = await fetchRemoteState();
    liveStatus = {
      connected: false,
      mode: "poll",
      reason: "poll",
      at: new Date().toISOString()
    };
    renderRemoteState(state, "poll");
  } catch (_error) {
    liveStatus = {
      connected: false,
      mode: "reconnect",
      reason: "server waiting",
      at: new Date().toISOString()
    };
    updateLiveIndicators();
    setActivity("Waiting for server reconnect", true);
  }
}

async function fetchRemoteState() {
  const response = await fetch("/api/state", { cache: "no-store" });
  return attachHubProjects(await response.json());
}

function renderRemoteState(state = {}, eventReason = "event") {
  if (document.hidden) {
    pendingRemoteState = state;
    pendingRemoteReason = eventReason;
    updateLiveIndicators();
    return;
  }
  render(state.latestAnalysis || emptyAnalysis(state.repo || ""), eventReason, state);
}

function flushPendingRemoteState() {
  if (document.hidden || !pendingRemoteState) return;
  const state = pendingRemoteState;
  const reason = pendingRemoteReason || "event";
  pendingRemoteState = null;
  pendingRemoteReason = "";
  renderRemoteState(state, reason);
}

async function attachHubProjects(state = {}, options = {}) {
  if (!state) return state;
  if (state.runtime?.hubMode !== true && state.runtime?.mode !== "hub") return state;
  const includeHealth = options.health !== false;
  const now = Date.now();
  const cacheMs = includeHealth ? HUB_PROJECT_HEALTH_CACHE_MS : HUB_PROJECT_CACHE_MS;
  if (!options.force && hubProjectCache && now - hubProjectCacheAt < cacheMs && (!includeHealth || hubProjectCacheHasHealth)) {
    return { ...state, hubProjects: hubProjectCache };
  }
  try {
    const response = await fetch(`/api/projects?health=${includeHealth ? "true" : "false"}`, { cache: "no-store" });
    if (!response.ok) return state;
    const hubProjects = await response.json();
    hubProjectCache = hubProjects;
    hubProjectCacheAt = now;
    hubProjectCacheHasHealth = includeHealth;
    return { ...state, hubProjects };
  } catch {
    return state;
  }
}

async function handleHubProjectAction(button) {
  const repo = button.dataset.hubRepo || "";
  const action = button.dataset.hubAction || "start";
  if (!repo) return;
  button.disabled = true;
  setActivity(action === "open" ? "Opening project" : "Starting project runtime", true);
  try {
    const response = await fetch(`/api/projects/${action === "open" ? "open" : "start"}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo })
    });
    const result = await response.json();
    if (!response.ok || result.ok === false) throw new Error(result.error || "Project runtime action failed");
    const state = await attachHubProjects(currentState || {}, { health: true, force: true });
    if (currentAnalysis) render(currentAnalysis, "hub_project_update", state);
    if (action === "open" && result.url) {
      const opened = window.open(result.url, "_blank", "noopener,noreferrer");
      setActivity(opened ? "Project runtime opened in a new window" : `Project runtime ready: ${result.url}`, true);
      return;
    }
    setActivity(result.started ? "Project runtime started" : "Project runtime running", true);
  } catch (error) {
    setActivity("Project action failed", true);
    renderError(String(error.message || error));
  } finally {
    button.disabled = false;
  }
}

function render(analysis, eventReason = "render", state = null) {
  const remoteUpdate = eventReason === "poll" || eventReason === "event" || eventReason === "heartbeat-state";
  const nextState = state || currentState || {};
  const remoteSignature = remoteUpdate ? remoteRenderSignature(analysis, nextState) : "";
  if (remoteUpdate && remoteSignature && remoteSignature === lastRemoteRenderSignature) return;
  currentAnalysis = analysis;
  currentState = nextState;
  if (analysis.repo && analysis.repo !== lastRepo) {
    lastRepo = analysis.repo;
    resetGraphMemory();
  }
  const sourceGraph = activeKnowledgeGraph(analysis, currentState);
  const paths = visiblePaths(analysis);
  const graph = visibleGraph(sourceGraph, analysis, paths);
  const context = buildActiveContext(graph, paths);
  const positions = layoutGraph(graph, analysis);
  const agentJudgment = agentJudgmentFromAnalysis(analysis);
  currentLaneMetrics = viewState.layout === "lanes" ? buildLaneLayoutMetrics(positions, graph) : null;
  if (!viewportInitialized || eventReason === "repo_switch" || eventReason === "layout_reset") {
    fitViewportToPositions(positions);
    viewportInitialized = true;
  }
  trackGraphDelta(graph, positions, analysis, eventReason);
  elements.repoLabel.textContent = formatRepoLabel(analysis.repo || "");
  elements.repoLabel.title = analysis.repo || "";
  elements.riskLabel.textContent = riskLabel(analysis.risk || "low");
  elements.riskLabel.className = `risk ${analysis.risk || "low"}`;
  elements.graphCount.textContent = `${formatGraphCount(graph, sourceGraph)}${formatLaneMetricSummary(currentLaneMetrics)}`;
  elements.workStatus.textContent = workStatusText(analysis, graph, sourceGraph, agentJudgment);
  elements.workStatus.title = agentJudgmentTitle(agentJudgment) || elements.workStatus.textContent;
  elements.updatedLabel.textContent = analysis.generatedAt ? new Date(analysis.generatedAt).toLocaleTimeString(activeLocale === "ko" ? "ko-KR" : "en-US") : "-";
  updateViewControls();
  renderResultFrame(analysis, graph, sourceGraph, paths);
  renderDecision(analysis);
  drawSvg(graph, positions, analysis, paths, context, eventReason);
  reportLaneMetrics(analysis, graph, currentLaneMetrics, eventReason);
  rememberPositions(positions);
  applyLocaleToDocument();
  if (remoteUpdate) lastRemoteRenderSignature = remoteSignature;
}

function activeKnowledgeGraph(analysis, state = currentState) {
  const graph = analysis.knowledgeGraph || analysis.graph || { nodes: [], edges: [], schema: { model: "scopelease_knowledge_graph" } };
  return mergeHubProjectGraph(mergeCodexSessionGraph(graph, state, analysis), state);
}

function remoteRenderSignature(analysis = {}, state = currentState) {
  const graph = activeKnowledgeGraph(analysis, state);
  const codex = codexSessionContext(state);
  const aggregate = codex.codexLocalAggregate || {};
  const hubTotals = hubProjectContext(state).totals || {};
  return [
    analysis.repo || "",
    analysis.generatedAt || "",
    analysis.contextPack?.userRequest?.text || analysis.userRequest || "",
    analysis.contextPack?.codexInput?.tokens || analysis.contextPack?.tokenEconomy?.actualInputTokens || 0,
    graphContentSignature(graph),
    changeSignature(analysis),
    aggregate.currentRepoThreadRecords || aggregate.currentRepoThreads || 0,
    hubTotals.projects || 0,
    hubTotals.runningProjects || 0,
    hubTotals.threadRecords || 0,
    hubProjectStatusSignature(hubProjectContext(state)),
    guardStateSignature(state),
    agentVisibleEventSignature(state)
  ].join("::");
}

function guardStateSignature(state = {}) {
  const latestGuard = (state.guardEvents || [])[0] || {};
  const latestLease = (state.approvalLeases || [])[0] || {};
  const metrics = state.fatigueMetrics || {};
  return [
    latestGuard.id || "",
    latestGuard.verdict || "",
    latestGuard.actionGrant || "",
    latestGuard.decisionBundleId || "",
    latestGuard.agentJudgment?.headline || "",
    latestLease.id || "",
    latestLease.choiceId || "",
    metrics.humanPromptsShown || 0,
    metrics.approvalLeasesCreated || 0,
    metrics.approvalLeaseHits || 0
  ].join("|");
}

function agentVisibleEventSignature(state = {}) {
  const mcpEvents = state.mcpContextEvents || [];
  const actualEvents = state.actualWorkEvents || [];
  const latestMcp = mcpEvents[0] || {};
  const latestActual = actualEvents[0] || {};
  return [
    mcpEvents.length,
    actualEvents.length,
    latestMcp.id || latestMcp.eventId || "",
    latestActual.id || latestActual.eventId || "",
    latestMcp.tokens || 0,
    latestActual.tokens || 0
  ].join("|");
}

function graphContentSignature(graph = {}) {
  const nodePart = (graph.nodes || [])
    .map((node) => `${node.id}:${nodeFingerprint(node)}`)
    .sort()
    .join("|");
  const edgePart = (graph.edges || [])
    .map(edgeKey)
    .sort()
    .join("|");
  return `${nodePart}::${edgePart}`;
}

function changeSignature(analysis = {}) {
  const changes = analysis.changes || {};
  return [
    ...(changes.files || []),
    ...(changes.added || []).map((path) => `+${path}`),
    ...(changes.modified || []).map((path) => `~${path}`),
    ...(changes.deleted || []).map((path) => `-${path}`),
    ...Object.entries(changes.symbols || {}).flatMap(([file, symbols]) =>
      (symbols || []).map((symbol) => `${file}:${symbol.id || symbol.name || ""}`)
    )
  ].sort().join("|");
}

function hubProjectStatusSignature(hub = {}) {
  return (hub.projects || [])
    .map((project) => [
      project.id || project.cwd || "",
      project.runtime?.status || "",
      project.runtime?.port || "",
      project.scopelease?.attached ? "attached" : "detached"
    ].join(":"))
    .sort()
    .join("|");
}

function mergeHubProjectGraph(sourceGraph = {}, state = {}) {
  const graph = hubProjectContext(state).knowledgeGraph;
  if (!graph?.nodes?.length && !graph?.edges?.length) return sourceGraph;
  return mergeProvidedCodexSessionGraph(sourceGraph, graph);
}

function mergeCodexSessionGraph(sourceGraph = {}, state = {}, analysis = {}) {
  const context = codexSessionContext(state);
  const providedGraph = context.knowledgeGraph || context.codexSessionKnowledgeGraph;
  if (providedGraph?.nodes?.length || providedGraph?.edges?.length) {
    return mergeProvidedCodexSessionGraph(sourceGraph, providedGraph);
  }
  const aggregate = context.codexLocalAggregate || {};
  const scope = context.codexWorkspaceScope || {};
  const threads = Array.isArray(aggregate.sampleThreads) ? aggregate.sampleThreads : [];
  const workspaces = Array.isArray(scope.includedWorkspaces) ? scope.includedWorkspaces : [];
  if (!threads.length && !workspaces.length) return sourceGraph;

  const nodes = [...(sourceGraph.nodes || [])];
  const edges = [...(sourceGraph.edges || [])];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgeIds = new Set(edges.map(edgeKey));
  const repoPath = aggregate.currentRepo || scope.currentRepo || analysis.repo || state.repo || "";
  const repoNode = {
    id: "codex-repo:current",
    label: repoPath.split("/").filter(Boolean).at(-1) || "current repo",
    caption: "Codex thread records",
    type: "codex_repo_usage",
    labels: ["ScopeLeaseNode", "CodexRepo", "CodexUsage", "Evidence"],
    path: repoPath,
    properties: {
      recordType: aggregate.recordType || "historical_cwd_matched_codex_thread_records",
      activeSessionClaim: "false",
      currentRepoThreadRecords: aggregate.currentRepoThreadRecords || aggregate.currentRepoThreads || 0,
      tokensUsed: aggregate.totalTokens || 0,
      latestUpdatedAt: aggregate.latestUpdatedAt || "",
      semantics: aggregate.note || scope.threadRecordSemantics || "Codex sqlite thread rows are historical records."
    }
  };
  addGraphNode(nodes, nodeIds, repoNode);

  const workspaceRows = workspaces.length ? workspaces : [{
    cwd: repoPath,
    canonicalCwd: scope.currentRepoCanonical || repoPath,
    threads: aggregate.currentRepoThreadRecords || aggregate.currentRepoThreads || threads.length,
    tokens: aggregate.totalTokens || 0,
    latestUpdatedAt: aggregate.latestUpdatedAt || ""
  }];

  for (const workspace of workspaceRows) {
    const workspaceId = `codex-workspace:${stableGraphId(workspace.canonicalCwd || workspace.cwd || repoPath || "current")}`;
    addGraphNode(nodes, nodeIds, {
      id: workspaceId,
      label: compactMiddle(workspace.cwd || repoPath || "workspace", 34),
      caption: "Codex workspace",
      type: "codex_workspace",
      labels: ["ScopeLeaseNode", "CodexWorkspace", "CodexUsage", "Evidence"],
      path: workspace.cwd || repoPath,
      properties: {
        cwd: workspace.cwd || "",
        canonicalCwd: workspace.canonicalCwd || "",
        matchesCurrentRepo: String(workspace.matchesCurrentRepo !== false),
        threadRecords: workspace.threads || 0,
        archivedThreadRecords: workspace.archivedThreads || 0,
        tokensUsed: workspace.tokens || 0,
        latestUpdatedAt: workspace.latestUpdatedAt || "",
        activeSessionClaim: "false"
      }
    });
    addGraphEdge(edges, edgeIds, {
      source: repoNode.id,
      target: workspaceId,
      type: "codex_scope",
      relationshipType: "HAS_CODEX_WORKSPACE",
      properties: { basis: "cwd matches current repository scope" }
    });

    for (const thread of threads.filter((item) => sameGraphPath(item.cwd, workspace.cwd || repoPath))) {
      const threadId = `codex-thread:${stableGraphId(thread.id || `${thread.cwd}:${thread.updatedAt}`)}`;
      addGraphNode(nodes, nodeIds, {
        id: threadId,
        label: thread.title || thread.id || "Codex thread",
        caption: "Codex thread record",
        type: "codex_thread_record",
        labels: ["ScopeLeaseNode", "CodexThreadRecord", "CodexUsage", "Evidence"],
        path: thread.cwd || repoPath,
        properties: {
          threadId: thread.id || "",
          title: thread.title || "",
          model: thread.model || "",
          provider: thread.modelProvider || "",
          tokensUsed: thread.tokensUsed || 0,
          updatedAt: thread.updatedAt || "",
          createdAt: thread.createdAt || "",
          archived: String(thread.archived === true),
          recordType: thread.recordType || "codex_sqlite_thread_record",
          activeSessionStatus: thread.activeSessionStatus || "not_measured"
        }
      });
      addGraphEdge(edges, edgeIds, {
        source: workspaceId,
        target: threadId,
        type: "codex_thread_record",
        relationshipType: "HAS_CODEX_THREAD_RECORD",
        properties: { basis: "Codex local sqlite threads row with cwd scoped to this repo" }
      });
      if (thread.model) {
        const modelId = `codex-model:${stableGraphId(`${thread.modelProvider || "provider"}:${thread.model}`)}`;
        addGraphNode(nodes, nodeIds, {
          id: modelId,
          label: thread.model,
          caption: thread.modelProvider ? `${thread.modelProvider} model` : "Codex model",
          type: "codex_model",
          labels: ["ScopeLeaseNode", "CodexModel", "CodexUsage"],
          properties: {
            provider: thread.modelProvider || "",
            model: thread.model
          }
        });
        addGraphEdge(edges, edgeIds, {
          source: threadId,
          target: modelId,
          type: "uses_model",
          relationshipType: "USES_MODEL",
          properties: { basis: "Codex sqlite thread model fields" }
        });
      }
    }
  }

  return {
    ...sourceGraph,
    nodes,
    edges,
    schema: mergeGraphSchema(sourceGraph.schema, nodes, edges)
  };
}

function mergeProvidedCodexSessionGraph(sourceGraph = {}, providedGraph = {}) {
  const nodes = [...(sourceGraph.nodes || [])];
  const edges = [...(sourceGraph.edges || [])];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgeIds = new Set(edges.map(edgeKey));
  for (const node of providedGraph.nodes || []) addGraphNode(nodes, nodeIds, node);
  for (const edge of providedGraph.edges || []) addGraphEdge(edges, edgeIds, edge);
  return {
    ...sourceGraph,
    nodes,
    edges,
    schema: mergeGraphSchema(sourceGraph.schema, nodes, edges)
  };
}

function codexSessionContext(state = {}) {
  return state?.codexSessionContext || state?.agentVisibleUsageDetection || state?.codexUsageDetection || {};
}

function hubProjectContext(state = {}) {
  return state?.hubProjects || state?.scopeleaseHubProjects || {};
}

function addGraphNode(nodes, nodeIds, node) {
  if (!node?.id || nodeIds.has(node.id)) return;
  nodeIds.add(node.id);
  nodes.push(node);
}

function addGraphEdge(edges, edgeIds, edge) {
  const key = edgeKey(edge);
  if (!edge?.source || !edge?.target || edgeIds.has(key)) return;
  edgeIds.add(key);
  edges.push(edge);
}

function edgeKey(edge = {}) {
  return [edge.source || "", edge.target || "", edge.type || "", edge.relationshipType || ""].join("::");
}

function stableGraphId(value = "") {
  const text = String(value || "").normalize("NFC");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return `${text.slice(0, 42).replace(/[^a-z0-9_.:-]+/gi, "_")}:${Math.abs(hash).toString(36)}`;
}

function sameGraphPath(left = "", right = "") {
  const a = String(left || "").normalize("NFC").replace(/\/+$/, "");
  const b = String(right || "").normalize("NFC").replace(/\/+$/, "");
  return a === b;
}

function mergeGraphSchema(schema = {}, nodes = [], edges = []) {
  const labelCounts = countValues(nodes.flatMap((node) => nodeLabels(node)));
  const relationshipCounts = countValues(edges.map((edge) => relationshipType(edge)));
  return {
    ...schema,
    model: schema.model || "scopelease_knowledge_graph",
    nodeCount: nodes.length,
    relationshipCount: edges.length,
    nodeLabels: labelCounts.map(([label, count]) => ({ label, count })),
    relationshipTypes: relationshipCounts.map(([type, count]) => ({ type, count }))
  };
}

function countValues(values = []) {
  const counts = new Map();
  for (const value of values) {
    const key = String(value || "").trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function resetGraphMemory() {
  selectedNodeId = null;
  manualPositions.clear();
  lastPositions.clear();
  recentNodeMarkers.clear();
  ghostNodes.clear();
  knownNodeIds = null;
  knownNodeFingerprints = null;
  lastAnalysisSignature = null;
  lastRemoteRenderSignature = "";
  pendingRemoteState = null;
  pendingRemoteReason = "";
  currentLaneMetrics = null;
  lastLaneMetricsReportSignature = "";
  lastLaneMetricsReportAt = 0;
  viewportInitialized = false;
}

function visibleGraph(sourceGraph, analysis, paths) {
  const nodes = sourceGraph.nodes || [];
  const edges = sourceGraph.edges || [];
  const query = normalizeText(searchTermFromFilter(viewState.query));
  const shouldShowAll = viewState.scope === "all" && viewState.focus === "all" && !query && !selectedNodeId;
  if (shouldShowAll) {
    if (nodes.length > FULL_GRAPH_NODE_LIMIT) return overviewGraph(sourceGraph, analysis, FULL_GRAPH_NODE_LIMIT);
    return sourceGraph;
  }

  const ids = new Set();
  const changedIds = changedNodeIds(analysis);
  const evidenceIds = evidenceNodeIds(analysis);

  for (const id of changedIds) ids.add(id);
  for (const id of evidenceIds) ids.add(id);
  for (const node of nodes) {
    if (isCodexUsageNode(node)) ids.add(node.id);
  }

  if (viewState.scope === "decision" && !changedIds.size && !evidenceIds.size && !(paths || []).length && !query && !selectedNodeId) {
    for (const node of fallbackFileNodes(sourceGraph, 28)) ids.add(node.id);
  }

  for (const path of paths) {
    for (const node of path.nodes || []) ids.add(node.id);
  }

  if (query) {
    for (const node of nodes) {
      if (!searchableNodeText(node).includes(query)) continue;
      ids.add(node.id);
      for (const edge of edges) {
        if (edge.source === node.id) ids.add(edge.target);
        if (edge.target === node.id) ids.add(edge.source);
      }
    }
    for (const path of analysis.impact?.paths || []) {
      if (!path.nodes?.some((node) => searchableNodeText(node).includes(query))) continue;
      for (const node of path.nodes) ids.add(node.id);
    }
  }

  if (selectedNodeId) {
    ids.add(selectedNodeId);
    for (const edge of edges) {
      if (edge.source === selectedNodeId) ids.add(edge.target);
      if (edge.target === selectedNodeId) ids.add(edge.source);
    }
  }

  if (viewState.scope === "decision" && ids.size > DECISION_GRAPH_NODE_LIMIT && !query && !selectedNodeId) {
    trimDecisionIds(ids, sourceGraph, analysis, paths, DECISION_GRAPH_NODE_LIMIT);
  }

  if (!ids.size) return sourceGraph;
  const visibleNodes = nodes.filter((node) => ids.has(node.id));
  const visibleEdges = edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  return { nodes: visibleNodes, edges: visibleEdges };
}

function fallbackFileNodes(graph = {}, limit = 24) {
  return (graph.nodes || [])
    .filter((node) => node.path && isFileNode(node))
    .map((node) => ({
      node,
      score:
        (nodeLabels(node).includes("CodeFile") ? 80 : 0) +
        (nodeLabels(node).includes("TestFile") ? 70 : 0) +
        (nodeLabels(node).includes("Document") ? 50 : 0) +
        (node.path.includes("src/") ? 25 : 0) +
        (node.path.includes("docs/") ? 15 : 0)
    }))
    .sort((a, b) => b.score - a.score || a.node.path.localeCompare(b.node.path))
    .slice(0, limit)
    .map((item) => item.node);
}

function overviewGraph(sourceGraph, analysis, nodeLimit = FULL_GRAPH_NODE_LIMIT) {
  const nodes = sourceGraph.nodes || [];
  const edges = sourceGraph.edges || [];
  const changed = changedNodeIds(analysis);
  const evidence = evidenceNodeIds(analysis);
  const pathIds = idsFromPaths(analysis.impact?.paths || []);
  const degrees = graphDegrees(sourceGraph);
  const selected = new Set();

  const scored = nodes
    .map((node) => ({
      node,
      score:
        (isCodexUsageNode(node) ? 5000 : 0) +
        (changed.has(node.id) ? 9000 : 0) +
        (evidence.has(node.id) ? 7000 : 0) +
        (pathIds.has(node.id) ? 3000 : 0) +
        ((degrees.get(node.id) || 0) * 42) +
        (nodeLabels(node).includes("CodeFile") ? 80 : 0)
    }))
    .sort((a, b) => b.score - a.score || nodeCaption(a.node).localeCompare(nodeCaption(b.node)));

  for (const item of scored.slice(0, nodeLimit)) selected.add(item.node.id);
  const visibleNodes = nodes.filter((node) => selected.has(node.id));
  const visibleEdges = limitGraphEdges(
    edges.filter((edge) => selected.has(edge.source) && selected.has(edge.target)),
    analysis.impact?.paths || [],
    FULL_GRAPH_EDGE_LIMIT
  );

  return {
    nodes: visibleNodes,
    edges: visibleEdges,
    overview: {
      limited: true,
      nodeLimit,
      edgeLimit: FULL_GRAPH_EDGE_LIMIT,
      sourceNodeCount: nodes.length,
      sourceEdgeCount: edges.length
    }
  };
}

function idsFromPaths(paths = []) {
  const ids = new Set();
  for (const path of paths) {
    for (const node of path.nodes || []) ids.add(node.id);
  }
  return ids;
}

function limitGraphEdges(edges, paths, limit) {
  if (edges.length <= limit) return edges;
  return [...edges]
    .sort((a, b) =>
      Number(relationshipType(b) === "VIOLATES_POLICY") - Number(relationshipType(a) === "VIOLATES_POLICY") ||
      Number(isEvidenceEdge(b, paths)) - Number(isEvidenceEdge(a, paths)) ||
      edgeWeight(b) - edgeWeight(a)
    )
    .slice(0, limit);
}

function changedNodeIds(analysis) {
  const files = new Set((analysis.changes?.files || []).map((file) => `file:${file}`));
  const ids = new Set(files);
  for (const [file, symbols] of Object.entries(analysis.changes?.symbols || {})) {
    ids.add(`file:${file}`);
    for (const symbol of symbols || []) {
      if (symbol.id) ids.add(symbol.id);
    }
  }
  return ids;
}

function evidenceNodeIds(analysis) {
  return new Set([
    ...(analysis.impact?.routes || []).map((item) => item.id),
    ...(analysis.impact?.importedBy || []).map((item) => item.id),
    ...(analysis.impact?.tests || []).map((item) => item.id),
    ...(analysis.impact?.docs || []).map((item) => item.id),
    ...(analysis.policyHits || []).map((hit) => `policy:${hit.ruleId}`)
  ]);
}

function trimDecisionIds(ids, graph, analysis, paths, limit) {
  const changed = changedNodeIds(analysis);
  const evidence = evidenceNodeIds(analysis);
  const degrees = graphDegrees(graph);
  const scored = [...ids]
    .map((id) => ({
      id,
      score:
        (evidence.has(id) ? 6000 : 0) +
        (isCodexUsageNode((graph.nodes || []).find((node) => node.id === id)) ? 4800 : 0) +
        (changed.has(id) ? 1600 : 0) +
        (pathFrequency(id, paths) * 64) +
        ((degrees.get(id) || 0) * 9)
    }))
    .sort((a, b) => b.score - a.score);
  ids.clear();
  for (const item of scored.slice(0, limit)) ids.add(item.id);
}

function pathFrequency(id, paths) {
  let count = 0;
  for (const path of paths) {
    if (path.nodes?.some((node) => node.id === id)) count += 1;
  }
  return count;
}

function formatGraphCount(graph, sourceGraph) {
  if (graph.overview?.limited) {
    return `${graph.nodes.length} shown / ${sourceGraph.nodes.length} nodes · overview`;
  }
  if (graph.nodes.length === sourceGraph.nodes.length && graph.edges.length === sourceGraph.edges.length) {
    return `${graph.nodes.length} nodes / ${graph.edges.length} rels`;
  }
  return `${graph.nodes.length} shown / ${sourceGraph.nodes.length} nodes`;
}

function formatLaneMetricSummary(metrics) {
  if (!metrics?.summary?.laneCount) return "";
  const summary = metrics.summary;
  const density = Math.round((summary.maxDensity || 0) * 100);
  return ` · lanes ${summary.laneCount} · overlap ${summary.totalOverlapCount} · max ${density}%`;
}

function reportLaneMetrics(analysis = {}, graph = {}, metrics = null, eventReason = "render") {
  if (!metrics || !isSidecarMode) return;
  const signature = laneMetricsSignature(metrics);
  const now = Date.now();
  if (signature === lastLaneMetricsReportSignature && now - lastLaneMetricsReportAt < 10000) return;
  lastLaneMetricsReportSignature = signature;
  lastLaneMetricsReportAt = now;
  window.clearTimeout(laneMetricsReportTimer);
  laneMetricsReportTimer = window.setTimeout(() => {
    fetch("/api/graph-layout-metrics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "graph-view",
        layout: metrics.layout,
        scope: metrics.scope,
        eventReason,
        repo: analysis.repo || "",
        userRequest: analysis.contextPack?.userRequest?.text || analysis.userRequest || "",
        nodeCount: metrics.nodeCount || (graph.nodes || []).length,
        edgeCount: metrics.edgeCount || (graph.edges || []).length,
        summary: metrics.summary,
        lanes: metrics.lanes
      })
    }).catch(() => {});
  }, 180);
}

function laneMetricsSignature(metrics = {}) {
  return JSON.stringify({
    layout: metrics.layout,
    scope: metrics.scope,
    nodeCount: metrics.nodeCount,
    edgeCount: metrics.edgeCount,
    lanes: (metrics.lanes || []).map((lane) => [
      lane.key,
      lane.count,
      lane.rows,
      lane.columns,
      lane.density,
      lane.overlapCount,
      lane.status
    ])
  });
}

function workStatusText(analysis, graph, sourceGraph = graph, agentJudgment = {}) {
  const tokenCopy = formatTokenEconomy(analysis.contextPack?.tokenEconomy || {});
  const hubTotals = hubProjectContext(currentState).totals || {};
  const projectText = hubTotals.projects
    ? `Hub ${hubTotals.projects} projects · ${hubTotals.runningProjects || 0} running`
    : "Project local";
  const baseText = `ScopeLease input ${tokenCopy.actualInput} · ${projectText} · KG ${graph.nodes.length}/${sourceGraph.nodes.length}`;
  const judgmentText = compactAgentJudgmentStatus(agentJudgment);
  return judgmentText ? `${baseText} · ${judgmentText}` : baseText;
}

function renderResultFrame(analysis, graph, sourceGraph, paths) {
  if (!elements.resultFrame) return;
  const pack = analysis.contextPack || {};
  const tokenCopy = formatTokenEconomy(pack.tokenEconomy);
  const promptContext = pack.codexInput?.promptContext || {};
  const contextDelta = promptContext.contextDelta || {};
  const hub = hubProjectContext(currentState);
  const totals = hub.totals || {};
  const overview = graph.overview?.limited
    ? `${graph.nodes.length}/${sourceGraph.nodes.length}`
    : `${graph.nodes.length}/${sourceGraph.nodes.length}`;
  const labels = topCounts(graph.nodes || [], (node) => nodeLabels(node).filter((label) => label !== "ScopeLeaseNode"))
    .slice(0, 4)
    .map(([label, count]) => `<span class="schema-chip ${schemaClass(label)}">${escapeHtml(label)} <b>${count}</b></span>`)
    .join("");
  elements.resultFrame.innerHTML = `
    ${userPanelHeader("Workspace", `${escapeHtml(String(totals.projects || 0))} projects · ${escapeHtml(String(totals.runningProjects || 0))} running`)}
    <div class="user-kpi-grid">
      <span><b>ScopeLease input</b><strong>${escapeHtml(contextDelta.codexInput || tokenCopy.actualInput)}</strong><em>agent-visible candidate</em></span>
      <span><b>KG view</b><strong>${escapeHtml(overview)}</strong><em>visible / stored nodes</em></span>
      <span><b>Trace paths</b><strong>${escapeHtml(String((paths || []).length))}</strong><em>evidence routes</em></span>
    </div>
    <div class="user-tag-row">${labels || "<span>No KG labels to show</span>"}</div>
    ${renderFilePathPanel(sourceGraph, analysis, pack)}
    ${renderHubProjectPanel(currentState)}
  `;
}

function renderFilePathPanel(sourceGraph = {}, analysis = {}, pack = {}) {
  const candidates = filePathCandidates(sourceGraph, analysis, pack);
  const totalFiles = (sourceGraph.nodes || []).filter((node) => node.path && isFileNode(node)).length;
  if (!candidates.length) return `
    <div class="file-path-panel">
      <div class="file-path-head"><b>Actual file paths</b><span>No KG file nodes</span></div>
    </div>
  `;
  const rows = candidates.slice(0, 12).map((item) => `
    <div class="file-path-row" title="${escapeHtml(item.path)}">
      ${escapeHtml(item.path)}
      <em>${escapeHtml(displayText(item.reason))}</em>
    </div>
  `).join("");
  return `
    <div class="file-path-panel">
      <div class="file-path-head"><b>Actual file paths</b><span>${escapeHtml(String(candidates.length))}/${escapeHtml(String(totalFiles))} shown</span></div>
      <div class="file-path-list">${rows}</div>
    </div>
  `;
}

function filePathCandidates(sourceGraph = {}, analysis = {}, pack = {}) {
  const byPath = new Map();
  const add = (path, reason, weight = 0) => {
    const value = String(path || "").trim();
    if (!value) return;
    const previous = byPath.get(value);
    if (!previous || weight > previous.weight) byPath.set(value, { path: value, reason, weight });
  };
  for (const file of analysis.changes?.files || []) add(file, "changed file", 1000);
  const readPlan = pack.agentContext?.readPlan || pack.codexInput?.promptContext?.readPlan || [];
  for (const item of readPlan) add(item.path || item.id || item.label, item.reason || "readPlan", 900);
  for (const item of pack.priorityContext || []) add(item.path, priorityReasonTextForUi(item.reason), 760);
  for (const node of sourceGraph.nodes || []) {
    if (!node.path || !isFileNode(node)) continue;
    add(node.path, nodeTypeLabel(node), filePathScore(node));
  }
  return [...byPath.values()]
    .sort((a, b) => b.weight - a.weight || a.path.localeCompare(b.path));
}

function filePathScore(node = {}) {
  const labels = new Set(nodeLabels(node));
  return (
    (labels.has("CodeFile") ? 600 : 0) +
    (labels.has("TestFile") ? 560 : 0) +
    (labels.has("Document") ? 420 : 0) +
    (labels.has("ConfigFile") ? 360 : 0) +
    (String(node.path || "").includes("src/") ? 60 : 0) +
    (String(node.path || "").includes("docs/") ? 35 : 0)
  );
}

function isFileNode(node = {}) {
  const labels = new Set(nodeLabels(node));
  return node.type === "file" || labels.has("File") || labels.has("CodeFile") || labels.has("TestFile") || labels.has("Document") || labels.has("ConfigFile");
}

function priorityReasonTextForUi(reason = "") {
  return {
    "changed since baseline": "changed file",
    "imports changed file": "imports changed file",
    "test edge points to changed file": "related test",
    "mentions changed symbol": "related doc"
  }[reason] || reason || "KG file node";
}

function renderHubProjectPanel(state = {}) {
  const isHub = state?.runtime?.hubMode === true || state?.runtime?.mode === "hub";
  if (!isHub) return "";
  const hub = hubProjectContext(state);
  const projects = Array.isArray(hub.projects) ? hub.projects : [];
  const totals = hub.totals || {};
  if (!projects.length) return `
    <div class="hub-projects-panel is-empty">
      <div class="hub-projects-head"><b>Hub</b><span>Waiting for Codex workspace inventory</span></div>
    </div>
  `;
  const rows = [...projects]
    .sort((left, right) =>
      Number(right.matchesCurrentRepo) - Number(left.matchesCurrentRepo) ||
      statusRank(right.runtime?.status) - statusRank(left.runtime?.status) ||
      timestampMs(right.codex?.latestUpdatedAt) - timestampMs(left.codex?.latestUpdatedAt)
    )
    .map((project) => {
      const status = project.runtime?.status || "stopped";
      return `
        <div class="hub-project-row">
          <span class="hub-status ${escapeHtml(status)}">${escapeHtml(formatHubStatus(status))}</span>
          <strong title="${escapeHtml(project.cwd || "")}">${escapeHtml(compactMiddle(project.name || project.cwd || "-", 28))}</strong>
          <small>${escapeHtml(String(project.codex?.threadRecords || 0))} threads · ${escapeHtml(project.scopelease?.attached ? "attached" : "not attached")}</small>
          <button type="button" data-hub-action="start" data-hub-repo="${escapeHtml(project.cwd || "")}">Start</button>
          <button type="button" data-hub-action="open" data-hub-repo="${escapeHtml(project.cwd || "")}">Open</button>
        </div>
      `;
    })
    .join("");
  return `
    <div class="hub-projects-panel">
      <div class="hub-projects-head">
        <b>Hub projects</b>
        <span>${escapeHtml(String(totals.projects || projects.length))} projects · ${escapeHtml(String(totals.runningProjects || 0))} running · local effects only</span>
      </div>
      <div class="hub-project-list">${rows}</div>
    </div>
  `;
}

function statusRank(status = "") {
  return {
    running: 4,
    port_busy_other_repo: 3,
    hub_control_port: 3,
    stopped: 2,
    not_checked: 1,
    missing_path: 0
  }[status] || 0;
}

function formatHubStatus(status = "") {
  return {
    running: "running",
    port_busy_other_repo: "busy",
    hub_control_port: "hub",
    stopped: "stopped",
    not_checked: "unchecked",
    missing_path: "missing"
  }[status] || status || "unknown";
}

function timestampMs(value = "") {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function topCounts(items, valuesForItem) {
  const counts = new Map();
  for (const item of items) {
    for (const value of valuesForItem(item) || []) {
      if (!value) continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function layoutGraph(graph, analysis) {
  const width = elements.canvas.clientWidth || window.innerWidth;
  const height = elements.canvas.clientHeight || window.innerHeight;
  const area = graphArea(width, height, graph.nodes.length);
  const cx = (area.left + area.right) / 2;
  const cy = (area.top + area.bottom) / 2;
  const rings = classifyNodes(graph.nodes, analysis);
  const positions = new Map();
  const densityScale = densityNodeScale(graph.nodes.length);
  const scale = viewState.scale * densityScale;
  const spacing = viewState.spacing * densitySpacing(graph.nodes.length);

  if (viewState.layout === "lanes") {
    placeDepthLanes(positions, graph, analysis, area, scale, spacing);
    applyManualPositions(positions);
    return positions;
  }

  if (isLargeFolderOverview(graph)) {
    placeFolderOverview(positions, graph, analysis, area, scale, spacing);
    applyManualPositions(positions);
    return positions;
  }

  if (viewState.layout === "cluster" || graph.nodes.length > 90 && viewState.layout === "radial") {
    placeForceClusters(positions, graph, analysis, area, scale, spacing);
    resolveCollisions(positions, area, graph.nodes.length);
    applyManualPositions(positions);
    return positions;
  }

  const xGap = 94 * spacing;
  const yGap = 78 * spacing;
  placeCluster(positions, rings.changed, cx, cy, "changed", scale, {
    xGap: xGap * 1.08,
    yGap: yGap * 1.08,
    columns: autoColumns(rings.changed.length, graph.nodes.length > 90 ? 6 : 3),
    area
  });

  placeCluster(positions, rings.symbol, cx, mix(area.top, cy, 0.28), "symbol", scale, { xGap, yGap, columns: autoColumns(rings.symbol.length, 6), area });
  placeCluster(positions, rings.route, mix(area.left, cx, 0.32), cy - 92 * spacing, "route", scale, { xGap, yGap, columns: autoColumns(rings.route.length, 3), area });
  placeCluster(positions, rings.policy, mix(area.left, cx, 0.24), cy + 92 * spacing, "policy", scale, { xGap, yGap, columns: autoColumns(rings.policy.length, 3), area });
  placeCluster(positions, rings.evidence, mix(cx, area.right, 0.68), cy, "evidence", scale, { xGap, yGap, columns: autoColumns(rings.evidence.length, 4), area });
  placeCluster(positions, rings.other, cx, mix(cy, area.bottom, 0.76), "other", scale, { xGap, yGap, columns: autoColumns(rings.other.length, 8), area });

  resolveCollisions(positions, area, graph.nodes.length);
  applyManualPositions(positions);
  return positions;
}

function isLargeFolderOverview(graph) {
  return viewState.scope === "all" && graph.nodes.length > 120 && !selectedNodeId && !viewState.query && viewState.focus === "all";
}

function placeFolderOverview(positions, graph, analysis, area, scale, spacing) {
  const clusters = buildFolderClusters(graph.nodes || [], analysis);
  if (!clusters.length) return;
  const degrees = graphDegrees(graph);
  const maxDegree = Math.max(1, ...degrees.values());
  const columns = Math.max(2, Math.ceil(Math.sqrt(clusters.length * ((area.right - area.left) / Math.max(1, area.bottom - area.top)))));
  const rows = Math.ceil(clusters.length / columns);
  const cellW = (area.right - area.left) / columns;
  const cellH = (area.bottom - area.top) / rows;

  clusters.forEach((cluster, clusterIndex) => {
    const column = clusterIndex % columns;
    const row = Math.floor(clusterIndex / columns);
    const cx = area.left + cellW * (column + 0.5);
    const cy = area.top + cellH * (row + 0.5);
    const sorted = [...cluster.nodes].sort((a, b) =>
      nodeOverviewRank(b, analysis, degrees) - nodeOverviewRank(a, analysis, degrees) ||
      nodeCaption(a).localeCompare(nodeCaption(b))
    );
    const nodeColumns = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(sorted.length))));
    const gapX = Math.max(54, Math.min(82, cellW / Math.max(1, nodeColumns + 0.8))) * spacing;
    const gapY = Math.max(48, Math.min(72, cellH / Math.max(1, Math.ceil(sorted.length / nodeColumns) + 0.8))) * spacing;
    const startX = cx - ((Math.min(nodeColumns, sorted.length) - 1) * gapX) / 2;
    const nodeRows = Math.ceil(sorted.length / nodeColumns);
    const startY = cy - ((nodeRows - 1) * gapY) / 2;

    sorted.forEach((node, nodeIndex) => {
      const visualClass = nodeVisualClass(node, analysis);
      const radius = nodeRadius(node, visualClass, scale, degreeScale(node.id, degrees, maxDegree));
      const localColumn = nodeIndex % nodeColumns;
      const localRow = Math.floor(nodeIndex / nodeColumns);
      positions.set(node.id, {
        ...node,
        className: visualClass,
        radius,
        clusterKey: cluster.key,
        clusterLabel: cluster.label,
        x: clamp(startX + localColumn * gapX, area.left + radius, area.right - radius),
        y: clamp(startY + localRow * gapY, area.top + radius, area.bottom - radius)
      });
    });
  });
}

function nodeOverviewRank(node, analysis, degrees) {
  const visual = nodeVisualClass(node, analysis);
  const rank = { policy: 9000, route: 7600, changed: 6800, evidence: 5200, symbol: 2600, other: 0 };
  return (rank[visual] || 0) + (degrees.get(node.id) || 0) * 30;
}

function placeDepthLanes(positions, graph, analysis, area, scale, spacing) {
  const nodes = graph.nodes || [];
  if (!nodes.length) return;
  const degrees = graphDegrees(graph);
  const maxDegree = Math.max(1, ...degrees.values());
  const lanes = new Map();

  for (const node of nodes) {
    const visualClass = nodeVisualClass(node, analysis);
    const lane = depthLaneForNode(node, visualClass, analysis);
    if (!lanes.has(lane.key)) lanes.set(lane.key, { ...lane, nodes: [] });
    lanes.get(lane.key).nodes.push({ node, visualClass });
  }

  const laneEntries = [...lanes.values()].sort((a, b) =>
    a.depth - b.depth ||
    a.order - b.order ||
    a.label.localeCompare(b.label)
  );
  const worldWidth = Math.max(420, area.right - area.left, laneEntries.length * 180);
  const layoutRight = area.left + worldWidth;
  const availableHeight = Math.max(220, area.bottom - area.top);
  const totalWeight = laneEntries.reduce((sum, lane) => sum + depthLaneWeight(lane.nodes.length), 0) || 1;
  let laneCursor = area.left;

  laneEntries.forEach((lane, laneIndex) => {
    const laneWidth = Math.max(150, (worldWidth * depthLaneWeight(lane.nodes.length)) / totalWeight);
    const laneLeft = laneCursor;
    const laneRight = laneIndex === laneEntries.length - 1 ? layoutRight : laneLeft + laneWidth;
    laneCursor = laneRight;
    const sorted = [...lane.nodes].sort((a, b) =>
      depthNodeRank(b.node, b.visualClass, analysis, degrees) -
      depthNodeRank(a.node, a.visualClass, analysis, degrees) ||
      depthSortLabel(a.node, analysis).localeCompare(depthSortLabel(b.node, analysis))
    );
    const laneScale = scale * depthLaneScale(sorted.length, nodes.length);
    const rowGap = Math.max(depthLaneMaxRadius(sorted.length) * 2 + 9, 30 * spacing);
    const maxRows = Math.max(1, Math.floor(availableHeight / rowGap));
    const rows = Math.max(1, Math.min(maxRows, sorted.length));
    const columns = Math.max(1, Math.ceil(sorted.length / rows));
    const columnGap = Math.max(depthLaneMaxRadius(sorted.length) * 2 + 18, (laneRight - laneLeft) / (columns + 1));
    const usedRows = Math.ceil(sorted.length / columns);
    const startY = area.top + Math.max(0, (availableHeight - (usedRows - 1) * rowGap) / 2);

    sorted.forEach(({ node, visualClass }, index) => {
      const radius = Math.min(
        nodeRadius(node, visualClass, laneScale, degreeScale(node.id, degrees, maxDegree)),
        depthLaneRadiusCap(sorted.length, visualClass)
      );
      const column = Math.floor(index / rows);
      const row = index % rows;
      const x = laneLeft + columnGap * (column + 1);
      const y = startY + row * rowGap;
      positions.set(node.id, {
        ...node,
        x: clamp(x, area.left + radius, layoutRight - radius),
        y: clamp(y, area.top + radius, area.bottom - radius),
        radius,
        className: visualClass,
        depthLane: lane.key,
        depthLaneLabel: lane.label,
        depthLaneIndex: laneIndex
      });
    });
  });
}

function depthLaneWeight(count) {
  return Math.max(1, Math.sqrt(Math.max(1, count)));
}

function depthLaneScale(count, total) {
  if (total > 140) return count > 64 ? 0.46 : count > 32 ? 0.56 : 0.7;
  if (total > 80) return count > 48 ? 0.52 : count > 24 ? 0.66 : 0.8;
  return count > 24 ? 0.76 : 0.92;
}

function depthLaneMaxRadius(count) {
  if (count > 64) return 24;
  if (count > 32) return 29;
  if (count > 16) return 34;
  return 42;
}

function depthLaneRadiusCap(count, visualClass) {
  const cap = depthLaneMaxRadius(count);
  if (visualClass === "changed") return Math.min(cap, count > 32 ? 26 : 36);
  if (visualClass === "policy") return Math.min(cap, count > 32 ? 22 : 32);
  if (visualClass === "evidence") return Math.min(cap, count > 32 ? 18 : 28);
  return Math.min(cap, count > 32 ? 17 : 25);
}

function buildLaneLayoutMetrics(positions, graph = {}) {
  const groups = new Map();
  for (const node of positions.values()) {
    if (!node.depthLane) continue;
    if (!groups.has(node.depthLane)) {
      groups.set(node.depthLane, {
        key: node.depthLane,
        label: node.depthLaneLabel || node.depthLane,
        index: node.depthLaneIndex || 0,
        nodes: []
      });
    }
    groups.get(node.depthLane).nodes.push(node);
  }

  const lanes = [...groups.values()]
    .sort((a, b) => a.index - b.index)
    .map((lane) => {
      const bounds = laneNodeBounds(lane.nodes);
      const overlap = laneOverlapMetrics(lane.nodes);
      const nodeArea = lane.nodes.reduce((sum, node) => sum + Math.PI * node.radius * node.radius, 0);
      const boxArea = Math.max(1, bounds.width * bounds.height);
      const density = nodeArea / boxArea;
      const columns = new Set(lane.nodes.map((node) => Math.round(node.x))).size;
      const rows = new Set(lane.nodes.map((node) => Math.round(node.y))).size;
      return {
        key: lane.key,
        label: lane.label,
        index: lane.index,
        count: lane.nodes.length,
        rows,
        columns,
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
        density: roundMetric(density),
        overlapCount: overlap.count,
        minGap: roundMetric(overlap.minGap),
        maxRadius: roundMetric(Math.max(...lane.nodes.map((node) => node.radius), 0)),
        status: overlap.count > 0 ? "overlap" : density > 0.42 ? "dense" : "ok"
      };
    });

  const summary = {
    laneCount: lanes.length,
    totalOverlapCount: lanes.reduce((sum, lane) => sum + lane.overlapCount, 0),
    maxDensity: roundMetric(Math.max(...lanes.map((lane) => lane.density), 0)),
    denseLaneCount: lanes.filter((lane) => lane.status === "dense").length,
    overlapLaneCount: lanes.filter((lane) => lane.overlapCount > 0).length
  };

  return {
    kind: "scopelease.graph_layout_metrics",
    layout: viewState.layout,
    scope: viewState.scope,
    nodeCount: (graph.nodes || []).length,
    edgeCount: (graph.edges || []).length,
    lanes,
    summary
  };
}

function laneNodeBounds(nodes = []) {
  if (!nodes.length) return { width: 0, height: 0 };
  const left = Math.min(...nodes.map((node) => node.x - node.radius));
  const right = Math.max(...nodes.map((node) => node.x + node.radius));
  const top = Math.min(...nodes.map((node) => node.y - node.radius));
  const bottom = Math.max(...nodes.map((node) => node.y + node.radius));
  return { width: right - left, height: bottom - top };
}

function laneOverlapMetrics(nodes = []) {
  let count = 0;
  let minGap = Number.POSITIVE_INFINITY;
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      const gap = Math.hypot(a.x - b.x, a.y - b.y) - a.radius - b.radius;
      minGap = Math.min(minGap, gap);
      if (gap < -0.5) count += 1;
    }
  }
  return {
    count,
    minGap: Number.isFinite(minGap) ? minGap : 0
  };
}

function roundMetric(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000) / 1000;
}

function depthLaneForNode(node, visualClass, analysis) {
  const pathValue = relativeNodePath(node, analysis);
  const pathDepth = pathValue ? Math.min(6, pathValue.split("/").filter(Boolean).length) : 0;
  const symbolOffset = visualClass === "symbol" ? 1 : 0;
  const visualDepth = {
    policy: 0,
    route: 1,
    changed: Math.max(1, pathDepth),
    evidence: Math.max(1, pathDepth),
    symbol: Math.max(2, pathDepth + symbolOffset),
    other: Math.max(1, pathDepth)
  }[visualClass] ?? Math.max(1, pathDepth);
  const depth = Math.min(7, visualDepth);
  const order = { policy: 0, route: 1, changed: 2, evidence: 3, symbol: 4, other: 5 }[visualClass] ?? 6;
  return {
    key: `depth:${depth}`,
    depth,
    order,
    label: depth === 0 ? "root / policy" : `depth ${depth}${depth >= 7 ? "+" : ""}`
  };
}

function relativeNodePath(node, analysis) {
  const repo = String(analysis.repo || "").replace(/\/+$/, "");
  let value = String(node.path || node.properties?.path || "");
  if (!value && node.id?.startsWith("file:")) value = node.id.slice(5);
  if (!value) return "";
  value = value.replace(/^file:/, "").replace(/^\.\//, "");
  if (repo && value === repo) return "";
  if (repo && value.startsWith(`${repo}/`)) value = value.slice(repo.length + 1);
  return value.replace(/^\/+/, "");
}

function depthNodeRank(node, visualClass, analysis, degrees) {
  const rank = { policy: 9000, route: 7600, changed: 6800, evidence: 5200, symbol: 3400, other: 0 };
  const changedBoost = isChangedNode(node, analysis) ? 1200 : 0;
  return (rank[visualClass] || 0) + changedBoost + (degrees.get(node.id) || 0) * 24;
}

function depthSortLabel(node, analysis) {
  return relativeNodePath(node, analysis) || nodeCaption(node) || node.id || "";
}

function buildFolderClusters(nodes, analysis) {
  const map = new Map();
  const anchorMap = buildDecisionAnchorMap(analysis);
  for (const node of nodes) {
    const cluster = nodeCluster(node, analysis, anchorMap);
    if (!map.has(cluster.key)) map.set(cluster.key, { ...cluster, nodes: [] });
    map.get(cluster.key).nodes.push(node);
  }

  return [...map.values()]
    .map((cluster) => ({
      ...cluster,
      changedCount: cluster.nodes.filter((node) => nodeVisualClass(node, analysis) === "changed").length,
      policyCount: cluster.nodes.filter((node) => nodeVisualClass(node, analysis) === "policy").length
    }))
    .sort((a, b) =>
      b.changedCount - a.changedCount ||
      b.policyCount - a.policyCount ||
      b.nodes.length - a.nodes.length ||
      a.label.localeCompare(b.label)
    );
}

function placeForceClusters(positions, graph, analysis, area, scale, spacing) {
  const nodes = graph.nodes || [];
  if (!nodes.length) return;
  const clusters = buildFolderClusters(nodes, analysis);
  const clusterByNode = new Map();
  for (const cluster of clusters) {
    for (const node of cluster.nodes) clusterByNode.set(node.id, cluster);
  }
  const centers = clusterCenters(clusters, area, graph, clusterByNode);
  const degrees = graphDegrees(graph);
  const maxDegree = Math.max(1, ...degrees.values());
  const simNodes = nodes.map((node, index) => {
    const cluster = clusterByNode.get(node.id) || nodeCluster(node, analysis);
    const center = centers.get(cluster.key) || { x: (area.left + area.right) / 2, y: (area.top + area.bottom) / 2 };
    const visualClass = nodeVisualClass(node, analysis);
    const radius = nodeRadius(node, visualClass, scale, degreeScale(node.id, degrees, maxDegree));
    const localIndex = cluster.nodes?.findIndex((item) => item.id === node.id) ?? index;
    const localAngle = goldenAngle(localIndex);
    const localRadius = 18 + Math.sqrt(localIndex + 1) * (radius + 9) * spacing;
    return {
      ...node,
      className: visualClass,
      radius,
      clusterKey: cluster.key,
      clusterLabel: cluster.label,
      x: clamp(center.x + Math.cos(localAngle) * localRadius, area.left + radius, area.right - radius),
      y: clamp(center.y + Math.sin(localAngle) * localRadius, area.top + radius, area.bottom - radius),
      vx: 0,
      vy: 0
    };
  });

  const byId = new Map(simNodes.map((node) => [node.id, node]));
  const simEdges = (graph.edges || [])
    .map((edge) => ({ ...edge, sourceNode: byId.get(edge.source), targetNode: byId.get(edge.target) }))
    .filter((edge) => edge.sourceNode && edge.targetNode);
  const iterations = nodes.length > 180 ? 145 : nodes.length > 90 ? 120 : 92;
  const repulsion = nodes.length > 180 ? 860 : nodes.length > 90 ? 1040 : 1280;
  const edgeStrength = nodes.length > 140 ? 0.006 : 0.009;
  const clusterStrength = nodes.length > 140 ? 0.018 : 0.026;
  const damping = 0.72;
  const padding = nodes.length > 120 ? 6 : 9;

  for (let round = 0; round < iterations; round += 1) {
    for (let i = 0; i < simNodes.length; i += 1) {
      const a = simNodes[i];
      for (let j = i + 1; j < simNodes.length; j += 1) {
        const b = simNodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 1) {
          const angle = goldenAngle(i + j + round);
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distSq = 1;
        }
        const dist = Math.sqrt(distSq);
        const sameCluster = a.clusterKey === b.clusterKey;
        const minDist = a.radius + b.radius + padding;
        const force = (repulsion * (sameCluster ? 0.72 : 1.18)) / Math.max(distSq, 160);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;

        if (dist < minDist) {
          const push = (minDist - dist) * 0.055;
          const ox = (dx / dist) * push;
          const oy = (dy / dist) * push;
          a.vx -= ox;
          a.vy -= oy;
          b.vx += ox;
          b.vy += oy;
        }
      }
    }

    for (const edge of simEdges) {
      const source = edge.sourceNode;
      const target = edge.targetNode;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const dist = Math.max(1, Math.hypot(dx, dy));
      const desired = edgeLength(edge, source, target, spacing);
      const force = (dist - desired) * edgeStrength * edgeWeight(edge);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      source.vx += fx;
      source.vy += fy;
      target.vx -= fx;
      target.vy -= fy;
    }

    for (const node of simNodes) {
      const center = centers.get(node.clusterKey);
      if (center) {
        node.vx += (center.x - node.x) * clusterStrength;
        node.vy += (center.y - node.y) * clusterStrength;
      }
      node.vx *= damping;
      node.vy *= damping;
      node.x = clamp(node.x + node.vx, area.left + node.radius, area.right - node.radius);
      node.y = clamp(node.y + node.vy, area.top + node.radius, area.bottom - node.radius);
    }
  }

  for (const node of simNodes) {
    delete node.vx;
    delete node.vy;
    positions.set(node.id, node);
  }
}

function clusterCenters(clusters, area, graph, clusterByNode) {
  const centers = new Map();
  const cx = (area.left + area.right) / 2;
  const cy = (area.top + area.bottom) / 2;
  const rx = Math.max(180, (area.right - area.left) * 0.33);
  const ry = Math.max(150, (area.bottom - area.top) * 0.3);
  const simClusters = clusters.map((cluster, index) => {
    const priorityAngle = cluster.key === "policy"
      ? Math.PI * 0.92
      : cluster.key === "route"
        ? Math.PI * 0.08
        : goldenAngle(index + 1);
    const radiusScale = cluster.changedCount ? 0.18 : cluster.policyCount ? 0.54 : 0.74 + (index % 4) * 0.08;
    const anchor = {
      x: cx + Math.cos(priorityAngle) * rx * radiusScale,
      y: cy + Math.sin(priorityAngle) * ry * radiusScale
    };
    return {
      ...cluster,
      x: anchor.x,
      y: anchor.y,
      vx: 0,
      vy: 0,
      anchor,
      radius: clusterRadiusEstimate(cluster)
    };
  });

  const byKey = new Map(simClusters.map((cluster) => [cluster.key, cluster]));
  const aggregateEdges = aggregateClusterEdges(graph, clusterByNode);
  const iterations = simClusters.length > 12 ? 90 : 72;

  for (let round = 0; round < iterations; round += 1) {
    for (let i = 0; i < simClusters.length; i += 1) {
      const a = simClusters[i];
      for (let j = i + 1; j < simClusters.length; j += 1) {
        const b = simClusters[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 1) {
          const angle = goldenAngle(i + j + round + 1);
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distSq = 1;
        }
        const dist = Math.sqrt(distSq);
        const desired = a.radius + b.radius + 96;
        const repulsion = (desired * desired) / Math.max(distSq, 160);
        const fx = (dx / dist) * repulsion * 0.42;
        const fy = (dy / dist) * repulsion * 0.42;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }

    for (const edge of aggregateEdges) {
      const source = byKey.get(edge.source);
      const target = byKey.get(edge.target);
      if (!source || !target) continue;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const dist = Math.max(1, Math.hypot(dx, dy));
      const desired = source.radius + target.radius + 84 + Math.min(120, edge.weight * 9);
      const force = (dist - desired) * 0.018 * Math.min(2.2, 0.8 + edge.weight * 0.16);
      source.vx += (dx / dist) * force;
      source.vy += (dy / dist) * force;
      target.vx -= (dx / dist) * force;
      target.vy -= (dy / dist) * force;
    }

    for (const cluster of simClusters) {
      const anchorStrength = cluster.changedCount ? 0.035 : cluster.kind === "policy" || cluster.kind === "route" ? 0.018 : 0.01;
      cluster.vx += (cluster.anchor.x - cluster.x) * anchorStrength;
      cluster.vy += (cluster.anchor.y - cluster.y) * anchorStrength;
      cluster.vx *= 0.68;
      cluster.vy *= 0.68;
      cluster.x = clamp(cluster.x + cluster.vx, area.left + cluster.radius, area.right - cluster.radius);
      cluster.y = clamp(cluster.y + cluster.vy, area.top + cluster.radius, area.bottom - cluster.radius);
    }
  }

  for (const cluster of simClusters) {
    centers.set(cluster.key, {
      x: cluster.x,
      y: cluster.y,
      label: cluster.label,
      kind: cluster.kind
    });
  }
  return centers;
}

function graphDegrees(graph) {
  const degrees = new Map((graph.nodes || []).map((node) => [node.id, 0]));
  for (const edge of graph.edges || []) {
    degrees.set(edge.source, (degrees.get(edge.source) || 0) + 1);
    degrees.set(edge.target, (degrees.get(edge.target) || 0) + 1);
  }
  return degrees;
}

function degreeScale(id, degrees, maxDegree) {
  const degree = degrees.get(id) || 0;
  if (!degree) return 0.92;
  return 0.94 + Math.min(0.28, degree / Math.max(1, maxDegree) * 0.28);
}

function clusterRadiusEstimate(cluster) {
  return Math.max(72, Math.sqrt(cluster.nodes.length) * 42 + (cluster.changedCount ? 28 : 0));
}

function aggregateClusterEdges(graph, clusterByNode) {
  const weights = new Map();
  for (const edge of graph.edges || []) {
    const source = clusterByNode.get(edge.source);
    const target = clusterByNode.get(edge.target);
    if (!source || !target || source.key === target.key) continue;
    const keys = [source.key, target.key].sort();
    const key = `${keys[0]}::${keys[1]}`;
    weights.set(key, (weights.get(key) || 0) + edgeWeight(edge));
  }
  return [...weights.entries()].map(([key, weight]) => {
    const [source, target] = key.split("::");
    return { source, target, weight };
  });
}

function edgeLength(edge, source, target, spacing) {
  if (source.clusterKey === target.clusterKey) return 84 * spacing;
  if (edge.type === "policy_hit") return 124 * spacing;
  if (edge.type === "tests" || edge.type === "mentions") return 132 * spacing;
  return 118 * spacing;
}

function edgeWeight(edge) {
  if (edge.type === "policy_hit") return 1.35;
  if (edge.type === "imports") return 1.08;
  if (edge.type === "defines") return 0.84;
  return 1;
}

function goldenAngle(index) {
  return index * 2.399963229728653;
}

function nodeCluster(node, analysis, anchorMap = null) {
  const anchored = anchorMap?.get(node.id);
  if (viewState.scope === "decision" && anchored) {
    return {
      key: `anchor:${anchored.id}`,
      label: `Anchor ${compactLabel(anchored.path || anchored.label || anchored.id, 24)}`,
      kind: folderKind(folderClusterLabel(anchored.path || anchored.label || ""), anchored)
    };
  }

  const visual = nodeVisualClass(node, analysis);
  if (visual === "policy") return { key: "policy", label: "Policy", kind: "policy" };
  if (visual === "route") return { key: "route", label: "Route", kind: "route" };
  const pathValue = node.path || node.label || "";
  if (!pathValue) return { key: "unknown", label: "Unclassified", kind: "other" };
  const label = folderClusterLabel(pathValue);
  return { key: `folder:${label}`, label, kind: folderKind(label, node) };
}

function buildDecisionAnchorMap(analysis) {
  const anchors = new Map();
  const changedIds = changedNodeIds(analysis);
  const nodeById = new Map((analysis.graph?.nodes || []).map((node) => [node.id, node]));
  const changedFiles = new Set(analysis.changes?.files || []);

  for (const file of changedFiles) {
    const fileNode = nodeById.get(`file:${file}`) || { id: `file:${file}`, label: file, path: file, type: "file" };
    anchors.set(fileNode.id, fileNode);
    for (const symbol of analysis.changes?.symbols?.[file] || []) {
      if (symbol.id) anchors.set(symbol.id, fileNode);
    }
  }

  for (const path of analysis.impact?.paths || []) {
    const nodes = path.nodes || [];
    const fileAnchor = nodes.find((node) => node.path && changedFiles.has(node.path) && node.id.startsWith("file:"));
    const changedAnchor = nodes.find((node) => changedIds.has(node.id)) || nodes.find((node) => nodeVisualClass(node, analysis) === "changed");
    const anchor = fileAnchor || fileAnchorForNode(changedAnchor, nodeById, changedFiles);
    if (!anchor) continue;
    const fullAnchor = nodeById.get(anchor.id) || anchor;
    for (const node of nodes) anchors.set(node.id, fullAnchor);
  }

  return anchors;
}

function fileAnchorForNode(node, nodeById, changedFiles) {
  if (!node) return null;
  if (node.path && changedFiles.has(node.path)) {
    return nodeById.get(`file:${node.path}`) || { id: `file:${node.path}`, label: node.path, path: node.path, type: "file" };
  }
  if (node.id?.startsWith("file:")) return node;
  return null;
}

function folderClusterLabel(pathValue) {
  const parts = String(pathValue).split("/").filter(Boolean);
  if (!parts.length) return "root";
  if (parts[0] === "src" && parts[1]) return `${parts[0]}/${parts[1]}`;
  if (parts[0] === "examples" && parts[1]) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

function folderKind(label, node) {
  if (node.fileType === "test" || label.includes("test")) return "test";
  if (node.fileType === "doc" || label === "docs") return "doc";
  if (label === "public") return "ui";
  if (label.startsWith("src")) return "code";
  return "other";
}

function nodeVisualClass(node, analysis) {
  const changedIds = new Set((analysis.changes?.files || []).map((file) => `file:${file}`));
  const routeIds = new Set((analysis.impact?.routes || []).map((item) => item.id));
  const policyIds = new Set((analysis.policyHits || []).map((hit) => `policy:${hit.ruleId}`));
  const labels = new Set(nodeLabels(node));
  const evidenceIds = new Set([
    ...(analysis.impact?.importedBy || []).map((item) => item.id),
    ...(analysis.impact?.tests || []).map((item) => item.id),
    ...(analysis.impact?.docs || []).map((item) => item.id)
  ]);

  if (labels.has("Policy") || policyIds.has(node.id) || node.type === "policy") return "policy";
  if (labels.has("Route") || routeIds.has(node.id) || node.type === "route") return "route";
  if (labels.has("CodexThreadRecord") || labels.has("CodexWorkspace") || labels.has("CodexRepo")) return "evidence";
  if (labels.has("Function") || labels.has("Class") || labels.has("Type") || node.type === "changed_function" || node.type === "changed_type" || node.type === "function" || node.type === "type") return "symbol";
  if (labels.has("TestFile") || labels.has("Document") || evidenceIds.has(node.id) || node.fileType === "test" || node.fileType === "doc") return "evidence";
  if (node.properties?.changed || labels.has("Changed") || changedIds.has(node.id) || node.type === "changed_file") return "changed";
  return "other";
}

function isCodexUsageNode(node = {}) {
  const labels = new Set(nodeLabels(node));
  return labels.has("CodexUsage") || labels.has("CodexThreadRecord") || labels.has("CodexWorkspace") || labels.has("CodexRepo") || labels.has("ScopeLeaseHub") || labels.has("ScopeLeaseProject");
}

function nodeLabels(node) {
  return node.labels || [node.identity?.displayTypeKo || node.type || "Node"].filter(Boolean);
}

function relationshipType(edge) {
  return edge.relationshipType || {
    defines: "DEFINES",
    imports: "IMPORTS",
    imported_by: "IMPORTED_BY",
    route: "EXPOSES",
    defined_by: "DEFINED_BY",
    tests: "TESTS",
    mentions: "MENTIONS",
    policy_hit: "VIOLATES_POLICY"
  }[edge.type] || String(edge.type || "RELATED_TO").toUpperCase();
}

function primaryLabel(node) {
  return nodeLabels(node).filter((label) => label !== "ScopeLeaseNode")[0] || "Node";
}

function relationshipBasis(edge) {
  const properties = edge.properties || {};
  if (properties.reason) return properties.reason;
  if (properties.basis) return properties.basis;
  if (properties.source && properties.line) return `${properties.source}:${properties.line}`;
  if (properties.source) return properties.source;
  if (properties.route) return routeLabel(properties.route);
  if (edge.meta?.reason) return edge.meta.reason;
  return edgeTypeLabel(edge.type || relationshipType(edge));
}

function schemaClass(label) {
  if (label === "Changed") return "changed";
  if (label === "Policy") return "policy";
  if (label === "Route") return "route";
  if (["TestFile", "Document", "Evidence", "CodexUsage", "CodexThreadRecord", "CodexWorkspace", "CodexRepo", "ScopeLeaseHub", "ScopeLeaseProject"].includes(label)) return "evidence";
  if (["Function", "Class", "Type"].includes(label)) return "symbol";
  return "other";
}

function graphArea(width, height, nodeCount = 0) {
  const compact = width <= 720;
  const worldScale = densityWorldScale(nodeCount);
  const worldWidth = width * worldScale;
  const worldHeight = height * worldScale;
  const sideOverflow = (worldWidth - width) / 2;
  const verticalOverflow = (worldHeight - height) / 2;
  if (isSidecarMode) {
    return {
      left: 118,
      right: width - 34 + sideOverflow * 2,
      top: 38 - verticalOverflow,
      bottom: height - 38 + verticalOverflow
    };
  }
  return {
    left: 30 - sideOverflow,
    right: width - 30 + sideOverflow,
    top: (compact ? 348 : 284) - verticalOverflow,
    bottom: height - (compact ? 232 : 220) + verticalOverflow
  };
}

function densityWorldScale(nodeCount) {
  if (nodeCount > 180) return 2.6;
  if (nodeCount > 100) return 2.15;
  if (nodeCount > 56) return 1.65;
  return 1;
}

function densityNodeScale(nodeCount) {
  if (nodeCount > 180) return 0.44;
  if (nodeCount > 100) return 0.56;
  if (nodeCount > 56) return 0.76;
  return 1;
}

function densitySpacing(nodeCount) {
  if (nodeCount > 180) return 1.36;
  if (nodeCount > 100) return 1.24;
  if (nodeCount > 56) return 1.12;
  return 1;
}

function classifyNodes(nodes, analysis) {
  const groups = { changed: [], route: [], policy: [], evidence: [], symbol: [], other: [] };
  for (const node of nodes) {
    groups[nodeVisualClass(node, analysis)].push(node);
  }
  return groups;
}

function placeCluster(positions, nodes, anchorX, anchorY, className, scale, options) {
  if (!nodes.length) return;
  const columns = Math.max(1, Math.min(options.columns || autoColumns(nodes.length), nodes.length));
  const rows = Math.ceil(nodes.length / columns);
  const startX = anchorX - ((columns - 1) * options.xGap) / 2;
  const startY = anchorY - ((rows - 1) * options.yGap) / 2;
  nodes.forEach((node, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const nodeClassName = options.classForNode ? options.classForNode(node) : className;
    const radius = nodeRadius(node, nodeClassName, scale);
    positions.set(node.id, {
      ...node,
      x: clamp(startX + col * options.xGap, options.area.left + radius, options.area.right - radius),
      y: clamp(startY + row * options.yGap, options.area.top + radius, options.area.bottom - radius),
      radius,
      className: nodeClassName
    });
  });
}

function placeLane(positions, nodes, x, className, scale = 1, center = false, area = { top: 130, bottom: 760, left: 0, right: 1000 }) {
  if (!nodes.length) return;
  const radius = nodeRadius(nodes[0], className, scale);
  const safeBottom = Math.max(area.top + 90, area.bottom);
  const rowGap = Math.max(radius * 2 + 14, 54 * viewState.spacing);
  const availableRows = Math.max(1, Math.floor((safeBottom - area.top) / rowGap));
  const columns = Math.max(1, Math.ceil(nodes.length / availableRows));
  const columnGap = Math.max(radius * 2 + 22, 72 * viewState.spacing);
  const rows = Math.ceil(nodes.length / columns);
  const startY = center ? area.top + (safeBottom - area.top - (rows - 1) * rowGap) / 2 : area.top;
  const startX = x - ((columns - 1) * columnGap) / 2;
  nodes.forEach((node, index) => {
    const nodeRadiusValue = nodeRadius(node, className, scale);
    const column = Math.floor(index / rows);
    const row = index % rows;
    positions.set(node.id, {
      ...node,
      x: clamp(startX + column * columnGap, area.left + nodeRadiusValue, area.right - nodeRadiusValue),
      y: clamp(startY + row * rowGap, area.top + nodeRadiusValue, area.bottom - nodeRadiusValue),
      radius: nodeRadiusValue,
      className
    });
  });
}

function nodeRadius(node, className, scale = 1, importance = 1) {
  const base = className === "changed"
    ? 56
    : className === "policy"
      ? 40
      : className === "symbol"
        ? 34
        : 36;
  return base * scale * importance;
}

function applyManualPositions(positions) {
  for (const [id, manual] of manualPositions) {
    const node = positions.get(id);
    if (!node) continue;
    positions.set(id, { ...node, x: manual.x, y: manual.y });
  }
}

function resolveCollisions(positions, area, nodeCount) {
  const nodes = [...positions.values()];
  const iterations = nodeCount > 160 ? 92 : nodeCount > 72 ? 72 : 42;
  const padding = nodeCount > 100 ? 7 : 10;
  const centerX = (area.left + area.right) / 2;
  const centerY = (area.top + area.bottom) / 2;

  for (let round = 0; round < iterations; round += 1) {
    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) {
          const angle = ((i + 1) * 37 + (j + 1) * 17) % 360;
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          dist = 1;
        }

        const minDist = a.radius + b.radius + padding;
        if (dist >= minDist) continue;
        const push = ((minDist - dist) / dist) * 0.5;
        const ox = dx * push;
        const oy = dy * push;
        a.x -= ox;
        a.y -= oy;
        b.x += ox;
        b.y += oy;
      }
    }

    for (const node of nodes) {
      const pull = node.className === "changed" ? 0.003 : 0.0012;
      node.x += (centerX - node.x) * pull;
      node.y += (centerY - node.y) * pull;
      node.x = clamp(node.x, area.left + node.radius, area.right - node.radius);
      node.y = clamp(node.y, area.top + node.radius, area.bottom - node.radius);
    }
  }

  for (const node of nodes) positions.set(node.id, node);
}

function autoColumns(length, preferred = 4) {
  if (length <= 1) return 1;
  return Math.max(1, Math.min(length, Math.ceil(Math.sqrt(length)), preferred));
}

function mix(a, b, amount) {
  return a + (b - a) * amount;
}

function viewportTransform() {
  return `translate(${viewportState.panX} ${viewportState.panY}) scale(${viewportState.zoom})`;
}

function drawSvg(graph, positions, analysis, paths, context, eventReason = "render") {
  const svg = elements.canvas;
  const width = svg.clientWidth || window.innerWidth;
  const height = svg.clientHeight || window.innerHeight;
  const denseOverview = isDenseOverview(graph);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.classList.toggle("edge-labels-hidden", !viewState.relationLabels);
  svg.classList.toggle("dense-graph", graph.nodes.length > 90);
  svg.onpointerdown = (event) => {
    if (event.target === svg) startCanvasPan(event);
  };
  svg.onclick = () => {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    selectedNodeId = null;
    render(analysis);
  };
  svg.innerHTML = `
    <defs>
      <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
        <path d="M0,0 L8,4 L0,8 z" fill="rgba(224,231,226,0.58)"></path>
      </marker>
    </defs>
  `;

  const viewport = document.createElementNS("http://www.w3.org/2000/svg", "g");
  viewport.setAttribute("class", "viewport");
  viewport.setAttribute("transform", viewportTransform());
  svg.appendChild(viewport);

  if (viewState.layout === "lanes") drawDepthLaneGuides(viewport, positions);
  if (viewState.layout !== "lanes" && denseOverview) drawClusterLinks(viewport, graph, positions, analysis);
  if (viewState.layout !== "lanes" && (viewState.layout === "cluster" || graph.nodes.length > 90)) drawClusterHulls(viewport, positions, analysis);
  drawDelegationBoundaries(viewport, graph, positions, analysis);
  if (viewState.pathBands) drawPathBands(viewport, positions, paths, context, denseOverview);

  for (const edge of graph.edges || []) {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) continue;
    const strong = isEvidenceEdge(edge, paths);
    if (denseOverview && !strong && edge.type !== "policy_hit") continue;
    const dim = shouldDimEdge(edge, paths, context.activeNodeIds);
    drawEdge(viewport, source, target, edge, strong, dim);
  }

  drawQueryWaves(viewport, positions, context.queryIds);

  const labelIds = visibleLabelIds(graph, positions, analysis, context, denseOverview);
  const animateMoves = shouldAnimateLayoutTransition(eventReason);
  for (const node of positions.values()) {
    drawNode(
      viewport,
      node,
      analysis,
      shouldDimNode(node, context.activeNodeIds),
      node.id === selectedNodeId,
      nodeClasses(node, analysis, context),
      labelIds.has(node.id),
      animateMoves ? lastPositions.get(node.id) : null
    );
  }

  drawGhostNodes(viewport);
}

function shouldAnimateLayoutTransition(eventReason = "") {
  if (viewState.layout !== "lanes") return false;
  return !["render", "drag", "drag_start", "drag_end", "marker_cleanup"].includes(eventReason);
}

function isDenseOverview(graph) {
  return graph.nodes.length > 90 && !selectedNodeId && !viewState.query && viewState.focus === "all";
}

function drawDepthLaneGuides(svg, positions) {
  const nodes = [...positions.values()].filter((node) => node.depthLane);
  if (nodes.length < 2) return;
  const lanes = new Map();
  const metricsByKey = new Map((currentLaneMetrics?.lanes || []).map((lane) => [lane.key, lane]));
  for (const node of nodes) {
    if (!lanes.has(node.depthLane)) {
      lanes.set(node.depthLane, {
        label: node.depthLaneLabel || node.depthLane,
        index: node.depthLaneIndex || 0,
        nodes: []
      });
    }
    lanes.get(node.depthLane).nodes.push(node);
  }
  const top = Math.min(...nodes.map((node) => node.y - node.radius));
  const bottom = Math.max(...nodes.map((node) => node.y + node.radius)) + 22;
  const layer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  layer.setAttribute("class", "depth-lane-guides");
  for (const lane of [...lanes.values()].sort((a, b) => a.index - b.index)) {
    const x = lane.nodes.reduce((sum, node) => sum + node.x, 0) / lane.nodes.length;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", x);
    line.setAttribute("x2", x);
    line.setAttribute("y1", top + 28);
    line.setAttribute("y2", bottom);
    layer.appendChild(line);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", x);
    label.setAttribute("y", top + 14);
    label.textContent = `${lane.label} · ${lane.nodes.length}`;
    layer.appendChild(label);

    const metrics = metricsByKey.get(lane.nodes[0]?.depthLane);
    if (metrics) {
      const metric = document.createElementNS("http://www.w3.org/2000/svg", "text");
      metric.setAttribute("class", `metric ${metrics.status}`);
      metric.setAttribute("x", x);
      metric.setAttribute("y", top + 31);
      metric.textContent = `density ${Math.round(metrics.density * 100)}% · overlap ${metrics.overlapCount}`;
      layer.appendChild(metric);
    }
  }
  svg.appendChild(layer);
}

function drawClusterLinks(svg, graph, positions, analysis) {
  const clusters = positionedClusters(positions, analysis);
  const nodeToCluster = new Map();
  for (const [key, cluster] of clusters) {
    for (const node of cluster.nodes) nodeToCluster.set(node.id, key);
  }

  const weights = new Map();
  for (const edge of graph.edges || []) {
    const source = nodeToCluster.get(edge.source);
    const target = nodeToCluster.get(edge.target);
    if (!source || !target || source === target) continue;
    const key = [source, target].sort().join("::");
    const current = weights.get(key) || { source, target, weight: 0, policy: false };
    current.weight += edgeWeight(edge);
    current.policy = current.policy || edge.type === "policy_hit";
    weights.set(key, current);
  }

  const layer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  layer.setAttribute("class", "cluster-links");
  for (const link of [...weights.values()].sort((a, b) => b.weight - a.weight).slice(0, 32)) {
    const source = clusters.get(link.source);
    const target = clusters.get(link.target);
    if (!source || !target) continue;
    const dx = target.cx - source.cx;
    const dy = target.cy - source.cy;
    const dist = Math.max(1, Math.hypot(dx, dy));
    const bend = Math.min(70, dist * 0.18);
    const mx = (source.cx + target.cx) / 2 - (dy / dist) * bend;
    const my = (source.cy + target.cy) / 2 + (dx / dist) * bend;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${source.cx} ${source.cy} Q ${mx} ${my} ${target.cx} ${target.cy}`);
    path.setAttribute("class", `cluster-link${link.policy ? " policy" : ""}`);
    path.style.strokeWidth = String(1.1 + Math.min(6, Math.sqrt(link.weight) * 0.62));
    layer.appendChild(path);
  }
  svg.appendChild(layer);
}

function positionedClusters(positions, analysis) {
  const clusters = new Map();
  const anchorMap = buildDecisionAnchorMap(analysis);
  for (const node of positions.values()) {
    const cluster = nodeCluster(node, analysis, anchorMap);
    if (!clusters.has(cluster.key)) clusters.set(cluster.key, { ...cluster, nodes: [], cx: 0, cy: 0 });
    clusters.get(cluster.key).nodes.push(node);
  }

  for (const cluster of clusters.values()) {
    cluster.cx = cluster.nodes.reduce((sum, node) => sum + node.x, 0) / cluster.nodes.length;
    cluster.cy = cluster.nodes.reduce((sum, node) => sum + node.y, 0) / cluster.nodes.length;
  }

  return clusters;
}

function visibleLabelIds(graph, positions, analysis, context, denseOverview) {
  if (viewState.layout === "lanes") {
    const degrees = graphDegrees(graph);
    const ids = new Set([...context.queryIds]);
    if (selectedNodeId) ids.add(selectedNodeId);

    const ranked = [...positions.values()]
      .map((node) => ({
        node,
        score:
          (node.className === "changed" ? 120 : 0) +
          (node.className === "policy" || node.className === "route" ? 60 : 0) +
          (node.className === "evidence" ? 36 : 0) +
          (node.className === "symbol" ? 18 : 0) +
          (degrees.get(node.id) || 0) * 7 +
          node.radius
      }))
      .sort((a, b) => b.score - a.score);

    const limit = graph.nodes.length > 160 ? 10 : graph.nodes.length > 90 ? 14 : 24;
    for (const item of ranked.slice(0, limit)) ids.add(item.node.id);
    return ids;
  }

  if (!denseOverview) return new Set((graph.nodes || []).map((node) => node.id));

  const degrees = graphDegrees(graph);
  const ids = new Set([...context.queryIds]);
  if (selectedNodeId) ids.add(selectedNodeId);

  const ranked = [...positions.values()]
    .map((node) => ({
      node,
      score:
        (node.className === "changed" ? 90 : 0) +
        (node.className === "policy" || node.className === "route" ? 42 : 0) +
        (node.className === "symbol" ? 16 : 0) +
        (degrees.get(node.id) || 0) * 7 +
        node.radius
    }))
    .sort((a, b) => b.score - a.score);

  const limit = graph.nodes.length > 180 ? 22 : 32;
  for (const item of ranked.slice(0, limit)) ids.add(item.node.id);
  return ids;
}

function drawClusterHulls(svg, positions, analysis) {
  const clusters = new Map();
  const anchorMap = buildDecisionAnchorMap(analysis);
  for (const node of positions.values()) {
    const cluster = nodeCluster(node, analysis, anchorMap);
    if (!clusters.has(cluster.key)) clusters.set(cluster.key, { ...cluster, nodes: [] });
    clusters.get(cluster.key).nodes.push(node);
  }

  const layer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  layer.setAttribute("class", "cluster-hulls");
  for (const cluster of clusters.values()) {
    if (!cluster.nodes.length) continue;
    const hull = clusterHull(cluster.nodes);
    if (!hull.path) continue;

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", hull.path);
    path.setAttribute("class", `cluster-hull ${cluster.kind || "other"}`);
    layer.appendChild(path);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", hull.labelX);
    label.setAttribute("y", hull.labelY);
    label.setAttribute("class", "cluster-label");
    label.textContent = `${compactMiddle(cluster.label, 30)} · ${cluster.nodes.length}`;
    layer.appendChild(label);
  }
  svg.appendChild(layer);
}

function drawDelegationBoundaries(svg, graph, positions, analysis) {
  const specs = delegationBoundarySpecs(graph, analysis);
  if (!specs.length) return;

  const layer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  layer.setAttribute("class", "delegation-boundaries");

  for (const spec of specs.sort((a, b) => BOUNDARY_ORDER.indexOf(a.kind) - BOUNDARY_ORDER.indexOf(b.kind))) {
    const nodes = positionedBoundaryNodes(spec, positions);
    if (!nodes.length) continue;
    const hull = boundaryHull(nodes, spec.padding);
    if (!hull.path) continue;

    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.setAttribute("class", `delegation-boundary ${spec.kind}`);
    group.setAttribute("data-kind", spec.kind);

    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${spec.label}: ${spec.reason}`;
    group.appendChild(title);

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", hull.path);
    path.setAttribute("class", "boundary-shape");
    group.appendChild(path);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", hull.labelX);
    label.setAttribute("y", hull.labelY);
    label.setAttribute("class", "boundary-label");
    label.textContent = boundaryLabel(spec, nodes.length);
    group.appendChild(label);

    layer.appendChild(group);
  }

  svg.appendChild(layer);
}

function delegationBoundarySpecs(graph, analysis) {
  const pack = analysis.contextPack || {};
  const agentContext = pack.agentContext || {};
  const promptContext = pack.codexInput?.promptContext || {};
  const visualFrontiers = pack.visualFrontiers || pack.boundaryFrontiers || {};
  const frontiers = visualFrontiers.kind ? visualFrontiers : (agentContext.frontiers || promptContext.frontiers || {});
  const readPlan = agentContext.readPlan || promptContext.readPlan || [];
  const lease = latestBoundaryLease(currentState);
  const changedIds = changedNodeIds(analysis);
  const evidenceIds = evidenceNodeIds(analysis);
  const pathIds = idsFromPaths(analysis.impact?.paths || []);
  const graphNodeIds = new Set((graph.nodes || []).map((node) => node.id));

  const read = boundaryRefSet();
  addPaths(read, readPlan.map((item) => item.path));
  addNodeIds(read, nodeIdsFromFrontier(frontiers.contextFrontier));

  const review = boundaryRefSet();
  addNodeIds(review, nodeIdsFromFrontier(frontiers.reviewFrontier));
  addNodeIds(review, lease?.reviewGraphNodes || []);
  addNodeIds(review, changedIds);
  addNodeIds(review, evidenceIds);
  addNodeIds(review, pathIds);
  addPaths(review, frontierPaths(frontiers.reviewFrontier));

  const permission = boundaryRefSet();
  addNodeIds(permission, nodeIdsFromFrontier(frontiers.permissionFrontier));
  addNodeIds(permission, lease?.allowedGraphNodes || []);
  addPaths(permission, lease?.fileScopes || []);
  if (!permission.ids.size && !permission.paths.size) {
    addNodeIds(permission, read.ids);
    addPaths(permission, read.paths);
    addNodeIds(permission, review.ids);
  }

  const leaseSet = boundaryRefSet();
  addNodeIds(leaseSet, lease?.allowedGraphNodes || []);
  addPaths(leaseSet, lease?.fileScopes || []);

  const stop = boundaryRefSet();
  addNodeIds(stop, nodeIdsFromFrontier(frontiers.stopFrontier));
  addNodeIds(stop, lease?.stopGraphNodes || []);
  addNodeIds(stop, (analysis.policyHits || []).map((hit) => `policy:${hit.ruleId}`));
  if (!hasVisibleRefs(stop, graphNodeIds)) addNodeIds(stop, evidenceIds);

  return [
    boundarySpec("permission", "Permission boundary", permission, "graph scope the agent may execute or edit within", 58, frontiers.permissionFrontier?.size || lease?.allowedGraphNodes?.length),
    boundarySpec("review", "Review boundary", review, "change-impact surface a human should not miss", 46, frontiers.reviewFrontier?.size || lease?.reviewGraphNodes?.length),
    boundarySpec("read", "Read boundary", read, "what the agent should read before the rest of the repo", 34, readPlan.length || frontiers.contextFrontier?.size),
    boundarySpec("lease", "Lease boundary", leaseSet, "where the current signed approval lease can be reused", 26, lease?.fileScopes?.length || lease?.allowedGraphNodes?.length),
    boundarySpec("stop", "Stop / re-ask boundary", stop, "conditions that force the agent to stop or ask again", 38, frontiers.stopFrontier?.size || lease?.stopGraphNodes?.length)
  ].filter((spec) => spec.ids.size || spec.paths.size);
}

function boundaryRefSet() {
  return { ids: new Set(), paths: new Set() };
}

function boundarySpec(kind, label, refs, reason, padding, total = null) {
  return {
    kind,
    label,
    ids: refs.ids,
    paths: refs.paths,
    reason,
    padding,
    total: Number.isFinite(Number(total)) ? Number(total) : null
  };
}

function addNodeIds(refs, values = []) {
  for (const value of values || []) {
    const id = typeof value === "string" ? value : value?.id;
    if (id) refs.ids.add(String(id));
  }
}

function addPaths(refs, values = []) {
  for (const value of values || []) {
    const path = typeof value === "string" ? value : value?.path;
    if (path) {
      refs.paths.add(String(path));
      refs.ids.add(`file:${path}`);
    }
  }
}

function nodeIdsFromFrontier(frontier = {}) {
  return [
    ...(frontier.nodes || []),
    ...(frontier.items || []).map((item) => item.id)
  ].filter(Boolean);
}

function frontierPaths(frontier = {}) {
  return (frontier.items || []).map((item) => item.path).filter(Boolean);
}

function hasVisibleRefs(refs, graphNodeIds) {
  for (const id of refs.ids || []) {
    if (graphNodeIds.has(id)) return true;
  }
  return false;
}

function latestBoundaryLease(state = {}) {
  const active = activeApprovalLeasesForDisplay(state);
  if (active.length) return active[active.length - 1];
  return null;
}

function positionedBoundaryNodes(spec, positions) {
  const nodes = [];
  for (const node of positions.values()) {
    if (spec.ids.has(node.id) || node.path && spec.paths.has(node.path)) nodes.push(node);
  }
  return nodes;
}

function boundaryHull(nodes, padding = 36) {
  const points = [];
  for (const node of nodes) {
    const radius = node.radius + padding;
    for (let index = 0; index < 12; index += 1) {
      const angle = (Math.PI * 2 * index) / 12 + 0.12;
      points.push({
        x: node.x + Math.cos(angle) * radius,
        y: node.y + Math.sin(angle) * radius
      });
    }
  }

  const hull = convexHull(points);
  if (!hull.length) return { path: "", labelX: 0, labelY: 0 };
  const minX = Math.min(...hull.map((point) => point.x));
  const minY = Math.min(...hull.map((point) => point.y));
  return {
    path: smoothClosedPath(hull),
    labelX: minX + 12,
    labelY: minY + 22
  };
}

function boundaryLabel(spec, visibleCount) {
  const total = spec.total && spec.total > visibleCount ? `/${spec.total}` : "";
  return `${spec.label} · ${visibleCount}${total}`;
}

function clusterHull(nodes) {
  const padding = nodes.length > 8 ? 24 : 30;
  const points = [];
  for (const node of nodes) {
    const radius = node.radius + padding;
    for (let index = 0; index < 10; index += 1) {
      const angle = (Math.PI * 2 * index) / 10 + 0.18;
      points.push({
        x: node.x + Math.cos(angle) * radius,
        y: node.y + Math.sin(angle) * radius
      });
    }
  }

  const hull = convexHull(points);
  if (!hull.length) return { path: "", labelX: 0, labelY: 0 };
  const minX = Math.min(...hull.map((point) => point.x));
  const minY = Math.min(...hull.map((point) => point.y));
  return {
    path: smoothClosedPath(hull),
    labelX: minX + 12,
    labelY: minY + 20
  };
}

function convexHull(points) {
  const sorted = [...points]
    .sort((a, b) => a.x - b.x || a.y - b.y)
    .filter((point, index, list) => index === 0 || point.x !== list[index - 1].x || point.y !== list[index - 1].y);
  if (sorted.length <= 2) return sorted;

  const lower = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop();
    lower.push(point);
  }

  const upper = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index];
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop();
    upper.push(point);
  }

  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

function smoothClosedPath(points) {
  if (points.length < 3) {
    const [point] = points;
    return point ? `M ${point.x - 42} ${point.y} A 42 42 0 1 0 ${point.x + 42} ${point.y} A 42 42 0 1 0 ${point.x - 42} ${point.y}` : "";
  }

  let d = `M ${midpoint(points.at(-1), points[0]).x} ${midpoint(points.at(-1), points[0]).y}`;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const mid = midpoint(current, next);
    d += ` Q ${current.x} ${current.y} ${mid.x} ${mid.y}`;
  }
  return `${d} Z`;
}

function cross(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function drawPathBands(svg, positions, paths, context, denseOverview = false) {
  const layer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  layer.setAttribute("class", "path-bands");
  const visibleLimit = denseOverview ? 10 : 18;
  for (const [index, path] of paths.slice(0, visibleLimit).entries()) {
    const points = path.nodes.map((node) => positions.get(node.id)).filter(Boolean);
    if (points.length < 2) continue;
    const selected = (selectedNodeId && path.nodes.some((node) => node.id === selectedNodeId)) || context.activePathKeys.has(pathKey(path));
    const quiet = (selectedNodeId || context.queryIds.size) && !selected;
    const d = routePath(points);
    const className = `${path.kind}${selected ? " selected" : ""}${quiet ? " quiet" : ""}`;

    const band = document.createElementNS("http://www.w3.org/2000/svg", "path");
    band.setAttribute("d", d);
    band.setAttribute("class", `path-band ${className}`);
    layer.appendChild(band);

    const flow = document.createElementNS("http://www.w3.org/2000/svg", "path");
    flow.setAttribute("d", d);
    flow.setAttribute("class", `path-flow ${className}`);
    flow.style.animationDelay = `${index * -0.16}s`;
    layer.appendChild(flow);

    if ((viewState.focus !== "all" || selectedNodeId || context.queryIds.size) && index < 10 && path.kind !== "defines") {
      const labelPoint = points[Math.floor((points.length - 1) / 2)];
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", labelPoint.x + 8);
      label.setAttribute("y", labelPoint.y - labelPoint.radius - 8);
      label.setAttribute("class", `path-label${quiet ? " quiet" : ""}`);
      label.textContent = pathKindLabel(path.kind);
      layer.appendChild(label);
    }
  }
  svg.appendChild(layer);
}

function drawQueryWaves(svg, positions, queryIds) {
  if (!queryIds.size) return;
  const layer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  layer.setAttribute("class", "query-waves");
  for (const id of queryIds) {
    const node = positions.get(id);
    if (!node) continue;
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("class", "query-wave");
    circle.setAttribute("cx", node.x);
    circle.setAttribute("cy", node.y);
    circle.setAttribute("r", node.radius + 6);

    const radius = document.createElementNS("http://www.w3.org/2000/svg", "animate");
    radius.setAttribute("attributeName", "r");
    radius.setAttribute("values", `${node.radius + 6};${node.radius + 48}`);
    radius.setAttribute("dur", "1.55s");
    radius.setAttribute("repeatCount", "indefinite");
    circle.appendChild(radius);

    const opacity = document.createElementNS("http://www.w3.org/2000/svg", "animate");
    opacity.setAttribute("attributeName", "opacity");
    opacity.setAttribute("values", "0.75;0");
    opacity.setAttribute("dur", "1.55s");
    opacity.setAttribute("repeatCount", "indefinite");
    circle.appendChild(opacity);

    layer.appendChild(circle);
  }
  svg.appendChild(layer);
}

function routePath(points) {
  if (points.length === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const mid = midpoint(points[index], points[index + 1]);
    d += ` Q ${points[index].x} ${points[index].y} ${mid.x} ${mid.y}`;
  }
  const last = points.at(-1);
  d += ` L ${last.x} ${last.y}`;
  return d;
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function drawEdge(svg, source, target, edge, strong, dim) {
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const dist = Math.max(1, Math.hypot(dx, dy));
  const sx = source.x + (dx / dist) * source.radius;
  const sy = source.y + (dy / dist) * source.radius;
  const tx = target.x - (dx / dist) * target.radius;
  const ty = target.y - (dy / dist) * target.radius;

  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", sx);
  line.setAttribute("y1", sy);
  line.setAttribute("x2", tx);
  line.setAttribute("y2", ty);
  line.setAttribute("marker-end", "url(#arrow)");
  line.setAttribute("class", `edge ${edgeClass(edge.type)}${strong ? " strong" : ""}${dim ? " dim" : ""}`);
  group.appendChild(line);

  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.setAttribute("x", (sx + tx) / 2);
  label.setAttribute("y", (sy + ty) / 2 - 5);
  label.setAttribute("text-anchor", "middle");
  label.setAttribute("class", "edge-label");
  label.textContent = relationshipType(edge);
  group.appendChild(label);

  svg.appendChild(group);
}

function edgeClass(type) {
  return String(type || "relation").replace(/[^a-z0-9_-]/gi, "-");
}

function drawNode(svg, node, analysis, dim, selected, marker = "", showLabel = true, previousNode = null) {
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const moving = shouldAnimateNodeMove(node, previousNode);
  group.setAttribute("class", `node ${node.className}${marker ? ` ${marker}` : ""}${dim ? " dim" : ""}${selected ? " selected" : ""}${showLabel ? " label-visible" : ""}${moving ? " layout-moving" : ""}`);
  group.setAttribute("transform", moving ? `translate(${previousNode.x}, ${previousNode.y})` : `translate(${node.x}, ${node.y})`);
  group.addEventListener("pointerdown", (event) => startNodeDrag(event, node, analysis));
  group.addEventListener("click", (event) => {
    event.stopPropagation();
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    selectedNodeId = node.id;
    render(analysis);
  });

  const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
  title.textContent = [nodeCaption(node), `labels: ${nodeLabels(node).map((label) => `:${label}`).join("")}`, node.path].filter(Boolean).join(" / ");
  group.appendChild(title);

  drawNodeShape(group, node);
  if (moving) appendNodeMoveAnimation(group, previousNode, node);

  if (showLabel) {
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.textContent = compactLabel(nodeDisplayLabel(node), 24);
    group.appendChild(label);

    const sub = document.createElementNS("http://www.w3.org/2000/svg", "text");
    sub.setAttribute("class", "sub");
    sub.textContent = nodeTypeLabel(node);
    group.appendChild(sub);
  }

  svg.appendChild(group);
}

function shouldAnimateNodeMove(node, previousNode) {
  if (!previousNode || selectedNodeId) return false;
  const distance = Math.hypot(node.x - previousNode.x, node.y - previousNode.y);
  return distance > 2 && distance < 3200;
}

function appendNodeMoveAnimation(group, fromNode, toNode) {
  const animation = document.createElementNS("http://www.w3.org/2000/svg", "animateTransform");
  animation.setAttribute("attributeName", "transform");
  animation.setAttribute("type", "translate");
  animation.setAttribute("from", `${fromNode.x} ${fromNode.y}`);
  animation.setAttribute("to", `${toNode.x} ${toNode.y}`);
  animation.setAttribute("dur", "360ms");
  animation.setAttribute("fill", "freeze");
  animation.setAttribute("calcMode", "spline");
  animation.setAttribute("keySplines", "0.2 0.8 0.2 1");
  group.appendChild(animation);
}

function togglePanel(side = "") {
  if (!["left", "right"].includes(side)) return;
  panelState[side] = !panelState[side];
  updateViewControls();
  viewportInitialized = false;
  if (currentAnalysis) render(currentAnalysis, "layout_reset", currentState);
}

function toggleGraphScope() {
  viewState.scope = viewState.scope === "all" ? "decision" : "all";
  selectedNodeId = null;
  viewportInitialized = false;
  updateViewControls();
  if (currentAnalysis) render(currentAnalysis, "layout_reset", currentState);
  setActivity(viewState.scope === "all" ? "Showing full KG" : "Showing decision KG", true);
}

function updateViewControls() {
  document.body.classList.toggle("panel-left-hidden", !panelState.left);
  document.body.classList.toggle("panel-right-hidden", !panelState.right);
  if (elements.leftPanelToggle) {
    elements.leftPanelToggle.setAttribute("aria-pressed", String(panelState.left));
    elements.leftPanelToggle.title = panelState.left ? "Hide Workspace panel" : "Show Workspace panel";
  }
  if (elements.rightPanelToggle) {
    elements.rightPanelToggle.setAttribute("aria-pressed", String(panelState.right));
    elements.rightPanelToggle.title = panelState.right ? "Hide ScopeLease panel" : "Show ScopeLease panel";
  }
  if (elements.scopeToggle) {
    const all = viewState.scope === "all";
    elements.scopeToggle.setAttribute("aria-pressed", String(all));
    elements.scopeToggle.textContent = all ? "Decision KG" : "Full KG";
    elements.scopeToggle.title = all ? "Show decision paths only" : "Show full stored KG";
  }
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
  activeLocale = locale === "ko" ? "ko" : "en";
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, activeLocale);
  } catch {
    // The current page can still switch language if localStorage is unavailable.
  }
  if (currentAnalysis) render(currentAnalysis, "locale", currentState);
  else applyLocaleToDocument();
}

function applyLocaleToDocument() {
  document.documentElement.lang = activeLocale === "ko" ? "ko" : "en";
  document.title = translateUiText("ScopeLease Graph View");
  for (const button of elements.localeButtons) {
    const active = button.dataset.localeOption === activeLocale;
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }
  translateNodeText(document.body);
  translateAttributes(document.body);
}

function translateUiText(value = "") {
  const text = String(value || "");
  if (!text) return text;
  const pairs = activeLocale === "ko"
    ? UI_TRANSLATION_PAIRS
    : UI_TRANSLATION_PAIRS.map(([english, korean]) => [korean, english]);
  let result = text;
  for (const [from, to] of [...pairs].sort((left, right) => right[0].length - left[0].length)) {
    if (from) result = result.replaceAll(from, to);
  }
  const regexPairs = activeLocale === "ko" ? KO_REGEX_TRANSLATIONS : EN_REGEX_TRANSLATIONS;
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
  [/\b(\d+)\/(\d+) visible \/ stored nodes\b/g, "$1/$2 표시 / 저장 노드"],
  [/\b(\d+)\/(\d+) shown\b/g, "$1/$2 표시"],
  [/\b(\d+) shown \/ (\d+) nodes\b/g, "$1개 표시 / $2개 노드"],
  [/\b(\d+) nodes \/ (\d+) rels\b/g, "$1개 노드 / $2개 관계"],
  [/\b(\d+) nodes \/ (\d+) edges\b/g, "$1개 노드 / $2개 관계"],
  [/\b(\d+) projects\b/g, "$1개 프로젝트"],
  [/\b(\d+) running\b/g, "$1개 실행 중"],
  [/\b(\d+) threads\b/g, "$1개 스레드"],
  [/\b(\d+) events\b/g, "$1개 이벤트"],
  [/\b(\d+) nodes\b/g, "$1개 노드"],
  [/\b(\d+) edges\b/g, "$1개 관계"],
  [/\b(\d+) rels\b/g, "$1개 관계"],
  [/\b(\d+) files\b/g, "$1개 파일"],
  [/\b(\d+) commands\b/g, "$1개 명령"],
  [/\blanes (\d+) · overlap (\d+) · max (\d+)%\b/g, "lanes $1 · 겹침 $2 · 최대 $3%"],
  [/\bAdded (\d+) \/ updated (\d+) \/ removed (\d+)\b/g, "추가 $1 / 갱신 $2 / 삭제 $3"],
  [/\bZoom (\d+)%\b/g, "줌 $1%"],
  [/\bMCP ([0-9.]+k) · hook ([0-9.]+k)\b/g, "MCP $1 · hook $2"],
  [/\bhook\/watcher ([0-9.]+k)\b/g, "hook/watcher $1"],
  [/\bwaiting for agent-visible events\b/g, "agent-visible 이벤트 대기"],
  [/\bruntime\b/g, "런타임"],
  [/\bscan ([0-9.]+)s\b/g, "스캔 $1초"],
  [/\bscope: (\d+) files · (\d+) commands · default\b/g, "범위: $1개 파일 · $2개 명령 · 기본"],
  [/\b(\d+)m candidate\b/g, "$1분 후보"],
  [/\b(\d+)m left\b/g, "$1분 남음"],
  [/\btarget\b/g, "대상"],
  [/\bload\b/g, "부하"],
  [/\bchanged file\b/g, "변경 파일"],
  [/\bchanged since baseline\b/g, "기준점 이후 변경"],
  [/\bimports changed file\b/g, "변경 파일을 호출"],
  [/\brelated test\b/g, "관련 테스트"],
  [/\brelated doc\b/g, "관련 문서"],
  [/\broot \/ policy\b/g, "root / 정책"],
  [/\bdepth (\d+)\+\b/g, "depth $1+"],
  [/\bdepth (\d+)\b/g, "depth $1"],
  [/\bHub (\d+) projects · (\d+) running\b/g, "허브 $1개 프로젝트 · $2개 실행 중"],
  [/\bKG (\d+)\/(\d+)\b/g, "KG $1/$2"],
  [/scope outside 파일, network, checkpoint a new decision require separation/g, "scope 밖 파일, 네트워크, 체크포인트는 새 판단으로 분리"],
  [/scope outside 파일, network, checkpoint and decision require separation/g, "scope 밖 파일, 네트워크, 체크포인트는 새 판단으로 분리"]
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
  [/(\d+)\/(\d+) 표시 \/ 저장 노드/g, "$1/$2 visible / stored nodes"],
  [/(\d+)\/(\d+) 표시/g, "$1/$2 shown"],
  [/(\d+)개 표시 \/ (\d+)개 노드/g, "$1 shown / $2 nodes"],
  [/(\d+)개 노드 \/ (\d+)개 관계/g, "$1 nodes / $2 edges"],
  [/(\d+)개 프로젝트/g, "$1 projects"],
  [/(\d+)개 실행 중/g, "$1 running"],
  [/(\d+)개 스레드/g, "$1 threads"],
  [/(\d+)개 이벤트/g, "$1 events"],
  [/(\d+)개 파일/g, "$1 files"],
  [/(\d+)개 명령/g, "$1 commands"],
  [/(\d+)개 노드/g, "$1 nodes"],
  [/(\d+)개 관계/g, "$1 edges"],
  [/lanes (\d+) · 겹침 (\d+) · 최대 (\d+)%/g, "lanes $1 · overlap $2 · max $3%"],
  [/추가 (\d+) \/ 갱신 (\d+) \/ 삭제 (\d+)/g, "Added $1 / updated $2 / removed $3"],
  [/줌 (\d+)%/g, "Zoom $1%"],
  [/agent-visible 이벤트 대기/g, "waiting for agent-visible events"],
  [/런타임/g, "runtime"],
  [/스캔 ([0-9.]+)초/g, "scan $1s"],
  [/범위: (\d+) files · (\d+) commands · 기본/g, "scope: $1 files · $2 commands · default"],
  [/범위: (\d+)개 파일 · (\d+)개 명령 · 기본/g, "scope: $1 files · $2 commands · default"],
  [/(\d+)분 후보/g, "$1m candidate"],
  [/(\d+)분 남음/g, "$1m left"],
  [/대상/g, "target"],
  [/부하/g, "load"],
  [/변경 파일/g, "changed file"],
  [/기준점 이후 변경/g, "changed since baseline"],
  [/변경 파일을 호출/g, "imports changed file"],
  [/관련 테스트/g, "related test"],
  [/관련 문서/g, "related doc"],
  [/root \/ 정책/g, "root / policy"],
  [/허브 (\d+)개 프로젝트 · (\d+)개 실행 중/g, "Hub $1 projects · $2 running"]
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

function drawNodeShape(group, node) {
  const r = node.radius;
  if (node.className === "route") {
    const diamond = document.createElementNS("http://www.w3.org/2000/svg", "path");
    diamond.setAttribute("class", "shape");
    diamond.setAttribute("d", `M 0 ${-r} L ${r} 0 L 0 ${r} L ${-r} 0 Z`);
    group.appendChild(diamond);
    return;
  }

  if (node.className === "policy") {
    const points = [];
    for (let i = 0; i < 8; i += 1) {
      const angle = Math.PI / 8 + i * Math.PI / 4;
      points.push(`${Math.cos(angle) * r},${Math.sin(angle) * r}`);
    }
    const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    polygon.setAttribute("class", "shape");
    polygon.setAttribute("points", points.join(" "));
    group.appendChild(polygon);
    return;
  }

  if (node.className === "evidence") {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("class", "shape");
    rect.setAttribute("x", -r);
    rect.setAttribute("y", -r * 0.72);
    rect.setAttribute("width", r * 2);
    rect.setAttribute("height", r * 1.44);
    rect.setAttribute("rx", 7);
    group.appendChild(rect);
    return;
  }

  if (isChangedNode(node)) {
    const ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    ring.setAttribute("class", "outer-ring");
    ring.setAttribute("r", r + 7);
    group.appendChild(ring);
  }

  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("class", "shape");
  circle.setAttribute("r", r);
  group.appendChild(circle);
}

function drawGhostNodes(svg) {
  pruneTransientMarkers();
  for (const ghost of ghostNodes.values()) {
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.setAttribute("class", "node removed");
    group.setAttribute("transform", `translate(${ghost.x}, ${ghost.y})`);

    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("r", Math.max(28, ghost.radius || 34));
    group.appendChild(circle);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.textContent = compactLabel(ghost.label || ghost.path || ghost.id, 18);
    group.appendChild(label);

    const sub = document.createElementNS("http://www.w3.org/2000/svg", "text");
    sub.setAttribute("class", "sub");
    sub.textContent = "Deleted";
    group.appendChild(sub);

    svg.appendChild(group);
  }
}

function renderDecision(analysis) {
  const pack = analysis.contextPack || {};
  const economy = pack.tokenEconomy;
  const gate = pack.decisionGate;
  const tokenCopy = formatTokenEconomy(economy);
  const decisionTitle = displayText(gate?.statusLabel) || (gate ? gateLabel(gate.status) : routeLabel(analysis.recommendation || "auto_log"));
  const nextAction = displayText(gate?.nextAction) || (gate ? nextActionLabel(gate, analysis) : "Record the change and review when needed.");
  const automation = displayText(gate?.automationLabel) || (gate ? autoLabel(gate) : "-");
  const promptContext = pack.codexInput?.promptContext || pack.agentContext || {};
  const fatiguePlan = promptContext.fatiguePlan || pack.agentContext?.fatiguePlan || {};
  const agentJudgment = agentJudgmentFromAnalysis(analysis);
  const requestText = analysis.contextPack?.userRequest?.text || analysis.userRequest || pack.codexInput?.userRequest?.text || "";
  const displayRequestText = displayText(displayUserRequestText(requestText));
  const localizedRequestText = translateUiText(displayRequestText);
  const requestSummary = localizedRequestText
    ? compactMiddle(localizedRequestText, 86)
    : "Waiting for current input";
  const decisionQuestion = displayText(fatiguePlan.askOnce?.[0]) || nextAction || decisionTitle;
  const decisionDisplay = compactMiddle(decisionQuestion, 118);
  const decisionMeta = `${decisionTitle} · ${automation}`;
  const guardCopy = formatGuardBrokerCopy(fatiguePlan, currentState);
  const guardEvidence = buildGuardEvidence(currentState, fatiguePlan);
  const frontierCopy = formatFrontierCopy(
    pack.agentContext?.frontiers || promptContext.frontiers || {},
    pack.agentContext?.frontierSummary || promptContext.frontiers || {}
  );
  const actualEvents = actualWorkEventsForRequest(currentState, analysis);
  const mcpContextEvents = mcpContextEventsForRequest(currentState, analysis);
  const pairSavings = formatObservedSavings(
    buildObservedWorkIntentSavings({
      actualEvents,
      mcpContextEvents,
      pairId: currentPairId(),
      runId: currentPairRunId(),
      analysis
    }),
    formatTokenCount
  );
  const hookEstimate = buildHookSavingsEstimate({ state: currentState, analysis });
  const usageBoundary = formatAgentUsageBoundary(currentState, analysis);
  renderUserDecisionPanel({
    analysis,
    requestSummary,
    requestTitle: localizedRequestText || displayRequestText,
    tokenCopy,
    pairSavings,
    hookEstimate,
    guardCopy,
    guardEvidence,
    frontierCopy,
    agentJudgment,
    decisionDisplay,
    decisionMeta,
    actualEvents,
    mcpContextEvents,
    usageBoundary
  });
}

function agentJudgmentFromAnalysis(analysis = {}) {
  const pack = analysis.contextPack || {};
  const promptContext = pack.codexInput?.promptContext || pack.agentContext || {};
  const fatiguePlan = promptContext.fatiguePlan || pack.agentContext?.fatiguePlan || {};
  const guardJudgment = latestGuardAgentJudgment(currentState);
  if (guardJudgment) return guardJudgment;
  return (
    pack.agentContext?.fatiguePlan?.decisionBundle?.agentJudgment ||
    promptContext.fatiguePlan?.decisionBundle?.agentJudgment ||
    fatiguePlan.decisionBundle?.agentJudgment ||
    currentState?.latestAnalysis?.contextPack?.agentContext?.fatiguePlan?.decisionBundle?.agentJudgment ||
    currentState?.latestAnalysis?.contextPack?.codexInput?.promptContext?.fatiguePlan?.decisionBundle?.agentJudgment ||
    {}
  );
}

function latestGuardAgentJudgment(state = {}) {
  const guards = state?.guardEvents || [];
  const event =
    guards.find((item) => item?.shouldAskHuman && item?.agentJudgment) ||
    guards.find((item) => item?.agentJudgment) ||
    null;
  if (!event?.agentJudgment) return null;
  const decisionAssistance = event.decisionAssistance || event.agentJudgment.decisionAssistance || {};
  return { ...event.agentJudgment, decisionAssistance };
}

function compactAgentJudgmentStatus(agentJudgment = {}) {
  const assistance = agentJudgment.decisionAssistance || {};
  if (!assistance.interruptHuman) return "";
  const reason = (assistance.riskReasons || [])[0] || agentJudgment.headline || "risk signal";
  return compactMiddle(`Risk check: ${displayText(reason)} · recommendation ${displayText(assistance.recommendedChoice || agentJudgment.recommendedChoice || "-")}`, 118);
}

function agentJudgmentTitle(agentJudgment = {}) {
  if (!agentJudgment?.headline && !agentJudgment?.interpretedInput) return "";
  return [
    agentJudgment.headline ? `Agent judgment: ${displayText(agentJudgment.headline)}` : "",
    agentJudgment.interpretedInput ? `Input interpretation: ${displayText(agentJudgment.interpretedInput)}` : "",
    (agentJudgment.willDo || []).length ? `Will do: ${(agentJudgment.willDo || []).map(displayText).join(" / ")}` : "",
    agentJudgment.approvalEffect ? `Approval effect: ${displayText(agentJudgment.approvalEffect)}` : "",
    (agentJudgment.willNotDo || []).length ? `Will not do: ${(agentJudgment.willNotDo || []).map(displayText).join(" / ")}` : ""
  ].filter(Boolean).join("\n");
}

function renderUserDecisionPanel({
  analysis = {},
  requestSummary = "",
  requestTitle = "",
  tokenCopy = {},
  pairSavings = {},
  hookEstimate = {},
  guardCopy = {},
  guardEvidence = {},
  frontierCopy = {},
  agentJudgment = {},
  decisionDisplay = "",
  decisionMeta = "",
  actualEvents = [],
  mcpContextEvents = [],
  usageBoundary = {}
}) {
  const currentUsage = summarizeAgentVisibleUsageEvents({ actualEvents, mcpContextEvents });
  const savingsDisplay = formatSavingsDisplay(pairSavings, hookEstimate);
  elements.decisionPanel.innerHTML = `
    ${userPanelHeader("ScopeLease", "Final user screen")}
    <section class="user-decision-panel">
      <div class="user-request-card">
        <b>Current request</b>
        <strong title="${escapeHtml(requestTitle || analysis.userRequest || "")}">${escapeHtml(requestSummary)}</strong>
      </div>
      ${renderAgentJudgmentPanel(agentJudgment)}
      <div class="user-metric-grid">
        <span><b>ScopeLease input</b><strong>${escapeHtml(tokenCopy.actualInput || "-")}</strong><em>delivery candidate</em></span>
        <span><b>Current observation</b><strong>${escapeHtml(currentUsage.value)}</strong><em>${escapeHtml(currentUsage.status)}</em></span>
        <span><b>${escapeHtml(displayText(savingsDisplay.label))}</b><strong>${escapeHtml(displayText(savingsDisplay.value))}</strong><em>${escapeHtml(displayText(savingsDisplay.meta))}</em></span>
      </div>
      <div class="user-decision-callout">
        <b>Decision needed</b>
        <strong>${escapeHtml(decisionDisplay)}</strong>
        <em>${escapeHtml(decisionMeta)}</em>
      </div>
      <div class="user-boundary-grid">
        <span><b>Verdict</b>${escapeHtml(guardCopy.verdict || "-")}</span>
        <span><b>Approval</b>${escapeHtml(guardCopy.lease || "-")}</span>
        <span><b>Provider/API</b>${escapeHtml(usageBoundary.providerStatus || "Excluded")}</span>
      </div>
      <div class="guard-evidence-panel">
        <span><b>Latest guard</b>${escapeHtml(guardEvidence.latestGuard || "-")}</span>
        <span><b>Active lease</b>${escapeHtml(guardEvidence.activeLease || "-")}</span>
        <span><b>Authority scope</b>${escapeHtml(guardEvidence.scope || "-")}</span>
        <span><b>Stop condition</b>${escapeHtml(guardEvidence.stopWhen || "-")}</span>
      </div>
      <div class="guard-evidence-panel frontier-evidence-panel">
        <span><b>Review frontier</b>${escapeHtml(frontierCopy.review || "-")}</span>
        <span><b>Permission frontier</b>${escapeHtml(frontierCopy.permission || "-")}</span>
        <span><b>Stop frontier</b>${escapeHtml(frontierCopy.stop || "-")}</span>
        <span><b>Graph scope</b>${escapeHtml(frontierCopy.scope || "-")}</span>
      </div>
      <p class="user-note">${escapeHtml(displayText(savingsDisplay.note))}</p>
    </section>
  `;
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

function renderAgentJudgmentPanel(agentJudgment = {}) {
  if (!agentJudgment?.headline && !agentJudgment?.interpretedInput) return "";
  const assistance = agentJudgment.decisionAssistance || {};
  if (assistance.surface === "silent") return "";
  const interrupt = Boolean(assistance.interruptHuman);
  const title = interrupt ? "Risk judgment" : "Delegation judgment";
  const reasons = (assistance.riskReasons || agentJudgment.riskReasons || []).slice(0, 3).map(displayText).join(" · ");
  const help = (assistance.decisionHelp || agentJudgment.decisionHelp || agentJudgment.willDo || []).slice(0, 3).map(displayText).join(" · ");
  const recommendation = displayText(assistance.recommendedChoice || agentJudgment.recommendedChoice || "-");
  const evaluation = [
    assistance.evaluationSignals?.humanTarget ? `target ${displayText(assistance.evaluationSignals.humanTarget)}` : "",
    assistance.evaluationSignals?.expectedCognitiveLoad ? `load ${displayText(assistance.evaluationSignals.expectedCognitiveLoad)}` : ""
  ].filter(Boolean).join(" · ");
  return `
    <div class="agent-judgment-panel ${interrupt ? "interrupt" : "review"}">
      <span><b>${escapeHtml(title)}</b>${escapeHtml(displayText(agentJudgment.headline) || "-")}</span>
      <span><b>Input interpretation</b>${escapeHtml(displayText(agentJudgment.interpretedInput) || "-")}</span>
      <span><b>Why it is shown</b>${escapeHtml(reasons || "Only delegation scope is shown; no risk interruption.")}</span>
      <span><b>Recommendation</b>${escapeHtml(recommendation)}</span>
      <span><b>Human should check</b>${escapeHtml(help || "-")}</span>
      <span><b>Evaluation signal</b>${escapeHtml(evaluation || "No user judgment")}</span>
    </div>
  `;
}

function displayUserRequestText(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  const marker = "## My request for Codex:";
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex >= 0) return text.slice(markerIndex + marker.length).trim();
  return text.replace(/^# In app browser:[\s\S]*?(?:\n\n|$)/, "").trim();
}

function formatAgentUsageBoundary(state = {}, analysis = {}) {
  const runtime = state.runtime || {};
  const apiEndpoint = `${window.location.origin}/api/agent-visible-usage`;
  const scopedContextEvents = mcpContextEventsForRequest(state, analysis || state.latestAnalysis || {});
  const scopedActualEvents = actualWorkEventsForRequest(state, analysis || state.latestAnalysis || {});
  const mcpTokens = scopedContextEvents.reduce((sum, event) => sum + Number(event.tokens || 0), 0);
  const actualTokens = scopedActualEvents.reduce((sum, event) => sum + Number(event.tokens || 0), 0);
  const observed = scopedContextEvents.length || scopedActualEvents.length;
  return {
    apiEndpoint,
    providerStatus: "Excluded",
    status: observed
      ? `MCP ${formatTokenCount(mcpTokens)} · hook ${formatTokenCount(actualTokens)}`
      : `waiting for agent-visible events · runtime ${formatShortTime(runtime.startedAt)}`
  };
}

function summarizeAgentVisibleUsageEvents(group = {}) {
  const actualEvents = group.actualEvents || [];
  const mcpContextEvents = group.mcpContextEvents || [];
  const actualTokens = actualEvents.reduce((sum, event) => sum + Number(event.tokens || 0), 0);
  const mcpTokens = mcpContextEvents.reduce((sum, event) => sum + Number(event.tokens || 0), 0);
  const connected = actualTokens > 0 || mcpTokens > 0;
  if (!connected) {
    return {
      connected: false,
      value: "Off",
      status: "Waiting",
      detail: "Agent-visible basis. ScopeLease MCP input and hook/watcher payloads appear when recorded."
    };
  }
  const detail = [
    `MCP ${formatTokenCount(mcpTokens)}`,
    `hook/watcher ${formatTokenCount(actualTokens)}`,
    `${mcpContextEvents.length + actualEvents.length} events`
  ].filter(Boolean).join(" · ");
  return {
    connected: true,
    value: formatTokenCount(mcpTokens + actualTokens),
    status: "Observed",
    detail
  };
}

function formatGuardBrokerCopy(fatiguePlan = {}, state = {}) {
  const bundle = fatiguePlan.decisionBundle || {};
  const scope = bundle.scope || {};
  const metrics = state.fatigueMetrics || {};
  const leases = activeApprovalLeasesForDisplay(state);
  const fileCount = (scope.files || []).length;
  const commandCount = (scope.commands || []).length;
  const stopWhen = bundle.stopWhen || fatiguePlan.stopWhen || [];
  return {
    verdict: bundle.defaultVerdict || fatiguePlan.mode || "Preparing",
    lease: leases.length
      ? `${leases.length} signed active`
      : `${fatiguePlan.reusableApproval?.leaseMinutes || scope.expiresInMinutes || 30}m candidate`,
    metrics: `ask ${metrics.humanPromptsShown || 0} · auto ${metrics.agentActionsAutoAllowed || 0} · hit ${metrics.approvalLeaseHits || 0}`,
    question: displayText(bundle.question) || "Classify the agent action as allow / ask_once / prepare_only / deny before execution.",
    scope: `scope: ${fileCount} files · ${commandCount} commands · default ${bundle.defaultVerdict || "-"}`,
    stopWhen: stopWhen.length
      ? `stop: ${stopWhen.slice(0, 4).map(displayText).join(", ")}${stopWhen.length > 4 ? ` plus ${stopWhen.length - 4}` : ""}`
      : "No stop conditions yet."
  };
}

function buildGuardEvidence(state = {}, fatiguePlan = {}) {
  const guards = state.guardEvents || [];
  const latestGuard = guards[0] || null;
  const leases = activeApprovalLeasesForDisplay(state);
  const latestLease = leases[0] || null;
  const bundle = fatiguePlan.decisionBundle || {};
  const scope = latestLease || bundle.scope || {};
  const fileScopes = latestLease?.fileScopes || scope.files || [];
  const commandScopes = latestLease?.commandScopes || scope.commands || [];
  const stopWhen = latestLease?.stopWhen || bundle.stopWhen || fatiguePlan.stopWhen || [];
  const guardLabel = latestGuard
    ? `${latestGuard.verdict || "-"} · ${latestGuard.actionGrant || "-"}${latestGuard.leaseId ? ` · ${shortId(latestGuard.leaseId)}` : ""}`
    : "None yet";
  const leaseLabel = latestLease
    ? `${shortId(latestLease.id)} · ${latestLease.choiceId || "-"} · ${formatRelativeExpiry(latestLease.expiresAt)}`
    : "None";
  return {
    latestGuard: guardLabel,
    activeLease: leaseLabel,
    scope: `${fileScopes.length || 0} files · ${commandScopes.length || 0} commands`,
    stopWhen: stopWhen.length
      ? compactMiddle(stopWhen.slice(0, 3).map(displayText).join(", "), 70)
      : "None"
  };
}

function activeApprovalLeasesForDisplay(state = {}) {
  return (state.approvalLeases || []).filter(isDisplayableSignedApprovalLease);
}

function isDisplayableSignedApprovalLease(lease = {}) {
  if (!lease || typeof lease !== "object") return false;
  if (lease.expiresAt && Date.parse(lease.expiresAt) <= Date.now()) return false;
  return lease.signatureVersion === 1
    && lease.signatureAlgorithm === "hmac-sha256"
    && Boolean(lease.signatureKeyId)
    && /^[0-9a-f]{64}$/i.test(String(lease.signature || ""));
}

function shortId(value = "") {
  const text = String(value || "");
  if (text.length <= 14) return text;
  return `${text.slice(0, 8)}...${text.slice(-4)}`;
}

function formatRelativeExpiry(value = "") {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "no expiry";
  const minutes = Math.ceil((time - Date.now()) / 60000);
  if (minutes <= 0) return "expired";
  return `${minutes}m left`;
}

function formatLiveCopy(state = {}) {
  const connected = liveStatus.connected;
  const mode = connected ? "Live connected" : (liveStatus.mode === "poll" ? "Polling update" : "Waiting for reconnect");
  const scan = state.runtime?.scanIntervalMs ? ` · scan ${Math.round(state.runtime.scanIntervalMs / 100) / 10}s` : "";
  const at = liveStatus.at || state.latestAnalysis?.generatedAt || "";
  const eventTime = at ? formatLiveTime(at) : "-";
  return {
    status: `${mode}${scan}`,
    event: `${eventReasonLabel(liveStatus.reason)} · ${eventTime}`
  };
}

function formatLiveTime(value = "") {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleTimeString(activeLocale === "ko" ? "ko-KR" : "en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function eventReasonLabel(reason = "") {
  const map = {
    initial: "Initial analysis",
    scan: "Periodic scan",
    "file-change": "File change",
    "repo-refresh": "Root refresh",
    "repo-switch": "Root changed",
    update: "Manual refresh",
    state: "State received",
    poll: "Polling update",
    heartbeat: "Heartbeat",
    open: "Connected"
  };
  return map[reason] || reason || "Idle";
}

function updateLiveIndicators() {
  const copy = formatLiveCopy(currentState || {});
  for (const node of document.querySelectorAll("[data-live-status]")) {
    node.textContent = translateUiText(copy.status);
  }
  for (const node of document.querySelectorAll("[data-live-event]")) {
    node.textContent = translateUiText(copy.event);
  }
  if (elements.activityLabel && !elements.activityLabel.classList.contains("active")) {
    elements.activityLabel.textContent = translateUiText(copy.status);
  }
}

async function copyCodexInputToClipboard(text = "") {
  if (!text.trim()) {
    setActivity("No agent input to copy", true);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    setActivity("Agent input copied", true);
  } catch (_error) {
    setActivity("Browser copy permission unavailable", true);
  }
}

function buildActiveContext(graph, paths) {
  const nodesById = new Map((graph.nodes || []).map((node) => [node.id, node]));
  const queryIds = new Set();
  const activeNodeIds = new Set();
  const activePathKeys = new Set();
  const query = normalizeText(searchTermFromFilter(viewState.query));

  if (query) {
    for (const node of graph.nodes || []) {
      if (searchableNodeText(node).includes(query)) queryIds.add(node.id);
    }

    for (const path of paths) {
      if (!path.nodes.some((node) => queryIds.has(node.id))) continue;
      activePathKeys.add(pathKey(path));
      for (const node of path.nodes) activeNodeIds.add(node.id);
    }

    for (const edge of graph.edges || []) {
      if (queryIds.has(edge.source) || queryIds.has(edge.target)) {
        activeNodeIds.add(edge.source);
        activeNodeIds.add(edge.target);
      }
    }

    for (const id of queryIds) activeNodeIds.add(id);
  } else if (selectedNodeId) {
    for (const path of paths) {
      if (!path.nodes.some((node) => node.id === selectedNodeId)) continue;
      activePathKeys.add(pathKey(path));
      for (const node of path.nodes) activeNodeIds.add(node.id);
    }
  } else if (viewState.focus !== "all") {
    for (const path of paths) {
      activePathKeys.add(pathKey(path));
      for (const node of path.nodes) activeNodeIds.add(node.id);
    }
  }

  return { nodesById, queryIds, activeNodeIds, activePathKeys };
}

function visiblePaths(analysis) {
  const paths = analysis.impact?.paths || [];
  const focus = viewState.focus;
  if (focus === "all") return paths;
  const allowed = {
    route: ["route"],
    caller: ["imported_by", "imports"],
    test: ["test"],
    doc: ["doc"],
    policy: ["policy"],
    defines: ["defines"]
  }[focus] || [];
  return paths.filter((path) => allowed.includes(path.kind));
}

function pathNodeIds(paths, selectedId) {
  const ids = new Set();
  for (const path of paths) {
    if (selectedId && !path.nodes.some((node) => node.id === selectedId)) continue;
    for (const node of path.nodes) ids.add(node.id);
  }
  return ids;
}

function shouldDimNode(node, activePathNodes) {
  if (!activePathNodes.size || viewState.focus === "all" && !selectedNodeId && !viewState.query) return false;
  return !activePathNodes.has(node.id);
}

function shouldDimEdge(edge, paths, activePathNodes) {
  if (!activePathNodes.size || viewState.focus === "all" && !selectedNodeId && !viewState.query) return false;
  return !activePathNodes.has(edge.source) || !activePathNodes.has(edge.target) || !isEvidenceEdge(edge, paths);
}

function isEvidenceEdge(edge, paths) {
  return paths.some((path) =>
    path.nodes.some((node, index) => {
      const next = path.nodes[index + 1];
      if (!next) return false;
      return samePair(edge.source, edge.target, node.id, next.id);
    })
  );
}

function samePair(aSource, aTarget, bSource, bTarget) {
  return (aSource === bSource && aTarget === bTarget) || (aSource === bTarget && aTarget === bSource);
}

function pathKey(path) {
  return `${path.kind}:${path.summary || path.nodes.map((node) => node.id).join(">")}`;
}

function formatPath(path) {
  const parts = path.nodes.map((node) => formatNodeRef(node));
  return `${pathKindLabel(path.kind)}: ${parts.join(" > ")}`;
}

function formatNodeRef(node) {
  const label = node.path ? compactLabel(node.path, 34) : compactLabel(nodeCaption(node), 34);
  return node.line ? `${label}:${node.line}` : label;
}

function connectedRelationships(graph, nodeId) {
  const nodesById = new Map((graph.nodes || []).map((node) => [node.id, node]));
  return (graph.edges || [])
    .filter((edge) => edge.source === nodeId || edge.target === nodeId)
    .map((edge) => {
      const outgoing = edge.source === nodeId;
      const otherId = outgoing ? edge.target : edge.source;
      return {
        edge,
        direction: outgoing ? "OUT" : "IN",
        other: nodesById.get(otherId) || { id: otherId, label: otherId }
      };
    });
}

function nodeCaption(node) {
  return node.caption || node.properties?.name || node.label || node.path || node.id;
}

function nodeDisplayLabel(node = {}) {
  if (node.path && isFileNode(node)) return node.path;
  if (node.path && nodeLabels(node).includes("Route")) return node.path;
  return nodeCaption(node);
}

function formatRepoLabel(repo) {
  if (!repo) return "";
  const name = repo.split("/").filter(Boolean).at(-1) || repo;
  return `${name} · ${compactMiddle(repo, 68)}`;
}

function currentPairRunId() {
  try {
    return String(new URLSearchParams(window.location.search).get("runId") || "").trim();
  } catch {
    return "";
  }
}

function currentPairId() {
  try {
    const params = new URLSearchParams(window.location.search);
    return String(params.get("pairId") || params.get("pair") || "").trim();
  } catch {
    return "";
  }
}

function formatShortTime(value = "") {
  if (!value) return "start time unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "start time unknown";
  return date.toLocaleTimeString(activeLocale === "ko" ? "ko-KR" : "en-US", { hour: "2-digit", minute: "2-digit" });
}

function nodeTypeLabel(node) {
  const labels = new Set(nodeLabels(node));
  if (labels.has("Policy")) return "Policy";
  if (labels.has("Route")) return "Route";
  if (labels.has("Function")) return "Function";
  if (labels.has("Class")) return "Class";
  if (labels.has("Type")) return "Type";
  if (labels.has("TestFile")) return "Test";
  if (labels.has("Document")) return "Document";
  if (labels.has("ConfigFile")) return "Config";
  if (labels.has("CodeFile")) return "Code";
  if (node.className === "changed") return "Changed";
  if (node.className === "route") return "Route";
  if (node.className === "policy") return "Policy";
  if (node.className === "symbol") return node.type === "changed_type" ? "Changed type" : "Changed function";
  if (node.fileType === "test" || node.type === "test") return "Test";
  if (node.fileType === "doc" || node.type === "doc") return "Document";
  if (node.fileType === "code" || node.type === "file") return "Code";
  return node.fileType || node.type || "Node";
}

function pathKindLabel(kind) {
  return {
    route: "route path",
    test: "test evidence",
    doc: "doc evidence",
    policy: "policy evidence",
    imported_by: "call impact",
    imports: "dependency",
    defines: "defines",
    mentions: "mentions"
  }[kind] || kind;
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

function riskLabel(value) {
  return { low: "Low", medium: "Medium", high: "High", critical: "Critical" }[value] || displayText(value);
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
  }[value] || displayText(value);
}

function gateLabel(value) {
  return {
    approval_required: "Blocked until approval",
    senior_review_required: "Senior review required",
    owner_review_required: "Owner review required",
    auto_log_allowed: "Auto-log allowed",
    log_only: "Audit log"
  }[value] || displayText(value);
}

function autoLabel(gate) {
  if (gate.canAutoApplyPatch && gate.canAutoCheckpoint) return "Apply and checkpoint allowed";
  if (gate.canAutoApplyPatch) return "Apply allowed, checkpoint separate";
  if (gate.canAutoPreparePatch) return "Prepare patch only";
  return "Automated work blocked";
}

function nextActionLabel(gate, analysis) {
  if (gate.status === "approval_required") return "Do not auto-apply before approver review.";
  if (gate.status === "senior_review_required") return "Prepare a patch draft only; senior review is required.";
  if (gate.status === "owner_review_required") return "Update the checkpoint after owner review.";
  if (gate.canAutoApplyPatch) return "Low-risk changes can be applied with an audit trail.";
  return `Route through ${routeLabel(analysis.recommendation || "auto_log")}.`;
}

function formatTokenEconomy(economy) {
  if (!economy) {
    return {
      agentInput: "-",
      tokenMode: "no token measurement",
      tokenMethod: "-",
      summary: "No input-candidate measurement.",
      field: "contextPack.agentContext",
      visualGraph: "-",
      omittedSummary: "No omitted-priority details.",
      budget: "No budget data"
    };
  }
  const labels = economy.labels || {};
  const fullRepo = labels.fullRepo || formatTokenCount(economy.fullRepoTokens);
  const userRequest = labels.userRequest || formatTokenCount(economy.userRequestTokens);
  const agentInput = labels.agentInput || formatTokenCount(economy.agentContextTokens);
  const actualInput = labels.actualInput || formatTokenCount(economy.actualInputTokens || economy.agentContextTokens);
  const actualInputChars = labels.actualInputChars || formatCharCount(economy.actualInputChars);
  const visualGraph = labels.visualGraph || formatTokenCount(economy.visualGraphTokens);
  const budget = labels.budget || formatTokenCount(economy.budget);
  const overBudget = labels.overBudget || formatTokenCount(economy.overBudgetTokens);
  const field = economy.agentInput?.field || "contextPack.agentContext";
  const omittedSummary = formatOmittedSummary(economy.agentInput?.omitted);
  const tokenMode = economy.exactTokens ? "local token measurement" : "fallback estimate";
  const tokenMethod = formatTokenizer(economy.tokenizer, tokenMode);
  return {
    fullRepo,
    userRequest,
    agentInput,
    actualInput,
    actualInputChars,
    tokenMode,
    tokenMethod,
    summary: displayText(economy.summary) || `The user request is ${userRequest}; the agent input candidate is ${actualInput}. The real pair delta compares observed default-codex input n with scopelease-codex input m for the same work intent, and only positive deltas count as savings.`,
    field,
    actualField: economy.actualInput?.field || "codexInput.text",
    visualGraph,
    omittedSummary,
    budget: displayText(economy.budgetSummary) || (economy.fitsBudget ? `fits within budget ${budget}` : `${overBudget} over budget ${budget}`)
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

function formatCharCount(value) {
  const chars = Number(value || 0);
  if (!Number.isFinite(chars) || chars <= 0) return "0";
  const scaled = chars / 1000;
  const fixed = scaled < 10 ? scaled.toFixed(2) : scaled.toFixed(1);
  return `${trimTrailingZero(fixed)}k`;
}

function trimTrailingZero(value) {
  return String(Number(value));
}

function nodeMarker(node, analysis) {
  const recent = recentNodeMarkers.get(node.id);
  if (recent) return recent.kind;
  return "";
}

function nodeClasses(node, analysis, context) {
  const classes = [nodeMarker(node, analysis)];
  if (isChangedNode(node)) classes.push("changed-flag");
  if (context.queryIds.has(node.id)) classes.push("query-hit");
  else if (viewState.query && context.activeNodeIds.has(node.id)) classes.push("query-expanded");
  return classes.filter(Boolean).join(" ");
}

function isChangedNode(node) {
  const labels = nodeLabels(node);
  return Boolean(node.properties?.changed || labels.includes("Changed") || String(node.type || "").startsWith("changed_"));
}

function searchableNodeText(node) {
  return normalizeText([
    node.id,
    node.label,
    node.caption,
    node.path,
    node.type,
    node.fileType,
    node.line,
    ...(nodeLabels(node) || []),
    ...Object.values(node.properties || {})
  ].filter(Boolean).join(" "));
}

function searchTermFromFilter(value) {
  return String(value || "").trim();
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function trackGraphDelta(graph, positions, analysis, eventReason) {
  const ids = new Set((graph.nodes || []).map((node) => node.id));
  const fingerprints = new Map((graph.nodes || []).map((node) => [node.id, nodeFingerprint(node)]));
  const signature = [...fingerprints.entries()].map(([id, fingerprint]) => `${id}:${fingerprint}`).sort().join("|");
  if (signature === lastAnalysisSignature) return;

  const now = Date.now();
  let added = 0;
  let updated = 0;
  let removed = 0;

  if (knownNodeIds && knownNodeFingerprints) {
    const nodesById = new Map((graph.nodes || []).map((node) => [node.id, node]));
    for (const [id, fingerprint] of fingerprints) {
      const node = nodesById.get(id);
      if (!knownNodeIds.has(id)) {
        if (!shouldMarkRealtimeNode(node, analysis)) continue;
        recentNodeMarkers.set(id, { kind: "new", expiresAt: now + MARKER_TTL });
        added += 1;
        continue;
      }
      if (knownNodeFingerprints.get(id) !== fingerprint && shouldMarkRealtimeNode(node, analysis)) {
        recentNodeMarkers.set(id, { kind: "updated", expiresAt: now + MARKER_TTL });
        updated += 1;
      }
    }

    for (const id of knownNodeIds) {
      if (ids.has(id)) continue;
      const previous = lastPositions.get(id);
      if (previous) ghostNodes.set(id, { ...previous, id, expiresAt: now + MARKER_TTL });
      removed += 1;
    }
  }

  knownNodeIds = ids;
  knownNodeFingerprints = fingerprints;
  lastAnalysisSignature = signature;
  pruneTransientMarkers();
  if (added || updated || removed) setActivity(`Added ${added} / updated ${updated} / removed ${removed}`, true);
  else if (eventReason && !["render", "layout_reset", "drag", "drag_start", "drag_end", "marker_cleanup"].includes(eventReason)) setActivity("Live update applied", true);
  scheduleMarkerCleanup();
}

function nodeFingerprint(node = {}) {
  const properties = node.properties || {};
  const stableProperties = [
    properties.hash,
    properties.contentHash,
    properties.changed,
    properties.risk,
    properties.line,
    properties.lineStart,
    properties.lineEnd,
    properties.name,
    properties.type
  ].filter((value) => value !== undefined && value !== null).join(":");
  return [
    node.id || "",
    node.type || "",
    node.path || "",
    node.label || "",
    node.caption || "",
    node.fileType || "",
    stableProperties
  ].join("::");
}

function shouldMarkRealtimeNode(node = {}, analysis = {}) {
  if (!node?.id) return false;
  const changedIds = changedNodeIds(analysis);
  if (changedIds.has(node.id)) return true;
  const changes = analysis.changes || {};
  const changedPaths = new Set([
    ...(changes.files || []),
    ...(changes.added || []),
    ...(changes.modified || []),
    ...(changes.deleted || [])
  ]);
  return Boolean(node.path && changedPaths.has(node.path));
}

function rememberPositions(positions) {
  lastPositions.clear();
  for (const [id, node] of positions) lastPositions.set(id, { ...node });
}

function pruneTransientMarkers() {
  const now = Date.now();
  for (const [id, marker] of recentNodeMarkers) {
    if (marker.expiresAt <= now) recentNodeMarkers.delete(id);
  }
  for (const [id, ghost] of ghostNodes) {
    if (ghost.expiresAt <= now) ghostNodes.delete(id);
  }
}

function scheduleMarkerCleanup() {
  clearTimeout(markerCleanupTimer);
  if (!recentNodeMarkers.size && !ghostNodes.size) return;
  markerCleanupTimer = setTimeout(() => {
    pruneTransientMarkers();
    if (currentAnalysis) render(currentAnalysis, "marker_cleanup");
  }, MARKER_TTL + 80);
}

function setActivity(text, active = false) {
  if (!elements.activityLabel) return;
  elements.activityLabel.textContent = translateUiText(text);
  elements.activityLabel.classList.toggle("active", active);
  if (!active) return;
  window.clearTimeout(setActivity.timer);
  setActivity.timer = window.setTimeout(() => {
    elements.activityLabel.textContent = translateUiText("Live connected");
    elements.activityLabel.classList.remove("active");
  }, 3200);
}

function renderError(message) {
  if (!elements.decisionPanel) return;
  elements.decisionPanel.innerHTML = `
    <strong>Path connection failed</strong>
    <span>${escapeHtml(message)}</span>
    <span>Enter a local folder path that exists, such as /Users/name/project or ~/project.</span>
  `;
  applyLocaleToDocument();
}

function startNodeDrag(event, node, analysis) {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const point = svgPoint(event);
  dragState = {
    type: "node",
    nodeId: node.id,
    startX: point.x,
    startY: point.y,
    originX: node.x,
    originY: node.y,
    moved: false
  };
  selectedNodeId = node.id;
  document.body.classList.add("dragging-node");
  if (event.currentTarget.setPointerCapture) event.currentTarget.setPointerCapture(event.pointerId);
  render(analysis, "drag_start");
}

function startCanvasPan(event) {
  if (event.button !== 0) return;
  event.preventDefault();
  dragState = {
    type: "pan",
    startClientX: event.clientX,
    startClientY: event.clientY,
    originPanX: viewportState.panX,
    originPanY: viewportState.panY,
    moved: false
  };
  document.body.classList.add("panning-graph");
  viewportInitialized = true;
}

function handlePointerMove(event) {
  if (!dragState || !currentAnalysis) return;
  event.preventDefault();
  if (dragState.type === "pan") {
    const dx = event.clientX - dragState.startClientX;
    const dy = event.clientY - dragState.startClientY;
    if (Math.hypot(dx, dy) > 2) dragState.moved = true;
    viewportState.panX = dragState.originPanX + dx;
    viewportState.panY = dragState.originPanY + dy;
    render(currentAnalysis, "pan");
    return;
  }

  const point = svgPoint(event);
  const dx = point.x - dragState.startX;
  const dy = point.y - dragState.startY;
  if (Math.hypot(dx, dy) > 2) dragState.moved = true;
  const width = elements.canvas.clientWidth || window.innerWidth;
  const height = elements.canvas.clientHeight || window.innerHeight;
  manualPositions.set(dragState.nodeId, {
    x: clamp(dragState.originX + dx, 24, width - 24),
    y: clamp(dragState.originY + dy, 24, height - 24)
  });
  render(currentAnalysis, "drag");
}

function handlePointerUp() {
  if (!dragState) return;
  const endedType = dragState.type;
  suppressNextClick = dragState.moved;
  dragState = null;
  document.body.classList.remove("dragging-node");
  document.body.classList.remove("panning-graph");
  if (suppressNextClick) setActivity(endedType === "pan" ? "Pan applied" : "Manual layout applied", true);
  if (currentAnalysis) render(currentAnalysis, "drag_end");
}

function svgPoint(event) {
  return screenToGraph(event);
}

function screenToGraph(event) {
  const point = screenPoint(event);
  return {
    x: (point.x - viewportState.panX) / viewportState.zoom,
    y: (point.y - viewportState.panY) / viewportState.zoom
  };
}

function screenPoint(event) {
  const svg = elements.canvas;
  const rect = svg.getBoundingClientRect();
  const viewBox = svg.viewBox.baseVal;
  const width = viewBox?.width || rect.width || 1;
  const height = viewBox?.height || rect.height || 1;
  return {
    x: ((event.clientX - rect.left) / Math.max(1, rect.width)) * width + (viewBox?.x || 0),
    y: ((event.clientY - rect.top) / Math.max(1, rect.height)) * height + (viewBox?.y || 0)
  };
}

function handleWheel(event) {
  event.preventDefault();
  zoomBy(event.deltaY < 0 ? 1.12 : 0.88, event);
}

function zoomBy(factor, anchorEvent = null) {
  const oldZoom = viewportState.zoom;
  const nextZoom = clamp(oldZoom * factor, 0.45, 2.8);
  if (Math.abs(nextZoom - oldZoom) < 0.001) return;

  const screen = anchorEvent ? screenPoint(anchorEvent) : graphCenterScreenPoint();
  const graph = anchorEvent ? screenToGraph(anchorEvent) : graphCenterPoint();
  viewportState.zoom = nextZoom;
  viewportState.panX = screen.x - graph.x * nextZoom;
  viewportState.panY = screen.y - graph.y * nextZoom;
  viewportInitialized = true;
  setActivity(`Zoom ${Math.round(nextZoom * 100)}%`, true);
  if (currentAnalysis) render(currentAnalysis, "zoom");
}

function fitViewportToPositions(positions) {
  const nodes = [...positions.values()];
  if (!nodes.length) {
    viewportState.zoom = 1;
    viewportState.panX = 0;
    viewportState.panY = 0;
    return;
  }

  const width = elements.canvas.clientWidth || window.innerWidth;
  const height = elements.canvas.clientHeight || window.innerHeight;
  const bounds = graphBounds(nodes);
  if (isSidecarMode) {
    const availableWidth = Math.max(280, width - 180);
    const availableHeight = Math.max(260, height - 92);
    const maxZoom = nodes.length <= DECISION_GRAPH_NODE_LIMIT ? 1.04 : nodes.length <= FULL_GRAPH_NODE_LIMIT ? 0.86 : 0.76;
    const nextZoom = clamp(Math.min(availableWidth / bounds.width, availableHeight / bounds.height, maxZoom), 0.24, maxZoom);
    viewportState.zoom = nextZoom;
    viewportState.panX = width / 2 - bounds.cx * nextZoom;
    viewportState.panY = height / 2 - bounds.cy * nextZoom;
    return;
  }
  const panelReserve = width > 980 ? 500 : 86;
  const availableWidth = Math.max(300, width - panelReserve);
  const availableHeight = Math.max(300, height - (width <= 720 ? 360 : 220));
  const maxZoom = nodes.length <= DECISION_GRAPH_NODE_LIMIT ? 1.55 : nodes.length <= FULL_GRAPH_NODE_LIMIT ? 1.18 : 1;
  const nextZoom = clamp(Math.min(availableWidth / bounds.width, availableHeight / bounds.height, maxZoom), 0.28, maxZoom);
  const targetX = width > 980 ? availableWidth / 2 + 24 : width / 2;
  const targetY = width <= 720 ? Math.max(240, height * 0.42) : height * 0.54;
  viewportState.zoom = nextZoom;
  viewportState.panX = targetX - bounds.cx * nextZoom;
  viewportState.panY = targetY - bounds.cy * nextZoom;
}

function graphBounds(nodes) {
  const minX = Math.min(...nodes.map((node) => node.x - node.radius));
  const maxX = Math.max(...nodes.map((node) => node.x + node.radius));
  const minY = Math.min(...nodes.map((node) => node.y - node.radius));
  const maxY = Math.max(...nodes.map((node) => node.y + node.radius));
  return {
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2
  };
}

function graphCenterScreenPoint() {
  const svg = elements.canvas;
  const viewBox = svg.viewBox.baseVal;
  return {
    x: (viewBox?.width || svg.clientWidth || window.innerWidth) / 2,
    y: (viewBox?.height || svg.clientHeight || window.innerHeight) / 2
  };
}

function graphCenterPoint() {
  const screen = graphCenterScreenPoint();
  return {
    x: (screen.x - viewportState.panX) / viewportState.zoom,
    y: (screen.y - viewportState.panY) / viewportState.zoom
  };
}

function compactLabel(value, max) {
  const text = String(value).split("/").at(-1) || String(value);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function compactMiddle(value, max) {
  const text = String(value || "");
  if (text.length <= max) return text;
  const keep = Math.max(8, Math.floor((max - 3) / 2));
  return `${text.slice(0, keep)}...${text.slice(-keep)}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function userPanelHeader(title, meta = "") {
  return `
    <div class="user-panel-head">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(displayText(meta))}</span>
    </div>
  `;
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
    [/(\d+)개 추가/g, "$1 added"],
    [/(\d+)개 변경/g, "$1 changed"],
    [/(\d+)개 삭제/g, "$1 deleted"],
    [/(\d+)개 심볼 감지/g, "$1 symbols detected"],
    [/높음 위험/g, "high risk"],
    [/중간 위험/g, "medium risk"],
    [/낮음 위험/g, "low risk"],
    [/(budget \S+)보다 (\S+) 많습니다\.?/g, "$2 over $1"],
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function emptyAnalysis(repo) {
  return {
    repo,
    risk: "low",
    generatedAt: null,
    changes: { added: [], modified: [], files: [], deleted: [], symbols: {} },
    impact: { routes: [], importedBy: [], tests: [], docs: [], paths: [] },
    policyHits: [],
    graph: { nodes: [], edges: [] },
    knowledgeGraph: { schema: { model: "scopelease_knowledge_graph", nodeLabels: [], relationshipTypes: [] }, nodes: [], edges: [] }
  };
}

function connectEvents() {
  if (!window.EventSource) return false;
  const source = new EventSource("/api/events");
  source.addEventListener("open", () => {
    liveStatus = {
      connected: true,
      mode: "sse",
      reason: "open",
      at: new Date().toISOString()
    };
    updateLiveIndicators();
  });
  source.addEventListener("state", async (event) => {
    const state = await attachHubProjects(JSON.parse(event.data));
    liveStatus = {
      connected: true,
      mode: "sse",
      reason: state.eventReason || "state",
      at: new Date().toISOString()
    };
    renderRemoteState(state, state.eventReason || "event");
  });
  source.addEventListener("heartbeat", async (event) => {
    const heartbeat = JSON.parse(event.data || "{}");
    liveStatus = {
      connected: true,
      mode: "sse",
      reason: "heartbeat",
      at: heartbeat.now || new Date().toISOString()
    };
    if (statePulseChanged(heartbeat.statePulse)) {
      try {
        const state = await fetchRemoteState();
        renderRemoteState(state, "heartbeat-state");
        return;
      } catch {
        liveStatus = {
          connected: false,
          mode: "reconnect",
          reason: "server waiting",
          at: new Date().toISOString()
        };
      }
    }
    updateLiveIndicators();
  });
  source.addEventListener("error", () => {
    liveStatus = {
      connected: false,
      mode: "reconnect",
      reason: "server waiting",
      at: new Date().toISOString()
    };
    updateLiveIndicators();
    source.close();
    startPolling();
  });
  return true;
}

function statePulseChanged(pulse = {}) {
  if (!pulse || !Object.keys(pulse).length) return false;
  if (!currentState?.latestAnalysis) return true;
  const analysis = currentState.latestAnalysis || {};
  const currentPulse = {
    generatedAt: analysis.generatedAt || "",
    request: analysis.contextPack?.userRequest?.text || analysis.userRequest || "",
    codexInputTokens: analysis.contextPack?.codexInput?.tokens || analysis.contextPack?.tokenEconomy?.actualInputTokens || 0,
    mcpContextEvents: (currentState.mcpContextEvents || []).length,
    actualWorkEvents: (currentState.actualWorkEvents || []).length
  };
  return (
    String(pulse.generatedAt || "") !== currentPulse.generatedAt ||
    String(pulse.request || "") !== currentPulse.request ||
    Number(pulse.codexInputTokens || 0) !== Number(currentPulse.codexInputTokens || 0) ||
    Number(pulse.mcpContextEvents || 0) !== Number(currentPulse.mcpContextEvents || 0) ||
    Number(pulse.actualWorkEvents || 0) !== Number(currentPulse.actualWorkEvents || 0)
  );
}

function startPolling() {
  if (pollTimer) return;
  refresh();
  pollTimer = setInterval(refresh, 1800);
}

window.addEventListener("resize", () => {
  if (currentAnalysis) render(currentAnalysis);
});
document.addEventListener("visibilitychange", flushPendingRemoteState);
window.addEventListener("pointermove", handlePointerMove);
window.addEventListener("pointerup", handlePointerUp);
window.addEventListener("pointercancel", handlePointerUp);
elements.canvas.addEventListener("wheel", handleWheel, { passive: false });
if (!connectEvents()) startPolling();
