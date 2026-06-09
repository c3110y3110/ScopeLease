import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { RISK_RANK } from "../constants.js";
import { hashText } from "../fs-utils.js";
import { actionGrant, actionInvalidPaths, actionPaths, hasUnsafeCommandPathEscape, hasUnsafeShellControl, isHardDenyAction, networkWithinScope, normalizeActionPath, normalizeAgentAction, pathsAreDocs } from "./action-policy.js";
import { actionGraphRefs, actionNodeId, baselineGraphHash, fileNodeId } from "./graph-adapter.js";

const LEASE_SIGNATURE_VERSION = 1;
const LEASE_SIGNATURE_ALGORITHM = "hmac-sha256";
const LEASE_SECRET_PATTERN = /^[0-9a-f]{64}$/i;

export function createApprovalLease({ analysis = {}, state = {}, decisionBundle = {}, choiceId = "", grantedBy = "human" }) {
  const choice = selectDecisionChoice(decisionBundle, choiceId);
  ensureReusableApprovalChoice(choice);
  const now = new Date();
  const minutes = Number(decisionBundle.scope?.expiresInMinutes || 30);
  const expiresAt = new Date(now.getTime() + minutes * 60 * 1000);
  const lease = {
    id: `lease_${hashText(`${decisionBundle.id}:${choice.id}:${now.toISOString()}`).slice(0, 12)}`,
    decisionBundleId: decisionBundle.id,
    choiceId: choice.id,
    grantedBy,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    requestHash: requestHash(analysis),
    baselineHash: baselineHash(state),
    riskMax: analysis.risk || decisionBundle.risk || "low",
    allowedActions: choice.grants || [],
    blockedActions: choice.blocks || [],
    fileScopes: decisionBundle.scope?.files || [],
    pathAllow: choice.pathAllow || decisionBundle.scope?.pathAllow || [],
    pathDeny: choice.pathDeny || decisionBundle.scope?.pathDeny || [],
    commandScopes: decisionBundle.scope?.commands || [],
    networkScopes: choice.networkScopes || decisionBundle.scope?.networkScopes || [],
    baselineGraphHash: baselineGraphHash({ analysis, state }),
    graphScopeHash: decisionBundle.scope?.graphScopeHash || "",
    reviewFrontierHash: decisionBundle.scope?.reviewFrontierHash || "",
    permissionFrontierHash: decisionBundle.scope?.permissionFrontierHash || "",
    allowedGraphNodes: [
      ...(decisionBundle.scope?.allowedGraphNodes || []),
      ...(decisionBundle.scope?.files || []).map(fileNodeId),
      ...(choice.grants || []).map(actionNodeId)
    ],
    reviewGraphNodes: decisionBundle.scope?.reviewGraphNodes || [],
    stopGraphNodes: decisionBundle.scope?.stopGraphNodes || [],
    graphBackend: decisionBundle.scope?.graphBackend || "",
    maxFiles: Number(decisionBundle.scope?.maxFiles || 0) || null,
    approvedChangedFiles: currentChangedFiles(analysis),
    stopWhen: decisionBundle.stopWhen || [],
    signatureVersion: LEASE_SIGNATURE_VERSION,
    signatureAlgorithm: LEASE_SIGNATURE_ALGORITHM,
    signatureKeyId: leaseKeyId({ analysis, state })
  };
  return signApprovalLease(lease, { analysis, state });
}

export function findValidLease({ action, analysis = {}, state = {}, leases = [] }) {
  return (leases || []).find((lease) => validateLease({ lease, action, analysis, state }).valid) || null;
}

