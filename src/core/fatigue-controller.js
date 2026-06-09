import { RISK_RANK } from "../constants.js";
import { hashText } from "../fs-utils.js";
import { actionGrant, actionPaths, defaultCommandScopes, isTaskScopedNetworkAction, normalizeAgentAction, taskScopedNetworkScopes } from "./action-policy.js";
import { buildFrontiers, compactFrontierForLease, frontierSummary } from "./frontier.js";

const DEFAULT_LEASE_MINUTES = 30;
const DEFAULT_MAX_FILES = 8;

export function buildDecisionBundle({ analysis = {}, decisionGate = {}, readPlan = [], policyHits = [], action = null, taskIntent = {} }) {
  const risk = analysis.risk || "low";
  const highRisk = RISK_RANK[risk] >= RISK_RANK.high || !decisionGate.canAutoApplyPatch;
  const id = `db_${hashText(JSON.stringify({
    generatedAt: analysis.generatedAt,
    risk,
    files: analysis.changes?.files || [],
    action
  })).slice(0, 12)}`;
  const policyLease = derivePolicyLease(policyHits);
  const normalizedAction = action ? normalizeAgentAction(action) : {};
  const files = scopedFiles({ analysis, readPlan, action: normalizedAction, maxFiles: policyLease.maxFiles });
  const commands = inferSafeCommands(analysis);
  const networkScopes = taskScopedNetworkScopes(analysis);
  const frontiers = buildFrontiers({ analysis, decisionGate, readPlan, policyHits, action: normalizedAction });
  const frontierLease = compactFrontierForLease(frontiers);
  const defaultVerdict = highRisk ? "prepare_only" : "allow_low_risk_subset";
  const stopWhen = buildStopConditions({ analysis, decisionGate, policyHits, frontiers });
  const grant = action ? actionGrant(normalizedAction) : "context_prepare";
  const decisionAssistance = buildDecisionAssistance({
    analysis,
    decisionGate,
    policyHits,
    action: normalizedAction,
    grant,
    files,
    commands,
    networkScopes,
    defaultVerdict,
    stopWhen
  });
  const agentJudgment = buildAgentJudgment({
    analysis,
    decisionGate,
    readPlan,
    policyHits,
    action,
    files,
    commands,
    networkScopes,
    defaultVerdict,
    stopWhen,
    taskIntent,
    grant,
    decisionAssistance
  });

  return {
    id,
    question: "이번 요청에 대해 아래 범위 안에서 agent가 자동 진행해도 되는가?",
    agentJudgment,
    decisionAssistance,
    risk,
    scopeleaserity: decisionGate.requiredApproval || decisionGate.scopeleaserity || "none",
    defaultVerdict,
    choices: [
      {
        id: "prepare_only",
        label: "패치 초안과 근거 정리만 허용",
        grants: ["read", "propose_patch", "run_tests"],
        blocks: ["apply_patch", "checkpoint", "merge", "network", "external_write"]
      },
      {
        id: "allow_scoped_patch",
        label: "이 요청의 파일 범위에서 패치 적용 허용",
        grants: ["read", "propose_patch", "apply_patch", "run_tests"],
        blocks: ["checkpoint", "merge", "network", "external_write"]
      },
      {
        id: "allow_low_risk_subset",
        label: "낮은 위험 범위만 자동 적용 허용",
        grants: ["read", "edit_docs", "run_tests"],
        blocks: ["edit_auth", "apply_high_risk_patch", "checkpoint", "merge", "network", "external_write"],
        pathAllow: ["README.md", "docs/**", "**/*.md", "**/*.mdx", "**/*.txt", "**/*.rst", "**/*.adoc"],
        pathDeny: ["src/**", "test/**", ".decision/**", ".codex/**", "**/auth/**", "**/*session*", "**/*middleware*"]
      },
      ...(grant === "network" && networkScopes.length ? [{
        id: "allow_task_scoped_network",
        label: "요청에 명시된 내부 서비스 접근만 허용",
        grants: ["network"],
        blocks: ["apply_patch", "checkpoint", "merge", "external_write"],
        networkScopes
      }] : []),
      {
        id: "deny",
        label: "중단",
        grants: [],
        blocks: ["all_write_actions"]
      }
    ],
    scope: {
      files,
      commands,
      networkScopes,
      expiresInMinutes: policyLease.maxMinutes,
      maxFiles: policyLease.maxFiles,
      ...frontierLease,
      frontierSummary: frontierSummary(frontiers)
    },
    policyHits: policyHits.map((hit) => ({
      ruleId: hit.ruleId,
      risk: hit.risk,
      route: hit.route,
      files: (hit.files || []).slice(0, 8)
    })),
    stopWhen
  };
}

