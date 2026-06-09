import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DECISION_DIR, IGNORE_DIRS, MAX_INDEX_FILE_BYTES } from "./constants.js";

export function normalizePath(value) {
  return value.split(path.sep).join("/");
}

export function toRelative(root, filePath) {
  return normalizePath(path.relative(root, filePath));
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

export function writeJson(filePath, value) {
  writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeCompactJson(filePath, value) {
  writeAtomic(filePath, `${JSON.stringify(value)}\n`);
}

function writeAtomic(filePath, text) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, text);
  fs.renameSync(tempPath, filePath);
}

export function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return JSON.parse(readText(filePath));
    } catch (error) {
      lastError = error;
      if (!isJsonParseError(error) || attempt === 3) break;
      sleepSync(25 * (attempt + 1));
    }
  }
  throw lastError;
}

export function writeText(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, value);
}

export function hashText(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

export function shouldIgnoreRelative(relativePath) {
  if (!relativePath || relativePath === ".") return false;
  const parts = normalizePath(relativePath).split("/");
  return parts.some((part) => IGNORE_DIRS.has(part));
}

export function isProbablyText(filePath) {
  let fd = null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_INDEX_FILE_BYTES) return false;
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(Math.min(stat.size, 4096));
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const sample = buffer.subarray(0, bytesRead);
    return !sample.includes(0);
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

export function walkFiles(root) {
  const files = [];

  function visit(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = toRelative(root, fullPath);
      if (shouldIgnoreRelative(relativePath)) continue;

      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }

      if (entry.isFile() && isProbablyText(fullPath)) {
        files.push(relativePath);
      }
    }
  }

  visit(root);
  return files.sort();
}

export function decisionPath(root, ...parts) {
  return path.join(root, DECISION_DIR, ...parts);
}

export function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function isJsonParseError(error) {
  return error instanceof SyntaxError;
}

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}