export function validateLease({ lease = {}, action = {}, analysis = {}, state = {} }) {
  const normalized = normalizeAgentAction(action);
  if (!lease.id) return invalid("missing lease id");
  const signature = verifyApprovalLeaseSignature({ lease, analysis, state });
  if (!signature.valid) return signature;
  if (lease.expiresAt && Date.parse(lease.expiresAt) < Date.now()) return invalid("approval lease expired");
  if (lease.requestHash && lease.requestHash !== requestHash(analysis)) return invalid("request scope changed");
  if (lease.baselineHash && lease.baselineHash !== baselineHash(state)) return invalid("baseline changed");
  if (lease.baselineGraphHash && lease.baselineGraphHash !== baselineGraphHash({ analysis, state })) return invalid("baseline graph changed");
  if (!riskWithinLease(analysis.risk || "low", lease.riskMax || "low")) return invalid("risk exceeds approval lease");
  if (isHardDenyAction(normalized, { networkScopes: lease.networkScopes || [] })) return invalid("action is destructive, external, or outside trusted scope");
  if (actionInvalidPaths(normalized).length) return invalid("action path is outside repo-relative scope");
  const grant = actionGrant(normalized);
  const paths = actionPaths(normalized);
  if (grant === "apply_patch" && changedFileOutsideScope(analysis, lease)) return invalid("changed file outside approval lease");
  if (lease.blockedActions?.includes(grant) || lease.blockedActions?.includes("all_write_actions")) return invalid("action blocked by lease");
  if (!actionCoveredByGrant(grant, lease.allowedActions || [], paths)) return invalid("action not granted by lease");
  if (grant === "network" && !networkWithinScope(normalized, lease.networkScopes || [])) return invalid("network target outside approval lease");
  if (grant === "apply_patch" && !paths.length) return invalid("write action is missing a repo-relative path");
  if (grant === "apply_patch" && (lease.allowedActions || []).includes("edit_docs") && !pathsAreDocs(paths)) return invalid("edit_docs lease only permits documentation paths");
  if (lease.maxFiles && paths.length > lease.maxFiles) return invalid("action exceeds approval lease file limit");
  if (pathsDenied(paths, lease.pathDeny || [])) return invalid("path denied by approval lease");
  if (!pathsWithinAllow(paths, lease.pathAllow || [])) return invalid("path outside approval lease allow list");
  if (!pathsWithinScope(paths, lease.fileScopes || [])) return invalid("path outside approval lease");
  if (!actionWithinGraphScope(normalized, lease)) return invalid("action outside approval graph scope");
  if (normalized.kind === "bash" && grant !== "network" && !commandWithinScope(normalized.command, lease.commandScopes || [])) return invalid("command outside approval lease");
  if (stopConditionTriggered(lease, state)) return invalid("approval lease stop condition triggered");
  return { valid: true, reason: "valid approval lease covers this action", lease };
}

export function requestHash(analysis = {}) {
  return `sha1:${hashText(JSON.stringify({
    userRequest: analysis.userRequest || analysis.contextPack?.userRequest?.text || "",
    pairingKey: analysis.contextPack?.agentContext?.taskIntent?.pairing?.pairingKey
      || analysis.contextPack?.taskIntent?.pairing?.pairingKey
      || ""
  }))}`;
}

export function baselineHash(state = {}) {
  return `sha1:${hashText(JSON.stringify(state.baselineHashes || {}))}`;
}

function invalid(reason) {
  return { valid: false, reason };
}

function selectDecisionChoice(decisionBundle = {}, choiceId = "") {
  const choices = Array.isArray(decisionBundle.choices) ? decisionBundle.choices : [];
  const requestedChoiceId = String(choiceId || "").trim();
  if (requestedChoiceId) {
    const choice = choices.find((item) => item.id === requestedChoiceId);
    if (!choice) throw new Error(`Unknown approval choice: ${requestedChoiceId}`);
    return choice;
  }
  return choices.find((item) => item.id === decisionBundle.defaultVerdict)
    || choices[0]
    || { id: "prepare_only", grants: ["read", "propose_patch", "run_tests"], blocks: ["apply_patch", "checkpoint", "network"] };
}

function ensureReusableApprovalChoice(choice = {}) {
  if (!Array.isArray(choice.grants) || !choice.grants.length) {
    throw new Error(`Approval choice does not grant reusable scopeleaserity: ${choice.id || "unknown"}`);
  }
}

function signApprovalLease(lease = {}, { analysis = {}, state = {} } = {}) {
  const secret = readLeaseSecret({ analysis, state, create: true });
  return {
    ...lease,
    signature: hmacLeasePayload(lease, secret)
  };
}