export function buildMachineFatiguePlan({ analysis = {}, decisionGate = {}, readPlan = [], policyHits = [], affected = {}, taskIntent = {} }) {
  const decisionBundle = buildDecisionBundle({ analysis, decisionGate, readPlan, policyHits, taskIntent });
  const compactDecisionBundle = compactDecisionBundleForAgent(decisionBundle);
  const canAutoApply = Boolean(decisionGate?.canAutoApplyPatch);
  const requiredChecks = decisionGate?.requiredChecks || [];
  const humanPolicyHits = policyHits.filter((hit) => RISK_RANK[hit.risk] >= RISK_RANK.high || ["senior_review", "approver", "human_review"].includes(hit.route));
  const readTargets = readPlan.slice(0, 6).map((item) => item.path || item.id || item.label).filter(Boolean);
  const evidenceCount = (affected.tests || []).length + (affected.docs || []).length + (affected.routes || []).length;
  const stopWhen = buildStopConditions({ analysis, decisionGate, policyHits });
  const permissionNeed = buildPermissionNeed({ decisionGate, taskIntent, policyHits });
  const autonomyPlan = buildAutonomyPlan({
    canAutoApply,
    decisionBundle,
    permissionNeed,
    readTargets,
    evidenceCount,
    stopWhen,
    taskIntent
  });
  const askOnce = [
    canAutoApply
      ? "낮은 위험 적용만 한 번 확인합니다."
      : "적용 여부와 범위를 한 번만 결정합니다."
  ];
  if (humanPolicyHits.length) askOnce.push(`${humanPolicyHits.length}개 권한 정책도 한 질문으로 묶습니다.`);
  if (requiredChecks.length) askOnce.push("필요한 확인만 묻습니다.");

  const agentShouldDo = [];
  if (readTargets.length) agentShouldDo.push(`readPlan ${readTargets.length}개 먼저: ${readTargets.slice(0, 3).join(", ")}${readTargets.length > 3 ? " ..." : ""}`);
  agentShouldDo.push("readPlan 밖은 근거가 있을 때만 엽니다.");
  if (evidenceCount) agentShouldDo.push("근거 요약 후 결정을 요청합니다.");
  else agentShouldDo.push("근거 부족 시 확인 항목부터 모읍니다.");
  agentShouldDo.push(canAutoApply ? "낮은 위험은 적용/검증 후 보고합니다." : "패치는 초안까지만 만들고 적용 전 멈춥니다.");
  agentShouldDo.push("stepPlan 순서로 진행하고 stop 조건에서만 묻습니다.");

  const doNotAsk = [
    "낮은 위험 기록은 반복 질문하지 않습니다.",
    "전체 KG/브라우저/로컬 활동 로그는 결정 질문에 넣지 않습니다.",
    "같은 권한 판단은 파일별 반복하지 않습니다."
  ];

  return {
    version: 1,
    mode: canAutoApply ? "auto_with_log" : "ask_once",
    decisionBudget: {
      maxQuestions: 1,
      currentQuestions: 0
    },
    decisionBundle: compactDecisionBundle,
    reusableApproval: {
      enabled: true,
      leaseMinutes: decisionBundle.scope.expiresInMinutes
    },
    permissionNeed,
    autonomyPlan,
    graphFrontier: decisionBundle.scope?.frontierSummary || {},
    askOnce,
    agentShouldDo,
    doNotAsk,
    stopWhen
  };
}

export function inferAllowedActions(decisionGate = {}) {
  if (decisionGate.canAutoApplyPatch) return ["read", "propose_patch", "apply_patch", "run_tests"];
  if (decisionGate.canAutoPreparePatch) return ["read", "propose_patch", "run_tests"];
  return ["read", "run_tests"];
}

export function inferSafeCommands(_analysis = {}) {
  return defaultCommandScopes();
}

