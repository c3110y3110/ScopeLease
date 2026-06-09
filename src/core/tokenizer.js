import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const DEFAULT_ENCODING = "o200k_base";
const DEFAULT_MODEL = process.env.SCOPELEASE_TOKEN_MODEL || "";
const PYTHON_CANDIDATES = [...new Set([process.env.SCOPELEASE_PYTHON, "python3", "python"].filter(Boolean))];
const PYTHON_TIKTOKEN_TIMEOUT_MS = positiveNumber(process.env.SCOPELEASE_TIKTOKEN_TIMEOUT_MS, 1500);
const PYTHON_TIKTOKEN_SLOW_MS = positiveNumber(process.env.SCOPELEASE_TIKTOKEN_SLOW_MS, 1200);
const TOKEN_CACHE_LIMIT = 256;
const tokenCache = new Map();

// Cache failed exact-tokenizer startup once per process; otherwise every new
// payload repeatedly spawns Python when tiktoken is missing.
let exactTokenizerUnavailableError = process.env.SCOPELEASE_DISABLE_TIKTOKEN === "1"
  ? "disabled by SCOPELEASE_DISABLE_TIKTOKEN=1"
  : "";

export function countTokensForTexts(texts, options = {}) {
  const values = texts.map((text) => String(text || ""));
  const cacheKeys = values.map((value) => cacheKey(value, options));
  const cached = cacheKeys.map((key) => tokenCache.get(key));
  if (cached.every(Boolean)) {
    return {
      counts: cached.map((entry) => entry.count),
      tokenizer: cached[0].tokenizer
    };
  }

  const exact = exactTokenizerUnavailableError
    ? { ok: false, error: exactTokenizerUnavailableError }
    : countWithPythonTiktoken(values, options);
  if (exact.ok) {
    cacheCounts(cacheKeys, exact.counts, exact.tokenizer);
    return exact;
  }
  exactTokenizerUnavailableError = exact.error || "tiktoken unavailable";

  const fallback = {
    counts: values.map((value) => Math.ceil(value.length / 4)),
    tokenizer: {
      exact: false,
      method: "rough_chars_div_4",
      encoding: options.encoding || DEFAULT_ENCODING,
      model: options.model || DEFAULT_MODEL || null,
      error: exact.error || "tiktoken unavailable"
    }
  };
  cacheCounts(cacheKeys, fallback.counts, fallback.tokenizer);
  return fallback;
}

export function countTokensForText(text, options = {}) {
  return countTokensForTexts([text], options).counts[0] || 0;
}

function countWithPythonTiktoken(texts, options) {
  const errors = [];
  for (const python of PYTHON_CANDIDATES) {
    const result = runPythonTiktoken(python, texts, options);
    if (result.ok) return result;
    errors.push(`${python}: ${result.error || "unavailable"}`);
  }
  return { ok: false, error: errors.join("; ") };
}

function runPythonTiktoken(python, texts, options) {
  const payload = {
    texts,
    model: options.model || DEFAULT_MODEL,
    encoding: options.encoding || DEFAULT_ENCODING
  };
  const script = [
    "import json, sys",
    "data = json.load(sys.stdin)",
    "try:",
    "    import tiktoken",
    "    model = data.get('model')",
    "    encoding = data.get('encoding') or 'o200k_base'",
    "    try:",
    "        enc = tiktoken.encoding_for_model(model) if model else tiktoken.get_encoding(encoding)",
    "    except Exception:",
    "        enc = tiktoken.get_encoding(encoding)",
    "    counts = [len(enc.encode(str(text or ''))) for text in data.get('texts', [])]",
    "    print(json.dumps({'ok': True, 'counts': counts, 'encoding': enc.name, 'model': model or None}))",
    "except Exception as exc:",
    "    print(json.dumps({'ok': False, 'error': type(exc).__name__ + ': ' + str(exc)}))",
    "    sys.exit(0)"
  ].join("\n");

  const started = Date.now();
  const result = spawnSync(python, ["-c", script], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 16,
    timeout: PYTHON_TIKTOKEN_TIMEOUT_MS
  });
  const durationMs = Date.now() - started;

  if (result.signal === "SIGTERM" || result.error?.code === "ETIMEDOUT") {
    return { ok: false, error: `tiktoken timed out after ${PYTHON_TIKTOKEN_TIMEOUT_MS}ms` };
  }
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0 && !result.stdout) return { ok: false, error: result.stderr || `exit ${result.status}` };

  try {
    const parsed = JSON.parse(String(result.stdout || "{}"));
    if (!parsed.ok || !Array.isArray(parsed.counts)) return { ok: false, error: parsed.error || "invalid tiktoken response" };
    if (durationMs > PYTHON_TIKTOKEN_SLOW_MS) {
      return { ok: false, error: `tiktoken slow path took ${durationMs}ms` };
    }
    return {
      ok: true,
      counts: parsed.counts.map((count) => Number(count || 0)),
      tokenizer: {
        exact: true,
        method: "tiktoken",
        encoding: parsed.encoding || payload.encoding,
        model: parsed.model || payload.model || null,
        source: "python:tiktoken"
      }
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function cacheKey(value, options = {}) {
  const model = options.model || DEFAULT_MODEL || "";
  const encoding = options.encoding || DEFAULT_ENCODING;
  const hash = createHash("sha256").update(value).digest("hex");
  return `${model}|${encoding}|${value.length}|${hash}`;
}

function cacheCounts(keys, counts, tokenizer) {
  for (let index = 0; index < keys.length; index += 1) {
    tokenCache.set(keys[index], { count: Number(counts[index] || 0), tokenizer });
    if (tokenCache.size > TOKEN_CACHE_LIMIT) tokenCache.delete(tokenCache.keys().next().value);
  }
}
