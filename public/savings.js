const PAIR_RECENCY_WINDOW_MS = 60 * 60 * 1000;

export function actualWorkEventsForRequest(state = {}, analysis = {}) {
  return eventsForWorkIntent(state.actualWorkEvents || [], analysis)
    .filter((event) => eventLane(event) !== "scopelease-internal");
}

export function mcpContextEventsForRequest(state = {}, analysis = {}) {
  return eventsForWorkIntent(state.mcpContextEvents || [], analysis);
}

export function buildObservedWorkIntentSavings({
  state = {},
  analysis = {},
  pairId = "",
  runId = "",
  actualEvents = null,
  mcpContextEvents = null
} = {}) {
  const scopedActualEvents = Array.isArray(actualEvents)
    ? actualEvents
    : actualWorkEventsForRequest(state, analysis);
  const scopedContextEvents = Array.isArray(mcpContextEvents)
    ? mcpContextEvents
    : mcpContextEventsForRequest(state, analysis);
  const selected = selectObservedPairRun({
    pairId,
    runId,
    actualEvents: scopedActualEvents,
    contextEvents: scopedContextEvents
  });
  const defaultTokens = selected.defaultTokens;
  const scopeleaseTokens = selected.scopeleaseTokens;
  const scopeleaseWorkReady = Number(selected.eventCounts?.scopeleaseWork || 0) > 0;
  const scopeleaseContextReady = Number(selected.eventCounts?.scopeleaseContext || 0) > 0;
  const measured = defaultTokens > 0 && scopeleaseTokens > 0 && scopeleaseWorkReady && scopeleaseContextReady;
  const savedTokens = measured ? defaultTokens - scopeleaseTokens : null;
  const savedPercent = measured ? Math.round((savedTokens / defaultTokens) * 100) : null;
  const missing = [
    defaultTokens ? "" : "default-codex 입력 n",
    scopeleaseTokens ? "" : "scopelease-codex 입력 m",
    scopeleaseWorkReady ? "" : "scopelease-codex 입력 이벤트",
    scopeleaseContextReady ? "" : "scopelease_get_context 근거"
  ].filter(Boolean);
  const requestKey = normalizeLedgerRequest(analysis.contextPack?.userRequest?.text || analysis.userRequest || "");
  return {
    workIntent: deriveLedgerWorkIntent(requestKey),
    pairId: selected.pairId || "",
    runId: selected.runId || "",
    pairSelection: selected.selection,
    measured,
    defaultTokens,
    scopeleaseTokens,
    savedTokens,
    savedPercent,
    missing,
    eventCounts: selected.eventCounts || { default: 0, scopeleaseContext: 0, scopeleaseWork: 0 },
    latestTimestamp: selected.latestTimestamp || ""
  };
}

export function formatObservedSavings(pair = {}, formatTokenCount = defaultTokenFormatter) {
  const defaultTokens = Number(pair.defaultTokens || 0);
  const scopeleaseTokens = Number(pair.scopeleaseTokens || 0);
  const savedTokens = pair.savedTokens === null || pair.savedTokens === undefined
    ? null
    : Number(pair.savedTokens || 0);
  const savedPercent = pair.savedPercent === null || pair.savedPercent === undefined
    ? null
    : Number(pair.savedPercent || 0);
  const measured = Boolean(pair.measured && defaultTokens > 0 && scopeleaseTokens > 0);
  const missing = Array.isArray(pair.missing) && pair.missing.length
    ? pair.missing
    : [
      defaultTokens ? "" : "default-codex 입력 n",
      scopeleaseTokens ? "" : "scopelease-codex 입력 m"
    ].filter(Boolean);
  return {
    ...pair,
    measured,
    defaultTokens,
    scopeleaseTokens,
    savedTokens,
    savedPercent,
    missing,
    defaultText: defaultTokens ? formatTokenCount(defaultTokens) : "관측 필요",
    scopeleaseText: scopeleaseTokens ? formatTokenCount(scopeleaseTokens) : "관측 필요",
    savedText: savedTokens === null ? "pair 필요" : formatTokenCount(savedTokens),
    rateText: measured ? `${formatTokenCount(savedTokens)} / ${savedPercent}%` : `${missing.join(", ")} 필요`,
    statusText: measured
      ? savingsStatusText({ defaultTokens, scopeleaseTokens, savedTokens, savedPercent, formatTokenCount })
      : `${missing.join(", ")} 관측이 필요합니다.`
  };
}