function scopedFiles({ analysis = {}, readPlan = [], action = null, maxFiles = DEFAULT_MAX_FILES }) {
  const paths = [
    ...actionPaths(action || {}),
    ...(readPlan || []).map((item) => item.path || item.id || item.label),
    ...(analysis.changes?.files || []),
    ...(analysis.impact?.tests || []).map((item) => item.path),
    ...(analysis.impact?.docs || []).map((item) => item.path)
  ].filter(Boolean);
  return [...new Set(paths)].slice(0, maxFiles || DEFAULT_MAX_FILES);
}

function derivePolicyLease(policyHits = []) {
  const leases = (policyHits || []).map((hit) => hit.lease || {}).filter(Boolean);
  const minuteValues = leases.map((lease) => Number(lease.max_minutes || lease.maxMinutes || 0)).filter((value) => value > 0);
  const fileValues = leases.map((lease) => Number(lease.max_files || lease.maxFiles || 0)).filter((value) => value > 0);
  return {
    maxMinutes: minuteValues.length ? Math.min(...minuteValues) : DEFAULT_LEASE_MINUTES,
    maxFiles: fileValues.length ? Math.min(...fileValues) : DEFAULT_MAX_FILES
  };
}

function buildAgentJudgment({
  analysis = {},
  decisionGate = {},
  readPlan = [],
  policyHits = [],
  action = null,
  files = [],
  commands = [],
  networkScopes = [],
  defaultVerdict = "",
  stopWhen = [],
  taskIntent = {},
  grant: providedGrant = "",
  decisionAssistance = {}
} = {}) {
  const normalizedAction = action ? normalizeAgentAction(action) : {};
  const grant = providedGrant || (action ? actionGrant(normalizedAction) : "context_prepare");
  const objective = compactText(
    taskIntent.objective ||
    analysis.contextPack?.userRequest?.text ||
    analysis.userRequest ||
    "사용자 요청을 처리합니다.",
    120
  );
  const readTargets = (readPlan || []).map((item) => item.path || item.id || item.label).filter(Boolean);
  const policyCount = (policyHits || []).length;
  const fileSummary = files.length
    ? `${files.length}개 파일 범위: ${files.slice(0, 4).join(", ")}${files.length > 4 ? ` 외 ${files.length - 4}개` : ""}`
    : readTargets.length
      ? `readPlan ${readTargets.length}개 기준`
      : "아직 특정 파일 범위 없음";
  const commandSummary = commands.length
    ? `${commands.slice(0, 3).join(", ")}${commands.length > 3 ? ` 외 ${commands.length - 3}개` : ""}`
    : "허용된 명령 없음";
  const actionSummary = summarizeActionForJudgment(normalizedAction, grant);
  const scopeleaseritySummary = decisionGate.canAutoApplyPatch
    ? "낮은 위험 범위는 자동 적용 가능"
    : "적용은 승인 후에만 가능";

  return {
    headline: `${taskTypeLabel(taskIntent.taskType)}으로 해석했고, ${actionSummary}`,
    interpretedInput: objective,
    risk: analysis.risk || "low",
    scopeleaserity: decisionGate.requiredApproval || decisionGate.scopeleaserity || "none",
    attention: decisionAssistance.surface || "status",
    interruptHuman: Boolean(decisionAssistance.interruptHuman),
    recommendedChoice: decisionAssistance.recommendedChoice || defaultVerdict,
    riskReasons: decisionAssistance.riskReasons || [],
    decisionHelp: decisionAssistance.decisionHelp || [],
    decisionAssistance,
    decision: decisionGate.summary || scopeleaseritySummary,
    willDo: [
      fileSummary,
      readTargets.length ? `먼저 읽을 근거: ${readTargets.slice(0, 3).join(", ")}${readTargets.length > 3 ? " ..." : ""}` : "",
      `검증 명령 범위: ${commandSummary}`,
      grant === "network" && networkScopes.length ? `내부 네트워크 범위: ${networkScopes.slice(0, 2).join(", ")}${networkScopes.length > 2 ? " ..." : ""}` : "",
      policyCount ? `정책 hit ${policyCount}개를 승인 판단에 반영` : "",
      "수정 후 결과와 근거를 요약 보고"
    ].filter(Boolean).slice(0, 5),
    approvalEffect: approvalEffectText(defaultVerdict, decisionAssistance),
    willNotDo: [
      grant === "network" && networkScopes.length
        ? "외부 네트워크, checkpoint, merge, external_write는 승인 범위에서 제외"
        : "checkpoint, merge, network, external_write는 승인 범위에서 제외",
      "범위 밖 파일이나 명령은 새 guard 판단 필요",
      stopWhen.length ? `중단 조건: ${stopWhen.slice(0, 3).join(", ")}${stopWhen.length > 3 ? " ..." : ""}` : ""
    ].filter(Boolean),
    action: {
      grant,
      kind: normalizedAction.kind || "",
      paths: actionPaths(normalizedAction).slice(0, 8)
    }
  };
}