function verifyApprovalLeaseSignature({ lease = {}, analysis = {}, state = {} }) {
  if (lease.signatureVersion !== LEASE_SIGNATURE_VERSION || lease.signatureAlgorithm !== LEASE_SIGNATURE_ALGORITHM || !lease.signatureKeyId || !lease.signature) {
    return invalid("approval lease signature missing or unsupported");
  }
  if (lease.signatureKeyId !== leaseKeyId({ analysis, state })) return invalid("approval lease signature key mismatch");
  const secret = readLeaseSecret({ analysis, state, create: false });
  if (!secret) return invalid("approval lease signature key unavailable");
  const expected = hmacLeasePayload(lease, secret);
  if (!safeEqualHex(expected, String(lease.signature || ""))) return invalid("approval lease signature mismatch");
  return { valid: true };
}

function hmacLeasePayload(lease = {}, secret = "") {
  return createHmac("sha256", hmacKey(secret))
    .update(canonicalLeasePayload(lease))
    .digest("hex");
}

function canonicalLeasePayload(lease = {}) {
  const payload = {};
  for (const [key, value] of Object.entries(lease || {})) {
    if (key === "signature") continue;
    payload[key] = value;
  }
  return JSON.stringify(stableValue(payload));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])])
  );
}

function hmacKey(secret = "") {
  const text = String(secret || "").trim();
  return LEASE_SECRET_PATTERN.test(text) ? Buffer.from(text, "hex") : text;
}

function safeEqualHex(left = "", right = "") {
  if (!/^[0-9a-f]+$/i.test(left) || !/^[0-9a-f]+$/i.test(right)) return false;
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (leftBuffer.length !== rightBuffer.length || !leftBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function readLeaseSecret({ analysis = {}, state = {}, create = false } = {}) {
  let secretPath = "";
  try {
    secretPath = leaseSecretPath({ analysis, state });
  } catch (error) {
    if (create) throw error;
    return "";
  }
  if (fs.existsSync(secretPath)) {
    return normalizeLeaseSecret(fs.readFileSync(secretPath, "utf8"), { secretPath, create });
  }
  if (!create) return "";
  ensurePrivateDir(path.dirname(secretPath));
  const secret = randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(secretPath, `${secret}\n`, { mode: 0o600, flag: "wx" });
    tryChmod(secretPath, 0o600);
    return secret;
  } catch (error) {
    if (error?.code === "EEXIST") {
      return normalizeLeaseSecret(fs.readFileSync(secretPath, "utf8"), { secretPath, create });
    }
    throw error;
  }
}

function normalizeLeaseSecret(raw = "", { secretPath = "", create = false } = {}) {
  const secret = String(raw || "").trim();
  if (LEASE_SECRET_PATTERN.test(secret)) return secret;
  if (!create) return "";
  throw new Error(`approval lease signing key is invalid: ${secretPath}`);
}

function ensurePrivateDir(dirPath = "") {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  tryChmod(dirPath, 0o700);
}

function tryChmod(targetPath = "", mode = 0o700) {
  try {
    fs.chmodSync(targetPath, mode);
  } catch {
    // Some filesystems ignore POSIX modes; the signature still prevents state-file edits from validating.
  }
}

function leaseSecretPath({ analysis = {}, state = {} } = {}) {
  const repoRoot = leaseRepoRoot({ analysis, state });
  const keyDir = leaseKeyDir();
  if (!process.env.SCOPELEASE_ALLOW_REPO_LOCAL_LEASE_KEY && pathInsideOrSame(repoRoot, keyDir)) {
    throw new Error("approval lease key directory must be outside repository");
  }
  return path.join(keyDir, `${leaseKeyId({ analysis, state })}.key`);
}

function leaseKeyDir() {
  const override = String(process.env.SCOPELEASE_LEASE_KEY_DIR || "").trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".scopelease", "keys");
}

function leaseKeyId({ analysis = {}, state = {} } = {}) {
  const repoPath = leaseRepoRoot({ analysis, state });
  return `repo_${hashText(repoPath).slice(0, 24)}`;
}

function leaseRepoRoot({ analysis = {}, state = {} } = {}) {
  return path.resolve(state.repo || analysis.repo || process.cwd());
}