export function buildHookSavingsEstimate({ state = {}, analysis = {} } = {}) {
  const context = state.codexSessionContext || state.agentVisibleUsageDetection || state.codexUsageDetection || {};
  const usage = context.agentVisibleUsage || state.agentVisibleUsage || {};
  const aggregate = context.codexLocalAggregate || {};
  const workspaceScope = context.codexWorkspaceScope || {};
  const confidenceBand = String(aggregate.confidenceBand || usage.confidence?.codexSessionTrend || "");
  const band = extractPercentBand(confidenceBand);
  const currentRepoThreadRecords = Number(
    aggregate.currentRepoThreadRecords ||
    aggregate.currentRepoThreads ||
    workspaceScope.includedThreadRecords ||
    workspaceScope.includedThreads ||
    usage.codexLocalThreadRecords ||
    usage.codexScopedThreadRecords ||
    0
  );
  const aggregateTokens = Number(aggregate.totalTokens || usage.codexLocalAggregateTokens || 0);
  const scopedWorkspaceCount = Number(workspaceScope.scopedWorkspaceCount || workspaceScope.includedWorkspaceCount || usage.codexScopedWorkspaceCount || 0);
  const excludedWorkspaceCount = Number(workspaceScope.excludedWorkspaceCount || usage.codexExcludedWorkspaceCount || 0);
  const currentRepo = workspaceScope.currentRepo || state.repo || analysis.repo || "";
  const available = Boolean(band && currentRepoThreadRecords > 0);
  return {
    kind: "hook_agent_visible_estimate",
    available,
    band,
    valueText: available ? band : "추정 대기",
    label: available ? `Hook 추정 ${band}` : "Hook 추정 대기",
    metaText: "agent-visible trend",
    aggregateTokens,
    currentRepoThreadRecords,
    scopedWorkspaceCount,
    excludedWorkspaceCount,
    currentRepo,
    confidenceBand,
    basis: "codex_local_aggregate hook/session trend for the current repo; not provider billing and not observed pair savings",
    statusText: available
      ? `Hook이 잡은 현재 repo Codex thread 기록 ${currentRepoThreadRecords}개 기준 session trend 추정입니다. 실제 pair 절감률은 default-codex 입력 n과 scopelease-codex 입력 m이 모두 있을 때 별도로 계산합니다.`
      : "Hook session trend가 아직 충분히 관측되지 않았습니다."
  };
}

export function formatSavingsDisplay(pairSavings = {}, hookEstimate = {}) {
  if (pairSavings.measured) {
    const positiveSavings = Number(pairSavings.savedTokens || 0) > 0;
    return {
      label: positiveSavings ? "실제 절감률" : "실제 pair delta",
      value: `${pairSavings.savedText} / ${pairSavings.savedPercent}%`,
      meta: pairSavings.pairSelection || "observed pair",
      note: pairSavings.statusText || "같은 work intent의 default/scopelease 관측 pair 기준입니다. 양수 delta만 절감률입니다."
    };
  }
  if (hookEstimate.available) {
    return {
      label: "Hook 경향",
      value: hookEstimate.valueText,
      meta: hookEstimate.metaText || "agent-visible trend",
      note: hookEstimate.statusText
    };
  }
  return {
    label: "Pair delta",
    value: "기준 입력 대기",
    meta: pairSavings.pairSelection || "observed pair",
    note: "같은 work intent의 default-codex 입력 n과 scopelease-codex 입력 m이 모두 관측되면 pair delta를 계산합니다. 양수일 때만 절감률입니다."
  };
}

function eventsForWorkIntent(events = [], analysis = {}) {
  const requestKey = normalizeLedgerRequest(analysis.contextPack?.userRequest?.text || analysis.userRequest || "");
  const workIntent = deriveLedgerWorkIntent(requestKey);
  if (!workIntent) return [];
  return (events || []).filter((event) => {
    const eventIntent = normalizeLedgerRequest(event.workIntent || event.meta?.workIntent || "");
    if (eventIntent) return eventIntent === workIntent || eventIntent === requestKey;
    const eventRequest = normalizeLedgerRequest(event.userRequest || "");
    return eventRequest === requestKey || deriveLedgerWorkIntent(eventRequest) === workIntent;
  });
}