function buildDecisionAssistance({
  analysis = {},
  decisionGate = {},
  policyHits = [],
  action = {},
  grant = "",
  files = [],
  commands = [],
  networkScopes = [],
  defaultVerdict = "",
  stopWhen = []
} = {}) {
  const risk = analysis.risk || "low";
  const riskRank = RISK_RANK[risk] || 0;
  const paths = actionPaths(action);
  const scopedPaths = files.length ? files : paths;
  const highPolicyHits = (policyHits || []).filter((hit) =>
    RISK_RANK[hit.risk] >= RISK_RANK.high || ["senior_review", "approver", "human_review"].includes(hit.route)
  );
  const sensitivePaths = scopedPaths.filter((item) => isSensitivePath(item));
  const taskScopedNetwork = grant === "network" && networkScopes.length > 0 && isTaskScopedNetworkAction(action, analysis);
  const externalAction = ["external_write", "checkpoint", "run_command"].includes(grant) || (grant === "network" && !taskScopedNetwork);
  const broadScope = scopedPaths.length > DEFAULT_MAX_FILES;
  const appliesCode = grant === "apply_patch" && !pathsLookDocumentation(scopedPaths);
  const trueRisk = riskRank >= RISK_RANK.high || highPolicyHits.length > 0 || externalAction || broadScope || sensitivePaths.length > 0;
  const boundedDelegation = grant === "apply_patch" && !trueRisk && scopedPaths.length > 0;
  const canStaySilent = ["read", "run_tests", "propose_patch", "context_prepare"].includes(grant) && !trueRisk;
  const surface = taskScopedNetwork
    ? "review"
    : trueRisk
    ? "interrupt"
    : boundedDelegation || appliesCode
      ? "review"
      : canStaySilent
        ? "silent"
        : "status";
  const recommendedChoice = taskScopedNetwork
    ? "allow_task_scoped_network"
    : trueRisk
    ? externalAction ? "deny" : "prepare_only"
    : boundedDelegation ? "allow_scoped_patch" : defaultVerdict;
  const riskReasons = [
    riskRank >= RISK_RANK.high ? `${risk} repository risk` : "",
    highPolicyHits.length ? `${highPolicyHits.length} high-risk policy hit` : "",
    sensitivePaths.length ? `sensitive path: ${sensitivePaths.slice(0, 3).join(", ")}${sensitivePaths.length > 3 ? " ..." : ""}` : "",
    taskScopedNetwork ? `task-scoped internal network: ${networkScopes.slice(0, 3).join(", ")}` : "",
    externalAction ? `blocked-capability request: ${grant}` : "",
    broadScope ? `broad file scope: ${scopedPaths.length} files` : "",
    boundedDelegation ? `bounded local patch: ${scopedPaths.length} files` : "",
    canStaySilent ? "safe or preparatory action" : ""
  ].filter(Boolean).slice(0, 6);
  const decisionHelp = trueRisk
    ? [
      "위험 이유가 실제 요청 의도와 맞는지만 확인",
      "모호하면 prepare_only로 초안/근거만 남기기",
      "범위 밖 파일, 네트워크, 체크포인트는 새 판단으로 분리"
    ]
    : boundedDelegation
      ? [
        "파일 범위가 의도와 맞으면 scoped lease로 위임",
        "중단 조건 발생 시 다시 묻도록 유지",
        "세부 구현 판단은 agent가 로그와 테스트로 처리"
      ]
      : [
        "사용자 중단 없이 로그만 남기는 경로",
        "위험 신호가 생기면 interrupt로 승격"
      ];
  if (taskScopedNetwork) {
    decisionHelp.splice(0, decisionHelp.length,
      "요청문에 명시된 내부 서비스 origin인지 확인",
      "같은 origin 밖으로 나가면 새 guard 판단 필요",
      "외부 다운로드나 패키지 설치는 계속 deny"
    );
  }
  return {
    version: 1,
    surface,
    interruptHuman: surface === "interrupt",
    severity: trueRisk ? risk : taskScopedNetwork || boundedDelegation ? "medium" : "low",
    recommendedChoice,
    userDecisionKind: trueRisk ? "risk_exception" : taskScopedNetwork ? "task_scoped_network_delegation" : boundedDelegation ? "scope_delegation" : "no_user_decision",
    riskReasons,
    decisionHelp,
    evaluationSignals: {
      humanTarget: trueRisk ? "risk_detection_and_override" : taskScopedNetwork ? "internal_network_scope_match" : boundedDelegation ? "scope_match_only" : "none",
      expectedCognitiveLoad: trueRisk ? "focused_high_value" : taskScopedNetwork || boundedDelegation ? "low" : "none",
      observable: [
        "shown_surface",
        "recommended_choice",
        "human_choice",
        "override_reason",
        "time_to_decision_ms",
        "post_lease_stop_condition"
      ],
      claim: "decision assistance is evaluated by whether humans only review high-value risk exceptions or bounded delegation scopes"
    },
    stopWhen: stopWhen.slice(0, 6),
    commandScope: commands.slice(0, 6),
    networkScope: networkScopes.slice(0, 6)
  };
}