function pathInsideOrSame(rootPath = "", targetPath = "") {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function riskWithinLease(currentRisk, riskMax) {
  return (RISK_RANK[currentRisk] || 0) <= (RISK_RANK[riskMax] || 0);
}

function actionCoveredByGrant(grant, allowed = [], paths = []) {
  if (allowed.includes(grant)) return true;
  if (grant === "apply_patch" && allowed.includes("edit_docs")) return pathsAreDocs(paths);
  return false;
}

function pathsWithinScope(paths = [], scopes = []) {
  if (!paths.length) return true;
  const normalizedScopes = normalizeScopePatterns(scopes);
  if (!normalizedScopes.length) return false;
  return paths.every((target) => normalizedScopes.some((scope) => pathMatchesScope(scope, target)));
}

function actionWithinGraphScope(action = {}, lease = {}) {
  const allowed = new Set(lease.allowedGraphNodes || []);
  if (!allowed.size) return true;
  const refs = actionGraphRefs(action);
  if (refs.actionNode && !allowed.has(refs.actionNode)) return false;
  return (refs.fileNodes || []).every((nodeId) => allowed.has(nodeId));
}

function changedFileOutsideScope(analysis = {}, lease = {}) {
  if (!(lease.stopWhen || []).includes("changed_file_outside_scope")) return false;
  if (!Array.isArray(lease.approvedChangedFiles)) return false;
  const approved = new Set(lease.approvedChangedFiles || []);
  const newChanged = currentChangedFiles(analysis).filter((file) => !approved.has(file));
  return newChanged.length > 0 && !pathsWithinScope(newChanged, lease.fileScopes || []);
}

function currentChangedFiles(analysis = {}) {
  return [...new Set([
    ...(analysis.changes?.files || []),
    ...Object.keys(analysis.changes?.fileHashes || {})
  ].filter(Boolean))];
}

function commandWithinScope(command = "", scopes = []) {
  const text = String(command || "").trim();
  if (!text) return false;
  if (hasUnsafeShellControl(text)) return false;
  if (hasUnsafeCommandPathEscape(text)) return false;
  return scopes.some((scope) => {
    const allowed = String(scope || "").trim();
    if (!allowed) return false;
    if (hasUnsafeShellControl(allowed)) return false;
    if (hasUnsafeCommandPathEscape(allowed)) return false;
    return text === allowed || text.startsWith(`${allowed} `);
  });
}

function pathsDenied(paths = [], deny = []) {
  const normalizedDeny = normalizeScopePatterns(deny);
  if (!paths.length || !normalizedDeny.length) return false;
  return paths.some((target) => normalizedDeny.some((scope) => pathMatchesScope(scope, target)));
}

function pathsWithinAllow(paths = [], allow = []) {
  const normalizedAllow = normalizeScopePatterns(allow);
  if (!paths.length || !normalizedAllow.length) return true;
  return paths.every((target) => normalizedAllow.some((scope) => pathMatchesScope(scope, target)));
}

function pathMatchesScope(scope = "", target = "") {
  const normalizedScope = normalizeScopePattern(scope);
  const normalizedTarget = normalizeActionPath(target);
  if (!normalizedScope || !normalizedTarget) return false;
  return normalizedTarget === normalizedScope
    || normalizedTarget.startsWith(`${normalizedScope}/`)
    || globLikeMatch(normalizedScope, normalizedTarget);
}

function stopConditionTriggered(lease = {}, state = {}) {
  const stopWhen = new Set(lease.stopWhen || []);
  if (!stopWhen.size) return false;
  const events = [
    ...(state.leaseStopEvents || []),
    ...(state.stopEvents || []),
    ...(state.guardEvents || [])
  ];
  return events.some((event) => {
    const reason = String(event.stopCondition || event.reason || event.type || "").trim();
    return reason && stopWhen.has(reason);
  });
}

function globLikeMatch(scope = "", target = "") {
  if (!scope.includes("*")) return false;
  const source = scope
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__SCOPELEASE_DOUBLE_STAR__")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${source.replace(/__SCOPELEASE_DOUBLE_STAR__/g, ".*")}$`).test(target);
}

function normalizeScopePatterns(scopes = []) {
  return [...new Set((scopes || []).map((scope) => normalizeScopePattern(scope)).filter(Boolean))];
}

function normalizeScopePattern(value = "") {
  const raw = String(value || "").trim().replace(/\\/g, "/");
  if (!raw || raw.includes("\0")) return "";
  if (raw.startsWith("/") || raw.startsWith("~") || /^[A-Za-z]:\//.test(raw)) return "";
  if (raw.split("/").some((part) => part === "..")) return "";
  return raw.replace(/^\.\//, "");
}
