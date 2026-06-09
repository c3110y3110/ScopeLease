import { recordModelUsage } from "../analyzer.js";

const DEFAULT_UPSTREAM = "https://api.openai.com/v1";
const MAX_CAPTURE_CHARS = 2_000_000;

export async function proxyModelUsageRequest({ req, res, root, requestText = "", onUsage = () => {} }) {
  const incomingUrl = new URL(req.url, "http://localhost");
  const targetUrl = buildTargetUrl(incomingUrl);
  const body = await readRequestBuffer(req);
  const headers = buildForwardHeaders(req.headers, body);
  const inferredRequest = inferUserRequestFromBody(body);

  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: body.length && !["GET", "HEAD"].includes(req.method) ? body : undefined
    });
  } catch (error) {
    res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    res.end(`${JSON.stringify({ ok: false, error: `upstream request failed: ${error.message}` })}\n`);
    return;
  }

  writeProxyHeaders(res, upstream);
  const contentType = upstream.headers.get("content-type") || "";
  const captured = contentType.includes("text/event-stream")
    ? await pipeAndCaptureStream(upstream, res)
    : await sendAndCaptureBody(upstream, res);

  const usageEvent = captureUsage({ root, req, targetUrl, requestText: inferredRequest || requestText, captured });
  if (usageEvent) onUsage(usageEvent);
}

export function extractUsageFromText(text = "") {
  const chunks = [];
  const raw = String(text || "").trim();
  if (!raw) return null;

  if (raw.startsWith("{") || raw.startsWith("[")) {
    const parsed = safeJsonParse(raw);
    if (parsed) chunks.push(parsed);
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.replace(/^data:\s*/, "");
    if (!data || data === "[DONE]") continue;
    const parsed = safeJsonParse(data);
    if (parsed) chunks.push(parsed);
  }

  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const candidate = findUsage(chunks[index]);
    if (candidate) return candidate;
  }
  return null;
}

function captureUsage({ root, req, targetUrl, requestText, captured }) {
  const usagePayload = extractUsageFromText(captured);
  if (!usagePayload?.usage) return null;
  const event = recordModelUsage(root, {
    source: "openai-compatible-proxy",
    provider: usagePayload.provider || "openai",
    model: usagePayload.model || "",
    requestId: usagePayload.id || req.headers["x-request-id"] || "",
    request: req.headers["x-scopelease-request"] || requestText || "",
    usage: usagePayload.usage,
    raw: {
      id: usagePayload.id,
      model: usagePayload.model,
      target: redactTarget(targetUrl)
    }
  }).event;
  return event;
}

export function inferUserRequestFromBody(body) {
  if (!body?.length) return "";
  const parsed = safeJsonParse(body.toString("utf8"));
  if (!parsed || typeof parsed !== "object") return "";
  return compactRequestText(
    extractLastUserText(parsed.input) ||
    extractLastMessageText(parsed.messages) ||
    extractLastMessageText(parsed.conversation?.items) ||
    ""
  );
}

function extractLastUserText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return textFromContent(value);
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const item = value[index];
    if (!item || typeof item !== "object") continue;
    if (item.role && item.role !== "user") continue;
    const text = textFromContent(item.content || item);
    if (text) return text;
  }
  return "";
}

function extractLastMessageText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    if (message.role && message.role !== "user") continue;
    const text = textFromContent(message.content || message);
    if (text) return text;
  }
  return "";
}

function textFromContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(textFromContent).filter(Boolean).join("\n");
  }
  if (typeof content !== "object") return "";
  if (typeof content.text === "string") return content.text;
  if (typeof content.input_text === "string") return content.input_text;
  if (typeof content.value === "string") return content.value;
  if (content.type === "input_text" && typeof content.text === "string") return content.text;
  return "";
}

function compactRequestText(value = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= 240) return text;
  return `${text.slice(0, 237)}...`;
}

function findUsage(value) {
  if (!value || typeof value !== "object") return null;
  if (value.usage) {
    return {
      id: value.id || value.response?.id || "",
      model: value.model || value.response?.model || "",
      usage: value.usage
    };
  }
  if (value.response?.usage) {
    return {
      id: value.response.id || value.id || "",
      model: value.response.model || value.model || "",
      usage: value.response.usage
    };
  }
  if (value.data?.usage) {
    return {
      id: value.data.id || value.id || "",
      model: value.data.model || value.model || "",
      usage: value.data.usage
    };
  }
  return null;
}

function buildTargetUrl(incomingUrl) {
  const upstream = String(process.env.SCOPELEASE_OPENAI_BASE_URL || DEFAULT_UPSTREAM).replace(/\/+$/, "");
  const suffix = incomingUrl.pathname.replace(/^\/proxy\/v1\/?/, "");
  const path = suffix ? `/${suffix}` : "/";
  return `${upstream}${path}${incomingUrl.search}`;
}

export function buildForwardHeaders(sourceHeaders, body, env = process.env) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(sourceHeaders || {})) {
    const lower = key.toLowerCase();
    if (["host", "content-length", "connection", "accept-encoding"].includes(lower)) continue;
    if (lower.startsWith("x-scopelease-")) continue;
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
  }
  const scopeleaseApiKey = formatBearerToken(env.SCOPELEASE_OPENAI_API_KEY);
  const fallbackApiKey = formatBearerToken(env.OPENAI_API_KEY);
  const allowOpenAiFallback = /^(1|true|yes)$/i.test(String(env.SCOPELEASE_ALLOW_OPENAI_API_KEY_FALLBACK || ""));
  if (scopeleaseApiKey) {
    headers.set("scopeleaserization", scopeleaseApiKey);
  } else if (!headers.has("scopeleaserization") && fallbackApiKey && allowOpenAiFallback) {
    headers.set("scopeleaserization", fallbackApiKey);
  }
  if (body.length && !headers.has("content-type")) headers.set("content-type", "application/json");
  return headers;
}

function formatBearerToken(value) {
  const token = String(value || "").trim();
  if (!token) return "";
  return /^bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}

function writeProxyHeaders(res, upstream) {
  const headers = {};
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (["connection", "content-length", "content-encoding", "transfer-encoding"].includes(lower)) return;
    headers[key] = value;
  });
  res.writeHead(upstream.status, headers);
}

async function sendAndCaptureBody(upstream, res) {
  const buffer = Buffer.from(await upstream.arrayBuffer());
  res.end(buffer);
  return buffer.toString("utf8", 0, Math.min(buffer.length, MAX_CAPTURE_CHARS));
}

async function pipeAndCaptureStream(upstream, res) {
  if (!upstream.body) {
    res.end();
    return "";
  }
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let captured = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    res.write(chunk);
    captured += decoder.decode(value, { stream: true });
    if (captured.length > MAX_CAPTURE_CHARS) captured = captured.slice(-MAX_CAPTURE_CHARS);
  }
  captured += decoder.decode();
  if (captured.length > MAX_CAPTURE_CHARS) captured = captured.slice(-MAX_CAPTURE_CHARS);
  res.end();
  return captured;
}

function readRequestBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function redactTarget(targetUrl) {
  const url = new URL(targetUrl);
  return `${url.origin}${url.pathname}`;
}