function summarizeActionForJudgment(action = {}, grant = "") {
  const paths = actionPaths(action);
  if (grant === "apply_patch") return `${paths.length || 0}개 경로에 패치를 적용하려는 요청입니다.`;
  if (grant === "propose_patch") return `${paths.length || 0}개 경로의 패치 초안을 만들려는 요청입니다.`;
  if (grant === "run_tests") return "허용된 검증 명령을 실행하려는 요청입니다.";
  if (grant === "network") return "요청에 명시된 내부 서비스에 접근하려는 요청입니다.";
  if (grant === "read") return "로컬 파일을 읽어 근거를 모으려는 요청입니다.";
  return "ScopeLease context와 권한 경계를 준비하려는 요청입니다.";
}

function approvalEffectText(defaultVerdict = "", decisionAssistance = {}) {
  if (decisionAssistance.recommendedChoice === "allow_task_scoped_network") {
    return "승인하면 요청문에 명시된 내부 서비스 origin만 열고, 다른 네트워크나 외부 쓰기는 다시 막습니다.";
  }
  if (decisionAssistance.surface === "interrupt") {
    return "위험 신호가 있어 적용 권한을 바로 위임하지 않고, prepare_only 또는 deny가 기본 안전 선택입니다.";
  }
  if (decisionAssistance.surface === "silent") {
    return "사용자 결정을 요구하지 않고 로그만 남기며, 위험 신호가 생기면 다시 멈춥니다.";
  }
  if (defaultVerdict === "allow_low_risk_subset") {
    return "승인하면 낮은 위험 문서/검증 범위만 자동 처리하고, 코드 적용은 다시 확인합니다.";
  }
  return "승인하면 표시된 파일 범위만 위임하고, 범위 이탈이나 위험 신호가 생기면 다시 멈춥니다.";
}

function isSensitivePath(value = "") {
  return /(^|\/)(auth|session|middleware|payment|billing|checkout|migration|migrations|schema|db|database|secrets?)(\/|\.|-|_|$)/i.test(String(value || ""));
}

function pathsLookDocumentation(paths = []) {
  return paths.length > 0 && paths.every((item) => /\.(md|mdx|txt|rst|adoc)$/i.test(item));
}

function taskTypeLabel(value = "") {
  const text = String(value || "");
  if (text === "code_change") return "코드 변경 작업";
  if (text === "question") return "질문/분석 작업";
  if (text === "documentation") return "문서 작업";
  if (text === "general_coding_task") return "일반 개발 작업";
  return "개발 작업";
}