function deriveLedgerWorkIntent(value = "") {
  const normalized = extractLedgerUserRequest(value).replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const paths = uniqueValues((normalized.match(/\b[A-Za-z0-9_.@/-]+\.(?:m?js|cjs|ts|tsx|jsx|json|md|toml|ya?ml|css|html|py|go|rs|java|kt|swift|c|cpp|h|hpp|sql|sh)(?::\d+)?\b/g) || []).map((item) => item.toLowerCase().replace(/:\d+$/, "")));
  const findings = [];
  for (const match of normalized.matchAll(/\bfinding\s*#?\s*(\d+)\b/gi)) findings.push(`finding-${match[1]}`);
  for (const match of normalized.matchAll(/\[p([0-3])\]/gi)) findings.push(`p${match[1]}`);
  const stop = new Set(["the", "and", "for", "with", "from", "this", "that", "request", "user", "input", "지금", "실제", "내용", "기준", "하면", "해서", "하고", "한다", "있는", "없는", "으로", "에서", "이걸", "그걸", "보자", "해봐", "해야", "하는", "하게", "같은", "이번", "요청"]);
  const terms = [];
  for (const token of normalized.toLowerCase().match(/[\p{L}\p{N}_@./:-]{2,}/gu) || []) {
    const cleaned = token.replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, "");
    if (!cleaned || /^\d+$/.test(cleaned) || stop.has(cleaned) || paths.includes(cleaned.replace(/:\d+$/, ""))) continue;
    terms.push(cleaned);
  }
  return uniqueValues([...paths, ...findings, ...terms]).slice(0, 24).join(" ").slice(0, 240) || normalized.slice(0, 240);
}

function extractLedgerUserRequest(value = "") {
  const text = normalizeLedgerRequest(value);
  const match = text.match(/User request:\s*([\s\S]*?)(?:\n\s*ScopeLease context:|\n\s*Boundary:|\n\s*```json|$)/i);
  return normalizeLedgerRequest(match?.[1] || text);
}

function uniqueValues(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = String(value || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

function selectObservedPairRun({ pairId = "", runId = "", actualEvents = [], contextEvents = [] }) {
  const wantedPairId = normalizePairId(pairId);
  const wantedRunId = normalizeRunId(runId);
  const groups = new Map();
  for (const event of [...(actualEvents || []), ...(contextEvents || [])]) {
    const lane = eventLane(event);
    const contextEvent = event.kind === "scopelease.mcp_context_event" || event.tool === "scopelease_get_context";
    if (contextEvent) {
      if (lane !== "scopelease-codex") continue;
    } else {
      if (!["default-codex", "scopelease-codex"].includes(lane)) continue;
      if (!isObservedInputPayload(event)) continue;
    }
    const eventPairId = normalizePairId(event.pairId || event.pair_id || event.meta?.pairId || event.meta?.pair_id);
    const eventRunId = normalizeRunId(event.runId || event.meta?.runId);
    if (!eventMatchesPairScope({
      eventPairId,
      eventRunId,
      wantedPairId,
      wantedRunId,
      allowDefaultBaselineRun: lane === "default-codex"
    })) continue;
    const key = wantedRunId ? `${eventPairId || "unpaired"}::${wantedRunId}` : eventPairId || eventRunId || "unscoped";
    const group = groups.get(key) || emptyPairGroup({ pairId: eventPairId, runId: eventRunId || "unscoped" });
    group.latestTimestamp = maxIso(group.latestTimestamp, event.timestamp);
    if (eventPairId && !group.pairId) group.pairId = eventPairId;
    if (eventRunId && !group.runId) group.runId = eventRunId;
    if (contextEvent) {
      if (!group.latestContextEvent || compareIso(event.timestamp, group.latestContextEvent.timestamp) >= 0) group.latestContextEvent = event;
      group.eventCounts.scopeleaseContext += 1;
    } else if (lane === "default-codex") group.defaultEvents.push(event);
    else if (lane === "scopelease-codex") group.scopeleaseWorkEvents.push(event);
    groups.set(key, group);
  }
  const candidates = [...groups.values()].map((group) => {
    const scopeleaseContextTokens = Number(group.latestContextEvent?.tokens || 0);
    const contextTimestamp = group.latestContextEvent?.timestamp || "";
    const contextRunId = normalizeRunId(group.latestContextEvent?.runId || group.latestContextEvent?.meta?.runId);
    const defaultBaselineRunId = contextRunId ? `${contextRunId}:default-baseline` : "";
    const defaultBucket = latestInputBucket(group.defaultEvents, {
      preferredRunId: defaultBaselineRunId,
      anchorTimestamp: contextTimestamp,
      maxDistanceMs: PAIR_RECENCY_WINDOW_MS
    });
    const scopeleaseWorkBucket = latestInputBucket(group.scopeleaseWorkEvents, {
      preferredRunId: contextRunId,
      anchorTimestamp: contextTimestamp,
      maxDistanceMs: PAIR_RECENCY_WINDOW_MS
    });
    const scopeleaseTokens = scopeleaseContextTokens + scopeleaseWorkBucket.tokens;
    const selectedRunId = contextRunId || scopeleaseWorkBucket.runId || defaultBucket.runId || group.runId;
    return {
      pairId: group.pairId || "",
      runId: selectedRunId === "unscoped" ? "" : selectedRunId,
      selection: pairSelectionLabel({ wantedPairId, wantedRunId, group }),
      latestTimestamp: group.latestTimestamp,
      defaultTokens: defaultBucket.tokens,
      scopeleaseTokens,
      defaultRunId: defaultBucket.runId || null,
      scopeleaseContextRunId: contextRunId || null,
      scopeleaseWorkRunId: scopeleaseWorkBucket.runId || null,
      measured: defaultBucket.tokens > 0 && scopeleaseWorkBucket.tokens > 0 && scopeleaseContextTokens > 0,
      eventCounts: {
        default: defaultBucket.count,
        scopeleaseContext: group.eventCounts.scopeleaseContext,
        scopeleaseWork: scopeleaseWorkBucket.count
      }
    };
  });
  candidates.sort((left, right) => {
    if (left.measured !== right.measured) return left.measured ? -1 : 1;
    return compareIso(right.latestTimestamp, left.latestTimestamp);
  });
  return candidates[0] || {
    pairId: wantedPairId,
    runId: wantedRunId,
    selection: pairSelectionLabel({ wantedPairId, wantedRunId }),
    latestTimestamp: "",
    defaultTokens: 0,
    scopeleaseTokens: 0,
    eventCounts: { default: 0, scopeleaseContext: 0, scopeleaseWork: 0 }
  };
}

function eventMatchesPairScope({
  eventPairId = "",
  eventRunId = "",
  wantedPairId = "",
  wantedRunId = "",
  allowDefaultBaselineRun = false
} = {}) {
  if (wantedPairId && eventPairId !== wantedPairId) return false;
  if (!wantedRunId) return true;
  if (!eventRunId) return false;
  return eventRunId === wantedRunId || (allowDefaultBaselineRun && eventRunId === `${wantedRunId}:default-baseline`);
}

function pairSelectionLabel({ wantedPairId = "", wantedRunId = "", group = {} } = {}) {
  if (wantedPairId && wantedRunId) return "explicit_pair_run";
  if (wantedPairId) return "explicit_pair_id";
  if (wantedRunId) return "explicit_run_id";
  if (!group || !Object.keys(group).length) return "none";
  if (group.pairId) return "latest_pair_id";
  return group.runId === "unscoped" ? "latest_unscoped" : "latest_run_id";
}

function emptyPairGroup({ pairId = "", runId = "unscoped" } = {}) {
  return {
    pairId,
    runId,
    latestTimestamp: "",
    defaultEvents: [],
    scopeleaseWorkEvents: [],
    latestContextEvent: null,
    eventCounts: { default: 0, scopeleaseContext: 0, scopeleaseWork: 0 }
  };
}

function latestInputBucket(events = [], { preferredRunId = "", anchorTimestamp = "", maxDistanceMs = 0 } = {}) {
  const wantedRunId = normalizeRunId(preferredRunId);
  const byRun = new Map();
  for (const event of events || []) {
    const runId = normalizeRunId(event.runId || event.meta?.runId) || "unscoped";
    const bucket = byRun.get(runId) || { runId, tokens: 0, count: 0, earliestTimestamp: "", latestTimestamp: "" };
    bucket.tokens += Number(event.tokens || 0);
    bucket.count += 1;
    bucket.earliestTimestamp = bucket.earliestTimestamp
      ? (compareIso(event.timestamp, bucket.earliestTimestamp) < 0 ? event.timestamp : bucket.earliestTimestamp)
      : event.timestamp || "";
    bucket.latestTimestamp = maxIso(bucket.latestTimestamp, event.timestamp);
    byRun.set(runId, bucket);
  }
  let buckets = [...byRun.values()];
  if (anchorTimestamp && maxDistanceMs > 0) {
    buckets = buckets.filter((bucket) => bucketWithinWindow(bucket, anchorTimestamp, maxDistanceMs));
  }
  if (wantedRunId && buckets.some((bucket) => bucket.runId === wantedRunId)) {
    return buckets.find((bucket) => bucket.runId === wantedRunId);
  }
  buckets.sort((left, right) => compareIso(right.latestTimestamp, left.latestTimestamp));
  return buckets[0] || { runId: "", tokens: 0, count: 0, earliestTimestamp: "", latestTimestamp: "" };
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

function normalizeRunId(value = "") {
  return String(value || "").trim();
}

function normalizePairId(value = "") {
  return String(value || "").trim();
}

function isObservedInputPayload(event = {}) {
  const phase = String(event.phase || event.meta?.phase || "").trim().toLowerCase();
  if (!phase) return true;
  return ["input", "prompt", "user-prompt", "user_prompt", "explore", "edit"].includes(phase);
}

function compareIso(left = "", right = "") {
  const leftTime = Date.parse(left || "");
  const rightTime = Date.parse(right || "");
  if (!Number.isFinite(leftTime) && !Number.isFinite(rightTime)) return 0;
  if (!Number.isFinite(leftTime)) return -1;
  if (!Number.isFinite(rightTime)) return 1;
  return leftTime - rightTime;
}

function maxIso(left = "", right = "") {
  return compareIso(left, right) >= 0 ? left : right;
}

function eventLane(event = {}) {
  const value = String(event.lane || event.runLane || event.meta?.lane || event.source || "").toLowerCase().replace(/[_\s]+/g, "-");
  if (value === "scopelease-internal" || value.startsWith("watch:auto")) return "scopelease-internal";
  if (/(default|baseline|without-scopelease|no-scopelease|plain-codex)/.test(value)) return "default-codex";
  if (/(scopelease-codex|with-scopelease|mcp|scopelease)/.test(value)) return "scopelease-codex";
  return "";
}

function normalizeLedgerRequest(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function extractPercentBand(value = "") {
  const match = String(value || "").match(/(?:^|[^\d])(\d{1,3}\s*-\s*\d{1,3}%|\d{1,3}%)(?=\D|$)/);
  return match ? match[1].replace(/\s+/g, "") : "";
}

function defaultTokenFormatter(value = 0) {
  const num = Number(value || 0);
  const sign = num < 0 ? "-" : "";
  const abs = Math.abs(num);
  if (abs >= 1000) return `${sign}${Math.round(abs / 100) / 10}k`;
  return `${sign}${abs}`;
}

function savingsStatusText({ defaultTokens = 0, scopeleaseTokens = 0, savedTokens = 0, savedPercent = 0, formatTokenCount = defaultTokenFormatter } = {}) {
  const base = `default-codex ${formatTokenCount(defaultTokens)} 대비 scopelease-codex ${formatTokenCount(scopeleaseTokens)}`;
  if (savedTokens < 0) return `${base}로 ${formatTokenCount(Math.abs(savedTokens))} 증가 (${savedPercent}%)`;
  return `${base}로 ${savedPercent}% 절감`;
}