function compactText(value = "", max = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function buildPermissionNeed({ decisionGate = {}, taskIntent = {}, policyHits = [] } = {}) {
  const intentNeed = taskIntent.permissionNeed || {};
  const canAutoApply = Boolean(decisionGate.canAutoApplyPatch);
  const canPrepare = Boolean(decisionGate.canAutoPreparePatch);
  const highRiskPolicy = (policyHits || []).some((hit) => RISK_RANK[hit.risk] >= RISK_RANK.high);
  return {
    read: true,
    proposePatch: canPrepare || Boolean(intentNeed.proposePatch),
    applyPatch: canAutoApply && !highRiskPolicy,
    runTests: true,
    checkpoint: false,
    network: false,
    externalWrite: false,
    humanApprovalBeforeApply: !canAutoApply || highRiskPolicy,
    scopeleaserity: decisionGate.requiredApproval || decisionGate.scopeleaserity || "none",
    reason: [
      ...(intentNeed.reason || []),
      highRiskPolicy ? "high-risk policy hit requires human-scoped scopeleaserity" : "",
      canAutoApply ? "decision gate permits low-risk auto apply" : "decision gate permits preparation before apply"
    ].filter(Boolean).slice(0, 6)
  };
}

function compactDecisionBundleForAgent(bundle = {}) {
  return {
    id: bundle.id,
    agentJudgment: bundle.agentJudgment,
    decisionAssistance: bundle.decisionAssistance,
    defaultVerdict: bundle.defaultVerdict,
    choices: (bundle.choices || []).map((choice) => ({
      id: choice.id,
      label: shortChoiceLabel(choice.id, choice.label)
    })),
    scope: {
      files: (bundle.scope?.files || []).slice(0, 8),
      commands: bundle.scope?.commands || [],
      networkScopes: bundle.scope?.networkScopes || [],
      expiresInMinutes: bundle.scope?.expiresInMinutes,
      maxFiles: bundle.scope?.maxFiles
    }
  };
}

function shortChoiceLabel(id = "", fallback = "") {
  if (id === "prepare_only") return "초안만";
  if (id === "allow_scoped_patch") return "범위 적용";
  if (id === "allow_low_risk_subset") return "낮은 위험";
  if (id === "allow_task_scoped_network") return "내부 API";
  if (id === "deny") return "중단";
  return fallback || id;
}

function buildAutonomyPlan({ canAutoApply = false, decisionBundle = {}, permissionNeed = {}, readTargets = [], evidenceCount = 0, stopWhen = [], taskIntent = {} } = {}) {
  const applyScopeLeaserity = canAutoApply && !permissionNeed.humanApprovalBeforeApply ? "auto_with_log" : "requires_approval_lease";
  const verifyScopeLeaserity = (decisionBundle.scope?.commands || []).length ? "within_command_scope" : "requires_command_scope";
  const stepPlan = [
    {
      id: "intent",
      goal: "fix_intent",
      scopeleaserity: "auto"
    },
    {
      id: "scope",
      goal: "narrow_scope",
      scopeleaserity: "auto"
    },
    {
      id: "inspect",
      goal: "read_only_needed",
      scopeleaserity: "auto"
    },
    {
      id: "patch",
      goal: canAutoApply ? "apply_low_risk" : "draft_before_apply",
      scopeleaserity: applyScopeLeaserity
    },
    {
      id: "verify",
      goal: evidenceCount ? "run_related_checks" : "minimal_checks",
      scopeleaserity: verifyScopeLeaserity
    },
    {
      id: "report",
      goal: "summarize_delta",
      scopeleaserity: "auto"
    }
  ];
  return {
    mode: canAutoApply ? "autonomous_low_risk" : "autonomous_prepare_then_ask",
    tokenStrategy: ["readPlan", "stepLocal", "reuseDecision", "noFullGraph", "deltaOnly"],
    biasControls: ["evidence_first", "countercheck", "policy_over_model", "agent_neutral", "verify_claims", "mark_uncertain"],
    codexPermissionBridge: {
      guardBeforeApply: true,
      approveOnceForScope: true,
      reuseLeaseUntilStop: true,
      blocked: ["checkpoint", "network", "external_write"],
      applyScopeLeaserity
    },
    stepPlan
  };
}

function buildStopConditions({ analysis = {}, decisionGate = {}, policyHits = [], frontiers = {} }) {
  const values = [
    "changed_file_outside_scope",
    "network_access_requested",
    "external_write_requested",
    "checkpoint_requested"
  ];
  for (const hit of policyHits || []) {
    for (const item of hit.lease?.stop_when || hit.lease?.stopWhen || []) values.push(item);
  }
  if ((analysis.policyHits || []).some((hit) => RISK_RANK[hit.risk] >= RISK_RANK.high)) values.push("new_high_risk_policy_hit");
  if ((decisionGate.requiredChecks || []).length) values.push("required_check_unresolved");
  for (const item of frontiers.stopWhen || []) values.push(item);
  values.push("test_failure_without_known_cause");
  return [...new Set(values)];
}
